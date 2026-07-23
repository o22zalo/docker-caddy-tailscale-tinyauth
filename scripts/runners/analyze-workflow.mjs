#!/usr/bin/env node
// scripts/runners/analyze-workflow.mjs
// CI: analyze workflow run — detect errors, measure timing, suggest improvements.
//
// Reads from ci-logs/ directory (created by collect-logs.mjs).
// Outputs markdown report to GITHUB_STEP_SUMMARY and console.
// Env vars: GITHUB_STEP_SUMMARY, GITHUB_RUN_ID, GITHUB_SHA, MODE.
//
// Flags:
//   --dry-run   Show what would be analyzed without running
//   --silent    Suppress console output
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const LOG_DIR = resolve(ROOT, "ci-logs");
const GITHUB_STEP_SUMMARY = process.env.GITHUB_STEP_SUMMARY;
const IS_AZURE = process.env.TF_BUILD === "True" || process.env.TF_BUILD === "true" || !!process.env.BUILD_BUILDID;
const MODE = process.env.MODE || "unknown";

process.chdir(ROOT);

// ── Error patterns to detect ─────────────────────────────────────────
const ERROR_PATTERNS = [
  // Docker/Compose errors
  { regex: /error.*starting container/i, category: "docker", severity: "critical" },
  { regex: /container.*exited with code/i, category: "docker", severity: "critical" },
  { regex: /port is already allocated/i, category: "docker", severity: "critical" },
  { regex: /no such image/i, category: "docker", severity: "high" },
  { regex: /pull access denied/i, category: "docker", severity: "high" },
  { regex: /manifest.*not found/i, category: "docker", severity: "high" },
  
  // Network errors
  { regex: /connection refused/i, category: "network", severity: "high" },
  { regex: /ECONNREFUSED/i, category: "network", severity: "high" },
  { regex: /ETIMEDOUT/i, category: "network", severity: "high" },
  { regex: /network.*not found/i, category: "network", severity: "critical" },
  
  // Service-specific errors
  { regex: /cloudflared.*error/i, category: "cloudflare", severity: "high" },
  { regex: /failed to connect to cloudflare/i, category: "cloudflare", severity: "critical" },
  { regex: /tinyauth.*error/i, category: "tinyauth", severity: "high" },
  { regex: /caddy.*error/i, category: "caddy", severity: "high" },
  { regex: /tailscale.*error/i, category: "tailscale", severity: "high" },
  { regex: /dozzle.*error/i, category: "dozzle", severity: "high" },
  { regex: /filebrowser.*error/i, category: "filebrowser", severity: "high" },
  { regex: /webssh.*error|ttyd.*error|tmux.*error/i, category: "webssh", severity: "high" },
  
  // Config errors
  { regex: /invalid.*config/i, category: "config", severity: "high" },
  { regex: /missing.*environment/i, category: "config", severity: "medium" },
  { regex: /env.*not set/i, category: "config", severity: "medium" },
  
  // Build errors
  { regex: /build.*failed/i, category: "build", severity: "critical" },
  { regex: /dockerfile.*not found/i, category: "build", severity: "critical" },
];

// ── Improvement suggestions ──────────────────────────────────────────
const IMPROVEMENTS = {
  slow_build: {
    condition: (metrics) => metrics.buildTime > 300, // > 5 min
    suggestion: "Build takes >5min. Consider: multi-stage builds, layer caching, smaller base images.",
    priority: "medium"
  },
  slow_pull: {
    condition: (metrics) => metrics.pullTime > 120, // > 2 min
    suggestion: "Image pull takes >2min. Consider: pre-pull in cache step, smaller images, local registry.",
    priority: "medium"
  },
  many_retries: {
    condition: (metrics) => metrics.retryCount > 3,
    suggestion: "Multiple retries detected. Check service dependencies and health checks.",
    priority: "high"
  },
  large_logs: {
    condition: (metrics) => metrics.totalLogSize > 10 * 1024 * 1024, // > 10MB
    suggestion: "Logs exceed 10MB. Consider: log rotation, reduce verbosity, structured logging.",
    priority: "low"
  }
};

