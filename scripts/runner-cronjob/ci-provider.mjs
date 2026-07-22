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
  return { provider };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  void DRY_RUN;
  if (!SILENT) console.log(JSON.stringify(workflowContext()));
}
