/**
 * T-1191 — the run-failure marker on a real database (no mocks).
 *
 * What is tested here is SQL behaviour: the single-row replace, the clear on
 * recovery, and above all the TEXT COMPARISON between `quota_resets_at` and
 * `CURRENT_TIMESTAMP`. That last one cannot be proven by a unit test with a
 * fake connection — it is a property of SQLite's collation over the exact
 * string format we store, and storing ISO-8601 instead would pass every
 * hand-written assertion while failing here.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { providerRunFailuresDb } from '@/modules/database/repositories/provider-run-failures.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'provider-run-failures-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const LIVE_REASON =
  'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 94h52m23s.';

test('the migration creates provider_run_failures at boot', async () => {
  await withIsolatedDatabase(() => {
    const row = getConnection()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='provider_run_failures'")
      .get();
    assert.ok(row, 'provider_run_failures should exist after initializeDatabase');
  });
});

test('a recorded failure comes back with its reason and exit code', async () => {
  await withIsolatedDatabase(() => {
    providerRunFailuresDb.recordFailure({
      sessionId: '00000001-0000-4000-8000-000000000001',
      provider: 'antigravity',
      reason: LIVE_REASON,
      exitCode: 1,
      quotaResetsAtMs: Date.now() + 60_000,
    });

    const stored = providerRunFailuresDb.getFailure('00000001-0000-4000-8000-000000000001');
    assert.equal(stored?.reason, LIVE_REASON);
    assert.equal(stored?.exitCode, 1);
    assert.equal(stored?.provider, 'antigravity');
  });
});

test('a second failure replaces the first — the row is a state, not a log', async () => {
  await withIsolatedDatabase(() => {
    const sessionId = 'session-replace';
    providerRunFailuresDb.recordFailure({
      sessionId,
      provider: 'antigravity',
      reason: 'Error: first failure.',
      exitCode: 1,
    });
    providerRunFailuresDb.recordFailure({
      sessionId,
      provider: 'antigravity',
      reason: 'Error: second failure.',
      exitCode: 2,
    });

    assert.equal(providerRunFailuresDb.getFailure(sessionId)?.reason, 'Error: second failure.');
    const count = getConnection()
      .prepare('SELECT COUNT(*) AS n FROM provider_run_failures WHERE session_id = ?')
      .get(sessionId) as { n: number };
    assert.equal(count.n, 1);
  });
});

test('a successful run clears the marker so no dead error is shown', async () => {
  await withIsolatedDatabase(() => {
    const sessionId = 'session-healed';
    providerRunFailuresDb.recordFailure({
      sessionId,
      provider: 'antigravity',
      reason: LIVE_REASON,
      exitCode: 1,
    });
    assert.ok(providerRunFailuresDb.getFailure(sessionId));

    providerRunFailuresDb.clearFailure(sessionId);
    assert.equal(providerRunFailuresDb.getFailure(sessionId), null);
  });
});

test('a future deadline reads as an active quota block', async () => {
  await withIsolatedDatabase(() => {
    providerRunFailuresDb.recordFailure({
      sessionId: 'session-blocked',
      provider: 'antigravity',
      reason: LIVE_REASON,
      exitCode: 1,
      quotaResetsAtMs: Date.now() + 2 * 3600_000,
    });

    const block = providerRunFailuresDb.getActiveQuotaBlock('antigravity');
    assert.ok(block, 'a deadline two hours out must read as blocked');
    assert.ok(block.resetsAtMs > Date.now());
  });
});

test('an elapsed deadline stops reading as a block, with no sweeper', async () => {
  await withIsolatedDatabase(() => {
    providerRunFailuresDb.recordFailure({
      sessionId: 'session-expired',
      provider: 'antigravity',
      reason: LIVE_REASON,
      exitCode: 1,
      quotaResetsAtMs: Date.now() - 3600_000,
    });

    assert.equal(providerRunFailuresDb.getActiveQuotaBlock('antigravity'), null);
    // The row survives as the conversation's failure record even though it is
    // no longer a live block — the two readings are deliberately separate.
    assert.ok(providerRunFailuresDb.getFailure('session-expired'));
  });
});

test('a deadline that elapsed EARLIER THE SAME DAY stops reading as a block', async () => {
  // THE FORMAT TRAP, isolated. Storing `toISOString()` puts a 'T' (0x54) where
  // CURRENT_TIMESTAMP puts a space (0x20), so `'…T13:00:00Z' > '… 19:00:00'`
  // compares TRUE and an hours-old block would keep reporting itself active
  // until the calendar date rolled over. The out-by-an-hour case above passes
  // under both formats; only a same-day comparison separates them.
  await withIsolatedDatabase(() => {
    const now = Date.now();
    const startOfDayUtc = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate()
    );
    // A minute past midnight UTC: same calendar day, comfortably in the past.
    providerRunFailuresDb.recordFailure({
      sessionId: 'session-same-day',
      provider: 'antigravity',
      reason: LIVE_REASON,
      exitCode: 1,
      quotaResetsAtMs: startOfDayUtc + 60_000,
    });

    assert.equal(
      providerRunFailuresDb.getActiveQuotaBlock('antigravity'),
      null,
      'a deadline that passed earlier today must not read as an active block'
    );
  });
});

test('the block reported is the FURTHEST deadline, not the most recent row', async () => {
  await withIsolatedDatabase(() => {
    providerRunFailuresDb.recordFailure({
      sessionId: 'session-far',
      provider: 'antigravity',
      reason: LIVE_REASON,
      exitCode: 1,
      quotaResetsAtMs: Date.now() + 10 * 3600_000,
    });
    // Written later, but expires sooner — one account-level block seen twice.
    providerRunFailuresDb.recordFailure({
      sessionId: 'session-near',
      provider: 'antigravity',
      reason: LIVE_REASON,
      exitCode: 1,
      quotaResetsAtMs: Date.now() + 1 * 3600_000,
    });

    const block = providerRunFailuresDb.getActiveQuotaBlock('antigravity');
    assert.ok(block);
    assert.ok(
      block.resetsAtMs > Date.now() + 9 * 3600_000,
      'the governing deadline is the later one, whichever row was written last'
    );
  });
});

test('a failure with no countdown is recorded but never becomes a block', async () => {
  await withIsolatedDatabase(() => {
    providerRunFailuresDb.recordFailure({
      sessionId: 'session-auth',
      provider: 'antigravity',
      reason: 'Error: authentication credentials have expired.',
      exitCode: 1,
      quotaResetsAtMs: null,
    });

    assert.ok(providerRunFailuresDb.getFailure('session-auth'));
    assert.equal(providerRunFailuresDb.getActiveQuotaBlock('antigravity'), null);
  });
});

test("one provider's block is invisible to another", async () => {
  await withIsolatedDatabase(() => {
    providerRunFailuresDb.recordFailure({
      sessionId: 'session-agy',
      provider: 'antigravity',
      reason: LIVE_REASON,
      exitCode: 1,
      quotaResetsAtMs: Date.now() + 3600_000,
    });

    assert.ok(providerRunFailuresDb.getActiveQuotaBlock('antigravity'));
    assert.equal(providerRunFailuresDb.getActiveQuotaBlock('codex'), null);
  });
});