// ── Helper functions ─────────────────────────────────────────────────
function readLogFiles() {
  if (!existsSync(LOG_DIR)) {
    log("WARN: ci-logs/ directory not found");
    return {};
  }
  
  const logs = {};
  const servicesDir = join(LOG_DIR, "services");
  
  // Read all-services.log
  const allLog = join(LOG_DIR, "all-services.log");
  if (existsSync(allLog)) {
    logs.all = readFileSync(allLog, "utf8");
  }
  
  // Read per-service logs
  if (existsSync(servicesDir)) {
    for (const file of readdirSync(servicesDir)) {
      if (file.endsWith(".log")) {
        const serviceName = file.replace(".log", "").replace(".docker-logs", "");
        const key = file.includes(".docker-logs") ? `${serviceName}_docker` : serviceName;
        logs[key] = readFileSync(join(servicesDir, file), "utf8");
      }
    }
  }
  
  return logs;
}

function detectErrors(logs) {
  const errors = [];
  
  for (const [service, content] of Object.entries(logs)) {
    const lines = content.split("\n");
    
    for (const pattern of ERROR_PATTERNS) {
      for (let i = 0; i < lines.length; i++) {
        if (pattern.regex.test(lines[i])) {
          errors.push({
            service,
            line: i + 1,
            content: lines[i].trim(),
            pattern: pattern.regex.source,
            category: pattern.category,
            severity: pattern.severity
          });
        }
      }
    }
  }
  
  return errors;
}

function extractTiming(logs) {
  const metrics = {
    buildTime: 0,
    pullTime: 0,
    startTime: 0,
    totalTime: 0,
    retryCount: 0,
    totalLogSize: 0
  };
  
  // Calculate total log size
  for (const content of Object.values(logs)) {
    metrics.totalLogSize += Buffer.byteLength(content, "utf8");
  }
  
  // Look for timing patterns in logs
  const allLogs = logs.all || "";
  
  // Count retries
  const retryMatches = allLogs.match(/retry|attempt|retrying/gi);
  metrics.retryCount = retryMatches ? retryMatches.length : 0;
  
  // Extract timestamps if present (ISO format)
  const timestampRegex = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/g;
  const timestamps = [];
  let match;
  while ((match = timestampRegex.exec(allLogs)) !== null) {
    timestamps.push(new Date(match[1]));
  }
  
  if (timestamps.length >= 2) {
    timestamps.sort((a, b) => a - b);
    metrics.totalTime = (timestamps[timestamps.length - 1] - timestamps[0]) / 1000;
  }
  
  return metrics;
}

