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
import { envGet, envHasKey, envKeys, exportCiVar, maskCiSecret, parseEnv } from "../lib/env-utils.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const ENV = resolve(ROOT, ".env");
const ENV_CI = resolve(ROOT, ".env.ci");
const GITHUB_STEP_SUMMARY = process.env.GITHUB_STEP_SUMMARY;
const IS_AZURE = process.env.TF_BUILD === "True" || process.env.TF_BUILD === "true" || !!process.env.BUILD_BUILDID;
const ENV_FILE = process.env.ENV_FILE || "";

function appendEnv(key, val) {
  if (!DRY_RUN) exportCiVar(key, val);
  log(`[env] ${key}=${val}`);
}

function showEnvKeys() {
  const parsed = parseEnv(ENV);
  const keys = Object.keys(parsed);
  log("--- .env keys ---");
  for (const k of keys) {
    const v = parsed[k];
    const masked = "*".repeat(v.length);
    log(`env:${k} = ${masked} (${v.length} ký tự)`);
  }
}

function envAppend(line) {
  appendFileSync(ENV, line + "\n");
}

const SECRET_KEY_RE = /(TOKEN|SECRET|PASSWORD|PASS|AUTH|KEY|COOKIE|CREDENTIAL|CLIENT_ID|CLIENT_SECRET|USERS|SERVICE_ACCOUNT|ACCOUNT_ID)/i;
function maskAllSecrets() {
  const parsed = parseEnv(ENV);
  for (const [k, v] of Object.entries(parsed)) {
    if (SECRET_KEY_RE.test(k) && v) maskCiSecret(v);
  }
}

