#!/usr/bin/env node
// .work/verify/verify-nodesync-scenarios.mjs
// KIỂM CHỨNG THỰC THI 10+ KỊCH BẢN đồng bộ khác nhau (yêu cầu: giả lập >10 mẫu
// dữ liệu/kịch bản). Mỗi kịch bản: tạo node01+node02 trạng thái khác nhau →
// rsync THẬT → verify-integrity THẬT → kỳ vọng toàn vẹn.
//
// Chạy được KHÔNG cần Docker/ssh (rsync + sha256 local thật).

import { mkdirSync, writeFileSync, rmSync, existsSync, chmodSync, utimesSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd(), "sandbox-scenarios");
const NS = resolve(process.cwd(), "..", "..", "nodesync");

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), status: r.status };
}
function w(base, rel, content) {
  const abs = resolve(base, rel);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}
function fingerprint(dir) {
  const cmd = `cd ${JSON.stringify(dir)} && { find . -printf 'META %y %p %m %s\\n'; find . -type f -exec sha256sum {} +; find . -type l -printf 'LINK %p -> %l\\n'; } 2>/dev/null | sort | sha256sum | cut -d' ' -f1`;
  const r = sh("bash", ["-lc", cmd]);
  return r.ok ? r.out : "ERR";
}
function rsyncSync(src, dst) {
  const t = Date.now();
  const r = sh("rsync", ["-az", "--delete", "--checksum", "--safe-links", `${src}/`, `${dst}/`]);
  return { ok: r.ok, ms: Date.now() - t, err: r.err };
}
function integrity(a, b) {
  const r = sh("node", [resolve(NS, "scripts/verify-integrity.mjs"), "--local", a, b, "--json", "--silent"]);
  // Ở chế độ --json, kết quả JSON in qua console.log (không bị --silent chặn).
  // Tìm khối JSON đầu tiên bắt đầu bằng '{' tới hết.
  const idx = r.out.indexOf("{");
  if (idx < 0) return null;
  try { return JSON.parse(r.out.slice(idx)); } catch { return null; }
}

// Định nghĩa các kịch bản: (n1seed, n2seed) → sau rsync phải toàn vẹn.
const scenarios = [
  { name: "01 node02 rỗng hoàn toàn", n1: (b) => w(b, "a.txt", "A"), n2: () => {} },
  { name: "02 node02 thiếu 1 file", n1: (b) => { w(b, "a.txt", "A"); w(b, "b.txt", "B"); }, n2: (b) => w(b, "a.txt", "A") },
  { name: "03 node02 khác nội dung", n1: (b) => w(b, "a.txt", "NEW"), n2: (b) => w(b, "a.txt", "OLD") },
  { name: "04 node02 thừa file (bị --delete)", n1: (b) => w(b, "a.txt", "A"), n2: (b) => { w(b, "a.txt", "A"); w(b, "junk.tmp", "junk"); } },
  { name: "05 file rỗng", n1: (b) => w(b, "empty", ""), n2: () => {} },
  { name: "06 nhiều thư mục lồng sâu", n1: (b) => { w(b, "x/y/z/deep.txt", "deep"); w(b, "x/y/w.txt", "w"); }, n2: () => {} },
  { name: "07 tên file có dấu cách + unicode", n1: (b) => { w(b, "có dấu.txt", "tiếng việt"); w(b, "a b c.txt", "spaces"); }, n2: () => {} },
  { name: "08 file lớn ~200KB", n1: (b) => w(b, "big.bin", "Z".repeat(200000)), n2: () => {} },
  { name: "09 nhiều file nhỏ (50 file)", n1: (b) => { for (let i = 0; i < 50; i++) w(b, `many/${i}.txt`, `f${i}`); }, n2: () => {} },
  { name: "10 file ẩn", n1: (b) => { w(b, ".hidden", "h"); w(b, ".config/x", "c"); }, n2: () => {} },
  { name: "11 đổi quyền file (rsync -a giữ perm)", n1: (b) => { const p = w(b, "exec.sh", "#!/bin/sh\necho hi"); chmodSync(p, 0o755); }, n2: (b) => { const p = w(b, "exec.sh", "#!/bin/sh\necho hi"); chmodSync(p, 0o644); } },
  { name: "12 mix: thiếu+khác+thừa cùng lúc", n1: (b) => { w(b, "keep.txt", "K"); w(b, "change.txt", "NEW"); w(b, "add.txt", "ADD"); }, n2: (b) => { w(b, "keep.txt", "K"); w(b, "change.txt", "OLD"); w(b, "remove.txt", "R"); } },
  { name: "13 giống hệt (no-op)", expectDifference: false, n1: (b) => { const p = w(b, "same.txt", "IDENTICAL"); utimesSync(p, 1700000000, 1700000000); }, n2: (b) => { const p = w(b, "same.txt", "IDENTICAL"); utimesSync(p, 1700000000, 1700000000); } },
  { name: "14 symlink nội bộ an toàn", n1: (b) => { w(b, "target.txt", "OK"); symlinkSync("target.txt", resolve(b, "link.txt")); }, n2: () => {} },
  { name: "15 symlink ra ngoài bị safe-links bỏ qua", expectSafeSkip: true, n1: (b) => symlinkSync("/etc/passwd", resolve(b, "unsafe-link")), n2: () => {} },
];

function run() {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  let pass = 0, fail = 0;
  const rows = [];
  for (const s of scenarios) {
    const n1 = resolve(ROOT, s.name.replace(/[^0-9]/g, "") + "/node01");
    const n2 = resolve(ROOT, s.name.replace(/[^0-9]/g, "") + "/node02");
    mkdirSync(n1, { recursive: true });
    mkdirSync(n2, { recursive: true });
    s.n1(n1); s.n2(n2);

    const fpBefore = { a: fingerprint(n1), b: fingerprint(n2) };
    const differedBefore = fpBefore.a !== fpBefore.b;
    const sync = rsyncSync(n1, n2);
    const fpAfter = { a: fingerprint(n1), b: fingerprint(n2) };
    const integ = integrity(n1, n2);
    const expectedDifference = s.expectDifference ?? true;
    const safeSkipOk = s.expectSafeSkip
      ? sync.ok && !existsSync(resolve(n2, "unsafe-link")) && integ?.counts?.onlyA === 1
      : sync.ok && fpAfter.a === fpAfter.b && integ?.integrityOk === true;
    const ok = differedBefore === expectedDifference && safeSkipOk;

    rows.push({
      scenario: s.name,
      differedBefore,
      rsyncMs: sync.ms,
      matchAfter: fpAfter.a === fpAfter.b,
      counts: integ?.counts,
      ok,
    });
    console.log(`${ok ? "✅" : "❌"} ${s.name} | diffTrước=${differedBefore} | rsync=${sync.ms}ms | khớpSau=${fpAfter.a === fpAfter.b} | same=${integ?.counts?.same} differ=${integ?.counts?.differ} onlyA=${integ?.counts?.onlyA} onlyB=${integ?.counts?.onlyB}`);
    if (ok) pass++; else fail++;
  }

  console.log(`\n==== TỔNG HỢP ${scenarios.length} KỊCH BẢN ====`);
  console.log(`PASS=${pass} FAIL=${fail}`);
  console.log(fail === 0 ? "VERIFY-NODESYNC-SCENARIOS: PASS ✅ (toàn bộ kịch bản toàn vẹn sau sync)" : "VERIFY-NODESYNC-SCENARIOS: FAIL ❌");
  process.exit(fail === 0 ? 0 : 1);
}

run();
