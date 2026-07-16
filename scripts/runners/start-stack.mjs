#!/usr/bin/env node
// scripts/runners/start-stack.mjs
// CI: start Docker Compose stack, fail fast if cloudflared is not running.
//
// Env vars: MODE (named | quick).
// Flags:
//   --dry-run   Show commands without running
//   --silent    Suppress output
import { execSync, spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectDocker } from "./_docker.mjs";
import { envGet, parseEnv } from "../lib/env-utils.mjs";
import { redactSecrets } from "../lib/redact-utils.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };
const err = (...a) => { if (!SILENT) console.error(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const MODE = process.env.MODE || "quick";

process.chdir(ROOT);

const docker = DRY_RUN ? { available: true, cmd: "docker", via: "dry-run" } : detectDocker();
if (!docker.available) {
  console.error("ERROR: Docker daemon unavailable. Start Docker Desktop/Engine, or use --dry-run.");
  process.exit(1);
}
const dc = (parts) => `${docker.cmd} ${parts}`;
log(`Docker: ${docker.via} (${docker.cmd})`);

function run(cmd) {
  if (DRY_RUN) { log(`[DRY RUN] ${cmd}`); return; }
  execSync(cmd, { stdio: SILENT ? "ignore" : "inherit", cwd: ROOT });
}
function runPrefixed(name, cmd) {
  if (DRY_RUN) { log(`[DRY RUN] ${cmd}`); return Promise.resolve(); }
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(cmd, { cwd: ROOT, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const write = (stream, data) => {
      if (SILENT) return;
      for (const line of data.toString().split(/\r?\n/).filter(Boolean)) stream.write(`[${name}] ${line}\n`);
    };
    proc.stdout.on("data", (data) => write(process.stdout, data));
    proc.stderr.on("data", (data) => write(process.stderr, data));
    proc.on("error", reject);
    proc.on("close", (code) => code === 0 ? resolvePromise() : reject(new Error(`${name} failed with exit code ${code}`)));
  });
}
function sh(cmd) {
  if (DRY_RUN) return "";
  return execSync(cmd, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
}

function hasLitestreamConfig(envFile) {
  const env = { ...parseEnv(envFile), ...process.env };
  return Object.keys(env).some((key) => /^LITESTREAM_\d+_SERVICE$/.test(key));
}

function hasRcloneConfig(envFile) {
  const env = { ...parseEnv(envFile), ...process.env };
  return Object.keys(env).some((key) => /^RCLONE_\d+_NAME$/.test(key));
}

// nodesync bật khi SSH_ENABLE=1 (đồng bộ dữ liệu giữa node qua SSH).
function envTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "0").toLowerCase());
}

function nodesyncConfig(envFile) {
  const env = { ...parseEnv(envFile), ...process.env };
  return {
    enabled: envTruthy(env.SSH_ENABLE),
    syncOnStart: envTruthy(env.NODESYNC_SYNC_ON_START),
    tailscaleChannel: envTruthy(env.SSH_CHANNEL_TAILSCALE_ENABLE ?? "1"),
    cloudflareChannel: envTruthy(env.SSH_CHANNEL_CLOUDFLARE_ENABLE),
    hybridChannel: envTruthy(env.SSH_CHANNEL_HYBRID_ENABLE),
  };
}

function firstIndexedName(envFile, prefix, key) {
  const env = { ...parseEnv(envFile), ...process.env };
  const indexes = Object.keys(env).map((name) => name.match(new RegExp(`^${prefix}_(\\d+)_${key}$`))?.[1]).filter(Boolean).sort((a, b) => Number(a) - Number(b));
  if (indexes.length === 0) return "";
  const index = indexes[0];
  return `${prefix.toLowerCase()}-${index}-${env[`${prefix}_${index}_${key}`]}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
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

async function waitForHealthy(service, timeoutMs = 90_000) {
  if (DRY_RUN) { log(`[DRY RUN] chờ ${service} healthy`); return; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = sh(dc(`inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' ${service}`));
      if (status === "healthy" || status === "running") return;
      if (status === "unhealthy" || status === "exited") throw new Error(`${service} status=${status}`);
    } catch (e) {
      if (/status=(unhealthy|exited)/.test(e.message)) throw e;
    }
    await new Promise((done) => setTimeout(done, 2_000));
  }
  throw new Error(`${service} không healthy sau ${timeoutMs / 1000}s`);
}

