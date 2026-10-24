# UC-05-04: the host agent as a container. The release tarball is verified against SHA256SUMS.
FROM debian:12.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
ARG PCP_DOWNLOAD_URL
RUN set -eu; test -n "$PCP_DOWNLOAD_URL"; cd /tmp; \
    arch="$(dpkg --print-architecture)"; version="$(curl -fsSL "$PCP_DOWNLOAD_URL/VERSION")"; \
    t="pcp-agent-$version-linux-$arch.tar.gz"; \
    curl -fsSLO "$PCP_DOWNLOAD_URL/$t"; curl -fsSL "$PCP_DOWNLOAD_URL/SHA256SUMS" | grep " $t\$" | sha256sum -c -; \
    tar -xzf "$t" -C /usr/local/bin pcp-agentctl pcp-otelcol; rm -f "$t"
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
