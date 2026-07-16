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
import dotenv from "dotenv";
import { envGet, envHasKey, envKeys } from "../lib/env-utils.mjs";

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

function showEnvKeys() {
  const keys = envKeys(ENV);
  log("--- .env keys ---");
  keys.forEach((k) => log(k));
}

function envAppend(line) {
  appendFileSync(ENV, line + "\n");
}

// 1. Write .env
if (DRY_RUN) {
  const dryEnv = ENV_FILE ? dotenv.parse(ENV_FILE) : {};
  log(`[DRY RUN] Would write .env from: ${ENV_FILE ? "secrets.ENV_FILE" : ".env.ci"}`);
  log(`[DRY RUN] Mode: ${dryEnv.CF_TUNNEL_TOKEN ? "named" : "quick"}`);
} else if (ENV_FILE) {
  writeFileSync(ENV, ENV_FILE + "\n");
  log("Wrote .env from secrets.ENV_FILE");
  if (envGet(ENV, "CF_TUNNEL_TOKEN")) {
    appendEnv("MODE", "named");
    log("Named Cloudflare tunnel mode (CF_TUNNEL_TOKEN set)");
  } else {
    appendEnv("MODE", "quick");
    log("Quick tunnel mode (no CF_TUNNEL_TOKEN in ENV_FILE)");
  }
} else {
  if (!DRY_RUN) copyFileSync(ENV_CI, ENV);
  appendEnv("MODE", "quick");
  log("secrets.ENV_FILE not set — using .env.ci + quick tunnel");
}
showEnvKeys();

// 2. Ensure required Tinyauth vars for quick mode
if (!ENV_FILE || !envGet(ENV, "CF_TUNNEL_TOKEN")) {
  if (!envHasKey(ENV, "TINYAUTH_AUTH_USERS")) {
    if (!DRY_RUN) envAppend('TINYAUTH_AUTH_USERS=user:$$2a$$10$$UdLYoJ5lgPsC0RKqYH/jMua7zIn0g9kPqWmhYayJYLaZQ/FTmH2/u');
    log("[env] Added TINYAUTH_AUTH_USERS (demo)");
  }
  if (!envHasKey(ENV, "TINYAUTH_AUTH_SECURECOOKIE")) {
    if (!DRY_RUN) envAppend("TINYAUTH_AUTH_SECURECOOKIE=false");
    log("[env] Added TINYAUTH_AUTH_SECURECOOKIE=false");
  }
}

// 3. Ensure COMPOSE_PROFILES
if (!envHasKey(ENV, "COMPOSE_PROFILES")) {
  if (!DRY_RUN) envAppend("COMPOSE_PROFILES=core");
  log("Added COMPOSE_PROFILES=core");
} else {
  log("COMPOSE_PROFILES already set:", envGet(ENV, "COMPOSE_PROFILES"));
}
if (envHasKey(ENV, "TS_AUTHKEY") && !/full|tailscale/.test(envGet(ENV, "COMPOSE_PROFILES"))) {
  const cur = envGet(ENV, "COMPOSE_PROFILES");
  if (!DRY_RUN) {
    const src = readFileSync(ENV, "utf8").replace(
      /^COMPOSE_PROFILES=.*$/m,
      `COMPOSE_PROFILES=${cur},tailscale`
    );
    writeFileSync(ENV, src);
  }
  log("Appended tailscale profile because TS_AUTHKEY is set");
}

// 4. Materialise node id BEFORE Compose interpolation so orchestrator and
// whoami receive the exact same identity.
if (envGet(ENV, "CONSUL_ENABLE") === "1" || envGet(ENV, "SSH_ENABLE") === "1") {
  const provider = process.env.GITHUB_RUN_ID ? "github" : (process.env.BUILD_BUILDID ? "azure" : "local");
  const runId = process.env.GITHUB_RUN_ID || process.env.BUILD_BUILDID || process.env.HOSTNAME || "node";
  const attempt = process.env.GITHUB_RUN_ATTEMPT || process.env.SYSTEM_JOBATTEMPT || "1";
  const generated = `${provider}-${runId}-${attempt}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const nodeId = envGet(ENV, "ORCH_NODE_ID") || generated;
  if (!DRY_RUN) {
    if (!envGet(ENV, "ORCH_NODE_ID")) envAppend(`ORCH_NODE_ID=${nodeId}`);
    const content = readFileSync(ENV, "utf8");
    if (/^WHOAMI_NAME=/m.test(content)) writeFileSync(ENV, content.replace(/^WHOAMI_NAME=.*$/m, `WHOAMI_NAME=${nodeId}`));
    else envAppend(`WHOAMI_NAME=${nodeId}`);
  }
  appendEnv("ORCH_NODE_ID", nodeId);
  appendEnv("WHOAMI_NAME", nodeId);
  log(`Materialised shared identity ORCH_NODE_ID=WHOAMI_NAME=${nodeId}`);
}

// 5. Summary
if (GITHUB_STEP_SUMMARY) {
  appendFileSync(GITHUB_STEP_SUMMARY, `## Environment\n\n- Mode: ${ENV_FILE && envGet(ENV, "CF_TUNNEL_TOKEN") ? "named" : "quick"}\n- Profiles: ${envGet(ENV, "COMPOSE_PROFILES")}\n\n`);
}