function analyzeSourceCode(errors) {
  const analysis = [];
  
  // Map error patterns to source files
  const sourceMap = {
    "docker": ["docker-compose.yml", "docker-compose.ci.yml", "*/Dockerfile"],
    "cloudflare": ["cloudflare/cloudflare.yml", "cloudflare/.env.example"],
    "tinyauth": ["tinyauth/tinyauth.yml", "tinyauth/.env.example"],
    "caddy": ["caddy/caddy.yml", "caddy/.env.example"],
    "tailscale": ["tailscale/tailscale.yml", "tailscale/.env.example"],
    "dozzle": ["dozzle/dozzle.yml", "dozzle/.env.example"],
    "filebrowser": ["filebrowser/filebrowser.yml", "filebrowser/.env.example"],
    "webssh": ["webssh/webssh.yml", "webssh/.env.example", "webssh/Dockerfile"],
    "config": [".env", ".env.example", ".env.ci"],
    "network": ["networks/networks.yml"],
    "build": ["*/Dockerfile", "docker-compose.yml"]
  };
  
  // Group errors by category
  const byCategory = {};
  for (const error of errors) {
    if (!byCategory[error.category]) byCategory[error.category] = [];
    byCategory[error.category].push(error);
  }
  
  // For each category, check source files
  for (const [category, categoryErrors] of Object.entries(byCategory)) {
    const files = sourceMap[category] || [];
    const issues = [];
    
    for (const pattern of files) {
      // Use glob to find matching files
      try {
        const found = execSync(`find . -path "./${pattern}" -type f 2>/dev/null || true`, { cwd: ROOT })
          .toString().trim().split("\n").filter(Boolean);
        
        for (const file of found) {
          if (existsSync(file)) {
            const content = readFileSync(file, "utf8");
            const lines = content.split("\n");
            
            // Check for common issues
            const fileIssues = [];
            
            // Check for empty env vars
            if (category === "config") {
              for (let i = 0; i < lines.length; i++) {
                if (/^[A-Z_]+=\s*$/.test(lines[i])) {
                  fileIssues.push({
                    file,
                    line: i + 1,
                    issue: "Empty environment variable",
                    fix: "Set value or comment out the line"
                  });
                }
              }
            }
            
            // Check for missing depends_on
            if (category === "docker" && file.endsWith(".yml")) {
              if (content.includes("depends_on:") && !content.includes("condition: service_healthy")) {
                fileIssues.push({
                  file,
                  line: null,
                  issue: "depends_on without health check condition",
                  fix: "Add 'condition: service_healthy' to depends_on"
                });
              }
            }
            
            if (fileIssues.length > 0) {
              issues.push(...fileIssues);
            }
          }
        }
      } catch {}
    }
    
    if (issues.length > 0) {
      analysis.push({
        category,
        errors: categoryErrors.length,
        issues
      });
    }
  }
  
  return analysis;
}

