#!/usr/bin/env node
// scripts/runner-tools/install-tool.mjs
// Install external CLI tools inside a CI runner (or locally) with MULTIPLE
// fallback methods. Tries each method in order until the tool verifies OK.
//
// Usage:
//   node scripts/runner-tools/install-tool.mjs <name> [name2 ...]
//   node scripts/runner-tools/install-tool.mjs --all
//   node scripts/runner-tools/install-tool.mjs opencode --dry-run
//
// Flags:
//   --all         install every tool in tools-config.jsonc
//   --dry-run     print what would run, install nothing
//   --skip-if-present   if `verify` already passes, do nothing (default: on)
//   --force       reinstall even if already present
//   --timeout=N   per-method timeout in seconds (default 300)
//
// Behaviour:
//   - Each method runs via `bash -lc` (login shell → picks up nvm/brew PATHs).
//   - `needs` gate: a method is skipped if its required binary is absent.
//   - After every method (and before the first), `pathAdd` dirs are added to
//     PATH for this process, and appended to $GITHUB_PATH when on GitHub Actions
//     so later workflow steps see the tool too.
//   - Exits 0 only if the tool verifies; non-zero (and a summary) otherwise.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const CONFIG = resolve(__dirname, "tools-config.jsonc");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const FORCE = args.includes("--force");
const ALL = args.includes("--all");
const SKIP_IF_PRESENT = !FORCE; // present-check on unless --force
const timeoutArg = args.find((a) => a.startsWith("--timeout="));
const TIMEOUT = (timeoutArg ? parseInt(timeoutArg.split("=")[1], 10) : 300) * 1000;
const names = args.filter((a) => !a.startsWith("--"));

