# CI Workflow Optimization — docker-caddy-tailscale-tinyauth

Tài liệu tóm tắt lần tái cấu trúc CI theo `prompt-docker-caddy-tailscale-tinyauth-20260720080307.md`.

Nguyên tắc tối cao: **Tính đúng đắn > tốc độ.** Khi source/Dockerfile/lockfile/compose
thay đổi, stack BẮT BUỘC chạy image build từ commit hiện tại — không bao giờ silently
chạy image cũ.

## Thay đổi theo từng phần

### 1. Workflow `.github/workflows/test.yml` (tái cấu trúc 9 phase)
- Gom step thành 9 phase có tiền tố `P1..P8` + timestamp `ts:start/ts:end` để đo thực tế.
- `permissions` giảm xuống tối thiểu: `contents: read`, `actions: write`, `id-token: write`.
- Bật `concurrency` theo branch (KHÔNG cancel-in-progress vì keep-alive giữ stack có chủ đích).
- Phase 4 gọi `setup-host.mjs` (điều phối song song an toàn) thay 5 step tuần tự.
- Phase 5 chèn `verify-stack-images.mjs` TRƯỚC Start stack (cửa an toàn image).

### 2. Docker cache (BuildKit gha, bỏ tar image cache mặc định)
- **Bỏ hẳn** tar image cache (`actions/cache` + `docker load` ~29s/413MB) khỏi đường mặc định.
- Luôn `docker/setup-buildx-action@v3` + `docker/bake-action@v6` với:
  - `source: .` — build từ checkout local (v6 mặc định build remote git ref!).
  - `load: true` — Compose dùng image local `proxy-stack-*` vừa build.
  - `type=gha` scope riêng từng target (`webssh`/`rclone`/`orchestrator`/`nodesync`).
- `docker-bake.hcl`: thêm `variable "GIT_SHA"` → label revision (truy vết commit; không phá cache).
- `verify-stack-images.mjs`: verify image local khớp run hiện tại; FAIL RÕ RÀNG nếu thiếu/lệch.
- Helper tar cũ (`cache-docker-build-github.mjs`/`-azure.mjs`) giữ lại làm fallback explicit, KHÔNG mặc định.

### 3. Setup Host & SSH
- `setup-host.mjs` điều phối:
  - `ssh:env` (materialize) chạy TRƯỚC.
  - Nhánh A ghi .env tuần tự (tránh race): `smoke-data` → `tinyauth-ci-user`.
  - Nhánh B SSH tuần tự: `setup-users` → `setup-nodesync-ssh`.
  - Hai nhánh chạy SONG SONG với nhau.
- `setup-nodesync-ssh.mjs`:
  - Chỉ cài `openssh-server` KHI THIẾU `sshd` (không cài lại rsync/sshpass).
  - Đọc `/etc/ssh/ssh_host_ed25519_key.pub` trực tiếp thay `ssh-keyscan` qua network
    (giữ manifest format tương thích: prefix `127.0.0.1`).
  - Tạo riêng host key ed25519, chỉ khi chưa tồn tại (không `ssh-keygen -A`).
  - Chỉ restart sshd khi drop-in THỰC SỰ đổi; luôn `sshd -t` trước (re)start.

### 4. Start stack / Tailscale / leader election
- Tách logic trùng giữa `up.mjs` và `start-stack.mjs` vào `scripts/lib/stack-lib.mjs`
  (single source of truth).
- **Bỏ hard-wait 8s** (`TS_MESH_WARMUP_SECONDS`) → probe SOCKS5 `nc -z` tới predecessor,
  retry ngắn có backoff, thoát ngay khi OK (KHÔNG throw — sync.mjs còn tự warmup + fallback).
- **Bỏ `sleep(3000)`** chờ RTDB timestamp → discover ngay.
- **Node đầu tiên** (predecessor.json `source=null`) → skip probe/rsync; sync.mjs ghi
  `sync-ok(first-runner)`; orchestrator giành leader trống (term=1).
- `waitForHealthy` poll 750ms (thay 2s), giữ nguyên tiêu chí healthy.
- `sleep 3` kiểm tra cloudflared → poll `waitForServiceRunning` (fail fast).
- `publish.mjs` idempotent: cache `ci-runtime/tailscale/published.json` (config hash);
  skip API PUT/POST + CLI advertise nếu hash khớp và serve state còn tồn tại.

