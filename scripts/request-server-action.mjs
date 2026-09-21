#!/usr/bin/env node
/**
 * request-server-action.mjs — coordinator CLI to RECORD a pending server action
 * (ADR-066, T-944). Run by the coordinator (a Claude session) — but this is a
 * plain node process writing a DB row, NOT a Claude command, so the client
 * restart guard does not apply. The owner then executes it from the web UI
 * (server-side spawn).
 *
 *   node scripts/request-server-action.mjs \
 *     --action safe-restart \
 *     --session <uuid> \
 *     --expected-server-build-id <sha256> \
 *     --reason "<why a restart is needed>"
 *
 * SECURITY: --action must be an allowlisted actionType (see
 * server/services/server-actions.js). Any other value is rejected here and NEVER
 * written. Only the symbolic actionType + sessionId + reason are stored — never a
 * command. Validation goes through the SAME buildPendingAction the server uses.
 *
 * It writes the row into the pending_server_actions table of the live application
 * database (DATABASE_PATH from .env, resolved exactly as the server does via
 * server/load-env.js), with the SAME ON CONFLICT DO NOTHING dedup as the server
 * (a repeat request for the same action+session while one is still pending is a
 * no-op). It does NOT broadcast over WebSocket — this is a standalone process;
 * the new row surfaces to clients within ≤60s via the /health poll (and
 * immediately for anyone who re-fetches the queue).
 */

// Resolve DATABASE_PATH (and the rest of .env) exactly like the server. This is a
// side-effecting import: it reads <repo>/.env and sets process.env.DATABASE_PATH.
import '../server/load-env.js';

import Database from 'better-sqlite3';

import { buildPendingAction, isGlobalIdempotentAction, listActionTypes } from '../server/services/server-actions.js';

function usage() {
  const actions = listActionTypes().join(', ');
  return [
    'Usage:',
    '  node scripts/request-server-action.mjs --action <type> [--session <id>] [--reason <text>] [--requested-by <who>]',
    '',
    `Allowed --action types: ${actions}`,
    '',
    'Example:',
    '  node scripts/request-server-action.mjs \\',
    '    --action safe-restart \\',
    '    --session 8b1e... \\',
    '    --expected-server-build-id <64-lowercase-hex> \\',
    '    --reason "إعادة تشغيل الخادم بعد بناء الطبقة الخادمية"',
  ].join('\n');
}

/** Minimal --flag value parser (supports `--k v` and `--k=v`). */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[arg.slice(2)] = next;
        i += 1;
      } else {
        out[arg.slice(2)] = true; // bare flag (e.g. --help)
      }
    }
  }
  return out;
}

function fail(message) {
  console.error(`request-server-action: ${message}\n`);
  console.error(usage());
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  console.log(usage());
  process.exit(0);
}

if (typeof args.action !== 'string' || args.action.length === 0) {
  fail('--action is required');
}

// Build + validate BEFORE opening the DB: an unknown actionType (or unsafe
// sessionId) must never reach persistence.
const built = buildPendingAction({
  actionType: args.action,
  sessionId: typeof args.session === 'string' ? args.session : undefined,
  reason: typeof args.reason === 'string' ? args.reason : undefined,
  requestedBy: typeof args['requested-by'] === 'string' ? args['requested-by'] : 'coordinator-cli',
  expectedServerBuildId: typeof args['expected-server-build-id'] === 'string'
    ? args['expected-server-build-id'] : undefined,
});

if (!built.ok) {
  fail(built.error);
}
if (built.value.actionType === 'safe-restart' && !built.value.expectedServerBuildId) {
  fail('--expected-server-build-id is required for safe-restart');
}

const dbPath = process.env.DATABASE_PATH;
if (!dbPath) {
  fail('DATABASE_PATH is not set (checked .env and defaults)');
}

