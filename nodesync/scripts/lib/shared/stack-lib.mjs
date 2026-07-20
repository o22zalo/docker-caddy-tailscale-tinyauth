#!/usr/bin/env node
// scripts/lib/stack-lib.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth cho logic khởi động stack, được chia sẻ giữa
//   - scripts/up.mjs                 (dev / prod / ci thủ công)
//   - scripts/runners/start-stack.mjs (CI runner)
//
// Trước đây hai file này copy-paste gần như y hệt các hàm: nodesync config,
// uniqueTsHostname, poll tailscale, warm peer, hard-wait mesh warmup 8s, v.v.
// Tách vào đây để CHỈ CÓ MỘT nguồn sự thật (yêu cầu prompt mục 4 & bất biến
// "mọi thay đổi áp dụng đồng bộ cho start-stack.mjs và up.mjs").
//
// NGUYÊN TẮC THIẾT KẾ (theo prompt mục 4):
//   * KHÔNG hard-wait cố định. `sleep(8000)` mesh warmup và `sleep(3000)` chờ
//     RTDB timestamp được thay bằng poll/probe có điều kiện, thoát ngay khi OK.
//   * Node ĐẦU TIÊN (không có predecessor) skip warm peer / rsync / sync-gate —
//     discover-predecessor.mjs trả source=null, sync.mjs tự ghi sync-ok
//     "first-runner"; elect.mjs giành leader trống với term=1.
//   * Node CÓ predecessor giữ đúng thứ tự an toàn: transport ready → discover →
//     sync xong → chỉ khi đó cloudflared connector mới nhận traffic.
//   * TCP 2222 (SSH sync) là bất biến — không hàm nào ở đây được đụng tới.
//
// Các hàm ở đây thuần side-effect-free KHI CÓ THỂ (parse/format) để dễ unit
// test; các hàm cần docker/exec nhận `deps` (run, sh, dc, log, err) để test
// bằng cách inject fake.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { parseEnv, envGet } from "./env-utils.mjs";

// ── Env truthiness (khớp cả up.mjs lẫn start-stack.mjs) ──────────────────────
export function envTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "0").toLowerCase());
}

/** Merge .env file + process.env (process.env thắng). */
export function mergedEnv(envFile) {
  return { ...parseEnv(envFile), ...process.env };
}

export function hasLitestreamConfig(envFile) {
  const env = mergedEnv(envFile);
  return Object.keys(env).some((key) => /^LITESTREAM_\d+_SERVICE$/.test(key));
}

export function hasRcloneConfig(envFile) {
  const env = mergedEnv(envFile);
  return Object.keys(env).some((key) => /^RCLONE_\d+_NAME$/.test(key));
}

/**
 * Đọc cấu hình nodesync từ .env + process.env.
 * `enabled` bật khi SSH_ENABLE truthy. `paths` là danh sách sync path đã trim.
 */
export function nodesyncConfig(envFile) {
  const env = mergedEnv(envFile);
  const smoke = envTruthy(env.SSH_SYNC_SMOKE_ENABLE);
  return {
    enabled: envTruthy(env.SSH_ENABLE),
    paths: String(env.SSH_SYNC_PATHS || (smoke ? "ci-runtime/smoke-sync-data" : ""))
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    tailscaleChannel: envTruthy(env.SSH_CHANNEL_TAILSCALE_ENABLE ?? "1"),
    cloudflareChannel: envTruthy(env.SSH_CHANNEL_CLOUDFLARE_ENABLE),
    hybridChannel: envTruthy(env.SSH_CHANNEL_HYBRID_ENABLE),
    orchestratorEnabled: envTruthy(env.CONSUL_ENABLE),
  };
}

