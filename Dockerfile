# syntax=docker/dockerfile:1

FROM node:24-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM caddy:2-alpine AS runtime
LABEL org.opencontainers.image.source="https://github.com/rouing/doorking-webui" \
      org.opencontainers.image.description="Standalone React + MUI + PWA frontend for DoorKing Gate Manager"
COPY --from=builder /app/dist /srv
RUN printf ':8080 {\n\troot * /srv\n\theader Content-Security-Policy "default-src '\''self'\''; style-src '\''self'\'' '\''unsafe-inline'\''; img-src '\''self'\'' data:"\n\t@manifest path /manifest.webmanifest\n\theader @manifest Content-Type "application/manifest+json; charset=utf-8"\n\t@immutable path /assets/*\n\theader @immutable Cache-Control "public, max-age=31536000, immutable"\n\t@shell not path /assets/*\n\theader @shell Cache-Control "no-cache"\n\ttry_files {path} /index.html\n\tfile_server\n}\n' > /etc/caddy/Caddyfile

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
