# Nodesync — đồng bộ runner theo thứ tự khởi động

Nodesync chỉ làm một việc: runner lên sau tự tìm runner sống đã lên trước trong
Firebase RTDB rồi đồng bộ các file/folder được opt-in. Nó **không** restore
Litestream, pull Rclone, chạy Tailscale/cloudflared riêng, hoặc chặn request qua
Caddy.

## Mặc định an toàn

```dotenv
SSH_ENABLE=0
NODESYNC_SYNC_PATHS=
```

`sync_paths` mặc định là `[]`. Khi danh sách rỗng, launcher không discover peer,
không mở SSH và không chạy rsync. Để bật:

```dotenv
SSH_ENABLE=1
NODESYNC_SYNC_PATHS=ci-data,uploads
SSH_CHANNEL_TAILSCALE_ENABLE=1
SSH_CHANNEL_CLOUDFLARE_ENABLE=1
SSH_CHANNEL_HYBRID_ENABLE=1
```

Không có `node01`/`node02` cố định. `startedAt` RTDB quyết định vai trò:
runner đầu tiên không có predecessor và skip; runner lên sau chọn node sống có
`startedAt` nhỏ hơn, ưu tiên node `serving`, rồi node gần nó nhất.

## Identity tự sinh

`scripts/runners/setup-env.mjs` ghi vào runtime `.env`, không cần khai báo trong
CI secret:

- GitHub: `ORCH_NODE_ID=github-<GITHUB_RUN_ID>-<GITHUB_RUN_ATTEMPT>`;
- Azure: `azure-<BUILD_BUILDID>-<SYSTEM_JOBATTEMPT>`;
- local: `local-<hostname>-1`;
- `WHOAMI_NAME` luôn được đặt bằng chính `ORCH_NODE_ID`.

Có thể đặt `ORCH_NODE_ID` thủ công để debug; launcher vẫn ép `WHOAMI_NAME` khớp.
Runtime `.env` và `ci-runtime/` đã gitignore.

## SSH zero-touch trên CI runner

`setup-nodesync-ssh.mjs` tự động:

1. cài OpenSSH server và rsync bằng sudo non-interactive nếu thiếu;
2. dùng user thật của runner;
3. cài public key vào `authorized_keys`, tắt password và interactive auth;
4. restart sshd;
5. lấy host key/fingerprint, IP và node identity;
6. ghi `ci-runtime/nodesync/host-ssh.json` để orchestrator publish lên RTDB.

Để nhiều runner xác thực chéo, `ENV_FILE` phải chứa cùng một Ed25519 keypair:

```dotenv
SSH_1_PRIVATE_KEY_B64=1
SSH_1_PRIVATE_KEY=<base64-private-key>
SSH_1_PUBLIC_KEY_B64=1
SSH_1_PUBLIC_KEY=<base64-public-key>
```

Nếu thiếu, bootstrap sinh key ephemeral chỉ phù hợp local/smoke một runner.
Không có prompt, password hoặc `StrictHostKeyChecking=accept-new`.

Mọi channel phải qua ba lớp kiểm tra trước rsync:

1. endpoint resolve thành công;
2. SSH host key khớp metadata RTDB (`StrictHostKeyChecking=yes`);
3. remote identity file trả đúng predecessor `nodeId`.

## Transport

### Tailscale

Dùng container `tailscale` hiện hữu, không chạy tailscaled trong nodesync.
Vì stack dùng userspace networking và `--accept-dns=false`, resolver dùng IP từ
`tailscale status --json`, không phụ thuộc `/etc/resolv.conf`/MagicDNS.
Launcher cấu hình:

```bash
tailscale serve --bg --tcp=2222 tcp://host.docker.internal:22
```

SSH client đi qua SOCKS5 `tailscale:1055` tới `<source-tailnet-ip>:2222`.
Peer phải online và IP phải thuộc chính predecessor trong RTDB.

### Cloudflare

Provisioner tạo `ssh.<DOMAIN> → ssh://host.docker.internal:22`. Client tái sử
dụng binary trong service `cloudflared` hiện hữu. Xem hướng dẫn chi tiết tại
`docs/nodesync-verification.md`.

### Hybrid

Dùng IP host được source publish lên RTDB; vẫn pin host key và verify node ID.

## Luồng startup

Các bước restore/pull vẫn thuộc Litestream/Rclone và chạy độc lập. Phần nodesync:

```text
bootstrap host ssh → start transport/orchestrator/nodesync
→ register RTDB → discover predecessor → authenticate → rsync configured paths
```
