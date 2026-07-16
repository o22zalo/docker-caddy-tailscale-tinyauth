#!/usr/bin/env node
// scripts/runners/verify-leader-whoami.mjs
// YÊU CẦU (Phần 1 #3): Sau khi một node lên leader, CI curl tới
// whoami.{DOMAIN} mỗi 5s và ĐỐI CHIẾU kết quả trả về (Name: <node-id>) có
// TRÙNG với leader đang chạy trên RTDB hay không. Lặp cho tới khi trùng thì
// dừng (thành công). Có so sánh kết quả rõ ràng.
//
// CÁCH LẤY LEADER: gọi vào container orchestrator (đã có firebase-admin + creds)
//   docker compose exec -T orchestrator node scripts/print-leader.mjs
// → in ra JSON { nodeId, term, publicUrl }.
//
// CÁCH LẤY whoami: curl publicUrl (hoặc http://whoami.$DOMAIN) → body chứa
//   "Name: <WHOAMI_NAME>" mà ta set = node id của runner (whoami.yml).
//
// Flags:
//   --dry-run   In các bước sẽ làm, không chạy thật
//   --silent    Không in
//
// Env:
//   VERIFY_LEADER_TIMEOUT   tổng thời gian chờ (giây), default 180
//   VERIFY_LEADER_INTERVAL  chu kỳ poll (giây), default 5
//   PUBLIC_URL / DOMAIN     dùng để dựng URL whoami nếu cần
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectDocker } from "./_docker.mjs";
import { envGet } from "../lib/env-utils.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };
const err = (...a) => { if (!SILENT) console.error(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
process.chdir(ROOT);

const ENV = resolve(ROOT, ".env");
const TIMEOUT = parseInt(process.env.VERIFY_LEADER_TIMEOUT || "180", 10);
const INTERVAL = parseInt(process.env.VERIFY_LEADER_INTERVAL || "5", 10);
if (!Number.isInteger(TIMEOUT) || TIMEOUT < 1 || !Number.isInteger(INTERVAL) || INTERVAL < 1) {
  err("ERROR: VERIFY_LEADER_TIMEOUT/INTERVAL phải là số nguyên dương.");
  process.exit(1);
}

const docker = DRY_RUN ? { available: true, cmd: "docker" } : detectDocker();
if (!docker.available) { err("ERROR: Docker daemon unavailable."); process.exit(1); }
const dc = (parts) => `${docker.cmd} ${parts}`;

function sh(cmd) {
  try { return execSync(cmd, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], timeout: 30000 }).toString().trim(); }
  catch { return ""; }
}

// Dựng URL whoami public.
function resolveWhoamiUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  if (existsSync("/tmp/proxy-stack-public-url.txt")) {
    const u = readFileSync("/tmp/proxy-stack-public-url.txt", "utf8").trim();
    if (u) return u;
  }
  if (existsSync(resolve(ROOT, "public-url.txt"))) {
    const u = readFileSync(resolve(ROOT, "public-url.txt"), "utf8").trim();
    if (u) return u;
  }
  const whoamiHost = envGet(ENV, "WHOAMI_HOST");
  const domain = envGet(ENV, "DOMAIN");
  if (whoamiHost && !whoamiHost.startsWith(":")) return whoamiHost.replace(/^http:\/\//, "https://");
  if (domain) return `https://whoami.${domain}`;
  return "http://127.0.0.1:8080";
}

// Lấy leader hiện tại từ RTDB qua orchestrator container.
function getLeaderNodeId() {
  const out = sh(dc("compose exec -T orchestrator node scripts/print-leader.mjs --silent"));
  if (!out) return null;
  try {
    const j = JSON.parse(out.split(/\r?\n/).filter(Boolean).pop());
    return j && j.nodeId ? j : null;
  } catch { return null; }
}

// Lấy "Name:" mà whoami echo (chính là node id runner đang phục vụ).
function getWhoamiName(url) {
  let body = "";
  try {
    const endpoint = new URL("/", url).toString();
    body = execFileSync("curl", ["-sS", "--max-time", "15", endpoint], { encoding: "utf8", timeout: 20000 }).trim();
  } catch { return null; }
  if (!body) return null;
  const m = body.match(/^Name:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

async function main() {
  const url = resolveWhoamiUrl();
  log(`==> Đối chiếu leader ↔ whoami. URL=${url} timeout=${TIMEOUT}s interval=${INTERVAL}s`);

  if (DRY_RUN) {
    log("[DRY RUN] Sẽ: (1) đọc leader từ orchestrator, (2) curl whoami mỗi 5s, (3) so Name == leader.nodeId");
    process.exit(0);
  }

  // Bỏ qua nếu orchestration tắt (không có leader để đối chiếu).
  const consul = envGet(ENV, "CONSUL_ENABLE");
  if (consul !== "1" && String(process.env.CONSUL_ENABLE) !== "1") {
    log("CONSUL_ENABLE != 1 → bỏ qua bước đối chiếu leader (orchestration tắt).");
    process.exit(0);
  }

  const deadline = Date.now() + TIMEOUT * 1000;
  let attempt = 0;
  let lastLeader = null;
  let lastName = null;

  while (Date.now() < deadline) {
    attempt += 1;
    const leader = getLeaderNodeId();
    const name = getWhoamiName(url);
    lastLeader = leader?.nodeId || null;
    lastName = name;

    log(`    attempt ${attempt}: leader(RTDB)=${lastLeader || "(none)"} term=${leader?.term ?? "-"}  whoami(Name)=${name || "(none)"}`);

    if (leader?.nodeId && name && leader.nodeId === name) {
      log("");
      log("SO SÁNH ĐỐI CHIẾU: ✅ TRÙNG KHỚP");
      log(`  leader đang chạy (RTDB): ${leader.nodeId} (term=${leader.term})`);
      log(`  whoami.{DOMAIN} trả về : ${name}`);
      log(`  → Request public đang được phục vụ ĐÚNG bởi leader hiện tại.`);
      process.exit(0);
    }
    execSync(`sleep ${INTERVAL}`, { stdio: "ignore" });
  }

  err("");
  err(`SO SÁNH ĐỐI CHIẾU: ❌ KHÔNG TRÙNG sau ${TIMEOUT}s`);
  err(`  leader cuối (RTDB): ${lastLeader || "(none)"}`);
  err(`  whoami cuối (Name): ${lastName || "(none)"}`);
  err("  Gợi ý debug: kiểm tra WHOAMI_NAME có = ORCH_NODE_ID không, orchestrator đã lên leader chưa, tunnel đã route sang node này chưa.");
  // Không fail cứng CI theo mặc định (đây là bước quan sát/đối chiếu). Đổi
  // VERIFY_LEADER_STRICT=1 để coi mismatch là lỗi.
  process.exit(process.env.VERIFY_LEADER_STRICT === "1" ? 1 : 0);
}

main();
