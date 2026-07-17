#!/usr/bin/env node
// Non-interactive Linux SSH user provisioning for CI runners and local hosts.
// Idempotent: chạy lại nhiều lần đều an toàn (create user, ghi file, sudoers).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectSshUsers, nodesyncEnabled } from "./lib/env.mjs";
import { log, warn, error } from "./lib/log.mjs";
import { parseEnv } from "../../scripts/lib/env-utils.mjs";
const args = process.argv.slice(2),
  dry = args.includes("--dry-run"),
  envIdx = args.indexOf("--env"),
  envFile = envIdx >= 0 ? resolve(args[envIdx + 1]) : resolve(".env");
const env = { ...(existsSync(envFile) ? parseEnv(envFile) : {}), ...process.env };
// useradd/adduser trên CI runner có thể chậm (ghi mail spool, hook) → cho phép timeout dài hơn.
function run(cmd, argv, { input, timeout = 20000 } = {}) {
  const shown = /(chpasswd)/.test(cmd) ? `${cmd} <hidden>` : `${cmd} ${argv.join(" ")}`;
  log(`${dry ? "[DRY RUN] " : ""}${shown}`);
  if (dry) return { ok: true, status: 0, out: "", err: "", timedOut: false };
  const r = spawnSync(cmd, argv, { encoding: "utf8", input, timeout });
  const timedOut = r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM";
  return { ok: r.status === 0, status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || r.error?.message || "").trim(), timedOut };
}
const root = () => process.getuid?.() === 0;
function privileged(cmd, argv, opt) {
  return root() ? run(cmd, argv, opt) : run("sudo", ["-n", cmd, ...argv], opt);
}
// Kiểm tra user tồn tại: dùng getent (đọc trực tiếp passwd DB), không phụ thuộc NSS cache như `id`.
const userExists = (u) => !dry && spawnSync("getent", ["passwd", u]).status === 0;
// Tạo user idempotent: tự xử lý timeout-nhưng-đã-tạo và user-đã-tồn-tại.
function ensureUser(u) {
  if (userExists(u.user)) {
    log(`user already exists, skip create user=${u.user}`);
    return;
  }
  const a = ["--no-log-init", "-m", "-s", u.shell];
  if (u.uid) a.push("-u", String(u.uid));
  a.push(u.user);
  const r = privileged("useradd", a, { timeout: 60000 });
  if (r.ok) {
    log(`useradd ok user=${u.user}`);
    return;
  }
  // useradd có thể timeout NHƯNG đã tạo user thành công (hook chậm). Re-check trước khi fallback.
  if (userExists(u.user)) {
    warn(`useradd reported failure (timedOut=${r.timedOut}) nhưng user đã tồn tại → coi như thành công user=${u.user}`);
    return;
  }
  warn(`useradd failed, fallback adduser: ${r.err}`);
  const b = ["--disabled-password", "--gecos", "", ...(u.uid ? ["--uid", String(u.uid)] : []), "--shell", u.shell, u.user];
  const r2 = privileged("adduser", b, { timeout: 60000 });
  if (r2.ok) {
    log(`adduser ok user=${u.user}`);
    return;
  }
  // Fallback cũng có thể timeout-nhưng-thành-công, hoặc "already exists" do race. Re-check lần cuối.
  if (userExists(u.user)) {
    warn(`adduser reported failure nhưng user đã tồn tại → coi như thành công user=${u.user}`);
    return;
  }
  throw new Error(`không tạo được user ${u.user}: useradd(${r.err}) adduser(${r2.err})`);
}
// Ghi file có quyền chỉ định một cách idempotent (install tạo file + set mode trong 1 bước, ghi đè an toàn).
function installFile(content, mode, dest, index, name) {
  const tmp = resolve(`ci-runtime/nodesync/${name}-${index}`);
  if (!dry) {
    mkdirSync(resolve("ci-runtime/nodesync"), { recursive: true });
    writeFileSync(tmp, content, { mode: 0o600 });
  }
  const r = privileged("install", ["-m", mode, tmp, dest]);
  if (!r.ok) throw new Error(`install ${dest}: ${r.err}`);
}
function create(u) {
  if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(u.user)) throw new Error(`SSH user invalid: ${u.user}`);
  log(`provision user=${u.user} index=${u.index} privileged=${u.privileged}`);
  ensureUser(u);
  if (u.password) {
    const r = privileged("chpasswd", [], { input: `${u.user}:${u.password}\n` });
    if (!r.ok) throw new Error(`chpasswd ${u.user}: ${r.err}`);
    log(`password configured user=${u.user} value=<hidden>`);
  }
  const home = spawnSync("getent", ["passwd", u.user], { encoding: "utf8" }).stdout?.trim().split(":")[5] || `/home/${u.user}`,
    ssh = `${home}/.ssh`;
  privileged("mkdir", ["-p", ssh]);
  privileged("chmod", ["700", ssh]);
  if (u.publicKey) installFile(u.publicKey.trim() + "\n", "600", `${ssh}/authorized_keys`, u.index, "authorized");
  if (u.privateKey) installFile(u.privateKey.trim() + "\n", "600", `${ssh}/id_ed25519`, u.index, "key");
  privileged("chown", ["-R", `${u.user}:${u.user}`, ssh]);
  if (u.privileged) {
    const group = spawnSync("getent", ["group", "sudo"]).status === 0 ? "sudo" : "wheel";
    privileged("usermod", ["-aG", group, u.user]);
    installFile(`${u.user} ALL=(ALL) NOPASSWD:ALL\n`, "0440", `/etc/sudoers.d/nodesync-${u.user}`, u.index, "sudoers");
    log(`sudo NOPASSWD configured user=${u.user}`);
  }
  return u.user;
}
try {
  if (process.platform !== "linux") throw new Error("SSH user provisioning currently requires Linux");
  if (!nodesyncEnabled(env)) {
    log("SSH_ENABLE!=1; skip users");
    process.exit(0);
  }
  const users = collectSshUsers(env);
  if (!users.length) throw new Error("No SSH_<index>_USER configured; run ssh-setup-env first");
  const done = users.map(create);
  log(`users ready count=${done.length} names=${done.join(",")}`);
} catch (e) {
  error(e.stack || e.message);
  process.exit(1);
}
