// orchestrator/scripts/elect.mjs
// Leader election qua RTDB transaction (consul-style).
//
// /leader = { nodeId, term, host, publicUrl, heartbeat, acquiredAt }
//
// Quy tắc:
//   - Node chỉ giành leader khi CHƯA có leader, HOẶC leader cũ đã "hết hạn"
//     (heartbeat quá TTL) → term++ (fencing token, tránh split-brain).
//   - Leader giữ ghế bằng renewLeadership() (đập heartbeat lên /leader).
//   - Standby gọi tryAcquire() theo chu kỳ; khi leader cũ chết sẽ tiếp quản.

import { connectRtdb, ServerValue } from "./lib/rtdb.mjs";
import { heartbeatTtlMs } from "./lib/node-identity.mjs";
import { log } from "./lib/log.mjs";

function now() {
  return Date.now();
}

function valueOrNull(value) {
  return value === undefined || value === "" ? null : value;
}

// Thử giành quyền leader. Trả { acquired, term, leader }.
export async function tryAcquire({ nodeId, host, publicUrl }) {
  const { db, paths } = connectRtdb();
  const ttl = heartbeatTtlMs();
  const ref = db.ref(paths.leader);

  const result = await ref.transaction((current) => {
    const t = now();
    if (!current || !current.nodeId) {
      // Chưa có leader → giành ngay, term = 1.
      return {
        nodeId,
        term: 1,
        host: valueOrNull(host),
        publicUrl: valueOrNull(publicUrl),
        acquiredAt: t,
        heartbeat: t,
      };
    }
    if (current.nodeId === nodeId) {
      // Mình đang là leader → renew.
      return { ...current, heartbeat: t, publicUrl: valueOrNull(publicUrl || current.publicUrl) };
    }
    const stale = t - (current.heartbeat || 0) > ttl;
    if (stale) {
      // Leader cũ chết → tiếp quản, tăng term (fencing).
      return {
        nodeId,
        term: (current.term || 0) + 1,
        host: valueOrNull(host),
        publicUrl: valueOrNull(publicUrl),
        acquiredAt: t,
        heartbeat: t,
      };
    }
    // Leader còn sống → abort transaction (giữ nguyên).
    return; // undefined => abort
  });

  const snap = result.snapshot.val();
  const acquired = result.committed && snap && snap.nodeId === nodeId;
  if (acquired) log(`Acquired leadership: term=${snap.term} node=${nodeId}`);
  return { acquired, term: snap?.term, leader: snap };
}

// Leader renew heartbeat trên /leader (kèm publicUrl mới nếu có).
export async function renewLeadership({ nodeId, publicUrl }) {
  const { db, paths } = connectRtdb();
  const ref = db.ref(paths.leader);
  const snap = await ref.get();
  const current = snap.val();
  if (!current || current.nodeId !== nodeId) return false;
  await ref.update({
    heartbeat: now(),
    publicUrl: valueOrNull(publicUrl || current.publicUrl),
  });
  return true;
}

// Chủ động nhường ghế (dùng trong graceful handoff).
export async function releaseLeadership({ nodeId }) {
  const { db, paths } = connectRtdb();
  const ref = db.ref(paths.leader);
  await ref.transaction((current) => {
    if (!current || current.nodeId !== nodeId) return;
    // Đặt heartbeat=0 để node kế tiếp thấy "stale" và tiếp quản ngay.
    return { ...current, heartbeat: 0, releasedAt: now() };
  });
  log(`Released leadership: node=${nodeId}`);
}

export async function getLeader() {
  const { db, paths } = connectRtdb();
  const snap = await db.ref(paths.leader).get();
  return snap.val();
}
