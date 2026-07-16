# docker-caddy-tailscale-tinyauth

Docker stack that combines **Cloudflare Tunnel**, **Tailscale**, **Caddy**, and **Tinyauth** into one reverse-proxy platform.

Each service lives in its own directory with its own Compose file. The root `docker-compose.yml` joins them with Compose `include`.

```
Internet ──► Cloudflare Tunnel ──► Caddy ──► Tinyauth (login)
                                  │
                                  └──► whoami (demo app, public by default)

Tailnet  ──► Tailscale Serve ──► Caddy   (optional private access)
```

## Layout

| Path | Role |
|------|------|
| `networks/networks.yml` | Shared `proxy` bridge network |
| `caddy/caddy.yml` + `caddy/scripts/` | Reverse proxy (`caddy-docker-proxy`) |
| `litestream/litestream.yml` + `litestream/scripts/` | SQLite restore/replication |
| `rclone/rclone.yml` + `rclone/scripts/` | File/folder remote sync |
| `tinyauth/tinyauth.yml` + `tinyauth/scripts/` | Forward-auth login UI |
| `whoami/whoami.yml` | Demo upstream app |
| `dozzle/dozzle.yml` | Protected Docker log viewer |
| `filebrowser/filebrowser.yml` | Protected repository file browser |
| `webssh/webssh.yml` | Protected web terminal with persistent tmux session |
| `cloudflare/cloudflare.yml` + `cloudflare/scripts/` | `cloudflared` tunnel (public edge) |
| `tailscale/tailscale.yml` + `tailscale/scripts/` | Optional Tailscale node + Serve |
| `orchestrator/orchestrator.yml` + `orchestrator/scripts/` | RTDB leader/handoff sidecar |
| `scripts/` | **Stack-wide only** (`up.mjs`, `wait-and-test.mjs`) |
| `docker-compose.yml` | Joins all service files |
| `docker-compose.ci.yml` | Quick-tunnel overrides for CI |
| `AGENTS.md` | Conventions for humans & coding agents |
| `.github/workflows/test.yml` | Smoke test + external reachability |

## Prerequisites

- Docker Engine + Compose v2.24+ (`include`, `!override`)
- A Cloudflare account (named tunnel) **or** use CI quick-tunnel mode
- (Optional) Tailscale auth key

## Quick start (local)

```bash
cp .env.example .env
# edit .env — COMPOSE_PROFILES, CF_TUNNEL_TOKEN, DOMAIN, TINYAUTH_* hosts

node scripts/up.mjs                     # uses COMPOSE_PROFILES from .env (default: core)

# whole stack including Tailscale:
#   COMPOSE_PROFILES=full
# or:
docker compose --profile full up -d
# or:
COMPOSE_PROFILES=core,tailscale docker compose up -d
```

### Profiles (bật / tắt service)

| Profile | Services |
|---------|----------|
| `core` | caddy, tinyauth, whoami, cloudflare, orchestrator |
| `full` | core + tailscale + dozzle + filebrowser + webssh |
| `caddy` / `litestream` / `rclone` / `tinyauth` / `whoami` / `cloudflare` / `tailscale` / `dozzle` / `filebrowser` / `webssh` / `orchestrator` | từng service |

Set in `.env`:

```bash
COMPOSE_PROFILES=core
# COMPOSE_PROFILES=full
# COMPOSE_PROFILES=caddy,whoami
```

`litestream` và `rclone` không cần thêm vào `COMPOSE_PROFILES` khi dùng
`node scripts/up.mjs` hoặc CI: helper tự bật nếu `.env` có
`LITESTREAM_<index>_SERVICE` hoặc `RCLONE_<index>_NAME`. Nếu chạy
`docker compose up` trực tiếp, Compose không tự suy luận được, nên phải tự thêm
profile hoặc dùng helper.

```bash
make profiles   # xem profile / service hiện tại
make up-core
make up-full
```

Helpers:

```bash
chmod +x scripts/*.sh */scripts/*.sh
./scripts/up.mjs                            # stack-wide
./tinyauth/scripts/generate-user.mjs       # service-local
./cloudflare/scripts/extract-tunnel-url.mjs
./tailscale/scripts/status.mjs
./caddy/scripts/dump-config.mjs
./orchestrator/scripts/status.mjs
```

Service-specific scripts live under `<service>/scripts/`. Only orchestration scripts stay in root `scripts/`. See `AGENTS.md`.

### Generate a Tinyauth user

