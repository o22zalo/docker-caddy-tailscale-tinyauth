import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { parseEnv } from "../../scripts/lib/env-utils.mjs";

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "../..");
const CONFIG_FILE = resolve(__dirname, "rclone.jsonc");

export function loadConfig() {
  const defaults = {
    image: "proxy-stack-rclone:local",
    pull_image: "rclone/rclone:1.68",
    runtime_root: "ci-runtime",
    data_root: "./ci-data/rclone",
    concurrency: 8,
    transfers: 8,
    checkers: 16,
    interval_seconds: 300,
  };
  if (!existsSync(CONFIG_FILE)) return defaults;
  return { ...defaults, ...parse(readFileSync(CONFIG_FILE, "utf8")) };
}

export function loadEnv(args) {
  const envArg = args.indexOf("--env");
  const envFile = resolve(ROOT, envArg >= 0 ? args[envArg + 1] : ".env");
  return { envFile, env: { ...parseEnv(envFile), ...process.env } };
}

function splitList(value) {
  return String(value || "").split(/[,\s]+/).map((v) => v.trim()).filter(Boolean);
}

export function selectedTags(args, env) {
  const tagArg = args.indexOf("--tags");
  return splitList(tagArg >= 0 ? args[tagArg + 1] : env.RCLONE_TAGS);
}

function hasSelectedTag(itemTags, tags) {
  return tags.length === 0 || itemTags.some((tag) => tags.includes(tag));
}

export function entries(env, tags = []) {
  const indexes = [...new Set(Object.keys(env).map((key) => key.match(/^RCLONE_(\d+)_NAME$/)?.[1]).filter(Boolean))]
    .sort((a, b) => Number(a) - Number(b));
  return indexes.map((index) => {
    const prefix = `RCLONE_${index}_`;
    const name = env[`${prefix}NAME`];
    const type = env[`${prefix}TYPE`] || "dir";
    const local = (env[`${prefix}LOCAL`] || `/data/rclone/${name}`)
      .replaceAll("{DOCKER_VOLUME_RUNTIME}", env.DOCKER_VOLUME_RUNTIME || "ci-runtime")
      .replaceAll("{DOCKER_VOLUME_DATA}", env.DOCKER_VOLUME_DATA || "ci-data");
    return {
      index,
      name,
      type,
      local,
      remote: env[`${prefix}REMOTE`] || "",
      tags: splitList(env[`${prefix}TAGS`]),
      direction: env[`${prefix}DIRECTION`] || "copy",
      interval: Math.max(1, parseInt(env[`${prefix}INTERVAL`] || "", 10) || 0),
      configRaw: env[`${prefix}CONFIG_RAW`] || "",
      configBase64: env[`${prefix}CONFIG_BASE64`] || "",
    };
  }).filter((entry) => entry.name && entry.remote && hasSelectedTag(entry.tags, tags));
}

export function containerName(items) {
  if (items.length === 0) return "rclone";
  return `rclone-${items[0].index}-${items[0].name}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export function paths(env, config) {
  const inContainer = existsSync("/data") && existsSync("/config/rclone");
  return {
    workspaceRoot: inContainer ? "/workspace" : ROOT,
    dataRoot: inContainer ? "/data" : resolve(ROOT, env.DOCKER_VOLUME_DATA || "ci-data"),
    hostRuntimeRoot: inContainer ? "/runtime" : resolve(ROOT, env.DOCKER_VOLUME_RUNTIME || config.runtime_root),
    runtimeRoot: inContainer ? "/config/rclone" : resolve(ROOT, env.DOCKER_VOLUME_RUNTIME || config.runtime_root, "rclone"),
    image: config.pull_image || "rclone/rclone:1.68",
  };
}

export function configText(item) {
  if (item.configBase64) return Buffer.from(item.configBase64, "base64").toString("utf8");
  return item.configRaw;
}

export function writeConfigs(items, runtimeRoot, dryRun, log) {
  for (const item of items) {
    const text = configText(item);
    if (!text) continue;
    const file = resolve(runtimeRoot, `${item.index}-${item.name}.conf`);
    if (dryRun) {
      log(`[DRY RUN] Would write ${file}`);
      continue;
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
}

export function configFile(runtimeRoot, item) {
  return resolve(runtimeRoot, `${item.index}-${item.name}.conf`);
}

export function localPath(dataRoot, item) {
  return resolve(dataRoot, item.local.replace(/^\/data\/?/, ""));
}

export function localHostPath(p, item) {
  if (item.local.startsWith("/runtime/")) return resolve(p.hostRuntimeRoot, item.local.replace(/^\/runtime\/?/, ""));
  if (item.local.startsWith("/workspace/")) return resolve(ROOT, item.local.replace(/^\/workspace\/?/, ""));
  if (item.local.startsWith("./") || item.local.startsWith("../")) return resolve(ROOT, item.local);
  return localPath(p.dataRoot, item);
}

export function localContainerPath(item) {
  if (item.local.startsWith("/data/") || item.local.startsWith("/runtime/") || item.local.startsWith("/workspace/")) return item.local;
  if (item.local.startsWith("./") || item.local.startsWith("../")) return `/workspace/${item.local.replace(/^\.\//, "")}`;
  return item.local;
}

export function ensureLocal(p, item) {
  const target = localHostPath(p, item);
  mkdirSync(item.type === "file" ? dirname(target) : target, { recursive: true });
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