const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[install-tool ${ts()}]`, ...a);
const warn = (...a) => console.warn(`[install-tool ${ts()}] WARN`, ...a);
const err = (...a) => console.error(`[install-tool ${ts()}] ERROR`, ...a);

function loadTools() {
  if (!existsSync(CONFIG)) { err(`missing config: ${CONFIG}`); process.exit(1); }
  try {
    const cfg = parseJsonc(readFileSync(CONFIG, "utf8")) || {};
    return Array.isArray(cfg.tools) ? cfg.tools : [];
  } catch (e) {
    err(`cannot parse ${CONFIG}: ${e.message}`); process.exit(1);
  }
}

// Expand $HOME (and ${HOME}) in a path string.
function expandHome(p) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return String(p).replace(/\$\{?HOME\}?/g, home);
}

// Does a bare command exist on PATH?
function commandExists(cmd) {
  if (!cmd) return true;
  const r = spawnSync("bash", ["-lc", `command -v ${cmd}`], { encoding: "utf8" });
  return r.status === 0 && (r.stdout || "").trim() !== "";
}

// Run a shell command in a login shell; return {ok, code, out, err, timedOut}.
function shell(cmd, { timeout = TIMEOUT } = {}) {
  const r = spawnSync("bash", ["-lc", cmd], { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
  const timedOut = r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM";
  return {
    ok: r.status === 0,
    code: r.status,
    out: (r.stdout || "").trim(),
    err: (r.stderr || r.error?.message || "").trim(),
    timedOut,
  };
}

// Prepend pathAdd dirs to this process PATH and (on GH Actions) $GITHUB_PATH.
function applyPathAdd(pathAdd = []) {
  for (const raw of pathAdd) {
    const dir = expandHome(raw);
    if (!dir) continue;
    const parts = (process.env.PATH || "").split(delimiter);
    if (!parts.includes(dir)) {
      process.env.PATH = dir + delimiter + process.env.PATH;
      log(`PATH += ${dir}`);
    }
    // Persist for subsequent GitHub Actions steps.
    const ghPath = process.env.GITHUB_PATH;
    if (ghPath && !DRY) {
      try { appendFileSync(ghPath, dir + "\n"); } catch {}
    }
  }
}

// Verify a tool: apply pathAdd first, then run its verify command.
function verifyTool(tool) {
  applyPathAdd(tool.pathAdd);
  if (!tool.verify) return true; // nothing to verify → assume ok
  if (DRY) { log(`[DRY RUN] verify: ${tool.verify}`); return false; }
  const r = shell(tool.verify, { timeout: 30000 });
  if (r.ok) log(`verify OK: ${tool.verify}${r.out ? ` → ${r.out.split("\n")[0]}` : ""}`);
  return r.ok;
}
function linkTool(tool) {
  if (!tool.linkTo || DRY) return;
  const found = shell(`command -v ${tool.name}`, { timeout: 30000 });
  if (!found.ok || !found.out) return;
  const target = found.out.split("\n")[0];
  const link = expandHome(tool.linkTo);
  const r = shell(`sudo -n ln -sfn ${JSON.stringify(target)} ${JSON.stringify(link)}`, { timeout: 30000 });
  if (r.ok) log(`linked ${tool.name}: ${link} -> ${target}`);
  else warn(`cannot link ${tool.name} to ${link}: ${r.err || `exit ${r.code}`}`);
}

function installTool(tool) {
  log(`==> tool "${tool.name}"`);

  if (SKIP_IF_PRESENT && verifyTool(tool)) {
    linkTool(tool);
    log(`already present, skip (use --force to reinstall) → ${tool.name}`);
    return { name: tool.name, ok: true, method: "present" };
  }

  const methods = Array.isArray(tool.methods) ? tool.methods : [];
  if (!methods.length) {
    warn(`no methods configured for ${tool.name}`);
    return { name: tool.name, ok: false, method: null };
  }

  const attempts = [];
  for (const m of methods) {
    if (m.needs && !commandExists(m.needs)) {
      log(`skip method "${m.id}" (missing dependency: ${m.needs})`);
      attempts.push(`${m.id}=skipped(no ${m.needs})`);
      continue;
    }

    // ── type: "download" — binary download with version-based cache ──
    if (m.type === "download") {
      const platform = `${process.platform}-${process.arch}`;
      const urlTemplate = typeof m.url === "object" ? m.url[platform] : m.url;
      if (!urlTemplate) {
        warn(`no download URL for platform ${platform}`);
        attempts.push(`${m.id}=skipped(no URL for ${platform})`);
        continue;
      }

      const version = tool.version || "latest";
      const cacheDir = resolve(ROOT, "scripts/runner-tools/.cache", tool.name, version, platform);
      const binaryPath = resolve(cacheDir, m.binary);

      // Check cache
      if (existsSync(binaryPath)) {
        log(`cached: ${binaryPath}`);
        applyPathAdd([cacheDir]);
        attempts.push(`${m.id}=cached`);
      } else {
        if (DRY) { attempts.push(`${m.id}=dry-run`); continue; }

        const url = urlTemplate.replace(/\$\{version\}/g, version);
        mkdirSync(cacheDir, { recursive: true });
        const tmpDir = resolve(ROOT, "ci-runtime", "tool-downloads");
        mkdirSync(tmpDir, { recursive: true });
        const isZip = url.endsWith(".zip");
        const archiveExt = isZip ? ".zip" : ".tar.gz";
        const archive = resolve(tmpDir, `${tool.name}-${version}${archiveExt}`);

        log(`downloading ${url}`);
        const dl = shell(`curl -fsSL -o ${JSON.stringify(archive)} ${JSON.stringify(url)}`);
        if (!dl.ok) {
          warn(`download failed: ${dl.err}`);
          attempts.push(`${m.id}=fail(download)`);
          continue;
        }

        const extractCmd = isZip
          ? `unzip -o ${JSON.stringify(archive)} -d ${JSON.stringify(cacheDir)}`
          : `tar xzf ${JSON.stringify(archive)} -C ${JSON.stringify(cacheDir)} --strip-components=0`;
        const ext = shell(extractCmd);
        shell(`rm -f ${JSON.stringify(archive)}`);
        if (!ext.ok) {
          warn(`extract failed: ${ext.err}`);
          attempts.push(`${m.id}=fail(extract)`);
          continue;
        }

        log(`installed to ${binaryPath}`);
        applyPathAdd([cacheDir]);
        attempts.push(`${m.id}=ran`);
      }

      if (verifyTool(tool)) {
        linkTool(tool);
        log(`SUCCESS: "${tool.name}" installed via "${m.id}"`);
        return { name: tool.name, ok: true, method: m.id };
      }
      warn(`"${tool.name}" not verified after "${m.id}" → next fallback`);
      continue;
    }

    // ── default: bash -lc method ──
    log(`try method "${m.id}": ${m.run}`);
    if (DRY) { attempts.push(`${m.id}=dry-run`); continue; }

    const r = shell(m.run);
    if (!r.ok) {
      warn(`method "${m.id}" failed (code=${r.code} timedOut=${r.timedOut}): ${r.err.split("\n").slice(-3).join(" | ")}`);
      attempts.push(`${m.id}=fail`);
      // Even on failure, some installers partially succeed → re-verify anyway.
    } else {
      log(`method "${m.id}" completed`);
      attempts.push(`${m.id}=ran`);
    }

    if (verifyTool(tool)) {
      linkTool(tool);
      log(`SUCCESS: "${tool.name}" installed via "${m.id}"`);
      return { name: tool.name, ok: true, method: m.id };
    }
    warn(`"${tool.name}" not verified after "${m.id}" → next fallback`);
  }

  err(`all methods exhausted for "${tool.name}" (attempts: ${attempts.join(", ")})`);
  return { name: tool.name, ok: false, method: null, attempts };
}

// ── main ─────────────────────────────────────────────────────────
const tools = loadTools();
let targets;
if (ALL) {
  targets = tools;
} else if (names.length) {
  targets = names.map((n) => {
    const t = tools.find((x) => x.name === n);
    if (!t) { err(`unknown tool "${n}" (not in tools-config.jsonc)`); process.exit(2); }
    return t;
  });
} else {
  err("no tool specified. Usage: install-tool.mjs <name> [...] | --all");
  log(`available: ${tools.map((t) => t.name).join(", ") || "(none)"}`);
  process.exit(2);
}

const results = targets.map(installTool);
const failed = results.filter((r) => !r.ok);

console.log("");
log("summary:");
for (const r of results) log(`  ${r.ok ? "OK  " : "FAIL"} ${r.name}${r.method ? ` (via ${r.method})` : ""}`);

// In dry-run we never actually install, so a "not verified" outcome is expected —
// don't fail the run; the goal was only to preview which methods would execute.
if (DRY) { log("dry-run complete (no changes made)"); process.exit(0); }

if (failed.length) {
  err(`${failed.length} tool(s) failed: ${failed.map((r) => r.name).join(", ")}`);
  process.exit(1);
}
log("all requested tools ready");
