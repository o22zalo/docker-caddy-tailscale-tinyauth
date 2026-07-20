# =============================================================================
# orchestrator/Dockerfile — RTDB-as-Consul sidecar
# =============================================================================
#
# Sidecar có "toàn quyền" trong flow này:
#   - Nói chuyện Docker qua docker.sock (điều khiển compose, xem log, ps...)
#   - Đọc/ghi workspace repo (mount read-only mặc định, /data ghi được)
#   - Kết nối Firebase RTDB làm consul điều phối leader/standby
#
# Base: Node 24 LTS trên Alpine 3.23 + docker-cli + compose plugin (để chạy `docker compose`)
# =============================================================================

FROM node:24-alpine3.23

# docker-cli + compose plugin: cần để sidecar gọi `docker compose ...` qua socket
RUN --mount=type=cache,target=/var/cache/apk apk add \
      docker-cli \
      docker-cli-compose \
      curl \
      bash \
      tini

WORKDIR /app

# Cài deps trước để tận dụng layer cache
COPY orchestrator/package.json ./package.json
COPY orchestrator/package-lock.json ./package-lock.json
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

# Copy toàn bộ code sidecar
COPY orchestrator/ ./

# tini làm init để reap zombie + forward signal (quan trọng cho graceful handoff)
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "scripts/main.mjs"]
