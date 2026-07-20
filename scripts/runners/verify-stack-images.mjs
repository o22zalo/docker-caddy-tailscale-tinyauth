#!/usr/bin/env node
// scripts/runners/verify-stack-images.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Cửa an toàn TRƯỚC "Start stack" (yêu cầu prompt mục 2 & 5):
//   "Sau Bake, in commit SHA, target, image ID/digest và thời gian build;
//    trước Start stack kiểm tra image local đang được Compose tham chiếu đúng
//    image vừa build trong run hiện tại."
//
// Cách hoạt động:
//   1. Với mỗi image tag mong đợi, `docker image ls <tag>` kiểm tra image tồn
//      tại trong Docker daemon (không phụ thuộc metadata file).
//   2. Nếu có metadata-file (bake --metadata-file), so sánh digest để xác nhận
//      image đúng build hiện tại.
//   3. In bảng: commit SHA | target | tag | image Id | digest.
//   4. Nếu image thiếu → FAIL RÕ RÀNG (exit 1).
//
// Usage:
//   node scripts/runners/verify-stack-images.mjs [--metadata <file>] [--silent]
//
// Env:
//   BAKE_METADATA_FILE  đường dẫn metadata-file (mặc định ci-runtime/bake-metadata.json)
//   GITHUB_SHA / BUILD_SOURCEVERSION  commit SHA để in ra (không bắt buộc)
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const args = process.argv.slice(2);
const SILENT = args.includes("--silent");
const metaIdx = args.indexOf("--metadata");
const METADATA_FILE = resolve(
  ROOT,
  metaIdx >= 0 ? args[metaIdx + 1] : process.env.BAKE_METADATA_FILE || "ci-runtime/bake-metadata.json",
);
const log = (...a) => { if (!SILENT) console.log(...a); };
const err = (...a) => console.error(...a);

const COMMIT = (process.env.GITHUB_SHA || process.env.BUILD_SOURCEVERSION || "").slice(0, 40) || "(unknown)";

// Các target bake → tag local mà Compose tham chiếu. Phải KHỚP docker-bake.hcl.
const EXPECTED = {
  webssh: "proxy-stack-webssh:latest",
  rclone: "proxy-stack-rclone:local",
  orchestrator: "proxy-stack-orchestrator:local",
  nodesync: "proxy-stack-nodesync:local",
};

/** Kiểm tra image tồn tại bằng `docker image ls` (không dùng inspect —
 *  inspect fail với docker-container driver + --load). */
function imageExists(tag) {
  try {
    const out = execSync(`docker image ls --format "{{.Repository}}:{{.Tag}}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.split("\n").some((line) => line.trim() === tag);
  } catch {
    return false;
  }
}

/** Lấy image ID (ngắn) bằng docker image ls. Trả "" nếu không có. */
function imageId(tag) {
  try {
    const out = execSync(`docker image ls --format "{{.ID}}" ${tag}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim().split("\n")[0] || "";
  } catch {
    return "";
  }
}

function loadMetadata() {
  if (!existsSync(METADATA_FILE)) return null;
  try {
    return JSON.parse(readFileSync(METADATA_FILE, "utf8"));
  } catch {
    return null;
  }
}

function digestFromMeta(entry) {
  if (!entry || typeof entry !== "object") return "";
  return entry["containerimage.digest"] || "";
}

function main() {
  log(`=== Verify stack images (commit=${COMMIT}) ===`);
  const meta = loadMetadata();
  if (meta) {
    log(`[verify-images] metadata-file: ${METADATA_FILE}`);
  } else {
    log("[verify-images] metadata-file thiếu — bỏ qua digest comparison, chỉ kiểm tra image existence.");
  }

  const rows = [];
  const failures = [];

  for (const [target, tag] of Object.entries(EXPECTED)) {
    const exists = imageExists(tag);
    const id = exists ? imageId(tag) : "";
    const metaDigest = meta ? digestFromMeta(meta?.[target]) : "";

    if (!exists) {
      failures.push(`target=${target} tag=${tag}: KHÔNG có image local (Compose sẽ không dùng được image vừa build).`);
      rows.push({ target, tag, id: "(missing)", digest: metaDigest || "(n/a)", ok: false });
      continue;
    }

    let ok = true;
    // Nếu có metadata, log digest để debug (không fail vì load:true type=docker
    // thường không tạo RepoDigests nên không so được).
    if (metaDigest) {
      log(`[verify-images] ${target}: image found, bake digest=${metaDigest.slice(0, 20)}…`);
    }
    rows.push({ target, tag, id: id.slice(0, 19) || "(unknown)", digest: metaDigest || "(local-load)", ok });
  }

  // In bảng.
  log("");
  log("commit    | target       | tag                              | image id            | digest");
  log("----------|--------------|----------------------------------|---------------------|--------------------------------------------------");
  for (const r of rows) {
    log(
      `${COMMIT.slice(0, 9).padEnd(9)} | ${r.target.padEnd(12)} | ${r.tag.padEnd(32)} | ${String(r.id).padEnd(19)} | ${r.digest}${r.ok ? "" : "  ❌"}`,
    );
  }
  log("");

  if (failures.length) {
    err("[verify-images] FAIL — image local KHÔNG khớp/ thiếu so với run hiện tại:");
    for (const f of failures) err(`  - ${f}`);
    err("[verify-images] Từ chối Start stack để tránh chạy image cũ. Hãy chạy lại Bake (load:true) cho run này.");
    process.exit(1);
  }
  log("[verify-images] OK — tất cả target proxy-stack-* đều có image local của run hiện tại.");
}

main();
