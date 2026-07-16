// orchestrator/scripts/lib/log.mjs
// Structured, prefixed, secret-redacting logger cho sidecar.

const SILENT = process.argv.includes("--silent");

// Redact các token/secret hay lộ trong log.
export function redact(value) {
  return String(value ?? "")
    .replace(/(TUNNEL_TOKEN|CF_TUNNEL_TOKEN|TS_AUTHKEY)=([^\s;&]+)/gi, "$1=<hidden>")
    .replace(/("private_key"\s*:\s*")[^"]+/gi, '$1<hidden>')
    .replace(/(eyJ[A-Za-z0-9_-]{10,})/g, "<jwt-redacted>")
    .replace(/(token|secret|password|apikey|api_key)"?\s*[:=]\s*"?[^"\s,}]+/gi, "$1=<hidden>");
}

function ts() {
  return new Date().toISOString();
}

export function log(...args) {
  if (SILENT) return;
  console.log(`[orchestrator ${ts()}]`, ...args.map((a) => (typeof a === "string" ? redact(a) : a)));
}

export function warn(...args) {
  if (SILENT) return;
  console.warn(`[orchestrator ${ts()}] WARN`, ...args.map((a) => (typeof a === "string" ? redact(a) : a)));
}

export function error(...args) {
  console.error(`[orchestrator ${ts()}] ERROR`, ...args.map((a) => (typeof a === "string" ? redact(a) : a)));
}
