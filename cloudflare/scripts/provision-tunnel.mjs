#!/usr/bin/env node
// cloudflare/scripts/provision-tunnel.mjs
// Provision Cloudflare named tunnel + DNS records — 100% API, no dashboard.
//
// Reads .env for DOMAIN + CF_* vars. Creates tunnel, gets token, configures
// ingress, creates DNS CNAME records. Writes results back to .env.
//
// Usage:
//   node cloudflare/scripts/provision-tunnel.mjs [--env path/to/.env]
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
// Security:
//   CF_API_TOKEN (scoped, recommended) over Global API Key.
//   Token with full account permissions for Tunnel, DNS, Workers, etc.
//
// Docs:
//   - Tunnel API: https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/
//   - DNS API: https://developers.cloudflare.com/api/resources/dns/subresources/records/
//   - Auth: https://developers.cloudflare.com/fundamentals/api/get-started/keys/
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const HOSTNAMES_FILE = resolve(__dirname, "hostnames.json");
const API = "https://api.cloudflare.com/client/v4";

// ── CLI args ─────────────────────────────────────────────────────
const envIdx = process.argv.indexOf("--env");
const ENV_FILE = envIdx !== -1 ? resolve(process.argv[envIdx + 1]) : resolve(ROOT, ".env");

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
  if (env.CF_API_TOKEN) {
    return { Authorization: `Bearer ${env.CF_API_TOKEN}` };
  }
  if (env.CF_API_EMAIL && env.CF_API_KEY) {
    return { "X-Auth-Email": env.CF_API_EMAIL, "X-Auth-Key": env.CF_API_KEY };
  }
  return null;
}

async function cf(method, path, body, headers) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  };
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

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log("=== Cloudflare Tunnel Provisioner ===\n");

  // 1. Read .env
  if (!existsSync(ENV_FILE)) {
    console.error(`ERROR: ${ENV_FILE} not found. Copy .env.example to .env first.`);
    process.exit(1);
  }
  const env = readEnv(ENV_FILE);
  console.log(`Env file: ${ENV_FILE}`);

  // 2. Validate DOMAIN
  if (!env.DOMAIN) {
    console.error("ERROR: DOMAIN not set in .env. Cannot provision tunnel.");
    process.exit(1);
  }
  const domain = env.DOMAIN;
  console.log(`Domain: ${domain}`);

  // 3. Validate auth
  const authHeaders = getAuthHeaders(env);
  if (!authHeaders) {
    console.error("ERROR: set CF_API_TOKEN, or CF_API_EMAIL + CF_API_KEY in .env");
    process.exit(1);
  }
  console.log(`Auth: ${env.CF_API_TOKEN ? "API Token" : "Global API Key"}\n`);

  // 4. Validate account
  if (!env.CF_ACCOUNT_ID) {
    console.error("ERROR: CF_ACCOUNT_ID not set in .env.");
    process.exit(1);
  }
  const accountId = env.CF_ACCOUNT_ID;

  // 5. Resolve zone ID
  let zoneId = env.CF_ZONE_ID || "";
  if (!zoneId) {
    console.log(`==> Resolving zone ID for ${domain}...`);
    const zoneResp = await cf("GET", `/zones?name=${domain}`, null, authHeaders);
    zoneId = zoneResp.result?.[0]?.id || "";
    if (!zoneId) {
      console.error(`ERROR: zone ${domain} not found. Add site to Cloudflare first.`);
      process.exit(1);
    }
    writeEnvVar(ENV_FILE, "CF_ZONE_ID", zoneId);
    console.log(`    CF_ZONE_ID=${zoneId} (saved)`);
  } else {
    console.log(`    CF_ZONE_ID=${zoneId} (from .env)`);
  }

  // 6. Create or reuse tunnel
  const tunnelName = env.CF_TUNNEL_NAME || `${domain}-tunnel`;
  let tunnelId = env.CF_TUNNEL_ID || "";

  if (!tunnelId) {
    console.log(`\n==> Creating tunnel '${tunnelName}'...`);
    const secret = execSync("openssl rand -base64 32").toString().trim();
    try {
      const createResp = await cf("POST", `/accounts/${accountId}/cfd_tunnel`, {
        name: tunnelName,
        tunnel_secret: secret,
        config_src: "cloudflare",
      }, authHeaders);
      tunnelId = createResp.result.id;
      console.log(`    Created: ${tunnelId}`);
    } catch {
      // Tunnel name exists — look up existing
      console.log(`    Tunnel '${tunnelName}' may already exist, looking up...`);
      const listResp = await cf("GET", `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`, null, authHeaders);
      tunnelId = listResp.result?.[0]?.id || "";
      if (!tunnelId) {
        console.error("ERROR: cannot create tunnel and cannot find existing one.");
        process.exit(1);
      }
      console.log(`    Found existing: ${tunnelId}`);
    }
    writeEnvVar(ENV_FILE, "CF_TUNNEL_NAME", tunnelName);
    writeEnvVar(ENV_FILE, "CF_TUNNEL_ID", tunnelId);
  } else {
    console.log(`\n==> Using existing tunnel: ${tunnelId}`);
  }

  // 7. Get tunnel token
  let tunnelToken = env.CF_TUNNEL_TOKEN || "";
  if (!tunnelToken) {
    console.log(`\n==> Fetching tunnel token...`);
    const tokenResp = await cf("GET", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`, null, authHeaders);
    tunnelToken = tokenResp.result;
    writeEnvVar(ENV_FILE, "CF_TUNNEL_TOKEN", tunnelToken);
    console.log(`    Token saved to CF_TUNNEL_TOKEN`);
  } else {
    console.log(`\n==> Using existing token (from .env)`);
  }

  // 8. Configure ingress from hostnames.json
  let hostnames = ["auth", "files", "ttyd"];
  let serviceUrl = "http://caddy:80";
  let catchAll = "http_status:404";
  if (existsSync(HOSTNAMES_FILE)) {
    const cfg = JSON.parse(readFileSync(HOSTNAMES_FILE, "utf8"));
    if (cfg.hostnames?.length) hostnames = cfg.hostnames;
    if (cfg.service_url) serviceUrl = cfg.service_url;
    if (cfg.catch_all) catchAll = cfg.catch_all;
  }
  const fqdns = hostnames.map((h) => `${h}.${domain}`);

  console.log(`\n==> Configuring ingress (${fqdns.length} hostnames)...`);
  const ingress = [
    ...fqdns.map((h) => ({ hostname: h, service: serviceUrl })),
    { service: catchAll },
  ];
  await cf("PUT", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
    config: { ingress },
  }, authHeaders);
  for (const h of fqdns) console.log(`    ${h} -> ${serviceUrl}`);

  // 9. Create/update DNS CNAME records
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

  // 10. Summary
  console.log(`
================================================================
DONE. Values saved to .env:

  CF_ZONE_ID=${zoneId}
  CF_TUNNEL_NAME=${tunnelName}
  CF_TUNNEL_ID=${tunnelId}
  CF_TUNNEL_TOKEN=${tunnelToken.slice(0, 20)}...

Hostnames configured:
${fqdns.map((h) => `  ${h} -> ${serviceUrl}`).join("\n")}

Next steps:
  docker compose up -d    # COMPOSE_PROFILES=core (or full)
================================================================`);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
