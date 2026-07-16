// orchestrator/scripts/hooks/stop-cloudflared.mjs
// HOOK: dừng cloudflared của node CŨ để "nhường" tunnel cho node mới.
//
// Với NAMED TUNNEL: nhiều connector cùng chạy 1 tunnel → khi node mới đã
// connect (ready) và node cũ stop cloudflared, Cloudflare tự route sang
// connector còn sống ⇒ zero-downtime, cùng domain.
//
// grace period lấy từ ORCH_CF_STOP_GRACE (mặc định 35s, khớp stop_grace_period).

import { stopService, isRunning } from "../lib/docker.mjs";
import { pushEvent } from "../lib/rtdb.mjs";
import { log } from "../lib/log.mjs";

export const name = "stop-cloudflared";

export async function run(ctx) {
  const service = process.env.ORCH_CF_SERVICE || "cloudflared";
  const grace = Number(process.env.ORCH_CF_STOP_GRACE || 35);

  if (!isRunning(service)) {
    log(`[hook:${name}] ${service} not running — skip`);
    return { skipped: true };
  }

  log(`[hook:${name}] draining tunnel: stopping ${service} to hand over to ${ctx.successor}`);
  stopService(service, { grace });
  await pushEvent("handoff.cloudflared_stopped", {
    service,
    successor: ctx.successor,
    term: ctx.term,
  });
  return { stopped: service };
}
