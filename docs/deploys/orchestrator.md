# Deploy Orchestrator RTDB-as-Consul

Orchestrator là sidecar dùng Firebase Realtime Database làm lớp điều phối leader/standby cho nhiều lần chạy CI/CD. Mục tiêu chính: khi GitHub Actions hoặc Azure Pipelines gần hết giới hạn khoảng 60 phút, runner mới có thể khởi động cùng stack, ghi trạng thái `ready`, rồi runner cũ upload dữ liệu và dừng `cloudflared` để traffic đi sang runner mới.

## Khi nào dùng

Dùng orchestrator khi:

- Stack chạy trong CI/CD runner có giới hạn thời gian.
- Muốn public URL giữ nguyên khi job cũ hết hạn.
- Có nhiều bước hậu xử lý trước khi node cũ rời đi: flush dữ liệu, upload folder, snapshot DB, notify webhook.
- Dùng Cloudflare named tunnel. Quick tunnel `trycloudflare.com` chỉ hợp smoke test, không giữ cùng domain khi chuyển runner.

Không cần bật orchestrator cho local dev ngắn hạn hoặc stack chạy lâu dài trên một máy cố định.

## Mô hình

```text
Runner A                         Firebase RTDB                         Runner B
leader + cloudflared             /orchestrator/<stack>/                 standby + cloudflared
serving traffic  ───────────────► leader
heartbeat       ───────────────► nodes/<A>
                                  nodes/<B> ◄────────────── ready + heartbeat

Runner A thấy B ready:
1. upload-data
2. stop-cloudflared
3. release leader

Cloudflare named tunnel còn connector B, nên route request sang Runner B.
```

RTDB path:

```text
orchestrator/<stack>/
  leader/          { nodeId, term, host, publicUrl, heartbeat, acquiredAt }
  nodes/<nodeId>/  { state, host, commit, ci, startedAt, heartbeat, meta }
  events/<pushId>  { type, at, nodeId, ... }
```

Node states:

```text
booting -> ready -> serving -> draining -> stopped
```

## Điều kiện bắt buộc

- Docker Compose v2.24+.
- Cloudflare named tunnel dùng `CF_TUNNEL_TOKEN`.
- Các public hostnames trong Cloudflare tunnel trỏ về `http://caddy:80`.
- Firebase project có Realtime Database.
- Service Account JSON có quyền đọc/ghi RTDB.
- Root `.env` có `COMPOSE_PROFILES=core` hoặc `full` để service `orchestrator` chạy cùng stack.

## Bước 1: Tạo Firebase RTDB

1. Vào Firebase Console.
2. Tạo project hoặc dùng project có sẵn.
3. Build -> Realtime Database -> Create Database.
4. Chọn region gần runner hoặc gần nơi bạn muốn điều phối.
5. Database URL sẽ có dạng:

```text
https://<project-id>-default-rtdb.firebaseio.com
https://<project-id>-default-rtdb.asia-southeast1.firebasedatabase.app
```

Ghi lại URL này cho `ORCH_RTDB_URL`.

## Bước 2: Tạo Service Account

1. Firebase Console -> Project settings.
2. Service accounts.
3. Generate new private key.
4. Lưu file JSON ở máy local hoặc secret manager.
5. Mã hóa base64 một dòng:

```bash
# Linux
base64 -w0 service-account.json

# macOS
base64 service-account.json | tr -d '\n'

# PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))
```

Giá trị base64 đặt vào `ORCH_RTDB_SERVICE_ACCOUNT`.

Không commit file JSON hoặc giá trị base64 vào repo.

## Bước 3: Cấu hình root `.env`

Tối thiểu:

```env
COMPOSE_PROFILES=core
CONSUL_ENABLE=1

DOMAIN=example.com
CF_TUNNEL_TOKEN=<cloudflare_named_tunnel_token>

ORCH_RTDB_SERVICE_ACCOUNT=<base64_service_account_json>
ORCH_RTDB_URL=https://<project-id>-default-rtdb.firebaseio.com
ORCH_STACK=example.com
ORCH_PUBLIC_URL=https://whoami.example.com
```

