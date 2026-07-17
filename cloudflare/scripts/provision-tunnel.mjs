#!/usr/bin/env node
// cloudflare/scripts/provision-tunnel.mjs
// Provision Cloudflare named tunnel + DNS records — 100% API, no dashboard.
//
// Reads .env for DOMAIN + CF_* vars. Creates tunnel, gets token, configures
// ingress, creates DNS CNAME records. Writes results back to .env.
//
// Usage:
//   node cloudflare/scripts/provision-tunnel.mjs [--env path] [--delete-connections] [--dry-run] [--silent]
//
// Requires: npm install dotenv jsonc-parser
//
// Flags:
//   --env path    Path to .env file (default: project root .env)
//   --delete-connections
//                 Delete all active cloudflared connectors for CF_TUNNEL_ID, then exit
//   --dry-run     Show what would be done, no API calls or .env writes
//   --silent      Skip confirmation prompt, run directly
//
// Env vars (from .env):
//   DOMAIN            required — root domain (e.g. example.com)
//   CF_API_TOKEN      preferred — scoped API Token (full permissions)
//   CF_API_EMAIL      alternative — email (with CF_API_KEY_GLOBAL or CF_API_KEY)
//   CF_API_KEY_GLOBAL alternative — Global API Key, preferred over CF_API_KEY
//   CF_API_KEY        alternative — Global API Key fallback (with CF_API_EMAIL)
//   CF_ACCOUNT_ID     optional — auto-resolved from API if missing
//   CF_ZONE_ID        optional — auto-resolved from DOMAIN if missing
//   CF_TUNNEL_NAME    optional — default: {DOMAIN}-tunnel
//   CF_TUNNEL_ID      optional — auto-created if missing
//   CF_TUNNEL_TOKEN   optional — auto-fetched if missing
//
// Docs:
//   - Tunnel API: https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/
//   - DNS API: https://developers.cloudflare.com/api/resources/dns/subresources/records/
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { parse } from "jsonc-parser";
import { parseEnv } from "../../scripts/lib/env-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const HOSTNAMES_FILE = resolve(__dirname, "hostnames.jsonc");
const API = "https://api.cloudflare.com/client/v4";

// ── CLI args ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const DELETE_CONNECTIONS = args.includes("--delete-connections");
const envIdx = args.indexOf("--env");
const ENV_FILE = envIdx !== -1 ? resolve(args[envIdx + 1]) : resolve(ROOT, ".env");
async function askConfirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(`${question} [y/N] `, (ans) => {
      rl.close();
      res(ans.toLowerCase() === "y");
    });
  });
}

// ── .env read/write ──────────────────────────────────────────────
function writeEnvVar(file, key, value) {
  if (DRY_RUN) return;
  let content = existsSync(file) ? readFileSync(file, "utf8") : "";
  const regex = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (regex.test(content)) {
    // Key exists — update in place
    content = content.replace(regex, line);
  } else {
    // Key new — insert after last CF_* line to keep CF_ vars grouped
    const lines = content.split("\n");
    let lastCfIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^CF_[A-Z0-9_]+=/.test(lines[i])) { lastCfIdx = i; break; }
    }
    if (lastCfIdx >= 0) {
      lines.splice(lastCfIdx + 1, 0, line);
      content = lines.join("\n");
    } else {
      content = content.trimEnd() + "\n" + line + "\n";
    }
  }
  writeFileSync(file, content);
}

// ── Cloudflare API ───────────────────────────────────────────────
function getGlobalApiKey(env) {
  return env.CF_API_KEY_GLOBAL || env.CF_API_KEY || "";
}

function getAuthHeaders(env) {
  if (env.CF_API_TOKEN) return { Authorization: `Bearer ${env.CF_API_TOKEN}` };
  const email = env.CF_API_EMAIL;
  const key = getGlobalApiKey(env);
  if (email && key) return { "X-Auth-Email": email, "X-Auth-Key": key };
  return null;
}