### 5. An toàn & nghiệm thu
- In commit SHA + image digest trước Start stack; verify image từ chối chạy image cũ.
- Secrets mask; log không in token/password/private key.
- `always()` cleanup + collect/upload logs giữ nguyên; teardown không che lỗi gốc.

## Bất biến được giữ
- **TCP 2222** (tailscale serve → host sshd:22) không bị bất kỳ thay đổi nào đụng tới.
- Publish lỗi chỉ warning, không làm gãy stack/sync.
- Thứ tự an toàn cho node có predecessor: transport → discover → sync xong → cloudflared.

## Kiểm thử
- `npm test` → 34 unit test (stack-lib 23 + publish-state 11) PASS.
- Không có Docker/GitHub runner trong môi trường dev → xác thực qua `--dry-run` + unit test
  + review 3 lớp. CI thực tế cần chạy trên GitHub Actions để nghiệm thu end-to-end.

## File thay đổi
| File | Loại |
|------|------|
| `.github/workflows/test.yml` | sửa (9 phase) |
| `.github/workflows/docker-bake.hcl` | sửa (GIT_SHA label) |
| `scripts/lib/stack-lib.mjs` | mới (single source of truth) |
| `scripts/runners/setup-host.mjs` | mới (điều phối Setup Host) |
| `scripts/runners/verify-stack-images.mjs` | mới (cửa an toàn image) |
| `scripts/runners/setup-nodesync-ssh.mjs` | viết lại (tối ưu SSH) |
| `scripts/runners/start-stack.mjs` | sửa (bỏ hard-wait, dùng stack-lib) |
| `scripts/up.mjs` | sửa (đồng bộ start-stack) |
| `tailscale/scripts/publish.mjs` | sửa (idempotent) |
| `tailscale/scripts/lib/publish-state.mjs` | mới (idempotency cache) |
| `scripts/test/stack-lib.test.mjs` | mới (unit test) |
| `tailscale/test/publish-state.test.mjs` | mới (unit test) |
| `package.json` | thêm script `test` |

---

## Triển khai theo phương án mới

### Bối cảnh: hai kịch bản chạy

| Kịch bản | Mô tả | Khi nào dùng |
|----------|-------|---------------|
| **Named tunnel** (prod) | `CF_TUNNEL_TOKEN` có giá trị → cloudflared kết nối tunnel cố định qua dashboard | Production, staging, CI đầy đủ secret |
| **Quick tunnel** (CI fallback) | Không có token → cloudflared tạo URL `*.trycloudflare.com` tạm | CI khi `ENV_FILE` secret chưa có, test nhanh |

Cả hai kịch bản đều dùng cùng một script `up.mjs` (dev/prod) hoặc `start-stack.mjs` (CI runner).
Logic khác nhau chỉ ở `MODE` (named vs quick) và compose file (`docker-compose.yml` hoặc cộng thêm `docker-compose.ci.yml`).

### Bước 1: Chuẩn bị `.env`

```bash
cp .env.example .env
# Sửa các giá trị bắt buộc (xem bảng bên dưới)
```

**Tối thiểu cho `core` profile** (public stack qua Cloudflare):

```env
COMPOSE_PROFILES=core
DOMAIN=example.com
CF_TUNNEL_TOKEN=eyJ...
TINYAUTH_APPURL=https://auth.example.com
TINYAUTH_AUTH_USERS=user:$$2a$$10$$...
TINYAUTH_AUTH_SECURECOOKIE=true
WHOAMI_HOST=http://whoami.example.com
```

**Bổ sung cho Tailscale** (thêm profile `tailscale` hoặc dùng `full`):

```env
COMPOSE_PROFILES=core,tailscale
TS_TAILNET=your-tailnet.ts.net
TS_AUTHKEY=tskey-auth-...
TS_HOSTNAME=proxy-stack
TS_USERSPACE=true
TS_EXTRA_ARGS=--accept-dns=false
```

**Bổ sung cho nodesync** (SSH sync giữa CI runners):

```env
SSH_ENABLE=1
SSH_SYNC_PATHS=ci-data
CONSUL_ENABLE=1
ORCH_RTDB_SERVICE_ACCOUNT=<base64>
ORCH_RTDB_URL=https://your-project-default-rtdb.firebaseio.com
```

**Bổ sung cho Tailscale publish** (publish app qua tailnet):

