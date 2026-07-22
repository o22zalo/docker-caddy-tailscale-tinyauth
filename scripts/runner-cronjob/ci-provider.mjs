#!/usr/bin/env node
// Detect CI provider from official environment variables only.

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");

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
    return {
      provider,
      owner,
      repo,
      workflow,
      ref,
      runGroup: env.CRONJOB_RUN_GROUP || `${env.GITHUB_WORKFLOW || "stack-test"}-${ref}`,
      apiBase: env.GITHUB_API_URL || "https://api.github.com",
    };
  }
  return { provider };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  void DRY_RUN;
  if (!SILENT) console.log(JSON.stringify(workflowContext()));
}
