#!/usr/bin/env node
// scripts/runners/collect-logs.mjs
// CI: collect per-service logs, inspect, and manifest into ci-logs/.
//
// Discovers services dynamically from running containers (docker ps).
// Env vars: MODE, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_SHA, GITHUB_REF, GITHUB_STEP_SUMMARY.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectDocker, dockerCmd } from "./_docker.mjs";
import { redactSecrets } from "../lib/redact-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const LOG_DIR = resolve(ROOT, "ci-logs");
const MODE = process.env.MODE || "unknown";
const GITHUB_STEP_SUMMARY = process.env.GITHUB_STEP_SUMMARY;
const IS_AZURE = process.env.TF_BUILD === "True" || process.env.TF_BUILD === "true" || !!process.env.BUILD_BUILDID;

process.chdir(ROOT);

const docker = detectDocker();
if (!docker.available) {
  console.error("ERROR: Docker not found. Install Docker Desktop or Docker in WSL.");
  process.exit(1);
}
console.log(`Docker: ${docker.via} (${docker.cmd})`);

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

// Discover compose services from this project only.
const PROJECT = process.env.COMPOSE_PROJECT_NAME || "proxy-stack";
const projectFilter = `--filter "label=com.docker.compose.project=${PROJECT}"`;
const serviceLabel = '{{.Label "com.docker.compose.service"}}';
const running = sh(dockerCmd(`ps ${projectFilter} --format '${serviceLabel}'`)).split("\n").filter(Boolean);
const all = sh(dockerCmd(`ps -a ${projectFilter} --format '${serviceLabel}'`)).split("\n").filter(Boolean);
const services = [...new Set(all.length > 0 ? all : running)];

mkdirSync(`${LOG_DIR}/services`, { recursive: true });
mkdirSync(`${LOG_DIR}/inspect`, { recursive: true });

// Stack overview
const ps = run(dockerCmd("compose ps -a")) + "\n\n" +
  "# docker compose config services\n" +
  run(dockerCmd("compose config --services")) + "\n\n" +
  "# docker ps -a (project)\n" +
  run(dockerCmd('ps -a --filter "label=com.docker.compose.project"'));
writeFileSync(`${LOG_DIR}/compose-ps.txt`, ps);

writeFileSync(`${LOG_DIR}/compose-config.yml`, redactSecrets(run(dockerCmd("compose config"))));

if (existsSync(resolve(ROOT, "public-url.txt"))) {
  copyFileSync(resolve(ROOT, "public-url.txt"), `${LOG_DIR}/public-url.txt`);
}

// All services combined log
writeFileSync(`${LOG_DIR}/all-services.log`, redactSecrets(run(dockerCmd("compose logs --no-color --timestamps"))));

// Per-service logs + inspect
for (const svc of services) {
  console.log(`Collecting logs for: ${svc}`);
  const svcLog = run(dockerCmd(`compose logs --no-color --timestamps ${svc}`));
  writeFileSync(`${LOG_DIR}/services/${svc}.log`, redactSecrets(svcLog || "(no logs or service not in this run)\n"));

  const cid = sh(dockerCmd(`ps -aq ${projectFilter} --filter "label=com.docker.compose.service=${svc}"`)).split("\n")[0] || "";
  if (cid) {
    writeFileSync(`${LOG_DIR}/inspect/${svc}.json`, redactSecrets(run(dockerCmd(`inspect ${cid}`)) || "{}"));
    writeFileSync(`${LOG_DIR}/services/${svc}.docker-logs.log`, redactSecrets(run(dockerCmd(`logs --timestamps ${cid}`))));
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

if (GITHUB_STEP_SUMMARY) {
  const summary = `## Collected log files\n\n\`\`\`\n${files}\n\`\`\`\n`;
  execSync(`cat >> "${GITHUB_STEP_SUMMARY}"`, { input: summary });
}

if (IS_AZURE) {
  // Azure Pipelines: upload ci-logs directory as attachment
  try {
    console.log(`##vso[task.uploadfile]${LOG_DIR}/MANIFEST.txt`);
    log("Azure Pipelines: uploaded MANIFEST.txt");
  } catch {}
}

console.log(`Collected ${services.length} service logs into ci-logs/`);
