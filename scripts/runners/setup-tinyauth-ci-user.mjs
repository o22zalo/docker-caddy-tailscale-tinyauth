#!/usr/bin/env node
// scripts/runners/setup-tinyauth-ci-user.mjs
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import bcryptjs from "bcryptjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const ENV = resolve(ROOT, ".env");
const GITHUB_ENV = process.env.GITHUB_ENV;
const username = "ci-bot";
const password = randomBytes(18).toString("base64url");
const hash = bcryptjs.hashSync(password, 10).split("$").join("$$");
const rawEnv = readFileSync(ENV, "utf8");
const current = rawEnv.match(/^TINYAUTH_AUTH_USERS\s*=(.*)$/m)?.[1] || "";
const users = current.split(",").map((user) => user.trim()).filter((user) => user && !user.startsWith(`${username}:`));
const next = [...users, `${username}:${hash}`].join(",");

if (!DRY_RUN) {
  let src = rawEnv.replace(/^TINYAUTH_CI_USER=.*\n?/gm, "").replace(/^TINYAUTH_CI_PASSWORD=.*\n?/gm, "");
  if (/^TINYAUTH_AUTH_USERS\s*=.*$/m.test(src)) {
    src = src.replace(/^TINYAUTH_AUTH_USERS\s*=.*$/m, `TINYAUTH_AUTH_USERS=${next}`);
  } else {
    src += `${src.endsWith("\n") ? "" : "\n"}TINYAUTH_AUTH_USERS=${next}\n`;
  }
  src += `TINYAUTH_CI_USER=${username}\nTINYAUTH_CI_PASSWORD=${password}\n`;
  writeFileSync(ENV, src);
  if (GITHUB_ENV) appendFileSync(GITHUB_ENV, `TINYAUTH_CI_USER=${username}\nTINYAUTH_CI_PASSWORD=${password}\n`);
}

log(`[env] TINYAUTH_CI_USER=${username}`);
log("[env] TINYAUTH_CI_PASSWORD=<hidden>");
log("[env] Added Tinyauth ci-bot user");