let db;
let inserted = 0;
let queued = null;
let superseded = 0;
try {
  db = new Database(dbPath);
  db.pragma('busy_timeout = 5000');
  // Create-if-missing so a fresh/sandbox DB is usable too. Mirrors the migration
  // (table + the partial-unique dedup index) so ON CONFLICT DO NOTHING has an
  // index to conflict on even outside a migrated DB. No-op on an existing DB.
  db.exec(
    `CREATE TABLE IF NOT EXISTS pending_server_actions (
       id TEXT PRIMARY KEY NOT NULL,
       action_type TEXT NOT NULL,
       session_id TEXT,
       reason TEXT,
       requested_by TEXT,
       status TEXT NOT NULL DEFAULT 'pending',
       error TEXT,
       requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       executed_at DATETIME
     );
     CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_actions_dedup
       ON pending_server_actions(action_type, IFNULL(session_id, ''))
       WHERE status = 'pending';
     CREATE INDEX IF NOT EXISTS idx_pending_actions_status
       ON pending_server_actions(status);`
  );
  const columns = db.prepare('PRAGMA table_info(pending_server_actions)').all();
  if (!columns.some(({ name }) => name === 'expected_server_build_id')) {
    db.exec('ALTER TABLE pending_server_actions ADD COLUMN expected_server_build_id TEXT');
  }
  // A GLOBAL action (one run satisfies every asker, e.g. safe-restart) must
  // collapse onto the row already queued, WHOEVER asked. The index above dedupes
  // on (action_type, session_id) — right for a conversation-scoped action, wrong
  // here: two Claude sessions each asking for a deploy left two rows, and
  // pressing them in sequence performed two real restarts, each cutting live
  // sockets. The HTTP route (/api/system/pending) already collapses them; this
  // CLI is the path a coordinator actually uses, so it has to do the same — the
  // fix was measured missing here on 2026-07-27 (two pending safe-restart rows,
  // 9s apart). The asker's reason is appended so no context is lost.
  if (isGlobalIdempotentAction(built.value.actionType)) {
    const enqueue = db.transaction(() => {
      const fenced = db.prepare(
        `UPDATE pending_server_actions
         SET status = 'superseded', error = ?
         WHERE action_type = ?
           AND (expected_server_build_id IS NULL OR expected_server_build_id != ?)
           AND status IN ('pending', 'failed')`
      ).run(`superseded_by:${built.value.id}`.slice(0, 500), built.value.actionType,
        built.value.expectedServerBuildId).changes;
      const existing = db.prepare(
        `SELECT id FROM pending_server_actions
         WHERE action_type = ? AND expected_server_build_id = ?
           AND status = 'pending'
         ORDER BY requested_at ASC, rowid ASC LIMIT 1`
      ).get(built.value.actionType, built.value.expectedServerBuildId);
      if (existing) {
        const sameGenerationFenced = db.prepare(
          `UPDATE pending_server_actions
           SET status = 'superseded', error = ?
           WHERE action_type = ? AND expected_server_build_id = ?
             AND id != ? AND status IN ('pending', 'failed')`
        ).run(`superseded_by:${existing.id}`.slice(0, 500), built.value.actionType,
          built.value.expectedServerBuildId, existing.id).changes;
        if (built.value.reason) db.prepare(
          `UPDATE pending_server_actions
           SET reason = substr(CASE WHEN reason IS NULL OR reason = '' THEN ? ELSE reason || char(10) || ? END, 1, 2000)
           WHERE id = ?`
        ).run(built.value.reason, built.value.reason, existing.id);
        return { queued: existing, inserted: 0, superseded: fenced + sameGenerationFenced };
      }
      const info = db.prepare(
        `INSERT INTO pending_server_actions
           (id, action_type, session_id, reason, requested_by, expected_server_build_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(built.value.id, built.value.actionType, built.value.sessionId,
        built.value.reason, built.value.requestedBy, built.value.expectedServerBuildId);
      return { queued: null, inserted: info.changes, superseded: fenced };
    })();
    queued = enqueue.queued;
    inserted = enqueue.inserted;
    superseded = enqueue.superseded;
  }
  if (!queued && !isGlobalIdempotentAction(built.value.actionType)) {
    const info = db
      .prepare(
        `INSERT INTO pending_server_actions
           (id, action_type, session_id, reason, requested_by, expected_server_build_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`
      )
      .run(
        built.value.id,
        built.value.actionType,
        built.value.sessionId,
        built.value.reason,
        built.value.requestedBy,
        built.value.expectedServerBuildId
      );
    inserted = info.changes;
  }
} catch (err) {
  fail(`failed to write pending action to ${dbPath}: ${err?.message ?? err}`);
} finally {
  try {
    if (db) db.close();
  } catch {
    /* ignore close errors */
  }
}

if (queued) {
  console.log('A pending request for this GLOBAL action is already queued — collapsed onto it, no second row.');
  console.log(`  actionType : ${built.value.actionType}`);
  console.log(`  queuedId   : ${queued.id}`);
  console.log(`  buildId    : ${built.value.expectedServerBuildId ?? '(none)'}`);
  console.log(`  database   : ${dbPath}`);
  console.log(`  superseded: ${superseded}`);
  console.log('\nOne execution satisfies every asker; the reason was appended to the queued row.');
} else if (inserted === 0) {
  console.log('A pending action for this (actionType, sessionId) already exists — not duplicated.');
  console.log(`  actionType : ${built.value.actionType}`);
  console.log(`  sessionId  : ${built.value.sessionId ?? '(none)'}`);
  console.log(`  buildId    : ${built.value.expectedServerBuildId ?? '(none)'}`);
  console.log(`  database   : ${dbPath}`);
  console.log(`  superseded: ${superseded}`);
} else {
  console.log('Pending server action recorded:');
  console.log(`  id         : ${built.value.id}`);
  console.log(`  actionType : ${built.value.actionType}`);
  console.log(`  sessionId  : ${built.value.sessionId ?? '(none)'}`);
  console.log(`  buildId    : ${built.value.expectedServerBuildId ?? '(none)'}`);
  console.log(`  reason     : ${built.value.reason ?? '(none)'}`);
  console.log(`  database   : ${dbPath}`);
  console.log('\nThe owner can now execute it from the web UI (server-side).');
}
