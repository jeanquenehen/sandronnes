FROM nginx:alpine

# Remove configurações e arquivos padrão para evitar conflitos
RUN rm -rf /usr/share/nginx/html/* && rm /etc/nginx/conf.d/default.conf

# Criamos uma configuração interna para garantir o roteamento correto
RUN echo 'server { \
    listen 80; \
    location / { \
        root /usr/share/nginx/html; \
        index index.html; \
        try_files $uri $uri/ /index.html; \
    } \
}' > /etc/nginx/conf.d/default.conf

# Copia os arquivos do seu repositório
COPY . /usr/share/nginx/html

# Ajusta permissões para que o Nginx possa ler os arquivos
RUN chmod -R 755 /usr/share/nginx/html && \
    chown -R nginx:nginx /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]