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
import { getNodeIdentityWithTailscale } from "./lib/node-identity.mjs";
import { getTailscaleInfo } from "./lib/tailscale-info.mjs";
import { viTime } from "./lib/vi-time.mjs";
import { log, error } from "./lib/log.mjs";

const STATES = ["booting", "ready", "serving", "draining", "stopped"];

function intervalMs() {
  const s = Number(process.env.ORCH_HEARTBEAT_INTERVAL_SECONDS || 15);
  return (Number.isFinite(s) && s > 0 ? s : 15) * 1000;
}

export async function startRegistration({ initialState = "booting" } = {}) {
  const { db, paths } = connectRtdb();
  const identity = getNodeIdentityWithTailscale();
  const nodeRef = db.ref(paths.node(identity.nodeId));

  const base = {
    ...identity,
    state: STATES.includes(initialState) ? initialState : "booting",
    startedAt: ServerValue.TIMESTAMP,
    startedAtVi: viTime(),
    heartbeat: ServerValue.TIMESTAMP,
    heartbeatVi: viTime(),
    updatedAt: ServerValue.TIMESTAMP,
    updatedAtVi: viTime(),
  };

  await nodeRef.set(base);
  // Khi mất kết nối (container chết / job hết giờ) → tự đánh dấu stopped.
  // LƯU Ý: onDisconnect chỉ nên tồn tại cho TIẾN TRÌNH HEARTBEAT CHÍNH.
  // Các script one-shot (discover-predecessor chạy qua `run --rm orchestrator`)
  // KHÔNG gọi startRegistration nên không đăng ký onDisconnect — an toàn.
  // Ta giữ tham chiếu để có thể .cancel() khi node dừng CHỦ ĐỘNG (tránh
  // onDisconnect firing trễ ghi đè "stopped" lên instance mới sau restart).
  const disconnectHandler = nodeRef.onDisconnect();
  await disconnectHandler.update({
    state: "stopped",
    stoppedAt: ServerValue.TIMESTAMP,
    stoppedAtVi: viTime(),
  });
  await pushEvent("node.registered", { nodeId: identity.nodeId, state: base.state });
  log(
    `Registered node ${identity.nodeId} state=${base.state} host=${identity.host} ` +
      `ts=${identity.tailscale?.available ? identity.tailscale.ip || "up" : "n/a"} ` +
      `user=${identity.runtime?.systemUser}(uid=${identity.runtime?.uid}) cwd=${identity.runtime?.cwd}`,
  );
  if (!identity.tailscale?.available && identity.tailscale?.reason) {
    // Debug rõ ràng khi KHÔNG lấy được tailnet (thiếu môi trường).
    log(`Tailscale info không sẵn có: ${identity.tailscale.reason}`);
  }

  const timer = setInterval(() => {
    nodeRef
      .update({ heartbeat: ServerValue.TIMESTAMP, heartbeatVi: viTime() })
      .catch((e) => error(`heartbeat failed: ${e.message}`));
  }, intervalMs());
  timer.unref?.();

  // API tiện dụng cho các script khác cập nhật state / publicUrl.
  return {
    nodeId: identity.nodeId,
    nodeRef,
    async setState(state, extra = {}) {
      if (!STATES.includes(state)) throw new Error(`invalid state: ${state}`);
      // Khi dừng CHỦ ĐỘNG → huỷ onDisconnect để nó không firing trễ, ghi đè
      // "stopped" lên một instance mới (sau restart) đang serving.
      if (state === "stopped") {
        try { await disconnectHandler.cancel(); } catch {}
      }
      await nodeRef.update({ state, updatedAt: ServerValue.TIMESTAMP, updatedAtVi: viTime(), ...extra });
      await pushEvent("node.state", { nodeId: identity.nodeId, state });
      log(`Node ${identity.nodeId} → ${state}`);
    },
    async setPublicUrl(url) {
      process.env.ORCH_PUBLIC_URL = url;
      await nodeRef.update({ publicUrl: url, updatedAt: ServerValue.TIMESTAMP, updatedAtVi: viTime() });
      log(`Node ${identity.nodeId} publicUrl set`);
    },
    // Cập nhật lại thông tin Tailscale (tailnet IP thường xuất hiện sau vài giây
    // khi node vừa join xong). Gọi lại sau khi stack ready để có ip/hostname đúng.
    async refreshTailscale() {
      try {
        const ts = getTailscaleInfo();
        await nodeRef.update({ tailscale: ts, updatedAt: ServerValue.TIMESTAMP, updatedAtVi: viTime() });
        if (ts.available) {
          log(`Node ${identity.nodeId} tailscale refreshed: ip=${ts.ip} host=${ts.hostname} ver=${ts.version} os=${ts.os}`);
        } else {
          log(`Node ${identity.nodeId} tailscale refresh: chưa sẵn có (${ts.reason})`);
        }
        return ts;
      } catch (e) {
        error(`refreshTailscale failed: ${e.message}`);
        return { available: false, reason: e.message };
      }
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
