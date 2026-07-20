#!/usr/bin/env node
// scripts/up.mjs
// Start compose project according to COMPOSE_PROFILES in .env, with fallback
// profiles auto-added for configured optional services.
//
// Usage:
//   node scripts/up.mjs                       # uses COMPOSE_PROFILES from .env
//   node scripts/up.mjs ci                    # CI / quick-tunnel mode
//   node scripts/up.mjs full                  # force COMPOSE_PROFILES=full
//   node scripts/up.mjs core                  # force core
//   node scripts/up.mjs caddy whoami          # force specific profiles
//
// Flags:
//   --dry-run   Show commands without running
//   --silent    Suppress output
import { execSync, execFileSync, spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectDocker } from "./runners/_docker.mjs";
import { envGet } from "./lib/env-utils.mjs";
import {
  hasLitestreamConfig as libHasLitestream,
  hasRcloneConfig as libHasRclone,
  nodesyncConfig as libNodesyncConfig,
  firstIndexedName as libFirstIndexedName,
  uniqueTsHostname,
  sanitizeTsExtraArgs,
  readPredecessor,
  waitForHealthy as libWaitForHealthy,
  waitForTailscale as libWaitForTailscale,
  waitForServiceRunning,
  probePredecessorSocks,
} from "./lib/stack-lib.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => {
  if (!SILENT) console.log(...a);
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ENV = resolve(ROOT, ".env");
process.chdir(ROOT);

const docker = DRY_RUN ? { available: true, cmd: "docker", via: "dry-run" } : detectDocker();
if (!docker.available) {
  console.error("ERROR: Docker daemon unavailable. Start Docker or use --dry-run.");
  process.exit(1);
}
const dc = (parts) => `${docker.cmd} ${parts}`;

function run(cmd) {
  if (DRY_RUN) {
    log(`[DRY RUN] ${cmd}`);
    return;
  }
  execSync(cmd, { stdio: SILENT ? "ignore" : "inherit", cwd: ROOT });
}

function runPrefixed(name, cmd) {
  if (DRY_RUN) {
    log(`[DRY RUN] ${cmd}`);
    return Promise.resolve();
  }
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(cmd, { cwd: ROOT, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const write = (stream, data) => {
      if (SILENT) return;
      for (const line of data.toString().split(/\r?\n/).filter(Boolean)) stream.write(`[${name}] ${line}\n`);
    };
    proc.stdout.on("data", (data) => write(process.stdout, data));
    proc.stderr.on("data", (data) => write(process.stderr, data));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`${name} failed with exit code ${code}`))));
  });
}

function hasLitestreamConfig() {
  return libHasLitestream(ENV);
}

function hasRcloneConfig() {
  return libHasRclone(ENV);
}

function nodesyncConfig() {
  return libNodesyncConfig(ENV);
}

function firstIndexedName(prefix, key) {
  return libFirstIndexedName(ENV, prefix, key);
}

function ensureProfile(name) {
  const current = process.env.COMPOSE_PROFILES || envGet(ENV, "COMPOSE_PROFILES") || "";
  if (current.split(/[,\s]+/).includes(name)) return;
  process.env.COMPOSE_PROFILES = current ? `${current},${name}` : name;
  log(`Ensuring ${name} profile is enabled`);
}

function resolveVolumeRoot(value, fallback) {
  return resolve(ROOT, value || fallback);
}
function compose(command) {
  const files = mode === "ci" ? "-f docker-compose.yml -f docker-compose.ci.yml " : "";
  return dc(`compose ${files}${command}`);
}
// deps chung cho stack-lib (up.mjs không có sh() sẵn — định nghĩa tại chỗ).
function sh(cmd) {
  if (DRY_RUN) return "";
  return execSync(cmd, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
}
const runCapture = (cmd, argv, timeoutMs = 15000) => {
  try {
    const out = execFileSync(cmd, argv, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs }).toString().trim();
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: (e.stderr || e.message || "").toString() };
  }
};
const libDeps = { sh, dc, log, err: (...a) => log(...a), dryRun: DRY_RUN, runCapture };
async function waitNodesync(timeoutMs = 90_000) {
  return libWaitForHealthy("nodesync", libDeps, timeoutMs);
}
async function waitTailscaleOnline(timeoutMs = 60_000) {
  return libWaitForTailscale(libDeps, timeoutMs);
}

// Validate .env
if (!existsSync(".env")) {
  console.error("Missing .env — copy .env.example and fill secrets:");
  console.error("  cp .env.example .env");
  process.exit(1);
}

// Demo password warning
const demoHash = "$$2a$$10$$UdLYoJ5lgPsC0RKqYH/jMua7zIn0g9kPqWmhYayJYLaZQ/FTmH2/u";
if (existsSync(".env") && readFileSync(".env", "utf8").includes(demoHash)) {
  log("WARNING: TINYAUTH_AUTH_USERS uses the demo password (user:password).");
  log("         Change it before production! node tinyauth/scripts/generate-user.mjs");
}

// Parse args
const nonFlagArgs = args.filter((a) => !a.startsWith("--"));
let mode = "prod";
if (nonFlagArgs[0] === "ci") {
  mode = "ci";
  nonFlagArgs.shift();
}

