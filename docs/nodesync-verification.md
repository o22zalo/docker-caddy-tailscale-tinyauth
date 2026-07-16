# Nodesync và Cloudflare SSH — cấu hình, kiểm chứng

## 1. Cloudflare named tunnel SSH ingress

Repo dùng remotely-managed tunnel (`CF_TUNNEL_TOKEN`), vì vậy ingress được cập
nhật qua Cloudflare API, không phải `config.yml` cục bộ.
`cloudflare/scripts/hostnames.jsonc` có rule:

```jsonc
{ "hostname": "ssh", "service": "ssh://host.docker.internal:22" }
```

`cloudflare/cloudflare.yml` map `host.docker.internal:host-gateway`, nên connector
trong Docker tới được sshd trên Linux CI runner.

Provision không tương tác:

```bash
node cloudflare/scripts/provision-tunnel.mjs --env .env --dry-run --silent
node cloudflare/scripts/provision-tunnel.mjs --env .env --silent
```

Lệnh thật cần `DOMAIN`, `CF_API_TOKEN` với quyền Account Cloudflare Tunnel:Edit
và Zone DNS:Edit. Script PUT toàn bộ typed ingress và tạo CNAME proxied
`ssh.<DOMAIN> → <tunnel-id>.cfargotunnel.com`; catch-all luôn cuối.

Có thể thêm service khác bằng object `{hostname, service}`. HTTP vẫn trỏ Caddy;
không trỏ SSH qua Caddy.

## 2. Cloudflare Access và CI headless

Có hai lựa chọn:

1. Không gắn Access application vào `ssh.<DOMAIN>`; authentication vẫn bắt buộc
   bằng SSH key, pinned host key và remote node identity.
2. Gắn Access application và policy `Service Auth`; đưa service token vào CI:

```dotenv
TUNNEL_SERVICE_TOKEN_ID=<client-id>
TUNNEL_SERVICE_TOKEN_SECRET=<client-secret>
```

Nodesync truyền hai biến vào `cloudflared access ssh` trong container hiện hữu.
Không dùng policy yêu cầu browser/IdP cho CI. Kiểm tra phiên bản cloudflared thực
tế hỗ trợ service-token cho `access ssh`; nếu log xuất browser URL hoặc timeout
banner, tắt channel hoặc pin một bản đã xác minh trước khi production. Secret
không được ghi vào docs/log/artifact.

Named tunnel có thể có nhiều connector khi handoff. Vì vậy client retry tối đa
3 lần nhưng chỉ chấp nhận connector có host key và node ID đúng predecessor.

## 3. Cấu hình sync

```dotenv
CONSUL_ENABLE=1
SSH_ENABLE=1
NODESYNC_SYNC_PATHS=ci-data,uploads
SSH_CHANNEL_TAILSCALE_ENABLE=1
SSH_CHANNEL_CLOUDFLARE_ENABLE=1
SSH_CHANNEL_HYBRID_ENABLE=1
```

Không cấu hình `NODESYNC_SYNC_PATHS` nghĩa là không sync. Không sync workspace
root, absolute path, `..` hoặc `ci-runtime`.

## 4. Bằng chứng trong log

Orchestrator:

```text
Registered node <id> ...
[nodesync-discovery] source=<predecessor-id>
[leader-whoami] MATCH ... leader.nodeId=<id> whoami.Name=<id>
```

Nodesync:

```text
SSH verified channel=tailscale ... source=<id>
Sync path=ci-data source=<id> → current=<id>
NODESYNC PASS ...
```

Runner đầu tiên phải log `no predecessor` và không rsync. `leader-whoami` là
monitor quan sát trong sidecar; mismatch/timeout cảnh báo nhưng không làm
orchestrator chết.

## 5. Kiểm thử local

```bash
npm ci
npm ci --prefix nodesync --omit=dev
npm ci --prefix orchestrator --omit=dev
cd .work/verify
node verify-election.mjs
node verify-nodesync-scenarios.mjs
node verify-new-architecture.mjs
node verify-source-invariants.mjs
```

Bộ scenario tự tạo source/receiver folders và hơn 10 trạng thái dữ liệu để chứng
minh rsync/integrity. Các tên `node01/node02` trong sandbox cũ chỉ là nhãn test,
không phải hostname hoặc vai trò production.
