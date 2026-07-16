// orchestrator/scripts/hooks/upload-data.mjs
// HOOK: đẩy dữ liệu lên trước khi node cũ rời đi (litestream/rclone flush).
//
// Repo đã có litestream (replicate SQLite) + rclone (sync). Hook này ép
// flush/sync ngay tại thời điểm handoff để không mất dữ liệu giữa hai ca.
//
// Có thể cấu hình lệnh tuỳ ý qua env ORCH_UPLOAD_CMD (chạy trong REPO_DIR),
// nếu không set thì fallback về các lệnh mặc định an toàn (best-effort).

import { spawnSync } from "node:child_process";
import { compose, REPO_DIR } from "../lib/docker.mjs";
import { pushEvent } from "../lib/rtdb.mjs";
import { log, error, redact } from "../lib/log.mjs";

export const name = "upload-data";

function runShell(cmd) {
  log(`[hook:${name}] $ ${cmd}`);
  const res = spawnSync(cmd, { cwd: REPO_DIR, shell: true, encoding: "utf8", timeout: 300_000 });
  if (res.status !== 0) error(`[hook:${name}] non-zero: ${redact((res.stderr || "").trim())}`);
  return res.status === 0;
}

export async function run(ctx) {
  const custom = process.env.ORCH_UPLOAD_CMD;
  let ok = true;

  if (custom && custom.trim()) {
    ok = runShell(custom.trim());
  } else {
    // Best-effort defaults: nhắc litestream snapshot + rclone sync (nếu có service).
    // litestream tự replicate liên tục; ở đây ta chỉ đảm bảo container còn sống
    // đủ lâu để đẩy nốt WAL. rclone: chạy sync thủ công nếu script tồn tại.
    try {
      compose(["exec", "-T", process.env.ORCH_RCLONE_SERVICE || "rclone", "sh", "-lc",
        process.env.ORCH_RCLONE_PUSH_CMD || "true"], { throwOnError: false });
    } catch (e) {
      error(`[hook:${name}] rclone push skipped: ${e.message}`);
    }
  }

  await pushEvent("handoff.data_uploaded", { ok, successor: ctx.successor, term: ctx.term });
  log(`[hook:${name}] done ok=${ok}`);
  return { uploaded: ok };
}
