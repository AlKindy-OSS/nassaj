/**
 * connector-oauth — where an OAuth connector's grant lives, per member.
 *
 * WHY A DIRECTORY AND NOT THE SECRET STORE. An OAuth connector has no key the
 * member can paste. nassaj's bridge owns one grant.json, refreshes it under a
 * cross-process lock, and writes each new generation atomically. Copying that
 * material into the encrypted key store would create a stale second authority.
 *
 * WHY STRICTLY PER MEMBER — the single-use refresh token. Canva Connect issues
 * ROTATING refresh tokens: "each refresh token can only be used once"
 * (canva.dev, read 2026-08-04). Two members pointed at one directory would race
 * on the next refresh, one would consume the token, and the other's would be
 * dead — logging BOTH out with no explanation. The per-member directory is
 * therefore a correctness requirement, not a privacy nicety.
 *
 * The directory sits inside the member's existing isolated tree, so it inherits
 * that tree's lifecycle: provisioned with it, and removed when the member is
 * deleted (auth.js sweeps the whole tree).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Root of the per-user isolated trees, mirrored from provision-user-dirs rather
 * than imported from it — exactly as `provider-secrets-store` mirrors it, and
 * for the same reason: that module pulls in the database barrel, which makes it
 * unloadable from a plain `node` CLI. This file is imported by
 * `scripts/connector-link.mjs`, so it must stay dependency-free.
 */
function usersRoot() {
  return path.join(os.homedir(), '.nassaj-users');
}

/** Same charset the table and the secret store accept — validated again here. */
const CONNECTOR_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const DIR_MODE = 0o700;

/**
 * Absolute path of one member's auth directory for one connector.
 *
 * Per CONNECTOR, not merely per member: a member may link Canva and some future
 * OAuth platform, and `mcp-remote` keys its files by a hash of the server URL
 * inside whatever directory it is given. Separate directories keep one
 * platform's re-link from disturbing another's.
 *
 * @param {string|number} userId
 * @param {string} connectorId
 * @returns {string}
 */
export function connectorAuthDir(userId, connectorId) {
  if (!CONNECTOR_ID_PATTERN.test(String(connectorId))) {
    throw new Error(`Refusing to build an auth path for a malformed connector id: ${connectorId}`);
  }
  return path.join(usersRoot(), String(userId), '.mcp-auth', String(connectorId));
}

/**
 * Creates the directory (0700) and returns it. Used by the linking command
 * before handing the path to `mcp-remote`.
 *
 * @param {string|number} userId
 * @param {string} connectorId
 * @returns {string}
 */
export function ensureConnectorAuthDir(userId, connectorId) {
  const dir = connectorAuthDir(userId, connectorId);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  // mkdir's mode is ignored when a legacy directory already exists.
  fs.chmodSync(dir, DIR_MODE);
  return dir;
}

/**
 * True when this member has completed the browser grant for this connector.
 *
 * The test is "does the directory hold a token file" rather than "does the
 * directory exist": the linking command creates the directory BEFORE the member
 * approves anything, so mere existence would report a half-finished link as
 * ready and distribute a server that cannot authenticate.
 *
 * Never reads or returns token contents — only whether some exist.
 *
 * @param {string|number} userId
 * @param {string} connectorId
 * @returns {boolean}
 */
export function hasOAuthTokens(userId, connectorId) {
  let dir;
  try {
    dir = connectorAuthDir(userId, connectorId);
  } catch {
    return false;
  }

  /** @param {string} current @param {number} depth */
  const holdsTokenFile = (current, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      // Two layouts land here. `mcp-remote` nests its state under a version
      // folder and names token files `<server_hash>_tokens.json`, so the probe
      // walks a couple of levels rather than assuming a layout a minor release
      // may re-arrange. A server nassaj ships instead reads `grant.json`, written
      // by connector-oauth-flow — same directory, same lifecycle, one file.
      if (entry.isFile() && (entry.name.includes('tokens') || entry.name === 'grant.json')) {
        return true;
      }
      if (entry.isDirectory() && depth > 0 && holdsTokenFile(path.join(current, entry.name), depth - 1)) {
        return true;
      }
    }
    return false;
  };

  return holdsTokenFile(dir, 2);
}

/**
 * Removes a member's grant for one connector. This is the real "disconnect" for
 * an OAuth connector: there is no key to rotate, so revoking access means
 * dropping the tokens (and, at the platform, withdrawing the app's permission —
 * which only the member can do from Canva's own settings).
 *
 * @param {string|number} userId
 * @param {string} connectorId
 * @returns {boolean} whether anything was removed
 */
export function clearOAuthTokens(userId, connectorId) {
  let dir;
  try {
    dir = connectorAuthDir(userId, connectorId);
  } catch {
    return false;
  }
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
