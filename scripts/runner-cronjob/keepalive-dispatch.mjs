#!/usr/bin/env node
import { parseEnv } from "../lib/env-utils.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { redactSecrets } from "../lib/redact-utils.mjs";
import { workflowContext } from "./ci-provider.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const MARK_START = args.includes("--mark-start");
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const CONFIG_FILE = resolve(__dirname, "keepalive-dispatch-config.jsonc");
const LOG_FILE = resolve(ROOT, "ci-logs/runner-cronjob.log");
const REPORT_FILE = resolve(ROOT, "ci-logs/runner-cronjob-report.json");
const START_FILE = resolve(ROOT, "ci-logs/runner-cronjob-started-at.txt");
const DISPATCHED_FILE = resolve(ROOT, "ci-logs/runner-cronjob-dispatched.json");
const scriptStartedAt = new Date();
const rows = [];

const redact = (v) => redactSecrets(v).replace(/(gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|Bearer[ \t]+[^"'"'"',\\\s]+)/g, "[REDACTED]");
const line = (msg) => `[${new Date().toISOString()}] ${redact(msg)}`;
const log = (...a) => {
  const msg = line(a.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
  rows.push(msg);
  if (!SILENT) console.log(msg);
};
let cachedEventInputs = null;
function getEventInputs() {
  if (cachedEventInputs !== null) return cachedEventInputs;
  cachedEventInputs = {};
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    try {
      cachedEventInputs = JSON.parse(readFileSync(eventPath, "utf8")).inputs || {};
    } catch {}
  }
  return cachedEventInputs;
}

const fileEnv = parseEnv(resolve(ROOT, ".env"));
const env = (key, fallback = "") => {
  let eventVal = undefined;
  const inputs = getEventInputs();
  if (key === "CRONJOB_NEXT_RUN_ENABLE" || key === "CRONJON_NEXT_RUN_ENABLE") {
    eventVal = inputs.next_run_enable;
  } else if (key === "CRONJOB_NEXT_RUN_MINUTES" || key === "CRONJON_NEXT_RUN_MINUTES") {
    eventVal = inputs.next_run_minutes;
  } else if (key === "CRONJOB_RUN_GROUP") {
    eventVal = inputs.run_group;
  }
  const value = eventVal !== undefined ? eventVal : (fileEnv[key] || process.env[key]);
  if (!value || /^\$\([^)]+\)$/.test(value)) return fallback;
  return value;
};
const boolDefaultTrue = (v) => v === undefined || v === "" ? true : /^(1|true|yes|on)$/i.test(String(v).trim());
const bool = (v) => /^(1|true|yes|on)$/i.test(String(v || ""));
const explicitFalse = (v) => /^(0|false|no|off)$/i.test(String(v || "").trim());
const num = (v, fallback) => Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback;
const channelConfigured = (enableKey, requiredKeys) => {
  const raw = env(enableKey);
  if (explicitFalse(raw)) return false;
  if (bool(raw)) return true;
  return requiredKeys.some((key) => Boolean(env(key)));
};

function resolveDispatchPat() {
  return env("CRONJOB_DISPATCH_PAT") || env("GITHUB_TOKEN") || env("SYSTEM_ACCESSTOKEN") || env("AZURE_DEVOPS_PAT") || "";
}

function config() {
  const defaults = {
    github_api_version: "2022-11-28",
    next_run_minutes: 58,
    channels: {
      cronjoborg: { minute: 0 },
      easycron: { cron_expression: "0 * * * *", timeout: 0 },
      fastcron: { expression: "0 * * * *", timeout: 30 },
      qstash: { cron: "0 * * * *" },
      webhook: {},
    },
  };
  if (!existsSync(CONFIG_FILE)) return defaults;
  return { ...defaults, ...parse(readFileSync(CONFIG_FILE, "utf8")) };
}

/**
 * Đọc thời gian bắt đầu workflow từ CI env vars.
 * GitHub Actions: GITHUB_RUN_STARTED_AT (ISO8601)
 * Azure DevOps: SYSTEM_PIPELINESTARTTIME (MM/DD/YYYY HH:MM:SS UTC)
 * Fallback: thời gian chạy script hiện tại.
 */
