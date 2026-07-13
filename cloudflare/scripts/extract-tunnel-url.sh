#!/usr/bin/env bash
# Cloudflare: print the quick-tunnel URL (*.trycloudflare.com) from cloudflared logs.
# Exit 0 and print URL on stdout when found; exit 1 if not found within timeout.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TIMEOUT="${1:-${TEST_TIMEOUT:-120}}"
INTERVAL="${2:-5}"

deadline=$((SECONDS + TIMEOUT))
while (( SECONDS < deadline )); do
  logs="$(docker compose logs --no-color cloudflared 2>&1 || true)"
  candidate="$(echo "$logs" | grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' | head -1 || true)"
  if [[ -n "$candidate" ]]; then
    echo "$candidate"
    exit 0
  fi
  sleep "$INTERVAL"
done

echo "ERROR: no trycloudflare.com URL found in cloudflared logs within ${TIMEOUT}s" >&2
exit 1
