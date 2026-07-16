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
import { execSync, spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectDocker } from "./runners/_docker.mjs";
import { envGet, parseEnv } from "./lib/env-utils.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ENV = resolve(ROOT, ".env");
process.chdir(ROOT);

const docker = DRY_RUN ? { available: true, cmd: "docker", via: "dry-run" } : detectDocker();
if (!docker.available) { console.error("ERROR: Docker daemon unavailable. Start Docker or use --dry-run."); process.exit(1); }
const dc = (parts) => `${docker.cmd} ${parts}`;

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

function hasLitestreamConfig() {
  const env = { ...parseEnv(ENV), ...process.env };
  return Object.keys(env).some((key) => /^LITESTREAM_\d+_SERVICE$/.test(key));
}

function hasRcloneConfig() {
  const env = { ...parseEnv(ENV), ...process.env };
  return Object.keys(env).some((key) => /^RCLONE_\d+_NAME$/.test(key));
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "0").toLowerCase());
}
function getNodesyncConfig() {
  const env = { ...parseEnv(ENV), ...process.env };
  return {
    enabled: truthy(env.SSH_ENABLE),
    syncOnStart: truthy(env.NODESYNC_SYNC_ON_START),
    tailscale: truthy(env.SSH_CHANNEL_TAILSCALE_ENABLE ?? "1"),
  };
}

function firstIndexedName(prefix, key) {
  const env = { ...parseEnv(ENV), ...process.env };
  const indexes = Object.keys(env).map((name) => name.match(new RegExp(`^${prefix}_(\\d+)_${key}$`))?.[1]).filter(Boolean).sort((a, b) => Number(a) - Number(b));
  if (indexes.length === 0) return "";
  const index = indexes[0];
  return `${prefix.toLowerCase()}-${index}-${env[`${prefix}_${index}_${key}`]}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
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
async function waitNodesync(timeoutMs = 90_000) {
  if (DRY_RUN) { log("[DRY RUN] chờ nodesync healthy"); return; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = execSync(dc("inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' nodesync"), { encoding: "utf8" }).trim();
      if (status === "healthy") return;
      if (["unhealthy", "exited"].includes(status)) throw new Error(`nodesync ${status}`);
    } catch (e) { if (/nodesync (unhealthy|exited)/.test(e.message)) throw e; }
    await new Promise((done) => setTimeout(done, 2_000));
  }
  throw new Error("nodesync không healthy sau 90s");
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
if (nonFlagArgs[0] === "ci") { mode = "ci"; nonFlagArgs.shift(); }

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
const nodesync = getNodesyncConfig();
if (nodesync.enabled) {
  ensureProfile("nodesync");
  if (nodesync.tailscale) ensureProfile("tailscale");
}
process.env.DOCKER_VOLUME_RUNTIME_ABS = resolveVolumeRoot(envGet(ENV, "DOCKER_VOLUME_RUNTIME"), "ci-runtime");
process.env.DOCKER_VOLUME_DATA_ABS = resolveVolumeRoot(envGet(ENV, "DOCKER_VOLUME_DATA"), "ci-data");

// Start stack
run(`node litestream/scripts/generate-config.mjs${SILENT ? " --silent" : ""}`);
await Promise.all([
  runPrefixed("litestream", `node litestream/scripts/restore.mjs${SILENT ? " --silent" : ""}`),
  runPrefixed("rclone", `node rclone/scripts/pull.mjs${SILENT ? " --silent" : ""}`),
]);
if (nodesync.enabled && nodesync.syncOnStart) {
  const services = nodesync.tailscale ? "tailscale nodesync" : "nodesync";
  run(compose(`up -d ${services}`));
  await waitNodesync();
  run(compose(`exec -T nodesync node scripts/sync.mjs${SILENT ? " --silent" : ""}`));
  log("Nodesync pre-start hoàn tất.");
}

if (mode === "ci") {
  log("Starting stack in CI / quick-tunnel mode...");
  run(dc("compose -f docker-compose.yml -f docker-compose.ci.yml up -d --remove-orphans"));
} else {
  log("Starting stack...");
  run(dc("compose up -d --remove-orphans"));
}

run(dc("compose ps"));
log("");
log("Active profiles tip: echo $COMPOSE_PROFILES or check .env");
if (hasLitestreamConfig() || hasRcloneConfig()) log("Optional profiles were auto-enabled from indexed env blocks.");
log("Tunnel logs: docker compose logs -f cloudflared");
log("Tinyauth user: node tinyauth/scripts/generate-user.mjs");
