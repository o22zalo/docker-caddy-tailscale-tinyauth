#!/usr/bin/env node
// scripts/runners/start-stack.mjs
// CI: start Docker Compose stack, fail fast if cloudflared is not running.
//
// Env vars: MODE (named | quick).
// Flags:
//   --dry-run   Show commands without running
//   --silent    Suppress output
import { execSync, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectDocker } from "./_docker.mjs";
import { envGet } from "../lib/env-utils.mjs";
import { redactSecrets } from "../lib/redact-utils.mjs";

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
} from "../lib/stack-lib.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => {
  if (!SILENT) console.log(...a);
};
const err = (...a) => {
  if (!SILENT) console.error(...a);
};

// ── Step timing instrumentation ──────────────────────────────────────────────
const STEP_SEP = "─".repeat(72);
let _totalStart = Date.now();
let _currentStep = null;

function stepBegin(name, { parallel = false, parent = null } = {}) {
  const now = Date.now();
  _currentStep = { name, start: now, parent };
  const prefix = parallel ? "  ↳ parallel" : "  ▶";
  log(`${prefix} [${name}] started`);
  return now;
}

function stepEnd(name, startTs, { note = "" } = {}) {
  const elapsed = ((Date.now() - startTs) / 1000).toFixed(2);
  const suffix = note ? ` — ${note}` : "";
  log(`  ✔ [${name}] done in ${elapsed}s${suffix}`);
}

function totalElapsed() {
  return ((Date.now() - _totalStart) / 1000).toFixed(2);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

// Detect actual mode from .env (CF_TUNNEL_TOKEN presence), not from
// process.env.MODE which depends on GITHUB_ENV (unavailable on Azure).
function detectMode() {
  if (process.env.MODE) return process.env.MODE;
  try {
    const envContent = readFileSync(resolve(ROOT, ".env"), "utf8");
    // dotenv-style: KEY=VALUE (no inline comment stripping needed for existence check)
    if (/^CF_TUNNEL_TOKEN=.+/m.test(envContent)) return "named";
  } catch {}
  return "quick";
}
const MODE = detectMode();

process.chdir(ROOT);

log(`\n${"═".repeat(72)}`);
log(`start-stack.mjs — MODE=${MODE} — started at ${new Date().toISOString()}`);
log(`${"═".repeat(72)}\n`);

const docker = DRY_RUN ? { available: true, cmd: "docker", via: "dry-run" } : detectDocker();
if (!docker.available) {
  console.error("ERROR: Docker daemon unavailable. Start Docker Desktop/Engine, or use --dry-run.");
  process.exit(1);
}
const dc = (parts) => `${docker.cmd} ${parts}`;
log(`Docker: ${docker.via} (${docker.cmd})`);

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
function sh(cmd) {
  if (DRY_RUN) return "";
  return execSync(cmd, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] })
    .toString()
    .trim();
}

function hasLitestreamConfig(envFile) {
  return libHasLitestream(envFile);
}

function hasRcloneConfig(envFile) {
  return libHasRclone(envFile);
}

// nodesync bật khi SSH_ENABLE=1 (đồng bộ dữ liệu giữa node qua SSH).
function nodesyncConfig(envFile) {
  return libNodesyncConfig(envFile);
}

function firstIndexedName(envFile, prefix, key) {
  return libFirstIndexedName(envFile, prefix, key);
}

function ensureProfile(name, envFile) {
  const current = process.env.COMPOSE_PROFILES || envGet(envFile, "COMPOSE_PROFILES") || "";
  if (current.split(/[,\s]+/).includes(name)) return;
  process.env.COMPOSE_PROFILES = current ? `${current},${name}` : name;
  log(`Ensuring ${name} profile is enabled`);
}

function resolveVolumeRoot(value, fallback) {
  return resolve(ROOT, value || fallback);
}

function composeArgs(command) {
  const files = MODE === "named" ? "" : "-f docker-compose.yml -f docker-compose.ci.yml ";
  return dc(`compose ${files}${command}`);
}

// deps chung cho stack-lib (inject run/sh/dc/log để dễ test + tái dùng).
const runCapture = (cmd, argv, timeoutMs = 15000) => {
  try {
    const out = execFileSync(cmd, argv, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs }).toString().trim();
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: (e.stderr || e.message || "").toString() };
  }
};
const libDeps = { sh, dc, log, err, dryRun: DRY_RUN, runCapture };

async function waitForHealthy(service, timeoutMs = 90_000) {
  return libWaitForHealthy(service, libDeps, timeoutMs);
}

async function waitForTailscale(timeoutMs = 60_000) {
  return libWaitForTailscale(libDeps, timeoutMs);
}

