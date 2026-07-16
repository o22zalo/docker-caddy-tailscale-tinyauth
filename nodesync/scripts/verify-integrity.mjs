#!/usr/bin/env node
// nodesync/scripts/verify-integrity.mjs
// KIỂM TRA TÍNH TOÀN VẸN dữ liệu ở mức sync giữa 2 node (YÊU CẦU).
//
// So sánh 2 cây thư mục theo TỪNG FILE: checksum (sha256), size, mtime.
// In báo cáo tiếng Việt đầy đủ: file nào giống/khác/thiếu/thừa, tổng dung lượng,
// thời gian chạy.
//
// 2 chế độ:
//   (A) --local <DIR_A> <DIR_B>
//       So sánh 2 thư mục CỤC BỘ (dùng cho test 2-node khi cả 2 data dir cùng
//       mount vào máy — KIỂM CHỨNG THẬT không cần ssh/docker).
//   (B) --peer  (mặc định)
//       So sánh workspace cục bộ với node01 qua ssh (dùng lib/ssh.mjs resolve).
//
//   node scripts/verify-integrity.mjs --local ./ci-data-node01 ./ci-data-node02
//   node scripts/verify-integrity.mjs --local A B --json
//   node scripts/verify-integrity.mjs --dry-run
//   node scripts/verify-integrity.mjs --silent

import { readdirSync, lstatSync, existsSync, readFileSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, relative } from "node:path";
import { log, warn, error } from "./lib/log.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const AS_JSON = args.includes("--json");
const LOCAL_IDX = args.indexOf("--local");
const LOCAL_MODE = LOCAL_IDX >= 0;

// Liệt kê đệ quy file trong 1 dir → map relPath → { size, mtimeMs, sha256 }.
function scanDir(root) {
  const out = new Map();
  if (!existsSync(root)) return out;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() || st.isSymbolicLink()) {
        const rel = relative(root, full);
        const type = st.isSymbolicLink() ? "symlink" : "file";
        let sha = "";
        let linkTarget = "";
        if (type === "file") {
          try { sha = createHash("sha256").update(readFileSync(full)).digest("hex"); } catch { sha = "ERR"; }
        } else {
          try { linkTarget = readlinkSync(full); } catch { linkTarget = "ERR"; }
        }
        out.set(rel, { type, size: st.size, mtimeMs: Math.round(st.mtimeMs), mode: st.mode & 0o7777, sha256: sha, linkTarget });
      }
    }
  };
  walk(root);
  return out;
}

// So sánh 2 map file.
function compare(a, b) {
  const onlyA = [], onlyB = [], differ = [], same = [];
  for (const [rel, meta] of a) {
    if (!b.has(rel)) { onlyA.push({ rel, ...meta }); continue; }
    const mb = b.get(rel);
    const mtimeDiff = Math.abs(meta.mtimeMs - mb.mtimeMs) > 1000;
    if (meta.type !== mb.type || meta.sha256 !== mb.sha256 || meta.linkTarget !== mb.linkTarget
      || meta.size !== mb.size || meta.mode !== mb.mode || mtimeDiff) {
      differ.push({ rel, a: meta, b: mb });
    } else same.push({ rel, ...meta });
  }
  for (const [rel, meta] of b) if (!a.has(rel)) onlyB.push({ rel, ...meta });
  return { onlyA, onlyB, differ, same };
}

function human(bytes) {
  const u = ["B", "KB", "MB", "GB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)}${u[i]}`;
}

function totalSize(map) {
  let s = 0;
  for (const m of map.values()) s += m.size;
  return s;
}

function reportLocal(dirA, dirB) {
  const startedAt = Date.now();
  log("=== KIỂM TRA TOÀN VẸN (chế độ --local: so 2 thư mục cục bộ) ===");
  log(`  A (node01) = ${dirA}`);
  log(`  B (node02) = ${dirB}`);

  if (DRY_RUN) { log("[DRY RUN] sẽ scan + so sánh checksum/size/mtime 2 thư mục."); return { dryRun: true }; }

  const a = scanDir(resolve(dirA));
  const b = scanDir(resolve(dirB));
  log(`  Số file: A=${a.size} (${human(totalSize(a))}), B=${b.size} (${human(totalSize(b))})`);

  const { onlyA, onlyB, differ, same } = compare(a, b);
  const durationMs = Date.now() - startedAt;

  log("--- Chi tiết ---");
  log(`  GIỐNG (checksum+size+mode+mtime khớp): ${same.length} file`);
  same.slice(0, 20).forEach((f) => log(`    = ${f.rel} (${human(f.size)}, sha=${f.sha256.slice(0, 12)}, mtime=${new Date(f.mtimeMs).toISOString()})`));
  if (same.length > 20) log(`    ... (+${same.length - 20} file nữa)`);

  if (differ.length) {
    warn(`  KHÁC nội dung: ${differ.length} file`);
    differ.slice(0, 20).forEach((f) => warn(`    ≠ ${f.rel}: A(sha=${f.a.sha256.slice(0, 12)},${human(f.a.size)},mode=${f.a.mode.toString(8)},mtime=${f.a.mtimeMs}) vs B(sha=${f.b.sha256.slice(0, 12)},${human(f.b.size)},mode=${f.b.mode.toString(8)},mtime=${f.b.mtimeMs})`));
  }
  if (onlyA.length) {
    warn(`  CHỈ CÓ Ở A (node01), thiếu ở B (node02): ${onlyA.length} file`);
    onlyA.slice(0, 20).forEach((f) => warn(`    − ${f.rel} (${human(f.size)})`));
  }
  if (onlyB.length) {
    warn(`  CHỈ CÓ Ở B (node02), thừa so với A: ${onlyB.length} file`);
    onlyB.slice(0, 20).forEach((f) => warn(`    + ${f.rel} (${human(f.size)})`));
  }

  const integrityOk = differ.length === 0 && onlyA.length === 0 && onlyB.length === 0;
  log("=== KẾT LUẬN TOÀN VẸN ===");
  log(`  ${integrityOk ? "✅ TOÀN VẸN — 2 node KHỚP (checksum+size+mode+mtime)" : "❌ CHƯA TOÀN VẸN — còn khác biệt (xem trên)"}`);
  log(`  Thời gian kiểm tra: ${durationMs}ms`);

  return {
    integrityOk, durationMs,
    counts: { same: same.length, differ: differ.length, onlyA: onlyA.length, onlyB: onlyB.length },
    totalA: totalSize(a), totalB: totalSize(b),
    sample: { differ: differ.slice(0, 5), onlyA: onlyA.slice(0, 5), onlyB: onlyB.slice(0, 5) },
  };
}

function main() {
  let result;
  if (LOCAL_MODE) {
    const dirA = args[LOCAL_IDX + 1];
    const dirB = args[LOCAL_IDX + 2];
    if (!dirA || !dirB) { error("Cần: --local <DIR_A> <DIR_B>"); process.exit(1); }
    result = reportLocal(dirA, dirB);
  } else {
    error("Chế độ peer chưa được hiện thực. Dùng --local <DIR_A> <DIR_B>; không trả PASS giả.");
    process.exit(2);
  }

  if (AS_JSON) console.log(JSON.stringify(result, null, 2));
  const ok = result.integrityOk === true || result.dryRun === true;
  process.exit(ok ? 0 : 3);
}

try { main(); }
catch (e) { error(`verify-integrity lỗi: ${e.stack || e.message}`); process.exit(1); }
