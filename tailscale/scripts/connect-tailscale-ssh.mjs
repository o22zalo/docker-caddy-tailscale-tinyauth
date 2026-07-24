#!/usr/bin/env node
// scripts/runners/connect-tailscale-ssh.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Join the CURRENT CI HOST (GitHub Actions runner or Azure Pipelines agent) to
// the tailnet and enable Tailscale SSH — no SSH password, no private key.
// Authentication for "who can SSH in" is handled entirely by Tailscale ACLs
// (tailscale/acl.hujson → "ssh" block, src/dst tag:ci) once the host carries
// tag:ci.
//
// Does NOT touch the Tailscale sidecar container used elsewhere in this repo
// (tailscale/tailscale.yml) — this joins the bare-metal/VM HOST the job runs
// on, which is what lets you `docker compose logs` / `docker logs <svc>`
// directly once connected, regardless of what later CI steps do.
//
// Flow:
//   1. Install tailscale CLI if missing (official install script).
//   2. Exchange TS_CLIENT_ID/TS_CLIENT_SECRET (OAuth client) for an access
//      token, then mint a short-lived, non-reusable, pre-authorized authkey
//      scoped to tag:ci.
//   3. `tailscale up --ssh --authkey=<...> --hostname=<unique>` — no key/pass
//      needed for SSH itself; the authkey step above only proves this HOST
//      is allowed to join, not who may later connect to it.
//
// Env (required):
//   TS_CLIENT_ID       OAuth client ID      (Tailscale admin → OAuth clients)
//   TS_CLIENT_SECRET   OAuth client secret
//
// Env (optional):
//   TS_TAGS            default: tag:ci
//   TS_HOSTNAME        default: auto (gh-<run_id>-<attempt> / az-<build_id>-<attempt>)
//   TS_EXPIRY_SECONDS  authkey TTL, default: 3600
//   TS_EXTRA_ARGS      extra flags appended to `tailscale up` (space-separated)
//
// Usage:
//   node scripts/runners/connect-tailscale-ssh.mjs
//   node scripts/runners/connect-tailscale-ssh.mjs --dry-run
//   node scripts/runners/connect-tailscale-ssh.mjs --logout   # tear down at end of job
//
// Flags:
//   --dry-run   Show what would run — no install, no API calls, no `tailscale up`
//   --silent    Suppress stdout (errors still print to stderr)
//   --logout    Run `tailscale logout` and exit (use as an always() cleanup step)
import { execSync, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const LOGOUT = args.includes("--logout");
const log = (...a) => {
  if (!SILENT) console.log(...a);
};
const err = (...a) => console.error(...a);

const API = "https://api.tailscale.com/api/v2";

function sh(cmd, { input, allowFail = false } = {}) {
  log(`$ ${cmd.replace(/(client_secret|authkey|Authorization: Bearer)[^&\s]*/gi, "$1=<hidden>")}`);
  if (DRY_RUN) return "";
  const res = spawnSync(cmd, { shell: true, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const out = (res.stdout || "").trim();
  if (res.status !== 0 && !allowFail) {
    err(res.stderr || out || `command failed: ${cmd}`);
    process.exit(res.status || 1);
  }
  return out;
}

function detectCiIdentity() {
  if (process.env.GITHUB_ACTIONS === "true") {
    return `gh-${process.env.GITHUB_RUN_ID || "local"}-${process.env.GITHUB_RUN_ATTEMPT || "1"}`;
  }
  if (process.env.TF_BUILD === "True" || process.env.BUILD_BUILDID) {
    return `az-${process.env.BUILD_BUILDID || "local"}-${process.env.SYSTEM_JOBATTEMPT || "1"}`;
  }
  return `local-${process.pid}`;
}

function sanitizeHostname(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

async function main() {
  if (LOGOUT) {
    log("Logging out of tailnet...");
    sh("sudo tailscale logout", { allowFail: true });
    log("Done.");
    return;
  }

  const CLIENT_ID = process.env.TS_CLIENT_ID || "";
  const CLIENT_SECRET = process.env.TS_CLIENT_SECRET || "";
  const TAGS = process.env.TS_TAGS || "tag:ci";
  const HOSTNAME = sanitizeHostname(process.env.TS_HOSTNAME || `proxy-stack-${detectCiIdentity()}`);
  const EXPIRY_SECONDS = Number(process.env.TS_EXPIRY_SECONDS || 3600);
  const EXTRA_ARGS = process.env.TS_EXTRA_ARGS || "";

  if (!CLIENT_ID || !CLIENT_SECRET) {
    err("ERROR: TS_CLIENT_ID and TS_CLIENT_SECRET are required.");
    process.exit(1);
  }

  log(`=== Tailscale SSH connect ===`);
  log(`hostname : ${HOSTNAME}`);
  log(`tags     : ${TAGS}`);
  log(`expiry   : ${EXPIRY_SECONDS}s`);

  // 1. Install tailscale CLI if missing.
  const has = spawnSync("sh", ["-lc", "command -v tailscale"], { encoding: "utf8" });
  if (has.status !== 0) {
    log("tailscale CLI not found — installing...");
    sh("curl -fsSL https://tailscale.com/install.sh | sh");
  } else {
    log(`tailscale CLI found: ${has.stdout.trim()}`);
  }

  if (DRY_RUN) {
    log("[DRY RUN] Would exchange OAuth client for access token, mint authkey, then:");
    log(`[DRY RUN] sudo tailscale up --authkey=<hidden> --hostname=${HOSTNAME} --advertise-tags=${TAGS} --ssh --accept-dns=false ${EXTRA_ARGS}`);
    return;
  }

  // 2a. OAuth client_credentials -> access token.
  log("Exchanging OAuth client credentials for access token...");
  const tokenRes = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson.access_token) {
    err(`ERROR: OAuth token exchange failed: HTTP ${tokenRes.status} ${JSON.stringify(tokenJson)}`);
    process.exit(1);
  }
  const accessToken = tokenJson.access_token;
  log("Access token obtained.");

  // 2b. Mint a short-lived, non-reusable, pre-authorized authkey scoped to TAGS.
  log("Minting ephemeral authkey...");
  const tagList = TAGS.split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const keyRes = await fetch(`${API}/tailnet/-/keys`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      capabilities: {
        devices: {
          create: {
            reusable: false,
            ephemeral: true,
            preauthorized: true,
            tags: tagList,
          },
        },
      },
      expirySeconds: EXPIRY_SECONDS,
    }),
  });
  const keyJson = await keyRes.json().catch(() => ({}));
  if (!keyRes.ok || !keyJson.key) {
    err(`ERROR: authkey creation failed: HTTP ${keyRes.status} ${JSON.stringify(keyJson)}`);
    process.exit(1);
  }
  log("Authkey minted (ephemeral, pre-authorized, non-reusable).");

  // 3. Join tailnet + enable Tailscale SSH.
  log("Joining tailnet and enabling Tailscale SSH...");
  const upCmd = [
    "sudo tailscale up",
    `--authkey=${keyJson.key}`,
    `--hostname=${HOSTNAME}`,
    `--advertise-tags=${TAGS}`,
    "--ssh",
    "--accept-dns=false",
    EXTRA_ARGS,
  ]
    .filter(Boolean)
    .join(" ");
  sh(upCmd);

  log("");
  log(`Connected. From any device already on the tailnet with tag ${TAGS} allowed by ACL:`);
  log(`  tailscale ssh ${HOSTNAME}`);
  log(`Then, on the host:`);
  log(`  docker compose logs -f --tail=100`);
  log(`  docker logs <container> --tail 100`);
}

main().catch((e) => {
  err(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
