# AGENTS.md — project conventions for humans and coding agents

This repository is a **modular Docker reverse-proxy stack**: Cloudflare Tunnel, Tailscale, Caddy, Tinyauth, plus a demo app (whoami). Follow these rules when changing anything.

## Goal

- Run as a single Compose project that is **reachable from the outside** (Cloudflare Tunnel).
- Configuration is **env-driven** (one `.env` file).
- CI proves the stack starts and is externally accessible.
- Success criteria: containers run **and** a public URL responds (HTTP 200 / 3xx / 401).

## Directory layout (mandatory)

```
<service>/
  <service>.yml          # Compose fragment for that service only
  scripts/               # Scripts that only concern this service (optional)
  …                      # Other service-local assets (e.g. tailscale/serve.json)

scripts/                 # ONLY stack-wide scripts (up, wait-and-test, …)
networks/networks.yml    # Shared Docker network
docker-compose.yml       # Root join via Compose `include`
docker-compose.ci.yml    # CI / quick-tunnel overrides
.env.example             # Root minimal env (what Compose actually loads)
.env.ci                  # CI fallback when GitHub secret is missing
<service>/.env.example   # Full catalog of that service’s env + docs links
.github/workflows/       # CI
AGENTS.md                # This file
README.md                # Human-facing docs
```

### Service folders today

| Directory     | Compose file     | Env catalog               | Notes                         |
| ------------- | ---------------- | ------------------------- | ----------------------------- |
| `networks/`   | `networks.yml`   | `networks/.env.example`   | Shared `proxy` network        |
| `caddy/`      | `caddy.yml`      | `caddy/.env.example`      | Reverse proxy                 |
| `litestream/` | `litestream.yml` | `litestream/.env.example` | SQLite restore/replication    |
| `rclone/`     | `rclone.yml`     | `rclone/.env.example`     | File/folder remote sync       |
| `tinyauth/`   | `tinyauth.yml`   | `tinyauth/.env.example`   | Forward-auth login            |
| `whoami/`     | `whoami.yml`     | `whoami/.env.example`     | Demo upstream                 |
| `dozzle/`     | `dozzle.yml`     | `dozzle/.env.example`     | Protected Docker logs         |
| `filebrowser/`| `filebrowser.yml`| `filebrowser/.env.example`| Protected repo file browser   |
| `webssh/`     | `webssh.yml`     | `webssh/.env.example`     | Protected ttyd/tmux terminal  |
| `cloudflare/` | `cloudflare.yml` | `cloudflare/.env.example` | cloudflared public edge       |
| `tailscale/`  | `tailscale.yml`  | `tailscale/.env.example`  | Profiles: `tailscale`, `full` |
| `orchestrator/`| `orchestrator.yml`| `orchestrator/.env.example`| RTDB leader/handoff sidecar   |
| `nodesync/`   | `nodesync.yml`   | `nodesync/.env.example`   | Dynamic SSH sync controller  |

### Naming rules

1. **One directory per service.**
2. **Compose file name = service name:** `cloudflare/cloudflare.yml`, not `docker-compose.yml` inside the service dir.
3. **Root** keeps `docker-compose.yml` (join) and `docker-compose.ci.yml` (overrides).
4. **Do not** put service-specific scripts under root `scripts/`.
5. **Do** put shared/orchestration scripts under root `scripts/`.
6. **Every Compose YAML** starts with a comment header: purpose in this project, official doc links, env/example config (see existing files).
7. **Every service directory** has `.env.example` documenting **all** supported env vars for that service (or stack knobs for it): purpose, how to obtain values, links, and full meaning of enum/choice values. Root `.env.example` stays the **minimal** set wired by compose; full catalogs live under `<service>/.env.example`.

## Scripts placement

| Kind         | Location                | Examples                                                                                                                                                                                      |
| ------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service-only | `<service>/scripts/*`   | `tinyauth/scripts/generate-user.mjs`, `cloudflare/scripts/provision-tunnel.mjs`, `cloudflare/scripts/extract-tunnel-url.mjs`, `tailscale/scripts/init.mjs`, `tailscale/scripts/status.mjs`, `caddy/scripts/dump-config.mjs` |
| Stack-wide   | `scripts/*.mjs`         | `scripts/up.mjs`, `scripts/wait-and-test.mjs`                                                                                                                                                 |
| CI / runner  | `scripts/runners/*.mjs` | `scripts/runners/setup-env.mjs`, `scripts/runners/start-stack.mjs`, `scripts/runners/collect-logs.mjs`, `scripts/runners/cache-docker-build-github.mjs`                                       |

