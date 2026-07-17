# =============================================================================
# nodesync/Dockerfile — SSH sync sidecar (đồng bộ dữ liệu giữa các node)
# =============================================================================
#
# Transport trong flow đồng bộ:
#   - openssh-client + rsync: đồng bộ/execute tới sshd trên CI runner.
#   - netcat: chuyển TCP qua SOCKS5 của Tailscale sidecar.
#   - cloudflared: Access client outbound; KHÔNG chạy connector local lúc sync.
#   - node: chạy toàn bộ script .mjs điều phối.
#
# Base: Node 24 LTS trên Alpine 3.23 (Node 20 đã EOL 2026-04-30).
# =============================================================================

# Reuse the exact cloudflared version pinned by cloudflare/cloudflare.yml. This
# binary is only an outbound Access client during predecessor sync; the local
# connector service intentionally remains stopped until sync completes.
FROM cloudflare/cloudflared:2026.7.1 AS cloudflared

FROM node:24-alpine3.23

COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared

RUN apk add --no-cache \
      openssh-client-default \
      netcat-openbsd \
      rsync \
      rclone \
      bash \
      coreutils \
      findutils \
      curl \
      tini \
    && cloudflared --version \
    && rm -rf /var/cache/apk/*

# Tailscale chạy ở sidecar riêng. Nodesync chuyển mọi tailnet connection qua
# SOCKS5 `tailscale:1055`; không gọi Docker host và không dựa system MagicDNS.

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
