/**
 * The one .env line grammar shared by every loader (load-env.js, bootstrap.js,
 * cli.js) so they cannot drift apart. Pure: no imports, no side effects, safe to
 * import from the bootstrap before any application module.
 */

const EXPORT_PREFIX = /^export\s+/;

/** Remove one pair of matching outer single or double quotes, if present. */
function stripMatchingQuotes(value) {
  if (value.length < 2) return value;
  const first = value[0];
  if ((first === '"' || first === "'") && value[value.length - 1] === first) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse one .env line into `{ key, value }`, or null for blank lines, comments,
 * lines without '=' and lines with an empty key. Splits on the first '=' only,
 * trims key and value, accepts an optional leading `export `, and strips one pair
 * of matching outer quotes from the value (an unmatched quote is kept verbatim).
 */
export function parseEnvLine(line) {
  const trimmed = String(line).trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const separator = trimmed.indexOf('=');
  if (separator === -1) return null;
  const key = trimmed.slice(0, separator).replace(EXPORT_PREFIX, '').trim();
  if (!key) return null;
  return { key, value: stripMatchingQuotes(trimmed.slice(separator + 1).trim()) };
}

/**
 * Apply .env file content to `env`. A key is written only when `env[key]` is
 * unset or empty, so values already supplied by the shell or process manager win
 * (the precedence every loader has always had).
 */
export function applyEnvContent(content, env = process.env) {
  for (const line of String(content).split('\n')) {
    const entry = parseEnvLine(line);
    if (entry && !env[entry.key]) env[entry.key] = entry.value;
  }
}
