# orchestrator — RTDB-as-Consul sidecar

Sidecar biến **Firebase Realtime Database (RTDB)** thành một "**consul**" điều phối
nhiều node CI/CD (GitHub Actions, Azure Pipelines) vốn bị giới hạn **~60 phút** mỗi
job. Mục tiêu: **giữ dịch vụ liền mạch (seamless)** khi chuyền ca từ runner này sang
runner khác, và có chỗ để cắm **nhiều nghiệp vụ phía sau** khi handoff.

RTDB đóng vai trò single-source-of-truth: node nào là **leader** (đang phục vụ
traffic), node nào là **con/standby** (đang chờ tiếp quản).

---

## Ba yêu cầu → cách hiện thực

| # | Yêu cầu | Hiện thực |
|---|---------|-----------|
| ① | Start stack OK → ghi trạng thái (giờ, máy, meta từ env) lên RTDB | `register.mjs` ghi `/nodes/<id>` + heartbeat; mọi `ORCH_META_*` tự vào `node.meta` |
| ② | Lắng nghe path → node mới ready thì stop cloudflared, upload dữ liệu... | `watch.mjs` / `main.mjs` lắng nghe `/nodes`; `hooks/` chạy pipeline handoff |
| ③ | Trỏ request sang node mới | **Named tunnel**: node mới connect cùng tunnel → node cũ `stop cloudflared` → Cloudflare route sang connector mới (**zero-downtime, cùng domain**) |

---

## Sơ đồ điều phối (consul model)

```
                    ┌──────────────────── Firebase RTDB ────────────────────┐
                    │  /orchestrator/<stack>/                                │
                    │    leader   { nodeId, term, heartbeat, publicUrl }     │
                    │    nodes/<id> { state, host, runner, meta, heartbeat } │
                    │    events/…   (audit log)                              │
                    └───────▲───────────────────────▲────────────────────────┘
             renew/acquire  │                       │  register + heartbeat
                            │                       │
        ┌───────────────────┴───┐          ┌────────┴──────────────┐
        │  Runner A (LEADER)     │          │  Runner B (STANDBY)   │
        │  proxy-stack + orch    │          │  proxy-stack + orch   │
        │  cloudflared ⇒ tunnel  │  handoff │  cloudflared ⇒ tunnel │
        │  serving traffic ──────┼─────────▶│  ready → tiếp quản    │
        └────────────────────────┘          └───────────────────────┘
                 │ near 60' limit → pipeline: upload-data → stop-cloudflared
                 └──────────────────────────────────────────────────────────▶ step down
```

**Handoff zero-downtime (named tunnel):** cả A và B cùng chạy `cloudflared` trỏ về
cùng một named tunnel/hostname. Khi B đã `ready` (connector B online) và A stop
cloudflared, Cloudflare tự chuyển traffic sang B — **cùng domain, không đổi URL**.

---

## Vòng đời một node (`main.mjs`)

1. **register** → `state=booting`, bật heartbeat, đặt `onDisconnect` (chết → `stopped`).
2. **chờ stack ready** (cloudflared running) → `state=ready`.
3. **election loop**:
   - Standby: `tryAcquire()` — chỉ giành ghế khi **chưa có leader** hoặc **leader chết**
     (heartbeat quá TTL). Giành được → `term++` (fencing token) → `state=serving`.
   - Leader: `renewLeadership()` + phát hiện **successor** mới `ready`.
     - Khi gần hết 60' (`ORCH_MAX_LEADER_SECONDS`) **và** có successor:
       chạy **handoff pipeline** → `releaseLeadership()` → `state=stopped`.

---

## Pipeline nghiệp vụ (dễ mở rộng) — `config.jsonc`

```jsonc
{
  "handoff_pipeline": [
    "upload-data",       // built-in: flush litestream/rclone
    "stop-cloudflared",  // built-in: nhường tunnel cho node mới
    // Thêm nghiệp vụ bất kỳ bằng shell hook:
    { "name": "notify", "shell": "curl -sS -X POST \"$ORCH_WEBHOOK_URL\" -d node=${successor}" },
    { "name": "flush",  "shell": "node scripts/flush.mjs", "critical": true }
  ]
}
```

