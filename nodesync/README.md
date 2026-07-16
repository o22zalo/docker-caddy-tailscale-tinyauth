# nodesync — đồng bộ dữ liệu giữa các node qua SSH

Sidecar cho phép các **node (runner CI)** chép file và chạy lệnh cho nhau qua
**SSH**, để **đồng bộ dữ liệu** khi chuyển ca. Kết hợp với `orchestrator`
(leader/standby): khi **node02** khởi động, nó sẽ **pull remote store → so khác
biệt với node01 qua SSH → sync trực tiếp từ node01 → rồi mới start app**.

Một phương án hợp nhất, **config-driven**, có **fallback kênh**:

```
Tailscale  →  Cloudflare  →  Hybrid (trực tiếp)
   (ưu tiên)     (dự phòng)      (fallback cuối / test)
```

Bật từng kênh bằng env `SSH_CHANNEL_*_ENABLE`. Kênh nào tắt/lỗi → tự fallback
sang kênh kế tiếp, có log rõ **lý do fallback**.

---

## Bật dịch vụ

```dotenv
SSH_ENABLE=1
COMPOSE_PROFILES=full          # hoặc: core,nodesync,tailscale
# Chỉ đặt =1 trên node02 (node nhận dữ liệu); node01 để 0.
NODESYNC_SYNC_ON_START=1

# Multi-user (tạo nhiều user theo index)
SSH_1_USER=sync
SSH_1_PASS_B64=1
SSH_1_PASS=c3luY3Bhc3M=        # base64 -w0 của "syncpass"
SSH_1_PUBLIC_KEY=ssh-ed25519 AAAA... sync@ci
SSH_1_PRIVILEGED=1             # sudo NOPASSWD:ALL (chạy MỌI lệnh) — mặc định 1

SSH_2_USER=admin
SSH_2_PASS=adminpass

# Kênh + fallback
SSH_CHANNEL_TAILSCALE_ENABLE=1
SSH_CHANNEL_CLOUDFLARE_ENABLE=0
SSH_CHANNEL_HYBRID_ENABLE=1

# Peer node01
NODESYNC_PEER_TAILSCALE_HOST=proxy-stack-a   # hostname tailnet
NODESYNC_PEER_HOST=node01                     # host trực tiếp (hybrid/test)
NODESYNC_PEER_USER=sync
```

```bash
COMPOSE_PROFILES=full docker compose up -d nodesync
docker compose logs -f nodesync
```

---

## Multi-user `SSH_<n>_*`

| Env | Ý nghĩa |
|-----|---------|
| `SSH_<n>_USER` | tên user (bắt buộc để tạo user index n) |
| `SSH_<n>_PASS` / `_PASSWORD` | mật khẩu (đặt `_B64=1` nếu base64) |
| `SSH_<n>_PUBLIC_KEY` | ghi vào `~/.ssh/authorized_keys` |
| `SSH_<n>_PRIVATE_KEY` | ghi vào `~/.ssh/id_ed25519` (đặt `_B64=1` nếu base64) |
| `SSH_<n>_PRIVILEGED` | `1` (mặc định) = sudo NOPASSWD:ALL; `0` = không |
| `SSH_<n>_SHELL` | shell (mặc định `/bin/bash`) |
| `SSH_<n>_UID` | uid cố định (tuỳ chọn) |

Secret (`PASS`, `PRIVATE_KEY`) mask base64 theo qui tắc repo (`base64 -w0`), và
**không bao giờ in ra log** (logger redact).

---

## Phân quyền & DNS resolve Tailscale

- **Phân quyền:** mỗi user privileged được cấp `NOPASSWD:ALL` trong
  `/etc/sudoers.d/nodesync-<user>` → chạy **mọi lệnh** giữa các node; thêm vào
  group `docker` (nếu có) để chạy lệnh **trong/ngoài docker** qua socket mount.
  Container chạy **root** (`user: "0:0"`) để có quyền cao nhất.

- **Tailscale userspace:** container `tailscale` expose SOCKS5 nội bộ tại
  `tailscale:1055`. `nodesync` đọc LocalAPI bằng
  `docker exec tailscale tailscale status --json`, map hostname → IP tailnet,
  rồi SSH qua `nc -x tailscale:1055 %h %p`. Không giả định container nodesync có
  route tailnet trực tiếp. Nếu SSH probe thất bại, tiếp tục Cloudflare/Hybrid.
  (Tài liệu: [quad100](https://tailscale.com/docs/reference/quad100),
   [magicdns](https://tailscale.com/docs/features/magicdns),
   [userspace](https://tailscale.com/docs/concepts/userspace-networking),
   [tailscale-ssh](https://tailscale.com/docs/features/tailscale-ssh)).

---

## Luồng sync (node02 ← node01)

1. Node02 bật `NODESYNC_SYNC_ON_START=1`; runner pull remote store trước.
2. Runner start sidecar, chờ healthy, rồi `sync.mjs` thử **SSH probe thật** theo
   fallback và diff từng `sync_path` bằng checksum + metadata.
3. Nếu khác: yêu cầu node01 **BẬT treo request** (503 + Retry-After) → **rsync**
   trực tiếp node01→node02 → node01 **TẮT treo**.
4. Báo cáo (file nào, thời gian, kích thước) → app start tiếp.

**Treo request** (mặc định `retry-after`): `hold-requests.mjs on` tạo file cờ
`ci-runtime/nodesync/hold.flag`; khi tồn tại, node01 trả `503 Retry-After` để
client/node02 retry sau `NODESYNC_RETRY_AFTER_SECONDS`. `hold-gate.mjs` trả
HTTP 503 thật và Caddy gọi gate trước reverse proxy. Sync xong → xoá cờ trong
`finally`. Mặc định chỉ sync `ci-data`; không sync toàn `ci-runtime` vì chứa
identity/key/state riêng từng node.

---

## Script

| Lệnh | Chức năng |
|------|-----------|
| `node scripts/entrypoint.mjs` | tạo user + cấu hình sshd + start sshd |
| `node scripts/setup-users.mjs [--dry-run]` | tạo multi-user + phân quyền |
| `node scripts/resolve-peer.mjs [--json]` | test resolve peer (fallback kênh) |
| `node scripts/sync.mjs [--dry-run] [--local-demo]` | chạy luồng đồng bộ |
| `node scripts/hold-requests.mjs on\|off\|status` | bật/tắt treo request |
| `node scripts/verify-integrity.mjs --local A B [--json]` | kiểm tra toàn vẹn 2 thư mục |

Tất cả script hỗ trợ `--dry-run` và `--silent` (theo convention repo).

---

## Kiểm chứng thực tế

Xem `docs/nodesync-verification.md` — hướng dẫn triển khai + kiểm chứng bằng
`ls` / checksum / size / time, kèm kết quả execute thật (rsync + verify-integrity
qua 15 kịch bản, gồm permission và symlink safety).
