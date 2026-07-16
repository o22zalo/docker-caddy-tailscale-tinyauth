# =============================================================================
# nodesync/Dockerfile — SSH sync sidecar (đồng bộ dữ liệu giữa các node)
# =============================================================================
#
# "Toàn quyền" trong flow đồng bộ:
#   - openssh-server + rsync: nhận/thực thi lệnh + đồng bộ file giữa node.
#   - docker-cli + compose: chạy lệnh TRONG docker (compose exec) qua socket.
#   - tailscale-cli: RESOLVE peer qua tailnet (status --json / ip) — đúng docs
#     userspace + accept-dns=false (không dựa system DNS).
#   - cloudflared: kênh dự phòng (cloudflared access ssh ProxyCommand).
#   - node: chạy toàn bộ script .mjs điều phối.
#   - sudo: user SSH_<n>_* được cấp NOPASSWD:ALL → chạy MỌI lệnh (kể cả root).
#
# Base: Node 24 LTS trên Alpine 3.23 (Node 20 đã EOL 2026-04-30).
# cloudflared không có trong Alpine stable repository; lấy binary từ image
# chính thức, cùng version đang pin tại cloudflare/cloudflare.yml.
# =============================================================================

FROM cloudflare/cloudflared:2026.7.1 AS cloudflared

FROM node:24-alpine3.23

COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared

RUN apk add --no-cache \
      openssh-server \
      openssh-client-default \
      sshpass \
      netcat-openbsd \
      rsync \
      rclone \
      docker-cli \
      docker-cli-compose \
      sudo \
      shadow \
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
