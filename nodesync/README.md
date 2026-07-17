# NodeSync — SSH sync giữa CI runners

Runner khởi động sau chọn predecessor còn sống từ Firebase RTDB và đồng bộ các
path đã opt-in. NodeSync tái sử dụng Tailscale/cloudflared hiện hữu; không chạy
thêm tunnel daemon.

## Tự động hóa SSH

```dotenv
SSH_ENABLE=1
SSH_SYNC_PATHS=ci-data,uploads
SSH_1_USER=nodesync
SSH_1_PASS=<shared-secret>
```

CI chạy hoàn toàn non-interactive theo thứ tự:

1. `npm run ssh:env --prefix nodesync`: chuẩn hóa `.env`, tự sinh user/password
   khi thiếu, sinh Ed25519 key, gom và sắp xếp toàn bộ `SSH_*`, mask secrets;
2. `npm run ssh:smoke:prepare --prefix nodesync`: tạo smoke fixture khi bật;
3. `setup-users.mjs`: tạo mọi `SSH_<index>_USER`, password, home, `.ssh`,
   `authorized_keys`, private key và sudo `NOPASSWD`;
4. `setup-nodesync-ssh.mjs`: cài OpenSSH/rsync/sshpass, cấu hình sshd, host key,
   identity file và manifest RTDB;
5. discover predecessor, pin host key, verify remote node ID, rồi rsync.

Key authentication được thử trước; `SSH_<index>_PASS` là fallback qua
`sshpass -e`, nên password không nằm trong argv hay log. Không dùng
`StrictHostKeyChecking=accept-new`.

Các workflow tích hợp sẵn:

- `.github/workflows/test.yml`;
- `.azure/azure-pipelines.yml`.

## Transports

```dotenv
SSH_CHANNEL_TAILSCALE_ENABLE=1
SSH_CHANNEL_CLOUDFLARE_ENABLE=1
SSH_CHANNEL_HYBRID_ENABLE=1
```

Chế độ thường dùng fallback theo thứ tự Tailscale → Cloudflare → Hybrid để tránh
nhiều rsync ghi vào cùng destination. Mỗi endpoint vẫn phải khớp pinned host key
và remote node ID.

### Tailscale SSH (ưu tiên) + fallback

Khi predecessor bật **Tailscale SSH** (`tailscale up --ssh`, tự động bật qua
`SSH_TAILSCALE_SSH=1`, mặc định), NodeSync kết nối **thẳng** tới `tailnet:22` và
để Tailscale lo xác thực/uỷ quyền qua ACL (`tag:ci → tag:ci`) — KHÔNG cần key
materialize, KHÔNG cần `nc -x` SOCKS proxy tự chế. Đây là đường ổn định nhất.

Nếu predecessor KHÔNG bật Tailscale SSH (userspace thuần), NodeSync **fallback**
về `tailscale serve --tcp=2222` + SOCKS5 proxy như trước.

```dotenv
SSH_TAILSCALE_SSH=1        # 1=Tailscale SSH trực tiếp (mặc định), 0=serve+proxy
```

> **Hostname duy nhất theo runner:** stack tự đặt `TS_HOSTNAME` =
> `proxy-stack-<gh|az>-<runId>-<attempt>` để 2 runner KHÔNG chồng cùng một
> node trên tailnet (nếu trùng hostname, Tailscale coi là 1 node → chỉ 1 IP
> tồn tại → rsync qua tailscale hỏng).

### Sync gate (rsync xong mới giành leader)

Runner lên sau **phải rsync xong dữ liệu của predecessor rồi mới được giành
leader**. `sync.mjs` ghi cờ `ci-runtime/nodesync/sync-ok` khi PASS; orchestrator
chờ cờ này trước khi `tryAcquire()`. Ngoài ra, ở giai đoạn sync, stack **không**
start `cloudflared` của node mới (tránh named tunnel route `ssh.<domain>` về
chính nó thay vì predecessor) — `cloudflared` chỉ connect SAU khi rsync xong.

```dotenv
ORCH_SYNC_GATE=1                    # auto-bật khi SSH_SYNC_PATHS có giá trị
ORCH_SYNC_GATE_TIMEOUT_SECONDS=900
SSH_HYBRID_ALLOW_10=0              # hybrid: cho phép IP 10.x (mặc định loại)
```

Cloudflare channel mặc định dùng named Tunnel hiện tại:

```dotenv
ssh.<DOMAIN> -> ssh://host.docker.internal:22
```

Không dùng Cloudflare Access service token; SSH xác thực bằng host key pinning +
`SSH_<index>_USER/PASS` hoặc key.

## Smoke sync

```dotenv
SSH_SYNC_SMOKE_ENABLE=1
```

Runner tạo `ci-runtime/smoke-sync-data` gồm file, cây thư mục, timestamp và
SHA-256 manifest. Khi bật smoke, `SSH_SYNC_PATHS` có thể để trống; runner tự
dùng `ci-runtime/smoke-sync-data`. Các metadata sau được ghi vào env/RTDB:

- `ORCH_META_SSH_SMOKE_CREATED_AT`;
- `ORCH_META_SSH_SMOKE_CHECKSUM`;
- `ORCH_META_SSH_SMOKE_FILES`;
- `ORCH_META_SSH_SMOKE_DIRS`.

Runner kế tiếp chạy mọi channel đã bật song song. Mỗi channel ghi vào destination
riêng và lỗi độc lập:

- dữ liệu: `ci-runtime/smoke-sync-results/<channel>/`;
- report: `ci-runtime/nodesync/reports/<channel>.json`;
- tổng hợp: `ci-runtime/nodesync/reports/summary.json`.

Report có source/current node, auth mode, endpoint, start/end/duration, danh sách
file/thư mục, size, checksum từng file, checksum tổng và kết quả xác minh với
manifest nguồn. Task chỉ fail khi không channel nào thành công.

## Mặc định an toàn

```dotenv
SSH_ENABLE=0
SSH_SYNC_SMOKE_ENABLE=0
SSH_SYNC_PATHS=
```

Khi tắt hoặc path rỗng, NodeSync không discover, không SSH và không rsync.
