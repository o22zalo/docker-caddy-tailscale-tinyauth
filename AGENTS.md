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

| Directory     | Compose file              | Env catalog              | Notes                          |
|---------------|---------------------------|--------------------------|--------------------------------|
| `networks/`   | `networks.yml`            | `networks/.env.example`  | Shared `proxy` network         |
| `caddy/`      | `caddy.yml`               | `caddy/.env.example`     | Reverse proxy                  |
| `tinyauth/`   | `tinyauth.yml`            | `tinyauth/.env.example`  | Forward-auth login             |
| `whoami/`     | `whoami.yml`              | `whoami/.env.example`    | Demo upstream                  |
| `cloudflare/` | `cloudflare.yml`          | `cloudflare/.env.example`| cloudflared public edge        |
| `tailscale/`  | `tailscale.yml`           | `tailscale/.env.example` | Profiles: `tailscale`, `full`  |

### Naming rules

1. **One directory per service.**
2. **Compose file name = service name:** `cloudflare/cloudflare.yml`, not `docker-compose.yml` inside the service dir.
3. **Root** keeps `docker-compose.yml` (join) and `docker-compose.ci.yml` (overrides).
4. **Do not** put service-specific scripts under root `scripts/`.
5. **Do** put shared/orchestration scripts under root `scripts/`.
6. **Every Compose YAML** starts with a comment header: purpose in this project, official doc links, env/example config (see existing files).
7. **Every service directory** has `.env.example` documenting **all** supported env vars for that service (or stack knobs for it): purpose, how to obtain values, links, and full meaning of enum/choice values. Root `.env.example` stays the **minimal** set wired by compose; full catalogs live under `<service>/.env.example`.

## Scripts placement

| Kind | Location | Examples |
|------|----------|----------|
| Service-only | `<service>/scripts/*.sh` | `tinyauth/scripts/generate-user.sh`, `cloudflare/scripts/extract-tunnel-url.sh`, `tailscale/scripts/status.sh`, `caddy/scripts/dump-config.sh` |
| Stack-wide | `scripts/*.sh` | `scripts/up.sh`, `scripts/wait-and-test.sh` |
| CI / runner | `scripts/runners/*.mjs` | `scripts/runners/setup-env.mjs`, `scripts/runners/start-stack.mjs`, `scripts/runners/collect-logs.mjs`, `scripts/runners/cache-docker-build-github.mjs` |

Rules:

- New helper for a single service → that service's `scripts/`.
- Script that starts/tests/tears down the **whole stack** → root `scripts/`.
- Script that runs **only in CI / GitHub Actions runner** → `scripts/runners/`.
- Stack scripts may **call** service scripts (e.g. `wait-and-test.sh` → `cloudflare/scripts/extract-tunnel-url.sh`).
- Prefer `#!/usr/bin/env bash`, `set -euo pipefail`, and resolve repo root relative to the script path.
- Keep scripts executable in CI (`chmod +x` on `scripts` and `*/scripts`).

### Inline code in YAML — prefer scripts

**Do not** put multi-step or branching logic inline in Compose YAML or GitHub Actions workflow YAML. Extract to a script file instead.

| Where | Rule | Why |
|-------|------|-----|
| CI workflow (`test.yml`) | ≥ 5 lines of bash → move to `scripts/runners/*.mjs` | Testable, reviewable, reusable |
| Compose YAML | No inline shell; use labels/env/scripts | Compose is declarative; logic belongs in scripts |
| Script language | `.mjs` (Node.js ES module) for CI runners; `.sh` for service/stack helpers | GitHub Actions runners have Node.js; `.mjs` is cross-platform, testable, no extra deps |

Exceptions (OK to keep inline):
- ≤ 4 lines of trivial shell (e.g. `echo`, `cat`, single `docker compose` call).
- GitHub Actions expressions (`${{ ... }}`) — these are YAML, not shell.

## Compose rules

1. Root `docker-compose.yml` uses **`include`** to pull every service YAML.
2. All app services attach to the shared network **`proxy`**.
3. Prefer **labels** on services for Caddy routing (caddy-docker-proxy).
4. Origin protocol is **HTTP**; TLS is terminated at Cloudflare Tunnel and/or Tailscale Serve.
5. Tinyauth protects apps via Caddy snippet `tinyauth_forwarder` + `caddy.import: tinyauth_forwarder *`.
6. **Every service is profile-gated.** Use `COMPOSE_PROFILES` in root `.env` (Compose reads it automatically).
7. CI overrides go in `docker-compose.ci.yml` (quick tunnel, catch-all `:80`, `labels: !override` where needed).
8. Requires Docker Compose **v2.24+** (`include`, `!override`).

### Profiles — principles (enable / disable services)

**Docs:** https://docs.docker.com/compose/how-tos/profiles/

#### Rules agents must follow

1. **Every app service is profile-gated.** No app service may run with an empty `profiles:` list. (`networks/` is infrastructure only — no service profile.)
2. **Each service has its own named profile** equal to the service/folder intent:
   - `caddy`, `tinyauth`, `whoami`, `cloudflare`, `tailscale`