// Set COMPOSE_PROFILES
if (nonFlagArgs.length > 0) {
  process.env.COMPOSE_PROFILES = nonFlagArgs.join(" ");
  log(`Forcing COMPOSE_PROFILES=${process.env.COMPOSE_PROFILES}`);
} else {
  const current = envGet(ENV, "COMPOSE_PROFILES");
  if (current) {
    log(`Using COMPOSE_PROFILES from .env: ${current}`);
  } else {
    log("WARN: COMPOSE_PROFILES not set in .env — no profiled services will start.");
    log("      Set e.g. COMPOSE_PROFILES=core  (see .env.example)");
  }
}

// Auto-add tailscale if TS_AUTHKEY present
if (envGet(ENV, "TS_AUTHKEY")) {
  const current = process.env.COMPOSE_PROFILES || envGet(ENV, "COMPOSE_PROFILES") || "";
  if (!current.includes("full") && !current.includes("tailscale")) {
    ensureProfile("tailscale");
  }
}

if (hasLitestreamConfig()) {
  ensureProfile("litestream");
  process.env.LITESTREAM_CONTAINER_NAME = firstIndexedName("LITESTREAM", "SERVICE");
}
if (hasRcloneConfig()) {
  ensureProfile("rclone");
  process.env.RCLONE_CONTAINER_NAME = firstIndexedName("RCLONE", "NAME");
}
const nodesync = nodesyncConfig();
if (nodesync.enabled) {
  ensureProfile("nodesync");
  if (nodesync.tailscaleChannel) ensureProfile("tailscale");
}
// [YC] Hostname Tailscale DUY NHẤT theo runner — dùng helper chung từ stack-lib.
if (nodesync.enabled && nodesync.tailscaleChannel) {
  process.env.TS_HOSTNAME = uniqueTsHostname(envGet(ENV, "TS_HOSTNAME") || "proxy-stack");
  const baseExtra = process.env.TS_EXTRA_ARGS || envGet(ENV, "TS_EXTRA_ARGS") || "--accept-dns=false";
  process.env.TS_EXTRA_ARGS = sanitizeTsExtraArgs(baseExtra);
  log(`Tailscale transport identity: hostname=${process.env.TS_HOSTNAME} extraArgs="${process.env.TS_EXTRA_ARGS}"`);
}
process.env.DOCKER_VOLUME_RUNTIME_ABS = resolveVolumeRoot(envGet(ENV, "DOCKER_VOLUME_RUNTIME"), "ci-runtime");
process.env.DOCKER_VOLUME_DATA_ABS = resolveVolumeRoot(envGet(ENV, "DOCKER_VOLUME_DATA"), "ci-data");

// Start stack
run(`node litestream/scripts/generate-config.mjs${SILENT ? " --silent" : ""}`);
await Promise.all([
  runPrefixed("litestream", `node litestream/scripts/restore.mjs${SILENT ? " --silent" : ""}`),
  runPrefixed("rclone", `node rclone/scripts/pull.mjs${SILENT ? " --silent" : ""}`),
]);
if (nodesync.enabled && nodesync.paths.length) {
  // Discovery bắt buộc orchestrator (RTDB) để chọn predecessor. Không có nó thì
  // sync.mjs sẽ throw "thiếu discovery manifest" → fail rõ ràng ngay từ đây.
  if (!nodesync.orchestratorEnabled) {
    throw new Error("SSH_SYNC_PATHS có dữ liệu nhưng CONSUL_ENABLE!=1; RTDB discovery là bắt buộc cho nodesync sync.");
  }
  // 1) Bootstrap SSH server trên host runner (tạo/cài key, sshd, host key...).
  run(`node scripts/runners/setup-nodesync-ssh.mjs${DRY_RUN ? " --dry-run" : ""}`);
  // 2) Start transport + orchestrator + nodesync (orchestrator register lên RTDB).
  //    KHÔNG start cloudflared ở đây: named tunnel multi-connector có thể route
  //    ssh.<domain> về chính node mới trước khi rsync xong. cloudflared connect
  //    ở bước "Start stack" phía dưới, SAU khi rsync xong.
  const services = ["orchestrator", "nodesync"];
  if (nodesync.tailscaleChannel) services.unshift("tailscale");
  run(compose(`up -d ${services.join(" ")}`));
  await waitNodesync();
  // 2b) Tailscale userspace transport. Serve TCP 2222 forwards to the host
  //     runner's sshd because users, identity files and workspace live there.
  if (nodesync.tailscaleChannel && !DRY_RUN) {
    const tsReady = await waitTailscaleOnline();
    if (!tsReady) log("WARN: Tailscale chưa sẵn sàng; sẽ fallback cloudflare/hybrid nếu bật.");
    else {
      run(dc("compose exec tailscale tailscale serve --bg --tcp=2222 tcp://host.docker.internal:22"));
      log("Tailscale transport ready: tailnet:2222 → runner sshd:22 via userspace SOCKS5.");
    }
  }
  // 3) [YC #2 — bỏ hard-wait] Không sleep 3s chờ RTDB timestamp nữa; discover
  //    ngay (chỉ đọc RTDB, read-after-write đủ nhất quán cho selection theo
  //    startedAt). Node đầu tiên → source=null → skip probe/rsync.
  log("Discovering nodesync predecessor...");
  run(compose(`run --rm --no-deps orchestrator node scripts/discover-predecessor.mjs --json > ci-runtime/nodesync/predecessor.json`));
  const predFile = resolve(ROOT, "ci-runtime/nodesync/predecessor.json");
  const pred = DRY_RUN ? { hasPredecessor: false, host: "" } : readPredecessor(predFile);
  if (!pred.hasPredecessor) {
    log("Không có predecessor → node đầu tiên; skip mesh-probe & rsync, để sync.mjs ghi sync-ok(first-runner).");
    run(compose(`exec -T nodesync node scripts/sync.mjs${SILENT ? " --silent" : ""}`));
    log("Nodesync (first-runner) hoàn tất; orchestrator có thể giành leader ngay.");
  } else {
    log(`Predecessor tìm thấy (host=${pred.host || "(chưa có tailnet host)"}).`);
    if (nodesync.tailscaleChannel && pred.host) {
      // Thay hard-wait 8s: probe SOCKS5 tới predecessor, retry ngắn, thoát ngay.
      await probePredecessorSocks(pred.host, libDeps, { port: 2222 });
    }
    // 4) Sync configured paths từ predecessor. sync.mjs ghi cờ sync-ok →
    //    orchestrator (sync-gate) mới giành leader. rsync XONG rồi mới cloudflared.
    run(compose(`exec -T nodesync node scripts/sync.mjs${SILENT ? " --silent" : ""}`));
    log("Nodesync pre-start hoàn tất (sync-ok đã ghi).");
  }
}

