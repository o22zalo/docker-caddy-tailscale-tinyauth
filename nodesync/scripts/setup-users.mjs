#!/usr/bin/env node
// nodesync/scripts/setup-users.mjs
// Tạo multi-user SSH từ env SSH_<n>_* + phân quyền chạy MỌI lệnh (sudo NOPASSWD)
// giữa các node (theo yêu cầu). Chạy trong entrypoint container nodesync (root).
//
//   node scripts/setup-users.mjs
//   node scripts/setup-users.mjs --dry-run   # in lệnh sẽ chạy, không thực thi
//   node scripts/setup-users.mjs --silent
//
// Với mỗi user:
//   - useradd (shell bash, home riêng), set password (chpasswd) nếu có.
//   - ghi ~/.ssh/authorized_keys (public key) + ~/.ssh/id_* (private key) nếu có.
//   - nếu privileged: thêm vào group sudo + /etc/sudoers.d NOPASSWD ALL.
//   - thêm vào group docker (chạy lệnh docker qua socket) nếu có group docker.
//
// SECRET: password/private key được giải mã base64 trong lib/env.mjs; KHÔNG log
// giá trị (logger redact). File key set quyền 600.

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { collectSshUsers, nodesyncEnabled } from "./lib/env.mjs";
import { log, warn, error } from "./lib/log.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

function sh(cmd, argv, { input } = {}) {
  if (DRY_RUN) { log(`[DRY RUN] ${cmd} ${argv.join(" ")}`); return { ok: true, out: "", err: "" }; }
  const res = spawnSync(cmd, argv, { encoding: "utf8", input, timeout: 30000 });
  return { ok: res.status === 0, out: (res.stdout || "").trim(), err: (res.stderr || "").trim() };
}

function userExists(name) {
  if (DRY_RUN) return false;
  return spawnSync("id", [name], { encoding: "utf8" }).status === 0;
}

function hasGroup(name) {
  if (DRY_RUN) return false;
  return spawnSync("getent", ["group", name], { encoding: "utf8" }).status === 0;
}

function createUser(u) {
  log(`Tạo user "${u.user}" (index=${u.index}, privileged=${u.privileged})`);
  if (userExists(u.user)) {
    log(`  user "${u.user}" đã tồn tại → bỏ qua useradd`);
  } else {
    const argv = ["-m", "-s", u.shell || "/bin/bash"];
    if (u.uid) argv.push("-u", String(u.uid));
    argv.push(u.user);
    const r = sh("useradd", argv);
    if (!r.ok && !DRY_RUN) { error(`  useradd "${u.user}" lỗi: ${r.err}`); return false; }
  }

  // Password (nếu có) — chpasswd đọc "user:pass" từ stdin.
  if (u.password) {
    const r = sh("chpasswd", [], { input: `${u.user}:${u.password}\n` });
    if (r.ok) log(`  đã đặt password cho "${u.user}" (giá trị ẩn)`);
    else if (!DRY_RUN) warn(`  đặt password "${u.user}" lỗi: ${r.err}`);
  }

  // SSH keys.
  const home = `/home/${u.user}`;
  const sshDir = `${home}/.ssh`;
  if (u.publicKey || u.privateKey) {
    if (!DRY_RUN) mkdirSync(sshDir, { recursive: true });
    if (u.publicKey) {
      if (!DRY_RUN) writeFileSync(`${sshDir}/authorized_keys`, u.publicKey.trim() + "\n", { mode: 0o600 });
      log(`  ghi authorized_keys cho "${u.user}"`);
    }
    if (u.privateKey) {
      if (!DRY_RUN) { writeFileSync(`${sshDir}/id_ed25519`, u.privateKey.trim() + "\n", { mode: 0o600 }); }
      log(`  ghi private key cho "${u.user}" (giá trị ẩn)`);
    }
    if (!DRY_RUN) {
      chmodSync(sshDir, 0o700);
      sh("chown", ["-R", `${u.user}:${u.user}`, sshDir]);
    }
  }

  // Phân quyền cao nhất: sudo NOPASSWD ALL (chạy mọi lệnh giữa node).
  if (u.privileged) {
    if (hasGroup("sudo")) sh("usermod", ["-aG", "sudo", u.user]);
    else if (hasGroup("wheel")) sh("usermod", ["-aG", "wheel", u.user]);
    const sudoersLine = `${u.user} ALL=(ALL) NOPASSWD:ALL\n`;
    const sudoersFile = `/etc/sudoers.d/nodesync-${u.user}`;
    if (!DRY_RUN) {
      try {
        mkdirSync("/etc/sudoers.d", { recursive: true });
        writeFileSync(sudoersFile, sudoersLine, { mode: 0o440 });
      } catch (e) { warn(`  ghi sudoers "${u.user}" lỗi: ${e.message}`); }
    } else {
      log(`[DRY RUN] echo "${sudoersLine.trim()}" > ${sudoersFile}`);
    }
    log(`  cấp sudo NOPASSWD:ALL cho "${u.user}" (chạy MỌI lệnh)`);
  }

  // Group docker: chạy lệnh docker (trong/ngoài docker) qua socket mount.
  if (hasGroup("docker")) {
    sh("usermod", ["-aG", "docker", u.user]);
    log(`  thêm "${u.user}" vào group docker`);
  }

  return true;
}

function main() {
  if (!nodesyncEnabled()) {
    log("SSH_ENABLE != 1 → nodesync tắt, KHÔNG tạo user. (đặt SSH_ENABLE=1 để bật)");
    return;
  }
  const users = collectSshUsers();
  if (users.length === 0) {
    warn("Không tìm thấy user nào (cần SSH_1_USER, SSH_2_USER, ...). Bỏ qua.");
    return;
  }
  log(`Sẽ tạo ${users.length} user: ${users.map((u) => `${u.index}:${u.user}`).join(", ")}`);
  let okCount = 0;
  for (const u of users) if (createUser(u)) okCount += 1;
  log(`Hoàn tất tạo user: ${okCount}/${users.length} OK`);
  if (okCount !== users.length) process.exitCode = 1;
}

try { main(); }
catch (e) { error(`setup-users lỗi: ${e.stack || e.message}`); process.exit(1); }
