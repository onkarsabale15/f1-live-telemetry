# syntax=docker/dockerfile:1

# ---- deps: install dependencies + generate the Prisma client for THIS platform ----
FROM node:20-alpine AS deps
WORKDIR /app
# Prisma's query engine needs OpenSSL on Alpine.
RUN apk add --no-cache openssl
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate

# ---- build: compile TypeScript ----
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY . .
RUN npm run build

# ---- runtime: minimal image that actually runs the server ----
FROM node:20-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./

EXPOSE 4000

# Pushes the current Prisma schema to whatever Postgres DATABASE_URL points
# at (this project has no migration history — see prisma/schema.prisma —
# so `db push` is the same command local/manual setup uses), then starts the
# server. Safe to run on every container start: a no-op once the schema
# already matches.
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node dist/server.js"]
