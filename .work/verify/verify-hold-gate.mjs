#!/usr/bin/env node
// Verify hold-gate HTTP: 204 -> hold on -> 503 + Retry-After -> off -> 204.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd(), "hold-gate-sandbox");
const NS = resolve(process.cwd(), "..", "..", "nodesync");
const port = 18088 + Math.floor(Math.random() * 1000);
const env = { ...process.env, SSH_WORKSPACE: ROOT, NODESYNC_HOLD_GATE_PORT: String(port) };
mkdirSync(ROOT, { recursive: true });

const gate = spawn("node", [resolve(NS, "scripts/hold-gate.mjs"), "--silent"], { env, stdio: "inherit" });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
function hold(action) {
  const result = spawnSync("node", [resolve(NS, "scripts/hold-requests.mjs"), action, "--silent"], { env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`hold ${action} failed: ${result.stderr}`);
}
async function request() {
  const response = await fetch(`http://127.0.0.1:${port}/hold`);
  await response.text();
  return response;
}

try {
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try { if ((await request()).status === 204) { ready = true; break; } } catch {}
    await sleep(100);
  }
  if (!ready) throw new Error("hold-gate không ready");
  hold("on");
  const blocked = await request();
  if (blocked.status !== 503 || blocked.headers.get("retry-after") !== "15") {
    throw new Error(`expected 503/Retry-After=15, got ${blocked.status}/${blocked.headers.get("retry-after")}`);
  }
  hold("off");
  if ((await request()).status !== 204) throw new Error("gate không trở lại 204");
  console.log("VERIFY-HOLD-GATE: PASS ✅");
} finally {
  gate.kill("SIGTERM");
  rmSync(ROOT, { recursive: true, force: true });
}