// chmod scripts
{
  const t = stepBegin("chmod-scripts");
  try {
    run("bash -c 'chmod +x scripts/*.sh */scripts/*.sh 2>/dev/null || chmod +x scripts/*.sh'");
  } catch {}
  stepEnd("chmod-scripts", t);
}

// Show active profiles
const envFile = resolve(ROOT, ".env");
const nodesync = nodesyncConfig(envFile);
{
  const t0 = stepBegin("profile-detect");
  log("Base COMPOSE_PROFILES:", envGet(envFile, "COMPOSE_PROFILES") || "(unset)");
  if (hasLitestreamConfig(envFile)) {
    ensureProfile("litestream", envFile);
    process.env.LITESTREAM_CONTAINER_NAME = firstIndexedName(envFile, "LITESTREAM", "SERVICE");
  }
  if (hasRcloneConfig(envFile)) {
    ensureProfile("rclone", envFile);
    process.env.RCLONE_CONTAINER_NAME = firstIndexedName(envFile, "RCLONE", "NAME");
  }
  if (nodesync.enabled) {
    ensureProfile("nodesync", envFile);
    if (nodesync.tailscaleChannel) ensureProfile("tailscale", envFile);
    log(`Nodesync enabled; paths=${nodesync.paths.length}; tailscale-channel=${nodesync.tailscaleChannel}`);
  }
  // [YC] Hostname Tailscale phải DUY NHẤT theo từng runner — dùng helper chung
  // từ stack-lib (uniqueTsHostname) để up.mjs và start-stack.mjs không lệch.
  if (nodesync.enabled && nodesync.tailscaleChannel) {
    const tsHost = uniqueTsHostname(envGet(envFile, "TS_HOSTNAME") || "proxy-stack");
    process.env.TS_HOSTNAME = tsHost;
    // Tailscale container owns only the userspace network/SOCKS5 transport.
    // SSH identity, users and workspace live on the host runner, so do not enable
    // Tailscale SSH here; Serve TCP forwards tailnet:2222 to host sshd:22.
    const baseExtra = process.env.TS_EXTRA_ARGS || envGet(envFile, "TS_EXTRA_ARGS") || "--accept-dns=false";
    process.env.TS_EXTRA_ARGS = sanitizeTsExtraArgs(baseExtra);
    log(`Tailscale transport identity: hostname=${tsHost} extraArgs="${process.env.TS_EXTRA_ARGS}"`);
  }
  process.env.DOCKER_VOLUME_RUNTIME_ABS = resolveVolumeRoot(envGet(envFile, "DOCKER_VOLUME_RUNTIME"), "ci-runtime");
  process.env.DOCKER_VOLUME_DATA_ABS = resolveVolumeRoot(envGet(envFile, "DOCKER_VOLUME_DATA"), "ci-data");
  stepEnd("profile-detect", t0);
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1 — Pre-stack restore (litestream generate → parallel restore/rclone)
// ─────────────────────────────────────────────────────────────────────────────
log(`${STEP_SEP}`);
log("PHASE 1: Pre-stack data restore");
const phase1Start = Date.now();

{
  const t = stepBegin("litestream-generate-config");
  run(`node litestream/scripts/generate-config.mjs${SILENT ? " --silent" : ""}`);
  stepEnd("litestream-generate-config", t);
}

log(`${STEP_SEP}`);
log("  Parallel: litestream-restore + rclone-pull (Promise.all)");
const tRestore = stepBegin("litestream-restore", { parallel: true });
const tRclone = stepBegin("rclone-pull", { parallel: true });
await Promise.all([
  runPrefixed("litestream", `node litestream/scripts/restore.mjs${SILENT ? " --silent" : ""}`),
  runPrefixed("rclone", `node rclone/scripts/pull.mjs${SILENT ? " --silent" : ""}`),
]);
stepEnd("litestream-restore", tRestore);
stepEnd("rclone-pull", tRclone);

log(`PHASE 1 total: ${((Date.now() - phase1Start) / 1000).toFixed(2)}s`);

// Nodesync zero-touch: bootstrap host SSH, register RTDB, discover predecessor,
// rồi sync configured paths. Không restore/pull dữ liệu trong sidecar này.
//
// [YC #3] THỨ TỰ BẮT BUỘC:
//   1) tailscale connect (join tailnet) TRƯỚC
//   2) rsync dữ liệu từ predecessor
//   3) CHỈ SAU KHI rsync xong (orchestrator qua sync-gate → giành leader) mới
//      start cloudflared của node MỚI.
//   Lý do: named tunnel là multi-connector; nếu cloudflared node mới connect
//   TRƯỚC khi rsync xong, Cloudflare có thể route ssh.<domain> về CHÍNH nó thay
//   vì predecessor → rsync kéo dữ liệu từ chính mình / host-key mismatch.
//   => Ở giai đoạn sync, TUYỆT ĐỐI KHÔNG start cloudflared.
if (nodesync.enabled) {
  if (nodesync.paths.length) {
    log(`${STEP_SEP}`);
    log("PHASE 2: Nodesync bootstrap + rsync");
    const phase2Start = Date.now();

    if (!nodesync.orchestratorEnabled) throw new Error("SSH_SYNC_PATHS có dữ liệu nhưng CONSUL_ENABLE!=1; RTDB discovery là bắt buộc");
    // KHÔNG start cloudflared ở đây (xem lý do trên). Client Cloudflare channel
    // chỉ cần `cloudflared access ssh` (outbound) — không cần connector local.
    const services = ["orchestrator", "nodesync"];
    if (nodesync.tailscaleChannel) services.unshift("tailscale");

    {
      const t = stepBegin("nodesync-up");
      run(composeArgs(`up -d ${services.join(" ")}`));
      stepEnd("nodesync-up", t, { note: `services: ${services.join(", ")}` });
    }

    {
      const t = stepBegin("wait-nodesync-healthy");
      await waitForHealthy("nodesync");
      stepEnd("wait-nodesync-healthy", t);
    }

    if (nodesync.tailscaleChannel) {
      const t = stepBegin("wait-tailscale-online");
      // Chờ tailnet của CHÍNH node này online (điều kiện cần để đi đường tailscale).
      if (!(await waitForTailscale())) {
        const hasFallback = nodesync.cloudflareChannel || nodesync.hybridChannel;
        if (!hasFallback) throw new Error("Tailscale chưa sẵn sàng và không có channel fallback");
        err("WARN: Tailscale chưa sẵn sàng; thử Cloudflare/Hybrid fallback.");
        stepEnd("wait-tailscale-online", t, { note: "fallback (not ready)" });
      } else {
        // This command runs on the host against the Tailscale sidecar. The
        // resulting listener belongs to the tailnet node, while SSH terminates
        // at host.docker.internal:22 where nodesync users/data actually live.
        run(dc("exec tailscale tailscale serve --bg --tcp=2222 tcp://host.docker.internal:22"));
        log("Tailscale transport ready: tailnet:2222 → runner sshd:22 via userspace SOCKS5.");
        stepEnd("wait-tailscale-online", t, { note: "ready, serve TCP configured" });
      }
    }

    {
      const t = stepBegin("discover-predecessor");
      // [YC #2 — bỏ hard-wait] Trước đây sleep 8s "mesh warmup" + sleep 3s chờ RTDB
      // timestamp. Nay: discover ngay (discover chỉ ĐỌC RTDB; register.mjs của
      // orchestrator đã ghi node trước đó, RTDB read-after-write nhất quán đủ cho
      // predecessor selection theo startedAt). Nếu chưa có predecessor, discover
      // trả source=null → node ĐẦU TIÊN, skip warmup/rsync hoàn toàn.
      log("Discovering nodesync predecessor...");
      // Container discover là ONE-SHOT (--rm) và CHỈ ĐỌC RTDB (không register,
      // không onDisconnect) → an toàn, dùng chung node-id để tự loại mình khỏi
      // danh sách predecessor candidate.
      run(composeArgs(`run --rm --no-deps orchestrator node scripts/discover-predecessor.mjs --json > ci-runtime/nodesync/predecessor.json`));
      const predFile = resolve(ROOT, "ci-runtime/nodesync/predecessor.json");
      const pred = DRY_RUN ? { hasPredecessor: false, host: "" } : readPredecessor(predFile);
      stepEnd("discover-predecessor", t, { note: pred.hasPredecessor ? `found host=${pred.host}` : "no predecessor (first node)" });

      if (!pred.hasPredecessor) {
        // Node ĐẦU TIÊN: không predecessor → skip warm peer + rsync. sync.mjs sẽ
        // tự ghi sync-ok "first-runner"; orchestrator giành leader trống (term=1).
        const t2 = stepBegin("sync-first-runner");
        log("Không có predecessor → node đầu tiên; skip mesh-probe & rsync, để sync.mjs ghi sync-ok(first-runner).");
        run(composeArgs(`exec -T nodesync node scripts/sync.mjs${SILENT ? " --silent" : ""}`));
        stepEnd("sync-first-runner", t2, { note: "first-runner, orchestrator can win leader" });
      } else {
        log(`Predecessor tìm thấy (host=${pred.host || "(chưa có tailnet host)"}).`);
        if (nodesync.tailscaleChannel && pred.host) {
          const tProbe = stepBegin("probe-predecessor-socks");
          // Thay hard-wait 8s: probe SOCKS5 tới predecessor, retry ngắn, thoát ngay
          // khi mở kết nối được. KHÔNG throw — sync.mjs còn warmup + fallback channel.
          await probePredecessorSocks(pred.host, libDeps, { port: 2222 });
          stepEnd("probe-predecessor-socks", tProbe);
        }
        const t2 = stepBegin("rsync-from-predecessor");
        // rsync: sync.mjs sẽ ghi cờ ci-runtime/nodesync/sync-ok khi xong → orchestrator
        // (đang chờ ở sync-gate) mới được phép giành leader.
        run(composeArgs(`exec -T nodesync node scripts/sync.mjs${SILENT ? " --silent" : ""}`));
        stepEnd("rsync-from-predecessor", t2, { note: "sync-ok written, orchestrator can win leader" });
      }
    }

    log(`PHASE 2 total: ${((Date.now() - phase2Start) / 1000).toFixed(2)}s`);
  } else log("SSH_SYNC_PATHS rỗng: không discover/SSH/rsync.");
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Start stack + cloudflared connect
// ─────────────────────────────────────────────────────────────────────────────
log(`${STEP_SEP}`);
log("PHASE 3: Start stack");
const phase3Start = Date.now();

{
  const t = stepBegin("compose-up");
  // Start stack (đây mới là lúc cloudflared của node mới connect — SAU rsync).
  if (MODE === "named") {
    run(dc("compose up -d --remove-orphans"));
    stepEnd("compose-up", t, { note: "named mode" });
  } else {
    run(dc("compose -f docker-compose.yml -f docker-compose.ci.yml up -d --remove-orphans"));
    stepEnd("compose-up", t, { note: "quick/CI mode" });
  }
}

{
  const t = stepBegin("compose-ps");
  run(dc("compose ps"));
  stepEnd("compose-ps", t);
}

log(`PHASE 3 total: ${((Date.now() - phase3Start) / 1000).toFixed(2)}s`);

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4 — Tailscale publish (fire-and-forget)
// ─────────────────────────────────────────────────────────────────────────────
{
  const activeProfiles = process.env.COMPOSE_PROFILES || envGet(envFile, "COMPOSE_PROFILES") || "";
  const tailscaleActive = /(^|[,\s])(tailscale|full)([,\s]|$)/.test(activeProfiles);
  const publishMode = (process.env.TS_PUBLISH_MODE || envGet(envFile, "TS_PUBLISH_MODE") || "off").toLowerCase();
  if (tailscaleActive && publishMode !== "off") {
    log(`${STEP_SEP}`);
    log("PHASE 4: Tailscale publish");
    const phase4Start = Date.now();

    {
      const t = stepBegin("tailscale-publish");
      log(`Publishing apps over tailnet (TS_PUBLISH_MODE=${publishMode})...`);
      try {
        run(`node tailscale/scripts/publish.mjs${DRY_RUN ? " --dry-run" : ""}${SILENT ? " --silent" : ""}`);
        stepEnd("tailscale-publish", t);
      } catch (e) {
        stepEnd("tailscale-publish", t, { note: `WARN: ${e.message}` });
        log(`WARN: publish qua tailnet lỗi nhưng bỏ qua để không ảnh hưởng stack: ${e.message}`);
      }
    }

    // Fire-and-forget: đợi tailscale online, detect hostname thật, ghi .env, re-publish nếu sai.
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

    log(`PHASE 4 total: ${((Date.now() - phase4Start) / 1000).toFixed(2)}s`);
  }
}

if (DRY_RUN) {
  log("[DRY RUN] Would check cloudflared is running after 3s");
  log(`\n${STEP_SEP}`);
  log(`TOTAL ELAPSED: ${totalElapsed()}s`);
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5 — Cloudflared health gate
// ─────────────────────────────────────────────────────────────────────────────
log(`${STEP_SEP}`);
log("PHASE 5: Cloudflared health check");
const phase5Start = Date.now();

{
  const t = stepBegin("wait-cloudflared");
  // Fail fast if cloudflared is not running — poll thay vì sleep 3 mù (thoát sớm
  // khi ready, fail nhanh khi quá timeout).
  const cfReady = await waitForServiceRunning("cloudflared", libDeps, 30_000, 500);
  if (!cfReady) {
    stepEnd("wait-cloudflared", t, { note: "FAILED — not running after 30s" });
    err("ERROR: cloudflared is not running after up");
    try {
      run(dc("compose ps -a"));
    } catch {}
    try {
      const rawLogs = sh(dc("compose logs --no-color cloudflared"));
      if (rawLogs) log(redactSecrets(rawLogs));
    } catch {}
    process.exit(1);
  }
  stepEnd("wait-cloudflared", t, { note: "healthy" });
}

log(`PHASE 5 total: ${((Date.now() - phase5Start) / 1000).toFixed(2)}s`);
log(`\n${STEP_SEP}`);
log(`ALL PHASES COMPLETE — TOTAL ELAPSED: ${totalElapsed()}s`);
log(`cloudflared running ✓`);
