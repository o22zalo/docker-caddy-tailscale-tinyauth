#!/usr/bin/env node
// tailscale/scripts/init.mjs
// Prepare Tailscale ACL file, HTTPS, Serve config, and root .env defaults.
//
// Usage:
//   node tailscale/scripts/init.mjs [--env path] [--dry-run] [--silent]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { parse } from "jsonc-parser";
import { parseEnv } from "../../scripts/lib/env-utils.mjs";
import { buildServeConfig, extractHostname, mergeServiceAutoApprovers, resolvePublishConfig } from "./lib/publish-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const CONFIG_FILE = resolve(__dirname, "init.jsonc");
const API = "https://api.tailscale.com/api/v2";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const envIdx = args.indexOf("--env");
const ENV_FILE = envIdx !== -1 ? resolve(args[envIdx + 1]) : resolve(ROOT, ".env");
const log = (...a) => { if (!SILENT) console.log(...a); };

function loadConfig() {
  const defaults = { services: [{ name: "whoami", upstream: "http://whoami:80" }] };
  if (!existsSync(CONFIG_FILE)) return defaults;
  return { ...defaults, ...parse(readFileSync(CONFIG_FILE, "utf8")) };
}

function csv(value) {
  return (value || "").split(",").map((v) => v.trim()).filter(Boolean);
}

function unique(values) {
  return [...new Set(values)];
}

function isTag(value) {
  return /^tag:[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

function trimDots(value) {
  return String(value || "").trim().replace(/^\.+|\.+$/g, "");
}

function isDomain(value) {
  return /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/.test(value || "");
}

function renderServe(services, tailnet, publishCfg, eol = "\n") {
  // Delegate to shared lib. TCP 443 (HTTPS) + 2222 (SSH forward) luôn có mặt;
  // Web{} chỉ được điền khi publishCfg.doServe (Cách A). Bất biến an toàn giữ
  // ở publish-lib.buildServeConfig.
  const cfg = { ...publishCfg, tailnet: tailnet || publishCfg.tailnet || "example.ts.net" };
  return `${JSON.stringify(buildServeConfig(services, cfg), null, 2)}${eol}`;
}

function mergeTagOwners(policy, requiredTags, owners) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("ACL policy is not a JSON object.");
  const tagOwners = policy.tagOwners && typeof policy.tagOwners === "object" && !Array.isArray(policy.tagOwners) ? { ...policy.tagOwners } : {};
  const added = [];
  for (const tag of requiredTags) {
    if (tagOwners[tag]) continue;
    tagOwners[tag] = [...owners];
    added.push(tag);
  }
  return { nextPolicy: added.length ? { ...policy, tagOwners } : policy, added };
}

function envLineKey(line) {
  const m = line.match(/^([A-Z0-9_]+)=/);
  return m ? m[1] : "";
}

function writeEnvVar(file, key, value) {
  if (DRY_RUN) return;
  let content = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = content ? content.split(/\n/) : [];
  const line = `${key}=${value}`;
  const idx = lines.findIndex((l) => envLineKey(l) === key);
  if (idx >= 0) lines[idx] = line;
  else {
    let lastTs = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^TS_[A-Z0-9_]+=/.test(lines[i])) { lastTs = i; break; }
    }
    if (lastTs >= 0) lines.splice(lastTs + 1, 0, line);
    else lines.push(line);
  }
  writeFileSync(file, `${lines.join("\n").replace(/\n*$/, "")}\n`, "utf8");
}

async function askConfirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolveAsk) => rl.question(`${question} [y/N] `, (ans) => {
    rl.close();
    resolveAsk(ans.trim().toLowerCase() === "y");
  }));
}

async function token(clientId, clientSecret) {
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
  const res = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`OAuth failed: HTTP ${res.status}`);
  return json.access_token;
}

