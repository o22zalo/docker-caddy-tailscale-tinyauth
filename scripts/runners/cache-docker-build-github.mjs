#!/usr/bin/env node
// scripts/runners/cache-docker-build-github.mjs
// GitHub Actions Docker image cache helper.
//
// Usage:
//   node cache-docker-build-github.mjs <key|env|restore|save> [--dry-run] [--silent]
//
// Subcommands:
//   key      Print cache key
//   env      Write DOCKER_CACHE_KEY + DOCKER_CACHE_PATH to GITHUB_ENV
//   restore  Load images from tar (after actions/cache restore)
//   save     Save images to tar (after compose up, on cache miss)
//
// Flags:
//   --dry-run   Show what would be done, no docker/env writes
//   --silent    Suppress output
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { detectDocker, dockerCmd } from "./_docker.mjs";

const allArgs = process.argv.slice(2);
const DRY_RUN = allArgs.includes("--dry-run");
const SILENT = allArgs.includes("--silent");
const log = (...a) => {
  if (!SILENT) console.log(...a);
};
const action = allArgs.find((a) => !a.startsWith("--"));

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const TAR_PATH = process.env.DOCKER_CACHE_PATH || "/tmp/docker-images-cache.tar";
const CONFIG_FILE = resolve(__dirname, "cache-config.jsonc");

function loadConfig() {
  const defaults = {
    compose_yamls: [
      "caddy/caddy.yml",
      "cloudflare/cloudflare.yml",
      "tinyauth/tinyauth.yml",
      "whoami/whoami.yml",
      "tailscale/tailscale.yml",
      "docker-compose.ci.yml",
    ],
  };
  if (!existsSync(CONFIG_FILE)) return defaults;
  return { ...defaults, ...parse(readFileSync(CONFIG_FILE, "utf8")) };
}

const config = loadConfig();
const COMPOSE_YAMLS = config.compose_yamls;

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
      // Resolve Compose ${VAR:-default} syntax to its default so
      // `docker inspect`/`docker save` receive a real, resolvable tag.
      const varMatch = img.match(/^\$\{[A-Z0-9_]+:-(.+)\}$/);
      if (varMatch) img = varMatch[1];
      if (img.startsWith("$")) continue; // unresolved var with no default — skip
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
  if (DRY_RUN) {
    log(`[DRY RUN] ${cmd}`);
    return true;
  }
  execSync(cmd, { stdio: SILENT ? "ignore" : "inherit" });
  return true;
}

const key = cacheKey();
const images = imageList();

if (!action || !["key", "env", "restore", "save"].includes(action)) {
  console.error("Usage: node cache-docker-build-github.mjs <key|env|restore|save> [--dry-run] [--silent]");
  process.exit(1);
}

if (action === "key") {
  log(key);
  process.exit(0);
}

if (action === "env") {
  const envFile = process.env.GITHUB_ENV;
  if (envFile && !DRY_RUN) {
    appendFileSync(envFile, `DOCKER_CACHE_KEY=${key}\nDOCKER_CACHE_PATH=${TAR_PATH}\n`);
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
    try {
      execSync(`${dcmd} image inspect ${img}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (local.length === 0) {
    log("No local images to save.");
    process.exit(0);
  }
  log(`Saving ${local.length}/${images.length} local images to cache...`);
  run(dockerCmd(`save ${local.join(" ")} -o ${TAR_PATH}`));
  if (!DRY_RUN && existsSync(TAR_PATH)) {
    const size = statSync(TAR_PATH).size;
    log(`Saved ${(size / 1024 / 1024).toFixed(1)}MB.`);
  }
}
