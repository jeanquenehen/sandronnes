FROM nginx:alpine

# Limpa qualquer arquivo padrão do Nginx para evitar conflitos
RUN rm -rf /usr/share/nginx/html/*

# Copia todo o conteúdo da sua pasta atual para o diretório do Nginx
COPY . /usr/share/nginx/html

# Garante que as permissões de leitura estão corretas
RUN chmod -R 755 /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]