function generateReport(errors, metrics, sourceAnalysis) {
  const lines = [];
  
  lines.push("## 🔍 Workflow Analysis Report");
  lines.push("");
  lines.push(`**Mode:** ${MODE}`);
  lines.push(`**Run ID:** ${process.env.GITHUB_RUN_ID || "local"}`);
  lines.push(`**Commit:** ${process.env.GITHUB_SHA?.substring(0, 7) || "unknown"}`);
  lines.push("");
  
  // Summary
  lines.push("### 📊 Summary");
  lines.push("");
  lines.push(`- **Errors found:** ${errors.length}`);
  lines.push(`- **Critical:** ${errors.filter(e => e.severity === "critical").length}`);
  lines.push(`- **High:** ${errors.filter(e => e.severity === "high").length}`);
  lines.push(`- **Medium:** ${errors.filter(e => e.severity === "medium").length}`);
  lines.push(`- **Total log size:** ${(metrics.totalLogSize / 1024 / 1024).toFixed(2)} MB`);
  lines.push(`- **Retries detected:** ${metrics.retryCount}`);
  if (metrics.totalTime > 0) {
    lines.push(`- **Total duration:** ${Math.round(metrics.totalTime)}s`);
  }
  lines.push("");
  
  // Errors by service
  if (errors.length > 0) {
    lines.push("### ❌ Errors Detected");
    lines.push("");
    
    const byService = {};
    for (const error of errors) {
      if (!byService[error.service]) byService[error.service] = [];
      byService[error.service].push(error);
    }
    
    for (const [service, serviceErrors] of Object.entries(byService)) {
      lines.push(`#### ${service}`);
      lines.push("");
      lines.push("| Severity | Line | Error |");
      lines.push("|----------|------|-------|");
      
      for (const error of serviceErrors.slice(0, 10)) { // Limit to 10 per service
        const severityIcon = {
          critical: "🔴",
          high: "🟠",
          medium: "🟡",
          low: "🟢"
        }[error.severity] || "⚪";
        
        lines.push(`| ${severityIcon} ${error.severity} | ${error.line} | \`${error.content.substring(0, 80)}\` |`);
      }
      
      if (serviceErrors.length > 10) {
        lines.push(`| ... | ... | *${serviceErrors.length - 10} more errors* |`);
      }
      lines.push("");
    }
  }
  
  // Source code analysis
  if (sourceAnalysis.length > 0) {
    lines.push("### 🔧 Source Code Issues");
    lines.push("");
    
    for (const analysis of sourceAnalysis) {
      lines.push(`**${analysis.category}** (${analysis.errors} errors)`);
      lines.push("");
      
      for (const issue of analysis.issues) {
        const location = issue.line ? `${issue.file}:${issue.line}` : issue.file;
        lines.push(`- \`${location}\`: ${issue.issue}`);
        lines.push(`  **Fix:** ${issue.fix}`);
      }
      lines.push("");
    }
  }
  
  // Improvement suggestions
  const suggestions = [];
  for (const [key, improvement] of Object.entries(IMPROVEMENTS)) {
    if (improvement.condition(metrics)) {
      suggestions.push(improvement);
    }
  }
  
  if (suggestions.length > 0) {
    lines.push("### 💡 Improvement Suggestions");
    lines.push("");
    
    // Sort by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
    
    for (const suggestion of suggestions) {
      const icon = {
        high: "🔴",
        medium: "🟡",
        low: "🟢"
      }[suggestion.priority];
      
      lines.push(`${icon} **${suggestion.priority}:** ${suggestion.suggestion}`);
    }
    lines.push("");
  }
  
  // Quick actions
  lines.push("### 🚀 Quick Actions");
  lines.push("");
  
  if (errors.length > 0) {
    lines.push("1. **Check container logs:** `docker compose logs <service>`");
    lines.push("2. **Verify environment:** `docker compose config`");
    lines.push("3. **Test connectivity:** `docker compose exec <service> ping <target>`");
  } else {
    lines.push("✅ No critical issues detected. Workflow looks healthy!");
  }
  lines.push("");
  
  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────
if (DRY_RUN) {
  log("[DRY RUN] Would analyze ci-logs/ directory");
  log("[DRY RUN] Would check for error patterns in logs");
  log("[DRY RUN] Would generate improvement report");
  process.exit(0);
}

log("Analyzing workflow run...");

// Read logs
const logs = readLogFiles();
if (Object.keys(logs).length === 0) {
  log("No logs found to analyze");
  process.exit(0);
}

// Detect errors
const errors = detectErrors(logs);
log(`Found ${errors.length} errors`);

// Extract timing metrics
const metrics = extractTiming(logs);
log(`Log size: ${(metrics.totalLogSize / 1024 / 1024).toFixed(2)} MB`);

// Analyze source code if errors found
let sourceAnalysis = [];
if (errors.length > 0) {
  log("Analyzing source code for related issues...");
  sourceAnalysis = analyzeSourceCode(errors);
}

// Generate report
const report = generateReport(errors, metrics, sourceAnalysis);

// Output to console
log("\n" + report);

// Write to GitHub Step Summary if available
if (GITHUB_STEP_SUMMARY) {
  try {
    execSync(`cat >> "${GITHUB_STEP_SUMMARY}"`, { input: report });
    log("Report written to GitHub Step Summary");
  } catch (e) {
    console.error("Failed to write to GITHUB_STEP_SUMMARY:", e.message);
  }
}

// Write to Azure Pipelines log attachment if available
if (IS_AZURE) {
  try {
    const reportFile = resolve(LOG_DIR, "workflow-analysis.md");
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(reportFile, report);
    log(`Report written to ${reportFile} (Azure Pipelines)`);
    console.log(`##vso[task.uploadfile]${reportFile}`);
  } catch (e) {
    console.error("Failed to write Azure analysis report:", e.message);
  }
}

// Exit with error if critical issues found
const criticalErrors = errors.filter(e => e.severity === "critical");
if (criticalErrors.length > 0) {
  console.error(`\n❌ ${criticalErrors.length} critical errors detected!`);
  process.exit(1);
}

log("\n✅ Analysis complete");
