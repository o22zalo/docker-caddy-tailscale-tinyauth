#!/usr/bin/env node
// scripts/addapp/add-app.mjs
// Scaffold a new APP into the stack from a template, wire it up, and register
// it in the apps registry + root docker-compose include.
//
// Usage:
//   node scripts/addapp/add-app.mjs --name nine-router --type dockerfile --port 3000
//   node scripts/addapp/add-app.mjs --name hello --type npx --port 8080 --auth
//   node scripts/addapp/add-app.mjs --name mysite --type code --port 3000 --subdomain site --no-auth
//
// Options:
//   --name <n>        App name (folder + service). Required. e.g. nine-router
//   --type <t>        image | dockerfile | npx | code. Required.
//   --port <p>        Internal container port. Default 3000.
//   --subdomain <s>   Subdomain slug. Default derived from name (nine-router).
//   --auth            Protect the route with Tinyauth forward-auth (default: ON)
//   --no-auth         Public route, no login.
//
// Flags:
//   --dry-run   Show what would be created — no writes.
//   --silent    Suppress output (errors still print to stderr).
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROOT, APP_TYPES, normaliseName, nameToPrefix, nameToSlug, addAppToConfig, loadApps,
} from "./app-utils.mjs";

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const SILENT = argv.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };
const die = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };

function opt(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) return true; // boolean flag
  return v;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = resolve(ROOT, "docs/templates");

// ── Parse & validate options ─────────────────────────────────────────────
const rawName = opt("name");
if (!rawName || rawName === true) die("--name is required (e.g. --name nine-router)");
const name = normaliseName(rawName);
if (!name) die(`Invalid --name "${rawName}"`);

const type = opt("type");
if (!type || !APP_TYPES.includes(type)) die(`--type must be one of: ${APP_TYPES.join(", ")}`);

const port = Number(opt("port", 3000));
if (!Number.isInteger(port) || port < 1 || port > 65535) die(`--port must be 1-65535 (got ${opt("port")})`);

const subdomain = opt("subdomain") && opt("subdomain") !== true ? nameToSlug(opt("subdomain")) : nameToSlug(name);
// auth defaults ON; --no-auth turns it off
const auth = argv.includes("--no-auth") ? false : true;

const prefix = nameToPrefix(name);
const appDir = resolve(ROOT, name);

// ── Guards ─────────────────────────────────────────────────────────────────
if (existsSync(appDir)) die(`Directory "${name}/" already exists`);
if (loadApps().apps.some((a) => a.name === name)) die(`App "${name}" already registered in apps-config.jsonc`);
const templateDir = resolve(TEMPLATES, type);
if (!existsSync(templateDir)) die(`Missing template dir: docs/templates/${type}`);

log(`Scaffolding app "${name}"`);
log(`  type       : ${type}`);
log(`  prefix     : ${prefix}_`);
log(`  port       : ${port}`);
log(`  subdomain  : ${subdomain}.<DOMAIN>`);
log(`  auth       : ${auth ? "on (tinyauth_forwarder)" : "off (public)"}`);

// ── Placeholder substitution ────────────────────────────────────────────────
const AUTH_IMPORT = auth ? "      caddy.import: tinyauth_forwarder *" : "";
function render(text) {
  return text
    .split("__APP_NAME__").join(name)
    .split("__APP_PREFIX__").join(prefix)
    .split("__APP_SLUG__").join(subdomain)
    .split("__APP_PORT__").join(String(port))
    .replace(/^__AUTH_IMPORT__$/m, AUTH_IMPORT)
    .split("__AUTH_IMPORT__").join(AUTH_IMPORT);
}

// Collect template files recursively → dest paths (renaming app.yml → <name>.yml)
function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push({ rel: relative(base, full), full });
  }
  return out;
}

const files = walk(templateDir).map(({ rel, full }) => {
  const destRel = rel === "app.yml" ? `${name}.yml` : rel;
  return { destRel, full };
});

// ── Write files ──────────────────────────────────────────────────────────────
for (const { destRel, full } of files) {
  const dest = join(appDir, destRel);
  const content = render(readFileSync(full, "utf8"));
  if (DRY_RUN) { log(`[DRY RUN] write ${relative(ROOT, dest)}`); continue; }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
  log(`  + ${relative(ROOT, dest)}`);
}

// ── Register in apps-config.jsonc ────────────────────────────────────────────
const entry = { name, prefix, type, port, auth };
if (type === "dockerfile" || type === "code") {
  entry.build = {
    context: `./${name}`,
    dockerfile: `./${name}/Dockerfile`,
    image: `proxy-stack-${name}:latest`,
    scope: name,
  };
}
if (DRY_RUN) log(`[DRY RUN] register in apps-config.jsonc: ${JSON.stringify(entry)}`);
else { addAppToConfig(entry); log(`  registered in scripts/addapp/apps-config.jsonc`); }

// ── Wire into root docker-compose.yml include ────────────────────────────────
const rootCompose = resolve(ROOT, "docker-compose.yml");
const includeLine = `  - path: ./${name}/${name}.yml`;
if (existsSync(rootCompose)) {
  const src = readFileSync(rootCompose, "utf8");
  if (src.includes(includeLine.trim())) {
    log(`  include already present in docker-compose.yml`);
  } else if (DRY_RUN) {
    log(`[DRY RUN] append to docker-compose.yml include:\n${includeLine}`);
  } else {
    // Append after the last existing include `- path:` line.
    const lines = src.split("\n");
    let lastIdx = -1;
    for (let i = 0; i < lines.length; i++) if (/^\s+- path:\s+\.\//.test(lines[i])) lastIdx = i;
    if (lastIdx === -1) die("Could not find an include list in docker-compose.yml");
    lines.splice(lastIdx + 1, 0, includeLine);
    writeFileSync(rootCompose, lines.join("\n"));
    log(`  wired into docker-compose.yml include`);
  }
}

// ── Next steps ───────────────────────────────────────────────────────────────
log("");
log("Done. Next steps:");
log(`  1. Edit ${name}/${name}.yml and ${name}/.env.example for your app.`);
if (type === "image") log(`     - set ${prefix}_IMAGE to your real upstream image`);
if (type === "npx") log(`     - set ${prefix}_NPX_PACKAGE / ${prefix}_NPX_ARGS`);
if (type === "dockerfile" || type === "code") log(`     - edit ${name}/Dockerfile (listen on 0.0.0.0:${port})`);
log(`  2. Add ${prefix}_HOST (+ COMPOSE_PROFILES=...,${name}) to root .env / .env.example / .env.ci`);
log(`  3. node scripts/addapp/validate-app.mjs ${name}`);
log(`  4. node scripts/addapp/gen-app-ci.mjs   # regenerate app CI build steps`);
log(`  5. make up-full   (or COMPOSE_PROFILES=core,${name} make up)`);
