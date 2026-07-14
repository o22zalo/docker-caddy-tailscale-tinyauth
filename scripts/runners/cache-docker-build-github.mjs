#!/usr/bin/env node
// scripts/runners/cache-docker-build-github.mjs
// GitHub Actions Docker image cache helper.
//
// Usage in workflow:
//   node scripts/runners/cache-docker-build-github.mjs key     # print cache key
//   node scripts/runners/cache-docker-build-github.mjs restore # load images from tar
//   node scripts/runners/cache-docker-build-github.mjs save    # save images to tar
//
// Reads compose YAMLs to discover pinned image tags, uses tar file
// at TAR_PATH for docker save/load.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

const TAR_PATH = process.env.DOCKER_CACHE_PATH || "/tmp/docker-images-cache.tar";
const COMPOSE_YAMLS = [
  "caddy/caddy.yml",
  "cloudflare/cloudflare.yml",
  "tinyauth/tinyauth.yml",
  "whoami/whoami.yml",
  "tailscale/tailscale.yml",
  "docker-compose.ci.yml",
];

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
      if (m) set.add(m[1]);
    }
  }
  return [...set];
}

function run(cmd) {
  execSync(cmd, { stdio: "inherit" });
}

const key = cacheKey();
const images = imageList();
const action = process.argv[2];

if (!action || !["key", "env", "restore", "save"].includes(action)) {
  console.error("Usage: node cache-docker-build-github.mjs <key|env|restore|save>");
  process.exit(1);
}

if (action === "key") {
  console.log(key);
  process.exit(0);
}

// env: write DOCKER_CACHE_KEY + DOCKER_CACHE_PATH to GITHUB_ENV (for actions/cache step)
if (action === "env") {
  const envFile = process.env.GITHUB_ENV;
  if (envFile) {
    appendFileSync(envFile, `DOCKER_CACHE_KEY=${key}\nDOCKER_CACHE_PATH=${TAR_PATH}\n`);
  }
  console.log(`DOCKER_CACHE_KEY=${key}`);
  console.log(`DOCKER_CACHE_PATH=${TAR_PATH}`);
  process.exit(0);
}

// restore: load images from tar (called AFTER actions/cache restores the tar)
if (action === "restore") {
  console.log(`Images to cache: ${images.join(", ")}`);
  if (existsSync(TAR_PATH) && statSync(TAR_PATH).size > 0) {
    console.log("Loading cached images...");
    run(`docker load -i ${TAR_PATH}`);
    console.log("Cache loaded.");
  } else {
    console.log("No cache found — images will be pulled fresh.");
  }
  process.exit(0);
}

// save: save images to tar (called AFTER compose up, only on cache miss)
if (action === "save") {
  if (existsSync(TAR_PATH) && statSync(TAR_PATH).size > 0) {
    console.log("Cache already exists — skipping save.");
    process.exit(0);
  }
  // Only save images that actually exist locally (profile-gated services may not be pulled)
  const local = images.filter((img) => {
    try {
      execSync(`docker image inspect ${img}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (local.length === 0) {
    console.log("No local images to save.");
    process.exit(0);
  }
  console.log(`Saving ${local.length}/${images.length} local images to cache...`);
  run(`docker save ${local.join(" ")} -o ${TAR_PATH}`);
  const size = statSync(TAR_PATH).size;
  console.log(`Saved ${(size / 1024 / 1024).toFixed(1)}MB.`);
}
