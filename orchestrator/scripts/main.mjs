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

import { connectRtdb, pushEvent, pushHandoffLog } from "./lib/rtdb.mjs";
import { getNodeIdentity, heartbeatTtlMs } from "./lib/node-identity.mjs";
import { startRegistration } from "./register.mjs";
import { tryAcquire, renewLeadership, releaseLeadership, getLeader, describeLeader } from "./elect.mjs";
import { runHandoffPipeline, loadConfig } from "./hooks/index.mjs";
import { isRunning } from "./lib/docker.mjs";
import { existsSync, readFileSync } from "node:fs";
import { log, warn, error } from "./lib/log.mjs";
import { monitorLeaderWhoami } from "./lib/leader-whoami-monitor.mjs";
import { cleanupOldLogs, cleanupIntervalMs, retentionDays } from "./lib/cleanup.mjs";

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

// [YC] "Runner sau lấy dữ liệu của leader về bằng rsync XONG mới giành leader."
// nodesync/sync.mjs ghi cờ ci-runtime/nodesync/sync-ok (mount vào /workspace).
// Orchestrator CHỈ được phép acquire leader khi cờ này = ok.
//   - status "ok"      → sync xong (hoặc first-runner/no-path) → cho acquire.
//   - status "failed"  → sync fail → KHÔNG acquire (chờ, để không cướp leader
//                        khi chưa có dữ liệu).
// Bật/tắt bằng ORCH_SYNC_GATE (mặc định: bật nếu SSH_SYNC_PATHS có giá trị).
function syncGateEnabled() {
  const explicit = process.env.ORCH_SYNC_GATE;
  if (explicit !== undefined) {
    const v = String(explicit).toLowerCase();
    return v === "1" || v === "true" || v === "yes";
  }
  // Auto: bật khi nodesync có path để sync.
  const paths = String(process.env.SSH_SYNC_PATHS || "").trim();
  const smoke = String(process.env.SSH_SYNC_SMOKE_ENABLE || "0").toLowerCase();
  return paths.length > 0 || smoke === "1" || smoke === "true" || smoke === "yes";
}

function readSyncGate() {
  const repo = process.env.ORCH_REPO_DIR || process.env.SSH_WORKSPACE || "/workspace";
  const file = `${repo.replace(/\/$/, "")}/ci-runtime/nodesync/sync-ok`;
  try {
    if (!existsSync(file)) return { present: false };
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return { present: true, ...raw };
  } catch (e) {
    return { present: false, error: e.message };
  }
}

