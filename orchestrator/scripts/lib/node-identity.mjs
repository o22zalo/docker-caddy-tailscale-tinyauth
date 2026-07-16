// orchestrator/scripts/lib/node-identity.mjs
// Gom "danh tính" của node hiện tại từ ENV — phục vụ YÊU CẦU ①:
// ghi ngày giờ, máy chạy, và mọi thông tin cấu hình lấy từ env lên RTDB.
//
// Node ID ưu tiên (ổn định trong 1 lần chạy CI):
//   ORCH_NODE_ID  > GITHUB_RUN_ID/attempt > BUILD_BUILDID/attempt > hostname+pid
//
// Mọi biến env dạng ORCH_META_<KEY> sẽ tự động được nhặt vào node.meta.<key>
// => "có thể cấu hình các thông tin cần thiết vào đây" mà không cần sửa code.

import { hostname } from "node:os";
import { execSync } from "node:child_process";

function safeHostname() {
  try {
    return hostname();
  } catch {
    return "unknown-host";
  }
}

function shortCommit() {
  const sha = process.env.GITHUB_SHA || process.env.BUILD_SOURCEVERSION || "";
  if (sha) return sha.slice(0, 8);
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["pipe", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

// Phát hiện CI provider + gom thông tin runner.
function detectCi() {
  if (process.env.GITHUB_ACTIONS === "true") {
    return {
      provider: "github",
      runId: process.env.GITHUB_RUN_ID || "",
      attempt: process.env.GITHUB_RUN_ATTEMPT || "1",
      workflow: process.env.GITHUB_WORKFLOW || "",
      job: process.env.GITHUB_JOB || "",
      runner: process.env.RUNNER_NAME || process.env.RUNNER_TRACKING_ID || "",
      ref: process.env.GITHUB_REF || "",
      repo: process.env.GITHUB_REPOSITORY || "",
    };
  }
  if (process.env.TF_BUILD === "True" || process.env.BUILD_BUILDID) {
    return {
      provider: "azure",
      runId: process.env.BUILD_BUILDID || "",
      attempt: process.env.SYSTEM_JOBATTEMPT || "1",
      workflow: process.env.BUILD_DEFINITIONNAME || "",
      job: process.env.SYSTEM_JOBDISPLAYNAME || "",
      runner: process.env.AGENT_NAME || "",
      ref: process.env.BUILD_SOURCEBRANCH || "",
      repo: process.env.BUILD_REPOSITORY_NAME || "",
    };
  }
  return { provider: "local", runId: "", attempt: "1", runner: safeHostname() };
}

function makeNodeId(ci) {
  if (process.env.ORCH_NODE_ID) return process.env.ORCH_NODE_ID;
  if (ci.runId) {
    const id = `${ci.provider}-${ci.runId}-${ci.attempt}`;
    process.env.ORCH_NODE_ID = id;
    return id;
  }
  const id = `${ci.provider}-${safeHostname()}-${process.pid}`;
  process.env.ORCH_NODE_ID = id;
  return id;
}

// Nhặt mọi ORCH_META_* thành object meta (lowercase key).
function collectMeta() {
  const meta = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("ORCH_META_")) {
      const key = k.slice("ORCH_META_".length).toLowerCase();
      meta[key] = v;
    }
  }
  return meta;
}

// TTL heartbeat: sau bao lâu không cập nhật thì coi node là chết.
export function heartbeatTtlMs() {
  const s = Number(process.env.ORCH_HEARTBEAT_TTL_SECONDS || 90);
  return (Number.isFinite(s) && s > 0 ? s : 90) * 1000;
}

export function getNodeIdentity() {
  const ci = detectCi();
  const nodeId = makeNodeId(ci);
  return {
    nodeId,
    host: safeHostname(),
    commit: shortCommit(),
    ci,
    // publicUrl có thể chưa biết lúc register lần đầu; cập nhật sau khi có tunnel.
    publicUrl: process.env.ORCH_PUBLIC_URL || "",
    domain: process.env.DOMAIN || "",
    profiles: process.env.COMPOSE_PROFILES || "",
    meta: collectMeta(),
  };
}
