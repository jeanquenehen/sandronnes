const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ── CLIENTES SUPABASE ────────────────────────────────────────────────────────
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { db: { schema: 'Sandronnes' }, auth: { persistSession: false, autoRefreshToken: false } }
);

const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { db: { schema: 'Sandronnes' }, auth: { persistSession: false, autoRefreshToken: false } }
);

// ── MIDDLEWARES ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());

function getToken(req) {
    return req.cookies['sb-access-token'] || null;
}

async function requireAuth(req, res, next) {
    const token = getToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'Não autenticado.' });
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) throw new Error('Sessão inválida');
        req.user = user;
        req.db = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_ANON_KEY,
            {
                db: { schema: 'Sandronnes' },
                auth: { persistSession: false, autoRefreshToken: false },
                global: { headers: { Authorization: `Bearer ${token}` } }
            }
        );
        next();
    } catch {
        return res.status(401).json({ success: false, message: 'Sessão expirada.' });
    }
}

function filtrarCampos(body, campos) {
    const out = {};
    campos.forEach(c => { if (body[c] !== undefined) out[c] = body[c]; });
    return out;
}

// ── DIVISÃO ENTRE SÓCIOS ─────────────────────────────────────────────────────
// Recalcula sandro_recebe e rafael_recebe no trabalho após qualquer
// alteração nas despesas vinculadas a ele.
//
// Fórmula:
//   liquido = valor_total − ganho_operador − ganho_representante − soma(despesas)
//   carteira Sandro → Sandro 60% / Rafael 40%
//   carteira Rafael → Sandro 50% / Rafael 50%
//
// Usa supabaseAdmin para garantir acesso mesmo com RLS ativo.

async function recalcularDivisao(trabalhoId) {
    try {
        // 1. Busca o trabalho
        const { data: trab, error: eTrab } = await supabaseAdmin
            .from('trabalhos')
            .select('valor_total, ganho_operador, ganho_representante, cliente_id')
            .eq('id', trabalhoId)
            .single();
        if (eTrab || !trab) throw new Error('Trabalho não encontrado: ' + (eTrab?.message || ''));

        // 2. Busca a carteira do cliente
        const { data: cliente, error: eCli } = await supabaseAdmin
            .from('clientes')
            .select('carteira')
            .eq('id', trab.cliente_id)
            .single();
        if (eCli || !cliente) throw new Error('Cliente não encontrado: ' + (eCli?.message || ''));

        // 3. Soma todas as despesas vinculadas ao trabalho
        const { data: despesas, error: eDesp } = await supabaseAdmin
            .from('despesas')
            .select('valor')
            .eq('trabalho_id', trabalhoId);
        if (eDesp) throw new Error('Erro ao buscar despesas: ' + eDesp.message);

        const totalDespesas = (despesas || []).reduce((s, d) => s + (parseFloat(d.valor) || 0), 0);

        // 4. Calcula o líquido
        const valorTotal      = parseFloat(trab.valor_total)       || 0;
        const ganhoOp         = parseFloat(trab.ganho_operador)     || 0;
        const ganhoRep        = parseFloat(trab.ganho_representante)|| 0;
        const liquido         = valorTotal - ganhoOp - ganhoRep - totalDespesas;

        // 5. Aplica percentual conforme carteira
        const carteira = (cliente.carteira || '').toLowerCase();
        let percSandro, percRafael;

        if (carteira === 'sandro') {
            percSandro = 0.60;
            percRafael = 0.40;
        } else {
            // carteira Rafael ou qualquer outro valor → 50/50
            percSandro = 0.50;
            percRafael = 0.50;
        }

        const sandroRecebe = parseFloat((liquido * percSandro).toFixed(2));
        const rafaelRecebe = parseFloat((liquido * percRafael).toFixed(2));

        // 6. Grava no trabalho
        const { error: eUp } = await supabaseAdmin
            .from('trabalhos')
            .update({ sandro_recebe: sandroRecebe, rafael_recebe: rafaelRecebe })
            .eq('id', trabalhoId);
        if (eUp) throw new Error('Erro ao atualizar divisão: ' + eUp.message);

    } catch (e) {
        // Loga mas não derruba a rota principal — a despesa já foi salva
        console.error('[recalcularDivisao]', e.message);
    }
}

