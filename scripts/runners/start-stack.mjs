#!/usr/bin/env node
// scripts/runners/start-stack.mjs
// CI: start Docker Compose stack, fail fast if cloudflared is not running.
//
// Env vars: MODE (named | quick).
// Flags:
//   --dry-run   Show commands without running
//   --silent    Suppress output
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectDocker, dockerCmd } from "./_docker.mjs";
import { envGet } from "../lib/env-utils.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };
const err = (...a) => { if (!SILENT) console.error(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const MODE = process.env.MODE || "quick";

process.chdir(ROOT);

const docker = detectDocker();
if (!docker.available) {
  console.error("ERROR: Docker not found. Install Docker Desktop or Docker in WSL.");
  process.exit(1);
}
log(`Docker: ${docker.via} (${docker.cmd})`);

function run(cmd) {
  if (DRY_RUN) { log(`[DRY RUN] ${cmd}`); return; }
  execSync(cmd, { stdio: SILENT ? "ignore" : "inherit", cwd: ROOT });
}
function sh(cmd) {
  if (DRY_RUN) return "";
  return execSync(cmd, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
}

function redactSecrets(value) {
  return value
    .replace(/^(\s*-?\s*["']?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|AUTH|KEY|COOKIE|CREDENTIAL|ACCOUNT_ID|CLIENT_ID|CLIENT_SECRET|USERS)[A-Z0-9_]*["']?\s*[:=]\s*).+$/gmi, "$1[REDACTED]")
    .replace(/("?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|AUTH|KEY|COOKIE|CREDENTIAL|ACCOUNT_ID|CLIENT_ID|CLIENT_SECRET|USERS)[A-Z0-9_]*"?=)[^",\]\s]+/gi, "$1[REDACTED]");
}

function hasLitestreamConfig(envFile) {
  return Object.keys(process.env).some((key) => /^LITESTREAM_\d+_SERVICE$/.test(key)) ||
    (existsSync(envFile) && /^LITESTREAM_\d+_SERVICE=/m.test(readFileSync(envFile, "utf8")));
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

// chmod scripts
try { run("bash -c 'chmod +x scripts/*.sh */scripts/*.sh 2>/dev/null || chmod +x scripts/*.sh'"); } catch {}

// Show active profiles
const envFile = resolve(ROOT, ".env");
log("Active COMPOSE_PROFILES:", envGet(envFile, "COMPOSE_PROFILES") || "(unset)");
if (hasLitestreamConfig(envFile)) ensureProfile("litestream", envFile);
process.env.DOCKER_VOLUME_RUNTIME_ABS = resolveVolumeRoot(envGet(envFile, "DOCKER_VOLUME_RUNTIME"), "ci-runtime");
process.env.DOCKER_VOLUME_DATA_ABS = resolveVolumeRoot(envGet(envFile, "DOCKER_VOLUME_DATA"), "ci-data");

run(`node litestream/scripts/generate-config.mjs${SILENT ? " --silent" : ""}`);
run(`node litestream/scripts/restore.mjs${SILENT ? " --silent" : ""}`);

// Start stack
if (MODE === "named") {
  run(dockerCmd("compose up -d --remove-orphans"));
} else {
  log("Resolved cloudflared service (must use --url, not run-with-token):");
  if (!DRY_RUN) {
    try {
      const cfg = sh(dockerCmd("compose -f docker-compose.yml -f docker-compose.ci.yml config"));
      const block = cfg.split("\n");
      let printing = false;
      for (const line of block) {
        if (/^  cloudflared:/.test(line)) printing = true;
        else if (printing && /^  [a-z]/.test(line)) break;
        if (printing) log(redactSecrets(line));
      }
    } catch {}
  }
  run(dockerCmd("compose -f docker-compose.yml -f docker-compose.ci.yml up -d --remove-orphans"));
}

run(dockerCmd("compose ps"));

if (DRY_RUN) {
  log("[DRY RUN] Would check cloudflared is running after 3s");
  process.exit(0);
}

// Fail fast if cloudflared is not running
execSync("sleep 3", { stdio: "inherit" });
try {
  const running = sh(dockerCmd("compose ps --status running --services"));
  if (!running.split("\n").includes("cloudflared")) throw new Error("not running");
} catch {
  err("ERROR: cloudflared is not running after up");
  try { run(dockerCmd("compose ps -a")); } catch {}
  try { run(dockerCmd("compose logs --no-color cloudflared")); } catch {}
  process.exit(1);
}
