# A disposable Ubuntu 24.04 host with systemd as PID 1, for installer end-to-end tests (D22).
# Redis and PostgreSQL (loopback only, as packaged) are there for discovery and packs (M6b).
# sshd and sudo are there for fleet tooling over SSH (Ansible) and the assisted install (M17).
FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv curl ca-certificates iproute2 redis-server postgresql openssh-server sudo python3 socat && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
