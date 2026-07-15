#!/usr/bin/env node
// Generate Litestream config from LITESTREAM_<index>_* env blocks.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { parseEnv } from "../../scripts/lib/env-utils.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const envArg = args.indexOf("--env");
const log = (...a) => { if (!SILENT) console.log(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const CONFIG_FILE = resolve(__dirname, "litestream.jsonc");
const ENV = resolve(ROOT, envArg >= 0 ? args[envArg + 1] : ".env");

function loadConfig() {
  const defaults = { runtime_root: "ci-runtime", data_root: "./ci-data/litestream" };
  if (!existsSync(CONFIG_FILE)) return defaults;
  return { ...defaults, ...parse(readFileSync(CONFIG_FILE, "utf8")) };
}

function q(value) {
  return JSON.stringify(String(value));
}

function entries(env) {
  const indexes = [...new Set(Object.keys(env).map((key) => key.match(/^LITESTREAM_(\d+)_SERVICE$/)?.[1]).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
  return indexes.map((index) => {
    const prefix = `LITESTREAM_${index}_`;
    const service = env[`${prefix}SERVICE`];
    const path = env[`${prefix}PATH`] || `/data/${service}/${service}.db`;
    const key = env[`${prefix}KEY`] || `${service}/${path.split("/").pop()}`;
    const url = env[`${prefix}URL`] || (env[`${prefix}BUCKET`] ? `s3://${env[`${prefix}BUCKET`]}/${key}` : "");
    return {
      index,
      service,
      path,
      url,
      endpoint: env[`${prefix}ENDPOINT`] || "",
      region: env[`${prefix}REGION`] || "",
      accessKeyId: env[`${prefix}ACCESS_KEY_ID`] || "",
      secretAccessKey: env[`${prefix}SECRET_ACCESS_KEY`] || "",
      forcePathStyle: env[`${prefix}FORCE_PATH_STYLE`] || "",
    };
  }).filter((entry) => entry.service && entry.url);
}

function containerName(items) {
  if (items.length === 0) return "litestream";
  return `litestream-${items[0].index}-${items[0].service}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function renderConfig(items) {
  const lines = ["dbs:"];
  if (items.length === 0) {
    lines.push("  []");
    return `${lines.join("\n")}\n`;
  }
  for (const item of items) {
    lines.push(`  - path: ${q(item.path)}`);
    lines.push("    replicas:");
    lines.push(`      - url: ${q(item.url)}`);
    if (item.endpoint) lines.push(`        endpoint: ${q(item.endpoint)}`);
    if (item.region) lines.push(`        region: ${q(item.region)}`);
    if (item.accessKeyId) lines.push(`        access-key-id: ${q(item.accessKeyId)}`);
    if (item.secretAccessKey) lines.push(`        secret-access-key: ${q(item.secretAccessKey)}`);
    if (item.forcePathStyle) lines.push(`        force-path-style: ${item.forcePathStyle === "true"}`);
  }
  return `${lines.join("\n")}\n`;
}

const env = { ...parseEnv(ENV), ...process.env };
const config = loadConfig();
const runtimeConfig = resolve(ROOT, env.DOCKER_VOLUME_RUNTIME || config.runtime_root, "litestream/litestream.yml");
const items = entries(env);
const output = renderConfig(items);

if (DRY_RUN) {
  log(`[DRY RUN] Would write ${runtimeConfig}`);
  log(output.replace(/(access-key-id|secret-access-key): .+/g, "$1: [REDACTED]"));
} else {
  mkdirSync(dirname(runtimeConfig), { recursive: true });
  writeFileSync(runtimeConfig, output);
}

log(`Litestream config: ${items.length} db(s), ${runtimeConfig}`);
log(`Litestream container: ${containerName(items)}`);
if (items.length > 0) log("Litestream profile required: litestream");