Khuyến nghị cho CI 60 phút:

```env
ORCH_MAX_LEADER_SECONDS=3300
ORCH_HEARTBEAT_INTERVAL_SECONDS=15
ORCH_HEARTBEAT_TTL_SECONDS=90
ORCH_READY_SERVICE=cloudflared
ORCH_READY_TIMEOUT_SECONDS=180
```

Metadata tùy ý ghi lên RTDB:

```env
ORCH_META_ENV=production
ORCH_META_REGION=asia-southeast1
ORCH_META_OWNER=platform
```

Các biến `ORCH_META_*` sẽ vào `nodes/<nodeId>/meta`.

## Bước 4: Start stack

Named tunnel:

```bash
node scripts/up.mjs
# hoặc
docker compose up -d
```

CI quick tunnel không phải mục tiêu handoff production. Quick tunnel vẫn chạy được stack, nhưng URL `trycloudflare.com` là URL tạm và không đại diện cho zero-downtime named tunnel.

Kiểm tra container:

```bash
docker compose ps
docker compose logs -f orchestrator
```

Khi bật thành công, RTDB sẽ có:

```text
/orchestrator/<ORCH_STACK>/nodes/<nodeId>
/orchestrator/<ORCH_STACK>/leader
```

## Bước 5: Xem trạng thái

Chạy từ host:

```bash
cd orchestrator
npm install
cd ..
make orch-status
```

Hoặc xem log container:

```bash
docker compose logs --tail=100 orchestrator
```

Các target Makefile:

```bash
make orch-status    # leader + nodes
make orch-watch     # lắng nghe nodes ready
make orch-register  # đăng ký node từ host, dùng cho debug
```

Host-side script cần dependencies trong `orchestrator/node_modules`. Container image đã cài sẵn bằng `npm ci`.

## Handoff mặc định

`orchestrator/config.jsonc` mặc định:

```jsonc
{
  "handoff_pipeline": [
    "upload-data",
    "stop-cloudflared"
  ],
  "handoff_on_successor_ready": true
}
```

Nghĩa là:

1. Runner A đang leader.
2. Runner B start thành công, `cloudflared` running, node B set `ready`.
3. Runner A thấy B fresh và ready.
4. Runner A chạy `upload-data`.
5. Runner A dừng service `cloudflared`.
6. Runner A release leadership.
7. Runner B acquire leadership và tiếp tục phục vụ.

Nếu muốn chỉ handoff khi leader gần hết giờ, set:

```jsonc
{
  "handoff_on_successor_ready": false
}
```

Khi đó leader chỉ nhường nếu có successor và quá `ORCH_MAX_LEADER_SECONDS`, hoặc khi `ORCH_FORCE_HANDOFF=1`.

## Upload dữ liệu khi handoff

Built-in `upload-data` là best-effort. Nếu có quy trình riêng, dùng `ORCH_UPLOAD_CMD`:

```env
ORCH_UPLOAD_CMD=node scripts/backup.mjs
```

Ví dụ rclone:

```env
ORCH_UPLOAD_CMD=docker compose exec -T rclone sh -lc "rclone sync /data remote:proxy-stack"
```

Ví dụ nhiều bước:

```env
ORCH_UPLOAD_CMD=node scripts/flush-cache.mjs && docker compose exec -T rclone sh -lc "rclone sync /data remote:proxy-stack"
```

Nếu bước upload là bắt buộc, nên đưa vào `config.jsonc` dưới dạng shell hook có `critical: true`:

```jsonc
{
  "handoff_pipeline": [
    { "name": "backup", "shell": "node scripts/backup.mjs", "critical": true },
    "stop-cloudflared"
  ]
}
```

## Thêm nghiệp vụ phía sau

Thêm shell hook:

