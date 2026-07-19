#!/usr/bin/env node
// tailscale/scripts/wait-ready.mjs
// Chạy SAU khi docker compose up + publish.mjs. Đợi tailscale online,
// detect hostname thật, ghi về .env, re-publish nếu hostname sai.
//
// KHÔNG block luồng chính — up.mjs / start-stack.mjs gọi fire-and-forget.
//
// Usage:
//   node tailscale/scripts/wait-ready.mjs [--env path] [--timeout ms] [--dry-run] [--silent]
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "../../scripts/lib/env-utils.mjs";
import { detectDocker } from "../../scripts/runners/_docker.mjs";
import { extractHostname } from "./lib/publish-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const envIdx = args.indexOf("--env");
const ENV_FILE = envIdx !== -1 ? resolve(args[envIdx + 1]) : resolve(ROOT, ".env");
const timeoutIdx = args.indexOf("--timeout");
const TIMEOUT_MS = timeoutIdx !== -1 ? Number(args[timeoutIdx + 1]) || 90_000 : 90_000;

const log = (...a) => { if (!SILENT) console.log(...a); };
const warn = (...a) => { if (!SILENT) console.warn(...a); };

function dockerExec(subcmd, { capture = false } = {}) {
  if (DRY_RUN) { log(`[DRY RUN] docker ${subcmd}`); return { ok: true, out: "" }; }
  const docker = detectDocker();
  if (!docker.available) return { ok: false, out: "Docker unavailable" };
  const full = `${docker.cmd} ${subcmd}`;
  try {
    const out = execSync(full, { cwd: ROOT, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", timeout: 15_000 });
    return { ok: true, out: capture ? String(out || "").trim() : "" };
  } catch (e) {
    return { ok: false, out: e.stderr ? String(e.stderr) : e.message };
  }
}

function sleep(ms) { execSync(`sleep ${ms / 1000}`); }

function writeEnvVar(file, key, value) {
  if (DRY_RUN) { log(`[DRY RUN] writeEnv ${key}=${value}`); return; }
  try {
    let content = existsSync(file) ? readFileSync(file, "utf8") : "";
    const lines = content ? content.split(/\n/) : [];
    const line = `${key}=${value}`;
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
    writeFileSync(file, `${lines.join("\n").replace(/\n*$/, "")}\n`, "utf8");
  } catch (e) {
    warn(`WARN: không ghi được ${key} vào ${file}: ${e.message}`);
  }
}

// ── Main ──
log(`[wait-ready] Đợi tailscale online (timeout ${TIMEOUT_MS / 1000}s)...`);

const deadline = Date.now() + TIMEOUT_MS;
let ready = false;
while (Date.now() < deadline) {
  const { ok, out } = dockerExec("compose exec -T tailscale tailscale status --json", { capture: true });
  if (ok && out) {
    try {
      const st = JSON.parse(out);
      if (st?.Self?.Online || st?.BackendState === "Running") { ready = true; break; }
    } catch {}
  }
  sleep(3000);
}

if (!ready) {
  log("[wait-ready] Tailscale chưa online sau timeout — bỏ qua.");
  process.exit(0); // không fail stack
}

log("[wait-ready] Tailscale online.");

// ── Detect hostname ──
const env = parseEnv(ENV_FILE);
const fileHostname = (env.TS_HOSTNAME || "").trim();

const statusOut = dockerExec("compose exec -T tailscale tailscale status --json", { capture: true });
if (!statusOut.ok || !statusOut.out) {
  log("[wait-ready] Không lấy được tailscale status — bỏ qua.");
  process.exit(0);
}

const realHost = extractHostname(statusOut.out);
if (!realHost) {
  log("[wait-ready] Không parse được hostname từ status — bỏ qua.");
  process.exit(0);
}

log(`[wait-ready] Hostname hiện tại trong .env: "${fileHostname || "(chưa set)"}"`);
log(`[wait-ready] Hostname thật từ tailscale:   "${realHost}"`);

if (realHost === fileHostname) {
  log("[wait-ready] Hostname đã đúng — không cần sửa.");
  process.exit(0);
}

// ── Ghi hostname mới về .env ──
log(`[wait-ready] Cập nhật TS_HOSTNAME: "${fileHostname || "(chưa set)"}" → "${realHost}"`);
writeEnvVar(ENV_FILE, "TS_HOSTNAME", realHost);

// ── Re-publish để cập nhật serve.json với hostname mới ──
const publishMode = (env.TS_PUBLISH_MODE || "off").toLowerCase();
if (publishMode !== "off") {
  log(`[wait-ready] Re-publish với hostname mới (mode=${publishMode})...`);
  try {
    const nodeBin = process.execPath;
    const publishScript = resolve(__dirname, "publish.mjs");
    const dryFlag = DRY_RUN ? " --dry-run" : "";
    execSync(`${nodeBin} ${publishScript}${dryFlag}`, { cwd: ROOT, stdio: "inherit", timeout: 60_000 });
    log("[wait-ready] Re-publish xong.");
  } catch (e) {
    warn(`[wait-ready] Re-publish lỗi (bỏ qua): ${e.message}`);
  }
} else {
  log("[wait-ready] TS_PUBLISH_MODE=off — bỏ qua re-publish.");
}

log("[wait-ready] Hoàn tất.");
