#!/usr/bin/env node
// nodesync/scripts/hold-gate.mjs
// HTTP pre-check cho Caddy: 204 khi phục vụ bình thường; 503 + Retry-After khi
// hold.flag tồn tại. Không ghi file và hỗ trợ --dry-run/--silent.

import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, workspaceDir } from "./lib/env.mjs";
import { log, error } from "./lib/log.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const port = Number(process.env.NODESYNC_HOLD_GATE_PORT || 8088);
const cfg = loadConfig();
const flag = resolve(workspaceDir(), cfg.hold.flag_file);

function holdState() {
  if (!existsSync(flag)) return { hold: false, retryAfter: cfg.hold.retry_after_seconds };
  try {
    const value = JSON.parse(readFileSync(flag, "utf8"));
    return { hold: value.hold !== false, retryAfter: Number(value.retryAfter) || cfg.hold.retry_after_seconds };
  } catch {
    return { hold: true, retryAfter: cfg.hold.retry_after_seconds };
  }
}

if (DRY_RUN) {
  log(`[DRY RUN] hold-gate sẽ listen 0.0.0.0:${port}, đọc ${flag}`);
} else {
  const server = http.createServer((req, res) => {
    if (req.url !== "/hold" && req.url !== "/healthz") {
      res.writeHead(404).end("not found\n");
      return;
    }
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok\n");
      return;
    }
    const state = holdState();
    if (state.hold) {
      res.writeHead(503, {
        "Content-Type": "text/plain; charset=utf-8",
        "Retry-After": String(state.retryAfter),
        "Cache-Control": "no-store",
      }).end(`Node đang đồng bộ dữ liệu; thử lại sau ${state.retryAfter} giây.\n`);
      return;
    }
    res.writeHead(204, { "Cache-Control": "no-store" }).end();
  });
  server.on("error", (e) => { error(`hold-gate lỗi: ${e.message}`); process.exit(1); });
  server.listen(port, "0.0.0.0", () => log(`hold-gate listen 0.0.0.0:${port}; flag=${flag}`));
}
