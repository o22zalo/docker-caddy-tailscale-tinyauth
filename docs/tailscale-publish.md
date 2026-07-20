# Publish app qua tailnet — Cách A + Cách B (Tailscale)

Tài liệu này mô tả cách publish các app nội bộ của stack (auth, files, webssh, dozzle,
whoami…) ra tailnet Tailscale, qua **hai cơ chế độc lập**, bật/tắt hoàn toàn bằng biến
môi trường prefix `TS_`.

> **TL;DR**
> - Mặc định `TS_PUBLISH_MODE=off` → **không đổi gì**, an toàn tuyệt đối.
> - Muốn DNS name **thật** (vd `https://whoami.tailaa8079.ts.net/` resolve được) → dùng **Cách B** (`services`).
> - Cách A (`serve`) chỉ proxy nội bộ, **không** tạo MagicDNS record riêng cho subdomain.
> - **SSH sync (TCP 2222) không bao giờ bị đụng** trong bất kỳ mode nào.
> - **Hostname tự detect**: không cần set `TS_HOSTNAME` thủ công — script tự lấy từ Tailscale API.

---

## 1. Vì sao có hai cách?

| | Cách A — `serve` | Cách B — `services` |
|---|---|---|
| Cơ chế | Tailscale **Serve Web** (`serve.json` → `Web{}`) | Tailscale **Services** (`svc:<name>`) |
| Advertise | Khai trong `serve.json` (nạp qua `TS_SERVE_CONFIG`) | CLI: `tailscale serve --service=svc:<name> --https=443 <upstream>` |
| MagicDNS record riêng? | ❌ **Không** — `Resolve-DnsName whoami.<tailnet>` báo *does not exist* | ✅ **Có** — DNS name thật `https://<name>.<tailnet>/` |
| Cần duyệt (approval)? | Không | Có → giải quyết bằng `autoApprovers.services` (tự động) |
| Ổn định | Ổn định, cũ | Mới hơn (đã test OK trong userspace mode của stack này) |

**Nguyên nhân gốc của lỗi "DNS name does not exist":** trước đây stack chỉ dùng Cách A.
Serve Web nhận subdomain (`auth.<tailnet>`, `whoami.<tailnet>`…) và proxy chạy *nội bộ*,
nhưng Tailscale **chỉ tạo MagicDNS record cho hostname của node** (vd `proxy-stack-gh-…`),
không tự tạo record cho từng subdomain khai trong Serve. Vì vậy client tra DNS sẽ không
thấy. Cách B (Tailscale Services) mới là cơ chế tạo DNS name thật.

---

## 2. Các biến môi trường (prefix `TS_`)

| Biến | Giá trị | Mặc định | Áp dụng |
|------|---------|----------|---------|
| `TS_PUBLISH_MODE` | `off` \| `serve` \| `services` \| `both` | `off` | Công tắc chính |
| `TS_SERVE_STYLE` | `subdomain` \| `path` | `subdomain` | Cách A |
| `TS_SERVICES_AUTOAPPROVE` | `1` \| `0` | `1` | Cách B |

### `TS_PUBLISH_MODE`
- `off` — không publish app. `serve.json` chỉ còn `TCP{443 HTTPS, 2222 SSH}`. **An toàn.**
- `serve` — bật Cách A.
- `services` — bật Cách B.
- `both` — bật **cả hai song song** (một app vừa có Serve Web vừa có Service).

### `TS_SERVE_STYLE` (chỉ Cách A)
- `subdomain` — mỗi app một host ảo: `https://auth.<tailnet>`, `https://files.<tailnet>`…
- `path` — gộp tất cả vào host của node: `https://<TS_HOSTNAME>.<tailnet>/auth`, `/files`…
  Kiểu `path` dùng đúng hostname thật của node nên **request tới được** (khác subdomain ảo).

### `TS_SERVICES_AUTOAPPROVE` (chỉ Cách B)
- `1` — `init.mjs` ghi `autoApprovers.services` vào ACL, approvers = các `TS_TAGS`
  (vd `tag:container`). Node tự duyệt, không kẹt *"approval from an admin is required"*.
- `0` — không ghi; bạn tự duyệt trong admin console.

---

## 3. Bốn kịch bản cấu hình

```env
# 1) Tắt hoàn toàn (mặc định — không publish app)
TS_PUBLISH_MODE=off

# 2) Chỉ Cách A (Serve Web, subdomain)
TS_PUBLISH_MODE=serve
TS_SERVE_STYLE=subdomain

# 3) Chỉ Cách B (Services — DNS name thật, tự duyệt)
TS_PUBLISH_MODE=services
TS_SERVICES_AUTOAPPROVE=1

# 4) Cả hai song song
TS_PUBLISH_MODE=both
TS_SERVE_STYLE=path
TS_SERVICES_AUTOAPPROVE=1
```

---

## 4. Luồng hoạt động

