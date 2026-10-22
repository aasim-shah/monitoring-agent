# syntax=docker/dockerfile:1.7
# Cross-compile on the build machine's architecture for the target platform.
FROM --platform=$BUILDPLATFORM golang:1.23.12-alpine AS build
ARG TARGETOS=linux
ARG TARGETARCH
WORKDIR /src
COPY go.work ./
COPY packages/go-platform packages/go-platform
COPY packages/agent-protocol/go packages/agent-protocol/go
# Every go.work module must exist for the workspace to load.
COPY agents/host-agent-go agents/host-agent-go
COPY apps/opamp-server apps/opamp-server
COPY apps/ingest-gateway apps/ingest-gateway
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/service ./apps/opamp-server

FROM alpine:3.22
RUN adduser -D -H -u 10001 app
COPY --from=build /out/service /app/service
USER app
EXPOSE 4320
ENTRYPOINT ["/app/service"]
