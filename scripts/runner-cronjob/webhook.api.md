# Generic Webhook Channel

Updated: 2026-07-23

This channel is for a self-hosted or third-party endpoint that receives the
computed GitHub dispatch URL and body, then performs the dispatch itself.

## Request Shape

`keepalive-dispatch.mjs` sends:

```text
POST <CRONJOB_WEBHOOK_URL>
Authorization: Bearer <CRONJOB_WEBHOOK_TOKEN>
Content-Type: application/json
```

Body (when called at `--mark-start`, includes `scheduled_at`):

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
  },
  "scheduled_at": "2026-07-23T08:58:00.000Z"
}
```

`scheduled_at` is the ISO8601 UTC timestamp of `nextRunAt` — the moment the webhook receiver should trigger the dispatch. Omitted when called from P7 (no scheduled time).

## Env

`CRONJOB_WEBHOOK_ENABLE=true`: enable this channel.

`CRONJOB_WEBHOOK_URL`: HTTPS endpoint to call.

`CRONJOB_WEBHOOK_TOKEN`: optional bearer token for the webhook.
