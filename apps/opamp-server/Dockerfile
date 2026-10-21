# syntax=docker/dockerfile:1.7
FROM golang:1.23.12-alpine AS build
WORKDIR /src
COPY go.work ./
COPY packages/go-platform packages/go-platform
COPY packages/agent-protocol/go packages/agent-protocol/go
COPY apps/opamp-server apps/opamp-server
COPY apps/ingest-gateway apps/ingest-gateway
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/service ./apps/opamp-server

FROM alpine:3.22
RUN adduser -D -H -u 10001 app
COPY --from=build /out/service /app/service
USER app
EXPOSE 4320
ENTRYPOINT ["/app/service"]
