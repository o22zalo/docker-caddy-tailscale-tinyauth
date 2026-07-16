.PHONY: up up-ci up-core up-full up-ts down logs ps config profiles test-ci user provision tunnel-url ts-status add-app validate-apps gen-app-ci orch-status orch-register orch-watch

# Uses COMPOSE_PROFILES from .env (default in .env.example: core)
up:
	node scripts/up.mjs

up-core:
	node scripts/up.mjs core

up-full:
	node scripts/up.mjs full

up-ts:
	node scripts/up.mjs core tailscale

up-ci:
	node scripts/up.mjs ci core

down:
	docker compose down --remove-orphans

logs:
	docker compose logs -f --tail=100

ps:
	docker compose ps

config:
	docker compose config

# List services and which profiles they belong to
profiles:
	@echo "COMPOSE_PROFILES (from env/.env): $${COMPOSE_PROFILES:-<not set in shell>}"
	@echo ""
	@echo "Service → profiles (from compose config):"
	@docker compose config --profiles 2>/dev/null || true
	@echo ""
	@echo "Enabled services with current profiles:"
	@docker compose config --services 2>/dev/null || true

test-ci: up-ci
	node scripts/wait-and-test.mjs

user:
	node tinyauth/scripts/generate-user.mjs

provision:
	node cloudflare/scripts/provision-tunnel.mjs

tunnel-url:
	node cloudflare/scripts/extract-tunnel-url.mjs

ts-status:
	node tailscale/scripts/status.mjs

# ── Apps (add / validate / regenerate CI) ───────────────────────────────────
# Usage: make add-app NAME=nine-router TYPE=dockerfile PORT=3000 [AUTH=--no-auth] [SUB=router]
add-app:
	node scripts/addapp/add-app.mjs --name $(NAME) --type $(TYPE) --port $(or $(PORT),3000) $(if $(SUB),--subdomain $(SUB),) $(AUTH)
	node scripts/addapp/gen-app-ci.mjs

validate-apps:
	node scripts/addapp/validate-app.mjs

gen-app-ci:
	node scripts/addapp/gen-app-ci.mjs

dump-config:
	node caddy/scripts/dump-config.mjs

# ── Orchestrator sidecar (RTDB-as-Consul) ───────────────────────────────────
# Xem trạng thái consul (leader + nodes) từ RTDB. Cần ORCH_RTDB_* trong .env.
orch-status:
	node orchestrator/scripts/status.mjs

# Ghi trạng thái node hiện tại lên RTDB + heartbeat (chạy trên host/CI, YC①).
orch-register:
	node orchestrator/scripts/register.mjs ready

# Lắng nghe node mới ready trên RTDB (YC②). Thêm --run-pipeline để chạy hook.
orch-watch:
	node orchestrator/scripts/watch.mjs