function workflowStartedAt() {
  const ghStart = process.env.GITHUB_RUN_STARTED_AT;
  if (ghStart) {
    const d = new Date(ghStart);
    if (!Number.isNaN(d.getTime())) {
      log(`[workflow-start] using GITHUB_RUN_STARTED_AT = ${ghStart}`);
      return d;
    }
  }
  const azStart = process.env.SYSTEM_PIPELINESTARTTIME;
  if (azStart) {
    const d = new Date(azStart);
    if (!Number.isNaN(d.getTime())) {
      log(`[workflow-start] using SYSTEM_PIPELINESTARTTIME = ${azStart}`);
      return d;
    }
  }
  log(`[workflow-start] no CI env found, using script start time = ${scriptStartedAt.toISOString()}`);
  return scriptStartedAt;
}

function currentRunStartedAt() {
  const raw = existsSync(START_FILE) ? readFileSync(START_FILE, "utf8").trim() : "";
  const d = raw ? new Date(raw) : scriptStartedAt;
  return Number.isNaN(d.getTime()) ? scriptStartedAt : d;
}

function nextRunPlan() {
  const minutes = num(env("CRONJOB_NEXT_RUN_MINUTES", env("CRONJON_NEXT_RUN_MINUTES")), config().next_run_minutes);
  const start = currentRunStartedAt();
  const dispatchAt = new Date(start.getTime() + minutes * 60_000);
  const now = new Date();
  const enabledRaw = env("CRONJOB_NEXT_RUN_ENABLE", env("CRONJON_NEXT_RUN_ENABLE"));
  return { enabled: boolDefaultTrue(enabledRaw), minutes, start, dispatchAt, now, allowed: now >= dispatchAt };
}

async function httpJson(name, url, { method = "POST", headers = {}, body } = {}) {
  log(`[${name}] request`, { method, url, body });
  if (DRY_RUN) return { ok: true, status: 0, text: "[DRY RUN]" };
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "User-Agent": "proxy-stack-keepalive", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  log(`[${name}] response`, { status: res.status, body: text || "" });
  return { ok: res.ok, status: res.status, text };
}

async function githubJson(name, url, token, body) {
  return httpJson(name, url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": env("CRONJOB_GITHUB_API_VERSION", config().github_api_version),
    },
    body,
  });
}

function dispatchBody(ctx) {
  const enabledRaw = env("CRONJOB_NEXT_RUN_ENABLE", env("CRONJON_NEXT_RUN_ENABLE"));
  return {
    ref: env("CRONJOB_REF", ctx.ref),
    inputs: {
      run_group: env("CRONJOB_RUN_GROUP", ctx.runGroup),
      next_run_enable: String(boolDefaultTrue(enabledRaw)),
      next_run_minutes: String(num(env("CRONJOB_NEXT_RUN_MINUTES", env("CRONJON_NEXT_RUN_MINUTES")), config().next_run_minutes)),
    },
  };
}

function isHourAllowed(hoursStr, currentHour) {
  if (!hoursStr) return true;
  const cleaned = hoursStr.replace(/\s+/g, "");
  if (cleaned.includes(",")) {
    const list = cleaned.split(",").map(Number).filter((h) => !Number.isNaN(h));
    return list.includes(currentHour);
  }
  if (cleaned.includes("-")) {
    const parts = cleaned.split("-").map(Number);
    if (parts.length === 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])) {
      const start = parts[0];
      const end = parts[1];
      if (start <= end) {
        return currentHour >= start && currentHour < end;
      } else {
        return currentHour >= start || currentHour < end;
      }
    }
  }
  const single = Number(cleaned);
  if (!Number.isNaN(single)) {
    return currentHour === single;
  }
  return true;
}

