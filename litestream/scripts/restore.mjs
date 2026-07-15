#!/usr/bin/env node
// Restore Litestream DBs before app containers start. Missing remote backups are OK.
// Runs all LITESTREAM_<index>_* restores concurrently (independent DBs/buckets).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { parseEnv } from "../../scripts/lib/env-utils.mjs";
import { detectDocker } from "../../scripts/runners/_docker.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const envArg = args.indexOf("--env");
const concurrencyArg = args.indexOf("--concurrency");
const CONCURRENCY = concurrencyArg >= 0 ? Math.max(1, parseInt(args[concurrencyArg + 1], 10) || 1) : Infinity;
const log = (...a) => { if (!SILENT) console.log(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const CONFIG_FILE = resolve(__dirname, "litestream.jsonc");
const ENV = resolve(ROOT, envArg >= 0 ? args[envArg + 1] : ".env");

function loadConfig() {
  const defaults = { image: "litestream/litestream:0.3.13", runtime_root: "ci-runtime", data_root: "./ci-data/litestream" };
  if (!existsSync(CONFIG_FILE)) return defaults;
  return { ...defaults, ...parse(readFileSync(CONFIG_FILE, "utf8")) };
}

function entries(env) {
  const indexes = [...new Set(Object.keys(env).map((key) => key.match(/^LITESTREAM_(\d+)_SERVICE$/)?.[1]).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
  return indexes.map((index) => {
    const prefix = `LITESTREAM_${index}_`;
    const service = env[`${prefix}SERVICE`];
    const path = env[`${prefix}PATH`] || `/data/${service}/${service}.db`;
    const key = env[`${prefix}KEY`] || `${service}/${path.split("/").pop()}`;
    const url = env[`${prefix}URL`] || (env[`${prefix}BUCKET`] ? `s3://${env[`${prefix}BUCKET`]}/${key}` : "");
    return { index, service, path, url };
  }).filter((entry) => entry.service && entry.url);
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function isMissingRemote(output) {
  return /no matching backup|no such key|not found|does not exist|replica.*not.*found|NoSuchKey|404/i.test(output);
}

function redactSecrets(value) {
  return value
    .replace(/(access-key-id:\s*).+/gi, "$1[REDACTED]")
    .replace(/(secret-access-key:\s*).+/gi, "$1[REDACTED]")
    .replace(/(AWS_ACCESS_KEY_ID=)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(AWS_SECRET_ACCESS_KEY=)[^\s]+/gi, "$1[REDACTED]");
}

// Run a shell command async, capture stdout/stderr, never throw — caller inspects .code.
function run(cmd) {
  return new Promise((res) => {
    const proc = spawn(cmd, { cwd: ROOT, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => res({ code: 1, stdout, stderr: `${stderr}\n${err.message}` }));
    proc.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
  });
}

// Simple concurrency-limited map.
async function mapLimit(items, limit, fn) {
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

async function main() {
  const env = { ...parseEnv(ENV), ...process.env };
  const config = loadConfig();
  const dataRoot = resolve(ROOT, env.DOCKER_VOLUME_DATA || dirname(config.data_root), "litestream");
  const runtimeConfig = resolve(ROOT, env.DOCKER_VOLUME_RUNTIME || config.runtime_root, "litestream/litestream.yml");
  const image = env.LITESTREAM_IMAGE || config.image;
  const items = entries(env);

  if (items.length === 0) {
    log("Litestream restore: no LITESTREAM_<index>_SERVICE entries; skip.");
    return;
  }

  const docker = DRY_RUN ? { available: true, cmd: "docker" } : detectDocker();
  if (!docker.available) {
    console.error("ERROR: Docker not found. Cannot run litestream restore.");
    process.exit(1);
  }

  if (!DRY_RUN) mkdirSync(dataRoot, { recursive: true });

  log(`Litestream restore: ${items.length} db(s), concurrency=${CONCURRENCY === Infinity ? items.length : CONCURRENCY}`);

  const results = await mapLimit(items, CONCURRENCY, async (item) => {
    const localPath = resolve(dataRoot, item.path.replace(/^\/data\//, ""));
    if (!DRY_RUN) mkdirSync(dirname(localPath), { recursive: true });
    if (existsSync(localPath)) {
      log(`Litestream restore: ${item.service} local DB exists; skip.`);
      return { service: item.service, ok: true };
    }

    const cmd = `${docker.cmd} run --rm -v ${shQuote(dataRoot)}:/data -v ${shQuote(runtimeConfig)}:/etc/litestream.yml:ro ${shQuote(image)} restore -if-db-not-exists -if-replica-exists -config /etc/litestream.yml ${shQuote(item.path)}`;
    if (DRY_RUN) {
      log(`[DRY RUN] ${cmd}`);
      return { service: item.service, ok: true };
    }

    const { code, stdout, stderr } = await run(cmd);
    const output = `${stdout}\n${stderr}`;

    if (code === 0) {
      if (stdout.trim()) log(`[${item.service}] ${stdout.trim()}`);
      return { service: item.service, ok: true };
    }

    if (isMissingRemote(output)) {
      log(`Litestream restore: ${item.service} has no remote backup yet; app will create DB.`);
      return { service: item.service, ok: true };
    }

    console.error(`Litestream restore failed for ${item.service}.`);
    if (output.trim()) console.error(redactSecrets(output.trim()));
    return { service: item.service, ok: false, code };
  });

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`Litestream restore: ${failed.length}/${items.length} service(s) failed: ${failed.map((f) => f.service).join(", ")}`);
    process.exit(failed[0].code || 1);
  }
}

main();