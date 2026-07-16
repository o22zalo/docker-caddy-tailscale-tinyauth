#!/usr/bin/env node
// nodesync/scripts/sync.mjs
// node02: sau remote restore, thử Tailscale → Cloudflare → Hybrid bằng SSH
// probe thật; diff, bật hold, rsync và luôn release hold trong finally.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  loadConfig, workspaceDir, enabledChannels, peerConfig,
  nodesyncEnabled, collectSshUsers,
} from "./lib/env.mjs";
import { resolveChannel, sshBaseArgs, sshCommand } from "./lib/ssh.mjs";
import { log, warn, error, stepTimer } from "./lib/log.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LOCAL_DEMO = args.includes("--local-demo");
const cfg = loadConfig();
const WS = workspaceDir();

function validRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.split(/[\\/]+/).includes("..")
    && !value.includes("\0");
}
function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }
function exec(cmd, argv, { timeout = 60000, env } = {}) {
  if (DRY_RUN) { log(`[DRY RUN] ${cmd} ${argv.join(" ")}`); return { ok: true, out: "", err: "", status: 0 }; }
  const res = spawnSync(cmd, argv, {
    encoding: "utf8", timeout, env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    out: (res.stdout || "").trim(), err: (res.stderr || res.error?.message || "").trim(), status: res.status,
  };
}

function fingerprintCommand(root, pathRel) {
  // Trigger hash: type/path/mode/size + content + symlink target. Không đưa mtime
  // vào hash để tránh sync lặp do filesystem khác độ phân giải timestamp.
  return `cd ${shellQuote(root)} && test -d ${shellQuote(pathRel)} && { find ${shellQuote(pathRel)} -printf 'META %y %p %m %s\\n'; find ${shellQuote(pathRel)} -type f -exec sha256sum {} +; find ${shellQuote(pathRel)} -type l -printf 'LINK %p -> %l\\n'; } 2>/dev/null | sort | sha256sum | cut -d' ' -f1`;
}
function localFingerprint(pathRel) {
  const abs = resolve(WS, pathRel);
  if (!existsSync(abs)) return { path: pathRel, fingerprint: "MISSING" };
  const r = exec("sh", ["-lc", fingerprintCommand(WS, pathRel)]);
  return { path: pathRel, fingerprint: r.ok ? r.out : "ERR", err: r.err };
}
function remoteFingerprint(connection, pathRel) {
  const baseCommand = fingerprintCommand(cfg.remote_workspace || WS, pathRel);
  const command = connection.auth.privileged ? `sudo -n sh -lc ${shellQuote(baseCommand)}` : baseCommand;
  const r = DRY_RUN
    ? { ok: true, out: "DRY_RUN", err: "" }
    : sshCommand(connection.auth, connection.sshArgs, connection.target, command, cfg.diff_timeout_seconds * 1000);
  return { path: pathRel, fingerprint: r.ok ? r.out : "ERR", err: r.err };
}
function remoteHold(connection, onoff) {
  const root = cfg.remote_workspace || WS;
  const baseCommand = `cd ${shellQuote(root)} && node nodesync/scripts/hold-requests.mjs ${onoff} --silent`;
  const command = connection.auth.privileged ? `sudo -n sh -lc ${shellQuote(baseCommand)}` : baseCommand;
  const r = DRY_RUN
    ? { ok: true, err: "" }
    : sshCommand(connection.auth, connection.sshArgs, connection.target, command, 30000);
  if (r.ok) log(`node01 hold → ${onoff.toUpperCase()} (OK)`);
  else warn(`node01 hold → ${onoff.toUpperCase()} thất bại: ${r.err}`);
  return r.ok;
}
function rsyncPull(connection, pathRel) {
  const timer = stepTimer(`rsync path "${pathRel}" từ node01`);
  const sourceRoot = (cfg.remote_workspace || WS).replace(/\/$/, "");
  const source = `${connection.target}:${sourceRoot}/${pathRel}/`;
  const destination = `${resolve(WS, pathRel)}/`;
  const sshParts = connection.auth.password
    ? ["sshpass", "-e", "ssh", ...connection.sshArgs]
    : ["ssh", ...connection.sshArgs];
  const rsh = sshParts.map(shellQuote).join(" ");
  if (!DRY_RUN) spawnSync("mkdir", ["-p", destination]);
  const privilegedRsync = connection.auth.privileged ? ["--rsync-path=sudo -n rsync"] : [];
  const r = exec("rsync", [...cfg.rsync_options, ...privilegedRsync, "-e", rsh, source, destination], {
    timeout: cfg.sync_timeout_seconds * 1000,
    env: connection.auth.password ? { SSHPASS: connection.auth.password } : undefined,
  });
  if (!r.ok) { timer.fail(r.err || `exit ${r.status}`); return { path: pathRel, ok: false, err: r.err }; }
  const stats = r.out.split(/\r?\n/).filter((line) => /Number of|Total|transferred|size/i.test(line)).slice(0, 6);
  timer.end(`(${stats.join(" | ") || "no-stats"})`);
  return { path: pathRel, ok: true, stats };
}

function authForPeer(peer) {
  const users = collectSshUsers();
  const configured = users.find((u) => u.user === peer.user) || users[0];
  if (!peer.user && configured) peer.user = configured.user;
  const identityFile = configured?.privateKey ? `/home/${configured.user}/.ssh/id_ed25519` : undefined;
  return { password: configured?.password || "", identityFile, privileged: configured?.privileged === true };
}

function connectWithFallback(channels, peer, auth) {
  const attempts = [];
  for (const channel of channels) {
    const resolved = resolveChannel(channel, peer);
    if (!resolved.host) {
      attempts.push({ channel, stage: "resolve", reason: resolved.reason });
      warn(`Kênh "${channel}" resolve thất bại → fallback: ${resolved.reason}`);
      continue;
    }
    const sshArgs = sshBaseArgs(resolved, {
      port: peer.port,
      connectTimeout: cfg.ssh_connect_timeout_seconds,
      identityFile: auth.identityFile,
      batchMode: !auth.password,
    });
    const target = `${peer.user}@${resolved.host}`;
    if (DRY_RUN) return { resolved, sshArgs, target, auth, attempts };
    const probe = sshCommand(auth, sshArgs, target, "printf NODESYNC_SSH_OK", cfg.ssh_connect_timeout_seconds * 1000 + 5000);
    if (probe.ok && probe.out === "NODESYNC_SSH_OK") {
      log(`SSH probe OK qua kênh "${channel}" → ${target}`);
      return { resolved, sshArgs, target, auth, attempts };
    }
    attempts.push({ channel, stage: "ssh", reason: probe.err || `output=${probe.out}` });
    warn(`Kênh "${channel}" resolve được nhưng SSH thất bại → fallback: ${probe.err || probe.out || "unknown"}`);
  }
  return { connection: null, attempts };
}

async function main() {
  log("=== NODESYNC: bắt đầu đồng bộ node02 ← node01 ===");
  if (!nodesyncEnabled()) { log("SSH_ENABLE != 1 → bỏ qua sync."); return; }
  if (!cfg.sync_paths.every(validRelativePath)) throw new Error(`sync_paths không an toàn: ${cfg.sync_paths.join(", ")}`);
  log(`workspace=${WS} sync_paths=[${cfg.sync_paths.join(", ")}]`);

  if (LOCAL_DEMO) {
    for (const path of cfg.sync_paths) log(`fingerprint(${path})=${localFingerprint(path).fingerprint}`);
    return;
  }

  const peer = peerConfig();
  const auth = authForPeer(peer);
  if (!peer.user) throw new Error("Thiếu NODESYNC_PEER_USER và không có SSH_<n>_USER");
  const channels = enabledChannels(cfg);
  if (channels.length === 0) throw new Error("Không có SSH channel nào được enable");
  log(`Kênh fallback: [${channels.join(" → ")}]; peer.user=${peer.user}`);

  const candidate = connectWithFallback(channels, peer, auth);
  const connection = candidate.connection === null ? null : candidate;
  if (!connection?.target) {
    for (const attempt of candidate.attempts || []) error(`  - ${attempt.channel}/${attempt.stage}: ${attempt.reason}`);
    throw new Error("Không kết nối SSH được tới node01 qua bất kỳ kênh nào");
  }

  const diffTimer = stepTimer("DIFF dữ liệu với node01 (checksum)");
  const diffs = cfg.sync_paths.map((path) => {
    const local = localFingerprint(path);
    const remote = remoteFingerprint(connection, path);
    if (remote.fingerprint === "ERR") throw new Error(`Không fingerprint được remote path ${path}: ${remote.err}`);
    const differ = local.fingerprint !== remote.fingerprint;
    log(`  ${path}: local=${local.fingerprint.slice(0, 12)} remote=${remote.fingerprint.slice(0, 12)} → ${differ ? "KHÁC" : "GIỐNG"}`);
    return { path, differ };
  });
  diffTimer.end();
  const toSync = diffs.filter((item) => item.differ).map((item) => item.path);
  if (toSync.length === 0) { log("Dữ liệu đã giống nhau; không cần sync."); return; }

  let holdEnabled = false;
  const results = [];
  try {
    holdEnabled = remoteHold(connection, "on");
    if (!holdEnabled) throw new Error("Không bật được hold trên node01; từ chối sync để tránh request chạy trên dữ liệu đang thay đổi");
    for (const path of toSync) {
      const result = rsyncPull(connection, path);
      results.push(result);
      if (!result.ok) throw new Error(`rsync ${path} thất bại: ${result.err}`);
    }
  } finally {
    if (holdEnabled && !remoteHold(connection, "off")) {
      error("CẢNH BÁO NGHIÊM TRỌNG: sync xong nhưng không release được hold trên node01");
    }
  }

  log("=== BÁO CÁO SYNC ===");
  results.forEach((result) => log(`  ✔ ${result.path}`));
  log("Kết quả: TẤT CẢ OK ✅. App sẵn sàng start.");
}

main().catch((e) => { error(`sync fatal: ${e.stack || e.message}`); process.exit(1); });
