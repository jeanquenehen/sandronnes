FROM node:22-alpine

WORKDIR /app

# Copia todos os arquivos do repositório primeiro
COPY . .

# Garante a instalação manual das dependências essenciais para o servidor rodar
RUN npm init -y && \
    npm install express @supabase/supabase-js cookie-parser dotenv

# Expõe a porta correta
EXPOSE 3000

# Define o ambiente de produção
ENV NODE_ENV=production

# Comando de inicialização
CMD ["node", "server.js"]