```env
TS_PUBLISH_MODE=serve           # off | serve | services | both
TS_SERVE_STYLE=subdomain        # subdomain | path
TS_CLIENT_ID=...
TS_CLIENT_SECRET=...
```

### Bước 2: Khởi động stack

**Dev / prod (named tunnel):**

```bash
# Core profile (đã set trong .env)
node scripts/up.mjs

# Hoặc chỉ định profile
node scripts/up.mjs full
node scripts/up.mjs core,tailscale

# CI / quick tunnel mode
node scripts/up.mjs ci

# Dry-run (không chạy, chỉ in lệnh)
node scripts/up.mjs --dry-run
```

**CI runner (GitHub Actions):**

```bash
# start-stack.mjs tự xử lý MODE, litestream/rclone, nodesync, tailscale publish
node scripts/runners/start-stack.mjs

# Dry-run
node scripts/runners/start-stack.mjs --dry-run --silent
```

**Docker Compose trực tiếp** (khuyến nghị dùng script):

```bash
# Named tunnel
docker compose up -d

# Quick tunnel (CI)
docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d

# Chỉ bật service cụ thể
COMPOSE_PROFILES=caddy,whoami docker compose up -d
```

### Bước 3: Verify stack đang chạy

```bash
# Kiểm tra container status
docker compose ps

# Kiểm tra external access (wait-and-test)
node scripts/wait-and-test.mjs

# Kiểmtra image đúng commit hiện tại
node scripts/runners/verify-stack-images.mjs

# Dump Caddy config để debug routing
node caddy/scripts/dump-config.mjs
```

---

## Env cần cấu hình

### Bảng tổng hợp theo kịch bản

| Biến | Mô tả | Named tunnel | Quick tunnel | Tailscale | Nodesync |
|------|-------|:---:|:---:|:---:|:---:|
| `COMPOSE_PROFILES` | Profile bật service | `core` | `core` | `core,tailscale` hoặc `full` | thêm `nodesync` |
| `DOMAIN` | Domain chính | ✅ bắt buộc | ✅ (có default) | ✅ | — |
| `CF_TUNNEL_TOKEN` | Token Cloudflare tunnel | ✅ bắt buộc | để trống | ✅ | — |
| `TINYAUTH_APPURL` | URL public auth | ✅ `https://auth.…` | `http://tinyauth.internal` | ✅ | — |
| `TINYAUTH_AUTH_USERS` | user:hash | ✅ | ✅ | ✅ | — |
| `TINYAUTH_AUTH_SECURECOOKIE` | Cookie secure flag | `true` | `false` | `true` | — |
| `WHOAMI_HOST` | URL whoami | ✅ | ✅ | ✅ | — |
| `TS_TAILNET` | Tailnet domain | — | — | ✅ bắt buộc | — |
| `TS_AUTHKEY` | Auth key join tailnet | — | — | ✅ (hoặc OAuth) | — |
| `TS_HOSTNAME` | Tên node trên tailnet | — | — | ✅ | ✅ |
| `TS_PUBLISH_MODE` | Publish app qua tailnet | — | — | `off`/`serve`/`services`/`both` | — |
| `TS_CLIENT_ID` | OAuth client (cho publish) | — | — | ✅ khi publish≠off | — |
| `TS_CLIENT_SECRET` | OAuth secret | — | — | ✅ khi publish≠off | — |
| `SSH_ENABLE` | Bật nodesync | — | — | — | `1` |
| `SSH_SYNC_PATHS` | Đường dẫn sync | — | — | — | ✅ |
| `CONSUL_ENABLE` | Bật orchestrator | — | — | — | `1` |
| `ORCH_RTDB_SERVICE_ACCOUNT` | Firebase SA (base64) | — | — | — | ✅ |
| `ORCH_RTDB_URL` | Firebase RTDB URL | — | — | — | ✅ |

### Env tự sinh bởi helper (KHÔNG cần set thủ công)

