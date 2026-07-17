// orchestrator/scripts/handoff-log.mjs
// Đọc NHẬT KÝ CHUYỂN GIAO LEADER từ RTDB.
//
// YÊU CẦU: chỉ lưu 1 record / lần đổi leader THẬT SỰ (leader cũ ≠ leader mới).
// Mỗi record: { oldLeader, newLeader, oldLeaderNextActions, oldLeaderTasks, at, atVi, term, reason }.
//
//   node scripts/handoff-log.mjs            # in toàn bộ (mới→cũ, giới hạn 100)
//   node scripts/handoff-log.mjs --limit 50 # số dòng tối đa
//   node scripts/handoff-log.mjs --json     # xuất JSON thô
//   node scripts/handoff-log.mjs --dry-run  # chỉ in path sẽ đọc, không kết nối
//   node scripts/handoff-log.mjs --silent   # không in (dùng khi test)

import { connectRtdb } from "./lib/rtdb.mjs";
import { log, error } from "./lib/log.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const AS_JSON = args.includes("--json");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 100 : 100;

const out = (...a) => { if (!SILENT) console.log(...a); };

function fmtLeader(l) {
  if (!l || !l.nodeId) return "(none)";
  return `${l.nodeId}${l.host ? `@${l.host}` : ""}${l.term !== undefined && l.term !== null ? ` term=${l.term}` : ""}`;
}

function fmtTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return "(không có — leader cũ đã chết/signal, không chạy pipeline)";
  return tasks.map((t) => `  • ${t.hook}: ${t.ok ? "OK" : "FAIL"}${t.error ? ` — ${t.error}` : ""}`).join("\n");
}

function fmtActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return "(không có)";
  return actions.map((name) => `  • ${name}`).join("\n");
}

async function main() {
  if (DRY_RUN) {
    out(`[DRY RUN] Sẽ đọc handoff log tại: orchestrator/<stack>/handoff/log (limit=${LIMIT}). Cần ORCH_RTDB_URL + creds khi chạy thật.`);
    process.exit(0);
  }

  const { db, paths, stack } = connectRtdb();

  const snap = await db.ref(paths.handoffLog).limitToLast(LIMIT).get();
  const val = snap.val() || {};
  // RTDB push keys sắp theo thời gian tăng dần → chuyển sang mảng theo thứ tự.
  const entries = Object.entries(val)
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => (a.at || 0) - (b.at || 0));

  if (AS_JSON) {
    out(JSON.stringify(entries, null, 2));
    process.exit(0);
  }

  out(`\n=== Nhật ký chuyển giao leader — stack="${stack}" — ${entries.length} record ===`);
  if (entries.length === 0) {
    out("(chưa có lần đổi leader nào)");
  }
  for (const e of entries) {
    const t = e.atVi || (e.at ? new Date(e.at).toISOString() : "(no-time)");
    out(`\n  [${t}] reason=${e.reason || "handoff"} term=${e.term ?? "?"}${e.transition ? ` transition=${e.transition}` : ""}`);
    out(`    Leader cũ: ${fmtLeader(e.oldLeader)}`);
    out(`    Leader mới: ${fmtLeader(e.newLeader)}`);
    out(`    Việc leader cũ sẽ làm sau đó:`);
    out(fmtActions(e.oldLeaderNextActions));
    out(`    Kết quả:`);
    out(fmtTasks(e.oldLeaderTasks));
  }
  out("");
  process.exit(0);
}

main().catch((e) => {
  error(`handoff-log failed: ${e.message}`);
  process.exit(1);
});