// A legacy Global API Key is a 37-char lowercase hex string. Newer/rolled
// keys use a "cfk_" prefixed scannable format instead. Anything that matches
// neither pattern is suspicious — most likely a scoped API Token pasted into
// the wrong variable, which causes Cloudflare error 6003/6103 because Tokens
// must be sent via the Authorization header, not X-Auth-Key.
function warnIfTokenLooksMisplaced(env) {
  const key = getGlobalApiKey(env);
  if (!key) return;
  const looksLegacy = /^[a-f0-9]{37}$/.test(key);
  const looksNewFormat = /^cfk_[A-Za-z0-9_-]{20,}$/.test(key);
  const masked = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : "(too short)";
  const src = env.CF_API_KEY_GLOBAL ? "CF_API_KEY_GLOBAL" : "CF_API_KEY";
  console.log(`   ${src} detected: length=${key.length}, value=${masked}`);
  if (!looksLegacy && !looksNewFormat) {
    console.log(`\n⚠  WARNING: ${src} doesn't match either known Global API Key format:`);
    console.log(`     - legacy: 37 lowercase hex chars`);
    console.log(`     - new:    cfk_ prefixed scannable format`);
    console.log(`   This strongly suggests it's actually an API Token (or was copied with`);
    console.log(`   extra whitespace/quotes/hidden characters). If so, this WILL cause`);
    console.log(`   "6003/6103 Invalid format for X-Auth-Key header" errors.`);
    console.log(`   Fix: go to dash.cloudflare.com/profile/api-tokens, scroll to the very`);
    console.log(`   bottom to the "Global API Key" section (NOT the "API Tokens" list above`);
    console.log(`   it), click View, and copy that value fresh into ${src}.`);
    console.log(`   Alternatively, if you actually have a Token, use CF_API_TOKEN instead.\n`);
  }
}

function buildCurl(method, path, body, headers) {
  const h = { "Content-Type": "application/json", ...headers };
  const parts = [`curl -sS -X ${method}`];
  for (const [k, v] of Object.entries(h)) {
    const safe = k === "Authorization" ? "Bearer ***" : k === "X-Auth-Key" ? "***" : v;
    parts.push(`  -H "${k}: ${safe}"`);
  }
  if (body) parts.push(`  -d '${JSON.stringify(body)}'`);
  parts.push(`  "${API}${path}"`);
  return parts.join(" \\\n");
}

async function cf(method, path, body, headers) {
  if (DRY_RUN) return { success: true, result: {}, curl: buildCurl(method, path, body, headers) };
  const curl = buildCurl(method, path, body, headers);
  const opts = { method, headers: { "Content-Type": "application/json", ...headers } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const resp = await fetch(`${API}${path}`, opts);
    const json = await resp.json();
    if (!json.success) {
      return { success: false, result: null, errors: json.errors, curl, status: resp.status };
    }
    return { success: true, result: json.result, curl };
  } catch (e) {
    return { success: false, result: null, errors: [{ message: e.message }], curl };
  }
}

function showStep(label, res) {
  if (res.success) {
    console.log(`  ✓  ${label}`);
  } else {
    console.log(`  ✗  ${label}  FAILED`);
    console.log(`     Errors:`);
    let sawHeaderError = false;
    for (const err of res.errors || []) {
      console.log(`       code=${err.code || "-"}  ${err.message}`);
      if (String(err.code) === "6003") sawHeaderError = true;
      for (const chained of err.error_chain || []) {
        console.log(`         ↳ code=${chained.code}  ${chained.message}`);
      }
    }
    if (sawHeaderError) {
      console.log(`     Hint: 6003 almost always means the auth headers don't match the credential type.`);
      console.log(`           If CF_API_KEY_GLOBAL / CF_API_KEY holds an API Token (not a Global API Key), move it to`);
      console.log(`           CF_API_TOKEN instead — Tokens require "Authorization: Bearer", not "X-Auth-Key".`);
    }
    console.log(
      `     Curl:\n${res.curl
        .split("\n")
        .map((l) => "       " + l)
        .join("\n")}`,
    );
  }
}