async function waitForTailscale(timeoutMs = 60_000) {
  if (DRY_RUN) { log("[DRY RUN] chờ tailscale LocalAPI sẵn sàng"); return true; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const output = sh(dc("exec tailscale tailscale status --json"));
      const status = JSON.parse(output);
      if (status?.Self?.Online || status?.BackendState === "Running") return true;
    } catch {}
    await new Promise((done) => setTimeout(done, 2_000));
  }
  return false;
}

// chmod scripts
try { run("bash -c 'chmod +x scripts/*.sh */scripts/*.sh 2>/dev/null || chmod +x scripts/*.sh'"); } catch {}

// Show active profiles
const envFile = resolve(ROOT, ".env");
log("Base COMPOSE_PROFILES:", envGet(envFile, "COMPOSE_PROFILES") || "(unset)");
if (hasLitestreamConfig(envFile)) {
  ensureProfile("litestream", envFile);
  process.env.LITESTREAM_CONTAINER_NAME = firstIndexedName(envFile, "LITESTREAM", "SERVICE");
}
if (hasRcloneConfig(envFile)) {
  ensureProfile("rclone", envFile);
  process.env.RCLONE_CONTAINER_NAME = firstIndexedName(envFile, "RCLONE", "NAME");
}
const nodesync = nodesyncConfig(envFile);
if (nodesync.enabled) {
  ensureProfile("nodesync", envFile);
  if (nodesync.tailscaleChannel) ensureProfile("tailscale", envFile);
  log(`Nodesync enabled; sync-on-start=${nodesync.syncOnStart}; tailscale-channel=${nodesync.tailscaleChannel}`);
}
process.env.DOCKER_VOLUME_RUNTIME_ABS = resolveVolumeRoot(envGet(envFile, "DOCKER_VOLUME_RUNTIME"), "ci-runtime");
process.env.DOCKER_VOLUME_DATA_ABS = resolveVolumeRoot(envGet(envFile, "DOCKER_VOLUME_DATA"), "ci-data");

run(`node litestream/scripts/generate-config.mjs${SILENT ? " --silent" : ""}`);
await Promise.all([
  runPrefixed("litestream", `node litestream/scripts/restore.mjs${SILENT ? " --silent" : ""}`),
  runPrefixed("rclone", `node rclone/scripts/pull.mjs${SILENT ? " --silent" : ""}`),
]);

// Node nhận dữ liệu: start transport/SSH sidecars trước, sync xong mới start app.
if (nodesync.enabled && nodesync.syncOnStart) {
  const prestartServices = nodesync.tailscaleChannel ? "tailscale nodesync" : "nodesync";
  run(composeArgs(`up -d ${prestartServices}`));
  await waitForHealthy("nodesync");
  if (nodesync.tailscaleChannel && !(await waitForTailscale())) {
    const hasFallback = nodesync.cloudflareChannel || nodesync.hybridChannel;
    if (!hasFallback) throw new Error("Tailscale chưa sẵn sàng và không có SSH channel fallback");
    err("WARN: Tailscale chưa sẵn sàng; sync sẽ thử Cloudflare/Hybrid fallback.");
  }
  run(composeArgs(`exec -T nodesync node scripts/sync.mjs${SILENT ? " --silent" : ""}`));
  log("Nodesync pre-start hoàn tất; tiếp tục start app stack.");
}

// Start stack
if (MODE === "named") {
  run(dc("compose up -d --remove-orphans"));
} else {
  log("Resolved cloudflared service (must use --url, not run-with-token):");
  if (!DRY_RUN) {
    try {
      const cfg = sh(dc("compose -f docker-compose.yml -f docker-compose.ci.yml config"));
      const block = cfg.split("\n");
      let printing = false;
      for (const line of block) {
        if (/^  cloudflared:/.test(line)) printing = true;
        else if (printing && /^  [a-z]/.test(line)) break;
        if (printing) log(redactSecrets(line));
      }
    } catch {}
  }
  run(dc("compose -f docker-compose.yml -f docker-compose.ci.yml up -d --remove-orphans"));
}

run(dc("compose ps"));

if (DRY_RUN) {
  log("[DRY RUN] Would check cloudflared is running after 3s");
  process.exit(0);
}

// Fail fast if cloudflared is not running
execSync("sleep 3", { stdio: "inherit" });
try {
  const running = sh(dc("compose ps --status running --services"));
  if (!running.split("\n").includes("cloudflared")) throw new Error("not running");
} catch {
  err("ERROR: cloudflared is not running after up");
  try { run(dc("compose ps -a")); } catch {}
  try { run(dc("compose logs --no-color cloudflared")); } catch {}
  process.exit(1);
}
