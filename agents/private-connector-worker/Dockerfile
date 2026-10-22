# syntax=docker/dockerfile:1.7
# Private connector worker (M8.1). Runs inside the customer network:
#   docker run -d --name pcp-private-worker --restart unless-stopped \
#     -v pcp-worker:/var/lib/pcp-worker -v /etc/pcp-worker/secrets:/etc/pcp-worker/secrets:ro \
#     <image> enroll-and-run --token … --control-url …
FROM node:22.20.0-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@pcp/private-connector-worker...
RUN pnpm deploy --filter=@pcp/private-connector-worker --prod /out

FROM node:22.20.0-alpine
ENV NODE_ENV=production PCP_STATE_DIR=/var/lib/pcp-worker PCP_SECRETS_DIR=/etc/pcp-worker/secrets
WORKDIR /app
COPY --from=build --chown=node:node /out .
RUN mkdir -p /var/lib/pcp-worker && chown node:node /var/lib/pcp-worker && chmod 700 /var/lib/pcp-worker
USER node
VOLUME ["/var/lib/pcp-worker"]
ENTRYPOINT ["node", "dist/main.js"]
CMD ["run"]