| Biến | Script sinh | Ghi chú |
|------|------------|---------|
| `SSH_1_USER` / `SSH_1_PASS` | `ssh:env` (nodesync) | Tự tạo nếu chưa có |
| `SSH_1_PRIVATE_KEY_BASE64` | `ssh:env` | Keypair ed25519 dùng chung |
| `ORCH_NODE_ID` | `setup-env.mjs` | `github-<runId>-<attempt>` hoặc `azure-<buildId>-<attempt>` |
| `ORCH_META_*` | `setup-env.mjs` | Runner metadata từ `GITHUB_*` / `RUNNER_*` env |
| `TS_HOSTNAME` (CI) | `uniqueTsHostname()` | `proxy-stack-gh-<runId>-<attempt>` (tránh trùng) |
| `DOCKER_VOLUME_RUNTIME_ABS` | `up.mjs` / `start-stack.mjs` | Resolve từ `DOCKER_VOLUME_RUNTIME` |
| `DOCKER_VOLUME_DATA_ABS` | `up.mjs` / `start-stack.mjs` | Resolve từ `DOCKER_VOLUME_DATA` |
| `LITESTREAM_CONTAINER_NAME` | `up.mjs` / `start-stack.mjs` | Khi có `LITESTREAM_<index>_SERVICE` |
| `RCLONE_CONTAINER_NAME` | `up.mjs` / `start-stack.mjs` | Khi có `RCLONE_<index>_NAME` |

### Env bị loại bỏ / thay đổi so với phương án cũ

| Biến cũ | Trạng thái | Thay thế |
|---------|-----------|---------|
| `TS_MESH_WARMUP_SECONDS` | **Bỏ** | `probePredecessorSocks()` — probe SOCKS5 `nc -z`, retry ngắn, thoát ngay khi OK |
| Hard-code `sleep(3000)` RTDB | **Bỏ** | Discover predecessor ngay (read-after-write RTDB đủ nhất quán) |
| Hard-code `sleep(3)` cloudflared | **Bỏ** | `waitForServiceRunning("cloudflared")` — poll 500ms, fail fast |

---

## Theo dõi & giám sát

### Timestamp từng phase (CI workflow)

Mỗi phase trong `test.yml` có timestamp `ts:start` / `ts:end` để đo thực tế:

```
[setup-host] ssh:env start ts=2026-07-20T01:26:44.123Z
[setup-host] ssh:env done ts=2026-07-20T01:26:45.456Z durationMs=1333
```

Phase cần đo:
- **P1** Install dependencies + tools
- **P2** Docker cache/build (BuildKit)
- **P3** Setup Env (`setup-env.mjs`)
- **P4** Setup Host (`setup-host.mjs` — 5 substep song song)
- **P5** Verify images + Start stack
- **P6** Verify stack (wait-and-test)
- **P7** Keep-alive heartbeat
- **P8** Finish (collect logs, analyze, upload artifact)

### Log artifact (CI)

```
ci-logs/
  MANIFEST.txt              # Danh sách file + kích thước
  compose-ps.txt            # docker compose ps output
  compose-config.yml        # docker compose config (đã redact)
  all-services.log          # Gộp log tất cả service
  public-url.txt            # URL public (named hoặc quick tunnel)
  services/<service>.log    # Log từng service
  services/<service>.docker-logs.log
  inspect/<service>.json    # docker inspect (đã redact)
```

Artifact name: `stack-logs-<run_id>-<run_attempt>` (giữ 14 ngày).

### Publish state (Tailscale)

File `ci-runtime/tailscale/published.json` lưu trạng thái publish lần cuối:

```json
{
  "hash": "a1b2c3...",
  "mode": "serve",
  "serveStyle": "subdomain",
  "tailnet": "your-tailnet.ts.net",
  "nodeHost": "proxy-stack",
  "services": ["whoami"],
  "at": "2026-07-20T01:30:00.000Z"
}
```

Kiểm tra idempotency:
- Hash khớp + serve state tồn tại → skip publish (log "Already published").
- Hash khác hoặc serve state mất → publish lại.

### Predecessor manifest (nodesync)

File `ci-runtime/nodesync/predecessor.json` do orchestrator discover:

```json
{
  "version": 1,
  "selfId": "github-12345-1",
  "source": {
    "nodeId": "github-12344-1",
    "startedAt": "2026-07-20T00:55:00.000Z",
    "tailscale": {
      "dnsName": "proxy-stack-gh-12344-1.tailnet.ts.net.",
      "ip": "100.64.0.5"
    }
  }
}
```

- `source=null` → node đầu tiên, skip rsync.
- `source` có giá trị → node có predecessor, chạy rsync.

### Kiểm tra nhanh

