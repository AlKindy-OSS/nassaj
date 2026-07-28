import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Read-only reader for the Antigravity (agy) OAuth access token.
 *
 * The `agy` CLI persists its OAuth credentials at
 * `~/.gemini/antigravity-cli/antigravity-oauth-token` as JSON of the shape
 * `{ token: { access_token, token_type, refresh_token, expiry }, auth_method }`.
 *
 * Hard constraints (qa-critic / architect):
 *  - STRICTLY read-only: this module never writes the file, never refreshes the
 *    token (agy owns the refresh lifecycle), and never mutates anything on disk.
 *  - The token value is NEVER logged, NEVER cached in module state, and NEVER
 *    returned to any client surface. Callers receive it transiently to set an
 *    Authorization header, then drop it.
 *  - Every failure path (missing file, bad JSON, missing field, no permission)
 *    resolves to `null` so a stale/absent token degrades gracefully rather than
 *    throwing and breaking agy sessions or the model catalog fetch.
 */

const ANTIGRAVITY_TOKEN_RELATIVE_PATH = path.join(
  '.gemini',
  'antigravity-cli',
  'antigravity-oauth-token',
);

/**
 * Upper bound on the credential file size we will read. The real file is well
 * under 1KB; this guards against a corrupted/huge file being slurped into
 * memory. Anything larger is treated as "no usable token".
 */
const MAX_TOKEN_FILE_BYTES = 64 * 1024;

type AntigravityTokenFile = {
  token?: {
    access_token?: unknown;
  };
};

/**
 * Resolves the absolute path of the agy OAuth token file under the current
 * user's home directory. Resolved per call so a test-time `os.homedir` patch is
 * always honoured.
 */
export function getAntigravityTokenPath(): string {
  return path.join(os.homedir(), ANTIGRAVITY_TOKEN_RELATIVE_PATH);
}

/**
 * Returns the current agy OAuth `access_token`, or `null` when it cannot be
 * read for any reason. The value is read fresh from disk on each call (agy may
 * have rotated it) and is never retained by this module.
 *
 * Note: an expired token is still returned as-is. Expiry enforcement lives with
 * the upstream API (a 401 from the catalog fetch triggers the graceful fallback)
 * — this reader does not attempt refresh, by design.
 */
export async function readAntigravityAccessToken(): Promise<string | null> {
  const tokenPath = getAntigravityTokenPath();

  let raw: string;
  try {
    raw = await readFile(tokenPath, { encoding: 'utf8' });
  } catch {
    // Missing file or no permission is an expected state (agy never run / not
    // logged in). Treated as "no token".
    return null;
  }

  if (raw.length === 0 || raw.length > MAX_TOKEN_FILE_BYTES) {
    return null;
  }

  let parsed: AntigravityTokenFile;
  try {
    parsed = JSON.parse(raw) as AntigravityTokenFile;
  } catch {
    return null;
  }

  const accessToken = parsed?.token?.access_token;
  if (typeof accessToken !== 'string') {
    return null;
  }

  const trimmed = accessToken.trim();
  return trimmed.length > 0 ? trimmed : null;
}
