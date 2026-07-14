#!/usr/bin/env bash
# Stack-wide: start compose project according to COMPOSE_PROFILES in .env
# (and optional CLI profiles / mode).
#
# Usage:
#   ./scripts/up.sh              # uses COMPOSE_PROFILES from .env (default core)
#   ./scripts/up.sh ci           # CI / quick-tunnel override compose file
#   ./scripts/up.sh full         # force COMPOSE_PROFILES=full for this run
#   ./scripts/up.sh core         # force core
#   ./scripts/up.sh caddy whoami # force only these profiles
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.example and fill secrets:"
  echo "  cp .env.example .env"
  exit 1
fi

DEMO_HASH='$$2a$$10$$UdLYoJ5lgPsC0RKqYH/jMua7zIn0g9kPqWmhYayJYLaZQ/FTmH2/u'
if grep -qF "$DEMO_HASH" .env 2>/dev/null; then
  echo "WARNING: TINYAUTH_AUTH_USERS uses the demo password (user:password)."
  echo "         Change it before production! ./tinyauth/scripts/generate-user.mjs"
fi

MODE="prod"
EXTRA_PROFILES=()

if [[ "${1:-}" == "ci" ]]; then
  MODE="ci"
  shift || true
fi

# Remaining args = profile names to force for this invocation
if [[ $# -gt 0 ]]; then
  # Join as COMPOSE_PROFILES for this process only
  export COMPOSE_PROFILES="$*"
  echo "Forcing COMPOSE_PROFILES=${COMPOSE_PROFILES}"
else
  # Show what .env provides (compose loads .env automatically)
  if grep -qE '^COMPOSE_PROFILES=' .env 2>/dev/null; then
    echo "Using COMPOSE_PROFILES from .env: $(grep -E '^COMPOSE_PROFILES=' .env | head -1 | cut -d= -f2-)"
  else
    echo "WARN: COMPOSE_PROFILES not set in .env — no profiled services will start."
    echo "      Set e.g. COMPOSE_PROFILES=core  (see .env.example)"
  fi
fi

# Auto-add tailscale profile when auth key present and not already covered
if grep -qE '^TS_AUTHKEY=.+' .env 2>/dev/null; then
  current="${COMPOSE_PROFILES:-}"
  if [[ -z "$current" ]] && grep -qE '^COMPOSE_PROFILES=' .env; then
    current="$(grep -E '^COMPOSE_PROFILES=' .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
  fi
  case ",${current}," in
    *,full,*|*,tailscale,*) ;;
    *)
      if [[ -n "${COMPOSE_PROFILES:-}" ]]; then
        export COMPOSE_PROFILES="${COMPOSE_PROFILES},tailscale"
      else
        # Let compose read .env, but pass extra CLI profile
        EXTRA_PROFILES+=(--profile tailscale)
      fi
      echo "TS_AUTHKEY present → ensuring Tailscale profile is enabled"
      ;;
  esac
fi

if [[ "$MODE" == "ci" ]]; then
  echo "Starting stack in CI / quick-tunnel mode..."
  docker compose -f docker-compose.yml -f docker-compose.ci.yml "${EXTRA_PROFILES[@]}" up -d --remove-orphans
else
  echo "Starting stack..."
  docker compose "${EXTRA_PROFILES[@]}" up -d --remove-orphans
fi

docker compose ps
echo
echo "Active profiles tip: echo \$COMPOSE_PROFILES or check .env"
echo "Tunnel logs: docker compose logs -f cloudflared"
echo "Tinyauth user: ./tinyauth/scripts/generate-user.mjs"
