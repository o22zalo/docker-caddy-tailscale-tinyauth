#!/usr/bin/env node
// scripts/runners/setup-nodesync-ssh.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Configure host sshd + publish pinned connection metadata, non-interactive.
//
// TỐI ƯU (prompt mục 3):
//   * Chỉ cài `openssh-server` KHI THIẾU `sshd`. KHÔNG cài lại rsync/sshpass
//     (đã có sẵn trên GitHub ubuntu-24.04). Root cause chậm là thiếu
//     openssh-server → không có lệnh `sshd`, KHÔNG phải thiếu sshpass.
//   * `apt-get update` chạy TRƯỚC install (GitHub khuyến nghị, tránh index cũ),
//     nhưng CHỈ khi thật sự cần cài.
//   * Đọc /etc/ssh/ssh_host_ed25519_key.pub TRỰC TIẾP thay `ssh-keyscan` qua
//     network (giữ manifest format tương thích: prefix `127.0.0.1`).
//   * Tạo riêng host key ed25519 (không `ssh-keygen -A` tạo cả RSA/ECDSA thừa),
//     CHỈ tạo khi file chưa tồn tại.
//   * CHỈ restart sshd khi drop-in THỰC SỰ thay đổi; luôn `sshd -t` trước restart.
//   * Giữ nguyên chmod/ownership, /run/sshd, /etc/nodesync, symlink workspace,
//     quyền đọc sync path — KHÔNG bỏ home/authorized_keys/private key.
//
// BẤT BIẾN: TCP 2222 (tailscale serve → host sshd:22) do start-stack quản lý;
// file này chỉ dựng sshd:22 trên host, không đụng port 2222.
//
// Log timestamp từng substep để đo (prompt mục 3 & 5).
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname, parse, resolve } from "node:path";
import { parseEnv } from "../lib/env-utils.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const ENV = resolve(ROOT, ".env");
const env = { ...(existsSync(ENV) ? parseEnv(ENV) : {}), ...process.env };
const enabled = /^(1|true|yes|on)$/i.test(env.SSH_ENABLE || "0");
const dry = process.argv.includes("--dry-run");
const runtime = resolve(ROOT, "ci-runtime/nodesync");
const keyFile = resolve(runtime, "id_ed25519");
const identityFile = resolve(runtime, "node-id");
const manifestFile = resolve(runtime, "host-ssh.json");
const nodeId = env.ORCH_NODE_ID || "local-unknown";
const users = Object.keys(env)
  .map((k) => k.match(/^SSH_(\d+)_USER$/))
  .filter(Boolean)
  .sort((a, b) => +a[1] - +b[1])
  .map((m) => env[m[0]])
  .filter(Boolean);
const sshUser = users[0];

const safe = (x) => String(x).replace(/(password|pass|secret|token|private[_-]?key)=\S+/gi, "$1=<hidden>");
const ts = () => new Date().toISOString();
function timed(label, fn) {
  const t0 = Date.now();
  console.log(`[nodesync-ssh] ${label} start ts=${ts()}`);
  const out = fn();
  console.log(`[nodesync-ssh] ${label} done ts=${ts()} durationMs=${Date.now() - t0}`);
  return out;
}
function run(cmd, args, opt = {}) {
  console.log(`[nodesync-ssh] ${safe(cmd + " " + args.join(" "))}`);
  if (dry) return "";
  const out = execFileSync(cmd, args, {
    encoding: "utf8",
    input: opt.input,
    stdio: opt.capture ? ["pipe", "pipe", "pipe"] : "inherit",
  });
  return typeof out === "string" ? out.trim() : "";
}
const sudo = (cmd, args, opt) => (process.getuid?.() === 0 ? run(cmd, args, opt) : run("sudo", ["-n", cmd, ...args], opt));
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "0"));
const syncPaths = String(env.SSH_SYNC_PATHS || (truthy(env.SSH_SYNC_SMOKE_ENABLE) ? "ci-runtime/smoke-sync-data" : ""))
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

