// orchestrator/scripts/main.mjs
// Entrypoint sidecar (CMD của Dockerfile). Điều phối vòng đời node theo
// mô hình leader/standby dùng RTDB làm consul.
//
// LUỒNG:
//   1. Đăng ký node (register) — state=booting → heartbeat sống.       [YC①]
//   2. Chờ stack local READY (cloudflared running) rồi setState=ready.
//   3. Vòng lặp:
//        - Nếu CHƯA là leader: liên tục tryAcquire().
//            + Giành được leader (leader cũ chết/nhường) → serving.
//        - Nếu ĐÃ là leader: renewLeadership() + watch standby mới.     [YC③]
//            + Khi có standby khác vừa "ready" & ta sắp hết giờ / bị đòi ghế
//              → chạy handoff pipeline (stop cloudflared, upload...).    [YC②]
//
// Toggle bằng CONSUL_ENABLE (=1 để bật). Nếu tắt, sidecar chỉ log rồi ngủ.

import { connectRtdb, pushEvent } from "./lib/rtdb.mjs";
import { getNodeIdentity, heartbeatTtlMs } from "./lib/node-identity.mjs";
import { startRegistration } from "./register.mjs";
import { tryAcquire, renewLeadership, releaseLeadership, getLeader, describeLeader } from "./elect.mjs";
import { runHandoffPipeline, loadConfig } from "./hooks/index.mjs";
import { isRunning } from "./lib/docker.mjs";
import { log, warn, error } from "./lib/log.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function enabled() {
  const v = String(process.env.CONSUL_ENABLE ?? "0").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function num(env, def) {
  const n = Number(process.env[env]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Đợi stack local sẵn sàng: cloudflared running (named tunnel connected).
async function waitStackReady({ timeoutSec = 180 } = {}) {
  const service = process.env.ORCH_READY_SERVICE || "cloudflared";
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      if (isRunning(service)) return true;
    } catch (e) {
      warn(`readiness check error: ${e.message}`);
    }
    await sleep(3000);
  }
  return false;
}

// Có standby nào khác đã "ready" và còn sống không? (để leader biết đã có ca sau)
async function findFreshSuccessor({ selfId }) {
  const { db, paths } = connectRtdb();
  const ttl = heartbeatTtlMs();
  const snap = await db.ref(paths.nodes).get();
  const nodes = snap.val() || {};
  const now = Date.now();
  const candidates = Object.entries(nodes)
    .filter(([id, n]) => id !== selfId)
    .filter(([, n]) => ["ready", "serving"].includes(n.state))
    .filter(([, n]) => now - (n.heartbeat || 0) <= ttl)
    // ưu tiên node mới khởi động gần nhất
    .sort((a, b) => (b[1].startedAt || 0) - (a[1].startedAt || 0));
  return candidates.length ? { id: candidates[0][0], node: candidates[0][1] } : null;
}

async function getElectionSnapshot() {
  const { db, paths } = connectRtdb();
  const [leaderSnap, nodesSnap] = await Promise.all([
    db.ref(paths.leader).get(),
    db.ref(paths.nodes).get(),
  ]);
  return {
    at: new Date().toISOString(),
    leader: leaderSnap.val() || null,
    nodes: nodesSnap.val() || {},
  };
}

async function logElectionSnapshot(label, extra = {}) {
  try {
    log(`Election snapshot: ${label}`, { ...extra, ...(await getElectionSnapshot()) });
  } catch (e) {
    warn(`Election snapshot failed (${label}): ${e.message}`);
  }
}

