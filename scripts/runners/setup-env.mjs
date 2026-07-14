#!/usr/bin/env node
// scripts/runners/setup-env.mjs
// CI: materialise .env from secret or fallback, detect mode, ensure profiles.
//
// Exports MODE to GITHUB_ENV (named | quick).
// Env vars: ENV_FILE (secret), GITHUB_ENV, GITHUB_STEP_SUMMARY.
//
// Flags:
//   --dry-run   Show what would be written, no file changes
//   --silent    Suppress console output
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const ENV = resolve(ROOT, ".env");
const ENV_CI = resolve(ROOT, ".env.ci");
const GITHUB_ENV = process.env.GITHUB_ENV;
const GITHUB_STEP_SUMMARY = process.env.GITHUB_STEP_SUMMARY;
const ENV_FILE = process.env.ENV_FILE || "";

function appendEnv(key, val) {
  if (!DRY_RUN && GITHUB_ENV) appendFileSync(GITHUB_ENV, `${key}=${val}\n`);
  log(`[env] ${key}=${val}`);
}

function envKeys() {
  if (!existsSync(ENV)) return;
  const keys = readFileSync(ENV, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => l.split("=")[0]);
  log("--- .env keys ---");
  keys.forEach((k) => log(k));
}

function envGet(key) {
  if (!existsSync(ENV)) return "";
  const m = readFileSync(ENV, "utf8").match(new RegExp(`^${key}=(.+)$`, "m"));
  return m ? m[1].replace(/^["']|["']$/g, "") : "";
}

function envHasKey(key) {
  if (!existsSync(ENV)) return false;
  return new RegExp(`^${key}=.+`, "m").test(readFileSync(ENV, "utf8"));
}

function envAppend(line) {
  appendFileSync(ENV, line + "\n");
}

// 1. Write .env
if (DRY_RUN) {
  log(`[DRY RUN] Would write .env from: ${ENV_FILE ? "secrets.ENV_FILE" : ".env.ci"}`);
  log(`[DRY RUN] Mode: ${ENV_FILE && ENV_FILE.includes("TUNNEL_TOKEN") ? "named" : "quick"}`);
} else if (ENV_FILE) {
  writeFileSync(ENV, ENV_FILE + "\n");
  log("Wrote .env from secrets.ENV_FILE");
  if (envHasKey("TUNNEL_TOKEN")) {
    appendEnv("MODE", "named");
    log("Named Cloudflare tunnel mode (TUNNEL_TOKEN set)");
  } else {
    appendEnv("MODE", "quick");
    log("Quick tunnel mode (no TUNNEL_TOKEN in ENV_FILE)");
  }
} else {
  if (!DRY_RUN) copyFileSync(ENV_CI, ENV);
  appendEnv("MODE", "quick");
  log("secrets.ENV_FILE not set — using .env.ci + quick tunnel");
}
envKeys();

// 2. Ensure required Tinyauth vars for quick mode
if (!ENV_FILE || !envHasKey("TUNNEL_TOKEN")) {
  if (!envHasKey("TINYAUTH_AUTH_USERS")) {
    if (!DRY_RUN) envAppend('TINYAUTH_AUTH_USERS=user:$$2a$$10$$UdLYoJ5lgPsC0RKqYH/jMua7zIn0g9kPqWmhYayJYLaZQ/FTmH2/u');
    log("[env] Added TINYAUTH_AUTH_USERS (demo)");
  }
  if (!envHasKey("TINYAUTH_AUTH_SECURECOOKIE")) {
    if (!DRY_RUN) envAppend("TINYAUTH_AUTH_SECURECOOKIE=false");
    log("[env] Added TINYAUTH_AUTH_SECURECOOKIE=false");
  }
}

// 3. Ensure COMPOSE_PROFILES
if (!envHasKey("COMPOSE_PROFILES")) {
  if (!DRY_RUN) envAppend("COMPOSE_PROFILES=core");
  log("Added COMPOSE_PROFILES=core");
} else {
  log("COMPOSE_PROFILES already set:", envGet("COMPOSE_PROFILES"));
}
if (envHasKey("TS_AUTHKEY") && !/full|tailscale/.test(envGet("COMPOSE_PROFILES"))) {
  const cur = envGet("COMPOSE_PROFILES");
  if (!DRY_RUN) {
    const src = readFileSync(ENV, "utf8").replace(
      /^COMPOSE_PROFILES=.*$/m,
      `COMPOSE_PROFILES=${cur},tailscale`
    );
    writeFileSync(ENV, src);
  }
  log("Appended tailscale profile because TS_AUTHKEY is set");
}

// 4. Summary
if (GITHUB_STEP_SUMMARY) {
  appendFileSync(GITHUB_STEP_SUMMARY, `## Environment\n\n- Mode: ${ENV_FILE && envHasKey("TUNNEL_TOKEN") ? "named" : "quick"}\n- Profiles: ${envGet("COMPOSE_PROFILES")}\n\n`);
}