// 1. Write .env — three sources, checked in priority order:
//    a) DOTENVRTDB_URL  → dotenvrtdb pull from Firebase RTDB
//    b) ENV_FILE         → GitHub secret / inline blob
//    c) fallback         → .env.ci (quick tunnel)
const DOTENVRTDB_URL = process.env.DOTENVRTDB_URL || "";
if (DRY_RUN) {
  const dryEnv = DOTENVRTDB_URL ? {} : (ENV_FILE ? dotenv.parse(ENV_FILE) : {});
  const src = DOTENVRTDB_URL ? "dotenvrtdb RTDB" : (ENV_FILE ? "secrets.ENV_FILE" : ".env.ci");
  log(`[DRY RUN] Would write .env from: ${src}`);
  log(`[DRY RUN] Mode: ${dryEnv.CF_TUNNEL_TOKEN ? "named" : "quick"}`);
} else if (DOTENVRTDB_URL) {
  log("DOTENVRTDB_URL detected — pulling .env via dotenvrtdb …");
  try {
    execSync(`dotenvrtdb -e .env --pull -eUrl="${DOTENVRTDB_URL}"`, {
      cwd: ROOT,
      stdio: "inherit",
      timeout: 60_000,
    });
    log("dotenvrtdb pull complete — .env written");
  } catch (e) {
    console.error(`dotenvrtdb pull failed (code=${e.status ?? e.message})`);
    process.exit(1);
  }
  if (envGet(ENV, "CF_TUNNEL_TOKEN")) {
    appendEnv("MODE", "named");
    log("Named Cloudflare tunnel mode (CF_TUNNEL_TOKEN set)");
  } else {
    appendEnv("MODE", "quick");
    log("Quick tunnel mode (no CF_TUNNEL_TOKEN in pulled .env)");
  }
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
const envSource = DOTENVRTDB_URL ? "DOTENVRTDB_URL" : (ENV_FILE ? "ENV_FILE" : ".env.ci");
log(`ENV source: ${envSource}`);
maskAllSecrets();
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

// 5a. Sinh ORCH_META_* từ biến GitHub Actions / Azure Pipelines để ghi metadata
// runner vào RTDB (phân biệt các runner, biết runner nào đang chạy).
if (envGet(ENV, "CONSUL_ENABLE") === "1" || envGet(ENV, "SSH_ENABLE") === "1") {
  // GitHub Actions: RUNNER_NAME, RUNNER_OS, RUNNER_ARCH, RUNNER_TRACKING_ID,
  // GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_WORKFLOW, GITHUB_JOB, GITHUB_REF,
  // GITHUB_REPOSITORY, GITHUB_SHA.
  const ghMeta = {
    RUNNER_NAME: process.env.RUNNER_NAME,
    RUNNER_OS: process.env.RUNNER_OS,
    RUNNER_ARCH: process.env.RUNNER_ARCH,
    RUNNER_TRACKING_ID: process.env.RUNNER_TRACKING_ID,
    GITHUB_RUN_ID: process.env.GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT: process.env.GITHUB_RUN_ATTEMPT,
    GITHUB_WORKFLOW: process.env.GITHUB_WORKFLOW,
    GITHUB_JOB: process.env.GITHUB_JOB,
    GITHUB_REF: process.env.GITHUB_REF,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    GITHUB_SHA: process.env.GITHUB_SHA,
  };
  // Azure Pipelines fallback: AGENT_NAME, AGENT_OS, BUILD_BUILDID, ...
  if (process.env.TF_BUILD === "True" || process.env.BUILD_BUILDID) {
    ghMeta.RUNNER_NAME = ghMeta.RUNNER_NAME || process.env.AGENT_NAME;
    ghMeta.RUNNER_OS = ghMeta.RUNNER_OS || process.env.AGENT_OS;
    ghMeta.RUNNER_ARCH = ghMeta.RUNNER_ARCH || process.env.AGENT_ARCHITECTURE;
    ghMeta.GITHUB_RUN_ID = ghMeta.GITHUB_RUN_ID || process.env.BUILD_BUILDID;
    ghMeta.GITHUB_RUN_ATTEMPT = ghMeta.GITHUB_RUN_ATTEMPT || process.env.SYSTEM_JOBATTEMPT;
    ghMeta.GITHUB_WORKFLOW = ghMeta.GITHUB_WORKFLOW || process.env.BUILD_DEFINITIONNAME;
    ghMeta.GITHUB_JOB = ghMeta.GITHUB_JOB || process.env.SYSTEM_JOBDISPLAYNAME;
    ghMeta.GITHUB_REF = ghMeta.GITHUB_REF || process.env.BUILD_SOURCEBRANCH;
    ghMeta.GITHUB_REPOSITORY = ghMeta.GITHUB_REPOSITORY || process.env.BUILD_REPOSITORY_NAME;
    ghMeta.GITHUB_SHA = ghMeta.GITHUB_SHA || process.env.BUILD_SOURCEVERSION;
  }
  for (const [k, v] of Object.entries(ghMeta)) {
    if (v === undefined || v === "") continue;
    const metaKey = `ORCH_META_${k}`;
    if (!envGet(ENV, metaKey)) {
      if (!DRY_RUN) envAppend(`${metaKey}=${v}`);
    }
    appendEnv(metaKey, v);
  }
  log(`Sinh ORCH_META_* từ CI runner vars (runner=${ghMeta.RUNNER_NAME || "n/a"})`);
}

// 5. Summary
if (GITHUB_STEP_SUMMARY) {
  appendFileSync(GITHUB_STEP_SUMMARY, `## Environment\n\n- Mode: ${ENV_FILE && envGet(ENV, "CF_TUNNEL_TOKEN") ? "named" : "quick"}\n- Profiles: ${envGet(ENV, "COMPOSE_PROFILES")}\n\n`);
}
if (IS_AZURE) {
  const mode = ENV_FILE && envGet(ENV, "CF_TUNNEL_TOKEN") ? "named" : "quick";
  log(`[azure] Mode: ${mode}`);
  log(`[azure] Profiles: ${envGet(ENV, "COMPOSE_PROFILES")}`);
  console.log(`##vso[task.setvariable variable=MODE]${mode}`);
}
