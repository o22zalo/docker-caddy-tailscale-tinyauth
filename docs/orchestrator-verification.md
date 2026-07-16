# Orchestrator — hướng dẫn kiểm chứng luồng leader/handoff

Tài liệu này mô tả **luồng đúng** khi orchestration bật (`CONSUL_ENABLE=1`), các
**thông báo (log)** sinh ra ở từng giai đoạn, và cách **kiểm chứng** bằng nhật ký
chuyển giao ghi trong RTDB + đối chiếu leader qua `whoami`.

> Log election-snapshot giờ có **diễn giải tiếng Việt** trong ngoặc:
> `Election snapshot: standby-blocked (đang chờ — leader hiện tại còn sống, chưa tới lượt tiếp quản)`.

---

## 1. Luồng đúng: runner01 chạy trước

Khi **runner01** khởi động (chưa có runner nào khác):

| Bước | Log tiêu biểu (rút gọn) |
|------|--------------------------|
| Đăng ký node | `Registered node github-<id01>-1 state=booting host=... user=root(uid=0) cwd=/app` |
| Tailscale (nếu có) | `Node ... tailscale refreshed: ip=100.x.y.z host=proxy-stack-a ver=1.98.x os=linux` hoặc `tailscale info không sẵn có: <reason>` |
| Stack ready | `Election snapshot: stack-ready (stack cục bộ đã sẵn sàng ...)` |
| Giành leader | `Now LEADER (term=1). Serving traffic.` + `Election snapshot: leader-acquired (node này VỪA GIÀNH ghế leader ...)` |
| Renew định kỳ | `Renewed leadership: node=github-<id01>-1 ... term=1` |

⟹ Lúc này **RTDB** có `leader = { nodeId: github-<id01>-1, term: 1 }`, và
`whoami.{DOMAIN}` trả về body chứa `Name: github-<id01>-1`.

---

## 2. runner02 chạy lên (trong khi runner01 vẫn là leader)

| Bước (runner02) | Log tiêu biểu |
|------|----------------|
| Đăng ký + ready | `Registered node github-<id02>-1 ...` → `stack-ready` |
| Thử giành ghế → BỊ CHẶN | `Standby: leader still active (node=github-<id01>-1 ... ttlMs=90000). Waiting.` |
| | `Election snapshot: standby-blocked (đang chờ — leader hiện tại còn sống, chưa tới lượt tiếp quản)` |

**Đồng thời trên runner01** (leader) phát hiện successor mới ready → bắt đầu handoff:

| Bước (runner01) | Log tiêu biểu | Nhật ký chuyển giao (RTDB `handoff/log`) |
|------|----------------|------------------------------------------|
| Phát hiện successor | `Handoff triggered → successor=github-<id02>-1 (overTime=false)` | `[begin] Bắt đầu chuyển giao từ ...01 sang ...02 (term=1)` |
| | `Election snapshot: handoff-begin (BẮT ĐẦU chuyển giao ...)` | |
| Chạy pipeline | `Running handoff pipeline (2 hooks) ...` | `[pipeline_start] Chạy pipeline handoff (2 hook) ...` |
| Hook upload-data | `[hook:upload-data] done ok=true` | `[hook_start]/[hook_done] Hook "upload-data" ...` |
| Hook stop-cloudflared | `[hook:stop-cloudflared] ...` | `[hook_start]/[hook_done] Hook "stop-cloudflared" ...` |
| | | `[pipeline_done] Pipeline handoff hoàn tất (2/2 hook OK)` |
| Nhả ghế | `Releasing leadership for successor=...02` | `[release] Nhả ghế leader để ...02 tiếp quản (term=1)` |
| | `Election snapshot: handoff-complete (HOÀN TẤT chuyển giao ...)` | `[complete] Hoàn tất chuyển giao ...` |

Sau đó **runner02** ở vòng poll kế tiếp thấy leader "stale" (heartbeat=0) → giành
ghế:

```
Now LEADER (term=2). Serving traffic.
Election snapshot: leader-acquired (node này VỪA GIÀNH ghế leader ...)
```

⟹ **RTDB** `leader = { nodeId: github-<id02>-1, term: 2 }` (term **tăng** — fencing).
`whoami.{DOMAIN}` giờ trả `Name: github-<id02>-1`.

---

## 3. Xem nhật ký chuyển giao (đối chiếu log thực thi có đúng không)

