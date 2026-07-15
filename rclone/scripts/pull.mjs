#!/usr/bin/env node
// Pull rclone remotes before app containers start.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { detectDocker } from "../../scripts/runners/_docker.mjs";
import { ROOT, configFile, containerName, ensureLocal, entries, loadConfig, loadEnv, localContainerPath, mapLimit, paths, selectedTags, writeConfigs } from "./lib.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };
const concurrencyArg = args.indexOf("--concurrency");

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

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

function redact(value) {
  return value.replace(/([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|AUTH|KEY|COOKIE|CREDENTIAL|CLIENT)[A-Z0-9_]*=)[^\s]+/gi, "$1[REDACTED]");
}

async function main() {
  const config = loadConfig();
  const { env } = loadEnv(args);
  const tags = selectedTags(args, env);
  const items = entries(env, tags);
  const p = paths(env, config);
  const concurrency = concurrencyArg >= 0 ? Math.max(1, parseInt(args[concurrencyArg + 1], 10) || 1) : config.concurrency;

  if (items.length === 0) {
    log("Rclone pull: no RCLONE_<index>_NAME entries; skip.");
    return;
  }

  writeConfigs(items, p.runtimeRoot, DRY_RUN, log);
  log(`Rclone pull: ${items.length} item(s), concurrency=${Math.min(concurrency, items.length)}, container=${containerName(items)}${tags.length ? `, tags=${tags.join(",")}` : ""}`);

  const docker = DRY_RUN ? { available: true, cmd: "docker" } : detectDocker();
  if (!docker.available) {
    console.error("ERROR: Docker not found. Cannot run rclone pull.");
    process.exit(1);
  }

  const results = await mapLimit(items, concurrency, async (item) => {
    if (!DRY_RUN) ensureLocal(p, item);
    const cfg = configFile(p.runtimeRoot, item);
    const cfgArg = existsSync(cfg) ? ` --config /config/rclone/${item.index}-${item.name}.conf` : "";
    const command = item.type === "file" ? "copyto" : "copy";
    const local = localContainerPath(item);
    const dest = item.type === "file" ? local : `${local}/`;
    const src = item.type === "file" ? item.remote : `${item.remote}/`;
    const cmd = `${docker.cmd} run --rm -v ${shQuote(p.workspaceRoot)}:/workspace -v ${shQuote(p.dataRoot)}:/data -v ${shQuote(p.hostRuntimeRoot)}:/runtime -v ${shQuote(p.runtimeRoot)}:/config/rclone:ro ${shQuote(p.image)} ${command} ${cfgArg} --transfers ${config.transfers} --checkers ${config.checkers} ${shQuote(src)} ${shQuote(dest)}`;
    if (DRY_RUN) {
      log(`[DRY RUN] ${cmd}`);
      return { name: item.name, ok: true };
    }
    const { code, stdout, stderr } = await run(cmd);
    if (code === 0) {
      if (stdout.trim()) log(`[${item.index}:${item.name}] ${stdout.trim()}`);
      return { name: item.name, ok: true };
    }
    console.error(`Rclone pull failed for ${item.index}:${item.name}.`);
    console.error(redact(`${stdout}\n${stderr}`.trim()));
    return { name: item.name, ok: false, code };
  });

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) process.exit(failed[0].code || 1);
}

main();
