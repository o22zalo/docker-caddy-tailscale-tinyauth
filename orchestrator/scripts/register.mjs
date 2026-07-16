// orchestrator/scripts/register.mjs
// YÊU CẦU ①: khi start stack thành công → ghi trạng thái node lên RTDB.
//
// Ghi vào /nodes/<nodeId>:
//   state, host, runner/ci, startedAt, heartbeat, publicUrl, domain, meta...
// và giữ heartbeat sống theo chu kỳ ORCH_HEARTBEAT_INTERVAL_SECONDS.
//
// Dùng onDisconnect() để khi container/process chết, RTDB tự đánh dấu node
// "stopped" — các node khác biết ngay để tiếp quản.
//
// Có thể gọi standalone (node register.mjs) hoặc import startRegistration().

import { connectRtdb, ServerValue, pushEvent } from "./lib/rtdb.mjs";
import { getNodeIdentity } from "./lib/node-identity.mjs";
import { log, error } from "./lib/log.mjs";

const STATES = ["booting", "ready", "serving", "draining", "stopped"];

function intervalMs() {
  const s = Number(process.env.ORCH_HEARTBEAT_INTERVAL_SECONDS || 15);
  return (Number.isFinite(s) && s > 0 ? s : 15) * 1000;
}

export async function startRegistration({ initialState = "booting" } = {}) {
  const { db, paths } = connectRtdb();
  const identity = getNodeIdentity();
  const nodeRef = db.ref(paths.node(identity.nodeId));

  const base = {
    ...identity,
    state: STATES.includes(initialState) ? initialState : "booting",
    startedAt: ServerValue.TIMESTAMP,
    heartbeat: ServerValue.TIMESTAMP,
    updatedAt: ServerValue.TIMESTAMP,
  };

  await nodeRef.set(base);
  // Khi mất kết nối (container chết / job hết giờ) → tự đánh dấu stopped.
  await nodeRef.onDisconnect().update({
    state: "stopped",
    stoppedAt: ServerValue.TIMESTAMP,
  });
  await pushEvent("node.registered", { nodeId: identity.nodeId, state: base.state });
  log(`Registered node ${identity.nodeId} state=${base.state} host=${identity.host}`);

  const timer = setInterval(() => {
    nodeRef
      .update({ heartbeat: ServerValue.TIMESTAMP })
      .catch((e) => error(`heartbeat failed: ${e.message}`));
  }, intervalMs());
  timer.unref?.();

  // API tiện dụng cho các script khác cập nhật state / publicUrl.
  return {
    nodeId: identity.nodeId,
    nodeRef,
    async setState(state, extra = {}) {
      if (!STATES.includes(state)) throw new Error(`invalid state: ${state}`);
      await nodeRef.update({ state, updatedAt: ServerValue.TIMESTAMP, ...extra });
      await pushEvent("node.state", { nodeId: identity.nodeId, state });
      log(`Node ${identity.nodeId} → ${state}`);
    },
    async setPublicUrl(url) {
      process.env.ORCH_PUBLIC_URL = url;
      await nodeRef.update({ publicUrl: url, updatedAt: ServerValue.TIMESTAMP });
      log(`Node ${identity.nodeId} publicUrl set`);
    },
    stopHeartbeat() {
      clearInterval(timer);
    },
  };
}

// ── Standalone entrypoint ────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const stateArg = process.argv.find((a) => STATES.includes(a)) || "ready";
  startRegistration({ initialState: stateArg })
    .then(() => log("register.mjs: heartbeat running (Ctrl-C to stop)"))
    .catch((e) => {
      error(e.message);
      process.exit(1);
    });
}