function safeSyncPath(p) {
  if (!p || p.startsWith("/") || p.split(/[\\/]+/).includes("..") || p === "." || p === "ci-runtime") throw new Error(`unsafe sync path: ${p}`);
  return p;
}
function grantSyncReads() {
  // Thu thập tất cả chmod commands, chạy 1 lần sudo thay vì N lần
  const cmds = [];
  for (const raw of syncPaths) {
    const rel = safeSyncPath(raw);
    const target = resolve(ROOT, rel);
    if (!existsSync(target)) continue;
    const root = parse(target).root;
    let cur = target;
    while (cur && cur !== root) {
      cur = dirname(cur);
      if (existsSync(cur)) cmds.push(`chmod a+X ${JSON.stringify(cur)}`);
    }
    cmds.push(`chmod -R a+rX ${JSON.stringify(target)}`);
  }
  if (cmds.length === 0) return;
  if (dry) { log(`[DRY RUN] grantSyncReads: ${cmds.length} chmod ops`); return; }
  execFileSync("sudo", ["-n", "sh", "-c", cmds.join(" && ")], { stdio: "inherit" });
}

// ── Chỉ cài openssh-server khi thiếu sshd (KHÔNG đụng rsync/sshpass) ──────────
function ensureSshd() {
  // Kiểm tra sshd đã có chưa. rsync/sshpass được assume có sẵn trên ubuntu-24.04;
  // nếu thiếu, sync.mjs / setup-users sẽ báo lỗi rõ ràng ở bước dùng chúng.
  const has = spawnSync("sh", ["-lc", "command -v sshd >/dev/null 2>&1"]);
  if (has.status === 0) {
    console.log("[nodesync-ssh] sshd đã có sẵn — bỏ qua cài openssh-server.");
    return;
  }
  console.log("[nodesync-ssh] Thiếu sshd → cài openssh-server (apt-get update trước).");
  const install = spawnSync("sh", [
    "-lc",
    "sudo -n apt-get update -qq && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openssh-server",
  ], { stdio: "inherit" });
  if (install.status !== 0) throw new Error("cài openssh-server (non-interactive) thất bại");
}

