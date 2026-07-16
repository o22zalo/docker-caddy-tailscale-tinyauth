# =============================================================================
# nodesync/Dockerfile — SSH sync sidecar (đồng bộ dữ liệu giữa các node)
# =============================================================================
#
# "Toàn quyền" trong flow đồng bộ:
#   - openssh-client + rsync: đồng bộ/execute tới sshd trên CI runner.
#   - docker-cli + compose: chạy lệnh TRONG docker (compose exec) qua socket.
#   - tailscale-cli: RESOLVE peer qua tailnet (status --json / ip) — đúng docs
#     userspace + accept-dns=false (không dựa system DNS).
#   - cloudflared: kênh dự phòng (cloudflared access ssh ProxyCommand).
#   - node: chạy toàn bộ script .mjs điều phối.
#
# Base: Node 24 LTS trên Alpine 3.23 (Node 20 đã EOL 2026-04-30).
# =============================================================================

FROM node:24-alpine3.23

RUN apk add --no-cache \
      openssh-client-default \
      netcat-openbsd \
      rsync \
      rclone \
      docker-cli \
      docker-cli-compose \
      bash \
      coreutils \
      findutils \
      curl \
      tini \
    && rm -rf /var/cache/apk/*

# Tailscale chạy ở sidecar riêng. Nodesync gọi CLI bằng `docker exec tailscale`
# và chuyển SSH qua SOCKS5 `tailscale:1055`; không cài tailscale APK tại đây.

WORKDIR /app

# Cài deps trước (layer cache).
COPY nodesync/package.json ./package.json
COPY nodesync/package-lock.json ./package-lock.json
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# Copy code sidecar.
COPY nodesync/ ./

# tini init → reap zombie + forward signal.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "scripts/entrypoint.mjs"]
