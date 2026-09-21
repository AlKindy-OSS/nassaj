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
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', '..', 'scripts', 'request-server-action.mjs');

const BUILD_A = 'a'.repeat(64);
const BUILD_B = 'b'.repeat(64);

function runCli(dbPath: string, sessionId: string, reason: string, buildId = BUILD_A): string {
  return execFileSync(
    process.execPath,
    [CLI, '--action', 'safe-restart', '--session', sessionId, '--reason', reason,
      '--expected-server-build-id', buildId],
    { env: { ...process.env, DATABASE_PATH: dbPath }, encoding: 'utf8' }
  );
}

function runCliAsync(dbPath: string, sessionId: string, reason: string, buildId = BUILD_A): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath,
      [CLI, '--action', 'safe-restart', '--session', sessionId, '--reason', reason,
        '--expected-server-build-id', buildId],
      { env: { ...process.env, DATABASE_PATH: dbPath }, encoding: 'utf8' },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

test('safe-restart without an expected build is rejected before opening the database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-unbound-'));
  const dbPath = path.join(dir, 'must-not-exist.db');
  try {
    assert.throws(() => execFileSync(
      process.execPath,
      [CLI, '--action', 'safe-restart', '--session', '00000000-0000-4000-8000-000000000000'],
      { env: { ...process.env, DATABASE_PATH: dbPath }, encoding: 'utf8', stdio: 'pipe' },
    ), /expected-server-build-id/);
    assert.equal(fs.existsSync(dbPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
    runCli(dbPath, '00000001-0000-4000-8000-000000000001', 'deploy fix A');
    const out = runCli(dbPath, '00000002-0000-4000-8000-000000000002', 'deploy fix B');

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
    const sid = '00000003-0000-4000-8000-000000000003';
    runCli(dbPath, sid, 'first ask');
    runCli(dbPath, sid, 'second ask');
    assert.equal(pendingRows(dbPath).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed global action is retained as history and a fresh request is queued', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-retry-'));
  const dbPath = path.join(dir, 'auth.db');
  try {
    runCli(dbPath, '00000009-0000-4000-8000-000000000009', 'first attempt');
    const db = new Database(dbPath);
    db.prepare("UPDATE pending_server_actions SET status='failed', error='restart declined'").run();
    db.close();

    const output = runCli(dbPath, '00000010-0000-4000-8000-000000000010', 'retry after repair');
    const check = new Database(dbPath, { readonly: true });
    const rows = check.prepare(
      "SELECT status, reason FROM pending_server_actions WHERE action_type='safe-restart' ORDER BY requested_at, rowid"
    ).all() as Array<{ status: string; reason: string }>;
    check.close();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[1].status, 'pending');
    assert.match(rows[1].reason, /retry after repair/);
    assert.match(output, /Pending server action recorded/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a different build supersedes pending/failed/unbound rows but preserves their audit records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-generation-'));
  const dbPath = path.join(dir, 'auth.db');
  try {
    runCli(dbPath, '00000004-0000-4000-8000-000000000004', 'build A', BUILD_A);
    const db = new Database(dbPath);
    db.prepare("UPDATE pending_server_actions SET status='failed', error='old' WHERE expected_server_build_id=?")
      .run(BUILD_A);
    db.prepare(`INSERT INTO pending_server_actions
      (id, action_type, session_id, reason, requested_by, expected_server_build_id)
      VALUES ('legacy-unbound', 'safe-restart', 'legacy', 'legacy', 'test', NULL)`).run();
    db.prepare(`INSERT INTO pending_server_actions
      (id, action_type, session_id, reason, requested_by, expected_server_build_id)
      VALUES ('unrelated', 'other-action', 'other', 'keep', 'test', NULL)`).run();
    db.close();

    runCli(dbPath, '00000005-0000-4000-8000-000000000005', 'build B', BUILD_B);
    const check = new Database(dbPath, { readonly: true });
    const rows = check.prepare(
      'SELECT id, action_type, expected_server_build_id, status FROM pending_server_actions'
    ).all() as Array<{
      id: string;
      action_type: string;
      expected_server_build_id: string | null;
      status: string;
    }>;
    check.close();
    assert.equal(rows.find(({ expected_server_build_id }) => expected_server_build_id === BUILD_A)?.status, 'superseded');
    assert.equal(rows.find(({ id }) => id === 'legacy-unbound')?.status, 'superseded');
    assert.equal(rows.find(({ id }) => id === 'unrelated')?.status, 'pending');
    assert.equal(rows.filter(({ action_type, status }) => action_type === 'safe-restart' && ['pending', 'failed'].includes(status)).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent same-build CLI requests collapse to one actionable row', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-concurrency-'));
  const dbPath = path.join(dir, 'auth.db');
  try {
    // Seed schema before concurrent writers race only on the enqueue transaction.
    runCli(dbPath, '00000006-0000-4000-8000-000000000006', 'seed', BUILD_A);
    await Promise.all([
      runCliAsync(dbPath, '00000007-0000-4000-8000-000000000007', 'race one', BUILD_B),
      runCliAsync(dbPath, '00000008-0000-4000-8000-000000000008', 'race two', BUILD_B),
    ]);
    const check = new Database(dbPath, { readonly: true });
    const actionable = check.prepare(
      "SELECT id, reason FROM pending_server_actions WHERE action_type='safe-restart' AND status IN ('pending','failed')"
    ).all() as Array<{ id: string; reason: string }>;
    check.close();
    assert.equal(actionable.length, 1);
    assert.match(actionable[0].reason, /race one/);
    assert.match(actionable[0].reason, /race two/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
