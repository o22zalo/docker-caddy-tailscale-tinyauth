// scripts/test/stack-lib.test.mjs
// Unit tests cho scripts/lib/stack-lib.mjs — chạy: node --test scripts/test/*.test.mjs
// Không cần Docker: các hàm poll nhận deps inject (fake sh/dc/runCapture).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  envTruthy,
  uniqueTsHostname,
  sanitizeTsExtraArgs,
  readPredecessor,
  waitForHealthy,
  waitForTailscale,
  waitForServiceRunning,
  probePredecessorSocks,
} from "../lib/stack-lib.mjs";

function tmpFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), "stacklib-"));
  const p = join(dir, name);
  writeFileSync(p, content);
  return { p, dir };
}

test("envTruthy nhận các giá trị hợp lệ", () => {
  for (const v of ["1", "true", "yes", "on", "TRUE", "On"]) assert.equal(envTruthy(v), true, `${v} phải truthy`);
  for (const v of ["0", "false", "no", "off", "", undefined, null, "random"]) assert.equal(envTruthy(v), false, `${v} phải falsy`);
});

test("uniqueTsHostname: local dev giữ nguyên base", () => {
  assert.equal(uniqueTsHostname("proxy-stack", {}), "proxy-stack");
});

test("uniqueTsHostname: GitHub gắn hậu tố runId-attempt, hợp lệ Tailscale", () => {
  const h = uniqueTsHostname("proxy-stack", { GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" });
  assert.equal(h, "proxy-stack-gh-123-2");
  assert.match(h, /^[a-z0-9-]+$/);
  assert.ok(h.length <= 63);
});

test("uniqueTsHostname: Azure gắn hậu tố az-buildId-attempt", () => {
  const h = uniqueTsHostname("proxy-stack", { TF_BUILD: "True", BUILD_BUILDID: "999", SYSTEM_JOBATTEMPT: "3" });
  assert.equal(h, "proxy-stack-az-999-3");
});

test("uniqueTsHostname: cắt tối đa 63 ký tự", () => {
  const h = uniqueTsHostname("x".repeat(80), { GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "1" });
  assert.ok(h.length <= 63);
});

test("sanitizeTsExtraArgs: loại bỏ --ssh nhưng giữ arg khác", () => {
  assert.equal(sanitizeTsExtraArgs("--accept-dns=false --ssh"), "--accept-dns=false");
  assert.equal(sanitizeTsExtraArgs("--ssh=true --accept-dns=false"), "--accept-dns=false");
  assert.equal(sanitizeTsExtraArgs("--accept-dns=false"), "--accept-dns=false");
  assert.equal(sanitizeTsExtraArgs("--ssh"), "");
});

test("readPredecessor: source=null → node đầu tiên (hasPredecessor=false)", () => {
  const { p, dir } = tmpFile("predecessor.json", JSON.stringify({ version: 1, selfId: "n1", source: null }));
  try {
    const r = readPredecessor(p);
    assert.equal(r.hasPredecessor, false);
    assert.equal(r.host, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPredecessor: có source + tailscale dnsName → host chuẩn hoá bỏ dấu chấm cuối", () => {
  const { p, dir } = tmpFile(
    "predecessor.json",
    JSON.stringify({ source: { nodeId: "n0", tailscale: { dnsName: "proxy-stack-gh-1-1.tailnet.ts.net." } } }),
  );
  try {
    const r = readPredecessor(p);
    assert.equal(r.hasPredecessor, true);
    assert.equal(r.host, "proxy-stack-gh-1-1.tailnet.ts.net");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPredecessor: fallback ip khi không có dnsName", () => {
  const { p, dir } = tmpFile("predecessor.json", JSON.stringify({ source: { nodeId: "n0", tailscale: { ip: "100.64.0.5" } } }));
  try {
    assert.equal(readPredecessor(p).host, "100.64.0.5");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPredecessor: file thiếu → hasPredecessor=false (an toàn, không throw)", () => {
  assert.deepEqual(readPredecessor("/khong/ton/tai/predecessor.json"), { hasPredecessor: false, host: "" });
});

test("readPredecessor: file hỏng (có tồn tại) → hasPredecessor=true (không skip rsync)", () => {
  const { p, dir } = tmpFile("predecessor.json", "not-valid-json {{{");
  try {
    const r = readPredecessor(p);
    assert.equal(r.hasPredecessor, true, "file hỏng → assume có predecessor → không skip rsync");
    assert.equal(r.host, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waitForHealthy: trả ngay khi healthy", async () => {
  let calls = 0;
  const deps = { sh: () => { calls++; return "healthy"; }, dc: (x) => x, dryRun: false };
  await waitForHealthy("nodesync", deps, 5000, 10);
  assert.equal(calls, 1);
});

test("waitForHealthy: ném lỗi khi unhealthy", async () => {
  const deps = { sh: () => "unhealthy", dc: (x) => x, dryRun: false };
  await assert.rejects(() => waitForHealthy("svc", deps, 5000, 10), /status=unhealthy/);
});

test("waitForHealthy: timeout khi mãi không healthy", async () => {
  const deps = { sh: () => "starting", dc: (x) => x, dryRun: false };
  await assert.rejects(() => waitForHealthy("svc", deps, 60, 10), /không healthy/);
});

test("waitForHealthy: dryRun trả ngay không gọi sh", async () => {
  let calls = 0;
  await waitForHealthy("svc", { sh: () => { calls++; return "x"; }, dc: (x) => x, dryRun: true }, 5000, 10);
  assert.equal(calls, 0);
});

test("waitForTailscale: true khi Self.Online", async () => {
  const deps = { sh: () => JSON.stringify({ Self: { Online: true } }), dc: (x) => x, dryRun: false };
  assert.equal(await waitForTailscale(deps, 5000, 10), true);
});

test("waitForTailscale: false khi timeout (JSON không online)", async () => {
  const deps = { sh: () => JSON.stringify({ BackendState: "Starting" }), dc: (x) => x, dryRun: false };
  assert.equal(await waitForTailscale(deps, 50, 10), false);
});

test("waitForServiceRunning: true khi service có trong danh sách running", async () => {
  const deps = { sh: () => "caddy\ncloudflared\ntinyauth", dc: (x) => x, dryRun: false };
  assert.equal(await waitForServiceRunning("cloudflared", deps, 5000, 10), true);
});

test("waitForServiceRunning: false khi service không running (timeout)", async () => {
  const deps = { sh: () => "caddy\ntinyauth", dc: (x) => x, dryRun: false };
  assert.equal(await waitForServiceRunning("cloudflared", deps, 50, 10), false);
});

test("probePredecessorSocks: OK ngay lần đầu, không lặp", async () => {
  let attempts = 0;
  const deps = { runCapture: () => { attempts++; return { ok: true }; }, log: () => {}, dryRun: false };
  const ok = await probePredecessorSocks("100.64.0.5", deps, { retries: 5, delayMs: 1 });
  assert.equal(ok, true);
  assert.equal(attempts, 1);
});

test("probePredecessorSocks: hết retry vẫn trả false (KHÔNG throw)", async () => {
  let attempts = 0;
  const deps = { runCapture: () => { attempts++; return { ok: false }; }, log: () => {}, dryRun: false };
  const ok = await probePredecessorSocks("100.64.0.5", deps, { retries: 3, delayMs: 1 });
  assert.equal(ok, false);
  assert.equal(attempts, 3);
});

test("probePredecessorSocks: host rỗng → false, không gọi runCapture", async () => {
  let attempts = 0;
  const deps = { runCapture: () => { attempts++; return { ok: true }; }, log: () => {}, dryRun: false };
  assert.equal(await probePredecessorSocks("", deps, {}), false);
  assert.equal(attempts, 0);
});

test("probePredecessorSocks: dryRun trả true không gọi runCapture", async () => {
  let attempts = 0;
  const deps = { runCapture: () => { attempts++; return { ok: false }; }, log: () => {}, dryRun: true };
  assert.equal(await probePredecessorSocks("h", deps, {}), true);
  assert.equal(attempts, 0);
});