async function main() {
  const identity = getNodeIdentity();
  const config = loadConfig();
  const consulEnabled = enabled();

  log(`CONSUL_ENABLE=${consulEnabled ? "on" : "off"}`);
  if (!consulEnabled) {
    log("Sidecar idle: no registration, no election, no handoff.");
    // giữ container sống
    // eslint-disable-next-line no-constant-condition
    while (true) await sleep(3600_000);
    return;
  }

  log(`Sidecar starting. node=${identity.nodeId} host=${identity.host} ci=${identity.ci.provider}`);
  const reg = await startRegistration({ initialState: "booting" });

  // Bước 2: chờ stack local ready.
  const ready = await waitStackReady({ timeoutSec: num("ORCH_READY_TIMEOUT_SECONDS", 180) });
  if (!ready) {
    warn("stack not ready within timeout — continuing but will not claim leadership yet");
  } else {
    await reg.setState("ready", { publicUrl: process.env.ORCH_PUBLIC_URL || "" });
    const leader = await getLeader();
    log(`Stack ready. Current RTDB leader: ${describeLeader(leader)}`);
    await logElectionSnapshot("stack-ready", { self: identity.nodeId });
  }

  const acquireInterval = num("ORCH_ACQUIRE_INTERVAL_SECONDS", config.acquire_interval_seconds || 5) * 1000;
  const renewInterval = num("ORCH_RENEW_INTERVAL_SECONDS", config.poll_interval_seconds || 10) * 1000;

  let isLeader = false;
  let term = 0;
  let handoffDone = false;

  // Ngưỡng chủ động nhường ghế trước khi job hết 60': ORCH_MAX_LEADER_SECONDS.
  const maxLeaderMs = num("ORCH_MAX_LEADER_SECONDS", 55 * 60) * 1000;
  let leaderSince = 0;

  // Graceful shutdown: nếu process bị kill (job kết thúc) → nhường ghế.
  const onExit = async (sig) => {
    try {
      if (isLeader) {
        const leaderBeforeRelease = await getLeader();
        warn(`Signal ${sig}: stepping down from leader. RTDB before release: ${describeLeader(leaderBeforeRelease)}`);
        await logElectionSnapshot("signal-before-release", { self: identity.nodeId, signal: sig, role: "leader" });
        await releaseLeadership({ nodeId: identity.nodeId });
        await reg.setState("stopped");
        warn(`Signal ${sig}: released leadership and marked node stopped.`);
        await logElectionSnapshot("signal-after-release", { self: identity.nodeId, signal: sig, role: "leader" });
      } else {
        warn(`Signal ${sig}: standby node stopping. No leadership release needed.`);
        await logElectionSnapshot("signal-standby-stop", { self: identity.nodeId, signal: sig, role: "standby" });
        await reg.setState("stopped");
      }
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => onExit("SIGINT"));
  process.on("SIGTERM", () => onExit("SIGTERM"));

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!isLeader) {
      // Standby: cố giành ghế (chỉ giành khi chưa có leader / leader chết).
      if (ready || isRunning(process.env.ORCH_READY_SERVICE || "cloudflared")) {
        const { acquired, term: t, blockedBy, ttlMs } = await tryAcquire({
          nodeId: identity.nodeId,
          host: identity.host,
          publicUrl: process.env.ORCH_PUBLIC_URL || "",
        });
        if (acquired) {
          isLeader = true;
          term = t;
          leaderSince = Date.now();
          handoffDone = false;
          await reg.setState("serving");
          await pushEvent("leader.acquired", { term, nodeId: identity.nodeId });
          log(`Now LEADER (term=${term}). Serving traffic.`);
          await logElectionSnapshot("leader-acquired", { self: identity.nodeId, term });
        } else if (blockedBy?.nodeId) {
          log(`Standby: leader still active (${describeLeader(blockedBy)} ttlMs=${ttlMs}). Waiting.`);
          await logElectionSnapshot("standby-blocked", { self: identity.nodeId, blockedBy: blockedBy.nodeId, ttlMs });
        } else {
          log("Standby: no leader acquired yet. Waiting.");
          await logElectionSnapshot("standby-no-leader", { self: identity.nodeId, ttlMs });
        }
      }
      await sleep(acquireInterval);
      continue;
    }

    // Leader: renew ghế.
    const { held, leader: currentLeader } = await renewLeadership({
      nodeId: identity.nodeId,
      publicUrl: process.env.ORCH_PUBLIC_URL || "",
    });
    if (!held) {
      warn(`Lost leadership. Current RTDB leader: ${describeLeader(currentLeader)}. Reverting to standby.`);
      await logElectionSnapshot("leader-lost", { self: identity.nodeId, replacedBy: currentLeader?.nodeId || null, previousTerm: term });
      isLeader = false;
      await reg.setState("ready");
      continue;
    }
    log(`Renewed leadership: ${describeLeader(currentLeader)}`);

    // [YC③] Có node kế nhiệm mới ready → tiến hành handoff để chuyền traffic.
    const overTime = Date.now() - leaderSince > maxLeaderMs;
    const successor = await findFreshSuccessor({ selfId: identity.nodeId });
    const handoffOnReady = config.handoff_on_successor_ready !== false;

    if (successor && (handoffOnReady || overTime || process.env.ORCH_FORCE_HANDOFF === "1") && !handoffDone) {
      handoffDone = true;
      log(`Handoff triggered → successor=${successor.id} (overTime=${overTime})`);
      await logElectionSnapshot("handoff-begin", { self: identity.nodeId, successor: successor.id, successorNode: successor.node, term, overTime });
      await reg.setState("draining");
      await pushEvent("handoff.begin", { successor: successor.id, term });

      // [YC②] chạy pipeline: upload dữ liệu, stop cloudflared (nhường tunnel)...
      try {
        await runHandoffPipeline({
          role: "leader",
          self: identity,
          successor: successor.id,
          term,
          leader: await getLeader(),
          config,
        });
      } catch (e) {
        error(`handoff pipeline error: ${e.message}`);
      }

      // Nhường ghế: node kế nhiệm sẽ tryAcquire() và thắng.
      log(`Releasing leadership for successor=${successor.id}. Current leader before release: ${describeLeader(await getLeader())}`);
      await logElectionSnapshot("handoff-before-release", { self: identity.nodeId, successor: successor.id, term });
      await releaseLeadership({ nodeId: identity.nodeId });
      await reg.setState("stopped");
      isLeader = false;
      log(`Handoff complete. Released term=${term}; successor=${successor.id} should acquire on next poll.`);
      await logElectionSnapshot("handoff-complete", { self: identity.nodeId, successor: successor.id, term });
      await pushEvent("handoff.complete", { successor: successor.id, term });
      // Sau khi nhường, container sidecar có thể tự thoát để job kết thúc gọn.
      if (process.env.ORCH_EXIT_AFTER_HANDOFF === "1") process.exit(0);
    }

    await sleep(renewInterval);
  }
}

main().catch((e) => {
  error(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
