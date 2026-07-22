# Upstash QStash Schedules API

Updated: 2026-07-22

Links:
- Schedules API: https://upstash.com/docs/qstash/api/schedules/create
- QStash overview: https://upstash.com/docs/qstash
- Console: https://console.upstash.com/qstash

Status in repo: implemented. `keepalive-dispatch.mjs` creates/updates a QStash
schedule when `CRONJOB_QSTASH_ENABLE=true`.

## Endpoint

```text
POST https://qstash.upstash.io/v2/schedules/{destination}
GET  https://qstash.upstash.io/v2/schedules
GET  https://qstash.upstash.io/v2/schedules/{scheduleId}
DELETE https://qstash.upstash.io/v2/schedules/{scheduleId}
```

Auth:

```text
Authorization: Bearer <CRONJOB_QSTASH_TOKEN>
```

Important headers:

```text
Upstash-Cron: 0 * * * *
Upstash-Method: POST
Upstash-Schedule-Id: gh-keepalive-stack-test-main
Upstash-Forward-Authorization: Bearer <CRONJOB_DISPATCH_PAT>
Upstash-Forward-Accept: application/vnd.github+json
Upstash-Forward-X-GitHub-Api-Version: 2022-11-28
Content-Type: application/json
```

`Upstash-Forward-*` sends headers to GitHub after removing the prefix.

## Env

`CRONJOB_QSTASH_TOKEN`: QStash token from Upstash Console.

`CRONJOB_QSTASH_ENABLE=true`: enable this channel.

`CRONJOB_QSTASH_CRON`: cron expression, default `0 * * * *`.

`CRONJOB_QSTASH_SCHEDULE_ID`: stable schedule ID. Reusing an ID updates the
same schedule instead of creating duplicates.

`CRONJOB_DISPATCH_PAT`: GitHub PAT forwarded to GitHub.
