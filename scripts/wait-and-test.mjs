#!/usr/bin/env node
// scripts/wait-and-test.mjs
// CI: wait for services, discover public URL, verify external access.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectDocker, dockerCmd } from "./runners/_docker.mjs";
import { envGet } from "./lib/env-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
process.chdir(ROOT);

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");

const log = (...a) => {
  if (!SILENT) console.log(...a);
};

const docker = DRY_RUN ? { available: true, cmd: "docker", via: "dry-run" } : detectDocker();
if (!docker.available) {
  console.error("ERROR: Docker not found.");
  process.exit(1);
}

const ENV = resolve(ROOT, ".env");

const TIMEOUT = parseInt(process.env.TEST_TIMEOUT || "180", 10);
const ACCEPT_RE = /^(200|301|302|307|401|403)$/;

function sh(cmd) {
  if (DRY_RUN) return "";
  try {
    return execSync(cmd, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

// HTTP probe bằng fetch native (Node 18+), không phụ thuộc binary curl.
// Giữ hành vi cũ: no redirect follow, timeout 10s mặc định, lưu body ra /tmp để in sau.
async function httpCode(url, timeoutMs = 10000) {
  if (DRY_RUN) return "200";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: "manual", signal: ctrl.signal });
    let body = "";
    try {
      body = await res.text();
    } catch {}
    try {
      writeFileSync("/tmp/proxy-stack-body.txt", body);
    } catch {}
    // Node cũ có thể trả "opaqueredirect" với status=0 khi gặp 3xx và redirect:"manual".
    // Chuẩn hóa về "302" để ACCEPT_RE (301|302|307) vẫn coi redirect là hợp lệ.
    if (res.type === "opaqueredirect") return "302";
    const code = String(res.status);
    return /^\d{3}$/.test(code) ? code : "000";
  } catch {
    return "000";
  } finally {
    clearTimeout(timer);
  }
}

if (DRY_RUN) {
  log("[DRY RUN] Would wait for caddy, whoami, cloudflared");
  log("[DRY RUN] Would probe local Caddy on 8080/80");
  log("[DRY RUN] Would extract public URL and verify external access");
  process.exit(0);
}

// ── Wait for core containers ─────────────────────────────────────
log("==> Waiting for core containers...");
const start = Date.now();
const deadline = start + TIMEOUT * 1000;
while (Date.now() < deadline) {
  const running = sh(dockerCmd("compose ps --status running --services"));
  if (["caddy", "whoami", "cloudflared"].every((s) => running.split("\n").includes(s))) {
    log("    caddy, whoami, cloudflared are running");
    break;
  }
  execSync("sleep 1", { stdio: "ignore" });
}

const running = sh(dockerCmd("compose ps --status running --services"));
const missing = ["caddy", "whoami", "cloudflared"].filter((s) => !running.split("\n").includes(s));
if (missing.length > 0) {
  console.error(`ERROR: required services not running: ${missing.join(", ")}`);
  try {
    execSync(dockerCmd("compose ps -a"), { stdio: "inherit", cwd: ROOT });
  } catch {}
  for (const svc of missing) {
    console.error(`--- logs: ${svc} ---`);
    try {
      execSync(dockerCmd(`compose logs --no-color --tail=80 ${svc}`), { stdio: "inherit", cwd: ROOT });
    } catch {}
  }
  process.exit(1);
}

// ── Probe local Caddy ────────────────────────────────────────────
log("==> Probing local Caddy (host port)...");
let localOk = false;
for (let i = 0; i < 24; i++) {
  for (const port of [8080, 80]) {
    const code = await httpCode(`http://127.0.0.1:${port}/`, 3000);
    if (ACCEPT_RE.test(code)) {
      log(`    localhost:${port} → HTTP ${code}`);
      localOk = true;
      break;
    }
  }
  if (localOk) break;
  execSync("sleep 1", { stdio: "ignore" });
}

if (!localOk) {
  log("WARN: local Caddy not ready on :8080/:80 (continuing with public tunnel check)");
  try {
    execSync(dockerCmd("compose logs --no-color --tail=60 caddy"), { stdio: "inherit", cwd: ROOT });
  } catch {}
  try {
    execSync(dockerCmd("compose logs --no-color --tail=40 whoami"), { stdio: "inherit", cwd: ROOT });
  } catch {}
}

// ── Detect actual cloudflared mode ────────────────────────────────
// Do NOT trust CF_TUNNEL_TOKEN in .env — CI override may force --url
// (quick tunnel) while .env still carries the token. Check the running
// container command instead.
function detectCloudflaredMode() {
  try {
    const inspect = sh(dockerCmd("inspect --format '{{.Config.Cmd}}' cloudflared"));
    // Quick tunnel: command contains "--url" → ["tunnel","--protocol","http2","--edge-ip-version","4","--url","http://caddy:80"]
    // Named tunnel:  ["tunnel","--no-autoupdate","run"] — no "--url"
    if (/\burl\b/.test(inspect)) return "quick";
    return "named";
  } catch {
    // Fallback: check .env token (local prod without CI override)
    return envGet(ENV, "CF_TUNNEL_TOKEN") ? "named" : "quick";
  }
}

