#!/usr/bin/env bash
# Tailscale: show node status inside the stack container (profile "tailscale").
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if ! docker compose ps --status running --services 2>/dev/null | grep -qx tailscale; then
  echo "ERROR: tailscale is not running. Start with:" >&2
  echo "  docker compose --profile tailscale up -d" >&2
  exit 1
fi

docker compose exec -T tailscale tailscale status