```bash
./tinyauth/scripts/generate-user.mjs
# paste into TINYAUTH_AUTH_USERS (double every $ as $$ for Compose)
```

Example login from docs: **user** / **password** (hash is already in `.env.example`).

## Environment / GitHub secret

All configuration is env-driven. Docker Compose loads the **root** `.env`.

On GitHub, create a **single repository secret** named:

| Secret | Content |
|--------|---------|
| `ENV_FILE` | Full contents of your production root `.env` file |

The workflow writes that secret to `.env` before `docker compose up`.

If `ENV_FILE` is missing (e.g. fork PRs), CI falls back to `.env.ci` and a **Cloudflare quick tunnel** (`*.trycloudflare.com`) so the job still proves external access.

| CI mode | When | Compose | Public URL | Whoami auth |
|---------|------|---------|------------|-------------|
| **Named** | `ENV_FILE` has non-empty `CF_TUNNEL_TOKEN` | `docker compose up` | `WHOAMI_HOST` / `whoami.$DOMAIN` (https) | Off by default; set `WHOAMI_TINYAUTH_ENABLED=true` for forward-auth |
| **Quick** | no secret or empty token | `+ docker-compose.ci.yml` | `*.trycloudflare.com` | Off (catch-all `:80`) |

### Per-service env catalogs

Root `.env.example` = minimal keys the compose files actually use.  
**Full** variable lists (every supported option, enums explained, links to obtain secrets) live next to each service:

| Catalog | Service |
|---------|---------|
| [`cloudflare/.env.example`](cloudflare/.env.example) | `TUNNEL_*`, protocol, loglevel, token |
| [`caddy/.env.example`](caddy/.env.example) | ports, `CADDY_DOCKER_*`, ingress networks |
| [`litestream/.env.example`](litestream/.env.example) | indexed `LITESTREAM_<index>_*` S3 sync blocks |
| [`rclone/.env.example`](rclone/.env.example) | indexed `RCLONE_<index>_*` file/folder sync blocks |
| [`tinyauth/.env.example`](tinyauth/.env.example) | all `TINYAUTH_*` v5 groups |
| [`whoami/.env.example`](whoami/.env.example) | `WHOAMI_HOST` / labels |
| [`dozzle/.env.example`](dozzle/.env.example) | `DOZZLE_HOSTS` / labels |
| [`filebrowser/.env.example`](filebrowser/.env.example) | `FILEBROWSER_HOST` / workspace mount notes |
| [`webssh/.env.example`](webssh/.env.example) | `WEBSSH_HOSTS` / ttyd + tmux notes |
| [`tailscale/.env.example`](tailscale/.env.example) | all `TS_*` Docker params |
| [`networks/.env.example`](networks/.env.example) | network knobs (mostly hard-coded) |
| [`orchestrator/.env.example`](orchestrator/.env.example) | `ORCH_*` RTDB leader/handoff sidecar |

Copy **only** keys you need from a catalog into root `.env` (with real values).  
Do **not** copy blank lines like `TINYAUTH_SERVER_SOCKETPATH=` — empty optional env can prevent Tinyauth/Caddy from starting (same risk in prod and CI).

Public apps that should not go through Tinyauth: see [`docs/deploys/public-apps.md`](docs/deploys/public-apps.md).

### Shared Docker network

The stack intentionally uses a global Docker bridge network named `proxy`.
That stable name keeps `CADDY_INGRESS_NETWORKS=proxy` working the same way in
Compose `include` mode and in the documented multi-file command.

Tradeoff: another Compose project on the same Docker host can also attach to a
network named `proxy`, so both stacks may share network reachability. Keep the
name as-is for this repo. Use a separate Docker host, or rename the network and
update `CADDY_INGRESS_NETWORKS`, if strict stack isolation matters.

### Important variables (minimal)

