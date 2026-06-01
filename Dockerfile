FROM node:20-alpine

WORKDIR /app

# Copia os arquivos de mapeamento de dependências
COPY package*.json ./

# Instala apenas as dependências de produção necessárias
RUN npm install --only=production

# Copia absolutamente todos os arquivos do seu projeto para dentro do container
# Isso inclui a pasta private/, o manager.html, o server.js, etc.
COPY . .

# Informa ao Docker que a aplicação escuta na porta 3000
EXPOSE 3000

# Define a variável de ambiente para otimizar o Node em produção
ENV NODE_ENV=production

# Comando que o Coolify vai executar para ligar o seu servidor Express real
CMD ["node", "server.js"]