Rules:

- New helper for a single service → that service's `scripts/`.
- Script that starts/tests/tears down the **whole stack** → root `scripts/`.
- Script that runs **only in CI / GitHub Actions runner** → `scripts/runners/`.
- Stack scripts may **call** service scripts (e.g. `wait-and-test.mjs` → `cloudflare/scripts/extract-tunnel-url.mjs`).
- Prefer `#!/usr/bin/env node`, `set -euo pipefail` equivalent (process.exit on error), and resolve repo root relative to the script path.
- Keep scripts executable in CI (`chmod +x` on `scripts` and `*/scripts`).

### Inline code in YAML — prefer scripts

**Do not** put multi-step or branching logic inline in Compose YAML or GitHub Actions workflow YAML. Extract to a script file instead.

| Where                    | Rule                                                | Why                                                                                                |
| ------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| CI workflow (`test.yml`) | ≥ 5 lines of bash → move to `scripts/runners/*.mjs` | Testable, reviewable, reusable                                                                     |
| Compose YAML             | No inline shell; use labels/env/scripts             | Compose is declarative; logic belongs in scripts                                                   |
| Script language          | `.mjs` (Node.js ES module) for all scripts          | GitHub Actions runners + local dev have Node.js; `.mjs` is cross-platform, testable, no extra deps |

Exceptions (OK to keep inline):

- ≤ 4 lines of trivial shell (e.g. `echo`, `cat`, single `docker compose` call).
- GitHub Actions expressions (`${{ ... }}`) — these are YAML, not shell.

### Script flags — `--dry-run` and `--silent`

Every `.mjs` script must support these flags:

| Flag        | Meaning                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `--dry-run` | Show what would be done — no API calls, no file writes, no docker commands |
| `--silent`  | Suppress console output (errors still print to stderr)                     |

Rules:

- Parse flags from `process.argv.slice(2)` at the top of the script.
- Use `const log = (...a) => { if (!SILENT) console.log(...a); }` for output.
- Guard all side effects (file writes, API calls, docker commands) with `if (DRY_RUN) { log("[DRY RUN] ..."); return; }`.
- `--dry-run` implies no writes to `.env`, `GITHUB_ENV`, or any file.
- `--silent` suppresses stdout only; `console.error` always prints.

### Syntax check — bắt buộc sau khi viết/sửa `.mjs`/`.js`

Sau khi viết hoặc sửa bất kỳ file `.mjs`/`.js` nào, **PHẢI** chạy `node --check <file>` trước khi coi task là done. Nếu lỗi thì tự sửa và check lại, tối đa 3 lần.

### Script config — extract hardcoded values to `.jsonc`

**Do not** hardcode lists, paths, or config values inside `.mjs` scripts. Extract to a `.jsonc` file in the same directory.

| Where                                  | Rule                                                            | Why                                         |
| -------------------------------------- | --------------------------------------------------------------- | ------------------------------------------- |
| Runners (`scripts/runners/`)           | Config → `<name>-config.jsonc` in same dir                      | Centralized, editable without touching code |
| Service scripts (`<service>/scripts/`) | Config → `<name>.jsonc` in same dir                             | Same                                        |
| Fallback                               | Script must work if config file missing — use sensible defaults | Backward compatible                         |

Example:

```
scripts/runners/
  cache-docker-build-github.mjs
  cache-config.jsonc             ← compose_yamls list
  collect-logs.mjs
  collect-logs-config.jsonc      ← known_services list
```

Config loading pattern:

```js
import { parse } from "jsonc-parser";

const CONFIG_FILE = resolve(__dirname, "my-config.jsonc");
function loadConfig() {
  const defaults = { key: ["value1", "value2"] };
  if (!existsSync(CONFIG_FILE)) return defaults;
  return { ...defaults, ...parse(readFileSync(CONFIG_FILE, "utf8")) };
}
const config = loadConfig();
```