```bash
# Trong container orchestrator (đã có creds):
docker compose exec -T orchestrator node scripts/handoff-log.mjs          # timeline người-đọc
docker compose exec -T orchestrator node scripts/handoff-log.mjs --json   # JSON thô
docker compose exec -T orchestrator node scripts/handoff-log.mjs --limit 50
```

Ví dụ output (theo thứ tự thời gian):

```
=== Nhật ký chuyển giao (handoff log) — stack="example-com" — 9 dòng ===
  [<t1>] (begin) from=...01 to=...02 term=1
      → Bắt đầu chuyển giao từ ...01 sang ...02 (term=1)
  [<t2>] (pipeline_start) to=...02
      → Chạy pipeline handoff (2 hook) cho node kế nhiệm ...02
  ...
  [<t9>] (complete) from=...01 to=...02 term=2
      → Hoàn tất chuyển giao: ...01 đã nhả ghế, ...02 đã giành leader
```

---

## 4. Đối chiếu leader ↔ whoami (CI tự động)

CI chạy `scripts/runners/verify-leader-whoami.mjs` (đã thêm vào `test.yml`): mỗi
5s `curl whoami.{DOMAIN}` và so `Name:` với leader trên RTDB, **lặp tới khi trùng**:

```
==> Đối chiếu leader ↔ whoami. URL=https://whoami.example.com timeout=120s interval=5s
    attempt 1: leader(RTDB)=github-<id>-1 term=1  whoami(Name)=github-<id>-1
SO SÁNH ĐỐI CHIẾU: ✅ TRÙNG KHỚP
  leader đang chạy (RTDB): github-<id>-1 (term=1)
  whoami.{DOMAIN} trả về : github-<id>-1
  → Request public đang được phục vụ ĐÚNG bởi leader hiện tại.
```

`setup-env.mjs` materialize `ORCH_NODE_ID` ổn định trước khi Compose render và
ghi cùng giá trị vào `.env`/`GITHUB_ENV`. Vì vậy orchestrator và
`WHOAMI_NAME: ${WHOAMI_NAME:-${ORCH_NODE_ID:-whoami}}` nhận đúng cùng ID.
Workflow đặt `VERIFY_LEADER_STRICT=1`: quá timeout mà không trùng sẽ fail CI;
khi `CONSUL_ENABLE!=1`, script skip thành công vì không có leader để đối chiếu.

---

## 5. Thông tin node mở rộng (Tailscale + runtime)

Node record trên RTDB giờ có thêm:

```jsonc
{
  "tailscale": { "available": true, "ip": "100.x.y.z", "hostname": "proxy-stack-a",
                 "version": "1.98.x", "os": "linux", "tailnet": "tailXXXX.ts.net", ... },
  "runtime":   { "systemUser": "root", "uid": 0, "isRoot": true, "cwd": "/app",
                 "channels": ["tailscale","hybrid"], "primaryChannel": "tailscale",
                 "sshUsers": [ { "index": 1, "user": "sync", "privileged": true, ... } ] }
}
```

Xem nhanh: `docker compose exec -T orchestrator node scripts/status.mjs`
(hoặc đọc trực tiếp node record trên Firebase Console).

Khi Tailscale chưa sẵn (thiếu authkey / chưa join), `tailscale.available=false` kèm
`reason` để **debug rõ ràng**.

---

## 6. An toàn khi handoff lỗi

`upload-data` và `stop-cloudflared` là critical hooks. Upload mặc định gọi
`rclone/scripts/sync-loop.mjs --once` nếu service rclone đang chạy; custom
`ORCH_UPLOAD_CMD` non-zero cũng là lỗi. Cloudflared phải dừng thật sau lệnh stop.
Nếu bất kỳ critical hook nào lỗi, orchestrator ghi `handoff.aborted`, trả state
về `serving`, giữ leadership và retry sau; tuyệt đối không release leader với dữ
liệu/tunnel ở trạng thái chưa hoàn tất.

## 7. Ràng buộc kiểm chứng cục bộ

- Election/handoff đã được **execute thật** bằng mock RTDB (`.work/verify/verify-election.mjs`
  → PASS: no split-brain, term 1→2 monotonic, 9-dòng handoff-log đúng thứ tự).
- Đối chiếu leader↔whoami và tailnet cần **CI hoặc host có Docker daemon + creds**
  (sandbox không chạy container/Firebase/tailnet được). Log/debug đã in rõ lý do
  khi thiếu môi trường.
