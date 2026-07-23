# Upstash QStash API

Updated: 2026-07-23

Links:
- Schedules API: https://upstash.com/docs/qstash/api/schedules/create
- QStash overview: https://upstash.com/docs/qstash
- Console: https://console.upstash.com/qstash

Status in repo: implemented. `keepalive-dispatch.mjs` supports two modes:

- **One-shot (--mark-start)**: `POST /v2/publish` with `Upstash-Not-Before` delivers exactly once at the scheduled time.
- **Recurring fallback (P7 retry)**: `POST /v2/schedules` with `Upstash-Cron` creates a recurring schedule.

## One-shot publish endpoint (preferred)

Used at `--mark-start` to schedule a single delivery at `nextRunAt`.

```text
POST https://qstash.upstash.io/v2/publish/{encodedDestination}
```

Auth:

```text
Authorization: Bearer <CRONJOB_QSTASH_TOKEN>
```

Important headers:

```text
Upstash-Not-Before: <Unix timestamp seconds of nextRunAt>
Upstash-Method: POST
Upstash-Forward-Authorization: Bearer <CRONJOB_DISPATCH_PAT>
Upstash-Forward-Accept: application/vnd.github+json
Upstash-Forward-X-GitHub-Api-Version: 2022-11-28
Upstash-Forward-Content-Type: application/json
Content-Type: application/json
```

`Upstash-Not-Before` = Unix timestamp in seconds. QStash holds the message and delivers it at that time, exactly once.

`Upstash-Forward-*` sends headers to GitHub after removing the prefix.

## Recurring schedule endpoint (P7 fallback)

Used only if `--mark-start` publish failed and P7 needs to retry.

```text
POST https://qstash.upstash.io/v2/schedules/{encodedDestination}
GET  https://qstash.upstash.io/v2/schedules
GET  https://qstash.upstash.io/v2/schedules/{scheduleId}
DELETE https://qstash.upstash.io/v2/schedules/{scheduleId}
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
