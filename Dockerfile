FROM nginx:alpine

# Copia os arquivos do seu site para a pasta padrão do Nginx
COPY . /usr/share/nginx/html

# Exclui o próprio Dockerfile da imagem final (opcional)
RUN rm /usr/share/nginx/html/Dockerfile

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]