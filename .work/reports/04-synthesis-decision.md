# Phase 04 — Tổng hợp 3 phương án kênh & quyết định phương án cuối

> **Audit bổ sung 2026-07-17:** Thiết kế hợp nhất vẫn giữ, nhưng fallback hiện
> dựa trên SSH probe thật (không chỉ resolve). Tailscale userspace đi qua SOCKS5
> sidecar; hold 503 đã có HTTP gate thật. Nguồn hiện hành:
> `docs/nodesync-verification.md`.

> Vai trò: Reviewer/Architect. So sánh 3 phương án kênh truyền SSH, đánh giá
> mạnh/yếu/độ phức tạp/độ đúng-thực-tế, rồi chốt **phương án hợp nhất** đã hiện
> thực (config-driven + fallback). Đây là phần "đối chiếu qua lại, report theo
> từng phương án, đề xuất phương án tối ưu" — làm SAU khi code + test xong.

## Bối cảnh
Yêu cầu (bản mới): **1 phương án hợp nhất**, có config enable từng kênh, đồng bộ
chạy trên mọi kênh, fallback **Tailscale → Cloudflare → Hybrid**. Dưới đây so sánh
3 kênh như 3 "phương án con" để giải thích vì sao xếp thứ tự ưu tiên như vậy.

## So sánh 3 kênh

### PA A — Tailscale
| Tiêu chí | Đánh giá |
|----------|----------|
| Đáp ứng | Kết nối mesh WireGuard, `tailscale ssh` hoặc sshd qua tailnet IP |
| Mạnh | Zero-config key (Tailscale SSH + ACL), mã hoá E2E, IP ổn định 100.x |
| Yếu | Cần authkey/tailnet; **userspace + accept-dns=false** ⇒ phải resolve qua LocalAPI, không dùng system DNS; container khác cần `network_mode: service:tailscale` hoặc SOCKS5 |
| Phức tạp | Trung bình (đã có sẵn service tailscale trong stack) |
| Đúng thực tế | Cao trong CI có tailnet; **đã tra docs** để resolve đúng |
| **Kết luận** | **Ưu tiên #1** — hạ tầng đã có, bảo mật tốt |

### PA B — Cloudflare (`cloudflared access ssh`)
| Tiêu chí | Đánh giá |
|----------|----------|
| Đáp ứng | Tunnel SSH qua edge Cloudflare (ProxyCommand) |
| Mạnh | Không cần tailnet; tận dụng cloudflared đã có; qua Internet vẫn an toàn |
| Yếu | Cần cấu hình **ingress SSH** riêng + Access policy → ảnh hưởng codebase cloudflare hiện tại nhiều hơn |
| Phức tạp | Cao hơn A (thêm ingress, ProxyCommand) |
| Đúng thực tế | Trung bình; phụ thuộc cấu hình tunnel |
| **Kết luận** | **Dự phòng #2** — bật khi cần, ít ảnh hưởng nếu để tắt mặc định |

### PA C — Hybrid (trực tiếp IP/host)
| Tiêu chí | Đánh giá |
|----------|----------|
| Đáp ứng | sshd trong container, kết nối trực tiếp IP/host cấu hình |
| Mạnh | Đơn giản nhất, chắc chắn, test được ngay (2 container cùng network) |
| Yếu | Cần định tuyến/IP tự lo; không mã hoá overlay như A |
| Phức tạp | Thấp |
| Đúng thực tế | Cao trong môi trường test/LAN; là **fallback cuối** đáng tin |
| **Kết luận** | **Fallback #3** — luôn dùng được, đảm bảo sync không "chết" |

## Đối chiếu qua lại → phương án hợp nhất (ĐÃ hiện thực)
- **Không chọn 1 kênh duy nhất** vì mỗi kênh mạnh/yếu ở môi trường khác nhau.
- **Hợp nhất**: enable từng kênh bằng `SSH_CHANNEL_*_ENABLE`; `sync.mjs` +
  `resolve-peer.mjs` thử theo thứ tự `channel_priority = [tailscale, cloudflare,
  hybrid]`, kênh nào lỗi/tắt → **fallback** kênh kế, **log rõ lý do**.
- Ưu tiên A (bảo mật + hạ tầng sẵn) → B (không cần tailnet) → C (chắc chắn cuối).
- Kênh setup (tạo user/sshd) dùng chung; chỉ **đồng bộ** mới phân nhánh kênh.

**Bằng chứng execute**: `resolve-peer.mjs` chạy thật cho thấy tailscale FAIL →
fallback hybrid thành công (xem `.work/reports/03-phase2-nodesync.md`).

## Rủi ro & giảm thiểu
| Rủi ro | Giảm thiểu |
|--------|-----------|
| Quyền cao (root + NOPASSWD + docker.sock) | README cảnh báo; chỉ bật khi `SSH_ENABLE=1`; secret redact + base64 mask |
| Cloudflare ingress ảnh hưởng codebase | Mặc định TẮT (`SSH_CHANNEL_CLOUDFLARE_ENABLE=0`); dùng ProxyCommand, không sửa cloudflare.yml |
| Treo request | Mặc định 503 Retry-After (đơn giản, chắc); file cờ dễ bật/tắt |
| Thiếu tailnet/creds cục bộ | Fallback + log reason; kiểm chứng phần data bằng rsync/checksum thật |

## Chốt
Phương án hợp nhất config-driven + fallback là **tối ưu** cho yêu cầu: linh hoạt
theo môi trường, an toàn khi thiếu 1 kênh, ảnh hưởng codebase tối thiểu (cloudflare
tắt mặc định). Đã hiện thực + test đầy đủ.
