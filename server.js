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

// ── HELPERS DE COOKIE ────────────────────────────────────────────────────────
const TRINTA_DIAS = 30 * 24 * 60 * 60 * 1000;

function setCookies(res, session) {
    const cookieOpts = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/'
    };
    // access_token: expira conforme o Supabase define (normalmente 1h)
    res.cookie('sb-access-token', session.access_token, {
        ...cookieOpts,
        maxAge: (session.expires_in || 3600) * 1000
    });
    // refresh_token: dura 30 dias — usado para renovar o access_token
    res.cookie('sb-refresh-token', session.refresh_token, {
        ...cookieOpts,
        maxAge: TRINTA_DIAS
    });
}

function clearCookies(res) {
    res.clearCookie('sb-access-token',  { path: '/' });
    res.clearCookie('sb-refresh-token', { path: '/' });
}

function getToken(req) {
    return req.cookies['sb-access-token'] || null;
}

function getRefreshToken(req) {
    return req.cookies['sb-refresh-token'] || null;
}

async function requireAuth(req, res, next) {
    let token = getToken(req);

    // Se não tem access_token mas tem refresh_token, renova automaticamente
    if (!token) {
        const refreshToken = getRefreshToken(req);
        if (!refreshToken) {
            return res.status(401).json({ success: false, message: 'Não autenticado.' });
        }
        try {
            const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
            if (error || !data.session) throw new Error('Refresh inválido');
            setCookies(res, data.session);
            token = data.session.access_token;
        } catch {
            clearCookies(res);
            return res.status(401).json({ success: false, message: 'Sessão expirada.' });
        }
    }

    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);

        // access_token expirado mas refresh_token ainda válido — renova
        if (error || !user) {
            const refreshToken = getRefreshToken(req);
            if (!refreshToken) throw new Error('Sem refresh token');
            const { data: refreshed, error: rErr } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
            if (rErr || !refreshed.session) throw new Error('Não foi possível renovar sessão');
            setCookies(res, refreshed.session);
            token = refreshed.session.access_token;
        }

        req.user = user;
        req.db = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_ANON_KEY,
            {
                db: { schema: 'Sandronnes' },
                auth: { persistSession: false, autoRefreshToken: false },
                global: {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        apikey: process.env.SUPABASE_ANON_KEY
                    }
                }
            }
        );
        next();
    } catch {
        clearCookies(res);
        return res.status(401).json({ success: false, message: 'Sessão expirada.' });
    }
}

function filtrarCampos(body, campos) {
    const out = {};
    campos.forEach(c => { if (body[c] !== undefined) out[c] = body[c]; });
    return out;
}

// ── CONTROLE DE ACESSO POR PAPEL ─────────────────────────────────────────────
// Papéis:
//   Administrador — acesso total
//   Sócio         — somente leitura
//   Operador      — (definir depois)
//   Representante — (definir depois)

function getPapel(req) {
    return req.user?.user_metadata?.papel || null;
}

// Bloqueia escrita (POST/PUT/DELETE) para qualquer papel que não seja Administrador.
function requireWriteAccess(req, res, next) {
    if (getPapel(req) === 'Administrador') return next();
    return res.status(403).json({ message: 'Você não tem permissão para realizar esta ação.' });
}

// Bloqueia rota inteira para qualquer papel que não seja Administrador (gestão de usuários).
function requireAdmin(req, res, next) {
    if (getPapel(req) === 'Administrador') return next();
    return res.status(403).json({ message: 'Acesso restrito a administradores.' });
}

