#!/usr/bin/env node
// Restore Litestream DBs before app containers start. Missing remote backups are OK.
import { execSync } from "node:child_process";
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
  return /no such key|not found|does not exist|replica.*not.*found|NoSuchKey|404/i.test(output);
}

const env = { ...parseEnv(ENV), ...process.env };
const config = loadConfig();
const dataRoot = resolve(ROOT, env.DOCKER_VOLUME_DATA || dirname(config.data_root), "litestream");
const runtimeConfig = resolve(ROOT, env.DOCKER_VOLUME_RUNTIME || config.runtime_root, "litestream/litestream.yml");
const image = env.LITESTREAM_IMAGE || config.image;
const items = entries(env);

if (items.length === 0) {
  log("Litestream restore: no LITESTREAM_<index>_SERVICE entries; skip.");
  process.exit(0);
}

const docker = DRY_RUN ? { available: true, cmd: "docker" } : detectDocker();
if (!docker.available) {
  console.error("ERROR: Docker not found. Cannot run litestream restore.");
  process.exit(1);
}

if (!DRY_RUN) mkdirSync(dataRoot, { recursive: true });

for (const item of items) {
  const localPath = resolve(dataRoot, item.path.replace(/^\/data\//, ""));
  if (!DRY_RUN) mkdirSync(dirname(localPath), { recursive: true });
  if (existsSync(localPath)) {
    log(`Litestream restore: ${item.service} local DB exists; skip.`);
    continue;
  }

  const cmd = `${docker.cmd} run --rm -v ${shQuote(dataRoot)}:/data -v ${shQuote(runtimeConfig)}:/etc/litestream.yml:ro ${shQuote(image)} restore -if-db-not-exists -config /etc/litestream.yml ${shQuote(item.path)}`;
  if (DRY_RUN) {
    log(`[DRY RUN] ${cmd}`);
    continue;
  }

  try {
    const output = execSync(cmd, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).toString();
    if (output.trim()) log(output.trim());
  } catch (error) {
    const output = `${error.stdout?.toString() || ""}\n${error.stderr?.toString() || ""}`;
    if (isMissingRemote(output)) {
      log(`Litestream restore: ${item.service} has no remote backup yet; app will create DB.`);
      continue;
    }
    console.error(`Litestream restore failed for ${item.service}.`);
    process.exit(error.status || 1);
  }
}
