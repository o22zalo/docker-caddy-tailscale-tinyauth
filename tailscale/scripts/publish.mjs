#!/usr/bin/env node
// tailscale/scripts/publish.mjs
// Publish stack apps over the tailnet — chạy SAU khi `docker compose up`.
// up.mjs / start-stack.mjs chỉ gọi 1 dòng: `node tailscale/scripts/publish.mjs`.
//
// Điều khiển hoàn toàn qua env (prefix TS_):
//   TS_PUBLISH_MODE       off | serve | services | both   (default: off)
//   TS_SERVE_STYLE        subdomain | path                (Cách A, default: subdomain)
//   TS_SERVICES_AUTOAPPROVE  1|0                          (Cách B, default: 1)
//   TS_SERVICES_VIP_MODE  auto | services | legacy-vip | skip  (Cách B, default: auto)
//   TS_TAILNET            <tailnet>.ts.net
//   TS_HOSTNAME           tên node (cho serveStyle=path)
//   TS_SERVE_JSON_PATH    (default tailscale/serve.json)
//
// AN TOÀN: script này KHÔNG BAO GIỜ chạm tới TCP 2222 (SSH sync forward) và
// KHÔNG BAO GIỜ gọi `tailscale serve clear` không scope. Cách A ghi lại
// serve.json (luôn kèm TCP 443 + 2222). Cách B chỉ advertise scope `svc:`.
// Mọi lỗi được nuốt + log — publish thất bại KHÔNG làm gãy stack/sync.
//
// Usage:
//   node tailscale/scripts/publish.mjs [--env path] [--dry-run] [--silent]
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { parseEnv } from "../../scripts/lib/env-utils.mjs";
import { detectDocker } from "../../scripts/runners/_docker.mjs";
import {
  buildAdvertiseCommands,
  buildServeConfig,
  buildServiceApprovalBody,
  buildVipServiceBody,
  buildServicesBody,
  extractAddrs,
  extractHostname,
  resolvePublishConfig,
  SSH_FORWARD_PORT,
} from "./lib/publish-lib.mjs";
import {
  computePublishHash,
  readPublishState,
  writePublishState,
  shouldSkipPublish,
  serveStatePresent,
} from "./lib/publish-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const PUBLISH_STATE_FILE = resolve(ROOT, "ci-runtime/tailscale/published.json");
const CONFIG_FILE = resolve(__dirname, "init.jsonc");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const envIdx = args.indexOf("--env");
const ENV_FILE = envIdx !== -1 ? resolve(args[envIdx + 1]) : resolve(ROOT, ".env");
const log = (...a) => { if (!SILENT) console.log(...a); };
const warn = (...a) => { if (!SILENT) console.warn(...a); };

const TAILSCALE_API = "https://api.tailscale.com/api/v2";

/** Ghi hoặc cập nhật 1 biến trong .env file. Không throw. */
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