3. **Group profiles (OR membership):**
   - `core` — public path: caddy + tinyauth + whoami + cloudflare
   - `full` — everything: core members **plus** tailscale
4. **Tailscale is never required for `core`.** Only on `tailscale` and/or `full`.
5. **Semantics = OR:** a service starts if **any one** of its listed profiles is active.
6. **Activation source of truth:** root `.env` → `COMPOSE_PROFILES=...` (Compose loads automatically). CLI `--profile X` can add profiles for one invocation.
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

| Profile | Enables |
|---------|---------|
| `caddy` | Caddy only |
| `tinyauth` | Tinyauth only |
| `whoami` | Whoami only |
| `cloudflare` | cloudflared only |
| `tailscale` | Tailscale only |
| `core` | caddy + tinyauth + whoami + cloudflare (public path) |
| `full` | core + tailscale |

| Service | Profiles on the service |
|---------|-------------------------|
| `caddy` | `caddy`, `core`, `full` |
| `tinyauth` | `tinyauth`, `core`, `full` |
| `whoami` | `whoami`, `core`, `full` |
| `cloudflared` | `cloudflare`, `core`, `full` |
| `tailscale` | `tailscale`, `full` |

```bash
# .env (recommended default)
COMPOSE_PROFILES=core

# one-shot
COMPOSE_PROFILES=full docker compose up -d
COMPOSE_PROFILES=caddy,whoami docker compose up -d
docker compose --profile tailscale up -d   # CLI adds a profile to the active set

# helpers
make up-core
make up-full
make profiles
./scripts/up.sh full
```

### Multi-file without include (must stay valid)

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

When adding a service, update **both** root `include` and this documented multi-file list (README + this file).

## Environment and secrets

1. **Single source of config:** root `.env` (never commit real secrets).
2. **GitHub:** one repository secret named **`ENV_FILE`** whose value is the **entire** `.env` file content.
3. Workflow writes `secrets.ENV_FILE` → `.env` before `docker compose up`.
4. If `ENV_FILE` is missing → use `.env.ci` + quick tunnel so CI still proves external access.
5. Document every variable in `.env.example`.
6. bcrypt / `$` in Compose: use **`$$`** in `.env` / compose so containers receive a single `$`.

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

### Tinyauth v5 (strict)

