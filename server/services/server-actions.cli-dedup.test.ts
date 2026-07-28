/**
 * server-actions.cli-dedup.test.ts — a GLOBAL action collapses to ONE queued row
 * no matter which session asked, on the CLI path too.
 *
 * `safe-restart` is globalIdempotent: one run satisfies every request that was
 * waiting for it. The HTTP route (/api/system/pending) already collapses them.
 * The coordinator CLI (scripts/request-server-action.mjs) did not — it inserted
 * straight against the partial-unique index, which keys on
 * (action_type, session_id), so two Claude sessions each asking for a deploy left
 * TWO pending rows. Measured on the live board 2026-07-27 (two safe-restart rows
 * 9s apart), and pressing them in sequence is exactly the restart-storm the
 * globalIdempotent flag exists to prevent — every one of them a drain that cuts
 * live sockets and orphans in-flight tool approvals.
 *
 * The CLI is the path a coordinator actually uses, so it is the one that matters.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', '..', 'scripts', 'request-server-action.mjs');

function runCli(dbPath: string, sessionId: string, reason: string): string {
  return execFileSync(
    process.execPath,
    [CLI, '--action', 'safe-restart', '--session', sessionId, '--reason', reason],
    { env: { ...process.env, DATABASE_PATH: dbPath }, encoding: 'utf8' }
  );
}

function pendingRows(dbPath: string): Array<{ id: string; reason: string | null }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare("SELECT id, reason FROM pending_server_actions WHERE status = 'pending'")
      .all() as Array<{ id: string; reason: string | null }>;
  } finally {
    db.close();
  }
}

test('two sessions asking for the same global action leave ONE queued row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-dedup-'));
  const dbPath = path.join(dir, 'auth.db');
  try {
    runCli(dbPath, '11111111-1111-4111-8111-111111111111', 'deploy fix A');
    const out = runCli(dbPath, '22222222-2222-4222-8222-222222222222', 'deploy fix B');

    const rows = pendingRows(dbPath);
    assert.equal(rows.length, 1, 'a global action must never queue a second row');
    assert.match(out, /collapsed onto it/, 'the CLI must say it collapsed, not that it recorded');
    // No asker's context may be lost when their request is collapsed.
    assert.match(rows[0].reason ?? '', /deploy fix A/);
    assert.match(rows[0].reason ?? '', /deploy fix B/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the same session asking twice is still one row (unchanged behaviour)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-dedup-'));
  const dbPath = path.join(dir, 'auth.db');
  try {
    const sid = '33333333-3333-4333-8333-333333333333';
    runCli(dbPath, sid, 'first ask');
    runCli(dbPath, sid, 'second ask');
    assert.equal(pendingRows(dbPath).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