```jsonc
{
  "handoff_pipeline": [
    "upload-data",
    { "name": "notify", "shell": "curl -sS -X POST \"$ORCH_WEBHOOK_URL\" -d node=${successor}" },
    "stop-cloudflared"
  ]
}
```

Biến nội suy hỗ trợ:

- `${successor}`
- `${term}`
- biến môi trường hiện có, ví dụ `${ORCH_WEBHOOK_URL}`

Thêm built-in hook:

1. Tạo file `orchestrator/scripts/hooks/<name>.mjs`.
2. Export `name` và `run(ctx)`.
3. Đăng ký vào `BUILTIN` trong `orchestrator/scripts/hooks/index.mjs`.
4. Thêm tên hook vào `handoff_pipeline`.
5. Chạy `node --check` cho file mới và `index.mjs`.

## GitHub Actions

Repository secret nên là `ENV_FILE`, chứa toàn bộ root `.env`.

Checklist cho named CI:

```env
COMPOSE_PROFILES=core
CONSUL_ENABLE=1
DOMAIN=example.com
CF_TUNNEL_TOKEN=<named_tunnel_token>
ORCH_RTDB_SERVICE_ACCOUNT=<base64_service_account_json>
ORCH_RTDB_URL=https://<project-id>-default-rtdb.firebaseio.com
ORCH_STACK=example.com
ORCH_MAX_LEADER_SECONDS=3300
```

Workflow hiện có sẽ materialize `ENV_FILE` thành `.env`, start stack, rồi smoke test public URL. Orchestrator chạy cùng profile `core`.

Để overlap runner cũ và runner mới, scheduler bên ngoài phải khởi động workflow kế tiếp trước khi workflow cũ hết hạn. Orchestrator chỉ điều phối khi cả hai node cùng sống trong một khoảng ngắn.

## Azure Pipelines

Đặt cùng bộ biến vào secret variables hoặc variable group:

```env
COMPOSE_PROFILES=core
CONSUL_ENABLE=1
CF_TUNNEL_TOKEN=<named_tunnel_token>
ORCH_RTDB_SERVICE_ACCOUNT=<base64_service_account_json>
ORCH_RTDB_URL=https://<project-id>-default-rtdb.firebaseio.com
ORCH_STACK=example.com
```

Orchestrator tự nhận diện Azure bằng các env như `TF_BUILD`, `BUILD_BUILDID`, `SYSTEM_JOBATTEMPT`, `AGENT_NAME`.

## Cloudflare traffic handoff

Handoff liền mạch dựa vào named tunnel:

- Runner A và Runner B dùng cùng `CF_TUNNEL_TOKEN`.
- Cloudflare có nhiều connector cho cùng tunnel.
- Public hostname vẫn trỏ về cùng tunnel.
- Khi A dừng `cloudflared`, connector B vẫn sống.
- Cloudflare route request mới sang B.

Không dùng `curl -L` cho smoke test auth vì redirect login có thể trỏ đến auth host. Repo smoke test chỉ cần first hop là `200`, `3xx`, `401`, hoặc `403`.

## RTDB security rules

Service Account dùng Admin SDK nên bypass database rules. Rules vẫn nên khóa client public:

```json
{
  "rules": {
    ".read": false,
    ".write": false
  }
}
```

Không dùng client-side Firebase key cho orchestrator. Chỉ dùng Service Account qua secret store.

## Quan sát dữ liệu

Leader hiện tại:

```text
orchestrator/<stack>/leader
```

Node sống:

```text
orchestrator/<stack>/nodes/<nodeId>/heartbeat
```

Audit:

```text
orchestrator/<stack>/events
```

Các event thường gặp:

- `node.registered`
- `node.state`
- `leader.acquired`
- `handoff.begin`
- `handoff.pipeline_start`
- `handoff.cloudflared_stopped`
- `handoff.complete`

## Test thủ công

Terminal A:

```bash
CONSUL_ENABLE=1 ORCH_NODE_ID=local-a docker compose up -d
docker compose logs -f orchestrator
```