function getIndexedRepositories(ctx) {
  const list = [];
  let i = 1;
  while (true) {
    const name = env(`CRONJOB_REPO_${i}_NAME`);
    if (!name) break;
    const owner = env(`CRONJOB_REPO_${i}_OWNER`, env("CRONJOB_OWNER", env("CRONJOB_ORG", ctx.owner)));
    const workflow = env(`CRONJOB_REPO_${i}_WORKFLOW`, env("CRONJOB_WORKFLOW", ctx.workflow));
    const ref = env(`CRONJOB_REPO_${i}_REF`, env("CRONJOB_REF", ctx.ref));
    const pat = env(`CRONJOB_REPO_${i}_PAT`, env("CRONJOB_GITHUB_TOKEN", env("CRONJOB_DISPATCH_PAT", env("GITHUB_TOKEN", env("SYSTEM_ACCESSTOKEN", env("AZURE_DEVOPS_PAT"))))));
    const hours = env(`CRONJOB_REPO_${i}_HOURS`);
    list.push({ index: i, name, owner, workflow, ref, pat, hours });
    i++;
  }
  return list;
}

function getDispatchRepositories(ctx) {
  const indexed = getIndexedRepositories(ctx);
  if (indexed.length > 0) return indexed;
  const name = env("CRONJOB_REPO", ctx.repo);
  const owner = env("CRONJOB_OWNER", env("CRONJOB_ORG", ctx.owner));
  const workflow = env("CRONJOB_WORKFLOW", ctx.workflow);
  const ref = env("CRONJOB_REF", ctx.ref);
  const pat = env("CRONJOB_GITHUB_TOKEN") || env("CRONJOB_DISPATCH_PAT") || env("GITHUB_TOKEN") || env("SYSTEM_ACCESSTOKEN") || env("AZURE_DEVOPS_PAT") || "";
  const hours = env("CRONJOB_HOURS");
  return [{ index: 0, name, owner, workflow, ref, pat, hours }];
}

function showCronjobEnv() {
  const allKeys = new Set([
    ...Object.keys(fileEnv),
    ...Object.keys(process.env)
  ]);
  const cronjobKeys = [...allKeys]
    .filter((k) => k.startsWith("CRONJOB_") || k.startsWith("CRONJON_"))
    .sort();
  log("--- CRONJOB Environment Variables ---");
  for (const k of cronjobKeys) {
    const rawVal = fileEnv[k] || process.env[k];
    if (rawVal === undefined) continue;
    const isSecret = /(TOKEN|SECRET|PASSWORD|PASS|AUTH|KEY|PAT|API)/i.test(k);
    const masked = isSecret ? "*".repeat(Math.min(8, rawVal.length)) : rawVal;
    log(`env:${k} = ${masked} (${rawVal.length} characters)`);
  }
  log("-------------------------------------");
}

function channelPlan() {
  return {
    github: true,
    cronjoborg: channelConfigured("CRONJOB_CRONJOBORG_ENABLE", ["CRONJOB_CRONJOBORG_API_KEY"]),
    easycron: channelConfigured("CRONJOB_EASYCRON_ENABLE", ["CRONJOB_EASYCRON_API_KEY"]),
    fastcron: channelConfigured("CRONJOB_FASTCRON_ENABLE", ["CRONJOB_FASTCRON_TOKEN"]),
    qstash: channelConfigured("CRONJOB_QSTASH_ENABLE", ["CRONJOB_QSTASH_TOKEN"]),
    webhook: channelConfigured("CRONJOB_WEBHOOK_ENABLE", ["CRONJOB_WEBHOOK_URL"]),
  };
}

