// nodesync/scripts/lib/env.mjs
// Đọc cấu hình nodesync từ ENV + config.jsonc.
//
// QUY TẮC (theo yêu cầu + convention repo):
//   - Multi-user: SSH_<n>_USER / SSH_<n>_PASS / SSH_<n>_PUBLIC_KEY /
//     SSH_<n>_PRIVATE_KEY. Có thể tạo nhiều user theo index (1,2,3...).
//   - Secret (PASS, PRIVATE_KEY) có thể ở dạng base64 (mask theo `base64 -w0`).
//     Đặt SSH_<n>_PASS_B64=1 / SSH_<n>_PRIVATE_KEY_B64=1 để báo cần decode.
//     (PUBLIC_KEY thường để nguyên; nếu base64 thì SSH_<n>_PUBLIC_KEY_B64=1.)
//   - Kênh: SSH_CHANNEL_TAILSCALE_ENABLE / _CLOUDFLARE_ENABLE / _HYBRID_ENABLE.
//   - KHÔNG parse .env bằng regex thô — env đã có sẵn trong process.env (Compose
//     inject qua env_file). Chỉ match KEY theo pattern index (giống repo dùng
//     LITESTREAM_<n>_SERVICE trong start-stack.mjs).

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Giải mã base64 nếu cờ *_B64 bật; ngược lại trả nguyên văn.
function maybeB64(value, isB64) {
  if (value == null) return value;
  if (!isB64) return value;
  try {
    return Buffer.from(String(value).trim(), "base64").toString("utf8");
  } catch {
    return value;
  }
}

function truthy(v, def = "0") {
  const s = String(v ?? def).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

// Nạp config.jsonc (mặc định), cho phép override vài field bằng env.
export function loadConfig() {
  const file = resolve(__dirname, "..", "..", "config.jsonc");
  const defaults = {
    channel_priority: ["tailscale", "cloudflare", "hybrid"],
    sync_paths: [],
    rsync_options: ["-az", "--delete", "--checksum", "--safe-links", "--stats", "--human-readable"],
    ssh_connect_timeout_seconds: 10,
    sync_timeout_seconds: 600,
    diff_timeout_seconds: 120,
  };
  let cfg = defaults;
  if (existsSync(file)) {
    try {
      cfg = { ...defaults, ...parseJsonc(readFileSync(file, "utf8")) };
    } catch {
      cfg = defaults;
    }
  }
  // Override bằng env (nếu có).
  if (Object.hasOwn(process.env, "NODESYNC_SYNC_PATHS")) {
    cfg.sync_paths = process.env.NODESYNC_SYNC_PATHS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return cfg;
}

// Thư mục workspace mount (chứa dữ liệu cần sync + file cờ hold).
export function workspaceDir() {
  return process.env.SSH_WORKSPACE || process.env.ORCH_REPO_DIR || "/workspace";
}

// Nhặt danh sách user SSH_<n>_* (giải mã secret nếu cần).
export function collectSshUsers(env = process.env) {
  const idxs = new Set();
  for (const k of Object.keys(env)) {
    const m = k.match(/^SSH_(\d+)_USER$/);
    if (m) idxs.add(Number(m[1]));
  }
  const users = [];
  for (const idx of [...idxs].sort((a, b) => a - b)) {
    const p = (suffix) => env[`SSH_${idx}_${suffix}`];
    const user = p("USER");
    if (!user) continue;
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) {
      throw new Error(`SSH_${idx}_USER không hợp lệ: chỉ cho phép [a-z_][a-z0-9_-]{0,31}`);
    }
    const shell = p("SHELL") || "/bin/bash";
    const uid = p("UID") || null;
    if (!shell.startsWith("/") || shell.includes("..")) throw new Error(`SSH_${idx}_SHELL không hợp lệ`);
    if (uid != null && !/^\d+$/.test(uid)) throw new Error(`SSH_${idx}_UID phải là số`);
    users.push({
      index: idx,
      user,
      password: maybeB64(p("PASS") ?? p("PASSWORD"), truthy(p("PASS_B64") ?? p("PASSWORD_B64"))),
      publicKey: maybeB64(p("PUBLIC_KEY"), truthy(p("PUBLIC_KEY_B64"))),
      privateKey: maybeB64(p("PRIVATE_KEY"), truthy(p("PRIVATE_KEY_B64"))),
      // Quyền: mặc định privileged (sudo NOPASSWD, chạy mọi lệnh) theo yêu cầu.
      privileged: truthy(p("PRIVILEGED"), "1"),
      // Shell/uid đã validate ở trên.
      shell,
      uid,
    });
  }
  return users;
}

// Kênh nào được bật + thứ tự ưu tiên fallback.
export function enabledChannels(config = loadConfig(), env = process.env) {
  const flags = {
    tailscale: truthy(env.SSH_CHANNEL_TAILSCALE_ENABLE, "1"), // mặc định bật tailscale
    cloudflare: truthy(env.SSH_CHANNEL_CLOUDFLARE_ENABLE, "0"),
    hybrid: truthy(env.SSH_CHANNEL_HYBRID_ENABLE, "0"),
  };
  return (config.channel_priority || ["tailscale", "cloudflare", "hybrid"]).filter((c) => flags[c]);
}

// nodesync có được bật không (SSH_ENABLE=1).
export function nodesyncEnabled(env = process.env) {
  return truthy(env.SSH_ENABLE, "0");
}

export { truthy, maybeB64 };
