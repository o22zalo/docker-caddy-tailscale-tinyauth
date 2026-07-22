# FastCron REST API

Updated: 2026-07-22

Links:
- API docs: https://www.fastcron.com/docs/api
- Dashboard: https://www.fastcron.com/user

Status in repo: implemented. `keepalive-dispatch.mjs` creates a FastCron job
when `CRONJOB_FASTCRON_ENABLE=true`.

## Endpoint

Base URL:

```text
https://www.fastcron.com/api/v1/{function}
```

Common functions:

```text
cron_list
cron_get
cron_add
cron_edit
cron_enable
cron_disable
cron_delete
cron_logs
cron_next
cron_batch_add
```

Auth: send `token` in JSON body/query, or `Authorization: Bearer <token>`.

## cron_add Shape

```json
{
  "token": "<CRONJOB_FASTCRON_TOKEN>",
  "url": "https://api.github.com/repos/owner/repo/actions/workflows/test.yml/dispatches",
  "expression": "0 * * * *",
  "httpMethod": "POST",
  "postData": "{\"ref\":\"main\",\"inputs\":{\"run_group\":\"stack-test-main\"}}",
  "httpHeaders": "Authorization: Bearer <CRONJOB_DISPATCH_PAT>\rAccept: application/vnd.github+json\rX-GitHub-Api-Version: 2022-11-28\rContent-Type: application/json",
  "timezone": "Asia/Bangkok",
  "name": "gh-keepalive-stack-test-main",
  "instances": 1
}
```

## Env

`CRONJOB_FASTCRON_TOKEN`: FastCron API token from Profile/API settings.

`CRONJOB_FASTCRON_ENABLE=true`: enable this channel.

`CRONJOB_FASTCRON_EXPRESSION`: cron expression, default `0 * * * *`.

`CRONJOB_FASTCRON_TIMEOUT`: request timeout, default `30`.

`CRONJOB_DISPATCH_PAT`: GitHub PAT sent to GitHub.

`CRONJOB_TZ`: timezone for the cron expression.
