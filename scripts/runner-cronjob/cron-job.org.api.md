# cron-job.org API

Updated: 2026-07-22

Links:
- API docs: https://docs.cron-job.org/rest-api.html
- Dashboard: https://console.cron-job.org/
- Service: https://cron-job.org/

## Endpoint

Base URL:

```text
https://api.cron-job.org
```

Create job:

```text
PUT or POST /jobs
```

Auth:

```text
Authorization: Bearer <CRONJOB_CRONJOBORG_API_KEY>
Content-Type: application/json
```

## GitHub Dispatch Job Shape

`keepalive-dispatch.mjs` creates a POST job pointed at the GitHub workflow
dispatch endpoint:

```json
{
  "job": {
    "title": "proxy-stack-keepalive",
    "enabled": true,
    "saveResponses": false,
    "url": "https://api.github.com/repos/owner/repo/actions/workflows/test.yml/dispatches",
    "requestMethod": 1,
    "schedule": {
      "timezone": "Asia/Bangkok",
      "hours": [-1],
      "mdays": [-1],
      "minutes": [0],
      "months": [-1],
      "wdays": [-1]
    },
    "requestHeaders": [
      { "name": "Authorization", "value": "Bearer <CRONJOB_DISPATCH_PAT>" },
      { "name": "Accept", "value": "application/vnd.github+json" },
      { "name": "Content-Type", "value": "application/json" }
    ],
    "requestBody": "{\"ref\":\"main\",\"inputs\":{\"run_group\":\"stack-test-main\"}}"
  }
}
```

`requestMethod: 1` means POST in cron-job.org API.

## Env

`CRONJOB_CRONJOBORG_ENABLE=true`: enable this channel.

`CRONJOB_CRONJOBORG_API_KEY`: cron-job.org API key from the dashboard.

`CRONJOB_CRONJOBORG_MINUTE`: minute of each hour, `0` to `59`.

`CRONJOB_DISPATCH_PAT`: GitHub PAT used by cron-job.org to call GitHub.

`CRONJOB_JOB_TITLE`: display name for the cron job.