- `string` → built-in hook (xem `scripts/hooks/index.mjs`).
- `{ shell }` → chạy lệnh tuỳ ý trong repo; hỗ trợ `${successor}`, `${term}`, `${ENV}`.
- `critical: true` → hook lỗi sẽ **chặn** pipeline (an toàn cho bước không được phép fail).
- Thứ tự khuyến nghị: **upload dữ liệu TRƯỚC**, rồi mới **stop cloudflared**.

Viết built-in hook mới: tạo `scripts/hooks/<ten>.mjs` export `{ name, run(ctx) }`,
đăng ký vào `BUILTIN` trong `hooks/index.mjs`, thêm tên vào `handoff_pipeline`.

---

## Cách chạy

### 1. Chuẩn bị credentials (Service Account JSON)

```bash
# Firebase Console → Project Settings → Service accounts → Generate new private key
base64 -w0 service-account.json           # Linux
base64 service-account.json | tr -d '\n'  # macOS
```

Đặt vào `.env` (hoặc secret `ENV_FILE` của CI):

```dotenv
CONSUL_ENABLE=1
ORCH_RTDB_SERVICE_ACCOUNT=<base64...>
ORCH_RTDB_URL=https://<project>-default-rtdb.firebaseio.com
ORCH_STACK=${DOMAIN}
ORCH_META_REGION=asia-southeast1
```

### 2. Khởi động cùng stack

```bash
# orchestrator thuộc profile core/full → tự lên cùng stack
docker compose up -d
# hoặc chỉ sidecar
docker compose --profile orchestrator up -d
```

### 3. Quan sát / thao tác thủ công

```bash
make orch-status          # xem leader + danh sách node (alive/dead)
make orch-watch           # lắng nghe node mới ready (thêm --run-pipeline để chạy hook)
docker compose logs -f orchestrator
```

> Các lệnh host-side (`make orch-*`) cần `firebase-admin` — cài trong module:
> `cd orchestrator && npm install`. Trong container thì đã có sẵn (Dockerfile).

---

## Sơ đồ dữ liệu RTDB

```
orchestrator/<stack>/
├── leader/            { nodeId, term, host, publicUrl, heartbeat, acquiredAt }
├── nodes/<nodeId>/    { state, host, commit, ci{provider,runId,runner...},
│                        startedAt, heartbeat, publicUrl, domain, meta{...} }
├── handoff/           (dành cho mở rộng: kênh yêu cầu/ack chuyển giao)
└── events/<pushId>    { type, at, nodeId, ... }   audit log
```

`state`: `booting → ready → serving → draining → stopped`.

---

## Biến môi trường chính

Xem đầy đủ trong [`.env.example`](./.env.example). Quan trọng nhất:

| Biến | Ý nghĩa |
|------|---------|
| `CONSUL_ENABLE` | `1` để bật orchestration (mặc định `0` → idle) |
| `ORCH_RTDB_SERVICE_ACCOUNT` | Service Account JSON (base64) — **secret** |
| `ORCH_RTDB_URL` | Realtime Database URL |
| `ORCH_STACK` | Namespace consul (mặc định = `DOMAIN`) |
| `ORCH_MAX_LEADER_SECONDS` | Nhường ghế trước khi hết 60' (mặc định 3300 = 55') |
| `ORCH_HEARTBEAT_TTL_SECONDS` | Quá hạn → coi node chết (mặc định 90) |
| `ORCH_META_*` | Metadata tuỳ ý ghi lên RTDB |
| `ORCH_UPLOAD_CMD` | Lệnh upload dữ liệu tuỳ biến khi handoff |

---

## An toàn / thiết kế

- **Fencing token** (`term++`) mỗi lần đổi leader → tránh split-brain (2 leader).
- **`onDisconnect`** của RTDB → node chết đột ngột vẫn tự đánh dấu `stopped`.
- **Graceful shutdown**: `SIGTERM`/`SIGINT` → leader `releaseLeadership()` trước khi tắt.
- **Best-effort trong CI**: `start-stack.mjs` chỉ ghi state khi `CONSUL_ENABLE=1`,
  lỗi RTDB không làm vỡ smoke test.
- **Secret redaction**: logger che token/JWT/private key.