if (mode === "ci") {
  log("Starting stack in CI / quick-tunnel mode...");
  run(dc("compose -f docker-compose.yml -f docker-compose.ci.yml up -d --remove-orphans"));
} else {
  log("Starting stack...");
  run(dc("compose up -d --remove-orphans"));
}

run(dc("compose ps"));

// Fail fast if cloudflared is not running — poll thay vì sleep mù.
if (!DRY_RUN) {
  const cfReady = await waitForServiceRunning("cloudflared", libDeps, 30_000, 500);
  if (!cfReady) {
    console.error("ERROR: cloudflared is not running after up");
    try { run(dc("compose ps -a")); } catch {}
    try { run(dc("compose logs --no-color cloudflared")); } catch {}
    process.exit(1);
  }
  log("cloudflared running ✓");
}

// Publish stack apps qua tailnet (Cách A/B theo TS_PUBLISH_MODE). Tách hẳn ra
// tailscale/scripts/publish.mjs — up.mjs chỉ gọi 1 dòng. Chỉ chạy khi profile
// tailscale đang bật; publish.mjs tự no-op khi TS_PUBLISH_MODE=off và tự nuốt
// lỗi (KHÔNG làm gãy stack / SSH sync 2222).
const activeProfiles = process.env.COMPOSE_PROFILES || envGet(ENV, "COMPOSE_PROFILES") || "";
const tailscaleActive = /(^|[,\s])(tailscale|full)([,\s]|$)/.test(activeProfiles);
const publishMode = (process.env.TS_PUBLISH_MODE || envGet(ENV, "TS_PUBLISH_MODE") || "off").toLowerCase();
if (tailscaleActive && publishMode !== "off") {
  log(`Publishing apps over tailnet (TS_PUBLISH_MODE=${publishMode})...`);
  try {
    run(`node tailscale/scripts/publish.mjs${DRY_RUN ? " --dry-run" : ""}${SILENT ? " --silent" : ""}`);
  } catch (e) {
    log(`WARN: publish qua tailnet lỗi nhưng bỏ qua để không ảnh hưởng stack: ${e.message}`);
  }

  // Fire-and-forget: đợi tailscale online, detect hostname thật, ghi .env, re-publish nếu sai.
  // Không block luồng chính — chạy nền.
  try {
    const nodeBin = process.execPath;
    const waitScript = resolve(ROOT, "tailscale/scripts/wait-ready.mjs");
    const waitArgs = [waitScript, ...(DRY_RUN ? ["--dry-run"] : []), ...(SILENT ? ["--silent"] : [])];
    const { spawn } = await import("node:child_process");
    spawn(nodeBin, waitArgs, { cwd: ROOT, stdio: "ignore", detached: true }).unref();
    log("(wait-ready đang chạy nền — tailscale sẽ tự detect hostname thật rồi ghi .env)");
  } catch (e) {
    log(`WARN: spawn wait-ready lỗi (bỏ qua): ${e.message}`);
  }
}

log("");
log("Active profiles tip: echo $COMPOSE_PROFILES or check .env");
if (hasLitestreamConfig() || hasRcloneConfig()) log("Optional profiles were auto-enabled from indexed env blocks.");
log("Tunnel logs: docker compose logs -f cloudflared");
log("Tinyauth user: node tinyauth/scripts/generate-user.mjs");
