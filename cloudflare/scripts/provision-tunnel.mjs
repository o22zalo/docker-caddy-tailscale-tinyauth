#!/usr/bin/env node
// cloudflare/scripts/provision-tunnel.mjs
// Provision Cloudflare named tunnel + DNS records — 100% API, no dashboard.
//
// Reads .env for DOMAIN + CF_* vars. Creates tunnel, gets token, configures
// ingress, creates DNS CNAME records. Writes results back to .env.
//
// Usage:
//   node cloudflare/scripts/provision-tunnel.mjs [--env path] [--dry-run] [--silent]
//
// Flags:
//   --env path    Path to .env file (default: project root .env)
//   --dry-run     Show what would be done, no API calls or .env writes
//   --silent      Skip confirmation prompt, run directly
//
// Env vars (from .env):
//   DOMAIN            required — root domain (e.g. example.com)
//   CF_API_TOKEN      preferred — scoped API Token (full permissions)
//   CF_API_EMAIL      alternative — email (with CF_API_KEY)
//   CF_API_KEY        alternative — Global API Key (with CF_API_EMAIL)
//   CF_ACCOUNT_ID     required — Cloudflare Account ID
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
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { parse } from "jsonc-parser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const HOSTNAMES_FILE = resolve(__dirname, "hostnames.jsonc");
const API = "https://api.cloudflare.com/client/v4";

// ── CLI args ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const envIdx = args.indexOf("--env");
const ENV_FILE = envIdx !== -1 ? resolve(args[envIdx + 1]) : resolve(ROOT, ".env");

async function askConfirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(`${question} [y/N] `, (ans) => { rl.close(); res(ans.toLowerCase() === "y"); });
  });
}

// ── .env read/write ──────────────────────────────────────────────
function readEnv(file) {
  if (!existsSync(file)) return {};
  const env = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function writeEnvVar(file, key, value) {
  if (DRY_RUN) return;
  let content = existsSync(file) ? readFileSync(file, "utf8") : "";
  const regex = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = content.trimEnd() + "\n" + line + "\n";
  }
  writeFileSync(file, content);
}

// ── Cloudflare API ───────────────────────────────────────────────
function getAuthHeaders(env) {
  if (env.CF_API_TOKEN) return { Authorization: `Bearer ${env.CF_API_TOKEN}` };
  if (env.CF_API_EMAIL && env.CF_API_KEY) return { "X-Auth-Email": env.CF_API_EMAIL, "X-Auth-Key": env.CF_API_KEY };
  return null;
}

