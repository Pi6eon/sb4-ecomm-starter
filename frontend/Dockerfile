FROM node:22.22-alpine AS build
WORKDIR /workspace
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
ENV BFF_HOST=bff
ENV BFF_PORT=3000
ENV NGINX_RESOLVER=127.0.0.11
ENV NGINX_ENVSUBST_FILTER=^(BFF_HOST|BFF_PORT|NGINX_RESOLVER)$
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /workspace/dist/shop-storefront/browser /usr/share/nginx/html
RUN sed -i 's#pid        /run/nginx.pid;#pid        /tmp/nginx.pid;#' /etc/nginx/nginx.conf \
    && chown -R nginx:nginx /etc/nginx/conf.d /var/cache/nginx /usr/share/nginx/html
USER nginx
EXPOSE 8080
