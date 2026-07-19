#!/usr/bin/env node
// scripts/runners/start-stack.mjs
// CI: start Docker Compose stack, fail fast if cloudflared is not running.
//
// Env vars: MODE (named | quick).
// Flags:
//   --dry-run   Show commands without running
//   --silent    Suppress output
import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectDocker } from "./_docker.mjs";
import { envGet, parseEnv } from "../lib/env-utils.mjs";
import { redactSecrets } from "../lib/redact-utils.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => {
  if (!SILENT) console.log(...a);
};
const err = (...a) => {
  if (!SILENT) console.error(...a);
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const MODE = process.env.MODE || "quick";

process.chdir(ROOT);

const docker = DRY_RUN ? { available: true, cmd: "docker", via: "dry-run" } : detectDocker();
if (!docker.available) {
  console.error("ERROR: Docker daemon unavailable. Start Docker Desktop/Engine, or use --dry-run.");
  process.exit(1);
}
const dc = (parts) => `${docker.cmd} ${parts}`;
log(`Docker: ${docker.via} (${docker.cmd})`);

function run(cmd) {
  if (DRY_RUN) {
    log(`[DRY RUN] ${cmd}`);
    return;
  }
  execSync(cmd, { stdio: SILENT ? "ignore" : "inherit", cwd: ROOT });
}
function runPrefixed(name, cmd) {
  if (DRY_RUN) {
    log(`[DRY RUN] ${cmd}`);
    return Promise.resolve();
  }
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(cmd, { cwd: ROOT, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    const write = (stream, data) => {
      if (SILENT) return;
      for (const line of data.toString().split(/\r?\n/).filter(Boolean)) stream.write(`[${name}] ${line}\n`);
    };
    proc.stdout.on("data", (data) => write(process.stdout, data));
    proc.stderr.on("data", (data) => write(process.stderr, data));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolvePromise() : reject(new Error(`${name} failed with exit code ${code}`))));
  });
}
function sh(cmd) {
  if (DRY_RUN) return "";
  return execSync(cmd, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] })
    .toString()
    .trim();
}

function hasLitestreamConfig(envFile) {
  const env = { ...parseEnv(envFile), ...process.env };
  return Object.keys(env).some((key) => /^LITESTREAM_\d+_SERVICE$/.test(key));
}

function hasRcloneConfig(envFile) {
  const env = { ...parseEnv(envFile), ...process.env };
  return Object.keys(env).some((key) => /^RCLONE_\d+_NAME$/.test(key));
}

// nodesync bật khi SSH_ENABLE=1 (đồng bộ dữ liệu giữa node qua SSH).
function envTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "0").toLowerCase());
}