| Variable | Purpose |
|----------|---------|
| `DOMAIN` | Base domain for default hostnames; `localhost` fallback is only for local tests |
| `CF_TUNNEL_TOKEN` | Cloudflare named tunnel token |
| `TINYAUTH_APPURL` | Public login URL (https) |
| `TINYAUTH_HOST` | Caddy site label (usually `http://auth.…`) |
| `TINYAUTH_AUTH_USERS` | `user:bcrypt` (use `$$` for `$` in Compose) |
| `TINYAUTH_AUTH_SECURECOOKIE` | `true` behind HTTPS public URLs |
| `WHOAMI_HOST` | Caddy site for the demo app |
| `WHOAMI_TINYAUTH_ENABLED` | Protect whoami with Tinyauth when `true`; default `false` |
| `DOZZLE_HOSTS` | Caddy sites for protected Docker logs |
| `FILEBROWSER_HOST` | Caddy site for protected repo file browser |
| `WEBSSH_HOSTS` | Caddy sites for protected ttyd/tmux terminal |
| `TS_AUTHKEY` | Tailscale auth key (profile `tailscale`) |
| `DOCKER_VOLUME_RUNTIME` | Bind-mount root for generated runtime files, defaults `./ci-runtime` |
| `DOCKER_VOLUME_DATA` | Bind-mount root for app data, defaults `./ci-data` |

### Litestream data sync

Litestream is optional. If no `LITESTREAM_<index>_*` block exists, startup skips
restore and the Litestream container idles. Any app using Litestream must store
its SQLite data under `${DOCKER_VOLUME_DATA}/litestream/<service>/`.

```env
LITESTREAM_0_SERVICE=tinyauth
LITESTREAM_0_PATH=/data/tinyauth/tinyauth.db
LITESTREAM_0_BUCKET=bucket
# LITESTREAM_0_KEY=tinyauth/tinyauth.db
LITESTREAM_0_ACCESS_KEY_ID=...
LITESTREAM_0_SECRET_ACCESS_KEY=...
LITESTREAM_0_ENDPOINT=https://project-ref.supabase.co/storage/v1/s3
LITESTREAM_0_REGION=auto
LITESTREAM_0_FORCE_PATH_STYLE=true
```

Startup helpers auto-enable the `litestream` profile when a `LITESTREAM_*`
block exists, generate `ci-runtime/litestream/litestream.yml`, restore any
missing local DB from S3 if present, then start containers. If S3 has no backup
yet, the app creates the DB and Litestream replicates it afterward.
Litestream restore and Rclone pull run in parallel after config generation.

### Rclone data sync

Rclone is optional. If no `RCLONE_<index>_NAME` block exists, startup skips
pull and no rclone container is started. Rclone-managed data should live under
`${DOCKER_VOLUME_DATA}/rclone/<name>/`.

```env
RCLONE_0_NAME=tinyauth-db
RCLONE_0_TYPE=file
RCLONE_0_LOCAL=/data/tinyauth-db/tinyauth.db
RCLONE_0_REMOTE=remote:proxy-stack/tinyauth.db
RCLONE_0_INTERVAL=300
RCLONE_0_CONFIG_BASE64=...
```

`RCLONE_0_NAME=tinyauth-db` makes the first rclone container name
`rclone-0-tinyauth-db`. Startup helpers pull all configured jobs in parallel
before app containers start; the rclone container then pushes local changes on
each job interval. Use `TYPE=dir` for whole folders. See
[`docs/deploys/rclone.md`](docs/deploys/rclone.md).

### Orchestrator handoff

Orchestrator is optional but included in `core`. Set `CONSUL_ENABLE=1` only when
you want RTDB leader/standby handoff across CI runners. Full deploy guide:
[`docs/deploys/orchestrator.md`](docs/deploys/orchestrator.md).

## Cloudflare named tunnel setup

1. Zero Trust → **Networks** → **Tunnels** → Create a tunnel (Cloudflared).
2. Copy the tunnel **token** into `CF_TUNNEL_TOKEN`.
3. Add **Public hostnames** (service URL for all of them):

   | Public hostname | Service |
   |-----------------|---------|
   | `auth.example.com` | `http://caddy:80` |
   | `whoami.example.com` | `http://caddy:80` |
   | `dozzle.example.com` | `http://caddy:80` |
   | `logs.example.com` | `http://caddy:80` |
   | `files.example.com` | `http://caddy:80` |
   | `ttyd.example.com` | `http://caddy:80` |
   | `webssh.example.com` | `http://caddy:80` |

4. DNS can be managed by Cloudflare when you add hostnames on the tunnel.

Caddy routes by `Host` header; Cloudflare only needs to send traffic to `caddy:80`.

## Admin tools

These are not part of `core`; enable them with `COMPOSE_PROFILES=full` or their
own profiles. Admin routes import `tinyauth_forwarder`; whoami imports a gated snippet and is public unless `WHOAMI_TINYAUTH_ENABLED=true`.

