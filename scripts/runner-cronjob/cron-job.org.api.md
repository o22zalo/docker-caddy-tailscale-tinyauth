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
    "saveResponses": true,
    "url": "https://api.github.com/repos/owner/repo/actions/workflows/test.yml/dispatches",
    "requestMethod": 1,
    "redirectSuccess": true,
    "schedule": {
      "timezone": "Asia/Bangkok",
      "expiresAt": 0,
      "hours": [-1],
      "mdays": [-1],
      "minutes": [0],
      "months": [-1],
      "wdays": [-1]
    },
    "extendedData": {
      "headers": {
        "Authorization": "Bearer <CRONJOB_DISPATCH_PAT>",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      "body": "{\"ref\":\"main\",\"inputs\":{\"run_group\":\"stack-test-main\"}}"
    },
    "notification": {
      "onFailure": true,
      "onFailureCount": 3,
      "onSuccess": true,
      "onDisable": true
    }
  }
}
```

`requestMethod: 1` means POST in cron-job.org API.

`redirectSuccess: true` treats HTTP 3xx redirect responses as a successful execution instead of a failure.

`saveResponses: true` stores the response headers/body of each execution in the job history (viewable via `GET /jobs/<jobId>/history/<identifier>`).

### Notification Settings

The `notification` object (only present on `DetailedJob`, i.e. `GET /jobs/<jobId>` and job create/update payloads) controls when cron-job.org emails you about this job's status:

| Field                    | Type        | Default           | Meaning                                                                                                                                                             |
| ------------------------ | ----------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onFailure`              | boolean     | `false`           | Send a notification when the job execution fails.                                                                                                                   |
| `onFailureCount`         | int (min 1) | `1`               | Number of _consecutive_ failures required before the failure notification fires. `3` means "notify after the 3rd failure in a row," not on every failure.           |
| `onSuccess`              | boolean     | `false`           | Send a notification when the job succeeds again after a prior failure (recovery notice).                                                                            |
| `onDisable`              | boolean     | `false`           | Send a notification when cron-job.org auto-disables the job (this happens automatically after too many consecutive failures — currently 25 on cron-job.org's side). |
| `onSslCertExpiry`        | boolean     | `false`           | Send a notification when the target's TLS certificate is about to expire.                                                                                           |
| `onSslCertExpirySeconds` | int (min 0) | `604800` (7 days) | How far ahead of expiry to send the SSL notice.                                                                                                                     |

### Running a Job Exactly Once

cron-job.org's `schedule` object is cron-style (hour/day/month/weekday match), so there's no dedicated "run once" flag. To make a job fire a single time and never again, combine two things:

1. **Pin every schedule field to the exact match instead of `-1` (wildcard).** Set `hours`, `mdays`, `minutes`, and `months` to the specific values of the one moment you want it to run (leave `wdays: [-1]` since day-of-month already narrows it to one day).
2. **Set `schedule.expiresAt`** to a timestamp shortly _after_ that moment, in the format `YYYYMMDDhhmmss` (job's own timezone). Once passed, cron-job.org stops scheduling the job entirely — this is what prevents it from firing again on the same hour/minute next month or next year. `expiresAt: 0` (the default) means "never expires," which is correct for recurring jobs but wrong for one-off jobs.

Example — run once at 2026-07-25 15:30 `Asia/Bangkok`, then never again:

```json
"schedule": {
  "timezone": "Asia/Bangkok",
  "expiresAt": 20260725160000,
  "hours": [15],
  "mdays": [25],
  "minutes": [30],
  "months": [7],
  "wdays": [-1]
}
```

`expiresAt` here is set ~30 minutes after the run time — enough buffer for the scheduled execution to actually fire before the job expires, but tight enough that it can't run again later.

## Env

`CRONJOB_CRONJOBORG_ENABLE=true`: enable this channel.

`CRONJOB_CRONJOBORG_API_KEY`: cron-job.org API key from the dashboard.

`CRONJOB_CRONJOBORG_MINUTE`: minute of each hour, `0` to `59`.

`CRONJOB_DISPATCH_PAT`: GitHub PAT used by cron-job.org to call GitHub.

`CRONJOB_JOB_TITLE`: display name for the cron job.
