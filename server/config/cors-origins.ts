/**
 * The CORS origin allowlist, shared by the global cors() middleware and the
 * trusted-origin policy, which refuses to enable device sessions for an origin
 * that CORS would not serve (ADR-163 amendment 1, M5).
 */

type CorsEnv = Readonly<Record<string, string | undefined>>;

const DEFAULT_CORS_ORIGINS: readonly string[] = Object.freeze([
  'http://localhost:3004',
  'http://localhost:3001',
  'http://localhost:5173',
]);

/** Returns the defaults plus every comma-separated `ALLOWED_ORIGINS` entry, de-duplicated. */
export function corsAllowedOrigins(env: CorsEnv = process.env): string[] {
  const configured = String(env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_CORS_ORIGINS, ...configured])];
}
