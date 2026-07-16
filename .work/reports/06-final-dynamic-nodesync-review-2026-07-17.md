# Final review — dynamic nodesync + orchestrator observability (2026-07-17)

Report này **supersede** các phần nodesync/hold-gate cố định trong report 01–05.
Các report cũ được giữ làm lịch sử audit, không còn là contract vận hành hiện tại.

## Kết quả triển khai

### Orchestrator / whoami

- `setup-env.mjs` tự sinh `ORCH_NODE_ID` theo CI run/attempt và tự đặt
  `WHOAMI_NAME` bằng cùng giá trị; không cần người dùng thêm env.
- Khi leader được acquire, orchestrator tự monitor public whoami và log
  `leader.nodeId` so với `Name`. Mismatch/timeout là observability warning,
  không restart/fail sidecar.
- URL tự suy ra từ `ORCH_PUBLIC_URL`, `WHOAMI_HOST`, hoặc
  `https://whoami.${DOMAIN}`.
- Bỏ CI step `VERIFY_LEADER_STRICT`; bằng chứng nằm trong orchestrator logs.
- Orchestrator image nâng Node 20 → Node 24 Alpine 3.23.

### Nodesync

- Không có node01/node02 cố định. RTDB `startedAt` xác định runner lên trước;
  runner đầu tiên skip, runner sau chọn predecessor sống, ưu tiên `serving`.
- `sync_paths` mặc định `[]`; không paths thì không discovery/SSH/rsync.
- Sidecar chỉ là client/controller; không chạy sshd, hold HTTP gate, Tailscale
  hoặc cloudflared riêng; không restore Litestream hay pull Rclone.
- CI host bootstrap tự cài/check sshd+rsync, cài Ed25519 key, tắt password,
  restart sshd, scan host key và publish public metadata qua orchestrator RTDB.
- Mọi channel pin SSH host key và chạy remote node-id challenge trước rsync.
- Tailscale dùng service hiện hữu: status JSON + SOCKS5 `tailscale:1055` và
  Serve TCP `tailnet-ip:2222 → host sshd:22`.
- Cloudflare dùng service hiện hữu: typed ingress
  `ssh.<DOMAIN> → ssh://host.docker.internal:22`; provisioner tạo CNAME/API
  config. Có hỗ trợ env service token cho Access headless.
- Hybrid dùng IP source publish trong RTDB và cùng cơ chế xác thực.

### Cleanup Caddy

Đã xóa toàn bộ wiring cũ khỏi Caddy và app YAML:

- `SSH_ENABLE` khỏi `caddy/caddy.yml`;
- snippet `nodesync_hold_gate`, matcher, `forward_auth nodesync:8088`;
- app imports trong whoami/filebrowser/dozzle/webssh/CI override;
- app generator không tái sinh import;
- xóa hold-gate/hold-request scripts, tests, cache entries và port 8088.

## Validation đã chạy

- `node --check`: toàn bộ `.mjs` liên quan — PASS.
- Election/handoff mock RTDB — PASS.
- 15 kịch bản rsync/integrity local — PASS 15/15.
- Dynamic predecessor + first-runner skip — PASS.
- Leader/whoami mismatch→match monitor — PASS.
- Default paths rỗng + obsolete Caddy wiring absent — PASS.
- Cloudflare provision `--dry-run`: typed SSH ingress + CNAME — PASS.
- `docker compose ... config` CI render — PASS.
- `git diff --check` — PASS.

## Giới hạn xác minh

Docker daemon không có trong workspace hiện tại nên chưa chạy E2E thật qua tailnet
hoặc Cloudflare edge. Không có Cloudflare API mutation: provisioner chỉ chạy
`--dry-run`. Production cần một CI run có RTDB, Tailscale/Cloudflare credentials
và Ed25519 keypair chung để thu log E2E.
