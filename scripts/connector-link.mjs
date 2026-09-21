#!/usr/bin/env node
/**
 * connector-link.mjs — the FALLBACK way to obtain an OAuth connector's grant.
 *
 * ⚠️ THIS IS NO LONGER THE NORMAL PATH (ADR-098 rev3, 2026-08-05). Linking now
 * happens from Settings → Connectors: nassaj runs the authorization-code + PKCE
 * exchange itself and seeds the result into the member's auth directory
 * (`connector-oauth-flow.ts`). Nobody needs a shell on the server, and nothing
 * needs a reachable port. Use the button.
 *
 * WHY THE COMMAND SURVIVES ANYWAY. It still answers two questions the UI does
 * not: `--status` (does this member hold a grant on disk) and `--unlink` (drop
 * it). Both are diagnostics, and both are safe.
 *
 * WHY `--host` IS A TRAP — measured, not theorised. Rewriting the callback host
 * gets you a valid authorize URL, and Canva accepts it. But `mcp-remote` calls
 * `findExistingClientPort` on EVERY launch, which throws "Cannot find localhost
 * callback URI from existing client information" whenever the stored
 * registration's redirect is not localhost. So a grant obtained through `--host`
 * does not merely make re-linking awkward: it makes the connector fail to start
 * in every engine, permanently, until the auth directory is wiped. The flag is
 * kept only because removing it silently would leave old instructions pointing
 * at an argument that vanished — do not reach for it.
 *
 * The default (localhost) is still correct when you can forward the port:
 *   ssh -L 14990:localhost:14990 <server>
 * The port is PINNED rather than auto-selected so that instruction stays true
 * between runs.
 *
 *   node scripts/connector-link.mjs --connector canva --user 2 --host nassaj.example.ts.net
 *   node scripts/connector-link.mjs --connector canva --user 2            # localhost + ssh -L
 *   node scripts/connector-link.mjs --connector canva --user 2 --status
 *   node scripts/connector-link.mjs --connector canva --user 2 --unlink
 *
 * NOTHING SECRET IS PRINTED. The authorize URL is public by construction (it
 * carries a PKCE challenge, not a secret). Tokens are written by `mcp-remote`
 * into the auth dir and never pass through this process's output.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  clearOAuthTokens,
  ensureConnectorAuthDir,
  hasOAuthTokens,
} from '../server/modules/connectors/connector-oauth.js';

const DB_PATH = process.env.DATABASE_PATH
  ?? path.join(os.homedir(), '.local/share/nassaj-dev/db.sqlite');

/** Pinned so the `ssh -L` instruction above stays true between runs. */
const CALLBACK_PORT = 14990;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

const connectorId = arg('connector');
const userId = Number(arg('user'));

if (!connectorId || !Number.isInteger(userId) || userId <= 0) {
  fail(
    'usage: connector-link.mjs --connector <id> --user <memberId> [--host <name>] [--status] [--unlink]',
  );
}

if (!fs.existsSync(DB_PATH)) fail(`Database not found at ${DB_PATH}. Set DATABASE_PATH.`);
const db = new Database(DB_PATH, { readonly: true });

const row = db.prepare('SELECT * FROM connectors WHERE id = ?').get(connectorId);
if (!row) fail(`Connector "${connectorId}" was not found. Add it in Settings → Connectors first.`);
if (row.auth_mode !== 'oauth') {
  fail(
    `Connector "${connectorId}" authenticates with a pasted key, not a browser grant. ` +
      'Paste its key in Settings → Connectors instead.',
  );
}

if (has('status')) {
  console.log(
    hasOAuthTokens(userId, connectorId)
      ? `linked   — member ${userId} holds a grant for "${connectorId}".`
      : `NOT linked — member ${userId} has no grant for "${connectorId}" yet.`,
  );
  process.exit(0);
}

if (has('unlink')) {
  const removed = clearOAuthTokens(userId, connectorId);
  console.log(
    removed
      ? `Removed member ${userId}'s grant for "${connectorId}".\n` +
          'Also withdraw nassaj from the platform\'s own connected-apps screen — ' +
          'deleting local tokens does not tell the platform anything.'
      : `Nothing to remove: member ${userId} had no grant for "${connectorId}".`,
  );
  process.exit(0);
}

const authDir = ensureConnectorAuthDir(userId, connectorId);
const host = arg('host');

// The connector row already carries the exact command the engines will run, so
// the link uses THAT rather than a second copy of the packaging that could drift
// from it. Only the callback flags are added.
const args = JSON.parse(row.args_json ?? '[]');
const linkArgs = [...args, String(CALLBACK_PORT)];
if (host) linkArgs.push('--host', host, '--allow-http');

console.error('');
console.error(`Linking "${connectorId}" for member ${userId}.`);
console.error(`Tokens will be written to: ${authDir}`);
console.error(
  host
    ? `Callback registered as http://${host}:${CALLBACK_PORT}/oauth/callback — open the URL below on a device that can reach that host.`
    : `Callback is http://localhost:${CALLBACK_PORT}/oauth/callback — forward it first:\n` +
        `  ssh -L ${CALLBACK_PORT}:localhost:${CALLBACK_PORT} <this-server>\n` +
        'then open the URL below in the browser on that same machine.',
);
console.error('Approve in the browser; this process exits once the grant lands.');
console.error('');

const child = spawn(row.command ?? 'npx', linkArgs, {
  stdio: 'inherit',
  env: { ...process.env, MCP_REMOTE_CONFIG_DIR: authDir },
});

child.on('exit', () => {
  // The child's own exit code is not the answer: `mcp-remote` stays a running
  // proxy after a successful grant and is normally interrupted, so a non-zero
  // code here says nothing about whether the link worked. The tokens on disk do.
  const linked = hasOAuthTokens(userId, connectorId);
  console.error('');
  console.error(
    linked
      ? `✔ Linked. Member ${userId} now holds a grant for "${connectorId}".\n` +
          '  Re-distribute from Settings → Connectors (or re-save the connector) so the engines pick it up.'
      : `✘ No tokens were written. The grant did not complete — re-run after checking the callback is reachable.`,
  );
  process.exit(linked ? 0 : 1);
});

child.on('error', (error) => fail(`Failed to run ${row.command}: ${error.message}`));
