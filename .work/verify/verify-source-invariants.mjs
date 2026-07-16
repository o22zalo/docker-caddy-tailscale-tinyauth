#!/usr/bin/env node
// Static integration invariants for wiring that unit simulations cannot execute.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd(), "..", "..");
function text(path) { return readFileSync(resolve(ROOT, path), "utf8"); }
function requirePattern(path, pattern, message) {
  if (!pattern.test(text(path))) throw new Error(`${path}: ${message}`);
}

requirePattern("nodesync/Dockerfile", /FROM cloudflare\/cloudflared:2026\.7\.1 AS cloudflared/, "cloudflared phải lấy từ official image");
requirePattern("nodesync/Dockerfile", /openssh-client-default/, "Alpine package openssh-client-default bị thiếu");
requirePattern("scripts/runners/start-stack.mjs", /restore\.mjs[\s\S]*syncOnStart[\s\S]*exec -T nodesync node scripts\/sync\.mjs[\s\S]*up -d --remove-orphans/, "startup phải restore → sync → app");
requirePattern("orchestrator/scripts/main.mjs", /handoff pipeline critical error[\s\S]*handoffDone = false;[\s\S]*continue;[\s\S]*Releasing leadership/, "critical handoff failure phải giữ leader");
requirePattern("orchestrator/config.jsonc", /upload-data\"?, \"critical\": true[\s\S]*stop-cloudflared\"?, \"critical\": true/, "built-in handoff hooks phải critical");
requirePattern("orchestrator/scripts/hooks/upload-data.mjs", /sync-loop\.mjs\", \"--once/, "upload hook phải flush rclone một lần");
requirePattern("scripts/runners/setup-env.mjs", /ORCH_NODE_ID=.*nodeId/, "node ID phải materialize trước Compose");
requirePattern("caddy/caddy.yml", /\(nodesync_hold_gate\)[\s\S]*nodesync:8088/, "Caddy hold-gate chưa được định nghĩa");
requirePattern("whoami/whoami.yml", /caddy\.import: nodesync_hold_gate/, "whoami chưa import hold-gate");

console.log("VERIFY-SOURCE-INVARIANTS: PASS ✅");