function githubUrl(ctx) {
  const owner = env("CRONJOB_OWNER", env("CRONJOB_ORG", ctx.owner));
  const repo = env("CRONJOB_REPO", ctx.repo);
  const workflow = encodeURIComponent(env("CRONJOB_WORKFLOW", ctx.workflow));
  return `${env("CRONJOB_GITHUB_API", ctx.apiBase)}/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;
}

async function selfDispatch(ctx) {
  const repos = getDispatchRepositories(ctx);
  const tz = env("CRONJOB_TZ", "Asia/Bangkok");
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false });
  const localHour = Number(formatter.format(new Date())) % 24;

  const dispatches = [];
  for (const repo of repos) {
    const label = repo.index > 0 ? `repo #${repo.index} (${repo.owner}/${repo.name})` : `default repo (${repo.owner}/${repo.name})`;
    if (!repo.pat) {
      dispatches.push({ name: label, ok: false, status: "error", error: "Missing dispatch token." });
      log(`[github:dispatch] ${label} failed: Missing dispatch token.`);
      continue;
    }
    const allowed = isHourAllowed(repo.hours, localHour);
    log(`[github:dispatch] ${label} checking hours range [${repo.hours || "any"}] vs current hour [${localHour}h]: ${allowed ? "ALLOWED" : "SKIPPED"}`);
    if (!allowed) {
      dispatches.push({ name: label, ok: null, status: "skipped", reason: `Hour ${localHour}h not in range ${repo.hours}` });
      continue;
    }
    const url = `${env("CRONJOB_GITHUB_API", ctx.apiBase)}/repos/${repo.owner}/${repo.name}/actions/workflows/${encodeURIComponent(repo.workflow)}/dispatches`;
    const body = {
      ref: repo.ref,
      inputs: {
        run_group: env("CRONJOB_RUN_GROUP", ctx.runGroup),
        next_run_enable: String(boolDefaultTrue(env("CRONJOB_NEXT_RUN_ENABLE", env("CRONJON_NEXT_RUN_ENABLE")))),
        next_run_minutes: String(num(env("CRONJOB_NEXT_RUN_MINUTES", env("CRONJON_NEXT_RUN_MINUTES")), config().next_run_minutes)),
      },
    };
    try {
      const res = await githubJson(`github:dispatch:${repo.owner}/${repo.name}`, url, repo.pat, body);
      dispatches.push({ name: label, ok: res.ok, status: res.status, response: redact(res.text || "") });
    } catch (e) {
      log(`[github:dispatch] ${label} error`, e.stack || e.message);
      dispatches.push({ name: label, ok: false, status: "error", error: redact(e.message) });
    }
  }
  const failed = dispatches.filter((d) => d.ok === false).length;
  const text = JSON.stringify(dispatches);
  return { ok: failed === 0, status: failed > 0 ? "error" : "success", text };
}

function dispatchHeaders() {
  const pat = resolveDispatchPat();
  if (!pat) throw new Error("External cron channels need CRONJOB_DISPATCH_PAT (or GITHUB_TOKEN / Azure System.AccessToken).");
  return [
    `Authorization: Bearer ${pat}`,
    "Accept: application/vnd.github+json",
    `X-GitHub-Api-Version: ${env("CRONJOB_GITHUB_API_VERSION", config().github_api_version)}`,
    "Content-Type: application/json",
  ];
}

/**
 * Format expiresAt cho cron-job.org: YYYYMMDDHHmmss trong timezone tz.
 * expiresAt = nextRunAt + 30 phút để đảm bảo job kịp chạy trước khi expire.
 */
function formatCronJobOrgExpiry(nextRunAt, tz) {
  const expiry = new Date(nextRunAt.getTime() + 30 * 60_000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(expiry);
  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  // hour12:false có thể trả về "24" vào lúc nửa đêm
  return Number(`${get("year")}${get("month")}${get("day")}${get("hour").replace("24", "00")}${get("minute")}${get("second")}`);
}

/**
 * Tách minute/hour/day/month từ nextRunAt trong timezone tz.
 * Dùng cho one-shot schedule pinning.
 */
function getScheduleParts(nextRunAt, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(nextRunAt);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value || "0");
  return {
    minute: get("minute"),
    hour: get("hour") % 24,
    day: get("day"),
    month: get("month"),
  };
}

/**
 * cron-job.org:
 * - nextRunAt != null → one-shot (expiresAt + pinned fields) theo doc mới
 * - nextRunAt == null → fallback recurring (P7 retry)
 */
