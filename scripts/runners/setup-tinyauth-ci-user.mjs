#!/usr/bin/env node
// scripts/runners/setup-tinyauth-ci-user.mjs
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import bcryptjs from "bcryptjs";

import { maskCiSecret, exportCiVar } from "../lib/env-utils.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const ENV = resolve(ROOT, ".env");
const username = "ci-bot";
const password = randomBytes(18).toString("base64url");
// Each real "$" in the bcrypt hash must survive TWO rounds of docker-compose
// variable interpolation (once when Compose parses .env itself, once when the
// compose file substitutes ${TINYAUTH_AUTH_USERS} into the container env).
// Each round collapses a "$$" pair into a single "$". To end up with exactly
// one "$" after two rounds you need 4 -> 2 -> 1, i.e. store 4 literal "$"
// characters per original "$". NOTE: this is a plain string join, not a regex
// replace, so there is no "$$" => "$" shorthand here — the string you pass is
// exactly what ends up in the file.
const escapeHash = (value) => value.replace(/\$+/g, "$").split("$").join("$$$$");
const hash = escapeHash(bcryptjs.hashSync(password, 10));
const rawEnv = readFileSync(ENV, "utf8");
const current = rawEnv.match(/^TINYAUTH_AUTH_USERS\s*=(.*)$/m)?.[1] || "";
const users = current.split(",")
  .map((user) => user.trim())
  .filter((user) => user && !user.startsWith(`${username}:`))
  .map((entry) => {
    const i = entry.indexOf(":");
    if (i === -1) return entry;
    return `${entry.slice(0, i)}:${escapeHash(entry.slice(i + 1))}`;
  });
const next = [...users, `${username}:${hash}`].join(",");

function authSummary(label, value) {
  const names = value.split(",").map((entry) => entry.split(":")[0]).filter(Boolean).join(",");
  const sample = value.replace(/:[^,]+/g, ":<hash>").slice(0, 120);
  const dollarRuns = [...value.matchAll(/\$+/g)].map((m) => m[0].length);
  log(`[env] ${label} length=${value.length} users=${names || "(none)"}`);
  log(`[env] ${label} sample=${sample}`);
  log(`[env] ${label} dollar_runs=${dollarRuns.join(",") || "0"}`);
}

authSummary("TINYAUTH_AUTH_USERS before", current);

if (!DRY_RUN) {
  let src = rawEnv.replace(/^TINYAUTH_CI_USER=.*\n?/gm, "").replace(/^TINYAUTH_CI_PASSWORD=.*\n?/gm, "");
  if (/^TINYAUTH_AUTH_USERS\s*=.*$/m.test(src)) {
    src = src.replace(/^TINYAUTH_AUTH_USERS\s*=.*$/m, `TINYAUTH_AUTH_USERS=${next}`);
  } else {
    src += `${src.endsWith("\n") ? "" : "\n"}TINYAUTH_AUTH_USERS=${next}\n`;
  }
  src += `TINYAUTH_CI_USER=${username}\nTINYAUTH_CI_PASSWORD=${password}\n`;
  writeFileSync(ENV, src);
  maskCiSecret(password);
  exportCiVar("TINYAUTH_CI_USER", username);
}

authSummary("TINYAUTH_AUTH_USERS after", next);
log(`[env] TINYAUTH_CI_USER=${username}`);
log("[env] TINYAUTH_CI_PASSWORD=<hidden>");
log("[env] Added Tinyauth ci-bot user");
