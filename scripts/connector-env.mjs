#!/usr/bin/env node
/**
 * connector-env.mjs — run a command with a connector's API key in its environment.
 *
 * WHY THIS EXISTS (owner question, 2026-08-04). The connectors page already
 * stores every platform's key, but it stores it ENCRYPTED, so a shell cannot use
 * it directly. This closes that last step: the key a member pasted once in the
 * UI becomes usable from a terminal — or by an agent that has a shell — WITHOUT
 * an MCP server. That matters because several platforms (Tamara, Geidea, ZATCA,
 * Google Business) publish a REST API and no MCP server at all, so this is the
 * only path that reaches them today.
 *
 * WHY IT INJECTS INSTEAD OF WRITING A .env FILE. The obvious version of this
 * idea materialises a plaintext `.env` and hands over the path. Three reasons
 * not to:
 *   1. A file at rest outlives its use. It survives the task, the session, and
 *      the person who forgot it was there — and nothing ever deletes it.
 *   2. It would be the ONLY plaintext copy of a key the rest of the system keeps
 *      encrypted, so every backup, sync and stray `grep` would carry it.
 *   3. Injected env reaches the child and dies with it.
 * If a real `.env` is ever genuinely needed, `--write-env <path>` does it — but
 * it is opt-in, refuses to write inside the repository, and says out loud that
 * the file is plaintext.
 *
 * THE VALUE IS NEVER PRINTED. There is deliberately no flag that echoes the key
 * to stdout: an agent reading this script's output would pull the secret into
 * its transcript, which is written to disk and replayed on every resume. The key
 * goes from the encrypted store into the child's environment and nowhere else.
 *
 *   node scripts/connector-env.mjs <connectorId> -- <command…>
 *   node scripts/connector-env.mjs tamara -- bash -c 'curl -H "Authorization: Bearer $TAMARA_TOKEN" https://api.tamara.co/…'
 *   node scripts/connector-env.mjs --list
 *
 * Exit codes: 0 success · 1 usage/not-found/no-key · child's own code otherwise.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  getNamespacedSecret,
  SYSTEM_SCOPE,
} from '../server/services/isolation/provider-secrets-store.js';

const DB_PATH =
  process.env.DATABASE_PATH ?? path.join(os.homedir(), '.local/share/nassaj-dev/db.sqlite');

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    fail(`Database not found at ${DB_PATH}. Set DATABASE_PATH.`);
  }
  return new Database(DB_PATH, { readonly: true });
}

/** Every connector row, with the env var name each one expects. */
function listConnectors(db) {
  return db
    .prepare(
      `SELECT id, service, display_name, credential_mode, owner_user_id,
              key_env_var, key_header, key_header_prefix, transport, url, enabled
         FROM connectors ORDER BY id`,
    )
    .all();
}

/**
 * The secret store scope a row's key lives in — the owner's own scope for a
 * personal connector, the operator-wide scope for a shared one. Mirrors
 * `scopeFor` in connectors.service.ts; the two must agree or a key written by
 * the UI is unreadable here.
 */
function scopeFor(row) {
  if (row.credential_mode !== 'per_member') return SYSTEM_SCOPE;
  if (row.owner_user_id === null) {
    fail(`Connector "${row.id}" is personal but has no owner — cannot resolve its key.`);
  }
  return row.owner_user_id;
}

const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  console.log(
    'usage: connector-env.mjs <connectorId> [--write-env <path>] -- <command…>\n' +
      '       connector-env.mjs --list',
  );
  process.exit(argv.length === 0 ? 1 : 0);
}

const db = openDb();

if (argv[0] === '--list') {
  const rows = listConnectors(db);
  if (rows.length === 0) {
    console.log('No connectors registered yet. Add one in Settings → Connectors.');
    process.exit(0);
  }
  for (const row of rows) {
    const configured = getNamespacedSecret(scopeFor(row), 'connector', row.id) !== null;
    const target = row.transport === 'http' ? row.url : row.key_env_var;
    console.log(
      [
        row.id.padEnd(24),
        row.credential_mode === 'per_member' ? `personal(user ${row.owner_user_id})` : 'shared',
        configured ? 'key:yes' : 'key:NO',
        row.enabled ? 'enabled' : 'disabled',
        target ?? '',
      ].join('  '),
    );
  }
  process.exit(0);
}

const connectorId = argv[0];
let rest = argv.slice(1);

let writeEnvPath = null;
if (rest[0] === '--write-env') {
  writeEnvPath = rest[1];
  rest = rest.slice(2);
  if (!writeEnvPath) fail('--write-env needs a path.');
}

const separator = rest.indexOf('--');
const command = separator === -1 ? rest : rest.slice(separator + 1);

const row = db
  .prepare('SELECT * FROM connectors WHERE id = ?')
  .get(connectorId);

if (!row) {
  fail(`Connector "${connectorId}" was not found. Run --list to see what exists.`);
}

const secret = getNamespacedSecret(scopeFor(row), 'connector', row.id);
if (secret === null) {
  fail(`Connector "${connectorId}" has no key stored. Paste one in Settings → Connectors.`);
}

// An http connector carries its credential in a header rather than an env var;
// expose both shapes so a curl invocation can use whichever it needs.
const envVarName = row.key_env_var || `${row.service.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TOKEN`;
const childEnv = { ...process.env, [envVarName]: secret };
if (row.key_header) {
  childEnv.CONNECTOR_AUTH_HEADER = row.key_header;
  childEnv.CONNECTOR_AUTH_VALUE = `${row.key_header_prefix ?? ''}${secret}`;
}
if (row.url) childEnv.CONNECTOR_URL = row.url;

if (writeEnvPath) {
  const resolved = path.resolve(writeEnvPath);
  // Refused inside the repository: a plaintext key one `git add -A` away from a
  // commit is a different class of accident than one in a scratch directory.
  if (resolved.startsWith(REPO_ROOT + path.sep)) {
    fail(`Refusing to write a plaintext key inside the repository (${resolved}).`);
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolved, `${envVarName}=${secret}\n`, { mode: 0o600 });
  console.error(
    `Wrote PLAINTEXT ${envVarName} to ${resolved} (0600). Delete it when done — nothing else will.`,
  );
}

if (command.length === 0) {
  if (!writeEnvPath) {
    console.error(
      `Connector "${connectorId}" is ready. Its key will be exposed as ${envVarName}.\n` +
        `Pass a command after -- to run with it, e.g.:\n` +
        `  node scripts/connector-env.mjs ${connectorId} -- bash -c 'curl -H "Authorization: Bearer $${envVarName}" <url>'`,
    );
  }
  process.exit(0);
}

const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: childEnv });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
child.on('error', (error) => fail(`Failed to run ${command[0]}: ${error.message}`));
