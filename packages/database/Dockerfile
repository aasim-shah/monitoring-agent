# syntax=docker/dockerfile:1.7
# Migration image: `pcp-db migrate` (role bootstrap + prisma migrate deploy).
FROM node:22.20.0-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 TURBO_TELEMETRY_DISABLED=1
RUN apk add --no-cache openssl && corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@pcp/database
RUN pnpm deploy --filter=@pcp/database --prod /out

FROM node:22.20.0-alpine
# Prisma's musl engines link OpenSSL 3.
RUN apk add --no-cache openssl
ENV NODE_ENV=production PRISMA_HIDE_UPDATE_MESSAGE=1
WORKDIR /app
COPY --from=build --chown=node:node /out .
USER node
CMD ["node", "dist/cli.js", "migrate"]
