# Generic Webhook Channel

Updated: 2026-07-22

This channel is for a self-hosted or third-party endpoint that receives the
computed GitHub dispatch URL and body, then performs the dispatch itself.

## Request Shape

`keepalive-dispatch.mjs` sends:

```text
POST <CRONJOB_WEBHOOK_URL>
Authorization: Bearer <CRONJOB_WEBHOOK_TOKEN>
Content-Type: application/json
```

Body:

```json
{
  "url": "https://api.github.com/repos/owner/repo/actions/workflows/test.yml/dispatches",
  "body": {
    "ref": "main",
    "inputs": {
      "run_group": "stack-test-main",
      "next_run_enable": "true",
      "next_run_minutes": "58"
    }
  }
}
```

## Env

`CRONJOB_WEBHOOK_ENABLE=true`: enable this channel.

`CRONJOB_WEBHOOK_URL`: HTTPS endpoint to call.

`CRONJOB_WEBHOOK_TOKEN`: optional bearer token for the webhook.
