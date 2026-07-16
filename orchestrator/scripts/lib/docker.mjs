// orchestrator/scripts/lib/docker.mjs
// Sidecar "toàn quyền" điều khiển compose qua docker.sock:
//   - compose(): chạy `docker compose ...`
//   - logs(): xem log service
//   - ps(): trạng thái container
//   - inspectData(): liệt kê dữ liệu repo/volume (xem dữ liệu toàn repo)
//
// Compose project follows cwd by default; set COMPOSE_PROJECT_NAME to pin it.

import { execSync, spawnSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { log, error, redact } from "./log.mjs";

// Thư mục repo được mount vào sidecar (mặc định /workspace, xem orchestrator.yml)
export const REPO_DIR = process.env.ORCH_REPO_DIR || "/workspace";

// File compose để thao tác. Prod dùng docker-compose.yml (named tunnel).
function composeFiles() {
  const files = (process.env.ORCH_COMPOSE_FILES || "docker-compose.yml")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  return files.flatMap((f) => ["-f", f]);
}

function baseArgs() {
  const project = process.env.COMPOSE_PROJECT_NAME;
  return ["compose", ...(project ? ["-p", project] : []), ...composeFiles()];
}

// Chạy docker compose, trả stdout (đồng bộ). throwOnError=false để không vỡ flow.
export function compose(args, { throwOnError = true, timeout = 120_000 } = {}) {
  const argv = [...baseArgs(), ...(Array.isArray(args) ? args : args.split(" "))];
  log(`docker ${argv.join(" ")}`);
  const res = spawnSync("docker", argv, {
    cwd: REPO_DIR,
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const msg = redact((res.stderr || res.stdout || "unknown").toString().trim());
    if (throwOnError) throw new Error(`compose failed: ${msg}`);
    error(`compose non-zero (${res.status}): ${msg}`);
  }
  return (res.stdout || "").toString();
}

// Docker CLI thô (không qua compose) — vd `docker logs`, `docker ps`.
export function docker(args, { throwOnError = false, timeout = 60_000 } = {}) {
  const argv = Array.isArray(args) ? args : args.split(" ");
  const res = spawnSync("docker", argv, {
    cwd: REPO_DIR,
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.status !== 0 && throwOnError) {
    throw new Error(`docker failed: ${redact((res.stderr || "").trim())}`);
  }
  return (res.stdout || "").toString();
}

export function ps() {
  return compose("ps", { throwOnError: false });
}

export function logs(service, { tail = 100, since } = {}) {
  const args = ["logs", "--no-color", "--tail", String(tail)];
  if (since) args.push("--since", since);
  if (service) args.push(service);
  return compose(args, { throwOnError: false });
}

export function isRunning(service) {
  const out = compose(["ps", "--status", "running", "--services"], { throwOnError: false });
  return out.split(/\r?\n/).map((s) => s.trim()).includes(service);
}

export function stopService(service, { grace = 35 } = {}) {
  log(`Stopping service: ${service} (grace ${grace}s)`);
  return compose(["stop", "-t", String(grace), service], { throwOnError: false });
}

// Xem dữ liệu toàn repo/volume — liệt kê cây thư mục 1 cấp + kích thước.
export function inspectData(subdir = "") {
  const target = resolve(REPO_DIR, subdir);
  if (!existsSync(target)) return { path: target, exists: false, entries: [] };
  const entries = readdirSync(target).map((name) => {
    const full = resolve(target, name);
    let size = 0;
    let type = "file";
    try {
      const st = statSync(full);
      type = st.isDirectory() ? "dir" : "file";
      size = st.size;
    } catch {}
    return { name, type, size };
  });
  return { path: target, exists: true, entries };
}
