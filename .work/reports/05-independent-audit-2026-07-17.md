# Independent audit — orchestrator + nodesync

**Ngày:** 2026-07-17 (Asia/Bangkok)  
**Phạm vi:** commit `d4dc34b` và toàn bộ wiring liên quan Compose, CI, env, docs.

## Kết luận

Bản triển khai ban đầu chưa đạt trạng thái end-to-end dù các test local báo PASS.
Vòng audit đã sửa các lỗi build, startup, fallback, HTTP hold, integrity, CI cache,
leader/whoami identity và critical handoff. Tất cả validation có thể chạy trong
workspace hiện tại đã PASS. Container build/E2E SSH thật vẫn cần GitHub Actions
hoặc host có Docker daemon.

## Lỗi đã phát hiện và sửa

| # | Mức độ | Lỗi | Sửa |
|---|--------|-----|-----|
| 1 | Blocker | Alpine không có APK `cloudflared` | Copy binary từ official image `cloudflare/cloudflared:2026.7.1` |
| 2 | Blocker | Alpine không có package `openssh-client` | Dùng `openssh-client-default`; kiểm package index Alpine 3.23 cho x86_64/aarch64 |
| 3 | High | Base Node 20 đã EOL | Pin `node:24-alpine3.23` |
| 4 | Blocker | `sync.mjs` không được gọi trước app startup | `start-stack.mjs` và `up.mjs`: restore/pull → start sidecar → sync → app |
| 5 | Blocker | Hold chỉ tạo file, Caddy không trả 503 | Thêm `hold-gate.mjs`, Caddy forward-auth precheck, execute thật 204→503→204 |
| 6 | High | Fallback chỉ theo resolve; SSH fail không fallback | Mỗi channel phải resolve + SSH probe trước khi chọn |
| 7 | High | Tailscale userspace không cấp route cho nodesync | Tailscale sidecar expose SOCKS5 `:1055`; SSH dùng `nc -x tailscale:1055` |
| 8 | High | Default sync cả `ci-runtime`, có thể ghi đè identity/key/state | Default chỉ `ci-data`; docs cấm sync toàn runtime |
| 9 | High | Password auth non-interactive/key selection chưa hoạt động ổn định | Thêm `sshpass`, chọn private key, cấu hình BatchMode đúng |
| 10 | High | `rsync --delete` + path/symlink unsafe | Validate relative paths, `--safe-links`, verifier dùng `lstat` |
| 11 | Medium | Fingerprint bỏ sót permission | Hash mode/type/size/content/symlink; scenario permission bắt buộc diff |
| 12 | High | CI cache không chứa nodesync image/code | Thêm nodesync/rclone files vào cache key/image list |
| 13 | Blocker | whoami nhận `whoami`, orchestrator tự sinh ID bên trong container | `setup-env.mjs` materialize `ORCH_NODE_ID` trước Compose; strict CI compare |
| 14 | Blocker | Critical handoff failure vẫn release leader | Upload/stop hooks critical; lỗi → abort, state serving, giữ leader |
| 15 | High | upload-data mặc định là no-op `true` | Rclone hỗ trợ `--once`; hook flush thật khi service chạy |
| 16 | High | stop-cloudflared bỏ qua exit code | Throw on stop failure và xác minh service không còn running |
| 17 | Medium | verifier peer chưa hiện thực nhưng exit 0 | Không `--local` giờ exit 2, không PASS giả |
| 18 | Medium | App scaffold mới không import hold-gate | Generator luôn thêm `nodesync_hold_gate`, auth dùng suffix `_1` |
| 19 | Medium | `--dry-run` vẫn yêu cầu Docker daemon | Runner/local up/leader verifier cho phép dry-run không daemon |
| 20 | Medium | AGENTS/README/env/docs xung đột profile và behavior | Đồng bộ service map, profile, startup, Tailscale, sync path, limitations |

## Kết quả execute

- `node --check` toàn bộ `.mjs/.js`: **PASS**.
- JSONC parse (`nodesync`, `orchestrator`, CI cache): **PASS**.
- Deployable YAML/workflow parse: **PASS**.
- Compose matrix core/full/CI overlay: **PASS**.
- Election/handoff mock RTDB: **PASS** (leader term 1→2, 9 log entries).
- Nodesync 14 mẫu local rsync/integrity: **PASS**.
- Nodesync scenarios: **PASS 15/15**.
  - permission diff được phát hiện;
  - no-op thật không diff;
  - symlink nội bộ sync;
  - symlink ra ngoài bị `--safe-links` bỏ qua.
- Hold-gate HTTP execute: **PASS** (`204 → 503 + Retry-After: 15 → 204`).
- Source integration invariants: **PASS**.
- Rclone `--once --dry-run`: **PASS**.
- Startup dry-run: xác nhận restore → nodesync sync → app up: **PASS**.
- Setup-env test: orchestrator và whoami cùng `ORCH_NODE_ID`: **PASS**.
- Alpine 3.23 package index x86_64/aarch64: tất cả APK hiện tại tồn tại: **PASS**.

## Chưa thể execute tại workspace này

Docker client/buildx có nhưng Docker daemon không chạy và không có
`/var/run/docker.sock`. Vì vậy chưa thể chạy:

1. `docker build -f nodesync/Dockerfile ...`;
2. sshd/auth/rsync E2E giữa hai container;
3. Caddy generated runtime config + HTTP route qua container;
4. Tailscale/Cloudflare thật với credentials;
5. Firebase RTDB thật.

CI đã được bổ sung regression tests và build step. Lần GitHub Actions kế tiếp là
nơi xác minh container build/E2E runtime. Nếu build còn lỗi, cần lấy toàn bộ
output APK/buildx (không chỉ dòng cuối) để xác định package/layer cụ thể.

## Cấu hình triển khai bắt buộc

- Cả node01/node02: `SSH_ENABLE=1`, cùng user/key phù hợp.
- Chỉ node02: `NODESYNC_SYNC_ON_START=1`.
- Mặc định `NODESYNC_SYNC_PATHS=ci-data`.
- Không sync toàn `ci-runtime`.
- Nếu chỉ dùng Tailscale, phải có authkey/identity hoạt động; nếu không, bật
  Cloudflare hoặc Hybrid fallback rõ ràng.
- Không publish SSH host port mặc định; direct-host cần Compose override riêng.