## Compose rules

1. Root `docker-compose.yml` uses **`include`** to pull every service YAML.
2. All app services attach to the shared network **`proxy`**.
3. Prefer **labels** on services for Caddy routing (caddy-docker-proxy).
4. Origin protocol is **HTTP**; TLS is terminated at Cloudflare Tunnel and/or Tailscale Serve.
5. Tinyauth protects apps via Caddy snippet `tinyauth_forwarder` + `caddy.import: tinyauth_forwarder *`; whoami is public by default and only uses forward-auth when `WHOAMI_TINYAUTH_ENABLED=true`.
6. **Every service is profile-gated.** Use `COMPOSE_PROFILES` in root `.env` (Compose reads it automatically).
7. CI overrides go in `docker-compose.ci.yml` (quick tunnel, catch-all `:80`, `labels: !override` where needed).
8. Requires Docker Compose **v2.24+** (`include`, `!override`).

### Shared network name

`networks/networks.yml` intentionally sets the Docker network name to global
`proxy` instead of the Compose-scoped default (`<project>_proxy`). This keeps
`CADDY_INGRESS_NETWORKS=proxy` stable for caddy-docker-proxy and lets service
fragments resolve the same network name in include and multi-file modes.

Tradeoff: two Compose projects on the same Docker host that both use a network
named `proxy` can share that bridge network. This is expected behavior here, not
a bug. Do not run untrusted stacks with the same `proxy` network name on the same
host. If isolation matters more than the stable name, change the network name and
update `CADDY_INGRESS_NETWORKS`, docs, examples, and any external service that
joins `proxy`.

### Profiles — principles (enable / disable services)

**Docs:** https://docs.docker.com/compose/how-tos/profiles/

#### Rules agents must follow

1. **Every app service is profile-gated.** No app service may run with an empty `profiles:` list. (`networks/` is infrastructure only — no service profile.)
2. **Each service has its own named profile** equal to the service/folder intent:
   - `caddy`, `litestream`, `rclone`, `tinyauth`, `whoami`, `cloudflare`, `tailscale`, `dozzle`, `filebrowser`, `webssh`, `orchestrator`
3. **Group profiles (OR membership):**
   - `core` — public path: caddy + tinyauth + whoami + cloudflare + orchestrator
   - `full` — everything: core members **plus** tailscale and admin tools
4. **Tailscale is never required for `core`.** Only on `tailscale` and/or `full`.
5. **Semantics = OR:** a service starts if **any one** of its listed profiles is active.
6. **Activation source of truth:** root `.env` → `COMPOSE_PROFILES=...` (Compose loads automatically). CLI `--profile X` can add profiles for one invocation.
   - Helpers auto-add `litestream` when `LITESTREAM_<index>_SERVICE` exists.
   - Helpers auto-add `rclone` when `RCLONE_<index>_NAME` exists.
   - Plain `docker compose up` cannot infer these fallback profiles; prefer `node scripts/up.mjs`.
7. **Defaults:**
   - Root `.env.example` and `.env.ci`: `COMPOSE_PROFILES=core`
   - If `COMPOSE_PROFILES` is unset/empty → **no** profiled services start
8. **Dependencies:** if a service `depends_on` another (e.g. cloudflared → caddy), both must be enabled (use `core`/`full`, or list both individual profiles).
9. **CI:** workflow must ensure `COMPOSE_PROFILES` is set (at least `core`) before `docker compose up`; may append `tailscale` when `TS_AUTHKEY` is present.
10. **New service checklist for profiles:**
    - Add `profiles: [<own-name>, core?, full?]`
    - Put on `core` only if part of the default public stack
    - Put on `full` if it should start with the “everything” preset
    - Document in this section + root `.env.example` + service `.env.example` + README

#### Profile map

| Profile      | Enables                                              |
| ------------ | ---------------------------------------------------- |
| `caddy`      | Caddy only                                           |
| `litestream` | Litestream only                                      |
| `rclone`     | Rclone only                                          |
| `tinyauth`   | Tinyauth only                                        |
| `whoami`     | Whoami only                                          |
| `cloudflare` | cloudflared only                                     |
| `tailscale`  | Tailscale only                                       |
| `dozzle`     | Dozzle only                                          |
| `filebrowser`| Filebrowser only                                     |
| `webssh`     | WebSSH/ttyd only                                     |
| `orchestrator`| Orchestrator sidecar only                           |
| `nodesync`   | Dynamic SSH sync controller only                    |
| `core`       | caddy + tinyauth + whoami + cloudflare + orchestrator (public path) |
| `full`       | core + tailscale + dozzle + filebrowser + webssh + nodesync |

