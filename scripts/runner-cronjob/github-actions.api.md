# GitHub Actions Workflow Dispatch API

Updated: 2026-07-22

Links:
- REST endpoint: https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
- Workflow syntax: https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions
- Fine-grained PAT permissions: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens

## Endpoint

```text
POST https://api.github.com/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches
```

`workflow_id` may be the workflow file name, for example `test.yml`.

Required headers:

```text
Authorization: Bearer <token>
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
Content-Type: application/json
```

Body:

```json
{
  "ref": "main",
  "inputs": {
    "run_group": "stack-test-main",
    "next_run_enable": "true",
    "next_run_minutes": "58"
  }
}
```

Expected success: `204 No Content`.

## Env

`CRONJOB_GITHUB_TOKEN`: token used by in-run self-dispatch. In GitHub Actions,
leave unset and use `${{ github.token }}` / `GITHUB_TOKEN`.

`CRONJOB_DISPATCH_PAT`: token used by external schedulers. Use a fine-grained PAT
scoped to the repository with Actions read/write.

`CRONJOB_OWNER`, `CRONJOB_REPO`, `CRONJOB_WORKFLOW`, `CRONJOB_REF`: override the
target workflow. In GitHub Actions these fall back to the current workflow.

`CRONJOB_RUN_GROUP`: shared concurrency group. Keep this identical for
self-dispatch and external channels.

`CRONJON_NEXT_RUN_ENABLE`: controls next-run dispatch. Empty value means enabled.
Accepted truthy values include `true`, `1`, `yes`, and `on`.

`CRONJON_NEXT_RUN_MINUTES`: expected workflow lifetime in minutes. The script
uses `ci-logs/runner-cronjob-started-at.txt + CRONJON_NEXT_RUN_MINUTES` to decide
when dispatch is allowed.
