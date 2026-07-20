#!/usr/bin/env node
// scripts/runners/setup-host.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Điều phối giai đoạn "Setup Host" (prompt mục 3). Trước đây 5 step chạy tuần
// tự trong test.yml:
//   1. ssh:env         (nodesync/scripts/ssh-setup-env.mjs)      — materialize env
//   2. ssh:smoke:prepare (nodesync/scripts/smoke-data.mjs)       — smoke data
//   3. setup-users.mjs                                           — provision users
//   4. setup-nodesync-ssh.mjs                                    — configure sshd
//   5. setup-tinyauth-ci-user.mjs                                — tinyauth bot
//
// DEPENDENCY THỰC SỰ:
//   * (1) materialize env  → tạo SSH_*_USER/PASS + key files. (3) provision users
//     và (4) configure sshd ĐỀU cần env này ⇒ (1) phải xong trước (3),(4).
//   * (3) provision users  → tạo user Linux. (4) configure sshd ghi AllowUsers
//     + host key ⇒ (3) phải xong trước (4). (3)→(4) TUẦN TỰ (prompt yêu cầu).
//   * (2) smoke data       → chỉ ghi ci-runtime/smoke-sync-data + ORCH_META_*.
//     Độc lập với SSH provisioning ⇒ chạy SONG SONG.
//   * (5) tinyauth bot     → chỉ sửa TINYAUTH_AUTH_USERS trong .env. Độc lập
//     với SSH ⇒ chạy SONG SONG.
//
// AN TOÀN GHI .ENV: (1) ssh:env, (2) smoke-data, (5) tinyauth-ci-user ĐỀU ghi
// cùng file .env. Ghi song song 3 tiến trình vào cùng file = race → hỏng .env.
// Vì vậy CHUỖI ghi-.env chạy TUẦN TỰ: (1) → (2) → (5). Trong khi đó (3) provision
// users KHÔNG ghi .env (chỉ đọc) nên có thể chạy song song với (2)+(5) SAU khi
// (1) xong. (4) configure sshd chờ (3).
//
//   Timeline:
//     (1 ssh:env)
//        ├─ nhánh A (ghi .env, tuần tự):   (2 smoke) → (5 tinyauth)
//        └─ nhánh B (SSH, tuần tự):        (3 users) → (4 sshd)
//     Promise.all([A, B]) — hai nhánh song song với nhau.
//
// Log timestamp đầu/cuối từng substep để ĐO thực tế (prompt: "không suy đoán
// bottleneck").
//
// Usage:
//   node scripts/runners/setup-host.mjs [--dry-run] [--silent]
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };

process.chdir(ROOT);

function ts() {
  return new Date().toISOString();
}

/**
 * Chạy 1 substep, log timestamp đầu/cuối + duration. Trả Promise reject nếu
 * exit code != 0 (trừ khi allowFail). Output stream với prefix [name].
 */
function step(name, cmd, cmdArgs, { allowFail = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    log(`::group::[setup-host] ▶ ${name}`);
    log(`[setup-host] ${name} start ts=${ts()} cmd="${cmd} ${cmdArgs.join(" ")}"`);
    if (DRY_RUN) {
      log(`[setup-host] [DRY RUN] ${name}`);
      log(`::endgroup::`);
      return resolvePromise({ name, ok: true, durationMs: 0 });
    }
    const proc = spawn(cmd, cmdArgs, { cwd: ROOT, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
    const pipe = (stream, data) => {
      if (SILENT) return;
      for (const line of data.toString().split(/\r?\n/).filter(Boolean)) stream.write(`[${name}] ${line}\n`);
    };
    proc.stdout.on("data", (d) => pipe(process.stdout, d));
    proc.stderr.on("data", (d) => pipe(process.stderr, d));
    proc.on("error", (e) => {
      log(`::endgroup::`);
      if (allowFail) { log(`[setup-host] ${name} error (ignored): ${e.message}`); return resolvePromise({ name, ok: false, durationMs: Date.now() - startedAt }); }
      reject(new Error(`${name} spawn error: ${e.message}`));
    });
    proc.on("close", (code) => {
      const durationMs = Date.now() - startedAt;
      log(`[setup-host] ${name} done ts=${ts()} exit=${code} durationMs=${durationMs}`);
      log(`::endgroup::`);
      if (code === 0 || allowFail) resolvePromise({ name, ok: code === 0, durationMs });
      else reject(new Error(`${name} failed with exit code ${code}`));
    });
  });
}

const NODE = process.execPath;
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const dryFlag = DRY_RUN ? ["--dry-run"] : [];

async function main() {
  const overallStart = Date.now();
  log(`=== Setup Host start ts=${ts()} dryRun=${DRY_RUN} ===`);

  // (1) Materialize SSH environment + mask secrets — BẮT BUỘC xong trước A/B.
  await step("ssh:env", NPM, ["run", "ssh:env", "--prefix", "nodesync"]);

  // Nhánh A — ghi .env TUẦN TỰ để tránh race trên .env: smoke → tinyauth.
  const branchEnvWriters = (async () => {
    await step("ssh:smoke:prepare", NPM, ["run", "ssh:smoke:prepare", "--prefix", "nodesync"]);
    await step("tinyauth-ci-user", NODE, ["scripts/runners/setup-tinyauth-ci-user.mjs", ...dryFlag]);
  })();

  // Nhánh B — SSH provisioning TUẦN TỰ: users → sshd (sshd cần users tồn tại).
  const branchSsh = (async () => {
    // provision users cần sudo + preserve env flags (giữ y hệt test.yml cũ).
    if (DRY_RUN) {
      await step("provision-users", NODE, ["nodesync/scripts/setup-users.mjs", "--env", ".env", "--dry-run"]);
    } else {
      await step("provision-users", "sudo", [
        "-n",
        "--preserve-env=SSH_ENABLE,SSH_SYNC_SMOKE_ENABLE",
        NODE,
        "nodesync/scripts/setup-users.mjs",
        "--env",
        ".env",
      ]);
    }
    await step("configure-sshd", NODE, ["scripts/runners/setup-nodesync-ssh.mjs", ...dryFlag]);
  })();

  await Promise.all([branchEnvWriters, branchSsh]);

  log(`=== Setup Host done ts=${ts()} totalMs=${Date.now() - overallStart} ===`);
}

main().catch((e) => {
  console.error(`[setup-host] FAILED: ${e.message}`);
  process.exit(1);
});