async function ensureCronJobOrg(ctx, nextRunAt) {
  if (!channelConfigured("CRONJOB_CRONJOBORG_ENABLE", ["CRONJOB_CRONJOBORG_API_KEY"])) return null;
  const apiKey = env("CRONJOB_CRONJOBORG_API_KEY");
  const pat = resolveDispatchPat();
  if (!apiKey || !pat) throw new Error("cron-job.org needs CRONJOB_CRONJOBORG_API_KEY and a dispatch PAT.");
  const tz = env("CRONJOB_TZ", "Asia/Bangkok");

  let scheduleField;
  if (nextRunAt) {
    const { minute, hour, day, month } = getScheduleParts(nextRunAt, tz);
    scheduleField = {
      timezone: tz,
      expiresAt: formatCronJobOrgExpiry(nextRunAt, tz),
      hours: [hour],
      mdays: [day],
      minutes: [minute],
      months: [month],
      wdays: [-1],
    };
    log(`[cron-job.org] one-shot schedule: ${JSON.stringify(scheduleField)}`);
  } else {
    scheduleField = {
      timezone: tz,
      expiresAt: 0,
      hours: [-1],
      mdays: [-1],
      minutes: [Number(env("CRONJOB_CRONJOBORG_MINUTE", config().channels.cronjoborg.minute))],
      months: [-1],
      wdays: [-1],
    };
  }

  const body = {
    job: {
      title: env("CRONJOB_JOB_TITLE", "proxy-stack-keepalive"),
      enabled: true,
      saveResponses: true,
      url: githubUrl(ctx),
      requestMethod: 1,
      redirectSuccess: true,
      schedule: scheduleField,
      requestHeaders: [
        { name: "Authorization", value: `Bearer ${pat}` },
        { name: "Accept", value: "application/vnd.github+json" },
        { name: "Content-Type", value: "application/json" },
      ],
      requestBody: JSON.stringify(dispatchBody(ctx)),
      notification: {
        onFailure: true,
        onFailureCount: 3,
        onSuccess: true,
        onDisable: true,
      },
    },
  };
  return httpJson("cron-job.org:create", "https://api.cron-job.org/jobs", { method: "PUT", headers: { Authorization: `Bearer ${apiKey}` }, body });
}

/**
 * EasyCron:
 * - nextRunAt != null → pinned cron expression "M H D Mon *" (one-shot tháng này)
 * - nextRunAt == null → fallback cron expression từ config
 */
async function ensureEasyCron(ctx, nextRunAt) {
  if (!channelConfigured("CRONJOB_EASYCRON_ENABLE", ["CRONJOB_EASYCRON_API_KEY"])) return null;
  const apiKey = env("CRONJOB_EASYCRON_API_KEY");
  if (!apiKey) throw new Error("EasyCron needs CRONJOB_EASYCRON_API_KEY.");
  const cfg = config().channels.easycron;
  const tz = env("CRONJOB_TZ", "Asia/Bangkok");

  let cronExpression;
  if (nextRunAt) {
    const { minute, hour, day, month } = getScheduleParts(nextRunAt, tz);
    cronExpression = `${minute} ${hour} ${day} ${month} *`;
    log(`[easycron] one-shot pinned cron: ${cronExpression}`);
  } else {
    cronExpression = env("CRONJOB_EASYCRON_CRON", cfg.cron_expression);
  }

  return httpJson("easycron:create", env("CRONJOB_EASYCRON_API", "https://api.easycron.com/v1/cron-jobs"), {
    headers: { "X-API-Key": apiKey },
    body: {
      url: githubUrl(ctx),
      cron_expression: cronExpression,
      timezone_from: 2,
      timezone: tz,
      http_method: "POST",
      http_headers: dispatchHeaders().join("\n"),
      http_message_body: JSON.stringify(dispatchBody(ctx)),
      timeout: Number(env("CRONJOB_EASYCRON_TIMEOUT", cfg.timeout)),
      status: 1,
      cron_job_name: env("CRONJOB_JOB_TITLE", "proxy-stack-keepalive"),
    },
  });
}

/**
 * FastCron:
 * - nextRunAt != null → pinned cron expression "M H D Mon *"
 * - nextRunAt == null → fallback expression từ config
 */