| Service       | Profiles on the service      |
| ------------- | ---------------------------- |
| `caddy`       | `caddy`, `core`, `full`      |
| `litestream`  | `litestream`                 |
| `rclone`      | `rclone`                     |
| `tinyauth`    | `tinyauth`, `core`, `full`   |
| `whoami`      | `whoami`, `core`, `full`     |
| `cloudflared` | `cloudflare`, `core`, `full` |
| `tailscale`   | `tailscale`, `full`          |
| `dozzle`      | `dozzle`, `full`             |
| `filebrowser` | `filebrowser`, `full`        |
| `webssh`      | `webssh`, `full`             |
| `orchestrator`| `orchestrator`, `core`, `full` |
| `nodesync`    | `nodesync`, `full`           |

```bash
# .env (recommended default)
COMPOSE_PROFILES=core   # helpers auto-add litestream/rclone if configured

# one-shot
COMPOSE_PROFILES=full docker compose up -d
COMPOSE_PROFILES=caddy,whoami docker compose up -d
docker compose --profile tailscale up -d   # CLI adds a profile to the active set

# helpers
make up-core
make up-full
make profiles
./scripts/up.mjs full
```

### Multi-file without include (must stay valid)

```bash
docker compose \
  -f networks/networks.yml \
  -f caddy/caddy.yml \
  -f litestream/litestream.yml \
  -f rclone/rclone.yml \
  -f tinyauth/tinyauth.yml \
  -f whoami/whoami.yml \
  -f dozzle/dozzle.yml \
  -f filebrowser/filebrowser.yml \
  -f webssh/webssh.yml \
  -f cloudflare/cloudflare.yml \
  -f tailscale/tailscale.yml \
  -f orchestrator/orchestrator.yml \
  -f nodesync/nodesync.yml \
  up -d
```

When adding a service, update **both** root `include` and this documented multi-file list (README + this file).

## Environment and secrets

1. **Single source of config:** root `.env` (never commit real secrets).
2. **GitHub:** one repository secret named **`ENV_FILE`** whose value is the **entire** `.env` file content.
3. Workflow writes `secrets.ENV_FILE` → `.env` before `docker compose up`.
4. If `ENV_FILE` is missing → use `.env.ci` + quick tunnel so CI still proves external access.
5. Document every variable in `.env.example`.
6. bcrypt / `$` in Compose: use **`$$`** in `.env` / compose so containers receive a single `$`.

### Volume roots

1. Use root `.env` variables for bind-mount roots:
   - `DOCKER_VOLUME_RUNTIME` defaults to `./ci-runtime` and stores generated runtime files for all services (service state, generated config, logs, tmux/Tailscale/Caddy runtime files).
   - `DOCKER_VOLUME_DATA` defaults to `./ci-data` and stores app data for current/future app services.
2. Do not add new named volumes for service runtime/data. Compose service files use internal roots `${DOCKER_VOLUME_RUNTIME_ABS:-../ci-runtime}` and `${DOCKER_VOLUME_DATA_ABS:-../ci-data}` so included service YAML resolves to the repo root; startup helpers derive these from root `.env` `DOCKER_VOLUME_RUNTIME` / `DOCKER_VOLUME_DATA`.
3. Keep repo/source mounts explicit (for example `..:/srv`) and keep config-file mounts service-local (for example `./serve.json:/config/serve.json:ro`).

### Litestream data sync

