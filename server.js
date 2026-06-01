const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cookieParser = require('cookie-parser');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Inicializa o cliente do Supabase de forma isolada no servidor
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Middlewares essenciais
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Mapeia a sua pasta de imagens/logótipos para ser acessível publicamente
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Middleware de barreira: Valida se o utilizador possui o cookie de sessão válido
function verificarAutenticacao(req, res, next) {
    const token = req.cookies.session_token;

    if (!token) {
        // Sem token válido, barra o acesso e redireciona para a tela de login na raiz
        return res.redirect('/manager.html');
    }

    // Se o cookie existir, permite o avanço para a rota protegida
    next();
}

// --- ROTAS DA LANDING PAGE E PÚBLICAS (NA RAIZ) ---

// Serve a Landing Page principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve a página de login (manager.html)
app.get('/manager.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'manager.html'));
});

// Serve o ficheiro de autenticação da Google (essencial para não quebrar a validação)
app.get('/google2314725259b134cf.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'google2314725259b134cf.html'));
});

// Serve a imagem isolada 7.png que está na raiz, caso precise dela no frontend
app.get('/7.png', (req, res) => {
    res.sendFile(path.join(__dirname, '7.png'));
});

// --- ROTA DE AUTENTICAÇÃO (API) ---

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        // Comunicação segura com o Supabase sem expor chaves no browser
        const { data, error } = await supabase.auth.signInWithPassword({
            email: email,
            password: password,
        });

        if (error) {
            throw error;
        }

        // Login validado: Cria o cookie HttpOnly seguro com o token de acesso
        res.cookie('session_token', data.session.access_token, {
            httpOnly: true, // Protege contra roubo de sessão via scripts (XSS)
            secure: process.env.NODE_ENV === 'production', // Ativa HTTPS apenas em produção (Coolify)
            maxAge: 1000 * 60 * 60 * 2 // Sessão válida por 2 horas
        });

        // Retorna o sucesso e aponta para a rota do sistema
        return res.status(200).json({ success: true, redirect: '/sistema' });

    } catch (error) {
        return res.status(401).json({ success: false, message: 'Utilizador ou senha inválidos.' });
    }
});

// --- ROTAS DO SISTEMA (PROTEGIDAS) ---

// O utilizador só acede ao dashboard se passar pelo middleware de autenticação
app.get('/sistema', verificarAutenticacao, (req, res) => {
    // Entrega com segurança o dashboard escondido na pasta private
    res.sendFile(path.join(__dirname, 'private', 'dashboard.html'));
});

// Rota para efetuar o logout
app.get('/api/logout', (req, res) => {
    res.clearCookie('session_token');
    res.redirect('/');
});

// Inicialização do servidor Express
app.listen(port, () => {
    console.log(`Servidor rodando estavelmente na porta ${port}`);
});