// orchestrator/scripts/hooks/index.mjs
// Registry + runner cho pipeline hook (YÊU CẦU ②).
//
// Thêm nghiệp vụ mới rất dễ:
//   1) Tạo file hooks/<ten>.mjs export { name, run(ctx) }
//   2) Đăng ký vào BUILTIN dưới đây (hoặc dùng shell hook qua config.jsonc)
//   3) Thêm tên hook vào orchestrator/config.jsonc → "handoff_pipeline"
//
// ctx truyền cho mỗi hook:
//   { role, self, successor, predecessor, term, leader, config }
//
// Hook chạy TUẦN TỰ theo thứ tự trong config; lỗi 1 hook không chặn hook sau
// (trừ khi hook có "critical": true).

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "jsonc-parser";
import { REPO_DIR } from "../lib/docker.mjs";
import { pushEvent, pushHandoffLog } from "../lib/rtdb.mjs";
import { log, error, redact } from "../lib/log.mjs";

import * as stopCloudflared from "./stop-cloudflared.mjs";
import * as uploadData from "./upload-data.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Hook dựng sẵn (built-in).
const BUILTIN = {
  [stopCloudflared.name]: stopCloudflared,
  [uploadData.name]: uploadData,
};

// Hook kiểu shell: khai báo trong config.jsonc dạng { "shell": "your command" }.
function makeShellHook(step) {
  return {
    name: step.name || "shell",
    async run(ctx) {
      const cmd = String(step.shell).replace(/\$\{(\w+)\}/g, (_, k) => ctx?.[k] ?? process.env[k] ?? "");
      log(`[hook:${step.name || "shell"}] $ ${cmd}`);
      const res = spawnSync(cmd, { cwd: REPO_DIR, shell: true, encoding: "utf8", timeout: (step.timeout_seconds || 300) * 1000 });
      if (res.status !== 0) {
        error(`[hook:${step.name || "shell"}] non-zero: ${redact((res.stderr || "").trim())}`);
        if (step.critical) throw new Error(`critical shell hook failed: ${step.name}`);
      }
      return { code: res.status };
    },
  };
}

export function loadConfig() {
  const file = resolve(__dirname, "..", "..", "config.jsonc");
  const defaults = {
    handoff_pipeline: [
      { name: "upload-data", critical: true },
      { name: "stop-cloudflared", critical: true },
    ],
    poll_interval_seconds: 5,
    acquire_interval_seconds: 5,
    handoff_on_successor_ready: true,
  };
  if (!existsSync(file)) return defaults;
  try {
    return { ...defaults, ...parse(readFileSync(file, "utf8")) };
  } catch (e) {
    error(`config.jsonc parse failed, using defaults: ${e.message}`);
    return defaults;
  }
}

// Resolve 1 bước pipeline (string builtin | {shell} | {name}) → hook object.
function resolveStep(step) {
  if (typeof step === "string") {
    if (BUILTIN[step]) return BUILTIN[step];
    throw new Error(`unknown builtin hook: ${step}`);
  }
  if (step && step.shell) return makeShellHook(step);
  if (step && step.name && BUILTIN[step.name]) return BUILTIN[step.name];
  throw new Error(`invalid hook step: ${JSON.stringify(step)}`);
}

// Chạy toàn bộ pipeline handoff tuần tự.
export async function runHandoffPipeline(ctx) {
  const config = ctx.config || loadConfig();
  const steps = config.handoff_pipeline || [];
  log(`Running handoff pipeline (${steps.length} hooks) for successor=${ctx.successor}`);
  await pushEvent("handoff.pipeline_start", { successor: ctx.successor, term: ctx.term, steps });
  await pushHandoffLog("pipeline_start", `Chạy pipeline handoff (${steps.length} hook) cho node kế nhiệm ${ctx.successor}`, {
    to: ctx.successor, term: ctx.term, steps: steps.map((s) => (typeof s === "string" ? s : s.name || "shell")),
  });

  const results = [];
  for (const rawStep of steps) {
    let hook;
    try {
      hook = resolveStep(rawStep);
    } catch (e) {
      error(e.message);
      await pushHandoffLog("hook_skip", `Bỏ qua hook không hợp lệ: ${e.message}`, { to: ctx.successor, term: ctx.term });
      continue;
    }
    await pushHandoffLog("hook_start", `Đang chạy hook "${hook.name}"`, { hook: hook.name, to: ctx.successor, term: ctx.term });
    try {
      const out = await hook.run(ctx);
      results.push({ hook: hook.name, ok: true, out });
      await pushHandoffLog("hook_done", `Hook "${hook.name}" chạy xong (thành công)`, { hook: hook.name, ok: true, to: ctx.successor, term: ctx.term });
    } catch (e) {
      error(`hook ${hook.name} failed: ${e.message}`);
      results.push({ hook: hook.name, ok: false, error: e.message });
      await pushHandoffLog("hook_fail", `Hook "${hook.name}" LỖI: ${e.message}`, { hook: hook.name, ok: false, to: ctx.successor, term: ctx.term });
      if (typeof rawStep === "object" && rawStep.critical) {
        await pushEvent("handoff.pipeline_aborted", { at: hook.name, error: e.message });
        await pushHandoffLog("pipeline_aborted", `DỪNG pipeline: hook critical "${hook.name}" thất bại`, { hook: hook.name, to: ctx.successor, term: ctx.term });
        throw e;
      }
    }
  }

  await pushEvent("handoff.pipeline_done", { successor: ctx.successor, term: ctx.term, results });
  await pushHandoffLog("pipeline_done", `Pipeline handoff hoàn tất (${results.filter((r) => r.ok).length}/${results.length} hook OK)`, {
    to: ctx.successor, term: ctx.term,
  });
  log("Handoff pipeline complete");
  return results;
}
