#!/usr/bin/env node
// scripts/runners/setup-env.mjs
// CI: materialise .env from secret or fallback, detect mode, ensure profiles.
//
// Exports MODE to GITHUB_ENV (named | quick).
// Env vars: ENV_FILE (secret), GITHUB_ENV, GITHUB_STEP_SUMMARY.
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const ENV = resolve(ROOT, ".env");
const ENV_CI = resolve(ROOT, ".env.ci");
const GITHUB_ENV = process.env.GITHUB_ENV;
const GITHUB_STEP_SUMMARY = process.env.GITHUB_STEP_SUMMARY;
const ENV_FILE = process.env.ENV_FILE || "";

function appendEnv(key, val) {
  if (GITHUB_ENV) appendFileSync(GITHUB_ENV, `${key}=${val}\n`);
}

function envKeys() {
  if (!existsSync(ENV)) return;
  const keys = readFileSync(ENV, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => l.split("=")[0]);
  console.log("--- .env keys ---");
  keys.forEach((k) => console.log(k));
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
if (ENV_FILE) {
  writeFileSync(ENV, ENV_FILE + "\n");
  console.log("Wrote .env from secrets.ENV_FILE");
  if (envHasKey("TUNNEL_TOKEN")) {
    appendEnv("MODE", "named");
    console.log("Named Cloudflare tunnel mode (TUNNEL_TOKEN set)");
  } else {
    appendEnv("MODE", "quick");
    console.log("Quick tunnel mode (no TUNNEL_TOKEN in ENV_FILE)");
  }
} else {
  copyFileSync(ENV_CI, ENV);
  appendEnv("MODE", "quick");
  console.log("secrets.ENV_FILE not set — using .env.ci + quick tunnel");
}
envKeys();

// 2. Ensure required Tinyauth vars for quick mode
if (!ENV_FILE || !envHasKey("TUNNEL_TOKEN")) {
  if (!envHasKey("TINYAUTH_AUTH_USERS")) {
    envAppend('TINYAUTH_AUTH_USERS=user:$$2a$$10$$UdLYoJ5lgPsC0RKqYH/jMua7zIn0g9kPqWmhYayJYLaZQ/FTmH2/u');
  }
  if (!envHasKey("TINYAUTH_AUTH_SECURECOOKIE")) {
    envAppend("TINYAUTH_AUTH_SECURECOOKIE=false");
  }
}

// 3. Ensure COMPOSE_PROFILES
if (!envHasKey("COMPOSE_PROFILES")) {
  envAppend("COMPOSE_PROFILES=core");
  console.log("Added COMPOSE_PROFILES=core");
} else {
  console.log("COMPOSE_PROFILES already set:", envGet("COMPOSE_PROFILES"));
}
if (envHasKey("TS_AUTHKEY") && !/full|tailscale/.test(envGet("COMPOSE_PROFILES"))) {
  const cur = envGet("COMPOSE_PROFILES");
  const src = readFileSync(ENV, "utf8").replace(
    /^COMPOSE_PROFILES=.*$/m,
    `COMPOSE_PROFILES=${cur},tailscale`
  );
  writeFileSync(ENV, src);
  console.log("Appended tailscale profile because TS_AUTHKEY is set");
}

// 4. Summary
if (GITHUB_STEP_SUMMARY) {
  appendFileSync(GITHUB_STEP_SUMMARY, `## Environment\n\n- Mode: ${ENV_FILE && envHasKey("TUNNEL_TOKEN") ? "named" : "quick"}\n- Profiles: ${envGet("COMPOSE_PROFILES")}\n\n`);
}
