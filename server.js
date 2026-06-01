const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    db: { schema: 'Sandronnes' },
    auth: {
        persistSession: false,
        autoRefreshToken: false
    }
});

// 1. MIDDLEWARES ESSENCIAIS (Sempre no topo)
app.use(express.json());
app.use(cookieParser());

// 2. ROTAS DE API (Devem vir ANTES dos arquivos estáticos para evitar conflito de 404)

// ROTA: Realiza o Login Seguro
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) throw error;

        res.cookie('sb-access-token', data.session.access_token, {
            httpOnly: true,
            secure: true, 
            maxAge: data.session.expires_in * 1000,
            sameSite: 'lax',
            path: '/' 
        });

        return res.json({ success: true, redirect: '/sistema' });

    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
});

// ROTA: Verifica quem é o usuário logado
app.get('/api/user', async (req, res) => {
    const token = req.cookies['sb-access-token'];

    if (!token) {
        return res.status(401).json({ authenticated: false });
    }

    try {
        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
            // Fallback de decodificação local caso o domínio customizado interfira
            const base64Url = token.split('.')[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            const jsonPayload = decodeURIComponent(Buffer.from(base64, 'base64').toString().split('').map(function(c) {
                return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
            }).join(''));

            const sessionData = JSON.parse(jsonPayload);
            if (sessionData && sessionData.email) {
                return res.json({ authenticated: true, user: { email: sessionData.email } });
            }
            throw error || new Error('Sessão inválida');
        }

        return res.json({ authenticated: true, user: { email: user.email } });
    } catch (error) {
        return res.status(401).json({ authenticated: false });
    }
});

// ROTA: Logout Seguro
app.post('/api/logout', (req, res) => {
    res.clearCookie('sb-access-token', { path: '/' });
    return res.json({ success: true });
});

// ROTA: Cadastro de novos usuários
app.post('/api/register', async (req, res) => {
    const { nome, email, password, perfil } = req.body;

    try {
        const { data: authData, error: authError } = await supabase.auth.signUp({ email, password });
        if (authError) throw authError;

        const { error: dbError } = await supabase
            .from('usuarios')
            .insert({ id: authData.user.id, nome, perfil });
            
        if (dbError) throw dbError;

        return res.json({ success: true });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
});

// 3. ROTAS DE PÁGINAS (ENTREGA DE HTML)

// Rota protegida do Dashboard
app.get('/sistema', (req, res) => {
    const token = req.cookies['sb-access-token'];
    if (!token) {
        return res.redirect('/manager.html');
    }
    res.sendFile(path.join(__dirname, 'private', 'dashboard.html'));
});

// Rota explícita da página de Login
app.get('/manager.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'manager.html'));
});

// 4. ARQUIVOS ESTÁTICOS (Sempre por último, servem de fallback para CSS, JS da raiz e da pasta private)
app.use(express.static(path.join(__dirname)));
app.use('/sistema', express.static(path.join(__dirname, 'private')));

// Inicialização do servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando estavelmente na porta ${PORT}`);
});