async function ensureFastCron(ctx, nextRunAt) {
  if (!channelConfigured("CRONJOB_FASTCRON_ENABLE", ["CRONJOB_FASTCRON_TOKEN"])) return null;
  const token = env("CRONJOB_FASTCRON_TOKEN");
  if (!token) throw new Error("FastCron needs CRONJOB_FASTCRON_TOKEN.");
  const cfg = config().channels.fastcron;
  const tz = env("CRONJOB_TZ", "Asia/Bangkok");

  let expression;
  if (nextRunAt) {
    const { minute, hour, day, month } = getScheduleParts(nextRunAt, tz);
    expression = `${minute} ${hour} ${day} ${month} *`;
    log(`[fastcron] one-shot pinned cron: ${expression}`);
  } else {
    expression = env("CRONJOB_FASTCRON_EXPRESSION", cfg.expression);
  }

  return httpJson("fastcron:create", env("CRONJOB_FASTCRON_API", "https://www.fastcron.com/api/v1/cron_add"), {
    headers: { Authorization: `Bearer ${token}` },
    body: {
      url: githubUrl(ctx),
      expression,
      timezone: tz,
      timeout: Number(env("CRONJOB_FASTCRON_TIMEOUT", cfg.timeout)),
      instances: 1,
      httpMethod: "POST",
      postData: JSON.stringify(dispatchBody(ctx)),
      httpHeaders: dispatchHeaders().join("\r\n"),
      name: env("CRONJOB_JOB_TITLE", "proxy-stack-keepalive"),
      notify: false,
    },
  });
}

/**
 * QStash:
 * - nextRunAt != null → one-shot publish với Upstash-Not-Before (Unix seconds)
 * - nextRunAt == null → fallback recurring schedule (P7 retry)
 */
async function ensureQstash(ctx, nextRunAt) {
  if (!channelConfigured("CRONJOB_QSTASH_ENABLE", ["CRONJOB_QSTASH_TOKEN"])) return null;
  const token = env("CRONJOB_QSTASH_TOKEN");
  const pat = resolveDispatchPat();
  if (!token || !pat) throw new Error("QStash needs CRONJOB_QSTASH_TOKEN and a dispatch PAT.");
  const destination = encodeURIComponent(githubUrl(ctx));
  const qstashBase = env("CRONJOB_QSTASH_API", "https://qstash.upstash.io");
  const apiVersion = env("CRONJOB_GITHUB_API_VERSION", config().github_api_version);

  if (nextRunAt) {
    const notBefore = Math.floor(nextRunAt.getTime() / 1000);
    log(`[qstash] one-shot publish Upstash-Not-Before=${notBefore} (${nextRunAt.toISOString()})`);
    return httpJson("qstash:publish", `${qstashBase}/v2/publish/${destination}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Upstash-Not-Before": String(notBefore),
        "Upstash-Method": "POST",
        "Upstash-Forward-Authorization": `Bearer ${pat}`,
        "Upstash-Forward-Accept": "application/vnd.github+json",
        "Upstash-Forward-X-GitHub-Api-Version": apiVersion,
        "Upstash-Forward-Content-Type": "application/json",
      },
      body: dispatchBody(ctx),
    });
  } else {
    return httpJson("qstash:schedule", `${qstashBase}/v2/schedules/${destination}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Upstash-Cron": env("CRONJOB_QSTASH_CRON", config().channels.qstash.cron),
        "Upstash-Method": "POST",
        "Upstash-Schedule-Id": env("CRONJOB_QSTASH_SCHEDULE_ID", env("CRONJOB_JOB_TITLE", "proxy-stack-keepalive")),
        "Upstash-Forward-Authorization": `Bearer ${pat}`,
        "Upstash-Forward-Accept": "application/vnd.github+json",
        "Upstash-Forward-X-GitHub-Api-Version": apiVersion,
        "Upstash-Forward-Content-Type": "application/json",
      },
      body: dispatchBody(ctx),
    });
  }
}

/**
 * Webhook: gửi kèm scheduled_at khi có nextRunAt để receiver biết thời điểm dự kiến.
 */