1. Any service data managed by Litestream must live under `${DOCKER_VOLUME_DATA:-./ci-data}/litestream/<service>/`.
2. Litestream env is indexed only: `LITESTREAM_<index>_SERVICE`, `LITESTREAM_<index>_PATH`, `LITESTREAM_<index>_URL` (or `BUCKET` + `KEY`), plus optional S3 fields like `ENDPOINT`, `REGION`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `FORCE_PATH_STYLE`.
3. Add a new synced service by adding the next index block; do not hardcode service names into scripts.
4. Startup must run `litestream/scripts/generate-config.mjs` then `litestream/scripts/restore.mjs` before app containers start. Helpers auto-enable the `litestream` profile when any `LITESTREAM_<index>_SERVICE` block exists. Missing remote backups are not fatal; credential/network errors are fatal.
5. Litestream-managed app paths inside containers should match `/data/<service>/<file>.db`.

### Rclone data sync

1. Any service data managed by Rclone should live under `${DOCKER_VOLUME_DATA:-./ci-data}/rclone/<name>/`.
2. Rclone env is indexed only: `RCLONE_<index>_NAME`, `RCLONE_<index>_TYPE` (`file` or `dir`), `RCLONE_<index>_LOCAL`, `RCLONE_<index>_REMOTE`, optional `INTERVAL`, `DIRECTION`, `CONFIG_RAW`, `CONFIG_BASE64`.
3. `RCLONE_<index>_NAME` drives the job label and container name for the first configured block: `rclone-<index>-<name>`.
4. Startup must run `rclone/scripts/pull.mjs` before app containers start. Helpers auto-enable the `rclone` profile when any `RCLONE_<index>_NAME` block exists.
5. Runtime sync is handled by the `rclone` container; jobs run concurrently and push local changes on each job interval.
6. Prefer `CONFIG_BASE64` for GitHub `ENV_FILE`; use `CONFIG_RAW` only when multiline secret handling is known-good.
7. Rclone image cache is covered by `scripts/runners/cache-config.jsonc`; keep `rclone/rclone.yml` and `rclone/Dockerfile` listed there when changing the image.

### Env injection rules (both prod and CI — do not regress)

These rules apply to **full named-tunnel config** and **quick-tunnel CI** alike.

1. **Never inject empty optional env via Compose `environment:`**  
   Patterns like `FOO: ${FOO:-}` put `FOO=""` into the container. Many apps treat “set but empty” differently from “unset” (Tinyauth v5: `TINYAUTH_SERVER_SOCKETPATH=""`, empty OAuth client IDs; caddy-docker-proxy: empty `CADDY_DOCKER_*` paths).
   - **Required / stack defaults** with non-empty defaults → OK in `environment:`.
   - **Optional knobs** → only in root `.env` when the user actually needs them; arrive via `env_file`.
   - In catalogs (`<service>/.env.example`), keep unused optionals **commented out**, not `KEY=`.

2. **Do not paste the full catalog into root `.env` with blank values.**  
   `env_file` loads every `KEY=` line. Prefer root `.env.example` (minimal) and copy **only** keys you set.

3. **Tinyauth-only keys for the process** must be documented `TINYAUTH_*`. Hostnames for Caddy labels use `TINYAUTH_HOST` / `CADDY_TINYAUTH_HOST` / `WHOAMI_HOST` — never invent process env for labels.

### .env parsing — use dotenv, not regex

Every `.mjs` script that reads values from `.env` **must** use `dotenv.parse()` (via the shared `scripts/lib/env-utils.mjs` helper). Do **not** hand-roll regex like `/^KEY=(.+)$/m`.

**Why:** regex does NOT strip inline `# comment` suffixes from unquoted values. Example:

```
CF_API_KEY=abcd1234  # my key
```

- `dotenv.parse` → `"abcd1234"` (correct)
- regex → `"abcd1234  # my key"` (wrong — causes Cloudflare 6003/6103)

`dotenv.parse` also handles quoted values, escape sequences, multi-line values, and empty lines per the standard `.env` spec that Docker Compose, dotenv-cli, and other tools follow.

**Usage:**

```js
import { parseEnv, envGet, envHasKey, envKeys } from "./lib/env-utils.mjs";   // from scripts/
import { parseEnv, envGet, envHasKey, envKeys } from "../../scripts/lib/env-utils.mjs"; // from service scripts/
```

- `parseEnv(filePath)` → `{ KEY: "value", ... }`
- `envGet(filePath, key)` → `"value"` or `""`
- `envHasKey(filePath, key)` → `true` / `false`
- `envKeys(filePath)` → `["KEY1", "KEY2", ...]`

### Tinyauth v5 (strict)