export function firstIndexedName(envFile, prefix, key) {
  const env = mergedEnv(envFile);
  const indexes = Object.keys(env)
    .map((name) => name.match(new RegExp(`^${prefix}_(\\d+)_${key}$`))?.[1])
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b));
  if (indexes.length === 0) return "";
  const index = indexes[0];
  return `${prefix.toLowerCase()}-${index}-${env[`${prefix}_${index}_${key}`]}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

// ── Tailscale hostname duy nhất theo runner ──────────────────────────────────
// [YC] Nếu 2 runner cùng hostname "proxy-stack", Tailscale coi là CÙNG node
// (re-register đè) → chỉ 1 IP tồn tại → rsync qua tailscale hỏng. Gắn hậu tố
// provider-runId-attempt để tách bạch. Tailscale hostname: chỉ [a-z0-9-], ≤63.
export function uniqueTsHostname(base = "proxy-stack", env = process.env) {
  const gh = env.GITHUB_ACTIONS === "true";
  const az = env.TF_BUILD === "True" || !!env.BUILD_BUILDID;
  let suffix = "";
  if (gh) suffix = `gh-${env.GITHUB_RUN_ID || ""}-${env.GITHUB_RUN_ATTEMPT || "1"}`;
  else if (az) suffix = `az-${env.BUILD_BUILDID || ""}-${env.SYSTEM_JOBATTEMPT || "1"}`;
  if (!suffix) return base; // local dev: giữ nguyên
  return `${base}-${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

/**
 * Tính TS_EXTRA_ARGS đã loại bỏ --ssh (tailscale container CHỈ giữ userspace
 * transport; SSH identity + users + workspace nằm trên host runner). Trả string.
 */
export function sanitizeTsExtraArgs(baseExtra = "--accept-dns=false") {
  return String(baseExtra)
    .replace(/(?:^|\s)--ssh(?:=true)?(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Predecessor manifest ─────────────────────────────────────────────────────
/**
 * Đọc predecessor.json và cho biết node hiện tại có predecessor hay không.
 * Trả { hasPredecessor, host }. host là tailnet host của predecessor (nếu có),
 * dùng để warm peer. Node ĐẦU TIÊN → hasPredecessor=false → skip warmup/rsync.
 * Không throw: file thiếu/hỏng coi như "chưa xác định predecessor".
 */
export function readPredecessor(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const source = parsed?.source;
    if (!source) return { hasPredecessor: false, host: "" };
    const rawHost = source?.tailscale?.dnsName?.replace(/\.$/, "") || source?.tailscale?.ip || "";
    const host = /^[a-zA-Z0-9_.:-]+$/.test(rawHost) ? rawHost : "";
    return { hasPredecessor: true, host };
  } catch (e) {
    // File tồn tại nhưng parse lỗi → có thể CÓ predecessor nhưng file hỏng.
    // An toàn hơn là KHÔNG skip rsync (tránh mất dữ liệu). Host rỗng →
    // warm peer sẽ tự no-op, sync.mjs vẫn chạy rsync bình thường.
    if (e?.code !== "ENOENT") {
      return { hasPredecessor: true, host: "" };
    }
    return { hasPredecessor: false, host: "" };
  }
}

// ── Poll helpers (thay hard-wait) ────────────────────────────────────────────
/**
 * Poll cho đến khi service healthy/running. Interval NGẮN (mặc định 750ms) thay
 * vì chờ cố định 2s — nhưng KHÔNG nới lỏng tiêu chí healthy (yêu cầu prompt).
 * deps: { sh(cmd)->string, dc(parts)->string, log, dryRun }
 * Ném lỗi nếu unhealthy/exited hoặc quá timeout.
 */
export async function waitForHealthy(service, { sh, dc, log = () => {}, dryRun = false } = {}, timeoutMs = 90_000, pollMs = 750) {
  if (dryRun) {
    log(`[DRY RUN] chờ ${service} healthy`);
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = sh(dc(`inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' ${service}`));
      if (status === "healthy" || status === "running") return;
      if (status === "unhealthy" || status === "exited") throw new Error(`${service} status=${status}`);
    } catch (e) {
      if (/status=(unhealthy|exited)/.test(e.message)) throw e;
    }
    await sleep(pollMs);
  }
  throw new Error(`${service} không healthy sau ${timeoutMs / 1000}s`);
}

/**
 * Poll tailscale LocalAPI cho tới khi Self.Online hoặc BackendState=Running.
 * Trả true/false (KHÔNG throw). Interval ngắn (1s) thay vì 2s.
 * deps: { sh, dc, log, dryRun }
 */
export async function waitForTailscale({ sh, dc, log = () => {}, dryRun = false } = {}, timeoutMs = 60_000, pollMs = 1000) {
  if (dryRun) {
    log("[DRY RUN] chờ tailscale LocalAPI sẵn sàng");
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // `docker exec tailscale ...` (không dùng -T vì đây là `docker exec`, không
      // phải `docker compose exec`). Container name = "tailscale".
      const output = sh(dc("exec tailscale tailscale status --json"));
      const status = JSON.parse(output);
      if (status?.Self?.Online || status?.BackendState === "Running") return true;
    } catch {}
    await sleep(pollMs);
  }
  return false;
}

/**
 * Poll cho tới khi service `cloudflared` running. Thay `sleep 3` mù bằng
 * fail-fast poll. Trả true nếu running, false nếu quá timeout.
 * deps: { sh, dc, dryRun }
 */
export async function waitForServiceRunning(service, { sh, dc, dryRun = false } = {}, timeoutMs = 30_000, pollMs = 500) {
  if (dryRun) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const running = sh(dc("compose ps --status running --services"));
      if (running.split("\n").includes(service)) return true;
    } catch {}
    await sleep(pollMs);
  }
  return false;
}