async function callWebhook(ctx, nextRunAt) {
  if (!channelConfigured("CRONJOB_WEBHOOK_ENABLE", ["CRONJOB_WEBHOOK_URL"])) return null;
  const url = env("CRONJOB_WEBHOOK_URL");
  if (!url) throw new Error("Webhook needs CRONJOB_WEBHOOK_URL.");
  const token = env("CRONJOB_WEBHOOK_TOKEN");
  const payload = {
    url: githubUrl(ctx),
    body: dispatchBody(ctx),
    ...(nextRunAt ? { scheduled_at: nextRunAt.toISOString() } : {}),
  };
  return httpJson("webhook", url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, body: payload });
}

async function runChannel(name, fn, results, step) {
  try {
    const res = await fn();
    if (!res) {
      results.push({ name, configured: false, ok: null, status: "skipped", step });
      return;
    }
    results.push({ name, configured: true, ok: res.ok, status: res.status, response: redact(res.text || ""), step });
  } catch (e) {
    log(`[${name}] error`, e.stack || e.message);
    results.push({ name, configured: true, ok: false, status: "error", error: redact(e.message), step });
  }
}

function writeReport(report) {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  const text = `${rows.join("\n")}\n\nREPORT\n${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(LOG_FILE, redact(text));
  writeFileSync(REPORT_FILE, redact(JSON.stringify(report, null, 2)));
}

function readDispatched() {
  if (!existsSync(DISPATCHED_FILE)) return {};
  try {
    return JSON.parse(readFileSync(DISPATCHED_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeDispatched(dispatched) {
  mkdirSync(dirname(DISPATCHED_FILE), { recursive: true });
  writeFileSync(DISPATCHED_FILE, JSON.stringify(dispatched, null, 2));
}

// ── MARK START ────────────────────────────────────────────────────────────────

async function markStart() {
  const wfStart = workflowStartedAt();
  const minutes = num(env("CRONJOB_NEXT_RUN_MINUTES", env("CRONJON_NEXT_RUN_MINUTES")), config().next_run_minutes);
  const nextRunAt = new Date(wfStart.getTime() + minutes * 60_000);
  const enabledRaw = env("CRONJOB_NEXT_RUN_ENABLE", env("CRONJON_NEXT_RUN_ENABLE"));

  log("[mark-start] workflowStartedAt =", wfStart.toISOString());
  log("[mark-start] nextRunAt =", nextRunAt.toISOString());

  if (!DRY_RUN) {
    mkdirSync(dirname(START_FILE), { recursive: true });
    writeFileSync(START_FILE, `${wfStart.toISOString()}\n`);
  }

  const ctx = workflowContext();
  const externalResults = [];

  if (!boolDefaultTrue(enabledRaw)) {
    log("[mark-start] CRONJOB_NEXT_RUN_ENABLE=false, skip external channel dispatch.");
  } else {
    showCronjobEnv();
    log("[mark-start] dispatching external channels for nextRunAt =", nextRunAt.toISOString());
    await runChannel("cron-job.org", () => ensureCronJobOrg(ctx, nextRunAt), externalResults, "mark-start");
    await runChannel("easycron", () => ensureEasyCron(ctx, nextRunAt), externalResults, "mark-start");
    await runChannel("fastcron", () => ensureFastCron(ctx, nextRunAt), externalResults, "mark-start");
    await runChannel("qstash", () => ensureQstash(ctx, nextRunAt), externalResults, "mark-start");
    await runChannel("webhook", () => callWebhook(ctx, nextRunAt), externalResults, "mark-start");
  }

  // Ghi dispatched.json để P7 biết channels nào đã ok
  const dispatched = {};
  for (const r of externalResults) {
    dispatched[r.name] = { ok: r.ok, step: "mark-start" };
  }
  if (!DRY_RUN) writeDispatched(dispatched);

  const configured = externalResults.filter((r) => r.configured);
  const success = configured.filter((r) => r.ok).length;
  const failed = configured.filter((r) => r.ok === false).length;

  const report = {
    action: "mark-start",
    dryRun: DRY_RUN,
    startFile: START_FILE,
    workflowStartedAt: wfStart.toISOString(),
    nextRunAt: nextRunAt.toISOString(),
    nextRun: {
      enabled: boolDefaultTrue(enabledRaw),
      minutes,
      behavior: "External channels dispatched above. P7 Self-dispatch will skip channels already ok here.",
    },
    externalChannels: {
      results: externalResults,
      summary: { configured: configured.length, success, failed },
    },
    note: DRY_RUN ? "Dry-run only; no files written, no API calls made." : "Workflow start recorded. External channels dispatched.",
  };
  log("[mark-start] report", report);
  writeReport(report);
}

if (MARK_START) {
  await markStart();
  process.exit(0);
}

// ── P7 SELF-DISPATCH ──────────────────────────────────────────────────────────

showCronjobEnv();

const ctx = workflowContext();
const plan = nextRunPlan();
const channels = channelPlan();
const results = [];
log("[plan]", {
  provider: ctx.provider,
  channels,
  enabled: plan.enabled,
  currentRunStartedAt: plan.start.toISOString(),
  nextRunMinutes: plan.minutes,
  dispatchAllowedAt: plan.dispatchAt.toISOString(),
  now: plan.now.toISOString(),
  allowedNow: plan.allowed,
  dryRun: DRY_RUN,
  dispatchBody: dispatchBody(ctx),
});

// Đọc channels đã ok ở --mark-start để skip
const alreadyDispatched = readDispatched();
const skippedChannels = Object.entries(alreadyDispatched)
  .filter(([, v]) => v.ok === true)
  .map(([name]) => name);
if (skippedChannels.length > 0) {
  log(`[self-dispatch] channels already ok at mark-start (will skip): ${skippedChannels.join(", ")}`);
}

if (ctx.provider !== "github" && !env("CRONJOB_OWNER")) {
  log(`[provider] ${ctx.provider}; no CRONJOB_OWNER, skip.`);
} else if (!plan.enabled) {
  log("[next-run] disabled by CRONJOB_NEXT_RUN_ENABLE.");
} else if (!plan.allowed) {
  log("[next-run] not time yet; skip dispatch.");
} else {
  // GitHub self-dispatch luôn chạy ở P7
  await runChannel("github", () => selfDispatch(ctx), results, "self-dispatch");

  // External channels: skip nếu đã ok ở mark-start
  const skipIfOk = (name, fn) => {
    if (skippedChannels.includes(name)) {
      log(`[self-dispatch] ${name}: already dispatched at mark-start, skip.`);
      results.push({ name, configured: true, ok: null, status: "skipped", step: "self-dispatch", skippedReason: "dispatched-at-mark-start" });
      return Promise.resolve();
    }
    return runChannel(name, fn, results, "self-dispatch");
  };

  await skipIfOk("cron-job.org", () => ensureCronJobOrg(ctx, null));
  await skipIfOk("easycron", () => ensureEasyCron(ctx, null));
  await skipIfOk("fastcron", () => ensureFastCron(ctx, null));
  await skipIfOk("qstash", () => ensureQstash(ctx, null));
  await skipIfOk("webhook", () => callWebhook(ctx, null));
}

const configured = results.filter((r) => r.configured);
const success = configured.filter((r) => r.ok).length;
const failed = configured.filter((r) => r.ok === false).length;
const report = {
  action: "self-dispatch",
  plan: {
    provider: ctx.provider,
    channels,
    enabled: plan.enabled,
    currentRunStartedAt: plan.start.toISOString(),
    nextRunMinutes: plan.minutes,
    dispatchAllowedAt: plan.dispatchAt.toISOString(),
    now: plan.now.toISOString(),
    allowedNow: plan.allowed,
  },
  skippedFromMarkStart: skippedChannels,
  results,
  summary: { configured: configured.length, success, failed, skipped: results.length - configured.length },
};
writeReport(report);
if (plan.enabled && plan.allowed && configured.length > 0 && success === 0) process.exitCode = 1;
