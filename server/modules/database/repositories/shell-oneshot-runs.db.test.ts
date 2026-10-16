/**
 * shell_oneshot_runs repository tests (ADR-213, T-2037): the durable consumed
 * runId ledger survives a reconnect to the database, consumes atomically,
 * keeps the first outcome, and prunes only ENDED rows by age; a 'started' row past the retention is
 * first closed as refused (qa high-2, round 3 item 7).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { SHELL_ONESHOT_RUN_RETENTION_MS, shellOneShotRunsDb } from '@/modules/database/index.js';

test('ledger rows persist across connections; consume is once; first outcome wins', async () => {
  const prev = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'oneshot-runs-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'db.sqlite');
  try {
    await initializeDatabase();
    assert.equal(shellOneShotRunsDb.get(1, 'r1'), undefined);
    assert.equal(shellOneShotRunsDb.consume(1, 'r1', 1000), true);
    assert.equal(shellOneShotRunsDb.consume(1, 'r1', 1001), false, 'a runId is consumed once');
    assert.equal(shellOneShotRunsDb.consume(2, 'r1', 1001), true, 'per user');

    // Simulated restart: a new connection over the same file (initialize again).
    closeConnection();
    await initializeDatabase();
    assert.deepEqual(shellOneShotRunsDb.get(1, 'r1'), { state: 'started', exit_code: null, consumed_at: 1000, ended_at: null });

    shellOneShotRunsDb.end(1, 'r1', 'finished', 3, 2000);
    shellOneShotRunsDb.end(1, 'r1', 'refused', null, 2001);
    assert.equal(shellOneShotRunsDb.get(1, 'r1')?.state, 'finished');
    assert.equal(shellOneShotRunsDb.get(1, 'r1')?.exit_code, 3);
    shellOneShotRunsDb.end(2, 'r1', 'refused', null, 2000);
    assert.equal(shellOneShotRunsDb.get(2, 'r1')?.state, 'refused');

    // Prune runs on write: only ended rows past retention go; started rows stay forever.
    assert.equal(shellOneShotRunsDb.consume(3, 'old-started', 0), true);
    const later = 2000 + SHELL_ONESHOT_RUN_RETENTION_MS + 1;
    assert.equal(shellOneShotRunsDb.consume(9, 'trigger', later), true);
    assert.equal(shellOneShotRunsDb.get(1, 'r1'), undefined, 'aged finished row pruned');
    assert.equal(shellOneShotRunsDb.get(2, 'r1'), undefined, 'aged refused row pruned');
    assert.deepEqual(shellOneShotRunsDb.get(3, 'old-started'), {
      state: 'refused', exit_code: null, consumed_at: 0, ended_at: later,
    }, 'an aged started row is closed as refused, not deleted, so it stays non-re-runnable');
    const muchLater = later + SHELL_ONESHOT_RUN_RETENTION_MS + 1;
    assert.equal(shellOneShotRunsDb.consume(9, 'trigger-2', muchLater), true);
    assert.equal(shellOneShotRunsDb.get(3, 'old-started'), undefined, 'then ages out');
    assert.equal(shellOneShotRunsDb.get(9, 'trigger-2')?.state, 'started', 'a fresh started row is kept');
  } finally {
    closeConnection();
    if (prev === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