- `dozzle`: Docker logs (`amir20/dozzle`), Docker socket mounted read-only.
- `filebrowser`: repository root mounted at `/srv`; hidden files are visible.
- `webssh`: ttyd terminal in `/workspace`; `tmux new-session -A -s webssh`
  preserves the shell when the browser closes.

## Adding your own apps

Add websites / APIs / tools behind the proxy with the app scaffolder. Each app
gets its own subdomain (`<slug>.${DOMAIN}`, like `whoami.${DOMAIN}`) and you can
add as many as you want. Four types are supported: `image`, `dockerfile`, `npx`,
`code`.

```bash
# auth ON by default; add --no-auth (or AUTH=--no-auth) for a public route
make add-app NAME=nine-router TYPE=dockerfile PORT=3000
make validate-apps      # enforce the rules (env prefix, profiles, network, ...)
make gen-app-ci             # regenerate GitHub Actions + Azure Pipelines build steps
COMPOSE_PROFILES=core,nine-router make up
```

Key rule: every app env var must start with the app's prefix
(`nine-router` → `NINE_ROUTER_`). Full guide + manual checklists:
[`docs/ADDING_APPS.md`](docs/ADDING_APPS.md).

## Tailscale (optional)

```bash
# chuẩn bị ACL tags + HTTPS + tailscale/serve.json
node tailscale/scripts/init.mjs --env .env --dry-run
node tailscale/scripts/init.mjs --env .env

# .env: COMPOSE_PROFILES=full   hoặc   core,tailscale
docker compose up -d
# CLI:
docker compose --profile core --profile tailscale up -d
```

- Uses userspace networking (`TS_USERSPACE=true`) — no host kernel module required.
- `tailscale/serve.json` proxies HTTPS on the Tailscale node directly to each service from `tailscale/scripts/init.jsonc`; aliases use `names` (for example `dozzle` + `logs`).
- Private hosts use `<service>.<TS_TAILNET>` (for example `files.example.ts.net`) and do not go through Tinyauth labels.
- ACL flow: `.env` + `tailscale/acl.sample.hujson` renders `tailscale/acl.hujson`, then init uploads `acl.hujson` to remote Tailscale ACL.
- `TS_CLIENT_ID` / `TS_CLIENT_SECRET` are the single Trust Credentials pair for API init and machine join.

## CI

Workflow: `.github/workflows/test.yml`

1. Writes `secrets.ENV_FILE` → `.env` (or `.env.ci`).
2. Starts the stack (`docker-compose.ci.yml` only for quick tunnel when no token).
3. Runs `scripts/wait-and-test.mjs`:
   - waits for `caddy`, `whoami`, `cloudflared`
   - discovers `https://*.trycloudflare.com` **or** uses `WHOAMI_HOST` for named tunnels
   - `curl` **without** `-L` (does not follow login redirects)
   - accepts HTTP **200 / 301 / 302 / 307 / 401 / 403** as “reachable”

**Full production-like secret:** put a complete root `.env` in `ENV_FILE` (including `CF_TUNNEL_TOKEN`, public `TINYAUTH_APPURL`, `WHOAMI_HOST`, hostnames on the Cloudflare tunnel). With default whoami auth off, smoke success is typically **200**; with `WHOAMI_TINYAUTH_ENABLED=true`, success may be **302** (redirect to login) or **401**.

## Multi-file compose without `include`

```bash
docker compose \
  -f networks/networks.yml \
  -f caddy/caddy.yml \
  -f litestream/litestream.yml \
  -f rclone/rclone.yml \
  -f tinyauth/tinyauth.yml \
  -f whoami/whoami.yml \
  -f cloudflare/cloudflare.yml \
  -f tailscale/tailscale.yml \
  -f orchestrator/orchestrator.yml \
  up -d
```

## Smoke test only (no named tunnel)

```bash
cp .env.ci .env
docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d
./scripts/wait-and-test.mjs
# open the printed trycloudflare.com URL
```

## Notes

- Origin protocol is **HTTP**; Cloudflare (or Tailscale Serve) terminates TLS.
- Tinyauth cookies are set on the parent of `TINYAUTH_APPURL` — use real subdomains (`auth.example.com` + `whoami.example.com`), not multi-level free DDNS hosts.
- Do not commit `.env`. Only `.env.example` / `.env.ci` belong in git.
- When probing a protected app manually: first response **302/401** means the tunnel + Caddy path works; following redirects needs a browser or login flow.
- Coding agents and contributors: follow **`AGENTS.md`** (layout, scripts, env injection rules, named vs quick CI).