// ── Discover public URL ──────────────────────────────────────────
let publicUrl = process.env.PUBLIC_URL || "";

if (!publicUrl) {
  const actualMode = detectCloudflaredMode();
  const whoamiHost = envGet(ENV, "WHOAMI_HOST");
  const domain = envGet(ENV, "DOMAIN");

  if (actualMode === "named") {
    if (whoamiHost) {
      publicUrl = whoamiHost.replace(/^http:\/\//, "https://");
      if (!publicUrl.startsWith("https://") && !publicUrl.startsWith("http://")) {
        publicUrl = `https://${publicUrl}`;
      }
    } else if (domain) {
      publicUrl = `https://whoami.${domain}`;
    }
    log(`==> Named tunnel mode (detected) → testing ${publicUrl || "(unset)"}`);
  } else {
    log("==> Quick tunnel mode (detected) — will extract trycloudflare.com URL");
  }
}

if (!publicUrl) {
  log("==> Extracting Cloudflare quick-tunnel URL...");
  const cfExtract = resolve(ROOT, "cloudflare/scripts/extract-tunnel-url.mjs");
  if (existsSync(cfExtract)) {
    const extractTimeout = Math.min(TIMEOUT, 120);
    try {
      publicUrl = execSync(`node "${cfExtract}" ${extractTimeout} 1`, {
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: (extractTimeout + 10) * 1000,
      })
        .toString()
        .trim();
    } catch {
      console.error("ERROR: failed to extract trycloudflare.com URL");
      try {
        execSync(dockerCmd("compose logs --no-color cloudflared"), { stdio: "inherit", cwd: ROOT });
      } catch {}
      process.exit(1);
    }
  } else {
    console.error(`ERROR: missing ${cfExtract}`);
    process.exit(1);
  }
}

if (!publicUrl) {
  console.error("ERROR: could not determine PUBLIC_URL");
  try {
    execSync(dockerCmd("compose logs --no-color cloudflared"), { stdio: "inherit", cwd: ROOT });
  } catch {}
  try {
    execSync(dockerCmd("compose logs --no-color --tail=80 caddy"), { stdio: "inherit", cwd: ROOT });
  } catch {}
  process.exit(1);
}

// ── Verify external HTTP access ──────────────────────────────────
log(`==> Public URL: ${publicUrl}`);
log("==> Verifying external HTTP access (no redirect follow)...");

let extOk = false;
let lastCode = "000";
for (let i = 1; i <= 36; i++) {
  lastCode = await httpCode(`${publicUrl}/`, 10000);
  log(`    attempt ${i}: HTTP ${lastCode}`);
  if (ACCEPT_RE.test(lastCode)) {
    extOk = true;
    break;
  }

  // Debug probe at attempts 6 and 18: kiem tra origin http://caddy:80 TU TRONG
  // network proxy. Dung `compose exec cloudflared` (container da o san trong
  // network proxy) chay wget — khong can pull image curl tu ngoai.
  if (i === 6 || i === 18) {
    log("    (debug) probe http://caddy:80 from proxy network:");
    try {
      const out = execSync(dockerCmd("compose exec -T cloudflared wget -q -S -O /dev/null http://caddy:80/"), {
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      }).toString();
      const m = out.match(/HTTP\/\S+\s+(\d{3})/);
      log(`    (debug) caddy_origin HTTP ${m ? m[1] : "unknown"}`);
    } catch (e) {
      const errStr = ((e && e.stderr) || "").toString();
      const m = errStr.match(/HTTP\/\S+\s+(\d{3})/);
      if (m) log(`    (debug) caddy_origin HTTP ${m[1]}`);
      else log("    (debug) origin probe failed");
    }
  }
  execSync("sleep 2", { stdio: "ignore" });
}

if (!extOk) {
  console.error(`ERROR: public URL did not become reachable (last HTTP ${lastCode})`);
  try {
    execSync(dockerCmd("compose logs --no-color cloudflared"), { stdio: "inherit", cwd: ROOT });
  } catch {}
  try {
    execSync(dockerCmd("compose logs --no-color --tail=100 caddy"), { stdio: "inherit", cwd: ROOT });
  } catch {}
  try {
    execSync(dockerCmd("compose logs --no-color --tail=50 whoami"), { stdio: "inherit", cwd: ROOT });
  } catch {}
  try {
    execSync(dockerCmd("compose logs --no-color --tail=40 tinyauth"), { stdio: "inherit", cwd: ROOT });
  } catch {}
  process.exit(1);
}

log("");
log("SUCCESS: stack is reachable from the outside");
log(`  URL:  ${publicUrl}`);
log(`  HTTP: ${lastCode}`);

if (existsSync("/tmp/proxy-stack-body.txt")) {
  const body = readFileSync("/tmp/proxy-stack-body.txt", "utf8").split("\n").slice(0, 20).join("\n");
  log("  Body (first 20 lines):");
  log(body);
}

writeFileSync("/tmp/proxy-stack-public-url.txt", publicUrl);
writeFileSync(resolve(ROOT, "public-url.txt"), publicUrl);
