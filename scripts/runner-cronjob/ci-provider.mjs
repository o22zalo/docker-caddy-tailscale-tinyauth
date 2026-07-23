#!/usr/bin/env node
// Detect CI provider from official environment variables only.

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");

import { existsSync, readFileSync } from "node:fs";

export function detectCiProvider(env = process.env) {
  if (env.GITHUB_ACTIONS === "true") return "github";
  if (env.TF_BUILD === "True" || env.TF_BUILD === "true") return "azure";
  return "local";
}

export function workflowContext(env = process.env) {
  const provider = detectCiProvider(env);
  if (provider === "github") {
    const [owner = "", repo = ""] = String(env.GITHUB_REPOSITORY || "").split("/");
    const workflow = String(env.GITHUB_WORKFLOW_REF || "").match(/\/\.github\/workflows\/([^@]+)@/)?.[1] || "test.yml";
    const ref = env.GITHUB_REF_NAME || "main";
    
    let runGroup = env.CRONJOB_RUN_GROUP;
    if (!runGroup && env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH)) {
      try {
        runGroup = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")).inputs?.run_group;
      } catch {}
    }
    if (!runGroup) {
      runGroup = `${env.GITHUB_WORKFLOW || "stack-test"}-${ref}`;
    }

    return {
      provider,
      owner,
      repo,
      workflow,
      ref,
      runGroup,
      apiBase: env.GITHUB_API_URL || "https://api.github.com",
    };
  }
  if (provider === "azure") {
    // Azure DevOps: BUILD_REPOSITORY_NAME = "owner/repo" or just "repo"
    const repoName = String(env.BUILD_REPOSITORY_NAME || "");
    const parts = repoName.split("/");
    const owner = parts.length > 1 ? parts[0] : (env.BUILD_REPOSITORY_URI?.match(/\/([^/]+)\/([^/]+?)(?:\.git)?$/)?.[1] || "");
    const repo = parts.length > 1 ? parts[1] : repoName;
    const workflow = env.BUILD_DEFINITIONNAME || "azure-pipelines.yml";
    const ref = (env.BUILD_SOURCEBRANCH || "").replace(/^refs\/heads\//, "") || "main";
    const runGroup = env.CRONJOB_RUN_GROUP || `${workflow}-${ref}`;

    return {
      provider,
      owner,
      repo,
      workflow,
      ref,
      runGroup,
      apiBase: env.SYSTEM_TEAMFOUNDATIONSERVERURI || "https://dev.azure.com/",
      buildId: env.BUILD_BUILDID,
      project: env.SYSTEM_TEAMPROJECT,
    };
  }
  return { provider };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  void DRY_RUN;
  if (!SILENT) console.log(JSON.stringify(workflowContext()));
}