function nodesyncConfig(envFile) {
  const env = { ...parseEnv(envFile), ...process.env };
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

function firstIndexedName(envFile, prefix, key) {
  const env = { ...parseEnv(envFile), ...process.env };
  const indexes = Object.keys(env)
    .map((name) => name.match(new RegExp(`^${prefix}_(\\d+)_${key}$`))?.[1])
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b));
  if (indexes.length === 0) return "";
  const index = indexes[0];
  return `${prefix.toLowerCase()}-${index}-${env[`${prefix}_${index}_${key}`]}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function ensureProfile(name, envFile) {
  const current = process.env.COMPOSE_PROFILES || envGet(envFile, "COMPOSE_PROFILES") || "";
  if (current.split(/[,\s]+/).includes(name)) return;
  process.env.COMPOSE_PROFILES = current ? `${current},${name}` : name;
  log(`Ensuring ${name} profile is enabled`);
}

function resolveVolumeRoot(value, fallback) {
  return resolve(ROOT, value || fallback);
}

function composeArgs(command) {
  const files = MODE === "named" ? "" : "-f docker-compose.yml -f docker-compose.ci.yml ";
  return dc(`compose ${files}${command}`);
}

async function waitForHealthy(service, timeoutMs = 90_000) {
  if (DRY_RUN) {
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
    await new Promise((done) => setTimeout(done, 2_000));
  }
  throw new Error(`${service} không healthy sau ${timeoutMs / 1000}s`);
}

async function waitForTailscale(timeoutMs = 60_000) {
  if (DRY_RUN) {
    log("[DRY RUN] chờ tailscale LocalAPI sẵn sàng");
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const output = sh(dc("exec tailscale tailscale status --json"));
      const status = JSON.parse(output);
      if (status?.Self?.Online || status?.BackendState === "Running") return true;
    } catch {}
    await new Promise((done) => setTimeout(done, 2_000));
  }
  return false;
}
function predecessorTailnetHost(file) {
  if (DRY_RUN) return "";
  try {
    const source = JSON.parse(readFileSync(file, "utf8"))?.source;
    const host = source?.tailscale?.dnsName?.replace(/\.$/, "") || source?.tailscale?.ip || "";
    return /^[a-zA-Z0-9_.:-]+$/.test(host) ? host : "";
  } catch {
    return "";
  }
}
function warmTailscalePeer(file, hasFallback) {
  const host = predecessorTailnetHost(file);
  if (!host) return;
  try {
    run(dc(`exec tailscale tailscale ping --c=1 ${host}`));
  } catch {
    const msg = `Tailscale peer ${host} chưa reachable; `;
    if (!hasFallback) throw new Error(`${msg}không có channel fallback`);
    err(`WARN: ${msg}sẽ thử Cloudflare/Hybrid fallback.`);
  }
}

// chmod scripts
try {
  run("bash -c 'chmod +x scripts/*.sh */scripts/*.sh 2>/dev/null || chmod +x scripts/*.sh'");
} catch {}

// Show active profiles
const envFile = resolve(ROOT, ".env");
log("Base COMPOSE_PROFILES:", envGet(envFile, "COMPOSE_PROFILES") || "(unset)");
if (hasLitestreamConfig(envFile)) {
  ensureProfile("litestream", envFile);
  process.env.LITESTREAM_CONTAINER_NAME = firstIndexedName(envFile, "LITESTREAM", "SERVICE");
}
if (hasRcloneConfig(envFile)) {
  ensureProfile("rclone", envFile);
  process.env.RCLONE_CONTAINER_NAME = firstIndexedName(envFile, "RCLONE", "NAME");
}
const nodesync = nodesyncConfig(envFile);
if (nodesync.enabled) {
  ensureProfile("nodesync", envFile);
  if (nodesync.tailscaleChannel) ensureProfile("tailscale", envFile);
  log(`Nodesync enabled; paths=${nodesync.paths.length}; tailscale-channel=${nodesync.tailscaleChannel}`);
}
// [YC] Hostname Tailscale phải DUY NHẤT theo từng runner. Nếu 2 runner cùng
// hostname "proxy-stack", Tailscale coi là CÙNG một node (re-register đè) →
// chỉ 1 IP tồn tại, runner kia mất tailnet IP → rsync qua tailscale hỏng.
// Gắn hậu tố provider-runId-attempt (github/azure tự detect) để tách bạch.
function uniqueTsHostname(base = "proxy-stack") {
  const gh = process.env.GITHUB_ACTIONS === "true";
  const az = process.env.TF_BUILD === "True" || !!process.env.BUILD_BUILDID;
  let suffix = "";
  if (gh) suffix = `gh-${process.env.GITHUB_RUN_ID || ""}-${process.env.GITHUB_RUN_ATTEMPT || "1"}`;
  else if (az) suffix = `az-${process.env.BUILD_BUILDID || ""}-${process.env.SYSTEM_JOBATTEMPT || "1"}`;
  if (!suffix) return base; // local dev: giữ nguyên
  // Tailscale hostname: chỉ [a-z0-9-], tối đa 63 ký tự.
  return `${base}-${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}
