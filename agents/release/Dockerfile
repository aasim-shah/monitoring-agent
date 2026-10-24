# syntax=docker/dockerfile:1.7
# Agent distribution (master plan M6.1, M6.7): pcp-agentctl + pcp-otelcol for linux/amd64
# and linux/arm64, packed as pcp-agent-<version>-linux-<arch>.tar.gz with SHA256SUMS,
# served with install.sh by the `downloads` service.
ARG AGENT_VERSION=0.5.0

# The collector needs Go 1.26 (OpenTelemetry v0.162.0); our own code builds with 1.23.
FROM --platform=$BUILDPLATFORM golang:1.26.9-alpine AS collector
RUN --mount=type=cache,id=go-mod,target=/go/pkg/mod \
    go install go.opentelemetry.io/collector/cmd/builder@v0.162.0
WORKDIR /build
COPY agents/host-agent-go/collector/builder-config.yaml .
# go build -p 2: the collector's largest packages (AWS SDK) run out of memory on 4 GB build VMs when compiled in parallel.
RUN --mount=type=cache,id=go-mod,target=/go/pkg/mod --mount=type=cache,id=go-build,target=/root/.cache/go-build \
    builder --config builder-config.yaml --skip-compilation && \
    cd build && for arch in amd64 arm64; do \
      CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -p 2 -trimpath -ldflags="-s -w" -o /out/$arch/pcp-otelcol . || exit 1; \
    done

FROM --platform=$BUILDPLATFORM golang:1.23.12-alpine AS agentctl
WORKDIR /src
COPY packages/agent-protocol/go packages/agent-protocol/go
COPY agents/host-agent-go agents/host-agent-go
ARG AGENT_VERSION
RUN --mount=type=cache,id=go-mod,target=/go/pkg/mod --mount=type=cache,id=go-build,target=/root/.cache/go-build \
    cd agents/host-agent-go && for arch in amd64 arm64; do \
      CGO_ENABLED=0 GOOS=linux GOARCH=$arch GOWORK=off go build -trimpath \
        -ldflags="-s -w -X main.version=${AGENT_VERSION}" -o /out/$arch/pcp-agentctl ./cmd/pcp-agentctl || exit 1; \
      CGO_ENABLED=0 GOOS=linux GOARCH=$arch GOWORK=off go build -trimpath \
        -ldflags="-s -w -X main.version=${AGENT_VERSION}" -o /out/$arch/pcp-helper ./cmd/pcp-helper || exit 1; \
    done

FROM --platform=$BUILDPLATFORM alpine:3.22 AS package
ARG AGENT_VERSION
COPY --from=collector /out /bin-out
COPY --from=agentctl /out /bin-out
RUN mkdir -p /dist && for arch in amd64 arm64; do \
      tar -C /bin-out/$arch -czf /dist/pcp-agent-${AGENT_VERSION}-linux-$arch.tar.gz pcp-agentctl pcp-otelcol pcp-helper; \
    done && cd /dist && sha256sum *.tar.gz > SHA256SUMS && echo "${AGENT_VERSION}" > VERSION

FROM scratch AS dist
COPY --from=package /dist /

# install.sh with the systemd unit embedded, so the installer is one self-contained file.
FROM --platform=$BUILDPLATFORM alpine:3.22 AS installer
COPY agents/host-agent-go/packaging/systemd/pcp-agent.service agents/host-agent-go/packaging/systemd/pcp-helper.service agents/host-agent-go/installer/install.sh /in/
RUN awk 'FILENAME == ARGV[1] { unit = unit $0 "\n"; next } FILENAME == ARGV[2] { helper = helper $0 "\n"; next } \
         /^@@UNIT@@$/ { printf "%s", unit; next } /^@@HELPER_UNIT@@$/ { printf "%s", helper; next } { print }' \
      /in/pcp-agent.service /in/pcp-helper.service /in/install.sh > /install.sh && chmod 0644 /install.sh && ! grep -q '@@' /install.sh

# Fleet tooling (M17.2): /downloads/install/pcp_agent-role.tar.gz and compose-agent.tar.gz.
FROM --platform=$BUILDPLATFORM alpine:3.22 AS fleet
COPY infrastructure/install /in
RUN mkdir -p /out && tar -C /in/ansible/roles -czf /out/pcp_agent-role.tar.gz pcp_agent \
    && tar -C /in -czf /out/compose-agent.tar.gz compose-agent \
    && cp /in/cloud-init/user-data.yaml.tmpl /out/

# Level 1 exporters (M18.3): the exact releases pcp-helper pins, checked here and again on the host.
FROM --platform=$BUILDPLATFORM alpine:3.22 AS exporters
RUN apk add --no-cache curl && mkdir -p /out && cd /out && \
    printf '%s  %s\n' \
      ed2e531fa68ca2b8604544e19d1088fe409d0592b9ab4f3093fba0783c764972 redis_exporter-v1.93.0.linux-amd64.tar.gz \
      c41f29c98ed45964f0588c8644f74b06bae703f696244536691f09ecf7b081a1 redis_exporter-v1.93.0.linux-arm64.tar.gz \
      246720dc4ecd8670801625423b7e44bbeb93115de07353cc6b4ea27e5bb7b87d kafka_exporter-1.10.0.linux-amd64.tar.gz \
      47c3c19eec67a511fde2afcc714f9cdc382642ffcd72a1ac4c9535d8d433fee1 kafka_exporter-1.10.0.linux-arm64.tar.gz \
      > SHA256SUMS && \
    for a in amd64 arm64; do \
      curl -fsSLO https://github.com/oliver006/redis_exporter/releases/download/v1.93.0/redis_exporter-v1.93.0.linux-$a.tar.gz && \
      curl -fsSLO https://github.com/danielqsj/kafka_exporter/releases/download/v1.10.0/kafka_exporter-1.10.0.linux-$a.tar.gz || exit 1; \
    done && sha256sum -c SHA256SUMS

# The `downloads` service: /install.sh and /downloads/<tarballs, SHA256SUMS, VERSION>.
FROM caddy:2.10.2-alpine AS downloads
COPY --from=package /dist /srv/downloads
COPY --from=installer /install.sh /srv/install.sh
COPY --from=fleet /out /srv/downloads/install
COPY --from=exporters /out /srv/downloads/exporters
COPY agents/release/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
