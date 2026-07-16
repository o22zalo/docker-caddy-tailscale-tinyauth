// orchestrator/scripts/hooks/upload-data.mjs
// Flush dữ liệu remote trước handoff. Custom ORCH_UPLOAD_CMD được ưu tiên;
// mặc định gọi rclone sync-loop --once nếu service rclone đang chạy.

import { spawnSync } from "node:child_process";
import { compose, REPO_DIR, isRunning } from "../lib/docker.mjs";
import { pushEvent } from "../lib/rtdb.mjs";
import { log, redact } from "../lib/log.mjs";

export const name = "upload-data";

function runShell(cmd) {
  log(`[hook:${name}] $ ${cmd}`);
  const res = spawnSync(cmd, { cwd: REPO_DIR, shell: true, encoding: "utf8", timeout: 300_000 });
  if (res.status !== 0) throw new Error(redact((res.stderr || res.error?.message || `exit ${res.status}`).trim()));
}

export async function run(ctx) {
  const custom = process.env.ORCH_UPLOAD_CMD?.trim();
  let mode = "skipped";
  if (custom) {
    runShell(custom);
    mode = "custom";
  } else {
    const service = process.env.ORCH_RCLONE_SERVICE || "rclone";
    if (isRunning(service)) {
      compose([
        "exec", "-T", service,
        "node", "/app/rclone/scripts/sync-loop.mjs", "--once", "--silent",
      ]);
      mode = "rclone-once";
    } else {
      log(`[hook:${name}] ${service} không chạy và ORCH_UPLOAD_CMD trống → không có remote upload cần flush`);
    }
  }

  await pushEvent("handoff.data_uploaded", { ok: true, mode, successor: ctx.successor, term: ctx.term });
  log(`[hook:${name}] done mode=${mode}`);
  return { uploaded: mode !== "skipped", mode };
}
