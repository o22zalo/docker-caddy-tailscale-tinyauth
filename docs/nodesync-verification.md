# nodesync — triển khai và kiểm chứng

## 1. Cấu hình theo vai trò

Cả hai node bật SSH server:

```dotenv
SSH_ENABLE=1
SSH_1_USER=sync
SSH_1_PUBLIC_KEY=ssh-ed25519 AAAA... sync@ci
SSH_1_PRIVATE_KEY_B64=1
SSH_1_PRIVATE_KEY=<base64-private-key>
SSH_1_PRIVILEGED=1
```

Chỉ **node02 (node nhận dữ liệu)** bật sync trước startup:

```dotenv
NODESYNC_SYNC_ON_START=1
NODESYNC_PEER_USER=sync
NODESYNC_PEER_TAILSCALE_HOST=proxy-stack-a
NODESYNC_PEER_HOST=<direct-fallback-host>
SSH_CHANNEL_TAILSCALE_ENABLE=1
SSH_CHANNEL_CLOUDFLARE_ENABLE=0
SSH_CHANNEL_HYBRID_ENABLE=1
NODESYNC_SYNC_PATHS=ci-data
```

Node01 để `NODESYNC_SYNC_ON_START=0` hoặc không khai báo. Không dùng
`NODESYNC_SYNC_PATHS=ci-runtime`: thư mục runtime chứa Tailscale identity, Caddy
state và SSH host keys riêng từng node. Chỉ opt-in một runtime subpath nếu đã
xác nhận nó thật sự có thể dùng chung.

## 2. Thứ tự startup đã hiện thực

`scripts/runners/start-stack.mjs` thực hiện:

1. Litestream restore và rclone pull.
2. Nếu `SSH_ENABLE=1` và `NODESYNC_SYNC_ON_START=1`: start `nodesync`; start
   `tailscale` nếu channel Tailscale bật.
3. Chờ `nodesync` healthy.
4. Chạy `node scripts/sync.mjs` trong container; lỗi sync làm startup thất bại.
5. Chỉ khi sync thành công mới start toàn app stack.

Kiểm tra kế hoạch mà không cần Docker daemon:

```bash
SSH_ENABLE=1 SSH_1_USER=sync \
SSH_CHANNEL_TAILSCALE_ENABLE=0 SSH_CHANNEL_HYBRID_ENABLE=1 \
NODESYNC_PEER_HOST=node01 NODESYNC_SYNC_ON_START=1 \
node scripts/runners/start-stack.mjs --dry-run
```

## 3. Kênh kết nối và fallback

- **Tailscale:** `tailscaled` chạy userspace trong sidecar `tailscale`; sidecar
  mở SOCKS5 nội bộ tại `tailscale:1055`. Nodesync đọc peer bằng
  `docker exec tailscale tailscale status --json`, rồi SSH qua
  `nc -x tailscale:1055 %h %p`.
- **Cloudflare:** `cloudflared access ssh --hostname <host>` làm ProxyCommand.
- **Hybrid:** host/IP trực tiếp.

Mỗi kênh phải qua cả **resolve** và **SSH probe**. Resolve được nhưng SSH/auth
thất bại vẫn fallback sang kênh tiếp theo.

## 4. Hold request thực tế

`hold-requests.mjs on` tạo `ci-runtime/nodesync/hold.flag`. `hold-gate.mjs` đọc
flag và trả:

- `204` khi bình thường;
- `503 Service Unavailable` + `Retry-After` khi đang sync.

Các route Caddy import snippet `nodesync_hold_gate`; snippet chỉ hoạt động khi
`SSH_ENABLE=1`. `sync.mjs` từ chối rsync nếu không bật được hold và luôn release
hold trong `finally`.

Kiểm tra trực tiếp gate:

```bash
SSH_WORKSPACE="$PWD/.work/hold-test" NODESYNC_HOLD_GATE_PORT=18088 \
  node nodesync/scripts/hold-gate.mjs
curl -i http://127.0.0.1:18088/hold                 # 204
SSH_WORKSPACE="$PWD/.work/hold-test" node nodesync/scripts/hold-requests.mjs on
curl -i http://127.0.0.1:18088/hold                 # 503 + Retry-After
```

## 5. Build và runtime verification

```bash
# Bắt lỗi package/image giống CI
docker build -f nodesync/Dockerfile -t proxy-stack-nodesync:local .

# Validate Compose
docker compose config
SSH_ENABLE=1 SSH_1_USER=sync COMPOSE_PROFILES=full docker compose config

# Start nguồn/node01 rồi kiểm tra SSH server + gate
docker compose up -d nodesync
docker compose exec -T nodesync node scripts/hold-requests.mjs status
curl -fsS http://127.0.0.1:8088/healthz  # nếu chạy từ cùng network/container

# Trên node02: chạy luồng sync thật
NODESYNC_SYNC_ON_START=1 node scripts/runners/start-stack.mjs
```

Dockerfile lấy `cloudflared` từ official image
`cloudflare/cloudflared:2026.7.1`; không cài `cloudflared` bằng Alpine APK.

## 6. Kiểm tra dữ liệu

```bash
node nodesync/scripts/verify-integrity.mjs --local <node01-dir> <node02-dir>
```

Verifier đối chiếu danh sách file, SHA-256, size, mode và mtime. Bộ test local:

```bash
cd .work/verify
node verify-nodesync.mjs
node verify-nodesync-scenarios.mjs
```

Đã execute local:

- election/handoff mock RTDB: PASS;
- 14 mẫu dữ liệu + rsync + integrity: PASS;
- 15 scenario, gồm permission diff, no-op thật, symlink nội bộ và unsafe
  symlink bị `--safe-links` bỏ qua đúng kỳ vọng: PASS 15/15;
- hold-gate HTTP: `204 → 503 + Retry-After → 204`: PASS;
- Compose core/full/CI render: PASS.

Chưa thể execute trong workspace hiện tại vì Docker daemon không có socket:

- build container nodesync;
- sshd/auth end-to-end giữa hai container;
- Tailscale/Cloudflare với credentials thật.

Các mục này phải chạy trong GitHub Actions hoặc host có Docker daemon và
credentials. Không được diễn giải local rsync test là SSH/Tailscale E2E.
