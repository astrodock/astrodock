# The relay runs as a Docker app on Astrodock so Caddy proxies every path to it.
# A Node buildpack app only gets /api/* proxied, and the relay's routes are
# /v1/* and /health.
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY src ./src
USER node
CMD ["node", "server.js"]