async function cf(method, path, body, headers) {
  if (DRY_RUN) return { success: true, result: {} };
  const opts = { method, headers: { "Content-Type": "application/json", ...headers } };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${API}${path}`, opts);
  const json = await resp.json();
  if (!json.success) {
    console.error(`API ${method} ${path} failed:`);
    console.error(JSON.stringify(json.errors, null, 2));
    process.exit(1);
  }
  return json;
}

// ── Hostnames config ─────────────────────────────────────────────
function loadHostnames(domain) {
  let hostnames = ["auth", "files", "ttyd"];
  let serviceUrl = "http://caddy:80";
  let catchAll = "http_status:404";
  if (existsSync(HOSTNAMES_FILE)) {
    const raw = readFileSync(HOSTNAMES_FILE, "utf8");
    const cfg = parse(raw);
    if (cfg.hostnames?.length) hostnames = cfg.hostnames;
    if (cfg.service_url) serviceUrl = cfg.service_url;
    if (cfg.catch_all) catchAll = cfg.catch_all;
  }
  const fqdns = hostnames.map((h) => `${h}.${domain}`);
  return { hostnames, fqdns, serviceUrl, catchAll };
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log(`=== Cloudflare Tunnel Provisioner${DRY_RUN ? " (DRY RUN)" : ""} ===\n`);

  // 1. Read .env
  if (!existsSync(ENV_FILE)) {
    console.error(`ERROR: ${ENV_FILE} not found. Copy .env.example to .env first.`);
    process.exit(1);
  }
  const env = readEnv(ENV_FILE);

  // 2. Validate required vars
  const missing = [];
  if (!env.DOMAIN) missing.push("DOMAIN");
  if (!getAuthHeaders(env)) missing.push("CF_API_TOKEN (or CF_API_EMAIL + CF_API_KEY)");
  if (!env.CF_ACCOUNT_ID) missing.push("CF_ACCOUNT_ID");
  if (missing.length) {
    console.error(`ERROR: missing in .env:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }

  const domain = env.DOMAIN;
  const accountId = env.CF_ACCOUNT_ID;
  const authHeaders = getAuthHeaders(env);
  const authType = env.CF_API_TOKEN ? "API Token" : "Global API Key";

  // 3. Resolve zone ID (existing or new)
  let zoneId = env.CF_ZONE_ID || "";
  let zoneAction = "from .env";
  if (!zoneId) {
    if (!DRY_RUN) {
      const zoneResp = await cf("GET", `/zones?name=${domain}`, null, authHeaders);
      zoneId = zoneResp.result?.[0]?.id || "";
      if (!zoneId) {
        console.error(`ERROR: zone ${domain} not found. Add site to Cloudflare first.`);
        process.exit(1);
      }
    } else {
      zoneId = "(will resolve from API)";
    }
    zoneAction = "resolve from API";
  }

  // 4. Tunnel
  const tunnelName = env.CF_TUNNEL_NAME || `${domain}-tunnel`;
  let tunnelId = env.CF_TUNNEL_ID || "";
  let tunnelAction = "from .env";
  if (!tunnelId) {
    tunnelAction = DRY_RUN ? "create via API" : "create or lookup";
  }

  // 5. Token
  let tunnelToken = env.CF_TUNNEL_TOKEN || "";
  let tokenAction = "from .env";
  if (!tunnelToken) {
    tokenAction = DRY_RUN ? "fetch from API" : "fetch";
  }

  // 6. Hostnames
  const { fqdns, serviceUrl, catchAll } = loadHostnames(domain);

  // ── Confirmation summary ───────────────────────────────────────
  console.log("─".repeat(60));
  console.log(`Env file:        ${ENV_FILE}`);
  console.log(`Domain:          ${domain}`);
  console.log(`Auth:            ${authType}`);
  console.log(`Account ID:      ${accountId}`);
  console.log(`Zone ID:         ${zoneId} (${zoneAction})`);
  console.log(`Tunnel name:     ${tunnelName}`);
  console.log(`Tunnel ID:       ${tunnelId || "(new)"} (${tunnelAction})`);
  console.log(`Tunnel token:    ${tunnelToken ? tunnelToken.slice(0, 20) + "..." : "(new)"} (${tokenAction})`);
  console.log(`Ingress:         ${fqdns.length} hostnames -> ${serviceUrl}`);
  console.log(`Catch-all:       ${catchAll}`);
  console.log(`DNS records:`);
  for (const h of fqdns) console.log(`  CNAME  ${h} -> {tunnel_id}.cfargotunnel.com  (proxied)`);
  console.log("─".repeat(60));

  if (DRY_RUN) {
    console.log("\n[DRY RUN] No API calls or .env writes performed.");
    return;
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
  // Zone ID
  if (!env.CF_ZONE_ID) {
    console.log(`\n==> Resolving zone ID for ${domain}...`);
    const zoneResp = await cf("GET", `/zones?name=${domain}`, null, authHeaders);
    zoneId = zoneResp.result?.[0]?.id || "";
    if (!zoneId) {
      console.error(`ERROR: zone ${domain} not found.`);
      process.exit(1);
    }
    writeEnvVar(ENV_FILE, "CF_ZONE_ID", zoneId);
    console.log(`    CF_ZONE_ID=${zoneId} (saved)`);
  }

  // Tunnel
  if (!env.CF_TUNNEL_ID) {
    console.log(`\n==> Creating tunnel '${tunnelName}'...`);
    const secret = execSync("openssl rand -base64 32").toString().trim();
    try {
      const createResp = await cf("POST", `/accounts/${accountId}/cfd_tunnel`, {
        name: tunnelName, tunnel_secret: secret, config_src: "cloudflare",
      }, authHeaders);
      tunnelId = createResp.result.id;
      console.log(`    Created: ${tunnelId}`);
    } catch {
      console.log(`    Tunnel '${tunnelName}' may already exist, looking up...`);
      const listResp = await cf("GET", `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`, null, authHeaders);
      tunnelId = listResp.result?.[0]?.id || "";
      if (!tunnelId) { console.error("ERROR: cannot create or find tunnel."); process.exit(1); }
      console.log(`    Found existing: ${tunnelId}`);
    }
    writeEnvVar(ENV_FILE, "CF_TUNNEL_NAME", tunnelName);
    writeEnvVar(ENV_FILE, "CF_TUNNEL_ID", tunnelId);
  }

  // Token
  if (!env.CF_TUNNEL_TOKEN) {
    console.log(`\n==> Fetching tunnel token...`);
    const tokenResp = await cf("GET", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`, null, authHeaders);
    tunnelToken = tokenResp.result;
    writeEnvVar(ENV_FILE, "CF_TUNNEL_TOKEN", tunnelToken);
    console.log(`    Token saved`);
  }

  // Ingress
  console.log(`\n==> Configuring ingress...`);
  const ingress = [...fqdns.map((h) => ({ hostname: h, service: serviceUrl })), { service: catchAll }];
  await cf("PUT", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, { config: { ingress } }, authHeaders);
  for (const h of fqdns) console.log(`    ${h} -> ${serviceUrl}`);

  // DNS
  const target = `${tunnelId}.cfargotunnel.com`;
  console.log(`\n==> Creating DNS CNAME records...`);
  for (const h of fqdns) {
    const existing = await cf("GET", `/zones/${zoneId}/dns_records?type=CNAME&name=${h}`, null, authHeaders);
    const recId = existing.result?.[0]?.id;
    const body = { type: "CNAME", name: h, content: target, proxied: true };
    if (recId) {
      await cf("PUT", `/zones/${zoneId}/dns_records/${recId}`, body, authHeaders);
      console.log(`    updated  ${h} -> ${target}`);
    } else {
      await cf("POST", `/zones/${zoneId}/dns_records`, body, authHeaders);
      console.log(`    created  ${h} -> ${target}`);
    }
  }

  // Done
  console.log(`
================================================================
DONE. Values saved to .env:

  CF_ZONE_ID=${zoneId}
  CF_TUNNEL_NAME=${tunnelName}
  CF_TUNNEL_ID=${tunnelId}
  CF_TUNNEL_TOKEN=${tunnelToken.slice(0, 20)}...

Next: docker compose up -d  (COMPOSE_PROFILES=core or full)
================================================================`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
