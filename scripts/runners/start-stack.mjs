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

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };
const err = (...a) => { if (!SILENT) console.error(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const MODE = process.env.MODE || "quick";

process.chdir(ROOT);

function run(cmd) {
  if (DRY_RUN) { log(`[DRY RUN] ${cmd}`); return; }
  execSync(cmd, { stdio: SILENT ? "ignore" : "inherit", cwd: ROOT });
}
function sh(cmd) {
  if (DRY_RUN) return "";
  return execSync(cmd, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
}

// chmod scripts
try { run("bash -c 'chmod +x scripts/*.sh */scripts/*.sh 2>/dev/null || chmod +x scripts/*.sh'"); } catch {}

// Show active profiles
const env = existsSync(resolve(ROOT, ".env")) ? readFileSync(resolve(ROOT, ".env"), "utf8") : "";
const m = env.match(/^COMPOSE_PROFILES=(.+)$/m);
log("Active COMPOSE_PROFILES:", m ? m[1] : "(unset)");

// Start stack
if (MODE === "named") {
  run("docker compose up -d --remove-orphans");
} else {
  log("Resolved cloudflared service (must use --url, not run-with-token):");
  if (!DRY_RUN) {
    try {
      const cfg = sh("docker compose -f docker-compose.yml -f docker-compose.ci.yml config");
      const block = cfg.split("\n");
      let printing = false;
      for (const line of block) {
        if (/^  cloudflared:/.test(line)) printing = true;
        else if (printing && /^  [a-z]/.test(line)) break;
        if (printing) log(line);
      }
    } catch {}
  }
  run("docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d --remove-orphans");
}

run("docker compose ps");

if (DRY_RUN) {
  log("[DRY RUN] Would check cloudflared is running after 3s");
  process.exit(0);
}

// Fail fast if cloudflared is not running
execSync("sleep 3", { stdio: "inherit" });
try {
  const running = sh("docker compose ps --status running --services");
  if (!running.split("\n").includes("cloudflared")) throw new Error("not running");
} catch {
  err("ERROR: cloudflared is not running after up");
  try { run("docker compose ps -a"); } catch {}
  try { run("docker compose logs --no-color cloudflared"); } catch {}
  process.exit(1);
}