async function getOAuthToken(env) {
  const clientId = (env.TS_CLIENT_ID || "").trim();
  const clientSecret = (env.TS_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) return null;
  try {
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
    const res = await fetch(`${TAILSCALE_API}/oauth/token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) return null;
    return json.access_token;
  } catch { return null; }
}

async function tsApi(method, path, token, body) {
  const res = await fetch(`${TAILSCALE_API}${path}`, {
    method,
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
}

function loadServices() {
  const defaults = [{ name: "whoami", upstream: "http://whoami:80" }];
  if (!existsSync(CONFIG_FILE)) return defaults;
  const cfg = parse(readFileSync(CONFIG_FILE, "utf8")) || {};
  return Array.isArray(cfg.services) && cfg.services.length ? cfg.services : defaults;
}

/** Chạy 1 lệnh docker, trả {ok, out}. Không throw. */
function dockerExec(subcmd, { capture = false } = {}) {
  if (DRY_RUN) { log(`[DRY RUN] docker ${subcmd}`); return { ok: true, out: "" }; }
  const docker = detectDocker();
  if (!docker.available) return { ok: false, out: "Docker unavailable" };
  const full = `${docker.cmd} ${subcmd}`;
  try {
    const out = execSync(full, { cwd: ROOT, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    return { ok: true, out: capture ? String(out || "").trim() : "" };
  } catch (e) {
    return { ok: false, out: e.stderr ? String(e.stderr) : e.message };
  }
}

/** Tailscale đã online chưa (best-effort, không throw). */
function waitTailscaleOnline(timeoutMs = 60_000) {
  if (DRY_RUN) { log("[DRY RUN] chờ tailscale online"); return true; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { ok, out } = dockerExec("compose exec -T tailscale tailscale status --json", { capture: true });
    if (ok && out) {
      try {
        const st = JSON.parse(out);
        if (st?.Self?.Online || st?.BackendState === "Running") return true;
      } catch {}
    }
    execSyncSleep(2000);
  }
  return false;
}

function execSyncSleep(ms) {
  // sleep đồng bộ đơn giản (script one-shot, không cần async).
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

// ── Cách A: viết serve.json (init.mjs cũng viết file này; ở đây bảo đảm runtime
//    khớp mode hiện tại). Container có :ro mount, nên chỉ đổi file trên host là đủ
//    khi init đã chạy — nhưng để publish độc lập, ta chỉ REBUILD khi cần và log.
function applyServe(services, cfg, env) {
  const servePath = resolve(ROOT, env.TS_SERVE_JSON_PATH || "tailscale/serve.json");
  const next = buildServeConfig(services, cfg);
  // sanity: TCP 2222 phải còn (bất biến an toàn).
  if (!next.TCP || !next.TCP[SSH_FORWARD_PORT]) {
    warn("REFUSING serve write: TCP 2222 (SSH forward) bị thiếu — bỏ qua để bảo vệ nodesync.");
    return;
  }
  const current = existsSync(servePath) ? readFileSync(servePath, "utf8") : "";
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const rendered = `${JSON.stringify(next, null, 2)}${eol}`;
  if (current === rendered) { log(`[serve] serve.json đã khớp (style=${cfg.serveStyle}).`); return; }
  if (DRY_RUN) { log(`[serve] [DRY RUN] sẽ ghi ${servePath} (style=${cfg.serveStyle}, ${Object.keys(next.Web).length} web host).`); return; }
  mkdirSync(dirname(servePath), { recursive: true });
  writeFileSync(servePath, rendered, "utf8");
  log(`[serve] serve.json updated (style=${cfg.serveStyle}, ${Object.keys(next.Web).length} web host).`);
  // Nạp lại serve config trong container. Best-effort.
  const r = dockerExec("compose restart tailscale");
  if (!r.ok) warn(`[serve] restart tailscale để nạp serve.json thất bại: ${r.out.split("\n")[0]}`);
}

// ── Cách B: advertise từng svc: qua CLI. KHÔNG đụng 2222.
// Trước advertise: tạo VIP service trên control plane (idempotent).
// Sau advertise: approve host qua API để tránh "pending approval".
async function applyServices(services, cfg, env) {
  const cmds = buildAdvertiseCommands(services, cfg);
  if (!cmds.length) { log("[services] không có service để advertise."); return; }
  const online = waitTailscaleOnline();
  if (!online && !DRY_RUN) {
    warn("[services] Tailscale chưa online sau 60s — bỏ qua advertise (stack/sync không bị ảnh hưởng).");
    return;
  }

  // ── Step 0: Get runtime info (nodeId, addrs) ──
  const token = await getOAuthToken(env);
  const tailnet = cfg.tailnet || env.TS_TAILNET || "";
  const encodedTailnet = encodeURIComponent(tailnet);
  let nodeId = "";
  let addrs = [];
  let statusJson = "";
  if (token && tailnet) {
    const st = dockerExec("compose exec -T tailscale tailscale status --json", { capture: true });
    if (st.ok && st.out) {
      statusJson = st.out;
      try { nodeId = JSON.parse(st.out)?.Self?.ID || ""; } catch {}
      addrs = extractAddrs(st.out);
    }
  }

  // ── Step 1: Create/Update services on control plane ──
  if (cfg.vipMode === "skip") {
    log("[services] TS_SERVICES_VIP_MODE=skip → bỏ qua VIP service creation.");
  } else if (token && tailnet) {
    const useServicesApi = cfg.vipMode !== "legacy-vip";
    const apiPath = useServicesApi ? "services" : "vip-services";
    log(`[services] ${useServicesApi ? "Update" : "Create"} ${apiPath} trên control plane (mode=${cfg.vipMode})...`);

    // Step 1a: Clear existing services first (fix "needs configuration" stale state)
    log(`[services] Clearing existing services trước khi tạo mới...`);
    await Promise.all(cmds.map(async (cmd) => {
      if (DRY_RUN) { log(`[services] [DRY RUN] DELETE /${apiPath}/${cmd.service}`); return; }
      const r = await tsApi("DELETE", `/tailnet/${encodedTailnet}/${apiPath}/${cmd.service}`, token);
      if (r.ok) log(`[services] ${cmd.service} cleared ✓`);
      // Ignore 404 (service doesn't exist yet)
    }));

    // Step 1b: Create services (sequential to avoid race conditions)
    for (const cmd of cmds) {
      if (DRY_RUN) { log(`[services] [DRY RUN] PUT /${apiPath}/${cmd.service}`); continue; }

      let body;
      if (useServicesApi) {
        body = buildServicesBody(cmd.service);
      } else {
        if (addrs.length < 1) {
          warn(`[services] ${cmd.service} skipped: không lấy được IPv4 từ tailscale status (got ${addrs.length} addrs). Dùng TS_SERVICES_VIP_MODE=services nếu API mới hỗ trợ không cần addrs.`);
          continue;
        }
        body = buildVipServiceBody(cmd.service, addrs);
      }

      const r = await tsApi("PUT", `/tailnet/${encodedTailnet}/${apiPath}/${cmd.service}`, token, body);
      if (r.ok) log(`[services] ${cmd.service} created ✓ (VIP: ${r.json.addrs?.[0] || r.json.name || "?"})`);
      else warn(`[services] ${cmd.service} create failed: HTTP ${r.status} ${r.json.message || ""}`);
    }
  } else {
    warn("[services] Không có OAuth token — bỏ qua VIP service creation (cần chạy ts-init trước).");
  }

  // ── Step 2: Advertise via CLI (sequential — CLI writes config file) ──
  let okCount = 0;
  for (const cmd of cmds) {
    const sub = `compose exec -T tailscale tailscale ${cmd.argv.join(" ")}`;
    const r = dockerExec(sub, { capture: true });
    if (r.ok) {
      okCount += 1;
      const pending = /approval from an admin is required/i.test(r.out);
      log(`[services] advertised ${cmd.service} → ${cmd.upstream}${pending ? " (⏳ chờ approve)" : " ✓"}`);
    } else {
      warn(`[services] advertise ${cmd.service} thất bại: ${r.out.split("\n")[0]}`);
    }
  }
  log(`[services] advertise xong: ${okCount}/${cmds.length}. DNS: https://<name>.${cfg.tailnet || "<tailnet>"}/`);

  // ── Step 3: Approve hosts via API (parallel — independent per service) ──
  if (token && tailnet && nodeId && cfg.autoApprove) {
    log(`[services] Approving hosts via API (parallel)...`);
    const results = await Promise.all(cmds.map(async (cmd) => {
      if (DRY_RUN) { log(`[services] [DRY RUN] POST approve ${cmd.service} node=${nodeId}`); return { svc: cmd.service, ok: true }; }
      const body = buildServiceApprovalBody();
      const r = await tsApi("POST", `/tailnet/${encodedTailnet}/services/${cmd.service}/device/${nodeId}/approved`, token, body);
      if (r.ok) { log(`[services] ${cmd.service} host approved ✓`); return { svc: cmd.service, ok: true }; }
      warn(`[services] ${cmd.service} approve failed: HTTP ${r.status} ${r.json.message || ""}`);
      return { svc: cmd.service, ok: false };
    }));
    const approved = results.filter((r) => r.ok).length;
    log(`[services] approve xong: ${approved}/${cmds.length}`);
  } else if (cfg.autoApprove) {
    warn("[services] Không thể auto-approve (thiếu token/tailnet/nodeId). Chạy `npm run ts-init` rồi `npm run ts-publish` lại.");
  } else {
    warn("[services] TS_SERVICES_AUTOAPPROVE=0 → service có thể kẹt 'pending approval'; duyệt thủ công trong admin console.");
  }
}

let ENV = {};
async function main() {
  ENV = { ...parseEnv(ENV_FILE), ...process.env };
  const cfg = resolvePublishConfig(ENV);
  for (const w of cfg.warnings) warn(`WARN: ${w}`);

  log(`=== Tailscale Publish${DRY_RUN ? " (DRY RUN)" : ""} — mode=${cfg.mode} ===`);
  if (cfg.mode === "off") {
    log("TS_PUBLISH_MODE=off → không publish app. Giữ nguyên serve.json/ACL hiện tại. (SSH 2222 không bị đụng.)");
    return;
  }

  const services = loadServices();
  log(`Services: ${services.map((s) => s.name).join(", ")}`);

  // ── Auto-detect hostname nếu chưa set hoặc đang dùng default sai ──
  if (cfg.doServe && cfg.serveStyle === "path") {
    const statusOut = dockerExec("compose exec -T tailscale tailscale status --json", { capture: true });
    if (statusOut.ok && statusOut.out) {
      const realHost = extractHostname(statusOut.out);
      if (realHost && realHost !== cfg.nodeHost) {
        log(`[hostname] Auto-detect: "${cfg.nodeHost}" → "${realHost}" (sửa serve.json host key)`);
        cfg.nodeHost = realHost;
        // Ghi hostname thật về .env để lần sau không cần detect lại
        writeEnvVar(ENV_FILE, "TS_HOSTNAME", realHost);
      }
    }
  }

  // ── Idempotency (prompt mục 4): skip nếu config hash khớp + serve state còn ──
  const hash = computePublishHash({ cfg, services });
  const prevState = readPublishState(PUBLISH_STATE_FILE);
  let serveConfirmed = true;
  if (cfg.doServe) {
    const serveStatus = dockerExec("compose exec -T tailscale tailscale serve status --json", { capture: true });
    serveConfirmed = serveStatus.ok && serveStatus.out ? serveStatePresent(serveStatus.out) : false;
  }
  const decision = shouldSkipPublish({ hash, prevState, serveConfirmed, cfg });
  log(`[idempotent] hash=${hash.slice(0, 12)} prev=${prevState?.hash?.slice(0, 12) || "(none)"} serveConfirmed=${serveConfirmed} → ${decision.skip ? "SKIP" : "PUBLISH"} (${decision.reason})`);
  if (decision.skip && !DRY_RUN) {
    log("Already published (config hash khớp + serve state còn tồn tại) — bỏ qua API PUT/POST & CLI advertise.");
    log("Publish hoàn tất (no-op).");
    return;
  }

  if (cfg.doServe) applyServe(services, cfg, ENV);
  if (cfg.doServices) await applyServices(services, cfg, ENV);

  // Ghi state sau khi publish thành công (best-effort, không làm gãy stack).
  writePublishState(PUBLISH_STATE_FILE, {
    hash,
    mode: cfg.mode,
    serveStyle: cfg.serveStyle,
    tailnet: cfg.tailnet,
    nodeHost: cfg.nodeHost,
    services: services.map((s) => s.name),
  });

  log("Publish hoàn tất.");
}

try {
  await main();
} catch (e) {
  // Bất biến: publish KHÔNG được làm gãy stack. Log rồi thoát 0.
  warn(`WARN: publish gặp lỗi nhưng bỏ qua để không ảnh hưởng stack/sync: ${e.message}`);
}
