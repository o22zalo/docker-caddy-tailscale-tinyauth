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
# Base: node 20 alpine.
# cloudflared không có trong Alpine stable repository; lấy binary từ image
# chính thức, cùng version đang pin tại cloudflare/cloudflare.yml.
# =============================================================================

FROM cloudflare/cloudflared:2026.7.1 AS cloudflared

FROM node:20-alpine

COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared

RUN apk add --no-cache \
  openssh-server \
  openssh-client \
  rsync \
  rclone \
  docker-cli \
  docker-cli-compose \
  sudo \
  bash \
  coreutils \
  findutils \
  curl \
  tini \
  && rm -rf /var/cache/apk/*

# Tailscale CLI (client) — dùng để resolve peer qua tailnet (LocalAPI).
# Cài từ package alpine nếu có; nếu không, kênh tailscale sẽ báo reason rõ ràng.
RUN apk add --no-cache tailscale || echo "WARN: tailscale-cli không cài được từ apk (kênh tailscale sẽ fallback)"

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
