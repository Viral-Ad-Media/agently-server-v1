# REST API. Plain Express (api/index.js exports the app; dev-server.js wraps
# it in http.createServer), so it containerises without a Vercel adapter and
# loses the 60s maxDuration ceiling.
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

ENV PORT=8080
EXPOSE 8080
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1 || exit 1

CMD ["node", "dev-server.js"]
