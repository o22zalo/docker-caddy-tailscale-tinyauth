#!/usr/bin/env node
// Periodically push local rclone-managed files/folders to remotes.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { configFile, ensureLocal, entries, loadConfig, loadEnv, localContainerPath, mapLimit, paths, selectedTags, writeConfigs } from "./lib.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };

function runRclone(argv) {
  return new Promise((res) => {
    const proc = spawn("rclone", argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => res({ code: 1, stdout, stderr: `${stderr}\n${err.message}` }));
    proc.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
  });
}

function redact(value) {
  return value.replace(/([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|AUTH|KEY|COOKIE|CREDENTIAL|CLIENT)[A-Z0-9_]*=)[^\s]+/gi, "$1[REDACTED]");
}

async function syncOne(item, config, p) {
  if (!DRY_RUN) ensureLocal(p, item);
  const cfg = configFile(p.runtimeRoot, item);
  const local = localContainerPath(item);
  const src = item.type === "file" ? local : `${local}/`;
  const dest = item.type === "file" ? item.remote : `${item.remote}/`;
  const command = item.direction === "bisync" ? "bisync" : (item.type === "file" ? "copyto" : "copy");
  const argv = [
    command,
    "--transfers", String(config.transfers),
    "--checkers", String(config.checkers),
    src,
    dest,
  ];
  if (existsSync(cfg)) argv.splice(1, 0, "--config", cfg);
  if (DRY_RUN) {
    log(`[DRY RUN] rclone ${argv.join(" ")}`);
    return;
  }
  const { code, stdout, stderr } = await runRclone(argv);
  if (code === 0) {
    if (stdout.trim()) log(`[${item.index}:${item.name}] ${stdout.trim()}`);
    return;
  }
  console.error(`Rclone sync failed for ${item.index}:${item.name}.`);
  console.error(redact(`${stdout}\n${stderr}`.trim()));
}

async function main() {
  const config = loadConfig();
  const { env } = loadEnv(args);
  const tags = selectedTags(args, env);
  const items = entries(env, tags);
  const p = paths(env, config);
  if (items.length === 0) {
    log("Rclone sync: no RCLONE_<index>_NAME entries; sleeping.");
    setInterval(() => {}, 2147483647);
    return;
  }
  writeConfigs(items, p.runtimeRoot, DRY_RUN, log);
  log(`Rclone sync: ${items.length} item(s), concurrency=${Math.min(config.concurrency, items.length)}${tags.length ? `, tags=${tags.join(",")}` : ""}`);
  const runAll = () => mapLimit(items, config.concurrency, (item) => syncOne(item, config, p));
  await runAll();
  if (DRY_RUN) return;
  for (const item of items) {
    const seconds = item.interval || config.interval_seconds;
    setInterval(() => syncOne(item, config, p), seconds * 1000);
  }
}

main();