```bash
# Container status
docker compose ps

# Log cloudflared (xem tunnel URL)
docker compose logs cloudflared | grep -i "trycloudflare\|https://"

# Log tailscale (xem tailnet status)
docker compose logs tailscale | grep -i "online\|dns"

# Log orchestrator (xem leader election)
docker compose logs orchestrator | grep -i "leader\|handoff\|heartbeat"

# Log nodesync (xem sync status)
docker compose logs nodesync | grep -i "sync-ok\|rsync\|predecessor"

# Publish state
cat ci-runtime/tailscale/published.json 2>/dev/null || echo "chưa publish"

# Verify images
node scripts/runners/verify-stack-images.mjs --silent
```

---

## So sánh phương án cũ và mới

### Docker cache

| Tiêu chí | Cũ | Mới |
|----------|-----|-----|
| Cache mặc định | Tar image (`actions/cache` + `docker load`) ~29s/413MB | BuildKit `type=gha` (layer cache, không tar) |
| Build khi code đổi | Bỏ qua Bake nếu `cache-hit=true` → **có thể chạy image cũ** | Luôn chạy Bake → BuildKit invalidate layer tương ứng |
| Cache-hit | Load tar → skip Bake entirely | BuildKit reuse layer → image build nhanh nhưng VẪN build |
| Fallback tar | Mặc định | Chỉ explicit khi BuildKit không khả dụng |
| Verify image | Không | `verify-stack-images.mjs` — FAIL nếu image không khớp commit |

### Setup Host (SSH)

| Tiêu chí | Cũ | Mới |
|----------|-----|-----|
| Thứ tự | 5 step tuần tự | Song song 2 nhánh (A: env→smoke→tinyauth, B: users→sshd) |
| Cài SSH | `apt-get install openssh-server rsync sshpass` mỗi lần | Chỉ cài `openssh-server` KHI THIẾU `sshd` |
| Host key | `ssh-keygen -A` (tạo cả RSA/ECDSA) + `ssh-keyscan` qua network | Chỉ tạo ed25519 (khi chưa có) + đọc `.pub` trực tiếp |
| sshd restart | Mỗi lần | Chỉ khi drop-in THỰC SỰ đổi; `sshd -t` trước |

### Start stack / Tailscale

| Tiêu chí | Cũ | Mới |
|----------|-----|-----|
| Mesh warmup | `sleep(8000)` cố định | `probePredecessorSocks()` — `nc -z` qua SOCKS5, retry 5 lần × 1s |
| RTDB wait | `sleep(3000)` cố định | Discover ngay (read-after-write đủ) |
| Node đầu tiên | Vẫn chạy rsync (waste time) | Skip probe/rsync, sync.mjs ghi `sync-ok(first-runner)` |
| Poll healthy | 2s interval | 750ms interval |
| Cloudflared check | `sleep(3)` rồi kiểm tra | `waitForServiceRunning` poll 500ms, fail fast |
| Logic trùng | Copy-paste giữa `up.mjs` và `start-stack.mjs` | `stack-lib.mjs` single source of truth |

### Publish (Tailscale)

| Tiêu chí | Cũ | Mới |
|----------|-----|-----|
| Idempotency | Không — mỗi lần đều gọi API + CLI | Hash cache `published.json`; skip nếu hash khớp + serve state còn |
| Lỗi publish | Có thể fail stack | Luôn warning, KHÔNG fail stack/sync |
| Hostname detect | Thủ công | Auto-detect từ Tailscale API, ghi về `.env` |

### Timeline mẫu (CI runner, code không đổi)

```
Phase           Cũ (ước tính)    Mới (ước tính)
─────────────   ─────────────    ─────────────
P1 Install      ~15s             ~15s
P2 Docker       ~30s (tar load)  ~5s  (BuildKit reuse)
P3 Setup Env    ~5s              ~5s
P4 Setup Host   ~25s (tuần tự)   ~10s (song song)
P5 Start stack  ~15s (sleep 11s) ~5s  (poll ngay)
P6 Verify       ~10s             ~10s
─────────────   ─────────────    ─────────────
Tổng            ~100s            ~50s
```

Khi code đổi, P2 BuildKit mất thêm ~15-30s (invalidate layer) nhưng vẫn nhanh hơn tar fallback.
Tính đúng đắn được đảm bảo: image LUÔN build từ commit hiện tại.