// Aplica requireWriteAccess automaticamente a POST/PUT/DELETE de rotas /api/* específicas.
function gateWrites(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    return requireWriteAccess(req, res, next);
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

        // 4. Base de cálculo: saldo = valor_total − despesas do trabalho
        const valorTotal = parseFloat(trab.valor_total) || 0;
        const saldo = valorTotal - totalDespesas;

        // 5. Aplica percentual conforme carteira
        const carteira = (cliente.carteira || '').toLowerCase();
        let percSandro, percRafael;

        if (carteira === 'sandro') {
            percSandro = 0.60;
            percRafael = 0.40;
        } else {
            percSandro = 0.50;
            percRafael = 0.50;
        }

        const sandroRecebe = parseFloat((saldo * percSandro).toFixed(2));
        const rafaelRecebe = parseFloat((saldo * percRafael).toFixed(2));

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
            console.error(`[GET /api/${tabela}]`, e.message, e);
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // POST — cria novo
    router.post(`/api/${tabela}`, requireAuth, requireWriteAccess, async (req, res) => {
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
    router.put(`/api/${tabela}/:id`, requireAuth, requireWriteAccess, async (req, res) => {
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
    router.delete(`/api/${tabela}/:id`, requireAuth, requireWriteAccess, async (req, res) => {
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

app.post('/api/trabalhos', requireAuth, requireWriteAccess, async (req, res) => {
    try {
        const campos = ['cliente_id','operador_id','representante_id','servico',
            'dimensao_ha','valor_ha','valor_total','ganho_operador',
            'ganho_representante','saldo','data_pedido','data_execucao',
            'status_pagamento','status_trabalho'];
        const payload = filtrarCampos(req.body, campos);
        const { data, error } = await req.db.from('trabalhos').insert(payload).select().single();
        if (error) throw error;
        res.status(201).json(data);

        // Lança despesas automáticas de comissão em background
        const dataRef = data.data_execucao || data.data_pedido || new Date().toISOString().slice(0,10);

        // 1. Comissão do operador
        const ganhoOp = parseFloat(data.ganho_operador) || 0;
        if (ganhoOp > 0) {
            await supabaseAdmin.from('despesas').insert({
                trabalho_id: data.id,
                data: dataRef,
                tipo: 'Comissão operador',
                valor: ganhoOp,
                descricao: 'Lançado automaticamente ao criar trabalho'
            });
        }

        // 2. Comissão do representante (somente se houver)
        const ganhoRep = parseFloat(data.ganho_representante) || 0;
        if (ganhoRep > 0 && data.representante_id) {
            await supabaseAdmin.from('despesas').insert({
                trabalho_id: data.id,
                data: dataRef,
                tipo: 'Comissão representante',
                valor: ganhoRep,
                descricao: 'Lançado automaticamente ao criar trabalho'
            });
        }

        // Recalcula divisão sócios após lançar as despesas
        recalcularDivisao(data.id);
    } catch (e) {
        res.status(400).json({ success: false, message: e.message });
    }
});

app.put('/api/trabalhos/:id', requireAuth, requireWriteAccess, async (req, res) => {
    try {
        const campos = ['cliente_id','operador_id','representante_id','servico',
            'dimensao_ha','valor_ha','valor_total','ganho_operador',
            'ganho_representante','saldo','data_pedido','data_execucao',
            'status_pagamento','status_trabalho'];
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

app.delete('/api/trabalhos/:id', requireAuth, requireWriteAccess, async (req, res) => {
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

// Investimentos
app.get('/api/investimentos', requireAuth, async (req, res) => {
    try {
        const { data, error } = await req.db
            .from('investimentos').select('*').order('criado_em', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (e) {
        console.error('[GET /api/investimentos]', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});
app.post('/api/investimentos', requireAuth, requireWriteAccess, async (req, res) => {
    try {
        const payload = filtrarCampos(req.body, ['data', 'valor', 'descricao']);
        const { data, error } = await req.db
            .from('investimentos').insert(payload).select().single();
        if (error) throw error;
        res.status(201).json(data);
    } catch (e) {
        console.error('[POST /api/investimentos]', e.message);
        res.status(400).json({ success: false, message: e.message });
    }
});
app.put('/api/investimentos/:id', requireAuth, requireWriteAccess, async (req, res) => {
    try {
        const payload = filtrarCampos(req.body, ['data', 'valor', 'descricao']);
        const { data, error } = await req.db
            .from('investimentos').update(payload).eq('id', req.params.id).select().single();
        if (error) throw error;
        res.json(data);
    } catch (e) {
        console.error('[PUT /api/investimentos]', e.message);
        res.status(400).json({ success: false, message: e.message });
    }
});
app.delete('/api/investimentos/:id', requireAuth, requireWriteAccess, async (req, res) => {
    try {
        const { error } = await req.db
            .from('investimentos').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        console.error('[DELETE /api/investimentos]', e.message);
        res.status(400).json({ success: false, message: e.message });
    }
});

crudRoutes(app, 'despesas_gerais', [
    'data', 'tipo', 'valor', 'descricao'
]);

crudRoutes(app, 'pagamentos', [
    'trabalho_id', 'data_vencimento', 'data_pagamento', 'valor', 'descricao'
]);

// ── ROTAS DE AUTENTICAÇÃO ────────────────────────────────────────────────────

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        setCookies(res, data.session);
        return res.json({ success: true, redirect: '/sistema' });
    } catch (e) {
        return res.status(400).json({ success: false, message: e.message });
    }
});

app.get('/api/user', async (req, res) => {
    let token = getToken(req);

    // Tenta renovar com refresh_token se access_token ausente
    if (!token) {
        const refreshToken = getRefreshToken(req);
        if (!refreshToken) return res.status(401).json({ authenticated: false });
        try {
            const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
            if (error || !data.session) throw new Error();
            setCookies(res, data.session);
            token = data.session.access_token;
        } catch {
            clearCookies(res);
            return res.status(401).json({ authenticated: false });
        }
    }

    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);
        if (error || !user) {
            // Tenta renovar com refresh_token
            const refreshToken = getRefreshToken(req);
            if (!refreshToken) throw new Error();
            const { data: refreshed, error: rErr } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
            if (rErr || !refreshed.session) throw new Error();
            setCookies(res, refreshed.session);
            const ru = refreshed.session.user;
            return res.json({ authenticated: true, user: { email: ru.email, nome: ru.user_metadata?.nome || '', papel: ru.user_metadata?.papel || '' } });
        }
        return res.json({ authenticated: true, user: { email: user.email, nome: user.user_metadata?.nome || '', papel: user.user_metadata?.papel || '' } });
    } catch {
        clearCookies(res);
        return res.status(401).json({ authenticated: false });
    }
});

app.post('/api/logout', (req, res) => {
    clearCookies(res);
    return res.json({ success: true });
});

app.post('/api/register', requireAuth, requireAdmin, async (req, res) => {
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

// ── USUÁRIOS (admin) ─────────────────────────────────────────────────────────
// Sufixo interno para "emails falsos": username vira username@sandronnes.com.br
const USER_DOMAIN = '@sandronnes.com.br';
const toEmail = u => String(u || '').trim().toLowerCase() + USER_DOMAIN;
const toUsername = email => String(email || '').replace(USER_DOMAIN, '');
const PAPEIS_VALIDOS = ['Administrador', 'Sócio', 'Operador', 'Representante'];

app.get('/api/usuarios', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin.auth.admin.listUsers();
        if (error) throw error;
        const lista = (data.users || []).map(u => ({
            id: u.id,
            username: toUsername(u.email),
            nome: u.user_metadata?.nome || '',
            papel: u.user_metadata?.papel || '',
            created_at: u.created_at,
            last_sign_in_at: u.last_sign_in_at
        }));
        return res.json(lista);
    } catch (e) {
        console.error('[GET /api/usuarios] erro:', e);
        return res.status(500).json({ message: e.message || String(e) });
    }
});

app.post('/api/usuarios', requireAuth, requireAdmin, async (req, res) => {
    const { username, password, nome, papel } = req.body || {};
    try {
        if (!username || !/^[a-z0-9._-]{2,}$/i.test(username))
            throw new Error('Username inválido. Use letras, números, ponto, traço e underline.');
        if (!password || password.length < 6)
            throw new Error('A senha precisa ter no mínimo 6 caracteres.');
        if (!nome || !nome.trim())
            throw new Error('Nome é obrigatório.');
        if (!PAPEIS_VALIDOS.includes(papel))
            throw new Error('Papel inválido.');

        const { data, error } = await supabaseAdmin.auth.admin.createUser({
            email: toEmail(username),
            password,
            email_confirm: true,
            user_metadata: { nome: nome.trim(), papel }
        });
        if (error) throw error;
        return res.json({ success: true, id: data.user.id });
    } catch (e) {
        console.error('[POST /api/usuarios] erro:', e);
        return res.status(400).json({ message: e.message || String(e) });
    }
});

app.put('/api/usuarios/:id', requireAuth, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { username, password, nome, papel } = req.body || {};
    try {
        if (!nome || !nome.trim()) throw new Error('Nome é obrigatório.');
        if (!PAPEIS_VALIDOS.includes(papel)) throw new Error('Papel inválido.');
        if (!username || !/^[a-z0-9._-]{2,}$/i.test(username))
            throw new Error('Username inválido.');
        if (password && password.length < 6)
            throw new Error('A nova senha precisa ter no mínimo 6 caracteres.');

        const update = {
            email: toEmail(username),
            user_metadata: { nome: nome.trim(), papel }
        };
        if (password) update.password = password;

        const { error } = await supabaseAdmin.auth.admin.updateUserById(id, update);
        if (error) throw error;
        return res.json({ success: true });
    } catch (e) {
        return res.status(400).json({ message: e.message });
    }
});

app.delete('/api/usuarios/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { error } = await supabaseAdmin.auth.admin.deleteUser(req.params.id);
        if (error) throw error;
        return res.json({ success: true });
    } catch (e) {
        return res.status(400).json({ message: e.message });
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