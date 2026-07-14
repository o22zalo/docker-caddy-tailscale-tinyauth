.PHONY: up up-ci up-core up-full up-ts down logs ps config profiles test-ci user tunnel-url ts-status

# Uses COMPOSE_PROFILES from .env (default in .env.example: core)
up:
	docker compose up -d --remove-orphans

up-core:
	COMPOSE_PROFILES=core docker compose up -d --remove-orphans

up-full:
	COMPOSE_PROFILES=full docker compose up -d --remove-orphans

up-ts:
	COMPOSE_PROFILES=core,tailscale docker compose up -d --remove-orphans

up-ci:
	COMPOSE_PROFILES=core docker compose -f docker-compose.yml -f docker-compose.ci.yml up -d --remove-orphans

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
	bash scripts/wait-and-test.sh

user:
	node tinyauth/scripts/generate-user.mjs

tunnel-url:
	bash cloudflare/scripts/extract-tunnel-url.sh

ts-status:
	bash tailscale/scripts/status.sh