Terminal B, dùng project khác hoặc runner khác:

```bash
CONSUL_ENABLE=1 ORCH_NODE_ID=local-b COMPOSE_PROJECT_NAME=proxy-stack-b docker compose up -d
```

Ép handoff:

```bash
ORCH_FORCE_HANDOFF=1 docker compose up -d orchestrator
```

Kiểm tra:

```bash
make orch-status
docker compose ps cloudflared
```

Lưu ý: hai Compose project trên cùng host có thể dùng chung network global `proxy` theo thiết kế repo. Không chạy stack không tin cậy trên cùng network đó.

## Troubleshooting

### `Missing ORCH_RTDB_URL`

Thiếu `ORCH_RTDB_URL` trong root `.env` hoặc secret `ENV_FILE`.

### `Missing credentials`

Thiếu `ORCH_RTDB_SERVICE_ACCOUNT` hoặc `ORCH_RTDB_SERVICE_ACCOUNT_FILE`.

Trong Docker/CI, khuyến nghị dùng `ORCH_RTDB_SERVICE_ACCOUNT` base64 thay vì mount file.

### `Service account JSON parse failed`

Base64 sai, bị xuống dòng lỗi, hoặc copy nhầm JSON raw vào biến base64.

PowerShell tạo lại:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))
```

### Orchestrator idle

`CONSUL_ENABLE` đang unset hoặc bằng `0`. Set:

```env
CONSUL_ENABLE=1
```

### Node không lên `ready`

Orchestrator chờ service trong `ORCH_READY_SERVICE`, mặc định là `cloudflared`.

Kiểm tra:

```bash
docker compose ps cloudflared
docker compose logs cloudflared
```

Named mode cần `CF_TUNNEL_TOKEN` hợp lệ. Quick mode dùng override CI, không phải đường handoff production.

### Leader không nhường

Kiểm tra:

- Có node khác `state=ready` hoặc `serving`.
- Heartbeat node đó chưa quá `ORCH_HEARTBEAT_TTL_SECONDS`.
- `handoff_on_successor_ready` có đang là `false`.
- Nếu muốn ép test, set `ORCH_FORCE_HANDOFF=1`.

### `docker compose` trong sidecar thao tác sai project

Mặc định sidecar chạy trong `/workspace`, Compose sẽ dùng project name theo thư mục. Nếu bạn start stack bằng project name riêng, set cùng giá trị:

```env
COMPOSE_PROJECT_NAME=proxy-stack-prod
```

### `upload-data` không làm gì

Built-in mặc định là best-effort. Cấu hình lệnh thật bằng:

```env
ORCH_UPLOAD_CMD=<your command>
```

Hoặc thêm shell hook `critical: true` trong `orchestrator/config.jsonc`.

### Public URL đổi sau handoff

Bạn đang dùng quick tunnel hoặc khác named tunnel token. Để giữ cùng domain, cả hai runner phải dùng cùng `CF_TUNNEL_TOKEN` của named tunnel và Cloudflare Public Hostname phải trỏ về tunnel đó.

## Checklist production

- [ ] `COMPOSE_PROFILES=core` hoặc `full`.
- [ ] `CONSUL_ENABLE=1`.
- [ ] `CF_TUNNEL_TOKEN` là named tunnel token, không phải quick tunnel.
- [ ] `ORCH_RTDB_SERVICE_ACCOUNT` nằm trong secret store.
- [ ] `ORCH_RTDB_URL` đúng database URL.
- [ ] `ORCH_STACK` ổn định cho cùng một cụm deploy.
- [ ] `ORCH_MAX_LEADER_SECONDS` nhỏ hơn thời hạn runner.
- [ ] Dữ liệu app đã có Litestream/Rclone hoặc `ORCH_UPLOAD_CMD`.
- [ ] Workflow kế tiếp được trigger trước khi workflow cũ hết thời gian.
- [ ] `docker compose logs orchestrator` có heartbeat/election bình thường.