- Only **documented** `TINYAUTH_*` keys (see https://tinyauth.app/docs/reference/configuration/).
- Unknown `TINYAUTH_*` keys make the process **refuse to start**.
- Empty optional `TINYAUTH_*` (especially `TINYAUTH_SERVER_SOCKETPATH`, OAuth provider IDs) can also break bootstrap — omit the key entirely if unused.
- Common keys: `TINYAUTH_APPURL`, `TINYAUTH_AUTH_USERS`, `TINYAUTH_AUTH_SECURECOOKIE`, `TINYAUTH_LOG_LEVEL`, `TINYAUTH_DATABASE_PATH`, `TINYAUTH_ANALYTICS_ENABLED`.
- Do **not** invent `TINYAUTH_SECRET` / old v3 names.
- Prod: `TINYAUTH_APPURL` must be the **public** `https://auth.<domain>` (cookie + redirects). CI quick mode may use `http://tinyauth.internal` only because whoami auth is stripped.

### Cloudflare

- **Named tunnel (prod / full ENV_FILE):** `CF_TUNNEL_TOKEN` + dashboard Public Hostname → `http://caddy:80` for **auth** and **whoami** hosts. Compose: `tunnel run` (no `docker-compose.ci.yml`).
- **Quick tunnel (no token / no secret):** `docker-compose.ci.yml` → `tunnel --url http://caddy:80`, prefer **HTTP/2** + IPv4 on GitHub runners; whoami becomes catch-all `:80` **without** `tinyauth_forwarder`.
- Service container name / compose service: `cloudflared`.

### Named vs quick — what breaks where

| Issue                               | Full config (named + auth)                            | Quick CI (no config)                                          |
| ----------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| Empty optional env in YAML / `.env` | **Yes** — Tinyauth/Caddy can fail to start            | **Yes**                                                       |
| `curl -L` following auth redirect   | Risky if `APPURL` wrong; OK if public `https://auth…` | **Fails** if forward-auth still on (redirect → internal host) |
| Missing `CF_TUNNEL_TOKEN`              | cloudflared crash-loops (`tunnel run`)                | Expected — use CI override                                    |
| Whoami protected by Tinyauth        | Off by default; set `WHOAMI_TINYAUTH_ENABLED=true` for **302/401** auth flow | Off (CI `labels: !override`)                |
| QUIC on GHA                         | Rare flake with `protocol=auto`                       | Common — force `http2` in CI                                  |

Full config is **not** immune to empty-env / probe bugs; only the trycloudflare-specific pieces are CI-only.

### Tailscale

- Profiles: `tailscale` and `full` only (not `core`).
- Userspace preferred (`TS_USERSPACE=true`) for portability.
- Serve config: `tailscale/serve.json` → proxy to `http://caddy:80`.

## CI requirements

Workflow: `.github/workflows/test.yml`.

Must:

1. Materialize `.env` from `ENV_FILE` or `.env.ci`.
2. Detect mode: `CF_TUNNEL_TOKEN` non-empty → **named** (plain compose); else **quick** (`docker-compose.ci.yml`).
3. Start stack; fail fast if `cloudflared` is not running.
4. Run `scripts/wait-and-test.mjs`:
   - require `caddy`, `whoami`, `cloudflared` running;
   - named: `PUBLIC_URL` from `WHOAMI_HOST` / `DOMAIN` (https);
   - quick: extract `https://*.trycloudflare.com` from logs;
   - **do not** `curl -L` (no redirect follow) — first hop 200/3xx/401/403 is enough to prove the edge;
   - accept HTTP **200, 301, 302, 307, 401, 403**.
5. Collect **per-service logs** into `ci-logs/` and upload as a GitHub Actions artifact (always, before tear down).
6. Also dump recent logs to the job console on failure; tear down always.
7. Never print secret values (only env **keys**).

**Full ENV_FILE checklist for named CI:** `COMPOSE_PROFILES` includes `core` (or equivalent), non-empty `CF_TUNNEL_TOKEN`, public hostnames on the tunnel, `WHOAMI_HOST` (or `DOMAIN`), valid `TINYAUTH_*` (public `APPURL`, users, secure cookie as needed).

### Log artifact layout (CI)

```
ci-logs/
  MANIFEST.txt
  compose-ps.txt
  compose-config.yml
  all-services.log
  public-url.txt          # if present
  services/<service>.log
  services/<service>.docker-logs.log
  inspect/<service>.json
```

Artifact name pattern: `stack-logs-<run_id>-<run_attempt>` (retention 14 days).

Security rule: CI artifacts and AI-analysis prompts must never contain raw secrets from `.env`, `docker compose config`, `docker inspect`, or service logs. Redact token/secret/key/auth/password/cookie/account/client values before writing files under `ci-logs/` or streaming opencode output.

## Adding a new service

1. Create `<name>/` with `<name>.yml` (header: purpose + doc links + examples).
2. Create `<name>/.env.example` with **full** env catalog (enums explained, how to obtain secrets, official links). Mark which keys are wired in the YAML vs optional/extension.
3. Assign **profiles**: at least `<name>`; add `core` and/or `full` per Profiles principles above; document in this file’s profile map.
4. Put service-only helpers under `<name>/scripts/` if needed.
5. Attach to network `proxy`.
6. Add Caddy labels if publicly routed; add `caddy.import: tinyauth_forwarder *` if auth is required.
7. Register in root `docker-compose.yml` `include`.
8. Update root `.env.example` (minimal keys + `COMPOSE_PROFILES` notes), `.env.ci`, README, and this file.
9. Update `scripts/runners/cache-config.jsonc` and `scripts/runners/ai-agents/opencode-analyze-config.jsonc` if the service adds compose files, Dockerfiles, or logs/code that CI should inspect.
10. Keep CI able to prove external reachability (whoami or equivalent).

## Adding an app (user apps — automated)

**Apps** (websites/APIs/tools you expose behind the proxy) are added with
automation, not by hand. Full guide + manual checklists: **`docs/ADDING_APPS.md`**.

```bash
make add-app NAME=nine-router TYPE=dockerfile PORT=3000   # auth ON; --no-auth for public
make validate-apps                                        # enforce the rules
make gen-app-ci                                               # regenerate CI build/cache steps
```

Rules an app **must** follow (enforced by `scripts/addapp/validate-app.mjs`):

1. Folder `<name>/` with compose file `<name>/<name>.yml`, `# ===` header.
2. `profiles: [<name>, full]` (add `core` only if part of the default public stack).
3. Attached to `proxy`; loads `env_file: ../.env` + `./.env`.
4. Caddy host label → `<slug>.${DOMAIN}` (like `whoami.${DOMAIN}`); many apps allowed.
5. **ENV PREFIX rule:** every app env var starts with the app prefix
   (`nine-router` → `NINE_ROUTER_`). Only shared keys may be unprefixed:
   `DOMAIN`, `COMPOSE_PROFILES`, `DOCKER_VOLUME_*`, `CADDY_*`, `TINYAUTH_*`.
6. Data under `${DOCKER_VOLUME_DATA_ABS}/<name>`; no new named volumes.
7. No `environment: KEY: ${KEY:-}` empty-string injection.
8. Registered in `scripts/addapp/apps-config.jsonc` (done by `add-app`) and in
   root `docker-compose.yml` `include`.

The four app types (`image`, `dockerfile`, `npx`, `code`) have templates in
`docs/templates/`. Buildable types (`dockerfile`, `code`) get a unique buildx
  cache **scope** = app name; `gen-app-ci` writes matching steps into dedicated
  app CI files: `.github/workflows/apps.yml` and `.azure/apps-pipelines.yml`.
  Runtime smoke workflows stay focused on stack reachability.

## What not to do

- Do not merge all services into one monolithic compose file as the only source of truth.
- Do not name service compose files `docker-compose.yml` inside service dirs.
- Do not dump service-specific scripts into root `scripts/`.
- Do not commit `.env` or real `CF_TUNNEL_TOKEN` / `TS_AUTHKEY`.
- Do not open host ports as the primary public path when Tunnel is the design; Tunnel is the outside entry.
- Do not break the "reachable from outside" CI check without replacing it.
- Do not reintroduce `environment: KEY: ${KEY:-}` for optional keys (empty-string injection).
- Do not paste catalog files into root `.env` with blank `KEY=` lines.
- Do not use `curl -L` in stack smoke tests (auth redirects break the check).
- Do not leave `tinyauth_forwarder` on whoami in quick-tunnel CI (catch-all must be public).
- Do not inline multi-step bash logic in Compose YAML or CI workflow YAML — extract to a script.

## Common commands

```bash
# Full stack (prod-like) — COMPOSE_PROFILES=core in .env by default
cp .env.example .env   # then edit; set COMPOSE_PROFILES=core or full
docker compose up -d
COMPOSE_PROFILES=full docker compose up -d
# or: COMPOSE_PROFILES=core,tailscale docker compose up -d

# CI / quick tunnel
cp .env.ci .env        # includes COMPOSE_PROFILES=core
docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d
./scripts/wait-and-test.mjs

# Service helpers
./tinyauth/scripts/generate-user.mjs
./cloudflare/scripts/extract-tunnel-url.mjs
./tailscale/scripts/init.mjs --env .env --dry-run
./tailscale/scripts/init.mjs --env .env
./tailscale/scripts/status.mjs
./caddy/scripts/dump-config.mjs
./orchestrator/scripts/status.mjs
```

## Commit message template (git-o commithook) — bắt buộc khi kết thúc

Repo này dùng hook **prepare-commit-msg** + **post-commit** (git-o / `setupgit commithook`):

| Bước | Việc                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Ghi **nội dung commit message** (mô tả công việc vừa xong) vào file **`.git/.git-o-commit-template`**                          |
| 2    | Chạy **`git commit`** (hoặc `git commit` rồi lưu editor) — **không** dùng `git commit -m "..."` nếu muốn template được áp dụng |
| 3    | Hook `prepare-commit-msg` chép nội dung template → message commit (chỉ commit thường; bỏ qua merge/squash/`-m`)                |
| 4    | Sau commit **thành công**, hook `post-commit` **clear** template                                                               |

### Quy tắc cho agent / người làm việc trong repo

1. **Trước khi coi task là xong**, nếu có thay đổi cần commit: **luôn ghi/cập nhật** `.git/.git-o-commit-template` với message rõ ràng (tiếng Việt hoặc Anh, complete sentences, nêu _what_ + _why_).
2. File nằm trong **`.git/`** — không commit vào tree; mỗi clone/máy có template riêng sau khi cài hook.
3. **Không** clear template thủ công trước khi commit (hook post-commit lo sau khi commit OK; clear sớm sẽ mất message nếu user hủy commit).
4. Agent **chỉ ghi template**, không tự chạy `git commit` hay `git push` — việc commit/push do user thực hiện.
5. Message nên khớp diff thật; không mention tool/agent trừ khi user yêu cầu.

### Ví dụ nội dung template

```text
Fix quick-tunnel CI and empty-env bootstrap for Tinyauth/Caddy.

Force HTTP/2 on trycloudflare path, stop injecting empty optional
TINYAUTH_*/CADDY_* vars, and smoke-test without curl -L so auth
redirects do not fail the public reachability check. Document named
vs quick modes in AGENTS.md and README.
```

## Agent checklist before finishing a change

- [ ] Service YAML named `<service>/<service>.yml`
- [ ] No optional empty `environment:` injections; catalogs keep unused keys commented
- [ ] Both paths still valid: **named** (`docker compose up`) and **quick** (`-f docker-compose.ci.yml`)
- [ ] `wait-and-test.mjs` still accepts 302/401 without following redirects
- [ ] Service has `profiles` (own name + `core` and/or `full` as appropriate)
- [ ] Scripts live in the correct directory (service vs stack-wide vs runners)
- [ ] No multi-step inline bash in YAML — extracted to scripts
- [ ] Root `include` list updated if services changed
- [ ] Env vars documented; Tinyauth keys valid for v5
- [ ] Root `.env.example` / `.env.ci` set `COMPOSE_PROFILES` appropriately
- [ ] README and AGENTS.md still accurate
- [ ] Sau khi viết/sửa file `.mjs`/`.js`, **đã chạy `node --check <file>`** trước khi coi task là done; nếu lỗi thì tự sửa và check lại, tối đa 3 lần
- [ ] **Đã ghi nội dung cập nhật vào `.git/.git-o-commit-template`** (sẵn sàng user `git commit` không `-m`)
