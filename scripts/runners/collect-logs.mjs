#!/usr/bin/env node
// scripts/runners/collect-logs.mjs
// CI: collect per-service logs, inspect, and manifest into ci-logs/.
//
// Env vars: MODE, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_SHA, GITHUB_REF, GITHUB_STEP_SUMMARY.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const LOG_DIR = resolve(ROOT, "ci-logs");
const MODE = process.env.MODE || "unknown";
const GITHUB_STEP_SUMMARY = process.env.GITHUB_STEP_SUMMARY;

process.chdir(ROOT);

function run(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] }).toString();
  } catch (e) {
    return e.stdout ? e.stdout.toString() : "";
  }
}

function sh(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  } catch {
    return "";
  }
}

mkdirSync(`${LOG_DIR}/services`, { recursive: true });
mkdirSync(`${LOG_DIR}/inspect`, { recursive: true });

// Stack overview
const ps = run("docker compose ps -a") + "\n\n" +
  "# docker compose config services\n" +
  run("docker compose config --services") + "\n\n" +
  "# docker ps -a (project)\n" +
  run('docker ps -a --filter "label=com.docker.compose.project"');
writeFileSync(`${LOG_DIR}/compose-ps.txt`, ps);

writeFileSync(`${LOG_DIR}/compose-config.yml`, run("docker compose config"));

if (existsSync(resolve(ROOT, "public-url.txt"))) {
  copyFileSync(resolve(ROOT, "public-url.txt"), `${LOG_DIR}/public-url.txt`);
}

// All services combined log
writeFileSync(`${LOG_DIR}/all-services.log`, run("docker compose logs --no-color --timestamps"));

// Discover services
const KNOWN = ["caddy", "tinyauth", "whoami", "cloudflared", "tailscale"];
const extra = sh("docker compose config --services").split("\n").filter(Boolean);
const services = [...new Set([...KNOWN, ...extra])];

// Per-service logs + inspect
for (const svc of services) {
  console.log(`Collecting logs for: ${svc}`);
  const log = run(`docker compose logs --no-color --timestamps ${svc}`);
  writeFileSync(`${LOG_DIR}/services/${svc}.log`, log || "(no logs or service not in this run)\n`);

  const cid = sh(`docker compose ps -aq ${svc} | head -1`);
  if (cid) {
    writeFileSync(`${LOG_DIR}/inspect/${svc}.json`, run(`docker inspect ${cid}`) || "{}");
    writeFileSync(`${LOG_DIR}/services/${svc}.docker-logs.log`, run(`docker logs --timestamps ${cid}`));
  } else {
    writeFileSync(`${LOG_DIR}/inspect/${svc}.json`, '{"note":"container not found"}');
  }
}

// Manifest
const files = sh(`find ${LOG_DIR} -type f | sort`);
const manifest = [
  `collected_at=${new Date().toISOString()}`,
  `mode=${MODE}`,
  `run_id=${process.env.GITHUB_RUN_ID || ""}`,
  `run_attempt=${process.env.GITHUB_RUN_ATTEMPT || ""}`,
  `sha=${process.env.GITHUB_SHA || ""}`,
  `ref=${process.env.GITHUB_REF || ""}`,
  `services=${services.join(" ")}`,
  "",
  "files:",
  files,
].join("\n");
writeFileSync(`${LOG_DIR}/MANIFEST.txt`, manifest);

// Step summary
if (GITHUB_STEP_SUMMARY) {
  const summary = `## Collected log files\n\n\`\`\`\n${files}\n\`\`\`\n`;
  execSync(`cat >> "${GITHUB_STEP_SUMMARY}"`, { input: summary });
}

console.log(`Collected ${services.length} service logs into ci-logs/`);
