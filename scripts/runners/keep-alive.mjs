#!/usr/bin/env node
// scripts/runners/keep-alive.mjs
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

process.chdir(ROOT);

// Session cookie kept in memory — no cookie-jar file, no shell quoting of
// "-H Cookie: ..." strings, nothing that can be mis-escaped.
let sessionCookie = "";

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

function mask(value) {
  return String(value || "")
    .replace(/(set-cookie:\s*[^=;\s]+)=([^;\r\n]+)/gi, "$1=<hidden>")
    .replace(/(cookie:\s*)([^\r\n]+)/gi, "$1<hidden>")
    .replace(/("password"\s*:\s*")[^"]+/gi, "$1<hidden>")
    .replace(/(token|secret|session|auth|password)=([^;&\s]+)/gi, "$1=<hidden>");
}

function formatBody(body) {
  const trimmed = String(body || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("<")) return trimmed.split(/\r?\n/)[0];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  return trimmed.slice(0, 500);
}

function withTimeout(timeoutSeconds) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

function cookieNamesFromSetCookie(setCookies) {
  return setCookies.map((c) => c.split("=")[0]).join(",") || "(none)";
}

async function login(timeoutSeconds) {
  const url = authUrl();
  const username = env.TINYAUTH_CI_USER;
  const password = env.TINYAUTH_CI_PASSWORD;
  log(`[auth] url=${url || "(missing)"} user=${username || "(missing)"} password=${password ? "<hidden>" : "(missing)"}`);
  if (!url || !username || !password) {
    log("[auth] skipped: missing TINYAUTH_APPURL / TINYAUTH_CI_USER / TINYAUTH_CI_PASSWORD");
    return { ok: false, reason: "config" };
  }
  const endpoint = `${url.replace(/\/$/, "")}/api/user/login`;
  if (DRY_RUN) { log(`[DRY RUN] POST ${endpoint}`); return { ok: true, reason: "dry-run" }; }

  const { signal, cancel } = withTimeout(timeoutSeconds);
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal,
    });
  } catch (e) {
    // fetch() rejects for DNS failure, connection refused, TLS errors, or our
    // own AbortController timeout — none of these ever produced an HTTP
    // response, so this is "mạng chưa thông", never a credentials problem.
    log(`[auth] network error reaching ${url}: ${e.name}: ${e.message}`);
    return { ok: false, reason: "network", error: e.message };
  } finally {
    cancel();
  }

  const setCookies = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  const body = await res.text().catch(() => "");

  log(`[auth] ${endpoint} -> HTTP ${res.status}`);
  log(`[auth] response_body_sample=${mask(formatBody(body)) || "(empty)"}`);
  log(`[auth] set-cookie names=${cookieNamesFromSetCookie(setCookies)}`);

  if (res.status === 401 || res.status === 403 || res.status === 422) {
    return { ok: false, reason: "credentials", httpCode: res.status };
  }
  if (!(res.status >= 200 && res.status < 400)) {
    return { ok: false, reason: "unexpected", httpCode: res.status };
  }
  if (setCookies.length === 0) {
    // Login endpoint said success but never actually gave us a session cookie.
    log("[auth] login returned success but no Set-Cookie header — treating as failed");
    return { ok: false, reason: "no-cookie" };
  }

  sessionCookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  return { ok: true, reason: "ok" };
}

async function verifyCookie(urls, timeoutSeconds) {
  const probe = urls[0];
  if (!probe) return true;
  const { signal, cancel } = withTimeout(timeoutSeconds);
  let res;
  try {
    res = await fetch(probe.url, { headers: sessionCookie ? { Cookie: sessionCookie } : {}, signal });
  } catch (e) {
    log(`[auth] cookie check network error via ${probe.url}: ${e.name}: ${e.message}`);
    return false;
  } finally {
    cancel();
  }
  log(`[auth] cookie check via ${probe.url} -> HTTP ${res.status}`);
  if (res.status === 401 || res.status === 403) {
    log("[auth] login succeeded but cookie doesn't authorize requests — check that TINYAUTH_APPURL shares a parent domain with the app URLs");
    return false;
  }
  return true;
}

async function checkUrl(item, timeoutSeconds, useCookie) {
  if (DRY_RUN) { log(`[DRY RUN] GET ${item.url}`); return; }
  const { signal, cancel } = withTimeout(timeoutSeconds);
  let res;
  try {
    res = await fetch(item.url, { headers: useCookie && sessionCookie ? { Cookie: sessionCookie } : {}, signal });
  } catch (e) {
    // Same distinction here: a thrown error means the request never completed
    // (network/DNS/timeout), not that the service responded with an error.
    log(`[url] ${item.service} ${item.url} ERR network: ${e.name}: ${e.message}`);
    process.exitCode = 1;
    return;
  } finally {
    cancel();
  }
  const body = await res.text().catch(() => "");
  log(`[url] ${item.service} ${item.url} ${res.status} cookie=${useCookie ? (sessionCookie ? "sent" : "(none)") : "(disabled)"}`);
  log(`[${item.service}] response_body_sample=${mask(formatBody(body)) || "(empty)"}`);
  if (res.status !== 200) process.exitCode = 1;
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
const loginResult = await login(config.curl_timeout_seconds);
if (!loginResult.ok) log(`[auth] not authenticated (reason: ${loginResult.reason}) — service checks will run without a cookie and may show 401s`);
const initialUrls = serviceUrls(config);
const loggedIn = loginResult.ok && Boolean(sessionCookie) && await verifyCookie(initialUrls, config.curl_timeout_seconds);

let elapsed = 0;
let since = new Date().toISOString();
while (elapsed < keepSeconds) {
  const sleepSeconds = Math.min(intervalSeconds, keepSeconds - elapsed);
  if (!DRY_RUN) execSync(`sleep ${sleepSeconds}`, { stdio: "ignore" });
  elapsed += sleepSeconds;
  log(`[heartbeat] ${new Date().toISOString()} ${elapsed}/${keepSeconds}s`);
  const ps = sh(dockerCmd("compose ps"));
  if (ps) log(ps);
  for (const item of serviceUrls(config)) await checkUrl(item, config.curl_timeout_seconds, loggedIn);
  showLogs(since);
  since = new Date().toISOString();
  if (DRY_RUN) break;
}