// ── FACTORY CRUD ─────────────────────────────────────────────────────────────
function crudRoutes(router, tabela, campos) {

    // GET — lista todos
    router.get(`/api/${tabela}`, requireAuth, async (req, res) => {
        try {
            const { data, error } = await req.db
                .from(tabela).select('*').order('criado_em', { ascending: false });
            if (error) throw error;
            res.json(data);
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // POST — cria novo
    router.post(`/api/${tabela}`, requireAuth, async (req, res) => {
        try {
            const payload = filtrarCampos(req.body, campos);
            const { data, error } = await req.db
                .from(tabela).insert(payload).select().single();
            if (error) throw error;
            res.status(201).json(data);

            // Se for despesa de trabalho, recalcula divisão em background
            if (tabela === 'despesas' && data.trabalho_id) {
                recalcularDivisao(data.trabalho_id);
            }
        } catch (e) {
            res.status(400).json({ success: false, message: e.message });
        }
    });

    // PUT — atualiza por id
    router.put(`/api/${tabela}/:id`, requireAuth, async (req, res) => {
        try {
            const payload = filtrarCampos(req.body, campos);
            const { data, error } = await req.db
                .from(tabela).update(payload).eq('id', req.params.id).select().single();
            if (error) throw error;
            res.json(data);

            // Se for despesa de trabalho, recalcula divisão em background
            if (tabela === 'despesas' && data.trabalho_id) {
                recalcularDivisao(data.trabalho_id);
            }
        } catch (e) {
            res.status(400).json({ success: false, message: e.message });
        }
    });

    // DELETE — remove por id
    router.delete(`/api/${tabela}/:id`, requireAuth, async (req, res) => {
        try {
            // Para despesas, busca o trabalho_id ANTES de deletar
            let trabalhoId = null;
            if (tabela === 'despesas') {
                const { data: desp } = await req.db
                    .from('despesas').select('trabalho_id').eq('id', req.params.id).single();
                trabalhoId = desp?.trabalho_id || null;
            }

            const { error } = await req.db.from(tabela).delete().eq('id', req.params.id);
            if (error) throw error;
            res.json({ success: true });

            // Recalcula divisão após exclusão da despesa
            if (trabalhoId) {
                recalcularDivisao(trabalhoId);
            }
        } catch (e) {
            res.status(400).json({ success: false, message: e.message });
        }
    });
}

// ── ROTAS CRUD ────────────────────────────────────────────────────────────────
// Também recalcula divisão ao salvar/editar um trabalho (ganhos podem mudar)

app.get('/api/trabalhos', requireAuth, async (req, res) => {
    try {
        const { data, error } = await req.db
            .from('trabalhos').select('*').order('criado_em', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/trabalhos', requireAuth, async (req, res) => {
    try {
        const campos = ['cliente_id','operador_id','representante_id','servico',
            'dimensao_ha','valor_ha','valor_total','ganho_operador',
            'ganho_representante','saldo','data_pedido','data_execucao','status_pagamento'];
        const payload = filtrarCampos(req.body, campos);
        const { data, error } = await req.db.from('trabalhos').insert(payload).select().single();
        if (error) throw error;
        res.status(201).json(data);
        // Recalcula após criar (ainda sem despesas, mas grava divisão inicial)
        recalcularDivisao(data.id);
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

app.put('/api/trabalhos/:id', requireAuth, async (req, res) => {
    try {
        const campos = ['cliente_id','operador_id','representante_id','servico',
            'dimensao_ha','valor_ha','valor_total','ganho_operador',
            'ganho_representante','saldo','data_pedido','data_execucao','status_pagamento'];
        const payload = filtrarCampos(req.body, campos);
        const { data, error } = await req.db
            .from('trabalhos').update(payload).eq('id', req.params.id).select().single();
        if (error) throw error;
        res.json(data);
        // Recalcula pois valor_total ou ganhos podem ter mudado
        recalcularDivisao(data.id);
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

app.delete('/api/trabalhos/:id', requireAuth, async (req, res) => {
    try {
        const { error } = await req.db.from('trabalhos').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

// Demais tabelas via factory
crudRoutes(app, 'clientes', [
    'nome', 'endereco', 'latitude', 'longitude', 'carteira', 'descricao'
]);

crudRoutes(app, 'operadores', [
    'nome', 'status'
]);

crudRoutes(app, 'representantes', [
    'nome', 'status'
]);

crudRoutes(app, 'despesas', [
    'trabalho_id', 'data', 'tipo', 'valor', 'descricao'
]);

crudRoutes(app, 'despesas_gerais', [
    'data', 'tipo', 'valor', 'descricao'
]);

crudRoutes(app, 'pagamentos', [
    'trabalho_id', 'data_vencimento', 'data_pagamento', 'valor', 'status', 'descricao'
]);

// ── ROTAS DE AUTENTICAÇÃO ────────────────────────────────────────────────────

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        res.cookie('sb-access-token', data.session.access_token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: data.session.expires_in * 1000,
            sameSite: 'lax',
            path: '/'
        });
        return res.json({ success: true, redirect: '/sistema' });
    } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
    }
});

app.get('/api/user', async (req, res) => {
    const token = getToken(req);
    if (!token) return res.status(401).json({ authenticated: false });
    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
            const payload = JSON.parse(
                Buffer.from(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString()
            );
            if (payload?.email) return res.json({ authenticated: true, user: { email: payload.email } });
            throw new Error('Sessão inválida');
        }
        return res.json({ authenticated: true, user: { email: user.email } });
    } catch {
        return res.status(401).json({ authenticated: false });
    }
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('sb-access-token', { path: '/' });
    return res.json({ success: true });
});

app.post('/api/register', requireAuth, async (req, res) => {
    const { nome, email, password, perfil } = req.body;
    try {
        const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
            email, password, email_confirm: true
        });
        if (authError) throw authError;
        const { error: dbError } = await supabaseAdmin
            .from('usuarios').insert({ id: authData.user.id, nome, perfil });
        if (dbError) throw dbError;
        return res.json({ success: true });
    } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
    }
});

// ── PÁGINAS ──────────────────────────────────────────────────────────────────

app.get('/sistema', (req, res) => {
    if (!getToken(req)) return res.redirect('/manager.html');
    res.sendFile(path.join(__dirname, 'private', 'dashboard.html'));
});

app.get('/manager.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'manager.html'));
});

// ── ESTÁTICOS ────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.use('/sistema', express.static(path.join(__dirname, 'private')));

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});