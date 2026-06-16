# Klove backend — always-on Node service (Fastify + Prisma + background workers + Playwright/Chromium).
FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Native deps Prisma + Chromium need at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install node deps (dev deps included so we can build TS + generate the Prisma client).
COPY package*.json ./
RUN npm ci

COPY . .

# Prisma client, then the headless browser the web-booking channel uses, then compile TS → dist/.
RUN npx prisma generate
RUN npx playwright install --with-deps chromium
RUN npm run build

EXPOSE 8080
# Env comes from fly secrets (not a .env file) in prod.
CMD ["node", "dist/index.js"]
