#!/usr/bin/env node
// Bootstrap OpenSSH trên CI runner, hoàn toàn không tương tác.
// Dùng SSH_1_PUBLIC_KEY/SSH_1_PRIVATE_KEY (hoặc *_B64=1) từ CI secret khi có;
// nếu thiếu sẽ sinh key local để smoke test. Metadata public được orchestrator
// đọc từ ci-runtime/nodesync/host-ssh.json và publish lên RTDB.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { hostname, networkInterfaces, userInfo } from "node:os";
import { resolve } from "node:path";
import { parseEnv } from "../lib/env-utils.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const ENV = resolve(ROOT, ".env");
const env = { ...(existsSync(ENV) ? parseEnv(ENV) : {}), ...process.env };
const enabled = /^(1|true|yes|on)$/i.test(env.SSH_ENABLE || "0");
const dry = process.argv.includes("--dry-run");
const runtime = resolve(ROOT, "ci-runtime/nodesync");
const keyFile = resolve(runtime, "id_ed25519");
const pubFile = `${keyFile}.pub`;
const authorized = resolve(runtime, "authorized_keys");
const identityFile = resolve(runtime, "node-id");
const manifestFile = resolve(runtime, "host-ssh.json");
const sshUser = userInfo().username;
const nodeId = env.ORCH_NODE_ID || "local-unknown";
const decode = (v, b64) => b64 === "1" ? Buffer.from(v || "", "base64").toString("utf8") : (v || "");
const privateKey = decode(env.SSH_1_PRIVATE_KEY, env.SSH_1_PRIVATE_KEY_B64);
const publicKey = decode(env.SSH_1_PUBLIC_KEY, env.SSH_1_PUBLIC_KEY_B64);
const run = (cmd, args, options={}) => {
  console.log(`[nodesync-ssh] ${cmd} ${args.join(" ")}`);
  if (dry) return "";
  return execFileSync(cmd, args, { encoding: "utf8", input: options.input, stdio: options.capture ? ["pipe","pipe","pipe"] : "inherit" }).trim();
};
const sudo = (args, options={}) => process.getuid?.() === 0 ? run(args[0], args.slice(1), options) : run("sudo", ["-n", ...args], options);

if (!enabled) { console.log("[nodesync-ssh] SSH_ENABLE!=1; bỏ qua bootstrap."); process.exit(0); }
if (dry) {
  console.log(`[nodesync-ssh] DRY RUN node=${nodeId} user=${sshUser}`);
  console.log("[nodesync-ssh] sẽ cài/check openssh-server+rsync, tạo/cài key, restart sshd, scan host key và ghi manifest");
  process.exit(0);
}
mkdirSync(runtime, { recursive: true });
if (privateKey) {
  writeFileSync(keyFile, privateKey.trim()+"\n", { mode: 0o600 });
  if (publicKey) writeFileSync(pubFile, publicKey.trim()+"\n", { mode: 0o644 });
  else writeFileSync(pubFile, run("ssh-keygen", ["-y", "-f", keyFile], {capture:true})+"\n", {mode:0o644});
} else if (!existsSync(keyFile)) {
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `${nodeId}@nodesync`, "-f", keyFile]);
  console.warn("[nodesync-ssh] Không có SSH_1_PRIVATE_KEY; đã sinh key local. Multi-runner cần key chung trong CI secret.");
}
chmodSync(keyFile, 0o600);
const pub = publicKey || readFileSync(pubFile, "utf8").trim();
writeFileSync(authorized, pub+"\n", { mode: 0o600 });
writeFileSync(identityFile, nodeId+"\n", { mode: 0o644 });

if (process.platform === "linux") {
  const apt = spawnSync("sh", ["-lc", "command -v sshd >/dev/null || (sudo -n apt-get update -qq && sudo -n apt-get install -y -qq openssh-server rsync)"]);
  if (!dry && apt.status !== 0) throw new Error("Không thể cài openssh-server/rsync không tương tác");
  sudo(["mkdir", "-p", "/run/sshd", "/etc/ssh/sshd_config.d"]);
  const dropin = [
    "PasswordAuthentication no", "KbdInteractiveAuthentication no", "PubkeyAuthentication yes",
    `AuthorizedKeysFile ${authorized}`, "PermitRootLogin no", "StrictModes no",
    "AllowTcpForwarding no", "X11Forwarding no", "PermitTTY no",
  ].join("\n")+"\n";
  const tmp = resolve(runtime, "99-nodesync.conf"); writeFileSync(tmp, dropin);
  sudo(["cp", tmp, "/etc/ssh/sshd_config.d/99-nodesync.conf"]);
  sudo(["ssh-keygen", "-A"]);
  if (spawnSync("sh", ["-lc", "command -v systemctl >/dev/null"]).status === 0) sudo(["systemctl", "restart", "ssh"]);
  else sudo(["sh", "-lc", "pkill -HUP sshd || /usr/sbin/sshd"]);
}
const hostKey = run("ssh-keyscan", ["-T", "5", "-t", "ed25519", "127.0.0.1"], { capture:true }).split("\n").find(x=>x&&!x.startsWith("#")) || "";
if (!hostKey) throw new Error("Không lấy được SSH host key sau bootstrap");
const fingerprint = run("ssh-keygen", ["-lf", "/dev/stdin"], { capture:true, input:hostKey });
const ips = Object.values(networkInterfaces()).flat().filter(x=>x&&!x.internal).map(x=>x.address);
const manifest = { version:1, nodeId, user:sshUser, port:22, tailscalePort:2222, host:hostname(), ips, workspace:ROOT, publicKey:pub, hostKey, fingerprint, identityFile, generatedAt:new Date().toISOString() };
writeFileSync(manifestFile, JSON.stringify(manifest,null,2)+"\n", {mode:0o600});
console.log(`[nodesync-ssh] READY user=${sshUser} node=${nodeId} fingerprint=${fingerprint}`);