- Only **documented** `TINYAUTH_*` keys (see https://tinyauth.app/docs/reference/configuration/).
- Unknown `TINYAUTH_*` keys make the process **refuse to start**.
- Empty optional `TINYAUTH_*` (especially `TINYAUTH_SERVER_SOCKETPATH`, OAuth provider IDs) can also break bootstrap — omit the key entirely if unused.
- Common keys: `TINYAUTH_APPURL`, `TINYAUTH_AUTH_USERS`, `TINYAUTH_AUTH_SECURECOOKIE`, `TINYAUTH_LOG_LEVEL`, `TINYAUTH_DATABASE_PATH`, `TINYAUTH_ANALYTICS_ENABLED`.
- Do **not** invent `TINYAUTH_SECRET` / old v3 names.
- Prod: `TINYAUTH_APPURL` must be the **public** `https://auth.<domain>` (cookie + redirects). CI quick mode may use `http://tinyauth.internal` only because whoami auth is stripped.

### Cloudflare

- **Named tunnel (prod / full ENV_FILE):** `TUNNEL_TOKEN` + dashboard Public Hostname → `http://caddy:80` for **auth** and **whoami** hosts. Compose: `tunnel run` (no `docker-compose.ci.yml`).
- **Quick tunnel (no token / no secret):** `docker-compose.ci.yml` → `tunnel --url http://caddy:80`, prefer **HTTP/2** + IPv4 on GitHub runners; whoami becomes catch-all `:80` **without** `tinyauth_forwarder`.
- Service container name / compose service: `cloudflared`.

### Named vs quick — what breaks where

| Issue | Full config (named + auth) | Quick CI (no config) |
|-------|----------------------------|----------------------|
| Empty optional env in YAML / `.env` | **Yes** — Tinyauth/Caddy can fail to start | **Yes** |
| `curl -L` following auth redirect | Risky if `APPURL` wrong; OK if public `https://auth…` | **Fails** if forward-auth still on (redirect → internal host) |
| Missing `TUNNEL_TOKEN` | cloudflared crash-loops (`tunnel run`) | Expected — use CI override |
| Whoami protected by Tinyauth | **Intended** — public probe may get **302/401** | Must **disable** auth (CI `labels: !override`) |
| QUIC on GHA | Rare flake with `protocol=auto` | Common — force `http2` in CI |

Full config is **not** immune to empty-env / probe bugs; only the trycloudflare-specific pieces are CI-only.

### Tailscale

- Profiles: `tailscale` and `full` only (not `core`).
- Userspace preferred (`TS_USERSPACE=true`) for portability.
- Serve config: `tailscale/serve.json` → proxy to `http://caddy:80`.

## CI requirements

Workflow: `.github/workflows/test.yml`.

Must:

1. Materialize `.env` from `ENV_FILE` or `.env.ci`.
2. Detect mode: `TUNNEL_TOKEN` non-empty → **named** (plain compose); else **quick** (`docker-compose.ci.yml`).
3. Start stack; fail fast if `cloudflared` is not running.
4. Run `scripts/wait-and-test.sh`:
   - require `caddy`, `whoami`, `cloudflared` running;
   - named: `PUBLIC_URL` from `WHOAMI_HOST` / `DOMAIN` (https);
   - quick: extract `https://*.trycloudflare.com` from logs;
   - **do not** `curl -L` (no redirect follow) — first hop 200/3xx/401/403 is enough to prove the edge;
   - accept HTTP **200, 301, 302, 307, 401, 403**.
5. Collect **per-service logs** into `ci-logs/` and upload as a GitHub Actions artifact (always, before tear down).
6. Also dump recent logs to the job console on failure; tear down always.
7. Never print secret values (only env **keys**).

**Full ENV_FILE checklist for named CI:** `COMPOSE_PROFILES` includes `core` (or equivalent), non-empty `TUNNEL_TOKEN`, public hostnames on the tunnel, `WHOAMI_HOST` (or `DOMAIN`), valid `TINYAUTH_*` (public `APPURL`, users, secure cookie as needed).

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

## Adding a new service

1. Create `<name>/` with `<name>.yml` (header: purpose + doc links + examples).
2. Create `<name>/.env.example` with **full** env catalog (enums explained, how to obtain secrets, official links). Mark which keys are wired in the YAML vs optional/extension.
3. Assign **profiles**: at least `<name>`; add `core` and/or `full` per Profiles principles above; document in this file’s profile map.
4. Put service-only helpers under `<name>/scripts/` if needed.
5. Attach to network `proxy`.
6. Add Caddy labels if publicly routed; add `caddy.import: tinyauth_forwarder *` if auth is required.
7. Register in root `docker-compose.yml` `include`.
8. Update root `.env.example` (minimal keys + `COMPOSE_PROFILES` notes), `.env.ci`, README, and this file.
9. Keep CI able to prove external reachability (whoami or equivalent).

## What not to do

- Do not merge all services into one monolithic compose file as the only source of truth.
- Do not name service compose files `docker-compose.yml` inside service dirs.
- Do not dump service-specific scripts into root `scripts/`.
- Do not commit `.env` or real `TUNNEL_TOKEN` / `TS_AUTHKEY`.
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
./scripts/wait-and-test.sh

# Service helpers
./tinyauth/scripts/generate-user.sh
./cloudflare/scripts/extract-tunnel-url.sh
./tailscale/scripts/status.sh
./caddy/scripts/dump-config.sh
```

## Commit message template (git-o commithook) — bắt buộc khi kết thúc

Repo này dùng hook **prepare-commit-msg** + **post-commit** (git-o / `setupgit commithook`):

| Bước | Việc |
|------|------|
| 1 | Ghi **nội dung commit message** (mô tả công việc vừa xong) vào file **`.git/.git-o-commit-template`** |
| 2 | Chạy **`git commit`** (hoặc `git commit` rồi lưu editor) — **không** dùng `git commit -m "..."` nếu muốn template được áp dụng |
| 3 | Hook `prepare-commit-msg` chép nội dung template → message commit (chỉ commit thường; bỏ qua merge/squash/`-m`) |
| 4 | Sau commit **thành công**, hook `post-commit` **clear** template |

### Quy tắc cho agent / người làm việc trong repo

1. **Trước khi coi task là xong**, nếu có thay đổi cần commit: **luôn ghi/cập nhật** `.git/.git-o-commit-template` với message rõ ràng (tiếng Việt hoặc Anh, complete sentences, nêu *what* + *why*).
2. File nằm trong **`.git/`** — không commit vào tree; mỗi clone/máy có template riêng sau khi cài hook.
3. **Không** clear template thủ công trước khi commit (hook post-commit lo sau khi commit OK; clear sớm sẽ mất message nếu user hủy commit).
4. Nếu user bảo commit: ghi template **trước**, rồi mới `git commit` (không `-m` / không `--amend` trừ khi user yêu cầu).
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
- [ ] `wait-and-test.sh` still accepts 302/401 without following redirects
- [ ] Service has `profiles` (own name + `core` and/or `full` as appropriate)
- [ ] Scripts live in the correct directory (service vs stack-wide vs runners)
- [ ] No multi-step inline bash in YAML — extracted to scripts
- [ ] Root `include` list updated if services changed
- [ ] Env vars documented; Tinyauth keys valid for v5
- [ ] Root `.env.example` / `.env.ci` set `COMPOSE_PROFILES` appropriately
- [ ] CI still covers external access
- [ ] README and AGENTS.md still accurate
- [ ] **Đã ghi nội dung cập nhật vào `.git/.git-o-commit-template`** (sẵn sàng `git commit` không `-m`)
