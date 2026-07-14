#!/usr/bin/env node
// tinyauth/scripts/generate-user.mjs
// Generate bcrypt hash for TINYAUTH_AUTH_USERS — no Docker required.
import { createInterface } from "node:readline";

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (ans) => { rl.close(); res(ans); }));
}

async function askSecret(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    process.stdout.write(question);
    let pw = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (ch) => {
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        rl.close();
        console.log();
        res(pw);
      } else if (ch === "\u0003") {
        process.exit(130);
      } else if (ch === "\u007f" || ch === "\b") {
        if (pw.length > 0) { pw = pw.slice(0, -1); process.stdout.write("\b \b"); }
      } else {
        pw += ch;
        process.stdout.write("*");
      }
    });
  });
}

async function hashBcrypt(pw) {
  // Try bcryptjs (pure JS, no native build)
  try {
    const { default: bcryptjs } = await import("bcryptjs");
    return bcryptjs.hashSync(pw, 10);
  } catch {}
  // Fallback: openssl
  try {
    const { execSync } = await import("node:child_process");
    return execSync(`openssl passwd -6 ${JSON.stringify(pw)}`).toString().trim();
  } catch {}
  return null;
}

console.log("=== Tinyauth user generator ===\n");

const user = await ask("Username: ");
if (!user) { console.error("ERROR: username cannot be empty"); process.exit(1); }

const pass = await askSecret("Password: ");
if (!pass) { console.error("ERROR: password cannot be empty"); process.exit(1); }

const hash = await hashBcrypt(pass);
if (!hash) {
  console.error("ERROR: no hash tool available. Install bcryptjs: npm install");
  process.exit(1);
}

const composeHash = hash.replace(/\$/g, "$$$$");

console.log(`
=== Result ===

Add to .env:
  TINYAUTH_AUTH_USERS=${user}:${composeHash}

Raw (for non-Compose use):
  ${user}:${hash}

If the hash contains $ characters, double them ($$) in .env
so Docker Compose keeps a single $ in the container.
`);
