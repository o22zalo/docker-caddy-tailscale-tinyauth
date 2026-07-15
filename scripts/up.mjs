#!/usr/bin/env node
// scripts/up.mjs
// Start compose project according to COMPOSE_PROFILES in .env.
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
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectDocker, dockerCmd } from "./runners/_docker.mjs";
import { envGet } from "./lib/env-utils.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ENV = resolve(ROOT, ".env");
process.chdir(ROOT);

const docker = detectDocker();
if (!docker.available) { console.error("ERROR: Docker not found."); process.exit(1); }

function run(cmd) {
  if (DRY_RUN) { log(`[DRY RUN] ${cmd}`); return; }
  execSync(cmd, { stdio: SILENT ? "ignore" : "inherit", cwd: ROOT });
}

function hasLitestreamConfig() {
  return Object.keys(process.env).some((key) => /^LITESTREAM_\d+_SERVICE$/.test(key)) ||
    (existsSync(ENV) && /^LITESTREAM_\d+_SERVICE=/m.test(readFileSync(ENV, "utf8")));
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
    if (process.env.COMPOSE_PROFILES) {
      process.env.COMPOSE_PROFILES += ",tailscale";
    }
    log("TS_AUTHKEY present → ensuring Tailscale profile is enabled");
  }
}

if (hasLitestreamConfig()) ensureProfile("litestream");
process.env.DOCKER_VOLUME_RUNTIME_ABS = resolveVolumeRoot(envGet(ENV, "DOCKER_VOLUME_RUNTIME"), "ci-runtime");
process.env.DOCKER_VOLUME_DATA_ABS = resolveVolumeRoot(envGet(ENV, "DOCKER_VOLUME_DATA"), "ci-data");

// Start stack
run(`node litestream/scripts/generate-config.mjs${SILENT ? " --silent" : ""}`);
run(`node litestream/scripts/restore.mjs${SILENT ? " --silent" : ""}`);

if (mode === "ci") {
  log("Starting stack in CI / quick-tunnel mode...");
  run(dockerCmd("compose -f docker-compose.yml -f docker-compose.ci.yml up -d --remove-orphans"));
} else {
  log("Starting stack...");
  run(dockerCmd("compose up -d --remove-orphans"));
}

run(dockerCmd("compose ps"));
log("");
log("Active profiles tip: echo $COMPOSE_PROFILES or check .env");
log("Tunnel logs: docker compose logs -f cloudflared");
log("Tinyauth user: node tinyauth/scripts/generate-user.mjs");
