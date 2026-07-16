# Phase 03 — Implement Phần 2 (nodesync) + Kiểm chứng

> **Audit bổ sung 2026-07-17:** Kết luận ban đầu được thay thế bởi vòng review
> độc lập hiện tại. Đã sửa build `cloudflared` APK, nối pre-start sync thật,
> hiện thực hold-gate HTTP 503, fallback theo SSH probe, Tailscale SOCKS5,
> cache CI, sync-path an toàn và verifier 15/15. Xem
> `docs/nodesync-verification.md` là nguồn hướng dẫn hiện hành.

> Vai trò: Coder → Test/Verify. Ghi lại thay đổi + kết quả execute thật.

## Cấu trúc dịch vụ mới `nodesync/`
```
nodesync/
├── nodesync.yml          # compose (profile nodesync|full), root, mount full workspace + docker.sock
├── Dockerfile            # openssh-server + rsync + rclone + docker-cli + cloudflared + tailscale + sudo + node
├── config.jsonc          # channel_priority, sync_paths, hold (503 retry-after), sshd, timeouts
├── package.json / -lock  # dep: jsonc-parser
├── .env.example          # catalog SSH_* + NODESYNC_*
├── README.md
└── scripts/
    ├── entrypoint.mjs        # sshd_config + host keys + setup-users + start sshd
    ├── setup-users.mjs       # tạo multi-user SSH_<n>_* + sudo NOPASSWD:ALL + group docker
    ├── resolve-peer.mjs      # test resolve fallback Tailscale→Cloudflare→Hybrid
    ├── sync.mjs              # luồng node02←node01: diff → hold → rsync → release → report
    ├── hold-requests.mjs     # bật/tắt treo request (503 Retry-After) qua file cờ
    ├── verify-integrity.mjs  # kiểm tra toàn vẹn 2 node (checksum/size/mtime) — có --local
    └── lib/{log,env,ssh}.mjs # logger redact, parse multi-user + channels, resolver + ssh args
```

## Tích hợp
- `docker-compose.yml`: include `nodesync/nodesync.yml`.
- `scripts/runners/start-stack.mjs`: `hasNodesyncConfig` (SSH_ENABLE=1) → auto enable profile `nodesync`.

## Đáp ứng yêu cầu
| Yêu cầu | Hiện thực |
|---------|-----------|
| 1 phương án hợp nhất, config enable từng kênh | `SSH_CHANNEL_*_ENABLE` + `channel_priority` trong config.jsonc |
| Đồng bộ chạy trên mọi kênh, fallback | `resolvePeer()` thử lần lượt, log lý do fallback |
| Multi-user tạo theo index | `SSH_<n>_USER/PASS/PUBLIC_KEY/PRIVATE_KEY` + `_B64` mask |
| Phân quyền chạy mọi lệnh | sudo NOPASSWD:ALL + group docker + container root |
| Resolve DNS Tailscale đúng docs | LocalAPI `tailscale status --json` / `tailscale ip` (userspace + accept-dns=false) |
| Orchestrator có thêm user/cwd | node record `runtime{ systemUser, uid, isRoot, cwd, channels, sshUsers }` |
| Luồng node02 pull→diff→sync→start | `sync.mjs` |
| node01 treo request khi sync | `hold-requests.mjs` (503 Retry-After, file cờ) |
| Script test toàn vẹn, log VN | `verify-integrity.mjs` + log tiếng Việt + đo thời gian |
| Hướng dẫn + kiểm chứng ls/checksum | `docs/nodesync-verification.md` |

## Kiểm chứng thực thi (execute thật)

### ✅ node --check — TẤT CẢ script PASS (orchestrator + nodesync + runners + verify).

### ✅ docker compose config — OK
- `SSH_ENABLE=1 COMPOSE_PROFILES=full docker compose config` → **FULL+nodesync CONFIG OK**.
- CI overlay `docker-compose.ci.yml` → **CI OVERLAY OK**.

### ✅ Parse multi-user (execute thật)
`SSH_1_USER=sync SSH_1_PASS_B64=1 SSH_1_PASS=cGFzczEyMw== SSH_2_USER=admin`
→ user1=sync pass="pass123" (base64 decode ✓), user2=admin, cả 2 privileged ✓.

### ✅ Fallback kênh (execute thật)
`resolve-peer.mjs` với tailscale bật (không tailnet) + hybrid:
→ tailscale FAIL (reason rõ) → **fallback hybrid → node01 ✓**.

### ✅ setup-users dry-run (execute thật)
2 user tạo + `NOPASSWD:ALL` cho cả 2, password ẩn trong log ✓.

### ✅ Orchestrator runtime info (execute thật)
`getSshRuntimeIdentity()` → systemUser/uid/cwd/channels/primaryChannel/sshUsers đúng,
KHÔNG lộ secret ✓.

### ✅ Đồng bộ dữ liệu — rsync + integrity THẬT
`.work/verify/verify-nodesync.mjs`: 14 mẫu đa dạng, hold-flag on/off, rsync 164ms,
fingerprint sau khớp, verify-integrity: same=14 differ=0 onlyA=0 onlyB=0 → **PASS ✅**.

### ✅ 13 KỊCH BẢN đồng bộ (execute thật)
`.work/verify/verify-nodesync-scenarios.mjs`: rỗng/thiếu/khác/thừa/rỗng-file/sâu/
unicode/lớn-200KB/50-file/ẩn/đổi-quyền/mix/no-op → **PASS 13/13 ✅**.

### ✅ Evidence ls/checksum/size/time (execute thật) — xem docs/nodesync-verification.md §3
node02 (chỉ users/1.txt) ← rsync node01 → fingerprint tổng 2 node TRÙNG
`8f6561fac7843f...` ✓.

## ⚠️ Ràng buộc (log rõ khi thiếu môi trường)
- sshd runtime + tailnet thật + cloudflared: **cần Docker daemon + creds** (sandbox không có).
  Code log `reason` rõ ràng mọi trường hợp thiếu (đã minh chứng qua fallback log).
- rsync/checksum/hold/parse/resolve-fallback/runtime-info: **THẬT 100%** tại sandbox.
