#!/usr/bin/env node
// scripts/lib/env-utils.mjs
// Shared .env parsing utilities using dotenv.parse (standard spec).
//
// dotenv.parse handles:
//   - inline `# comment` stripping (unquoted values)
//   - quoted values (single & double)
//   - escape sequences (\n, \r, \t, etc.)
//   - multi-line values
//   - empty lines, whitespace trimming
//
// This replaces hand-rolled regex like `/^KEY=(.+)$/m` which does NOT strip
// trailing comments and can leak non-ASCII into API headers.
//
// After parsing, values are expanded: ${VAR} and $VAR references are resolved
// from the same .env (matching Docker Compose variable substitution behavior).
import { existsSync, readFileSync } from "node:fs";
import dotenv from "dotenv";

/**
 * Expand ${VAR} and $VAR references in a value using the env map.
 * Handles nested refs (A→B→C) up to 10 passes. Skips undefined vars.
 */
function expandValue(value, env, maxPasses = 10) {
  let result = value;
  for (let i = 0; i < maxPasses; i++) {
    const prev = result;
    // ${VAR} — braced form (most common in .env / Compose)
    result = result.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, key) =>
      env[key] !== undefined ? env[key] : `\${${key}}`
    );
    // $VAR — bare form (no braces)
    result = result.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, key) =>
      env[key] !== undefined ? env[key] : `$${key}`
    );
    if (result === prev) break; // no more expansions
  }
  return result;
}

/**
 * Parse a .env file into a plain object. Returns {} if file missing.
 * - Strips stray non-printable chars (CRLF remnants, BOM, etc.)
 * - Expands ${VAR} / $VAR references from the same file (like Compose)
 */
export function parseEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const raw = dotenv.parse(readFileSync(filePath, "utf8"));
  // First pass: strip non-printable
  const cleaned = {};
  for (const [k, v] of Object.entries(raw)) {
    cleaned[k] = v.replace(/[^\x20-\x7E]/g, "");
  }
  // Second pass: expand variable references
  const env = {};
  for (const [k, v] of Object.entries(cleaned)) {
    env[k] = expandValue(v, cleaned);
  }
  return env;
}

/**
 * Get a single value from .env. Returns "" if key missing or file absent.
 */
export function envGet(filePath, key) {
  return parseEnv(filePath)[key] || "";
}

/**
 * Check whether a key is present in .env (even if value is empty).
 * Returns false if file missing.
 */
export function envHasKey(filePath, key) {
  if (!existsSync(filePath)) return false;
  const parsed = dotenv.parse(readFileSync(filePath, "utf8"));
  return key in parsed;
}

/**
 * List all keys defined in .env (ignoring comments and blank lines).
 * Returns [] if file missing.
 */
export function envKeys(filePath) {
  if (!existsSync(filePath)) return [];
  return Object.keys(dotenv.parse(readFileSync(filePath, "utf8")));
}
