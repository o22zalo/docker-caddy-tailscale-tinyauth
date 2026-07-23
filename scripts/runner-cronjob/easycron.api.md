# EasyCron API

Updated: 2026-07-23

Links:
- API docs: https://developer.easycron.com/docs/api
- Create cron job: https://developer.easycron.com/docs/api/v1/cron-jobs/post
- Dashboard: https://www.easycron.com/user

Status in repo: implemented. `keepalive-dispatch.mjs` creates an EasyCron job
when `CRONJOB_EASYCRON_ENABLE=true`.

### One-shot mode (--mark-start)

When called at `--mark-start`, the cron expression is pinned to the exact `nextRunAt` datetime:
`{minute} {hour} {day} {month} *`

Example — run at 2026-07-23 08:58 Asia/Bangkok: `58 8 23 7 *`

EasyCron does not have a native one-shot/expires feature. The job will repeat on the same minute/hour next month unless manually deleted.

## Endpoint

```text
POST https://api.easycron.com/v1/cron-jobs
```

Auth:

```text
X-API-Key: <CRONJOB_EASYCRON_API_KEY>
```

## Request Shape

```json
{
  "url": "https://api.github.com/repos/owner/repo/actions/workflows/test.yml/dispatches",
  "cron_expression": "0 * * * *",
  "timezone": "Asia/Bangkok",
  "http_method": "POST",
  "http_headers": "Authorization: Bearer <CRONJOB_DISPATCH_PAT>\nAccept: application/vnd.github+json",
  "http_message_body": "{\"ref\":\"main\",\"inputs\":{\"run_group\":\"stack-test-main\"}}",
  "status": 1,
  "cron_job_name": "proxy-stack-keepalive"
}
```

## Env

`CRONJOB_EASYCRON_ENABLE=true`: enable this channel.

`CRONJOB_EASYCRON_API_KEY`: EasyCron API key.

`CRONJOB_EASYCRON_API`: override API endpoint, default
`https://api.easycron.com/v1/cron-jobs`.

`CRONJOB_EASYCRON_CRON`: cron expression, default `0 * * * *`.

`CRONJOB_EASYCRON_TIMEOUT`: request timeout, default `0`.

`CRONJOB_DISPATCH_PAT`: GitHub PAT sent to GitHub.

