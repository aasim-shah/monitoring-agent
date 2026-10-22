# A disposable Ubuntu 24.04 host with systemd as PID 1, for installer end-to-end tests (D22).
# Redis and PostgreSQL (loopback only, as packaged) are there for discovery and packs (M6b).
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv curl ca-certificates iproute2 redis-server postgresql && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