// ── Host key ed25519: chỉ tạo khi chưa có; đọc .pub trực tiếp ─────────────────
function ensureHostKey() {
  const hostKeyPath = "/etc/ssh/ssh_host_ed25519_key";
  const hostKeyPub = `${hostKeyPath}.pub`;
  // Chỉ tạo ed25519 (không -A tạo RSA/ECDSA thừa), chỉ khi CHƯA tồn tại.
  if (!existsSync(hostKeyPath)) {
    sudo("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKeyPath]);
  } else {
    console.log("[nodesync-ssh] host key ed25519 đã tồn tại — không tạo lại.");
  }
  return hostKeyPub;
}

// ── Drop-in sshd config: chỉ install + restart khi NỘI DUNG thay đổi ─────────
function applySshdDropin() {
  const dropinPath = "/etc/ssh/sshd_config.d/99-nodesync.conf";
  const dropin =
    [
      "PasswordAuthentication yes",
      "KbdInteractiveAuthentication no",
      "PubkeyAuthentication yes",
      "PermitRootLogin no",
      "UsePAM yes",
      "AllowTcpForwarding no",
      "X11Forwarding no",
      "PermitTTY yes",
      `AllowUsers ${users.join(" ")}`,
    ].join("\n") + "\n";

  // So sánh với nội dung hiện tại (đọc qua sudo cat, an toàn nếu file chưa có).
  let current = "";
  const cat = spawnSync("sh", ["-lc", `sudo -n cat ${dropinPath} 2>/dev/null || true`], { encoding: "utf8" });
  if (cat.status === 0) current = cat.stdout || "";

  const changed = current !== dropin;
  if (!changed) {
    console.log("[nodesync-ssh] drop-in sshd không đổi — bỏ qua ghi + restart.");
    return false;
  }
  const tmp = resolve(runtime, "99-nodesync.conf");
  writeFileSync(tmp, dropin);
  sudo("install", ["-m", "0644", tmp, dropinPath]);
  console.log("[nodesync-ssh] drop-in sshd thay đổi → đã ghi mới.");
  return true;
}

function restartSshdIfNeeded(changed) {
  // Luôn validate config trước bất kỳ (re)start nào.
  sudo("sshd", ["-t"]);
  if (!changed) {
    // Config không đổi. Chỉ đảm bảo sshd đang chạy (start nếu chưa), KHÔNG restart.
    const running = spawnSync("sh", ["-lc", "pgrep -x sshd >/dev/null 2>&1"]);
    if (running.status === 0) {
      console.log("[nodesync-ssh] sshd đang chạy + config không đổi → không restart.");
      return;
    }
    console.log("[nodesync-ssh] sshd chưa chạy → start (không restart).");
  }
  const hasSystemctl = spawnSync("sh", ["-lc", "command -v systemctl >/dev/null && systemctl list-unit-files ssh.service >/dev/null 2>&1"]);
  if (hasSystemctl.status === 0) {
    sudo("systemctl", [changed ? "restart" : "start", "ssh"]);
  } else {
    // Không có systemd (container-like): HUP nếu đang chạy, else khởi động sshd.
    sudo("sh", ["-lc", changed ? "pkill -HUP sshd || /usr/sbin/sshd" : "pgrep -x sshd >/dev/null || /usr/sbin/sshd"]);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
if (!enabled) {
  console.log("[nodesync-ssh] disabled");
  process.exit(0);
}
if (!sshUser) throw new Error("Run nodesync ssh:env before bootstrap");
if (dry) {
  console.log(`[nodesync-ssh] DRY RUN node=${nodeId} user=${sshUser} users=${users.join(",")}`);
  process.exit(0);
}
if (process.platform !== "linux") throw new Error("sshd bootstrap requires Linux");

console.log(`[nodesync-ssh] BEGIN ts=${ts()} node=${nodeId} users=${users.join(",")}`);

mkdirSync(runtime, { recursive: true });
if (!existsSync(keyFile)) throw new Error(`missing ${keyFile}; run ssh:env`);
chmodSync(keyFile, 0o600);
writeFileSync(identityFile, nodeId + "\n", { mode: 0o644 });

timed("ensure-sshd", ensureSshd);

// Batch: mkdir + install + ln → 1 sudo call thay vì 3
sudo("sh", ["-c", [
  `mkdir -p /run/sshd /etc/ssh/sshd_config.d /etc/nodesync`,
  `install -m 0644 ${JSON.stringify(identityFile)} /etc/nodesync/node-id`,
  `ln -sfn ${JSON.stringify(ROOT)} /workspace`,
].join(" && ")]);
timed("grant-sync-reads", grantSyncReads);

const hostKeyPub = timed("ensure-host-key", ensureHostKey);
const changed = timed("apply-sshd-dropin", applySshdDropin);
timed("restart-sshd", () => restartSshdIfNeeded(changed));

// ── Đọc host key ed25519 TRỰC TIẾP từ file .pub (thay ssh-keyscan qua network) ─
// Manifest tương thích: consumer mong dạng "127.0.0.1 ssh-ed25519 AAAA...".
const rawPub = timed("read-host-key", () => {
  const out = spawnSync("sh", ["-lc", `sudo -n cat ${hostKeyPub} 2>/dev/null || cat ${hostKeyPub}`], { encoding: "utf8" });
  if (out.status !== 0 || !out.stdout?.trim()) throw new Error(`không đọc được ${hostKeyPub}`);
  return out.stdout.trim();
});
// rawPub dạng: "ssh-ed25519 AAAA... comment". Chuẩn hoá về "ssh-ed25519 AAAA..."
// rồi prefix host 127.0.0.1 để khớp format ssh-keyscan cũ.
const pubParts = rawPub.split(/\s+/);
const hostKeyBody = `${pubParts[0]} ${pubParts[1]}`;
const hostKey = `127.0.0.1 ${hostKeyBody}`;
const hostKeyFile = resolve(runtime, "host-ed25519.pub");
writeFileSync(hostKeyFile, hostKey + "\n", { mode: 0o600 });

const fingerprint = run("ssh-keygen", ["-lf", hostKeyFile], { capture: true });
const ips = Object.values(networkInterfaces())
  .flat()
  .filter((x) => x && !x.internal)
  .map((x) => x.address);

const manifest = {
  version: 2,
  nodeId,
  user: sshUser,
  users,
  port: 22,
  tailscalePort: 2222,
  host: hostname(),
  ips,
  workspace: ROOT,
  hostKey,
  fingerprint,
  identityFile: "/etc/nodesync/node-id",
  generatedAt: new Date().toISOString(),
};
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
console.log(`[nodesync-ssh] READY ts=${ts()} users=${users.join(",")} node=${nodeId} fingerprint=${fingerprint}`);
