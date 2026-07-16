// orchestrator/scripts/status.mjs
// Xem nhanh trạng thái consul: leader hiện tại + danh sách node + tươi/chết.
// node status.mjs

import { connectRtdb } from "./lib/rtdb.mjs";
import { heartbeatTtlMs } from "./lib/node-identity.mjs";
import { log } from "./lib/log.mjs";

async function main() {
  const { db, paths, stack } = connectRtdb();
  const ttl = heartbeatTtlMs();
  const now = Date.now();

  const leaderSnap = await db.ref(paths.leader).get();
  const nodesSnap = await db.ref(paths.nodes).get();
  const leader = leaderSnap.val();
  const nodes = nodesSnap.val() || {};

  console.log(`\n=== Orchestrator status: stack="${stack}" ===`);
  if (leader) {
    const age = Math.round((now - (leader.heartbeat || 0)) / 1000);
    console.log(`LEADER: ${leader.nodeId}  term=${leader.term}  hb=${age}s ago  url=${leader.publicUrl || "-"}`);
  } else {
    console.log("LEADER: (none)");
  }

  console.log(`\nNODES (${Object.keys(nodes).length}):`);
  for (const [id, n] of Object.entries(nodes)) {
    const age = Math.round((now - (n.heartbeat || 0)) / 1000);
    const alive = now - (n.heartbeat || 0) <= ttl ? "alive" : "DEAD ";
    console.log(
      `  [${alive}] ${id}  state=${(n.state || "?").padEnd(8)} host=${n.host || "-"} runner=${n.ci?.runner || "-"} hb=${age}s url=${n.publicUrl || "-"}`,
    );
  }
  console.log("");
  process.exit(0);
}

main().catch((e) => {
  log(`status failed: ${e.message}`);
  process.exit(1);
});
