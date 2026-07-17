#!/usr/bin/env node
// scripts/runners/cache-docker-build-azure.mjs
// Azure Pipelines Docker image cache helper — mirrors the GitHub logic in
// cache-docker-build-github.mjs but writes Azure pipeline variables instead of
// GITHUB_ENV.
//
// Usage:
//   node cache-docker-build-azure.mjs <key|vars|restore|save> [--dry-run] [--silent]
//
// Subcommands:
//   key      Print the cache key (same hash algorithm as GitHub helper).
//   vars     Emit Azure logging commands to set DOCKER_CACHE_KEY / DOCKER_CACHE_PATH.
//   restore  Load images from tar (after the Cache@2 restore step).
//   save     Save local images to tar (after compose up, on cache miss).
//
// Notes:
//   - The cache KEY is computed from the SAME cache-config.jsonc compose_yamls
//     list as GitHub, so both platforms bust the cache identically.
//   - Azure Cache@2 handles the tar file at DOCKER_CACHE_PATH; this script only
//     loads/saves the tar, exactly like the GitHub restore/save subcommands.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { detectDocker, dockerCmd } from "./_docker.mjs";

const allArgs = process.argv.slice(2);
const DRY_RUN = allArgs.includes("--dry-run");
const SILENT = allArgs.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };
const action = allArgs.find((a) => !a.startsWith("--"));

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const TAR_PATH = process.env.DOCKER_CACHE_PATH || `${process.env.PIPELINE_WORKSPACE || "/tmp"}/docker-images-cache.tar`;
const CONFIG_FILE = resolve(__dirname, "cache-config.jsonc");

function loadConfig() {
  const defaults = { compose_yamls: ["docker-compose.ci.yml"] };
  if (!existsSync(CONFIG_FILE)) return defaults;
  return { ...defaults, ...parse(readFileSync(CONFIG_FILE, "utf8")) };
}

const COMPOSE_YAMLS = loadConfig().compose_yamls;

function cacheKey() {
  const hash = createHash("sha256");
  for (const f of COMPOSE_YAMLS) {
    const p = resolve(ROOT, f);
    if (existsSync(p)) hash.update(readFileSync(p));
  }
  return `docker-images-${hash.digest("hex")}`;
}

function imageList() {
  const set = new Set();
  for (const f of COMPOSE_YAMLS) {
    const p = resolve(ROOT, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s+image:\s*(.+?)\s*$/);
      if (!m) continue;
      let img = m[1];
      const varMatch = img.match(/^\$\{[A-Z0-9_]+:-(.+)\}$/);
      if (varMatch) img = varMatch[1];
      if (img.startsWith("$")) continue;
      set.add(img);
    }
  }
  return [...set];
}

function run(cmd) {
  if (!cmd) {
    log("Docker unavailable — skipping image cache step.");
    return false;
  }
  if (DRY_RUN) { log(`[DRY RUN] ${cmd}`); return true; }
  execSync(cmd, { stdio: SILENT ? "ignore" : "inherit" });
  return true;
}

const key = cacheKey();
const images = imageList();

if (!action || !["key", "vars", "restore", "save"].includes(action)) {
  console.error("Usage: node cache-docker-build-azure.mjs <key|vars|restore|save> [--dry-run] [--silent]");
  process.exit(1);
}

if (action === "key") { log(key); process.exit(0); }

if (action === "vars") {
  // Azure Pipelines logging commands set pipeline variables for later steps.
  if (!DRY_RUN) {
    console.log(`##vso[task.setvariable variable=DOCKER_CACHE_KEY]${key}`);
    console.log(`##vso[task.setvariable variable=DOCKER_CACHE_PATH]${TAR_PATH}`);
  }
  log(`DOCKER_CACHE_KEY=${key}`);
  log(`DOCKER_CACHE_PATH=${TAR_PATH}`);
  process.exit(0);
}

if (action === "restore") {
  log(`Images to cache: ${images.join(", ")}`);
  if (existsSync(TAR_PATH) && statSync(TAR_PATH).size > 0) {
    log("Loading cached images...");
    if (run(dockerCmd(`load -i ${TAR_PATH}`))) log("Cache loaded.");
  } else {
    log("No cache found — images will be pulled fresh.");
  }
  process.exit(0);
}

if (action === "save") {
  if (existsSync(TAR_PATH) && statSync(TAR_PATH).size > 0) {
    log("Cache already exists — skipping save.");
    process.exit(0);
  }
  const dcmd = dockerCmd("") || "docker";
  const local = images.filter((img) => {
    try { execSync(`${dcmd} image inspect ${img}`, { stdio: "ignore" }); return true; }
    catch { return false; }
  });
  if (local.length === 0) { log("No local images to save."); process.exit(0); }
  log(`Saving ${local.length}/${images.length} local images to cache...`);
  run(dockerCmd(`save ${local.join(" ")} -o ${TAR_PATH}`));
  if (!DRY_RUN && existsSync(TAR_PATH)) {
    log(`Saved ${(statSync(TAR_PATH).size / 1024 / 1024).toFixed(1)}MB.`);
  }
}
