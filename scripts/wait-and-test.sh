#!/usr/bin/env bash
# Stack-wide: wait for services, discover public URL, verify external access.
# Uses cloudflare/scripts/extract-tunnel-url.sh for quick-tunnel discovery.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TIMEOUT="${TEST_TIMEOUT:-180}"
INTERVAL=5
PUBLIC_URL="${PUBLIC_URL:-}"
CF_EXTRACT="$ROOT/cloudflare/scripts/extract-tunnel-url.sh"

env_get() {
  local key="$1"
  local file="${2:-.env}"
  [[ -f "$file" ]] || return 0
  grep -E "^${key}=" "$file" | head -1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

echo "==> Waiting for core containers..."
deadline=$((SECONDS + TIMEOUT))
while (( SECONDS < deadline )); do
  running="$(docker compose ps --status running --services 2>/dev/null || true)"
  if echo "$running" | grep -qx caddy \
    && echo "$running" | grep -qx whoami \
    && echo "$running" | grep -qx cloudflared; then
    echo "    caddy, whoami, cloudflared are running"
    break
  fi
  sleep "$INTERVAL"
done

running="$(docker compose ps --status running --services 2>/dev/null || true)"
if ! echo "$running" | grep -qx cloudflared; then
  echo "ERROR: cloudflared is not running"
  docker compose ps || true
  docker compose logs --no-color cloudflared || true
  exit 1
fi

echo "==> Probing local Caddy..."
local_ok=0
for port in 8080 80; do
  for _ in $(seq 1 20); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${port}/" 2>/dev/null || echo 000)"
    if [[ "$code" =~ ^(200|301|302|307|401|403)$ ]]; then
      echo "    localhost:${port} → HTTP $code"
      local_ok=1
      break 2
    fi
    sleep 2
  done
done
if [[ "$local_ok" -ne 1 ]]; then
  echo "WARN: local Caddy not ready on :8080/:80 (continuing with public tunnel check)"
  docker compose logs --no-color --tail=40 caddy || true
fi

# Discover public URL
if [[ -z "$PUBLIC_URL" ]]; then
  TUNNEL_TOKEN="$(env_get TUNNEL_TOKEN)"
  WHOAMI_HOST="$(env_get WHOAMI_HOST)"
  DOMAIN="$(env_get DOMAIN)"

  if [[ -n "${TUNNEL_TOKEN:-}" ]]; then
    if [[ -n "${WHOAMI_HOST:-}" ]]; then
      PUBLIC_URL="$(echo "$WHOAMI_HOST" | sed -e 's#^http://#https://#' -e 's#^https://#https://#')"
      if [[ "$PUBLIC_URL" != https://* && "$PUBLIC_URL" != http://* ]]; then
        PUBLIC_URL="https://${PUBLIC_URL}"
      fi
    elif [[ -n "${DOMAIN:-}" ]]; then
      PUBLIC_URL="https://whoami.${DOMAIN}"
    fi
    echo "==> Named tunnel mode → testing ${PUBLIC_URL:-"(unset)"}"
  fi
fi

if [[ -z "$PUBLIC_URL" ]]; then
  echo "==> Extracting Cloudflare quick-tunnel URL..."
  if [[ -x "$CF_EXTRACT" ]] || [[ -f "$CF_EXTRACT" ]]; then
    chmod +x "$CF_EXTRACT" 2>/dev/null || true
    PUBLIC_URL="$("$CF_EXTRACT" "$TIMEOUT" "$INTERVAL")" || PUBLIC_URL=""
  else
    echo "ERROR: missing $CF_EXTRACT" >&2
    exit 1
  fi
fi

if [[ -z "$PUBLIC_URL" ]]; then
  echo "ERROR: could not determine PUBLIC_URL"
  echo "--- cloudflared logs ---"
  docker compose logs --no-color cloudflared || true
  echo "--- caddy logs ---"
  docker compose logs --no-color --tail=80 caddy || true
  exit 1
fi

echo "==> Public URL: $PUBLIC_URL"
echo "==> Verifying external HTTP access..."

ext_ok=0
code="000"
for i in $(seq 1 36); do
  code="$(curl -sS -o /tmp/proxy-stack-body.txt -w '%{http_code}' --max-time 20 -L "$PUBLIC_URL/" 2>/dev/null || echo 000)"
  echo "    attempt $i: HTTP $code"
  if [[ "$code" =~ ^(200|301|302|307|401|403)$ ]]; then
    ext_ok=1
    break
  fi
  sleep 5
done

if [[ "$ext_ok" -ne 1 ]]; then
  echo "ERROR: public URL did not become reachable (last HTTP $code)"
  echo "--- response body ---"
  cat /tmp/proxy-stack-body.txt 2>/dev/null || true
  echo "--- cloudflared logs ---"
  docker compose logs --no-color cloudflared || true
  echo "--- caddy logs ---"
  docker compose logs --no-color --tail=100 caddy || true
  echo "--- whoami logs ---"
  docker compose logs --no-color --tail=50 whoami || true
  exit 1
fi

echo
echo "SUCCESS: stack is reachable from the outside"
echo "  URL:  $PUBLIC_URL"
echo "  HTTP: $code"
if [[ -f /tmp/proxy-stack-body.txt ]]; then
  echo "  Body (first 20 lines):"
  head -n 20 /tmp/proxy-stack-body.txt || true
fi

echo "$PUBLIC_URL" > /tmp/proxy-stack-public-url.txt
echo "$PUBLIC_URL" > "$ROOT/public-url.txt"
