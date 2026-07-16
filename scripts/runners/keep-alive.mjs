#!/usr/bin/env node
// scripts/runners/keep-alive.mjs
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { detectDocker, dockerCmd } from "./_docker.mjs";
import { parseEnv } from "../lib/env-utils.mjs";
import { redactSecrets } from "../lib/redact-utils.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const CONFIG_FILE = resolve(__dirname, "keep-alive-config.jsonc");
const env = { ...parseEnv(resolve(ROOT, ".env")), ...process.env };
const COOKIE_FILE = resolve(tmpdir(), `tinyauth-cookies-${process.pid}.txt`);

process.chdir(ROOT);

function loadConfig() {
  const defaults = { default_keep_minutes: 5, default_interval_seconds: 30, services: [], curl_timeout_seconds: 12 };
  if (!existsSync(CONFIG_FILE)) return defaults;
  return { ...defaults, ...parse(readFileSync(CONFIG_FILE, "utf8")) };
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sh(cmd) {
  if (DRY_RUN) return "";
  try {
    return execSync(cmd, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  } catch (e) {
    return (e.stdout || e.stderr || "").toString().trim();
  }
}

function expand(value) {
  return String(value || "").replace(/\$\{([A-Z_][A-Z0-9_]*)(:-([^}]*))?\}/g, (_, key, _fallbackExpr, fallback) => env[key] || fallback || "");
}

function splitUrls(value) {
  return expand(value).split(",").map((url) => url.trim()).filter(Boolean);
}

function authUrl() {
  return env.TINYAUTH_APPURL || env.CADDY_TINYAUTH_HOST || env.TINYAUTH_HOST || "";
}

function serviceUrls(config) {
  const urls = [];
  for (const service of config.services || []) {
    const raw = service.env?.map((key) => env[key]).find(Boolean) || service.fallback || "";
    for (const url of splitUrls(raw)) urls.push({ service: service.name, url });
  }
  return urls;
}

function login(timeout) {
  const url = authUrl();
  const username = env.TINYAUTH_CI_USER;
  const password = env.TINYAUTH_CI_PASSWORD;
  log(`[auth] url=${url || "(missing)"} user=${username || "(missing)"} password=${password ? "<hidden>" : "(missing)"}`);
  if (!url || !username || !password) {
    log("[auth] skipped: missing TINYAUTH_APPURL / TINYAUTH_CI_USER / TINYAUTH_CI_PASSWORD");
    return { ok: false, reason: "config" };
  }
  const bodyFile = resolve(tmpdir(), `tinyauth-login-${process.pid}.json`);
  const headersFile = resolve(tmpdir(), `tinyauth-login-${process.pid}.headers`);
  const responseFile = resolve(tmpdir(), `tinyauth-login-${process.pid}.body`);
  writeFileSync(bodyFile, JSON.stringify({ username, password }));
  const cmd = `curl -k -sS -D "${headersFile}" -c "${COOKIE_FILE}" -o "${responseFile}" -w "%{http_code}" --max-time ${timeout} -X POST -H "Content-Type: application/json" --data-binary "@${bodyFile}" "${url.replace(/\/$/, "")}/api/login"`;
  if (DRY_RUN) { log(`[DRY RUN] ${cmd.replace(password, "<password>")}`); return { ok: true, reason: "dry-run" }; }

  // curl's own exit code (transport-level: DNS/connect/timeout) is separate from
  // the HTTP status it received (application-level: wrong creds, server error...).
  let code = "ERR";
  let curlExit = 0;
  try {
    code = execSync(cmd, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  } catch (e) {
    curlExit = e.status ?? 1;
    code = (e.stdout || "").toString().trim() || "ERR";
  }

  if (curlExit !== 0) {
    // curl never got a response at all: host unreachable, connection refused, timed out...
    // this is "mạng chưa thông", not an auth problem — no HTTP status exists to blame.
    log(`[auth] network error reaching ${url} (curl exit code ${curlExit})`);
    return { ok: false, reason: "network", curlExit };
  }

  log(`[auth] ${url}/api/login -> HTTP ${code}`);
  showHttpDebug("auth", headersFile, responseFile);
  log(`[auth] cookies=${cookieNames().join(",") || "(none)"}`);

  if (code === "401" || code === "403" || code === "422") {
    return { ok: false, reason: "credentials", httpCode: code };
  }
  if (!/^[23]\d\d$/.test(code) && !cookieHeader()) {
    return { ok: false, reason: "unexpected", httpCode: code };
  }
  if (!existsSync(COOKIE_FILE) || !cookieHeader()) {
    // Login endpoint said success but never actually gave us a session cookie.
    log("[auth] login returned success but no cookie was written — treating as failed");
    return { ok: false, reason: "no-cookie" };
  }
  return { ok: true, reason: "ok" };
}

function verifyCookie(urls, timeout) {
  const probe = urls[0];
  if (!probe) return true;
  const header = cookieHeader();
  const cookie = header ? `-H "Cookie: ${header}"` : "";
  const headersFile = resolve(tmpdir(), `tinyauth-verify-${process.pid}.headers`);
  const responseFile = resolve(tmpdir(), `tinyauth-verify-${process.pid}.body`);
  const cmd = `curl -k -sS ${cookie} -D "${headersFile}" -o "${responseFile}" -w "%{http_code}" --max-time ${timeout} "${probe.url}"`;
  const code = sh(cmd) || "ERR";
  log(`[auth] cookie check via ${probe.url} -> HTTP ${code}`);
  showHttpDebug("auth-verify", headersFile, responseFile);
  if (code === "401" || code === "403") {
    log("[auth] login succeeded but cookie doesn't authorize requests — check that TINYAUTH_APPURL shares a parent domain with the app URLs");
    return false;
  }
  return true;
}

function cookieRows() {
  if (!existsSync(COOKIE_FILE)) return "";
  return readFileSync(COOKIE_FILE, "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("\t"))
    .filter((cols) => cols.length >= 7);
}

function cookieNames() {
  return cookieRows().map((cols) => cols[5]);
}

function cookieHeader() {
  return cookieRows()
    .map((cols) => `${cols[5]}=${cols[6]}`)
    .join("; ");
}

function mask(value) {
  return String(value || "")
    .replace(/(set-cookie:\s*[^=;\s]+)=([^;\r\n]+)/gi, "$1=<hidden>")
    .replace(/(cookie:\s*)([^\r\n]+)/gi, "$1<hidden>")
    .replace(/("password"\s*:\s*")[^"]+/gi, "$1<hidden>")
    .replace(/(token|secret|session|auth|password)=([^;&\s]+)/gi, "$1=<hidden>");
}

function showHttpDebug(label, headersFile, responseFile) {
  const headers = existsSync(headersFile) ? readFileSync(headersFile, "utf8").split(/\r?\n/).filter(Boolean).slice(0, 20).join("\n") : "";
  const body = existsSync(responseFile) ? readFileSync(responseFile, "utf8").slice(0, 500) : "";
  log(`[${label}] response_headers:\n${mask(headers) || "(none)"}`);
  log(`[${label}] response_body_sample=${mask(body) || "(empty)"}`);
}

function curlUrl(item, timeout, useCookie) {
  const header = useCookie ? cookieHeader() : "";
  const cookie = header ? `-H "Cookie: ${header}"` : "";
  const headersFile = resolve(tmpdir(), `keep-alive-${process.pid}-${item.service}.headers`);
  const responseFile = resolve(tmpdir(), `keep-alive-${process.pid}-${item.service}.body`);
  const cmd = `curl -k -sS ${cookie} -D "${headersFile}" -o "${responseFile}" -w "%{http_code}" --max-time ${timeout} "${item.url}"`;
  if (DRY_RUN) return log(`[DRY RUN] ${cmd}`);
  const code = sh(cmd) || "ERR";
  log(`[url] ${item.service} ${item.url} ${code} cookie_names=${useCookie ? cookieNames().join(",") || "(none)" : "(disabled)"}`);
  showHttpDebug(item.service, headersFile, responseFile);
  if (code !== "200") process.exitCode = 1;
}

function runningContainers() {
  const rows = sh(dockerCmd('ps --format "{{.ID}}\\t{{.Names}}"')).split(/\r?\n/).filter(Boolean);
  return rows.map((row) => {
    const [id, name] = row.split("\t");
    return { id, name };
  });
}

function showLogs(since) {
  const containers = runningContainers();
  log("[containers]");
  log(containers.map((c) => `${c.id} ${c.name}`).join("\n") || "(none)");
  for (const c of containers) {
    log(`===== ${c.name} logs since ${since} =====`);
    const out = sh(dockerCmd(`logs --timestamps --since "${since}" ${c.id}`));
    log(redactSecrets(out || "(no new logs)"));
  }
}

const config = loadConfig();
const keepSeconds = Math.round(num(env.KEEP_SECONDS, num(env.KEEP_MIN, num(env.KEEP_ALIVE_MINUTES, config.default_keep_minutes)) * 60));
const intervalSeconds = Math.round(num(env.KEEP_INTERVAL_SECONDS, num(env.INTERVAL_SECONDS, num(env.INTERVAL_MIN, config.default_interval_seconds / 60) * 60)));
const publicUrl = existsSync(resolve(ROOT, "public-url.txt")) ? readFileSync(resolve(ROOT, "public-url.txt"), "utf8").trim() : "unknown";

if (!detectDocker().available) {
  console.error("ERROR: Docker not found.");
  process.exit(1);
}

log(`Keeping stack alive for ${keepSeconds}s, heartbeat every ${intervalSeconds}s. URL: ${publicUrl}`);
const loginResult = login(config.curl_timeout_seconds);
if (!loginResult.ok) log(`[auth] not authenticated (reason: ${loginResult.reason}) — service checks will run without a cookie and may show 401s`);
const initialUrls = serviceUrls(config);
const hasCookie = loginResult.ok && Boolean(cookieHeader());
if (hasCookie) verifyCookie(initialUrls, config.curl_timeout_seconds);
const loggedIn = hasCookie;

let elapsed = 0;
let since = new Date().toISOString();
while (elapsed < keepSeconds) {
  const sleepSeconds = Math.min(intervalSeconds, keepSeconds - elapsed);
  if (!DRY_RUN) execSync(`sleep ${sleepSeconds}`, { stdio: "ignore" });
  elapsed += sleepSeconds;
  log(`[heartbeat] ${new Date().toISOString()} ${elapsed}/${keepSeconds}s`);
  const ps = sh(dockerCmd("compose ps"));
  if (ps) log(ps);
  for (const item of serviceUrls(config)) curlUrl(item, config.curl_timeout_seconds, loggedIn);
  showLogs(since);
  since = new Date().toISOString();
  if (DRY_RUN) break;
}