```
                        ┌──────────────────────────┐
   npm run ts-init  ──▶ │ tailscale/scripts/init.mjs│
   (1 lần / khi đổi ACL)│  • auto-detect hostname   │
                        │    từ Tailscale API       │
                        │  • render serve.json      │──▶ tailscale/serve.json
                        │    (theo mode + style)    │
                        │  • merge autoApprovers    │──▶ tailscale/acl.hujson
                        │  • POST ACL, bật HTTPS     │──▶ Tailscale API
                        └──────────────────────────┘

   npm run up       ──▶ scripts/up.mjs
   (mỗi lần start)        │  … compose up …
                          │  (chỉ 1 dòng gọi ↓, khi profile tailscale bật & mode!=off)
                          ▼
                        ┌──────────────────────────────┐
                        │ tailscale/scripts/publish.mjs │
                        │  • auto-detect hostname       │
                        │  • Cách A: ghi/nạp serve.json  │
                        │  • Cách B:                    │
                        │    1. PUT /services/svc:*      │──▶ tạo services
                        │    2. serve --service=svc:*    │──▶ advertise
                        │    3. POST approve host       │──▶ approve node
                        │  • phòng thủ: lỗi KHÔNG gãy stack
                        └──────────────────────────────┘
```

- **Logic thuần** nằm ở `tailscale/scripts/lib/publish-lib.mjs` (unit-testable, không side-effect).
- `up.mjs` **chỉ gọi 1 dòng** `node tailscale/scripts/publish.mjs` — không chứa logic publish.

---

## 5. ⚠️ An toàn SSH sync (nodesync) — BẤT BIẾN

Stack dùng **TCP 2222** (`tailscale serve --tcp=2222 tcp://host.docker.internal:22`)
làm kênh SSH cho nodesync sync dữ liệu giữa các node. Đây là **xương sống** và tuyệt đối
không được phá.

Các đảm bảo đã đưa vào code:
- `serve.json` **luôn** chứa `TCP{443 HTTPS, 2222 SSH forward}` trong **mọi** `TS_PUBLISH_MODE`
  (kể cả `off`). Có unit test khẳng định điều này.
- `publish.mjs` **không bao giờ** gọi `tailscale serve clear` không scope.
- Cách B chỉ thao tác scope `--service=svc:` — độc lập hoàn toàn với `--tcp=2222` local scope
  (đã verify qua `tailscale serve status`: cả hai cùng tồn tại).
- Nếu `buildServeConfig` vì lý do gì đó thiếu 2222, `publish.mjs` **từ chối ghi** serve.json.
- Mọi lỗi publish được **nuốt + log**, thoát code 0 → không làm gãy `up.mjs` / sync.

---

## 6. Cách dùng

```bash
# Xem trước (không đụng gì)
TS_PUBLISH_MODE=both npm run ts-init:dry
TS_PUBLISH_MODE=both npm run ts-publish:dry

# Áp ACL + serve.json + bật HTTPS (khi đổi mode / lần đầu)
npm run ts-init

# Start stack — up.mjs sẽ tự gọi publish theo TS_PUBLISH_MODE
npm run up

# Publish thủ công (nếu chỉ muốn re-advertise mà không restart stack)
npm run ts-publish

# Kiểm tra kết quả
npm run ts-status
docker compose exec tailscale tailscale serve status

# Chạy unit test
npm run ts-test
```

### Kiểm chứng Cách B từ máy client
```powershell
ipconfig /flushdns
Resolve-DnsName whoami.<tailnet>.ts.net    # Cách B: phải resolve; Cách A: sẽ "does not exist"
```

---

## 7. Xử lý sự cố

| Triệu chứng | Nguyên nhân | Khắc phục |
|-------------|-------------|-----------|
| `Resolve-DnsName …` báo *does not exist* | Đang dùng Cách A (`serve`) hoặc VIP service chưa tạo | Chuyển `TS_PUBLISH_MODE=services` hoặc `both`; publish.mjs tự tạo VIP services |
| Service kẹt *"approval from an admin is required"* | Host chưa approve | publish.mjs tự approve qua API; nếu fallback, chạy `npm run ts-publish` lại |
| Hostname sai trong serve.json (Cách A path không match) | `TS_HOSTNAME` chưa đúng | Xoá `TS_HOSTNAME` khỏi .env — script tự detect từ Tailscale API |
| SSH sync gãy sau khi bật publish | (không nên xảy ra) TCP 2222 bị mất | Chạy `tailscale serve status` kiểm 2222; **không** dùng `serve clear`; xem mục 5 |
| `tailscale serve --service` báo lỗi lệnh | Client Tailscale quá cũ | Cần client hỗ trợ Tailscale Services (đã test v1.98) |

---

## 8. File liên quan

| File | Vai trò |
|------|---------|
| `tailscale/scripts/lib/publish-lib.mjs` | Logic thuần (build serve.json, advertise cmd, autoApprovers) |
| `tailscale/scripts/publish.mjs` | Runner runtime; up.mjs gọi qua đây |
| `tailscale/scripts/init.mjs` | Render serve.json + ACL (dùng chung lib) |
| `tailscale/scripts/init.jsonc` | Nguồn danh sách service (dùng chung A + B) |
| `tailscale/acl.sample.hujson` | Mẫu ACL; `autoApprovers.services` chèn tự động |
| `tailscale/test/publish-lib.test.mjs` | Unit test (12 case, gồm invariant 2222) |
| `scripts/up.mjs` | Chỉ 1 dòng gọi publish sau `compose up` |
| Deploy: `docs/deploys/tailscale-publish.md` | Hướng dẫn triển khai theo môi trường |
