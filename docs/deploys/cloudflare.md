# Deploy với Cloudflare Tunnel

Hướng dẫn triển khai stack qua Cloudflare Tunnel — truy cập public mà không mở port firewall.

## Yêu cầu

- Domain đã add vào Cloudflare (nameserver trỏ về Cloudflare)
- Cloudflare Account ID
- API Token với permissions:
  - **Account** → Cloudflare Tunnel: Edit
  - **Zone** → DNS: Edit
  - **Zone** → Workers: Edit (tùy chọn, dùng cho tương lai)

## Bước 1: Tạo API Token

1. Đăng nhập [Cloudflare Dashboard](https://one.dash.cloudflare.com/)
2. My Profile → API Tokens → Create Token
3. Chọn template **Edit zone DNS** hoặc tạo custom:
   - Account → Cloudflare Tunnel → Edit
   - Zone → DNS → Edit
   - Zone → Workers → Edit (tùy chọn)
4. Giới hạn Zone → chọn domain cụ thể
5. Copy token (bắt đầu bằng `xxxx...`)

## Bước 2: Cấu hình `.env`

```bash
cp .env.example .env
```

Edit `.env`, set các biến bắt buộc:

```env
# Domain
DOMAIN=example.com

# Cloudflare API
CF_API_TOKEN=xxxx_your_token_here
CF_ACCOUNT_ID=your_account_id

# Profiles
COMPOSE_PROFILES=core
```

**Lấy Account ID:** Dashboard → bất kỳ zone nào → sidebar phải → "Account ID".

## Bước 3: Cấu hình hostnames (tùy chọn)

Edit `cloudflare/scripts/hostnames.jsonc` để thêm/bớt subdomain:

```jsonc
{
  // Subdomains sẽ tạo cho {hostname}.{DOMAIN}
  "hostnames": [
    "auth",   // Tinyauth login page
    "files",  // File server
    "ttyd"    // Terminal web
  ],

  // Service URL mà tất cả hostname trỏ về
  "service_url": "http://caddy:80",

  // Catch-all rule
  "catch_all": "http_status:404"
}
```

Mỗi entry trong `hostnames` sẽ tạo subdomain `{hostname}.{DOMAIN}`.

## Bước 4: Provision tunnel

```bash
# Xem trước (không gọi API, không ghi .env)
node cloudflare/scripts/provision-tunnel.mjs --dry-run

# Chạy với xác nhận (mặc định)
node cloudflare/scripts/provision-tunnel.mjs

# Chạy luôn, không hỏi
node cloudflare/scripts/provision-tunnel.mjs --silent

# Chỉ định .env khác
node cloudflare/scripts/provision-tunnel.mjs --env path/to/.env
```

Hoặc dùng npm/make:

```bash
npm run provision
make provision
```

Script sẽ hiển thị tổng hợp thông tin trước khi chạy:

- File `.env` nào sẽ dùng
- Domain, Account ID, Zone ID
- Tên tunnel, ID tunnel, token
- Các hostname sẽ tạo
- Các DNS record sẽ tạo

Với `--dry-run`: chỉ hiển thị, không gọi API hay ghi file.
Với `--silent`: bỏ qua xác nhận, chạy luôn.
Mặc định: hỏi `[y/N]` trước khi thực hiện.

Script sẽ:
1. Resolve Zone ID từ DOMAIN (hoặc dùng CF_ZONE_ID đã có)
2. Tạo tunnel `{DOMAIN}-tunnel` (hoặc dùng CF_TUNNEL_ID đã có)
3. Fetch tunnel token
4. Cấu hình ingress (hostnames → http://caddy:80)
5. Tạo DNS CNAME records
6. Lưu tất cả vào `.env` (CF_ZONE_ID, CF_TUNNEL_ID, CF_TUNNEL_TOKEN, ...)

Chạy lại script nhiều lần cũng an toàn — nó skip tạo mới nếu đã có trong `.env`.

## Bước 5: Start stack

```bash
docker compose up -d
# hoặc
make up
# hoặc
npm run up
```

Verify:

```bash
docker compose ps
docker compose logs cloudflared
```

## Bước 6: Kiểm tra truy cập

- `https://auth.example.com` → Tinyauth login page
- `https://files.example.com` → (nếu có upstream)
- `https://ttyd.example.com` → (nếu có upstream)

## Env vars tự động ghi vào `.env`

Sau khi chạy provision, các biến sau sẽ có trong `.env`:

| Var | Mô tả |
|-----|-------|
| `CF_ZONE_ID` | Zone ID (tự tra theo DOMAIN) |
| `CF_TUNNEL_NAME` | Tên tunnel (`{DOMAIN}-tunnel`) |
| `CF_TUNNEL_ID` | Tunnel ID (UUID) |
| `CF_TUNNEL_TOKEN` | Token để cloudflared connect |

Các biến này dùng được cho `TUNNEL_TOKEN` trong compose (hoặc script tự map).

## Troubleshooting

### "zone not found"
Domain chưa add vào Cloudflare hoặc nameserver chưa trỏ về Cloudflare.

### "tunnel already exists"
Bình thường — script sẽ tìm lại tunnel hiện có và dùng lại.

### cloudflared crash-loop
Check `docker compose logs cloudflared`. Thường do token sai hoặc rỗng.

### DNS không resolve
Check Cloudflare Dashboard → DNS → records đã có CNAME chưa.

### Permission denied
API Token thiếu quyền. Đảm bảo có Tunnel:Edit + DNS:Edit trên đúng zone.