// Đợi cờ sync-ok = "ok". Trả true nếu được phép acquire, false nếu hết giờ.
async function waitSyncGate({ timeoutSec = 900 } = {}) {
  if (!syncGateEnabled()) {
    log("Sync gate: disabled (ORCH_SYNC_GATE off / no SSH_SYNC_PATHS) → acquire tự do.");
    return true;
  }
  const deadline = Date.now() + timeoutSec * 1000;
  let lastLog = 0;
  while (Date.now() < deadline) {
    const gate = readSyncGate();
    if (gate.present && gate.status === "ok") {
      log(`Sync gate: OK (${gate.detail || "n/a"}) → được phép giành leader.`);
      return true;
    }
    if (gate.present && gate.status === "failed") {
      warn(`Sync gate: FAILED (${gate.detail || "n/a"}) → CHƯA giành leader (chờ dữ liệu / retry sync).`);
    } else if (Date.now() - lastLog > 15000) {
      log("Sync gate: đang chờ rsync predecessor xong (chưa có cờ sync-ok)...");
      lastLog = Date.now();
    }
    await sleep(3000);
  }
  warn(`Sync gate: hết giờ sau ${timeoutSec}s mà chưa "ok".`);
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
    .filter(([, n]) => n.state === "ready")
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

// Diễn giải tiếng Việt cho từng label election-snapshot (yêu cầu Phần 1 #1).
// Format log: "Election snapshot: <label> (<diễn giải tiếng Việt>)".
const SNAPSHOT_VI = {
  "stack-ready":
    "stack cục bộ đã sẵn sàng (cloudflared running), node vào vòng election",
  "leader-acquired":
    "node này VỪA GIÀNH được ghế leader, bắt đầu phục vụ traffic",
  "standby-blocked":
    "đang chờ — leader hiện tại còn sống, chưa tới lượt tiếp quản",
  "standby-no-leader":
    "chưa có leader nào; node đang thử giành ghế ở vòng kế tiếp",
  "leader-lost":
    "node này ĐÃ MẤT ghế leader (bị node khác tiếp quản/term đổi), quay về standby",
  "handoff-begin":
    "BẮT ĐẦU chuyển giao: đã có node kế nhiệm sẵn sàng, leader vào trạng thái draining",
  "handoff-before-release":
    "sắp NHẢ ghế cho node kế nhiệm sau khi chạy xong pipeline handoff",
  "handoff-complete":
    "HOÀN TẤT chuyển giao: đã nhả ghế, node kế nhiệm sẽ giành leader ở vòng poll kế tiếp",
  "signal-before-release":
    "nhận tín hiệu tắt (SIGTERM/SIGINT) khi đang là leader → chuẩn bị nhả ghế",
  "signal-after-release":
    "đã nhả ghế xong sau tín hiệu tắt, đánh dấu node stopped",
  "signal-standby-stop":
    "node standby nhận tín hiệu tắt → dừng, không cần nhả ghế",
};

function describeSnapshotVi(label) {
  return SNAPSHOT_VI[label] || "trạng thái election (chưa có diễn giải riêng)";
}

function describeHandoffStep(step) {
  if (typeof step === "string") return step;
  if (step?.name) return step.name;
  if (step?.shell) return step.name || "shell";
  return "unknown";
}

async function logElectionSnapshot(label, extra = {}) {
  try {
    log(`Election snapshot: ${label} (${describeSnapshotVi(label)})`, { ...extra, ...(await getElectionSnapshot()) });
  } catch (e) {
    warn(`Election snapshot failed (${label}): ${e.message}`);
  }
}

async function runCleanup(reason) {
  try {
    const result = await cleanupOldLogs();
    log(`Cleanup ${reason}: deleted=${result.deleted} scanned=${result.scanned}`);
  } catch (e) {
    warn(`cleanup ${reason} failed: ${e.message}`);
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

  // [YC cleanup] Xoá log cũ trong RTDB (events/handoff-log/nodes đã chết).
  // Chạy ngay sau khi sidecar sẵn sàng + định kỳ mỗi ORCH_CLEANUP_INTERVAL_SECONDS.
  const retention = retentionDays();
  log(`Log retention: ${retention > 0 ? `${retention} ngày` : "tắt (ORCH_LOG_RETENTION_DAYS=0)"}`);
  if (retention > 0) {
    const cleanupTimer = setInterval(() => {
      runCleanup("periodic");
    }, cleanupIntervalMs());
    cleanupTimer.unref?.();
  }

  // Bước 2: chờ stack local ready.
  const ready = await waitStackReady({ timeoutSec: num("ORCH_READY_TIMEOUT_SECONDS", 180) });
  if (!ready) {
    warn("stack not ready within timeout — continuing but will not claim leadership yet");
  } else {
    await reg.setState("ready", { publicUrl: process.env.ORCH_PUBLIC_URL || "" });
    // Sau khi stack ready, tailnet IP thường đã có → cập nhật lại thông tin tailscale.
    await reg.refreshTailscale();
    const leader = await getLeader();
    log(`Stack ready. Current RTDB leader: ${describeLeader(leader)}`);
    if (retention > 0) await runCleanup("after stack ready");
    await logElectionSnapshot("stack-ready", { self: identity.nodeId });
  }

  const acquireInterval = num("ORCH_ACQUIRE_INTERVAL_SECONDS", config.acquire_interval_seconds || 5) * 1000;
  const renewInterval = num("ORCH_RENEW_INTERVAL_SECONDS", config.poll_interval_seconds || 10) * 1000;

  // [YC] GATE: chỉ cho phép giành leader SAU khi rsync predecessor xong.
  // Đợi một lần trước khi vào vòng election. Nếu gate fail/hết giờ → không
  // acquire (node vẫn heartbeat/standby, có thể retry sync ở lớp ngoài).
  let syncGateOk = await waitSyncGate({ timeoutSec: num("ORCH_SYNC_GATE_TIMEOUT_SECONDS", 900) });
  if (!syncGateOk) {
    warn("Sync gate chưa OK → node ở STANDBY, KHÔNG giành leader cho tới khi sync xong.");
  }

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
      // Nếu gate chưa OK, thử refresh cờ mỗi vòng (sync có thể vừa xong).
      if (!syncGateOk) {
        const gate = readSyncGate();
        if (gate.present && gate.status === "ok") {
          syncGateOk = true;
          log(`Sync gate: chuyển sang OK (${gate.detail || "n/a"}) → mở khoá election.`);
        }
      }
      // Standby: cố giành ghế (chỉ giành khi chưa có leader / leader chết)
      // VÀ sync gate đã OK (rsync predecessor xong).
      if (syncGateOk && (ready || isRunning(process.env.ORCH_READY_SERVICE || "cloudflared"))) {
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
          // Nếu trước đó có leader khác (blockedBy.nodeId) → đây là lần đổi
          // leader thật sự → ghi 1 record handoff-log (reason=leader-stale).
          if (blockedBy?.nodeId && blockedBy.nodeId !== identity.nodeId) {
            await pushHandoffLog({
              oldLeader: { nodeId: blockedBy.nodeId, host: blockedBy.host || null, term: blockedBy.term ?? null },
              newLeader: { nodeId: identity.nodeId, host: identity.host, term: t },
              oldLeaderTasks: [], // leader cũ đã chết, không chạy pipeline
              reason: "leader-stale",
              term: t,
            });
          }
          const whoamiUrl = process.env.ORCH_PUBLIC_URL || process.env.WHOAMI_HOST || (process.env.DOMAIN ? `https://whoami.${process.env.DOMAIN}` : "");
          monitorLeaderWhoami({ getLeader, selfId: identity.nodeId, url: whoamiUrl, log, warn }).catch((e) => warn(`[leader-whoami] monitor error: ${e.message}`));
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

      // Snapshot leader cũ TRƯỚC khi nhường ghế (để ghi vào record handoff-log).
      const oldLeaderSnapshot = await getLeader();
      const oldLeaderNextActions = (config.handoff_pipeline || []).map(describeHandoffStep);

      // [YC②] chạy pipeline: upload dữ liệu, stop cloudflared (nhường tunnel)...
      let pipelineResults = [];
      try {
        pipelineResults = await runHandoffPipeline({
          role: "leader",
          self: identity,
          successor: successor.id,
          term,
          leader: oldLeaderSnapshot,
          config,
        });
      } catch (e) {
        error(`handoff pipeline critical error: ${e.message}; HỦY handoff, giữ leadership`);
        await pushEvent("handoff.aborted", { successor: successor.id, term, error: e.message });
        await reg.setState("serving");
        handoffDone = false;
        await sleep(renewInterval);
        continue;
      }

      // Chỉ nhường ghế khi pipeline không có critical failure.
      log(`Releasing leadership for successor=${successor.id}. Current leader before release: ${describeLeader(await getLeader())}`);
      await logElectionSnapshot("handoff-before-release", { self: identity.nodeId, successor: successor.id, term });
      await releaseLeadership({ nodeId: identity.nodeId });
      await reg.setState("stopped");
      isLeader = false;

      // Ghi 1 record handoff-log: leader đã đổi (old → new sẽ lấy sau khi
      // successor acquire ở vòng poll kế tiếp). Ta dùng successor làm "newLeader"
      // dự kiến; nếu muốn chính xác, có thể cập nhật sau khi successor thực sự
      // lên. Nhưng vì đã release → successor chắc chắn sẽ acquire → dùng ngay.
      const oldLeaderTasks = pipelineResults.map((r) => ({
        hook: r.hook,
        ok: r.ok,
        error: r.error || undefined,
      }));
      await pushHandoffLog({
        oldLeader: { nodeId: identity.nodeId, host: identity.host, term },
        newLeader: { nodeId: successor.id, host: successor.node?.host || null, term: term + 1 },
        oldLeaderNextActions,
        oldLeaderTasks,
        reason: "handoff",
        term: term + 1,
      });
      await pushEvent("handoff.complete", { successor: successor.id, term });
      log(`Handoff complete. Released term=${term}; successor=${successor.id} should acquire on next poll.`);
      await logElectionSnapshot("handoff-complete", { self: identity.nodeId, successor: successor.id, term });
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
