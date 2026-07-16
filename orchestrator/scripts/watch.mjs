// orchestrator/scripts/watch.mjs
// YÊU CẦU ②: Lắng nghe một path trên RTDB để biết có app nào đã khởi chạy
// thành công (state=ready/serving). Có thể chạy ĐỘC LẬP với main.mjs cho các
// nghiệp vụ "quan sát thuần" (observer) không tham gia election.
//
// Dùng khi bạn muốn 1 tiến trình chỉ react theo sự kiện node mới, mà không
// cần đóng vai leader — vd một máy chuyên "chạy nghiệp vụ phía sau".
//
// node watch.mjs                 # lắng nghe /nodes, log node mới ready
// node watch.mjs --run-pipeline  # khi phát hiện node mới ready → chạy pipeline

import { connectRtdb } from "./lib/rtdb.mjs";
import { heartbeatTtlMs, getNodeIdentity } from "./lib/node-identity.mjs";
import { runHandoffPipeline, loadConfig } from "./hooks/index.mjs";
import { log, error } from "./lib/log.mjs";

const RUN_PIPELINE = process.argv.includes("--run-pipeline");

function main() {
  const { db, paths } = connectRtdb();
  const self = getNodeIdentity();
  const ttl = heartbeatTtlMs();
  const config = loadConfig();
  const seen = new Map(); // nodeId -> last state (tránh trigger lặp)

  log(`Watching ${paths.nodes} for freshly READY apps... (run-pipeline=${RUN_PIPELINE})`);

  const ref = db.ref(paths.nodes);

  // child_changed + child_added: bắt mọi node đổi trạng thái.
  const handler = async (snap) => {
    const id = snap.key;
    const node = snap.val() || {};
    const prev = seen.get(id);
    seen.set(id, node.state);

    const fresh = Date.now() - (node.heartbeat || 0) <= ttl;
    const becameReady =
      ["ready", "serving"].includes(node.state) &&
      prev !== node.state &&
      fresh &&
      id !== self.nodeId;

    if (!becameReady) return;

    log(`Detected app READY: node=${id} host=${node.host} url=${node.publicUrl || "(n/a)"}`);

    if (RUN_PIPELINE) {
      try {
        await runHandoffPipeline({
          role: "observer",
          self,
          successor: id,
          predecessor: self.nodeId,
          term: node.term || 0,
          config,
        });
      } catch (e) {
        error(`pipeline on ready failed: ${e.message}`);
      }
    }
  };

  ref.on("child_added", handler);
  ref.on("child_changed", handler);

  log("watch.mjs running (Ctrl-C to stop)");
}

main();
