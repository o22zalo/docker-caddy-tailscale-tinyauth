# docker-caddy-tailscale-tinyauth

Docker stack that combines **Cloudflare Tunnel**, **Tailscale**, **Caddy**, and **Tinyauth** into one reverse-proxy platform.

Each service lives in its own directory with its own Compose file. The root `docker-compose.yml` joins them with Compose `include`.

```
Internet ──► Cloudflare Tunnel ──► Caddy ──► Tinyauth (login)
                                  │
                                  └──► whoami (demo app, protected)

Tailnet  ──► Tailscale Serve ──► Caddy   (optional private access)
```

## Layout

| Path | Role |
|------|------|
| `networks/networks.yml` | Shared `proxy` bridge network |
| `caddy/caddy.yml` + `caddy/scripts/` | Reverse proxy (`caddy-docker-proxy`) |
| `tinyauth/tinyauth.yml` + `tinyauth/scripts/` | Forward-auth login UI |
| `whoami/whoami.yml` | Demo upstream app |
| `cloudflare/cloudflare.yml` + `cloudflare/scripts/` | `cloudflared` tunnel (public edge) |
| `tailscale/tailscale.yml` + `tailscale/scripts/` | Optional Tailscale node + Serve |
| `scripts/` | **Stack-wide only** (`up.sh`, `wait-and-test.sh`) |
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
# edit .env — COMPOSE_PROFILES, TUNNEL_TOKEN, DOMAIN, TINYAUTH_* hosts

docker compose up -d                    # uses COMPOSE_PROFILES from .env (default: core)

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
| `core` | caddy, tinyauth, whoami, cloudflare |
| `full` | core + tailscale |
| `caddy` / `tinyauth` / `whoami` / `cloudflare` / `tailscale` | từng service |

Set in `.env`:

```bash
COMPOSE_PROFILES=core
# COMPOSE_PROFILES=full
# COMPOSE_PROFILES=caddy,whoami
```

```bash
make profiles   # xem profile / service hiện tại
make up-core
make up-full
```

Helpers:

```bash
chmod +x scripts/*.sh */scripts/*.sh
./scripts/up.sh                          # stack-wide
./tinyauth/scripts/generate-user.sh      # service-local
./cloudflare/scripts/extract-tunnel-url.sh
./tailscale/scripts/status.sh
./caddy/scripts/dump-config.sh
```

Service-specific scripts live under `<service>/scripts/`. Only orchestration scripts stay in root `scripts/`. See `AGENTS.md`.

### Generate a Tinyauth user

```bash
./tinyauth/scripts/generate-user.sh
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

### Per-service env catalogs

Root `.env.example` = minimal keys the compose files actually use.  
**Full** variable lists (every supported option, enums explained, links to obtain secrets) live next to each service:

| Catalog | Service |
|---------|---------|
| [`cloudflare/.env.example`](cloudflare/.env.example) | `TUNNEL_*`, protocol, loglevel, token |
| [`caddy/.env.example`](caddy/.env.example) | ports, `CADDY_DOCKER_*`, ingress networks |
| [`tinyauth/.env.example`](tinyauth/.env.example) | all `TINYAUTH_*` v5 groups |
| [`whoami/.env.example`](whoami/.env.example) | `WHOAMI_HOST` / labels |
| [`tailscale/.env.example`](tailscale/.env.example) | all `TS_*` Docker params |
| [`networks/.env.example`](networks/.env.example) | network knobs (mostly hard-coded) |

Copy extra keys from a service catalog into root `.env` **and** wire them in that service’s YAML if you need them at runtime.

### Important variables (minimal)

| Variable | Purpose |
|----------|---------|
| `DOMAIN` | Base domain for default hostnames |
| `TUNNEL_TOKEN` | Cloudflare named tunnel token |
| `TINYAUTH_APPURL` | Public login URL (https) |
| `TINYAUTH_HOST` | Caddy site label (usually `http://auth.…`) |
| `TINYAUTH_AUTH_USERS` | `user:bcrypt` (use `$$` for `$` in Compose) |
| `TINYAUTH_AUTH_SECURECOOKIE` | `true` behind HTTPS public URLs |
| `WHOAMI_HOST` | Caddy site for the demo app |
| `TS_AUTHKEY` | Tailscale auth key (profile `tailscale`) |

## Cloudflare named tunnel setup

1. Zero Trust → **Networks** → **Tunnels** → Create a tunnel (Cloudflared).
2. Copy the tunnel **token** into `TUNNEL_TOKEN`.
3. Add **Public hostnames** (service URL for all of them):

   | Public hostname | Service |
   |-----------------|---------|
   | `auth.example.com` | `http://caddy:80` |
   | `whoami.example.com` | `http://caddy:80` |

4. DNS can be managed by Cloudflare when you add hostnames on the tunnel.

Caddy routes by `Host` header; Cloudflare only needs to send traffic to `caddy:80`.

## Tailscale (optional)

```bash
# .env: COMPOSE_PROFILES=full   hoặc   core,tailscale
docker compose up -d
# CLI:
docker compose --profile core --profile tailscale up -d
```

- Uses userspace networking (`TS_USERSPACE=true`) — no host kernel module required.
- `tailscale/serve.json` proxies HTTPS on the Tailscale node to `http://caddy:80`.
- Approve the node / tags in the Tailscale admin console if required.

## CI

Workflow: `.github/workflows/test.yml`

1. Writes `secrets.ENV_FILE` → `.env` (or `.env.ci`).
2. Starts the stack (`docker-compose.ci.yml` for quick tunnel when no token).
3. Runs `scripts/wait-and-test.sh`:
   - waits for containers
   - discovers `https://*.trycloudflare.com` **or** uses `WHOAMI_HOST` for named tunnels
   - `curl`s the public URL and requires HTTP 200/3xx/401

## Multi-file compose without `include`

```bash
docker compose \
  -f networks/networks.yml \
  -f caddy/caddy.yml \
  -f tinyauth/tinyauth.yml \
  -f whoami/whoami.yml \
  -f cloudflare/cloudflare.yml \
  -f tailscale/tailscale.yml \
  up -d
```

## Smoke test only (no named tunnel)

```bash
cp .env.ci .env
docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d
./scripts/wait-and-test.sh
# open the printed trycloudflare.com URL
```

## Notes

- Origin protocol is **HTTP**; Cloudflare (or Tailscale Serve) terminates TLS.
- Tinyauth cookies are set on the parent of `TINYAUTH_APPURL` — use real subdomains (`auth.example.com` + `whoami.example.com`), not multi-level free DDNS hosts.
- Do not commit `.env`. Only `.env.example` / `.env.ci` belong in git.
- Coding agents and contributors: follow **`AGENTS.md`** (layout, scripts placement, env, CI rules).
