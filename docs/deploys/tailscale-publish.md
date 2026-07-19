# Deploy — Publish app qua tailnet (Tailscale Serve + Services)

Triển khai tính năng publish app qua tailnet. Reference đầy đủ: [`docs/tailscale-publish.md`](../tailscale-publish.md).

## Yêu cầu

- Profile `tailscale` (hoặc `full`) đang bật (`COMPOSE_PROFILES`).
- `TS_AUTHKEY` / OAuth (`TS_CLIENT_ID`, `TS_CLIENT_SECRET`) + `TS_TAILNET` đã cấu hình.
- Client Tailscale hỗ trợ Tailscale Services (≥ v1.96; đã test v1.98).
- HTTPS tailnet đã bật (init.mjs tự bật qua `PATCH /settings`).
- **Không cần set `TS_HOSTNAME`** — script tự detect hostname từ Tailscale API.

## Cấu hình (.env)

Chọn 1 trong 4 chế độ (mặc định `off` — không publish):

```env
# Không publish (an toàn, mặc định)
TS_PUBLISH_MODE=off

# Cách A — Serve Web
TS_PUBLISH_MODE=serve
TS_SERVE_STYLE=subdomain        # hoặc path

# Cách B — Services (DNS name thật, khuyến nghị)
TS_PUBLISH_MODE=services
TS_SERVICES_AUTOAPPROVE=1

# Cả hai
TS_PUBLISH_MODE=both
TS_SERVE_STYLE=path
TS_SERVICES_AUTOAPPROVE=1
```

## Các bước triển khai

```bash
# 1. Xem trước (không ghi gì, không cần Docker)
npm run ts-init:dry
npm run ts-publish:dry

# 2. Áp ACL + serve.json + bật HTTPS + tạo VIP services (chạy khi lần đầu / đổi mode)
npm run ts-init

# 3. Start stack — up.mjs tự động publish theo TS_PUBLISH_MODE
#    publish.mjs sẽ: auto-detect hostname → create VIP services → advertise → approve
npm run up
#    (hoặc publish thủ công không restart stack:)
npm run ts-publish

# 4. Verify
npm run ts-status
docker compose exec tailscale tailscale serve status   # phải thấy tcp:2222 + svc/Web
npm run ts-test                                         # 15/15 pass
```

Từ máy client (Windows PowerShell), kiểm chứng Cách B:

```powershell
ipconfig /flushdns
Resolve-DnsName whoami.<tailnet>.ts.net    # Cách B: resolve OK
curl https://whoami.<tailnet>.ts.net/      # Cách B: 200 OK
```

## ✅ Checklist an toàn (nodesync SSH sync)

Publish **không được** ảnh hưởng SSH sync (TCP 2222). Sau khi deploy, xác nhận:

- [ ] `docker compose exec tailscale tailscale serve status` vẫn liệt kê
      `tcp://…:2222 → tcp://host.docker.internal:22`.
- [ ] `npm run ts-test` pass (bao gồm invariant "TCP 2222 luôn còn mọi mode").
- [ ] nodesync sync vẫn chạy bình thường (kiểm `docs/nodesync-verification.md`).
- [ ] Không có script nào gọi `tailscale serve clear` không scope.

## Rollback

Đặt lại `TS_PUBLISH_MODE=off`, rồi:

```bash
npm run ts-init     # serve.json về chỉ TCP 443 + 2222; ACL bỏ autoApprovers (nếu muốn)
npm run up
```

Gỡ 1 service B thủ công (không đụng 2222):

```bash
docker compose exec tailscale tailscale serve --service=svc:whoami --https=443 off
```

## Lưu ý

- `TS_PUBLISH_MODE=off` khi chạy `ts-init` **sẽ ghi đè** `serve.json` thành chỉ-TCP
  (xoá các subdomain Cách A cũ). Đây là hành vi mong muốn của "off".
- **Hostname tự detect**: `init.mjs` và `publish.mjs` đều tự lấy hostname từ Tailscale API.
  Không cần set `TS_HOSTNAME` thủ công — xóa nó khỏi .env để dùng auto-detect.
- **VIP services tự tạo**: `publish.mjs` gọi `PUT /vip-services/svc:<name>` trước khi advertise.
  Nếu service đã tồn tại → idempotent (200 OK). Không cần tạo thủ công qua admin UI.
- **Host auto-approve**: Sau advertise, `publish.mjs` gọi `POST .../approved` để approve node.
  Kết hợp với ACL `autoApprovers.services`, node tự duyệt mà không kẹt "pending approval".