/**
 * Probe predecessor qua SOCKS5 (tailscale userspace) bằng `nc -z` — chỉ mở/đóng
 * kết nối, KHÔNG gửi dữ liệu. Thay cho hard-wait mesh warmup 8s: ép tailscaled
 * thiết lập netmap/DERP path tới peer, retry ngắn có backoff, THOÁT NGAY khi OK.
 *
 * Lưu ý: sync.mjs cũng warmup từng endpoint; probe ở đây chỉ là "best-effort"
 * để giảm độ trễ cú probe đầu. KHÔNG throw — path thật do sync.mjs quyết định.
 * deps: { runCapture(cmd,args,timeoutMs)->{ok}, log, dryRun }
 */
export async function probePredecessorSocks(host, { runCapture, log = () => {}, dryRun = false } = {}, opts = {}) {
  const port = opts.port || 2222;
  const retries = Math.max(1, Number(opts.retries ?? process.env.TS_MESH_PROBE_RETRIES ?? 5));
  const delayMs = Math.max(0, Number(opts.delayMs ?? process.env.TS_MESH_PROBE_DELAY_MS ?? 1000));
  const timeoutSec = Math.max(1, Number(opts.timeoutSec ?? 3));
  if (!host) {
    log("probePredecessorSocks: không có host predecessor → skip.");
    return false;
  }
  if (dryRun) {
    log(`[DRY RUN] probe SOCKS5 predecessor ${host}:${port}`);
    return true;
  }
  for (let attempt = 1; attempt <= retries; attempt++) {
    const r = await runCapture("docker", ["exec", "tailscale", "nc", "-z", "-w", String(timeoutSec), "-x", "localhost:1055", host, String(port)], (timeoutSec + 2) * 1000);
    if (r.ok) {
      log(`probePredecessorSocks OK endpoint=${host}:${port} attempt=${attempt}/${retries}`);
      return true;
    }
    log(`probePredecessorSocks miss endpoint=${host}:${port} attempt=${attempt}/${retries}`);
    if (attempt < retries) await sleep(delayMs);
  }
  log(`probePredecessorSocks: predecessor ${host}:${port} chưa reachable sau ${retries} lần — để sync.mjs tự warmup/quyết định.`);
  return false;
}

// ── util ─────────────────────────────────────────────────────────────────────
export function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** Đọc COMPOSE_PROFILES đang active (process.env thắng .env). */
export function activeProfiles(envFile) {
  return process.env.COMPOSE_PROFILES || envGet(envFile, "COMPOSE_PROFILES") || "";
}

export function tailscaleProfileActive(profiles) {
  return /(^|[,\s])(tailscale|full)([,\s]|$)/.test(profiles);
}
