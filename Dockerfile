FROM nginx:alpine

# 1. Limpa tudo
RUN rm -rf /usr/share/nginx/html/*

# 2. Copia apenas o que é necessário para o site
# Isso evita levar o Dockerfile e o docker-compose para dentro da pasta pública
COPY index.html /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/
COPY 7.png /usr/share/nginx/html/

# 3. Ajusta permissões explicitamente
RUN chmod -R 755 /usr/share/nginx/html && \
    chown -R nginx:nginx /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]