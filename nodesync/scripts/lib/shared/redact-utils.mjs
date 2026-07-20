export function redactSecrets(value) {
  return String(value)
    .replace(/^(\s*-?\s*["']?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|AUTH|KEY|COOKIE|CREDENTIAL|ACCOUNT_ID|CLIENT_ID|CLIENT_SECRET|USERS)[A-Z0-9_]*["']?\s*[:=]\s*).+$/gmi, "$1[REDACTED]")
    .replace(/("?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|AUTH|KEY|COOKIE|CREDENTIAL|ACCOUNT_ID|CLIENT_ID|CLIENT_SECRET|USERS)[A-Z0-9_]*"?=)[^",\]\s]+/gi, "$1[REDACTED]")
    .replace(/((?:access-key-id|secret-access-key):\s*).+/gi, "$1[REDACTED]");
}