// ── Hostnames config ─────────────────────────────────────────────
function loadIngress(domain) {
  const fallback = ["auth", "files", "ttyd", "webssh", "whoami", "dozzle", "logs"]
    .map((hostname) => ({ hostname, service: "http://caddy:80" }));
  let rules = fallback;
  let catchAll = "http_status:404";
  if (existsSync(HOSTNAMES_FILE)) {
    const cfg = parse(readFileSync(HOSTNAMES_FILE, "utf8"));
    if (Array.isArray(cfg.ingress) && cfg.ingress.length) rules = cfg.ingress;
    else if (Array.isArray(cfg.hostnames)) rules = cfg.hostnames.map((hostname) => ({ hostname, service: cfg.service_url || "http://caddy:80" }));
    if (cfg.catch_all) catchAll = cfg.catch_all;
  }
  const ingress = rules.map((rule) => {
    if (!rule.hostname || !rule.service) throw new Error("Mỗi ingress cần hostname và service");
    const hostname = rule.hostname.includes(".") ? rule.hostname : `${rule.hostname}.${domain}`;
    if (!/^[a-zA-Z0-9.-]+$/.test(hostname)) throw new Error(`Ingress hostname không hợp lệ: ${hostname}`);
    if (!/^(https?|ssh|tcp):\/\//.test(rule.service)) throw new Error(`Ingress service không hợp lệ: ${rule.service}`);
    return { hostname, service: rule.service };
  });
  return { ingress, fqdns: ingress.map((x) => x.hostname), catchAll };
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log(`=== Cloudflare Tunnel Provisioner${DRY_RUN ? " (DRY RUN)" : ""} ===\n`);

  // 1. Read .env
  if (!existsSync(ENV_FILE)) {
    console.error(`ERROR: ${ENV_FILE} not found. Copy .env.example to .env first.`);
    process.exit(1);
  }
  const env = parseEnv(ENV_FILE);
  warnIfTokenLooksMisplaced(env);

  // 2. Validate required vars (defer exit to after env status display)
  const missing = [];
  if (!env.DOMAIN) missing.push("DOMAIN");
  if (!getAuthHeaders(env)) missing.push("CF_API_TOKEN (or CF_API_EMAIL + CF_API_KEY_GLOBAL / CF_API_KEY)");

  const domain = env.DOMAIN || "(not set)";
  const authHeaders = getAuthHeaders(env);
  const authType = env.CF_API_TOKEN ? "API Token" : env.CF_API_EMAIL && getGlobalApiKey(env) ? "Global API Key" : "(not configured)";

  if (DELETE_CONNECTIONS) {
    if (!env.CF_ACCOUNT_ID) missing.push("CF_ACCOUNT_ID");
    if (!env.CF_TUNNEL_ID) missing.push("CF_TUNNEL_ID");

    console.log("─".repeat(60));
    console.log(`Env file:        ${ENV_FILE}`);
    console.log(`Auth:            ${authType}`);
    console.log(`Account ID:      ${env.CF_ACCOUNT_ID || "(missing)"}`);
    console.log(`Tunnel ID:       ${env.CF_TUNNEL_ID || "(missing)"}`);
    console.log(`Action:          DELETE /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections`);
    console.log("─".repeat(60));

    if (DRY_RUN) {
      console.log(`\nAPI calls that would be made:`);
      console.log(`  DELETE /accounts/${env.CF_ACCOUNT_ID || "{account_id}"}/cfd_tunnel/${env.CF_TUNNEL_ID || "{tunnel_id}"}/connections`);
      console.log(`\n[DRY RUN] No API calls performed.`);
      return;
    }

    if (missing.length) {
      console.error(`\nERROR: missing required vars in .env — cannot proceed: ${missing.join(", ")}`);
      process.exit(1);
    }

    if (!SILENT) {
      const ok = await askConfirm("\nDelete all active tunnel connectors?");
      if (!ok) {
        console.log("Aborted.");
        return;
      }
    }

    const res = await cf("DELETE", `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${env.CF_TUNNEL_ID}/connections`, null, authHeaders);
    showStep("Deleted tunnel connections", res);
    if (!res.success) process.exit(1);
    return;
  }

  // Track what will be written / resolved
  const willWrite = []; // { key, value, reason }
  const willResolve = []; // { key, reason }

  // 3. Resolve account ID (from .env or API)
  let accountId = env.CF_ACCOUNT_ID || "";
  let accountAction = "from .env";
  if (!accountId) {
    accountId = "(will resolve from API)";
    accountAction = "resolve from API";
    willResolve.push({ key: "CF_ACCOUNT_ID", reason: "GET /accounts → first account" });
    willWrite.push({ key: "CF_ACCOUNT_ID", value: "<account_id>", reason: "auto-resolved" });
  }

  // 4. Resolve zone ID (existing or new)
  let zoneId = env.CF_ZONE_ID || "";
  let zoneAction = "from .env";
  if (!zoneId) {
    zoneId = "(will resolve from API)";
    zoneAction = "resolve from API";
    willResolve.push({ key: "CF_ZONE_ID", reason: `GET /zones?name=${domain}` });
    willWrite.push({ key: "CF_ZONE_ID", value: "<zone_id>", reason: "auto-resolved" });
  }

  // 5. Tunnel
  const tunnelName = env.CF_TUNNEL_NAME || `${domain}-tunnel`;
  let tunnelId = env.CF_TUNNEL_ID || "";
  let tunnelAction = "from .env";
  if (!tunnelId) {
    tunnelId = "(new)";
    tunnelAction = "create via API";
    willResolve.push({ key: "CF_TUNNEL_ID", reason: `POST /accounts/{id}/cfd_tunnel (name: ${tunnelName})` });
    willWrite.push({ key: "CF_TUNNEL_NAME", value: tunnelName, reason: "set alongside tunnel" });
    willWrite.push({ key: "CF_TUNNEL_ID", value: "<tunnel_id>", reason: "auto-created" });
    willWrite.push({ key: "CF_TUNNEL_TARGET", value: "<tunnel_id>.cfargotunnel.com", reason: "CNAME target for DNS" });
  }

  // 6. Token
  let tunnelToken = env.CF_TUNNEL_TOKEN || "";
  let tokenAction = "from .env";
  if (!tunnelToken) {
    tunnelToken = "(new)";
    tokenAction = "fetch from API";
    willResolve.push({ key: "CF_TUNNEL_TOKEN", reason: "GET /accounts/{id}/cfd_tunnel/{tunnel_id}/token" });
    willWrite.push({ key: "CF_TUNNEL_TOKEN", value: "<token>", reason: "auto-fetched" });
  }

  // 7. Hostnames
  const { ingress, fqdns, catchAll } = loadIngress(domain);

  // ── Confirmation summary ───────────────────────────────────────
  console.log("─".repeat(60));
  console.log(`Env file:        ${ENV_FILE}`);
  console.log(`Domain:          ${domain}`);
  console.log(`Auth:            ${authType}`);
  console.log(`Account ID:      ${accountId} (${accountAction})`);
  console.log(`Zone ID:         ${zoneId} (${zoneAction})`);
  console.log(`Tunnel name:     ${tunnelName}`);
  console.log(`Tunnel ID:       ${tunnelId} (${tunnelAction})`);
  console.log(`Tunnel token:    ${tunnelToken === "(new)" ? "(new)" : "<configured>"} (${tokenAction})`);
  console.log(`Tunnel target:   ${env.CF_TUNNEL_TARGET || `${tunnelId}.cfargotunnel.com`}`);
  console.log(`SSH transport:    plain Tunnel SSH (no Cloudflare Access service token)`);
  console.log(`Ingress:         ${ingress.length} rules`);
  for (const rule of ingress) console.log(`  ${rule.hostname} -> ${rule.service}`);
  console.log(`Catch-all:       ${catchAll}`);
  console.log(`DNS records:`);
  for (const h of fqdns) console.log(`  CNAME  ${h} -> {tunnel_id}.cfargotunnel.com  (proxied)`);
  console.log("─".repeat(60));

  // ── .env status (always show before confirmation / dry-run exit) ──
  const present = [];
  if (env.CF_ACCOUNT_ID) present.push("CF_ACCOUNT_ID");
  if (env.CF_ZONE_ID) present.push("CF_ZONE_ID");
  if (env.CF_TUNNEL_ID) present.push("CF_TUNNEL_ID");
  if (env.CF_TUNNEL_TOKEN) present.push("CF_TUNNEL_TOKEN");
  if (env.CF_TUNNEL_TARGET) present.push("CF_TUNNEL_TARGET");
  if (env.CF_API_TOKEN) present.push("CF_API_TOKEN");
  else if (env.CF_API_EMAIL && getGlobalApiKey(env)) {
    present.push("CF_API_EMAIL");
    present.push(env.CF_API_KEY_GLOBAL ? "CF_API_KEY_GLOBAL" : "CF_API_KEY");
  }

  console.log(`\n── .env status ──────────────────────────────────────`);

  if (missing.length) {
    console.log(`MISSING — required, will block real run (${missing.length}):`);
    for (const k of missing) console.log(`  ✗  ${k}`);
    console.log();
  }

  console.log(`Already set (${present.length}):`);
  if (present.length) {
    for (const k of present) console.log(`  ✓  ${k}`);
  } else {
    console.log(`  (none)`);
  }

  if (willResolve.length) {
    console.log(`\nWill resolve via API (${willResolve.length}):`);
    for (const { key, reason } of willResolve) console.log(`  →  ${key}  —  ${reason}`);
  }

  if (willWrite.length) {
    console.log(`\nWill write to .env (${willWrite.length}):`);
    for (const { key, value, reason } of willWrite) console.log(`  ✎  ${key}=${value}  (${reason})`);
  }

  if (DRY_RUN) {
    console.log(`\nAPI calls that would be made:`);
    if (!env.CF_ACCOUNT_ID) console.log(`  GET  /accounts`);
    if (!env.CF_ZONE_ID) console.log(`  GET  /zones?name=${domain}`);
    if (!env.CF_TUNNEL_ID) {
      console.log(`  POST /accounts/{account_id}/cfd_tunnel`);
      console.log(`  GET  /accounts/{account_id}/cfd_tunnel?name=${tunnelName}  (fallback lookup)`);
    }
    if (!env.CF_TUNNEL_TOKEN) console.log(`  GET  /accounts/{account_id}/cfd_tunnel/{tunnel_id}/token`);
    console.log(`  PUT  /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations  (ingress)`);
    for (const h of fqdns) {
      console.log(`  GET  /zones/{zone_id}/dns_records?type=CNAME&name=${h}`);
      console.log(`  POST /zones/{zone_id}/dns_records  (create/update CNAME)`);
    }

    console.log(`\n[DRY RUN] No API calls or .env writes performed.`);
    return;
  }

  // Block if required vars missing
  if (missing.length) {
    console.error(`\nERROR: missing required vars in .env — cannot proceed.`);
    process.exit(1);
  }

  // Ask confirmation unless --silent
  if (!SILENT) {
    const ok = await askConfirm("\nProceed?");
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  // ── Execute ────────────────────────────────────────────────────
  const written = []; // { key, value }
  let hasFailure = false;

  // Account ID
  if (!env.CF_ACCOUNT_ID) {
    console.log(`\n==> Resolving CF_ACCOUNT_ID...`);
    const res = await cf("GET", "/accounts", null, authHeaders);
    accountId = res.success ? res.result?.[0]?.id || "" : "";
    if (accountId) {
      showStep(`CF_ACCOUNT_ID=${accountId}`, res);
      writeEnvVar(ENV_FILE, "CF_ACCOUNT_ID", accountId);
      written.push({ key: "CF_ACCOUNT_ID", value: accountId });
    } else {
      showStep("CF_ACCOUNT_ID — no accounts found", res);
      hasFailure = true;
    }
  }

  // Zone ID
  if (!env.CF_ZONE_ID) {
    console.log(`\n==> Resolving CF_ZONE_ID for ${domain}...`);
    const res = await cf("GET", `/zones?name=${domain}`, null, authHeaders);
    zoneId = res.success ? res.result?.[0]?.id || "" : "";
    if (zoneId) {
      showStep(`CF_ZONE_ID=${zoneId}`, res);
      writeEnvVar(ENV_FILE, "CF_ZONE_ID", zoneId);
      written.push({ key: "CF_ZONE_ID", value: zoneId });
    } else {
      showStep(`CF_ZONE_ID — zone '${domain}' not found`, res);
      hasFailure = true;
    }
  }

  // Tunnel
  if (!env.CF_TUNNEL_ID) {
    console.log(`\n==> Creating tunnel '${tunnelName}'...`);
    const secret = randomBytes(32).toString("base64");
    const createRes = await cf(
      "POST",
      `/accounts/${accountId}/cfd_tunnel`,
      {
        name: tunnelName,
        tunnel_secret: secret,
        config_src: "cloudflare",
      },
      authHeaders,
    );
    if (createRes.success) {
      tunnelId = createRes.result.id;
      showStep(`Created tunnel ${tunnelId}`, createRes);
    } else {
      console.log(`    Create failed, looking up existing...`);
      const listRes = await cf("GET", `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`, null, authHeaders);
      tunnelId = listRes.success ? listRes.result?.[0]?.id || "" : "";
      if (tunnelId) {
        showStep(`Found existing tunnel ${tunnelId}`, listRes);
      } else {
        showStep(`Tunnel '${tunnelName}' — not found`, listRes);
        hasFailure = true;
      }
    }
    if (tunnelId) {
      writeEnvVar(ENV_FILE, "CF_TUNNEL_NAME", tunnelName);
      writeEnvVar(ENV_FILE, "CF_TUNNEL_ID", tunnelId);
      const tunnelTarget = `${tunnelId}.cfargotunnel.com`;
      writeEnvVar(ENV_FILE, "CF_TUNNEL_TARGET", tunnelTarget);
      written.push({ key: "CF_TUNNEL_NAME", value: tunnelName });
      written.push({ key: "CF_TUNNEL_ID", value: tunnelId });
      written.push({ key: "CF_TUNNEL_TARGET", value: tunnelTarget });
    }
  }

  // Token
  if (!env.CF_TUNNEL_TOKEN && tunnelId) {
    console.log(`\n==> Fetching tunnel token...`);
    const res = await cf("GET", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`, null, authHeaders);
    tunnelToken = res.success ? res.result : "";
    if (tunnelToken) {
      showStep(`CF_TUNNEL_TOKEN=${tunnelToken.slice(0, 20)}...`, res);
      writeEnvVar(ENV_FILE, "CF_TUNNEL_TOKEN", tunnelToken);
      written.push({ key: "CF_TUNNEL_TOKEN", value: tunnelToken.slice(0, 20) + "..." });
    } else {
      showStep("CF_TUNNEL_TOKEN — fetch failed", res);
      hasFailure = true;
    }
  }

  // Ingress
  if (tunnelId) {
    console.log(`\n==> Configuring ingress...`);
    const finalIngress = [...ingress, { service: catchAll }];
    const res = await cf("PUT", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, { config: { ingress: finalIngress } }, authHeaders);
    if (res.success) {
      showStep(`Ingress: ${ingress.length} typed rules`, res);
    } else {
      showStep("Ingress config failed", res);
      hasFailure = true;
    }
  }

  // DNS
  if (tunnelId && zoneId) {
    const target = env.CF_TUNNEL_TARGET || `${tunnelId}.cfargotunnel.com`;
    console.log(`\n==> Creating DNS CNAME records...`);
    for (const h of fqdns) {
      const existing = await cf("GET", `/zones/${zoneId}/dns_records?type=CNAME&name=${h}`, null, authHeaders);
      const recId = existing.success ? existing.result?.[0]?.id || null : null;
      const body = { type: "CNAME", name: h, content: target, proxied: true };
      let res;
      if (recId) {
        res = await cf("PUT", `/zones/${zoneId}/dns_records/${recId}`, body, authHeaders);
      } else {
        res = await cf("POST", `/zones/${zoneId}/dns_records`, body, authHeaders);
      }
      showStep(`CNAME ${h} -> ${target}`, res);
      if (!res.success) hasFailure = true;
    }
  }

  // Summary
  if (hasFailure) {
    console.error(`\n⚠  Some steps failed. Fix the errors above and re-run.`);
    process.exit(1);
  }

  if (written.length) {
    console.log(`
================================================================
DONE. Values saved to .env:
`);
    for (const { key, value } of written) console.log(`  ${key}=${value}`);
    console.log(`
Next: docker compose up -d  (COMPOSE_PROFILES=core or full)
================================================================`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
