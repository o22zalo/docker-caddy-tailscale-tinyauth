#!/usr/bin/env node
// nodesync/scripts/entrypoint.mjs
// Khởi tạo SSH server + hold-gate. Chạy root trong sidecar để tạo user và nhận
// lệnh quản trị theo cấu hình rõ ràng của repo.

import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { loadConfig, nodesyncEnabled, collectSshUsers } from "./lib/env.mjs";
import { log, warn, error } from "./lib/log.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

function sh(cmd, argv) {
  if (DRY_RUN) { log(`[DRY RUN] ${cmd} ${argv.join(" ")}`); return { ok: true }; }
  const res = spawnSync(cmd, argv, { stdio: "inherit" });
  return { ok: res.status === 0, status: res.status };
}

function writeSshdConfig(cfg) {
  const lines = [
    `Port ${cfg.sshd.port}`,
    "AddressFamily any",
    "ListenAddress 0.0.0.0",
    `PasswordAuthentication ${cfg.sshd.password_authentication ? "yes" : "no"}`,
    "PubkeyAuthentication yes",
    `PermitRootLogin ${cfg.sshd.permit_root_login ? "yes" : "prohibit-password"}`,
    "AuthorizedKeysFile .ssh/authorized_keys",
    "UsePAM no",
    "PermitTTY yes",
    "X11Forwarding no",
    "Subsystem sftp /usr/lib/ssh/sftp-server",
    "ClientAliveInterval 30",
    "ClientAliveCountMax 4",
  ];
  const content = lines.join("\n") + "\n";
  if (DRY_RUN) { log(`[DRY RUN] ghi /etc/ssh/sshd_config:\n${content}`); return; }
  mkdirSync("/etc/ssh", { recursive: true });
  writeFileSync("/etc/ssh/sshd_config", content);
  log("Đã ghi /etc/ssh/sshd_config theo config.jsonc");
}

function ensureHostKeys() {
  if (DRY_RUN) { log("[DRY RUN] ssh-keygen -A (tạo host keys)"); return; }
  if (!existsSync("/etc/ssh/ssh_host_ed25519_key")) {
    if (!sh("ssh-keygen", ["-A"]).ok) throw new Error("ssh-keygen -A thất bại");
    log("Đã tạo SSH host keys");
  } else log("SSH host keys đã có");
}

function startChild(name, cmd, argv) {
  const child = spawn(cmd, argv, { stdio: "inherit" });
  child.on("error", (e) => { error(`${name} không khởi động được: ${e.message}`); process.exit(1); });
  child.on("exit", (code, signal) => {
    if (code !== 0 && signal == null) error(`${name} dừng ngoài ý muốn: exit=${code}`);
    process.exit(code ?? 1);
  });
  return child;
}

async function main() {
  const cfg = loadConfig();
  log("=== NODESYNC entrypoint ===");
  if (!nodesyncEnabled()) {
    log("SSH_ENABLE != 1 → nodesync IDLE (không mở sshd, không tạo user).");
    if (DRY_RUN) return;
    while (true) await new Promise((r) => setTimeout(r, 3600_000));
  }

  const users = collectSshUsers();
  if (users.length === 0) throw new Error("SSH_ENABLE=1 nhưng chưa có SSH_<n>_USER");
  log(`nodesync BẬT. Số user cấu hình: ${users.length} [${users.map((u) => u.user).join(", ")}]`);

  writeSshdConfig(cfg);
  ensureHostKeys();
  if (!sh("node", ["scripts/setup-users.mjs", ...(DRY_RUN ? ["--dry-run"] : [])]).ok) {
    throw new Error("setup-users.mjs thất bại");
  }
  if (DRY_RUN) {
    log("[DRY RUN] sẽ chạy hold-gate + /usr/sbin/sshd -D -e");
    return;
  }

  const gate = startChild("hold-gate", "node", ["scripts/hold-gate.mjs"]);
  const sshd = startChild("sshd", "/usr/sbin/sshd", ["-D", "-e"]);
  const shutdown = (signal) => {
    warn(`Nhận ${signal}; dừng hold-gate và sshd`);
    gate.kill(signal);
    sshd.kill(signal);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => { error(`entrypoint fatal: ${e.stack || e.message}`); process.exit(1); });
