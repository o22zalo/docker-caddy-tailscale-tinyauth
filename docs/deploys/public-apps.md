# Public apps without Tinyauth

Use this when an app should be reachable through Cloudflare Tunnel + Caddy without a login wall.

## whoami

Default: public, no Tinyauth.

```env
WHOAMI_HOST=http://whoami.example.com
WHOAMI_TINYAUTH_ENABLED=false
```

Enable login only when needed:

```env
WHOAMI_TINYAUTH_ENABLED=true
```

Then restart Caddy so `caddy-docker-proxy` reloads the env-backed matcher:

```bash
docker compose up -d caddy whoami
```

## New app

For a public app, do not import `tinyauth_forwarder`.

```yaml
services:
  myapp:
    image: example/myapp:latest
    networks:
      - proxy
    labels:
      caddy: ${MYAPP_HOST:-http://myapp.${DOMAIN:-localhost}}
      caddy.reverse_proxy: "{{upstreams 8080}}"
```

For a protected app, add the import:

```yaml
labels:
  caddy: ${MYAPP_HOST:-http://myapp.${DOMAIN:-localhost}}
  caddy.reverse_proxy: "{{upstreams 8080}}"
  caddy.import: tinyauth_forwarder *
```

## Cloudflare

Public Hostname still points to Caddy:

```text
myapp.example.com -> http://caddy:80
```

Caddy decides whether the route is public or protected from the service labels.