async function ts(method, path, accessToken, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} failed: HTTP ${res.status}${json.message ? ` ${json.message}` : ""}`);
  return { json, etag: res.headers.get("etag") || "" };
}

async function main() {
  log(`=== Tailscale Init${DRY_RUN ? " (DRY RUN)" : ""} ===\n`);
  const fileEnv = parseEnv(ENV_FILE);
  const env = { ...fileEnv, ...process.env };
  const cfg = loadConfig();
  const tailnet = trimDots(env.TS_TAILNET);
  const clientId = (env.TS_CLIENT_ID || "").trim();
  const clientSecret = (env.TS_CLIENT_SECRET || "").trim();
  const tagsRaw = csv(env.TS_TAGS || "tag:container,tag:ci");
  const tags = unique(tagsRaw.filter(isTag));
  const badTags = unique(tagsRaw.filter((tag) => !isTag(tag)));
  const owners = unique(csv(env.TS_TAG_OWNERS || "autogroup:admin"));
  const publishCfg = resolvePublishConfig(env);
  for (const w of publishCfg.warnings) log(`Warning: ${w}`);
  const servePath = resolve(ROOT, env.TS_SERVE_JSON_PATH || "tailscale/serve.json");
  const aclSamplePath = resolve(ROOT, env.TS_ACL_SAMPLE_PATH || "tailscale/acl.sample.hujson");
  const aclPath = resolve(ROOT, env.TS_ACL_JSON_PATH || "tailscale/acl.hujson");
  const services = (cfg.services || []).filter((svc) => svc?.name && svc?.upstream);

  const errors = [];
  if (!clientId) errors.push("Missing TS_CLIENT_ID.");
  if (!clientSecret) errors.push("Missing TS_CLIENT_SECRET.");
  if (!tailnet) errors.push("Missing TS_TAILNET.");
  else if (!isDomain(tailnet)) errors.push(`TS_TAILNET is not a domain: ${tailnet}`);
  if (!tags.length) errors.push("Missing valid TS_TAGS, example: tag:proxy.");
  if (!owners.length) errors.push("Missing TS_TAG_OWNERS.");
  if (!services.length) errors.push("No services in tailscale/scripts/init.jsonc.");
  if (!existsSync(aclSamplePath)) errors.push(`ACL sample file not found: ${aclSamplePath}`);

  log(`Env file:     ${ENV_FILE}`);
  log(`Tailnet:      ${tailnet || "(missing)"}`);
  log(`Tags:         ${tags.join(", ") || "(missing)"}`);
  log(`Serve file:   ${servePath}`);
  log(`ACL sample:   ${aclSamplePath}`);
  log(`ACL file:     ${aclPath}`);
  log(`Publish mode: ${publishCfg.mode}${publishCfg.doServe ? ` (serve style=${publishCfg.serveStyle})` : ""}${publishCfg.doServices ? ` (services autoApprove=${publishCfg.autoApprove ? "on" : "off"})` : ""}`);
  if (publishCfg.doServe) log(`Serve routes: ${services.flatMap((s) => unique([s.name, ...(s.names || [])].filter(Boolean)).map((name) => publishCfg.serveStyle === "path" ? `${publishCfg.nodeHost}.${tailnet || "TS_TAILNET"}/${name} -> ${s.upstream}` : `${name}.${tailnet || "TS_TAILNET"} -> ${s.upstream}`)).join(", ")}`);
  else log("Serve routes: (Cách A tắt — serve.json chỉ có TCP 443 + 2222)");
  if (badTags.length) log(`Warning: ignoring invalid TS_TAGS: ${badTags.join(", ")}`);

  const envWrites = [];
  if (!fileEnv.TS_TAILNET && process.env.TS_TAILNET) envWrites.push(["TS_TAILNET", tailnet]);
  if (!fileEnv.TS_HOSTNAME) envWrites.push(["TS_HOSTNAME", detectedHostname]);
  if (!fileEnv.TS_SERVE_CONFIG) envWrites.push(["TS_SERVE_CONFIG", "/config/serve.json"]);
  const extra = env.TS_EXTRA_ARGS || "--accept-dns=false";
  const advertise = `--advertise-tags=${tags.join(",")}`;
  if (tags.length && !fileEnv.TS_EXTRA_ARGS?.includes("--advertise-tags=")) envWrites.push(["TS_EXTRA_ARGS", `${extra} ${advertise}`.trim()]);

  if (envWrites.length) {
    log("\nWill write to .env:");
    for (const [key, value] of envWrites) log(`  ${key}=${value}`);
  }

  const serveCurrent = existsSync(servePath) ? readFileSync(servePath, "utf8") : "";
  const serveEol = serveCurrent.includes("\r\n") ? "\r\n" : "\n";
  const serveNext = renderServe(services, tailnet || "example.ts.net", publishCfg, serveEol);
  const serveChanged = serveCurrent !== serveNext;
  const aclSample = existsSync(aclSamplePath) ? parse(readFileSync(aclSamplePath, "utf8")) : {};
  // 1) tagOwners cho tag đang advertise. 2) autoApprovers.services (Cách B) để
  //    node tự duyệt service — approvers = chính các tag host.
  const aclWithTags = existsSync(aclSamplePath) ? mergeTagOwners(aclSample, tags, owners).nextPolicy : {};
  const aclNextPolicy = mergeServiceAutoApprovers(aclWithTags, services, publishCfg, tags).nextPolicy;
  const aclNext = `${JSON.stringify(aclNextPolicy, null, 2)}\n`;
  const aclCurrent = existsSync(aclPath) ? readFileSync(aclPath, "utf8") : "";
  const aclChanged = aclCurrent !== aclNext;
  log(`\nServe config: ${serveChanged ? "update needed" : "already current"}`);
  log(`ACL file:     ${aclChanged ? "update needed" : "already current"}`);

  if (DRY_RUN) {
    log("\nAPI calls that would be made:");
    log("  POST /oauth/token");
    log("  POST /tailnet/{tailnet}/acl  (upload rendered acl.hujson)");
    log("  GET  /tailnet/{tailnet}/settings");
    log("  PATCH /tailnet/{tailnet}/settings  (if HTTPS disabled)");
    log("\n[DRY RUN] No API calls or file writes performed.");
    if (errors.length) {
      log("\nWould block real run:");
      for (const err of errors) log(`  - ${err}`);
    }
    return;
  }

  if (errors.length) {
    console.error("\nERROR: cannot continue:");
    for (const err of errors) console.error(`  - ${err}`);
    process.exit(1);
  }

  if (!SILENT) {
    const ok = await askConfirm("\nApply Tailscale changes?");
    if (!ok) return;
  }

  const accessToken = await token(clientId, clientSecret);
  const encodedTailnet = encodeURIComponent(tailnet);

  // ── Auto-detect hostname từ Tailscale API (list devices) ──
  // Publish.mjs cũng tự detect khi chạy sau docker compose up, nhưng ở đây
  // ta detect sớm hơn để serve.json render đúng hostname ngay từ lần đầu.
  let detectedHostname = publishCfg.nodeHost;
  try {
    const devicesRes = await ts("GET", `/tailnet/${encodedTailnet}/devices`, accessToken);
    const devices = devicesRes.json?.devices || [];
    // Tìm device có tag trùng với tag đầu tiên trong danh sách (vd tag:container)
    const matchTag = tags[0];
    const selfDevice = devices.find((d) =>
      Array.isArray(d?.tags) && d.tags.includes(matchTag) && d?.hostname
    );
    if (selfDevice?.hostname) {
      detectedHostname = selfDevice.hostname;
      if (detectedHostname !== publishCfg.nodeHost) {
        log(`\nAuto-detected hostname: "${publishCfg.nodeHost}" → "${detectedHostname}"`);
        publishCfg.nodeHost = detectedHostname;
      }
    }
  } catch {
    // API có thể fail nếu chưa có device nào — không fatal.
  }

  if (aclChanged) {
    mkdirSync(dirname(aclPath), { recursive: true });
    writeFileSync(aclPath, aclNext, "utf8");
    log(`ACL file written: ${aclPath}`);
  }
  await ts("POST", `/tailnet/${encodedTailnet}/acl`, accessToken, aclNextPolicy);
  log("Remote ACL updated from rendered ACL file.");

  const settings = await ts("GET", `/tailnet/${encodedTailnet}/settings`, accessToken);
  if (settings.json.httpsEnabled !== true) {
    await ts("PATCH", `/tailnet/${encodedTailnet}/settings`, accessToken, { httpsEnabled: true });
    log("Tailnet HTTPS enabled.");
  } else {
    log("Tailnet HTTPS already enabled.");
  }

  if (serveChanged) {
    mkdirSync(dirname(servePath), { recursive: true });
    writeFileSync(servePath, serveNext, "utf8");
    log(`Serve config written: ${servePath}`);
  }

  for (const [key, value] of envWrites) writeEnvVar(ENV_FILE, key, value);
  if (envWrites.length) log(`Env defaults written: ${ENV_FILE}`);
  log("\nDone.");
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