if (nodesync.enabled && nodesync.tailscaleChannel) {
  const tsHost = uniqueTsHostname(envGet(envFile, "TS_HOSTNAME") || "proxy-stack");
  process.env.TS_HOSTNAME = tsHost;
  // Tailscale container owns only the userspace network/SOCKS5 transport.
  // SSH identity, users and workspace live on the host runner, so do not enable
  // Tailscale SSH here; Serve TCP forwards tailnet:2222 to host sshd:22.
  const baseExtra = process.env.TS_EXTRA_ARGS || envGet(envFile, "TS_EXTRA_ARGS") || "--accept-dns=false";
  process.env.TS_EXTRA_ARGS = baseExtra
    .replace(/(?:^|\s)--ssh(?:=true)?(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  log(`Tailscale transport identity: hostname=${tsHost} extraArgs="${process.env.TS_EXTRA_ARGS}"`);
}
process.env.DOCKER_VOLUME_RUNTIME_ABS = resolveVolumeRoot(envGet(envFile, "DOCKER_VOLUME_RUNTIME"), "ci-runtime");
process.env.DOCKER_VOLUME_DATA_ABS = resolveVolumeRoot(envGet(envFile, "DOCKER_VOLUME_DATA"), "ci-data");

run(`node litestream/scripts/generate-config.mjs${SILENT ? " --silent" : ""}`);
await Promise.all([
  runPrefixed("litestream", `node litestream/scripts/restore.mjs${SILENT ? " --silent" : ""}`),
  runPrefixed("rclone", `node rclone/scripts/pull.mjs${SILENT ? " --silent" : ""}`),
]);

// Nodesync zero-touch: bootstrap host SSH, register RTDB, discover predecessor,
// rồi sync configured paths. Không restore/pull dữ liệu trong sidecar này.
//
// [YC #3] THỨ TỰ BẮT BUỘC:
//   1) tailscale connect (join tailnet) TRƯỚC
//   2) rsync dữ liệu từ predecessor
//   3) CHỈ SAU KHI rsync xong (orchestrator qua sync-gate → giành leader) mới
//      start cloudflared của node MỚI.
//   Lý do: named tunnel là multi-connector; nếu cloudflared node mới connect
//   TRƯỚC khi rsync xong, Cloudflare có thể route ssh.<domain> về CHÍNH nó thay
//   vì predecessor → rsync kéo dữ liệu từ chính mình / host-key mismatch.
//   => Ở giai đoạn sync, TUYỆT ĐỐI KHÔNG start cloudflared.
if (nodesync.enabled) {
  if (nodesync.paths.length) {
    if (!nodesync.orchestratorEnabled) throw new Error("SSH_SYNC_PATHS có dữ liệu nhưng CONSUL_ENABLE!=1; RTDB discovery là bắt buộc");
    // KHÔNG start cloudflared ở đây (xem lý do trên). Client Cloudflare channel
    // chỉ cần `cloudflared access ssh` (outbound) — không cần connector local.
    const services = ["orchestrator", "nodesync"];
    if (nodesync.tailscaleChannel) services.unshift("tailscale");
    run(composeArgs(`up -d ${services.join(" ")}`));
    await waitForHealthy("nodesync");
    if (nodesync.tailscaleChannel) {
      // Chờ tailnet của CHÍNH node này online (điều kiện cần để đi đường tailscale).
      if (!(await waitForTailscale())) {
        const hasFallback = nodesync.cloudflareChannel || nodesync.hybridChannel;
        if (!hasFallback) throw new Error("Tailscale chưa sẵn sàng và không có channel fallback");
        err("WARN: Tailscale chưa sẵn sàng; thử Cloudflare/Hybrid fallback.");
      } else {
        // This command runs on the host against the Tailscale sidecar. The
        // resulting listener belongs to the tailnet node, while SSH terminates
        // at host.docker.internal:22 where nodesync users/data actually live.
        run(dc("exec tailscale tailscale serve --bg --tcp=2222 tcp://host.docker.internal:22"));
        log("Tailscale transport ready: tailnet:2222 → runner sshd:22 via userspace SOCKS5.");
        // [YC #2] waitForTailscale() chỉ xác nhận CHÍNH node này online với
        // control-plane, KHÔNG đảm bảo netmap/DERP path tới predecessor đã
        // hội tụ xong. Trên GitHub-hosted runner, UDP outbound thường bị hạn
        // chế nên WireGuard P2P phải fallback qua DERP relay — việc này cần
        // thêm vài giây ở cả 2 phía trước khi SOCKS5 CONNECT hoạt động ổn định.
        // Không chờ đủ → nc/ssh probe bị tailscaled từ chối ngay lập tức với
        // "General SOCKS server failure" dù ACL đã cho phép mọi node.
        const meshWarmupSec = Number(process.env.TS_MESH_WARMUP_SECONDS || 8);
        if (meshWarmupSec > 0) {
          log(`Chờ ${meshWarmupSec}s để Tailscale netmap/DERP hội tụ trước khi sync...`);
          if (!DRY_RUN) await new Promise((done) => setTimeout(done, meshWarmupSec * 1000));
        }
      }
    }
    // Registration ghi node booting ngay; đợi ngắn để RTDB server timestamp ổn định.
    if (!DRY_RUN) await new Promise((done) => setTimeout(done, 3000));
    log("Discovering nodesync predecessor...");
    // Container discover là ONE-SHOT (--rm) và CHỈ ĐỌC RTDB (không register,
    // không onDisconnect) → an toàn, dùng chung node-id để tự loại mình khỏi
    // danh sách predecessor candidate.
    run(composeArgs(`run --rm --no-deps orchestrator node scripts/discover-predecessor.mjs --json > ci-runtime/nodesync/predecessor.json`));
    log("Nodesync predecessor manifest ready.");
    if (nodesync.tailscaleChannel) warmTailscalePeer(resolve(ROOT, "ci-runtime/nodesync/predecessor.json"), nodesync.cloudflareChannel || nodesync.hybridChannel);
    // rsync: sync.mjs sẽ ghi cờ ci-runtime/nodesync/sync-ok khi xong → orchestrator
    // (đang chờ ở sync-gate) mới được phép giành leader.
    run(composeArgs(`exec -T nodesync node scripts/sync.mjs${SILENT ? " --silent" : ""}`));
    log("Nodesync rsync hoàn tất (sync-ok đã ghi); orchestrator có thể giành leader.");
  } else log("SSH_SYNC_PATHS rỗng: không discover/SSH/rsync.");
}

// Start stack (đây mới là lúc cloudflared của node mới connect — SAU rsync).
if (MODE === "named") {
  run(dc("compose up -d --remove-orphans"));
} else {
  log("Resolved cloudflared service (must use --url, not run-with-token):");
  if (!DRY_RUN) {
    try {
      const cfg = sh(dc("compose -f docker-compose.yml -f docker-compose.ci.yml config"));
      const block = cfg.split("\n");
      let printing = false;
      for (const line of block) {
        if (/^  cloudflared:/.test(line)) printing = true;
        else if (printing && /^  [a-z]/.test(line)) break;
        if (printing) log(redactSecrets(line));
      }
    } catch {}
  }
  run(dc("compose -f docker-compose.yml -f docker-compose.ci.yml up -d --remove-orphans"));
}

run(dc("compose ps"));

// Publish stack apps qua tailnet (Cách A/B theo TS_PUBLISH_MODE). Tách hẳn ra
// tailscale/scripts/publish.mjs — start-stack.mjs chỉ gọi 1 dòng. No-op khi
// TS_PUBLISH_MODE=off; publish.mjs tự nuốt lỗi (KHÔNG làm gãy stack / SSH 2222).
{
  const activeProfiles = process.env.COMPOSE_PROFILES || envGet(envFile, "COMPOSE_PROFILES") || "";
  const tailscaleActive = /(^|[,\s])(tailscale|full)([,\s]|$)/.test(activeProfiles);
  const publishMode = (process.env.TS_PUBLISH_MODE || envGet(envFile, "TS_PUBLISH_MODE") || "off").toLowerCase();
  if (tailscaleActive && publishMode !== "off") {
    log(`Publishing apps over tailnet (TS_PUBLISH_MODE=${publishMode})...`);
    try {
      run(`node tailscale/scripts/publish.mjs${DRY_RUN ? " --dry-run" : ""}${SILENT ? " --silent" : ""}`);
    } catch (e) {
      log(`WARN: publish qua tailnet lỗi nhưng bỏ qua để không ảnh hưởng stack: ${e.message}`);
    }

    // Fire-and-forget: đợi tailscale online, detect hostname thật, ghi .env, re-publish nếu sai.
    try {
      const nodeBin = process.execPath;
      const waitScript = resolve(ROOT, "tailscale/scripts/wait-ready.mjs");
      const dryFlag = DRY_RUN ? " --dry-run" : "";
      const { spawn } = await import("node:child_process");
      spawn(nodeBin, [waitScript, dryFlag], { cwd: ROOT, stdio: "ignore", detached: true }).unref();
      log("(wait-ready đang chạy nền — tailscale sẽ tự detect hostname thật rồi ghi .env)");
    } catch (e) {
      log(`WARN: spawn wait-ready lỗi (bỏ qua): ${e.message}`);
    }
  }
}

if (DRY_RUN) {
  log("[DRY RUN] Would check cloudflared is running after 3s");
  process.exit(0);
}

// Fail fast if cloudflared is not running
execSync("sleep 3", { stdio: "inherit" });
try {
  const running = sh(dc("compose ps --status running --services"));
  if (!running.split("\n").includes("cloudflared")) throw new Error("not running");
} catch {
  err("ERROR: cloudflared is not running after up");
  try {
    run(dc("compose ps -a"));
  } catch {}
  try {
    run(dc("compose logs --no-color cloudflared"));
  } catch {}
  process.exit(1);
}
