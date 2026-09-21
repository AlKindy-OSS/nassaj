/**
 * Integration tests for pending-server-actions.db.ts repository (ADR-066, T-944).
 *
 * Each test group uses a fully isolated in-process SQLite database (temp dir +
 * process.env.DATABASE_PATH swap + closeConnection) so the fixture DB is never
 * touched. Schema is bootstrapped via initializeDatabase (which calls
 * runMigrations, creating the table and its indexes).
 *
 * Coverage:
 *   - insert: new row returns 1; dedup (same actionType+sessionId pending) returns 0
 *   - insert: null-session dedup (IFNULL(session_id,'') key)
 *   - listActionable (the CLAIMABLE set): pending+failed visible, executing excluded
 *   - listActionable ordering: oldest first
 *   - countActionable: pending only (T-1684 — what lights the yellow badge)
 *   - listVisible / listHistory: the queue vs the one-hour history (T-1684)
 *   - markSucceeded / pruneHistory / requeueSettled (T-1684)
 *   - getById: returns row or null
 *   - getPendingByDedup: finds current pending row; null after claim
 *   - claimForExecution (CAS): first call changes=1, second call changes=0
 *   - claimForExecution: transitions status pending → executing
 *   - resetToPending: restores executing row
 *   - markFailed: sets status+error; truncates error to 500 chars
 *   - deleteById: removes row (returns 1); idempotent on missing id (returns 0)
 *
 * Framework: node:test + node:assert/strict via tsx (matches the server suite).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { pendingServerActionsDb } from '@/modules/database/repositories/pending-server-actions.db.js';
import type { InsertPendingServerAction } from '@/modules/database/repositories/pending-server-actions.db.js';

// ── Isolation helper ────────────────────────────────────────────────────────

async function withDb(runTest: () => void | Promise<void>): Promise<void> {
  const prev = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'psa-repo-test-'));
  const dbPath = path.join(dir, 'db.sqlite');

  closeConnection();
  process.env.DATABASE_PATH = dbPath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (prev === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

function makeAction(overrides: Partial<InsertPendingServerAction> = {}): InsertPendingServerAction {
  return {
    id: crypto.randomUUID(),
    actionType: 'safe-restart',
    sessionId: null,
    reason: null,
    requestedBy: null,
    ...overrides,
  };
}

// ── insert ───────────────────────────────────────────────────────────────────

test('insert: returns 1 for a new pending action', async () => {
  await withDb(() => {
    const result = pendingServerActionsDb.insert(makeAction({ sessionId: 'ins-new-1' }));
    assert.equal(result, 1, 'insert must return 1 for a fresh row');
  });
});

test('insert dedup: same (actionType, sessionId) while pending → 0 (ON CONFLICT DO NOTHING)', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'dedup-same-sid' });
    const r1 = pendingServerActionsDb.insert(action);
    // Second insert with same actionType+sessionId, different id
    const r2 = pendingServerActionsDb.insert({
      ...makeAction(),
      actionType: 'safe-restart',
      sessionId: 'dedup-same-sid',
    });
    assert.equal(r1, 1, 'first insert must create a row');
    assert.equal(r2, 0, 'second insert with same pending key must be a no-op');
  });
});

test('insert dedup: null sessionId — two null-session requests for same actionType deduplicate', async () => {
  await withDb(() => {
    // Per the partial unique index: (action_type, IFNULL(session_id,'')) WHERE status='pending'
    // Both requests have sessionId=null → IFNULL(null,'') = '' → same dedup key.
    const r1 = pendingServerActionsDb.insert(makeAction({ sessionId: null }));
    const r2 = pendingServerActionsDb.insert(makeAction({ sessionId: null }));
    assert.equal(r1, 1, 'first null-session insert must create a row');
    assert.equal(r2, 0, 'second null-session insert for same actionType must be a no-op');
  });
});

test('insert: a fresh request can be inserted after the previous one is deleted', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'cycle-1' });
    assert.equal(pendingServerActionsDb.insert(action), 1);
    pendingServerActionsDb.claimForExecution(action.id);
    pendingServerActionsDb.deleteById(action.id);
    // Now the dedup key is free — a new pending request for the same (type, session) must work.
    const fresh = makeAction({ sessionId: 'cycle-1' });
    assert.equal(pendingServerActionsDb.insert(fresh), 1, 'fresh insert after deletion must succeed');
  });
});

test('insert: a fresh null-session request can be inserted after the previous failed one', async () => {
  await withDb(() => {
    // The partial unique index applies WHERE status='pending'; a failed row does
    // not block a new pending request for the same key.
    const action = makeAction({ sessionId: null });
    assert.equal(pendingServerActionsDb.insert(action), 1);
    pendingServerActionsDb.markFailed(action.id, 'gate_error');
    const fresh = makeAction({ sessionId: null });
    assert.equal(pendingServerActionsDb.insert(fresh), 1, 'failed row must not block a new pending insert');
  });
});

// ── listActionable / countActionable ─────────────────────────────────────────

test('listActionable: includes pending and failed rows, excludes executing', async () => {
  await withDb(() => {
    const pending = makeAction({ sessionId: 'list-pend' });
    const toFail = makeAction({ sessionId: 'list-fail' });
    const toExec = makeAction({ sessionId: 'list-exec' });

    pendingServerActionsDb.insert(pending);
    pendingServerActionsDb.insert(toFail);
    pendingServerActionsDb.insert(toExec);

    pendingServerActionsDb.markFailed(toFail.id, 'gate_error');
    pendingServerActionsDb.claimForExecution(toExec.id);

    const rows = pendingServerActionsDb.listActionable();
    const ids = rows.map((r) => r.id);

    assert.ok(ids.includes(pending.id), 'pending row must appear in listActionable');
    assert.ok(ids.includes(toFail.id), 'failed row must appear in listActionable');
    assert.ok(!ids.includes(toExec.id), 'executing row must NOT appear in listActionable');
  });
});

test('listActionable: empty queue returns an empty array', async () => {
  await withDb(() => {
    assert.deepEqual(pendingServerActionsDb.listActionable(), []);
  });
});

test('listActionable: rows are ordered oldest first (requested_at ASC)', async () => {
  await withDb(() => {
    const a = makeAction({ sessionId: 'order-a' });
    const b = makeAction({ sessionId: 'order-b' });
    pendingServerActionsDb.insert(a);
    pendingServerActionsDb.insert(b);

    const rows = pendingServerActionsDb.listActionable();
    const aIdx = rows.findIndex((r) => r.id === a.id);
    const bIdx = rows.findIndex((r) => r.id === b.id);
    assert.ok(aIdx !== -1 && bIdx !== -1);
    assert.ok(aIdx < bIdx, 'earlier inserted row must come before later one');
  });
});

test('T-1684 countActionable: counts pending ONLY — failed/executing/settled never light the badge', async () => {
  await withDb(() => {
    assert.equal(pendingServerActionsDb.countActionable(), 0, 'empty queue must return 0');

    const p = makeAction({ sessionId: 'cnt-p' });
    const f = makeAction({ sessionId: 'cnt-f' });
    const e = makeAction({ sessionId: 'cnt-e' });
    const s = makeAction({ sessionId: 'cnt-s' });
    pendingServerActionsDb.insert(p);
    pendingServerActionsDb.insert(f);
    pendingServerActionsDb.insert(e);
    pendingServerActionsDb.insert(s);
    assert.equal(pendingServerActionsDb.countActionable(), 4);

    pendingServerActionsDb.markFailed(f.id, 'err');
    pendingServerActionsDb.claimForExecution(e.id);
    pendingServerActionsDb.claimForExecution(s.id);
    pendingServerActionsDb.markSucceeded(s.id);

    assert.equal(
      pendingServerActionsDb.countActionable(),
      1,
      'only the still-pending row counts'
    );
  });
});

// ── getById ──────────────────────────────────────────────────────────────────

test('getById: returns the mapped row for an existing id', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'getbyid-x', reason: 'test reason' });
    pendingServerActionsDb.insert(action);

    const row = pendingServerActionsDb.getById(action.id);
    assert.ok(row !== null, 'row must exist');
    assert.equal(row!.id, action.id);
    assert.equal(row!.actionType, 'safe-restart');
    assert.equal(row!.sessionId, 'getbyid-x');
    assert.equal(row!.reason, 'test reason');
    assert.equal(row!.status, 'pending');
  });
});

test('getById: returns null for a non-existent id', async () => {
  await withDb(() => {
    assert.equal(pendingServerActionsDb.getById('nonexistent-id-xyz'), null);
  });
});

// ── getPendingByDedup ────────────────────────────────────────────────────────

test('getPendingByDedup: finds current pending row by (actionType, sessionId)', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'dedup-find-1' });
    pendingServerActionsDb.insert(action);

    const found = pendingServerActionsDb.getPendingByDedup('safe-restart', 'dedup-find-1');
    assert.ok(found !== null, 'pending row must be found by dedup key');
    assert.equal(found!.id, action.id);
  });
});

test('getPendingByDedup: returns null after row is claimed (status no longer pending)', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'dedup-claimed' });
    pendingServerActionsDb.insert(action);
    pendingServerActionsDb.claimForExecution(action.id);
    assert.equal(
      pendingServerActionsDb.getPendingByDedup('safe-restart', 'dedup-claimed'),
      null,
      'claimed (executing) row must not be returned by getPendingByDedup'
    );
  });
});

test('getPendingByDedup: handles null sessionId lookup', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: null });
    pendingServerActionsDb.insert(action);

    const found = pendingServerActionsDb.getPendingByDedup('safe-restart', null);
    assert.ok(found !== null, 'null-session pending row must be findable');
    assert.equal(found!.id, action.id);
  });
});

// ── claimForExecution (CAS) ──────────────────────────────────────────────────

test('claimForExecution CAS: first call returns 1, second call returns 0 (prevents double-run)', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'cas-test-1' });
    pendingServerActionsDb.insert(action);

    const first = pendingServerActionsDb.claimForExecution(action.id);
    const second = pendingServerActionsDb.claimForExecution(action.id);

    assert.equal(first, 1, 'first CAS claim must succeed (changes=1)');
    assert.equal(second, 0, 'second CAS claim must fail (changes=0) — prevents double-run');
  });
});

test('claimForExecution: transitions row status from pending to executing', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'cas-status-1' });
    pendingServerActionsDb.insert(action);
    pendingServerActionsDb.claimForExecution(action.id);

    const row = pendingServerActionsDb.getById(action.id);
    assert.ok(row !== null);
    assert.equal(row!.status, 'executing');
    assert.ok(row!.executedAt !== null, 'executedAt must be stamped after claim');
  });
});

test('claimForExecution: returns 0 for a non-existent id (no phantom claims)', async () => {
  await withDb(() => {
    assert.equal(pendingServerActionsDb.claimForExecution('does-not-exist'), 0);
  });
});

// ── Retry of a failed row (B-200 / T-969) ────────────────────────────────────
//
// The claim set was widened from 'pending' to ('pending','failed') so the Retry
// button actually retries: before that, a row that failed its gate could never
// be claimed again and the button was a no-op against a permanently dead id.
//
// The behaviour shipped without a test, which is the risk these three close:
// narrowing that IN-list back to ('pending') passes every other test in this
// file and silently kills Retry again.

test('claimForExecution: claims a FAILED row — this is what makes Retry work', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'retry-failed-claimable' });
    pendingServerActionsDb.insert(action);
    pendingServerActionsDb.markFailed(action.id, 'gate refused the first attempt');

    assert.equal(
      pendingServerActionsDb.claimForExecution(action.id),
      1,
      'a failed row must be claimable, or the Retry button has nothing to act on',
    );
    assert.equal(pendingServerActionsDb.getById(action.id)?.status, 'executing');
  });
});

test('claimForExecution: clears the previous error when re-claiming a failed row', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'retry-clears-error' });
    pendingServerActionsDb.insert(action);
    pendingServerActionsDb.markFailed(action.id, 'stale reason from the first attempt');

    pendingServerActionsDb.claimForExecution(action.id);

    // Without `error = NULL` the retry carries the OLD failure text, so the UI
    // reports the previous attempt's reason over an attempt still in flight —
    // the same class of lie as reporting a working guard as a malfunction.
    assert.equal(
      pendingServerActionsDb.getById(action.id)?.error,
      null,
      're-claiming must clear the stale error, not carry it into the new attempt',
    );
  });
});

test('claimForExecution: widening to failed did NOT weaken the double-run guard', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'retry-guard-intact' });
    pendingServerActionsDb.insert(action);
    pendingServerActionsDb.claimForExecution(action.id); // now 'executing'

    // 'executing' stays excluded: a row with a live execution behind it must
    // never be claimed a second time, however the claim set grows.
    assert.equal(
      pendingServerActionsDb.claimForExecution(action.id),
      0,
      'an executing row must remain unclaimable',
    );
  });
});

// ── resetToPending ───────────────────────────────────────────────────────────

test('resetToPending: restores an executing row to pending and clears executedAt', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'reset-1' });
    pendingServerActionsDb.insert(action);
    pendingServerActionsDb.claimForExecution(action.id);
    getConnection().prepare(
      'UPDATE pending_server_actions SET error = ? WHERE id = ?',
    ).run('stale execution detail', action.id);

    pendingServerActionsDb.resetToPending(action.id);
    const row = pendingServerActionsDb.getById(action.id);
    assert.ok(row !== null);
    assert.equal(row!.status, 'pending');
    assert.equal(row!.executedAt, null);
    assert.equal(row!.error, null);
  });
});

test('resetToPending: never revives a terminal failed row', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'reset-terminal' });
    pendingServerActionsDb.insert(action);
    pendingServerActionsDb.markFailed(action.id, 'terminal failure');

    assert.equal(pendingServerActionsDb.resetToPending(action.id), 0);
    assert.equal(pendingServerActionsDb.getById(action.id)?.status, 'failed');
    assert.equal(pendingServerActionsDb.getById(action.id)?.error, 'terminal failure');
  });
});

// ── markFailed ───────────────────────────────────────────────────────────────

test('markFailed: sets status to failed and records the error string', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'fail-1' });
    pendingServerActionsDb.insert(action);
    pendingServerActionsDb.markFailed(action.id, 'gate_failed:2');

    const row = pendingServerActionsDb.getById(action.id);
    assert.ok(row !== null);
    assert.equal(row!.status, 'failed');
    assert.equal(row!.error, 'gate_failed:2');
  });
});

test('markFailed: truncates error string to 500 characters', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'fail-long' });
    pendingServerActionsDb.insert(action);
    pendingServerActionsDb.markFailed(action.id, 'e'.repeat(600));

    const row = pendingServerActionsDb.getById(action.id);
    assert.ok(row !== null);
    assert.equal(row!.error!.length, 500, 'error must be capped at 500 characters');
  });
});

// ── deleteById ───────────────────────────────────────────────────────────────

test('deleteById: removes the row and returns 1', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'del-1' });
    pendingServerActionsDb.insert(action);
    const result = pendingServerActionsDb.deleteById(action.id);
    assert.equal(result, 1);
    assert.equal(pendingServerActionsDb.getById(action.id), null);
  });
});

test('deleteById: is idempotent — deleting a non-existent id returns 0, not an error', async () => {
  await withDb(() => {
    assert.equal(pendingServerActionsDb.deleteById('phantom-id'), 0);
  });
});

test('deleteById: calling it twice on the same id is safe (second call returns 0)', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'del-twice' });
    pendingServerActionsDb.insert(action);
    assert.equal(pendingServerActionsDb.deleteById(action.id), 1);
    assert.equal(pendingServerActionsDb.deleteById(action.id), 0);
  });
});

// ── B-200: a 'failed' row is RETRYABLE (claimable) ───────────────────────────
//
// REGRESSION GUARD. claimForExecution used to require status='pending' while
// listActionable/countActionable and the UI all treat pending+failed as "the
// actionable queue" and offer Retry on a failed row. Nothing in the system ever
// moves a row back from 'failed' to 'pending', so every Retry CAS-missed → 409
// not_claimable, permanently. These tests fail on the pre-fix repository.

test('B-200 claimForExecution: a FAILED row is claimable (Retry works)', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'b200-retry' });
    pendingServerActionsDb.insert(action);
    pendingServerActionsDb.claimForExecution(action.id);
    pendingServerActionsDb.markFailed(action.id, 'gate_failed:6');
    assert.equal(pendingServerActionsDb.getById(action.id)!.status, 'failed');

    const claimed = pendingServerActionsDb.claimForExecution(action.id);
    assert.equal(claimed, 1, 'a failed row must be claimable — otherwise Retry always 409s');
    assert.equal(pendingServerActionsDb.getById(action.id)!.status, 'executing');
  });
});

test('B-200 claimForExecution: claiming a failed row CLEARS the stale error and re-stamps executedAt', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'b200-clear' });
    pendingServerActionsDb.insert(action);
    pendingServerActionsDb.claimForExecution(action.id);
    pendingServerActionsDb.markFailed(action.id, 'gate_failed:6');

    pendingServerActionsDb.claimForExecution(action.id);
    const row = pendingServerActionsDb.getById(action.id)!;
    assert.equal(row.error, null, 'the previous attempt error must not survive a retry');
    assert.ok(row.executedAt !== null, 'a retry must stamp a fresh executed_at');
  });
});

test('B-200 claimForExecution: the double-run guard is UNCHANGED — an executing row is never claimable', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'b200-cas' });
    pendingServerActionsDb.insert(action);
    assert.equal(pendingServerActionsDb.claimForExecution(action.id), 1);
    assert.equal(
      pendingServerActionsDb.claimForExecution(action.id),
      0,
      'widening the claim to failed must not weaken the executing (double-run) guard'
    );
  });
});

test('B-200 resetToPending: a retry whose dedup twin is pending keeps a terminal receipt', async () => {
  await withDb(() => {
    // A failed row and a NEW pending row can legitimately share a dedup key: the
    // partial unique index only covers status='pending'. Retrying the failed one
    // and then deferring it would UPDATE it to 'pending' → UNIQUE violation.
    const failed = makeAction({ sessionId: null });
    pendingServerActionsDb.insert(failed);
    pendingServerActionsDb.claimForExecution(failed.id);
    pendingServerActionsDb.markFailed(failed.id, 'gate_failed:6');

    const fresh = makeAction({ sessionId: null });
    assert.equal(pendingServerActionsDb.insert(fresh), 1, 'a failed row must not block a fresh request');

    assert.equal(pendingServerActionsDb.claimForExecution(failed.id), 1);
    // Must not throw (which would leave the row stuck in 'executing' forever).
    assert.doesNotThrow(() => pendingServerActionsDb.resetToPending(failed.id));
    assert.equal(pendingServerActionsDb.getById(failed.id)?.status, 'superseded');
    assert.equal(
      pendingServerActionsDb.getById(failed.id)?.error,
      'satisfied_by_equivalent_pending_action',
    );
    assert.equal(pendingServerActionsDb.getById(fresh.id)!.status, 'pending', 'the twin survives');
  });
});

test('an older executing generation cannot return to pending after a newer build is queued', async () => {
  await withDb(() => {
    const buildA = '1'.repeat(64);
    const buildB = '2'.repeat(64);
    pendingServerActionsDb.insert(makeAction({
      id: 'executing-a', expectedServerBuildId: buildA,
    }));
    pendingServerActionsDb.claimForExecution('executing-a');
    // Historical coexistence fixture: the guarded enqueue now rejects this new request.
    pendingServerActionsDb.insert(makeAction({
      id: 'newer-b', expectedServerBuildId: buildB,
    }));

    pendingServerActionsDb.resetToPending('executing-a');

    assert.equal(pendingServerActionsDb.getById('executing-a')?.status, 'superseded');
    assert.equal(pendingServerActionsDb.getById('executing-a')?.error, 'superseded_by:newer-b');
    assert.deepEqual(
      pendingServerActionsDb.listActionable().map(({ id }) => id),
      ['newer-b'],
    );
  });
});

test('an older executing generation cannot become retryable failed after a newer build is queued', async () => {
  await withDb(() => {
    const buildA = '3'.repeat(64);
    const buildB = '4'.repeat(64);
    pendingServerActionsDb.insert(makeAction({
      id: 'executing-failure-a', expectedServerBuildId: buildA,
    }));
    pendingServerActionsDb.claimForExecution('executing-failure-a');
    // Historical coexistence fixture: the guarded enqueue now rejects this new request.
    pendingServerActionsDb.insert(makeAction({
      id: 'newer-failure-b', expectedServerBuildId: buildB,
    }));

    pendingServerActionsDb.markFailed('executing-failure-a', 'late gate failure');

    assert.equal(pendingServerActionsDb.getById('executing-failure-a')?.status, 'superseded');
    assert.equal(
      pendingServerActionsDb.getById('executing-failure-a')?.error,
      'superseded_by:newer-failure-b',
    );
    assert.deepEqual(
      pendingServerActionsDb.listActionable().map(({ id }) => id),
      ['newer-failure-b'],
    );
  });
});

// ── B-185 (ب): abandoned 'executing' rows are reaped ─────────────────────────

test('T-1684 reapStaleExecuting: an abandoned executing row settles as UNRESOLVED history, not pending', async () => {
  await withDb(() => {
    const action = makeAction({ actionType: 'custom-test', sessionId: 'b185-stale' });
    pendingServerActionsDb.insert(action);
    pendingServerActionsDb.claimForExecution(action.id);
    assert.equal(pendingServerActionsDb.listHistory().length, 0, 'executing is not history yet');

    // maxAgeMs=0 → every executing row counts as stale (deterministic; no sleep).
    const reaped = pendingServerActionsDb.reapStaleExecuting(0);
    assert.equal(reaped, 1);
    const row = pendingServerActionsDb.getById(action.id)!;
    assert.equal(row.status, 'failed');
    assert.equal(row.error, 'execution_unresolved', 'an orphan proves unknown, never success');
    assert.ok(row.settledAt, 'settled_at is stamped so the hour starts counting');
    assert.equal(pendingServerActionsDb.listVisible().length, 0, 'it left the queue');
    assert.equal(pendingServerActionsDb.listHistory().length, 1, 'it is history');
    assert.equal(pendingServerActionsDb.countActionable(), 0, 'the badge must not come back');
    assert.equal(pendingServerActionsDb.claimForExecution(action.id), 1, 'still retryable');
  });
});

test('B-185 reapStaleExecuting: a FRESH executing row is left alone (never yanks a live run)', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'b185-fresh' });
    pendingServerActionsDb.insert(action);
    pendingServerActionsDb.claimForExecution(action.id);

    const reaped = pendingServerActionsDb.reapStaleExecuting(30 * 60 * 1000);
    assert.equal(reaped, 0, 'a run started seconds ago must not be reaped');
    assert.equal(pendingServerActionsDb.getById(action.id)!.status, 'executing');
  });
});

test('B-185 reapStaleExecuting: pending and failed rows are never touched', async () => {
  await withDb(() => {
    const pending = makeAction({ sessionId: 'b185-pending' });
    const failed = makeAction({ sessionId: 'b185-failed' });
    pendingServerActionsDb.insert(pending);
    pendingServerActionsDb.insert(failed);
    pendingServerActionsDb.claimForExecution(failed.id);
    pendingServerActionsDb.markFailed(failed.id, 'boom');

    assert.equal(pendingServerActionsDb.reapStaleExecuting(0), 0);
    assert.equal(pendingServerActionsDb.getById(pending.id)!.status, 'pending');
    assert.equal(pendingServerActionsDb.getById(failed.id)!.status, 'failed');
  });
});

// ── T-1684: success is kept as history, then pruned after one hour ───────────

test('T-1684 markSucceeded: a successful action stays as history instead of being deleted', async () => {
  await withDb(() => {
    const action = makeAction({ actionType: 'custom-test', sessionId: 'ok-run' });
    pendingServerActionsDb.insert(action);
    pendingServerActionsDb.claimForExecution(action.id);
    assert.equal(pendingServerActionsDb.markSucceeded(action.id, 'exit_0'), 1);

    const row = pendingServerActionsDb.getById(action.id)!;
    assert.equal(row.status, 'succeeded');
    assert.equal(row.error, 'exit_0');
    assert.ok(row.executedAt && row.settledAt);
    assert.equal(pendingServerActionsDb.listVisible().length, 0, 'gone from the queue');
    assert.deepEqual(pendingServerActionsDb.listHistory().map(({ id }) => id), [action.id]);
    assert.equal(pendingServerActionsDb.countActionable(), 0);
    assert.equal(pendingServerActionsDb.claimForExecution(action.id), 0,
      'a proven success must not be re-run from history');
  });
});

test('T-1684 markSucceeded settles ONLY the row this process claimed', async () => {
  await withDb(() => {
    // Defence in depth (qa-critic): a late success callback must not resurrect a
    // row that meanwhile got superseded, requeued or settled by someone else.
    const queued = makeAction({ actionType: 'custom-test', sessionId: 'guard-pending' });
    const fenced = makeAction({ actionType: 'custom-test', sessionId: 'guard-fenced' });
    for (const a of [queued, fenced]) pendingServerActionsDb.insert(a);
    pendingServerActionsDb.claimForExecution(fenced.id);
    pendingServerActionsDb.markSuperseded(fenced.id, 'satisfied_by_same_generation_execution');

    assert.equal(pendingServerActionsDb.markSucceeded(queued.id), 0, 'never claimed');
    assert.equal(pendingServerActionsDb.markSucceeded(fenced.id), 0, 'no longer executing');
    assert.equal(pendingServerActionsDb.getById(queued.id)!.status, 'pending');
    assert.equal(pendingServerActionsDb.getById(fenced.id)!.status, 'superseded');
    assert.equal(pendingServerActionsDb.getById(fenced.id)!.error,
      'satisfied_by_same_generation_execution');
  });
});

test('T-1684 pruneHistory: settled rows are deleted an hour after settling, pending never', async () => {
  await withDb(() => {
    const done = makeAction({ actionType: 'custom-test', sessionId: 'prune-ok' });
    const failed = makeAction({ actionType: 'custom-test', sessionId: 'prune-fail' });
    const waiting = makeAction({ actionType: 'custom-test', sessionId: 'prune-wait' });
    for (const a of [done, failed, waiting]) pendingServerActionsDb.insert(a);
    pendingServerActionsDb.claimForExecution(done.id);
    pendingServerActionsDb.markSucceeded(done.id);
    pendingServerActionsDb.markFailed(failed.id, 'boom');

    assert.equal(pendingServerActionsDb.pruneHistory(60 * 60 * 1000), 0, 'fresh history is kept');
    assert.equal(pendingServerActionsDb.listHistory().length, 2);

    // maxAgeMs=0 → everything already settled is past its horizon.
    assert.equal(pendingServerActionsDb.pruneHistory(0), 2);
    assert.equal(pendingServerActionsDb.listHistory().length, 0);
    assert.equal(pendingServerActionsDb.getById(waiting.id)!.status, 'pending',
      'a queued row is never pruned at any age');
  });
});

test('T-1684 listHistory: newest first, and the queue projection excludes failed rows', async () => {
  await withDb(() => {
    const first = makeAction({ actionType: 'custom-test', sessionId: 'h-1' });
    const second = makeAction({ actionType: 'custom-test', sessionId: 'h-2' });
    const queued = makeAction({ actionType: 'custom-test', sessionId: 'h-3' });
    for (const a of [first, second, queued]) pendingServerActionsDb.insert(a);
    pendingServerActionsDb.markFailed(first.id, 'boom');
    getConnection().prepare("UPDATE pending_server_actions SET settled_at = datetime('now', '-5 minutes') WHERE id = ?")
      .run(first.id);
    pendingServerActionsDb.claimForExecution(second.id);
    pendingServerActionsDb.markSucceeded(second.id);

    assert.deepEqual(pendingServerActionsDb.listHistory().map(({ id }) => id), [second.id, first.id]);
    assert.deepEqual(pendingServerActionsDb.listVisible().map(({ id }) => id), [queued.id]);
  });
});

test('T-1684 requeueSettled: an aborted execution goes back to the queue from history', async () => {
  await withDb(() => {
    const action = makeAction({ actionType: 'custom-test', sessionId: 'requeue' });
    pendingServerActionsDb.insert(action);
    pendingServerActionsDb.claimForExecution(action.id);
    pendingServerActionsDb.markFailed(action.id, 'execution_unresolved');

    assert.equal(pendingServerActionsDb.requeueSettled(action.id), 1);
    const row = pendingServerActionsDb.getById(action.id)!;
    assert.equal(row.status, 'pending');
    assert.equal(row.settledAt, null);
    assert.equal(row.executedAt, null);
    assert.equal(pendingServerActionsDb.countActionable(), 1, 'real queued work does light the badge');
  });
});

// ── global-action collapse (one restart satisfies every asker) ───────────────
//
// The dedup index keys on (action_type, session_id). For a GLOBAL action that is
// right for nothing: three conversations each asking for a deploy left three
// rows, and pressing them in sequence performed three real restarts — each one
// draining live sockets, orphaning in-flight approvals, and reading to the user
// as a random disconnect. Measured 2026-07-26: triggers 21s apart (15:35:34/44/55)
// and 14s apart (01:03:37/51). These lock the collapse primitives.

test('getQueuedByActionType finds a queued row from ANY session, oldest first', async () => {
  await withDb(() => {
    pendingServerActionsDb.insert(makeAction({ id: 'g-1', sessionId: 'session-a', reason: 'first' }));
    pendingServerActionsDb.insert(makeAction({ id: 'g-2', sessionId: 'session-b', reason: 'second' }));

    const found = pendingServerActionsDb.getQueuedByActionType('safe-restart');
    assert.equal(found?.id, 'g-1', 'must return the oldest queued row regardless of session');
  });
});

test('getQueuedByActionType also sees a failed row (it is still waiting to run)', async () => {
  await withDb(() => {
    pendingServerActionsDb.insert(makeAction({ id: 'g-failed', sessionId: 'session-a' }));
    pendingServerActionsDb.markFailed('g-failed', 'gate deferred');

    const found = pendingServerActionsDb.getQueuedByActionType('safe-restart');
    assert.equal(found?.id, 'g-failed', 'a failed row still represents unfinished work');
  });
});

test('appendReason merges a second asker context instead of discarding it', async () => {
  await withDb(() => {
    pendingServerActionsDb.insert(makeAction({ id: 'g-merge', sessionId: 'a', reason: 'deploy A' }));
    pendingServerActionsDb.appendReason('g-merge', 'deploy B');

    const row = pendingServerActionsDb.getById('g-merge');
    assert.match(row!.reason!, /deploy A/, 'the original reason must survive');
    assert.match(row!.reason!, /deploy B/, 'the new reason must be recorded');
  });
});

test('appendReason ignores an empty reason and never nulls an existing one', async () => {
  await withDb(() => {
    pendingServerActionsDb.insert(makeAction({ id: 'g-empty', sessionId: 'a', reason: 'keep me' }));
    pendingServerActionsDb.appendReason('g-empty', '   ');

    assert.equal(pendingServerActionsDb.getById('g-empty')!.reason, 'keep me');
  });
});

test('T-1684 supersedeSiblings settles every OTHER queued row as history, keeping the executed one', async () => {
  await withDb(() => {
    pendingServerActionsDb.insert(makeAction({ id: 'k-run', sessionId: 'a' }));
    pendingServerActionsDb.insert(makeAction({ id: 'k-other-1', sessionId: 'b' }));
    pendingServerActionsDb.insert(makeAction({ id: 'k-other-2', sessionId: 'c' }));
    pendingServerActionsDb.markFailed('k-other-2', 'earlier gate deferral');

    const satisfied = pendingServerActionsDb.supersedeSiblings('safe-restart', 'k-run');

    assert.equal(satisfied, 2, 'both the pending and the failed sibling are satisfied by this run');
    assert.equal(pendingServerActionsDb.getById('k-run')?.status, 'pending', 'the executed row is untouched here');
    // Retained, not deleted: the owner must still see that their request was met.
    for (const id of ['k-other-1', 'k-other-2']) {
      const row = pendingServerActionsDb.getById(id)!;
      assert.equal(row.status, 'superseded');
      assert.ok(row.settledAt, 'a settled sibling starts its retention hour');
    }
    assert.deepEqual(pendingServerActionsDb.listHistory().map(({ id }) => id).sort(),
      ['k-other-1', 'k-other-2']);
    assert.equal(pendingServerActionsDb.countActionable(), 1, 'only the kept row still waits');
  });
});

test('supersedeSiblings never touches an executing row or a different action type', async () => {
  await withDb(() => {
    pendingServerActionsDb.insert(makeAction({ id: 'c-run', sessionId: 'a' }));
    pendingServerActionsDb.insert(makeAction({ id: 'c-executing', sessionId: 'b' }));
    pendingServerActionsDb.claimForExecution('c-executing');
    pendingServerActionsDb.insert(makeAction({ id: 'c-other-type', actionType: 'some-other', sessionId: 'c' }));

    const satisfied = pendingServerActionsDb.supersedeSiblings('safe-restart', 'c-run');

    assert.equal(satisfied, 0, 'an in-flight run and an unrelated action are not satisfied by this one');
    assert.equal(pendingServerActionsDb.getById('c-executing')?.status, 'executing');
    assert.equal(pendingServerActionsDb.getById('c-other-type')?.status, 'pending');
  });
});

test('clearSatisfiedBefore requires a proven build identity even for pre-boot requests', async () => {
  await withDb(() => {
    pendingServerActionsDb.insert(makeAction({ id: 'before-boot', sessionId: 'old' }));
    pendingServerActionsDb.insert(makeAction({ id: 'after-boot', sessionId: 'new' }));
    getConnection().prepare(
      `UPDATE pending_server_actions SET requested_at = ? WHERE id = ?`,
    ).run('2026-08-17 01:00:00', 'before-boot');
    getConnection().prepare(
      `UPDATE pending_server_actions SET requested_at = ? WHERE id = ?`,
    ).run('2026-08-17 03:00:00', 'after-boot');

    assert.equal(
      pendingServerActionsDb.clearSatisfiedBefore('safe-restart', '2026-08-17T02:00:00.000Z'),
      0,
    );
    assert.equal(pendingServerActionsDb.getById('before-boot')?.status, 'pending');
    assert.equal(pendingServerActionsDb.getById('before-boot')?.error, null);
    assert.equal(pendingServerActionsDb.getById('after-boot')?.status, 'pending');
  });
});

test('ADR-129 dedup and sibling clearing are scoped to expected server build identity', async () => {
  await withDb(() => {
    const buildA = 'a'.repeat(64);
    const buildB = 'b'.repeat(64);
    assert.equal(pendingServerActionsDb.insert(makeAction({
      id: 'build-a', sessionId: 'same', expectedServerBuildId: buildA,
    })), 1);
    assert.equal(pendingServerActionsDb.insert(makeAction({
      id: 'build-b', sessionId: 'same', expectedServerBuildId: buildB,
    })), 1, 'different generations must not dedup together');
    assert.equal(pendingServerActionsDb.getPendingByDedup('safe-restart', 'same', buildA)?.id, 'build-a');
    assert.equal(pendingServerActionsDb.getQueuedByActionType('safe-restart', buildB)?.id, 'build-b');
    assert.equal(pendingServerActionsDb.supersedeSiblings('safe-restart', 'build-b', buildB), 0);
    assert.equal(pendingServerActionsDb.getById('build-a')?.status, 'pending');
  });
});

test('ADR-129 A to B permanently supersedes A and boot only clears the loaded generation', async () => {
  await withDb(() => {
    const buildA = 'a'.repeat(64);
    const buildB = 'b'.repeat(64);
    pendingServerActionsDb.insert(makeAction({ id: 'stale-a', expectedServerBuildId: buildA }));
    pendingServerActionsDb.insert(makeAction({ id: 'current-b', expectedServerBuildId: buildB }));
    assert.equal(pendingServerActionsDb.supersedeOtherGenerations('safe-restart', buildB), 1);
    assert.equal(pendingServerActionsDb.getById('stale-a')?.status, 'superseded');
    assert.equal(pendingServerActionsDb.claimForExecution('stale-a'), 0);

    assert.equal(
      pendingServerActionsDb.clearSatisfiedBefore('safe-restart', '2999-01-01T00:00:00.000Z', buildB),
      1,
    );
    assert.equal(pendingServerActionsDb.getById('stale-a')?.status, 'superseded');
    assert.equal(pendingServerActionsDb.getById('current-b')?.status, 'superseded');
    assert.equal(pendingServerActionsDb.getById('current-b')?.error, 'satisfied_by_server_start');
  });
});

test('boot reconciliation preserves all executing actions until exact transaction evidence arrives', async () => {
  await withDb(() => {
    const loadedBuild = 'c'.repeat(64);
    const otherBuild = 'd'.repeat(64);
    pendingServerActionsDb.insert(makeAction({
      id: 'loaded-executing', sessionId: 'loaded', expectedServerBuildId: loadedBuild,
    }));
    pendingServerActionsDb.insert(makeAction({
      id: 'other-executing', sessionId: 'other', expectedServerBuildId: otherBuild,
    }));
    pendingServerActionsDb.claimForExecution('loaded-executing');
    pendingServerActionsDb.claimForExecution('other-executing');
    getConnection().prepare(
      `UPDATE pending_server_actions SET requested_at = ? WHERE id IN (?, ?)`,
    ).run('2026-08-17 01:00:00', 'loaded-executing', 'other-executing');

    assert.equal(
      pendingServerActionsDb.clearSatisfiedBefore(
        'safe-restart', '2026-08-17T02:00:00.000Z', loadedBuild,
      ),
      0,
    );
    assert.equal(pendingServerActionsDb.getById('loaded-executing')?.status, 'executing');
    assert.equal(
      pendingServerActionsDb.getById('loaded-executing')?.error,
      null,
    );
    assert.equal(pendingServerActionsDb.getById('other-executing')?.status, 'executing');
    assert.equal(
      pendingServerActionsDb.getById('other-executing')?.error,
      null,
    );
  });
});

test('generation-bound enqueue atomically fences different and unbound work without deleting audit rows', async () => {
  await withDb(() => {
    const buildA = 'a'.repeat(64);
    const buildB = 'b'.repeat(64);
    pendingServerActionsDb.insert(makeAction({ id: 'old-bound', expectedServerBuildId: buildA }));
    pendingServerActionsDb.insert(makeAction({ id: 'old-unbound', sessionId: 'legacy' }));
    pendingServerActionsDb.markFailed('old-unbound', 'old failure');
    pendingServerActionsDb.insert(makeAction({
      id: 'unrelated', actionType: 'some-other', sessionId: 'unrelated',
    }));

    const result = pendingServerActionsDb.enqueueGenerationBoundGlobal(makeAction({
      id: 'new-bound', expectedServerBuildId: buildB, reason: 'activate B',
    }));

    assert.equal(result.inserted, true);
    assert.equal(result.superseded, 2);
    assert.equal(pendingServerActionsDb.getById('old-bound')?.status, 'superseded');
    assert.equal(pendingServerActionsDb.getById('old-unbound')?.status, 'superseded');
    assert.equal(pendingServerActionsDb.getById('old-bound')?.error, 'superseded_by:new-bound');
    assert.equal(pendingServerActionsDb.getById('unrelated')?.status, 'pending');
    assert.equal(pendingServerActionsDb.listActionable().some(({ id }) => id === 'old-bound'), false);
  });
});

test('generation-bound enqueue collapses the same build and preserves both reasons', async () => {
  await withDb(() => {
    const build = 'c'.repeat(64);
    pendingServerActionsDb.insert(makeAction({
      id: 'same-build-old', expectedServerBuildId: build, reason: 'first reason',
    }));
    pendingServerActionsDb.markFailed('same-build-old', 'retryable');

    const result = pendingServerActionsDb.enqueueGenerationBoundGlobal(makeAction({
      id: 'same-build-new', expectedServerBuildId: build, reason: 'second reason',
    }));

    assert.equal(result.inserted, false);
    assert.equal(result.row.id, 'same-build-old');
    assert.equal(result.row.status, 'failed');
    assert.match(result.row.reason ?? '', /first reason/);
    assert.match(result.row.reason ?? '', /second reason/);
    assert.equal(pendingServerActionsDb.getById('same-build-new'), null);
  });
});

test('generation-bound enqueue fences pre-existing same-build duplicates and keeps one pending action', async () => {
  await withDb(() => {
    const build = 'd'.repeat(64);
    pendingServerActionsDb.insert(makeAction({
      id: 'same-build-pending', sessionId: 'one', expectedServerBuildId: build,
    }));
    pendingServerActionsDb.insert(makeAction({
      id: 'same-build-failed', sessionId: 'two', expectedServerBuildId: build,
    }));
    pendingServerActionsDb.markFailed('same-build-failed', 'old failure');

    const result = pendingServerActionsDb.enqueueGenerationBoundGlobal(makeAction({
      id: 'same-build-third', sessionId: 'three', expectedServerBuildId: build,
    }));

    assert.equal(result.inserted, false);
    assert.equal(result.row.id, 'same-build-pending');
    assert.equal(result.superseded, 1);
    assert.equal(pendingServerActionsDb.getById('same-build-failed')?.status, 'superseded');
    assert.equal(
      pendingServerActionsDb.getById('same-build-failed')?.error,
      'superseded_by:same-build-pending',
    );
    assert.deepEqual(
      pendingServerActionsDb.listActionable().filter(({ actionType }) => actionType === 'safe-restart')
        .map(({ id }) => id),
      ['same-build-pending'],
    );
  });
});

 test('old boot cannot settle a different queued build or reap its unknown execution', async () => {
  await withDb(() => {
    const build = 'a'.repeat(64);
    pendingServerActionsDb.insert(makeAction({ id: 'different-build', expectedServerBuildId: build }));
    assert.equal(pendingServerActionsDb.clearSatisfiedBefore('safe-restart', '2999-01-01', 'b'.repeat(64)), 0);
    assert.equal(pendingServerActionsDb.getById('different-build')?.status, 'pending');
    pendingServerActionsDb.claimForExecution('different-build');
    assert.equal(pendingServerActionsDb.reapStaleExecuting(0), 0);
    assert.equal(pendingServerActionsDb.getById('different-build')?.status, 'executing');
  });
});

test('dismiss cannot remove the identity of a claimed action', async () => {
  await withDb(() => {
    pendingServerActionsDb.insert(makeAction({ id: 'claimed' }));
    pendingServerActionsDb.claimForExecution('claimed');
    assert.equal(pendingServerActionsDb.dismissById('claimed'), 0);
    assert.equal(pendingServerActionsDb.getById('claimed')?.status, 'executing');
  });
});

test('attempt CAS rejects duplicate claim, stale nonce, wrong build and terminal resurrection', async () => {
  await withDb(() => {
    const build = 'a'.repeat(64);
    pendingServerActionsDb.insert(makeAction({ id: 'attempt', expectedServerBuildId: build }));
    assert.equal(pendingServerActionsDb.claimForExecution('attempt'), 1);
    const first = pendingServerActionsDb.getById('attempt')!.executionAttemptNonce!;
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(pendingServerActionsDb.claimForExecution('attempt'), 0);
    assert.equal(pendingServerActionsDb.settleExecution('attempt', first, 'b'.repeat(64), 'pending', 'live_work'), 0);
    assert.equal(pendingServerActionsDb.settleExecution('attempt', first, build, 'pending', 'live_work'), 1);
    assert.equal(pendingServerActionsDb.getById('attempt')?.error, 'live_work');
    assert.equal(pendingServerActionsDb.claimForExecution('attempt'), 1);
    const second = pendingServerActionsDb.getById('attempt')!.executionAttemptNonce!;
    assert.notEqual(second, first);
    assert.equal(pendingServerActionsDb.settleExecution('attempt', first, build, 'superseded', 'oid_loaded'), 0);
    assert.equal(pendingServerActionsDb.settleExecution('attempt', second, build, 'superseded', 'oid_loaded'), 1);
    assert.equal(pendingServerActionsDb.settleExecution('attempt', second, build, 'pending', 'live_work'), 0);
  });
});

test('deferring A after B enqueue preserves A history without violating the pending UNIQUE key', async () => {
  await withDb(() => {
    const build = 'f'.repeat(64);
    pendingServerActionsDb.insert(makeAction({ id: 'attempt-A', sessionId: 'same-session', expectedServerBuildId: build }));
    pendingServerActionsDb.claimForExecution('attempt-A');
    const before = pendingServerActionsDb.getById('attempt-A')!;
    pendingServerActionsDb.insert(makeAction({ id: 'request-B', sessionId: 'same-session', expectedServerBuildId: build }));
    assert.equal(pendingServerActionsDb.settleExecution('attempt-A', '0'.repeat(64), build, 'pending', 'live_work'), 0);
    assert.equal(pendingServerActionsDb.settleExecution('attempt-A', before.executionAttemptNonce!, build, 'pending', 'live_work'), 1);
    const after = pendingServerActionsDb.getById('attempt-A')!;
    assert.equal(after.status, 'superseded');
    assert.equal(after.error, 'superseded_by:request-B');
    assert.equal(after.executionAttemptNonce, before.executionAttemptNonce);
    assert.equal(after.executedAt, before.executedAt);
    assert.equal(pendingServerActionsDb.getById('request-B')?.status, 'pending');
    assert.equal(pendingServerActionsDb.settleExecution('attempt-A', before.executionAttemptNonce!, build, 'pending', 'live_work'), 0);
  });
});

// ── B-1057 / ADR-156 WI-1: the eternally-pending row ─────────────────────────

test('B-1057 resetToPending clears the execution nonce so the row reads as freshly queued', async () => {
  await withDb(() => {
    const build = 'a'.repeat(64);
    pendingServerActionsDb.insert(makeAction({ id: 'deferred', expectedServerBuildId: build }));
    assert.equal(pendingServerActionsDb.claimForExecution('deferred'), 1);
    assert.match(pendingServerActionsDb.getById('deferred')!.executionAttemptNonce!, /^[a-f0-9]{64}$/);

    assert.equal(pendingServerActionsDb.resetToPending('deferred', 'live_sessions'), 1);
    const after = pendingServerActionsDb.getById('deferred')!;
    assert.equal(after.status, 'pending');
    assert.equal(after.executedAt, null);
    assert.equal(after.executionAttemptNonce, null, 'a deferred row must carry no stamp from the undone attempt');
    // The stale nonce can no longer settle the row it no longer owns.
    assert.equal(pendingServerActionsDb.settleExecution('deferred', 'b'.repeat(64), build, 'succeeded', 'x'), 0);
  });
});

test('B-1057 boot settles a DEFERRED pending row that still carries a stale nonce', async () => {
  await withDb(() => {
    const loadedBuild = 'a'.repeat(64);
    const otherBuild = 'b'.repeat(64);
    // Legacy rows written by pre-fix code: returned to 'pending' with the
    // attempt nonce left behind — exactly the 1.47.0.9 rows that never settled.
    for (const [id, session, build, reason] of [
      ['deferred-null', 'a', loadedBuild, null],
      ['deferred-live-sessions', 'b', loadedBuild, 'live_sessions'],
      ['deferred-live-work', 'c', loadedBuild, 'live_work'],
      ['deferred-pm2', 'd', loadedBuild, 'proc_not_in_pm2'],
      // Reaches the row through settleExecution, which keeps the nonce, so
      // without the allowance nothing could ever settle it (B-1057, other path).
      ['deferred-oid-control', 'f', loadedBuild, 'oid_control_deferred'],
      ['deferred-other-build', 'e', otherBuild, 'live_sessions'],
    ] as const) {
      pendingServerActionsDb.insert(makeAction({ id, sessionId: session, expectedServerBuildId: build }));
      pendingServerActionsDb.claimForExecution(id);
      getConnection().prepare(
        `UPDATE pending_server_actions
         SET status = 'pending', executed_at = NULL, settled_at = NULL, error = ?, requested_at = ?
         WHERE id = ?`,
      ).run(reason, '2026-08-17 01:00:00', id);
      assert.ok(pendingServerActionsDb.getById(id)!.executionAttemptNonce, `${id} must keep its nonce`);
    }

    assert.equal(
      pendingServerActionsDb.clearSatisfiedBefore('safe-restart', '2026-08-17T02:00:00.000Z', loadedBuild),
      5,
      'every deferred row on the LOADED generation must settle at boot',
    );
    for (const id of ['deferred-null', 'deferred-live-sessions', 'deferred-live-work',
      'deferred-pm2', 'deferred-oid-control']) {
      const settled = pendingServerActionsDb.getById(id)!;
      assert.equal(settled.status, 'superseded', id);
      assert.equal(settled.error, 'satisfied_by_server_start', id);
    }
    // A row bound to a different build is still none of this boot's business.
    assert.equal(pendingServerActionsDb.getById('deferred-other-build')?.status, 'pending');
  });
});

test('م-5 boot never overwrites a row that carries a real execution verdict', async () => {
  await withDb(() => {
    const loadedBuild = 'a'.repeat(64);
    // Every one of these has a nonce AND an error that records what an attempt
    // actually produced. Boot cannot prove an outcome, so it must not claim one.
    const verdicts = [
      ['failed-manual', 'm', 'failed', 'oid_manual_recovery_required'],
      ['failed-unresolved', 'u', 'failed', 'execution_unresolved'],
      ['pending-manual', 'p', 'pending', 'oid_manual_recovery_required'],
      ['pending-unknown-code', 'k', 'pending', 'oid_control_unrecognised'],
    ] as const;
    for (const [id, session, status, error] of verdicts) {
      pendingServerActionsDb.insert(makeAction({ id, sessionId: session, expectedServerBuildId: loadedBuild }));
      pendingServerActionsDb.claimForExecution(id);
      getConnection().prepare(
        `UPDATE pending_server_actions
         SET status = ?, executed_at = NULL, settled_at = NULL, error = ?, requested_at = ?
         WHERE id = ?`,
      ).run(status, error, '2026-08-17 01:00:00', id);
    }

    assert.equal(
      pendingServerActionsDb.clearSatisfiedBefore('safe-restart', '2026-08-17T02:00:00.000Z', loadedBuild),
      0,
      'a recorded verdict is evidence; a server start is not evidence that overturns it',
    );
    for (const [id, , status, error] of verdicts) {
      const row = pendingServerActionsDb.getById(id)!;
      assert.equal(row.status, status, id);
      assert.equal(row.error, error, id);
    }
  });
});

test('م-5 a freshly deferred row needs no legacy allowance — its nonce is already gone', async () => {
  await withDb(() => {
    const loadedBuild = 'a'.repeat(64);
    pendingServerActionsDb.insert(makeAction({ id: 'fresh', expectedServerBuildId: loadedBuild }));
    pendingServerActionsDb.claimForExecution('fresh');
    assert.equal(pendingServerActionsDb.resetToPending('fresh', 'live_sessions'), 1);
    assert.equal(pendingServerActionsDb.getById('fresh')!.executionAttemptNonce, null);
    getConnection().prepare('UPDATE pending_server_actions SET requested_at = ? WHERE id = ?')
      .run('2026-08-17 01:00:00', 'fresh');

    assert.equal(
      pendingServerActionsDb.clearSatisfiedBefore('safe-restart', '2026-08-17T02:00:00.000Z', loadedBuild),
      1,
    );
    assert.equal(pendingServerActionsDb.getById('fresh')?.error, 'satisfied_by_server_start');
  });
});


test('local pair queue replaces a same-server action for another client digest but reuses the exact pair', async () => {
  await withDb(() => {
    const first = makeAction({ reason: 'local-update:1', requestedBy: 'local-update:1',
      expectedServerBuildId: 'a'.repeat(64), releaseCommit: 'b'.repeat(40), activationIdentitySha256: 'c'.repeat(64) });
    const original = pendingServerActionsDb.enqueueGenerationBoundGlobal(first);
    const second = { ...first, id: crypto.randomUUID(), reason: 'local-update:2', activationIdentitySha256: 'd'.repeat(64) };
    const replaced = pendingServerActionsDb.enqueueGenerationBoundGlobal(second);
    assert.equal(replaced.inserted, true);
    assert.equal(pendingServerActionsDb.getById(original.row.id)?.status, 'superseded');
    assert.equal(pendingServerActionsDb.enqueueGenerationBoundGlobal({ ...second, id: crypto.randomUUID() }).row.id, replaced.row.id);
  });
});

for (const status of ['pending', 'failed'] as const) test(`B-1157 repeated local enqueue preserves exact identity and SQL claim from ${status}`, async () => {
  await withDb(() => {
    const input = makeAction({ reason: 'local-update:1', requestedBy: 'local-update:7', expectedServerBuildId: 'a'.repeat(64),
      releaseCommit: 'b'.repeat(40), activationIdentitySha256: 'c'.repeat(64) });
    const first = pendingServerActionsDb.enqueueGenerationBoundGlobal(input);
    if (status === 'failed') pendingServerActionsDb.markFailed(first.row.id, 'live_sessions');
    for (let attempt = 0; attempt < 3; attempt++) {
      const replay = pendingServerActionsDb.enqueueGenerationBoundGlobal({ ...input, id: crypto.randomUUID() });
      assert.equal(replay.row.id, first.row.id); assert.equal(replay.inserted, false); assert.equal(replay.superseded, 0);
      assert.equal(replay.row.reason, input.reason); assert.equal(replay.row.requestedBy, input.requestedBy);
      assert.equal(replay.row.activationIdentitySha256, input.activationIdentitySha256);
    }
    const otherAsker = pendingServerActionsDb.enqueueGenerationBoundGlobal({ ...input, id: crypto.randomUUID(), reason: 'human context' });
    assert.equal(otherAsker.row.reason, input.reason);
    assert.ok(pendingServerActionsDb.claimForExecution(first.row.id));
    const claimed = pendingServerActionsDb.getById(first.row.id)!;
    assert.equal(claimed.status, 'executing'); assert.equal(claimed.reason, input.reason); assert.ok(claimed.executionAttemptNonce);
  });
});
for (const changed of [
  { reason: 'local-update:2' }, { requestedBy: 'local-update:8' },
  { releaseCommit: 'd'.repeat(40) }, { activationIdentitySha256: 'e'.repeat(64) },
]) test(`B-1157 local identity conflict ${Object.keys(changed)[0]} cannot reuse prior action`, async () => {
  await withDb(() => {
    const input = makeAction({ reason: 'local-update:1', requestedBy: 'local-update:7', expectedServerBuildId: 'a'.repeat(64),
      releaseCommit: 'b'.repeat(40), activationIdentitySha256: 'c'.repeat(64) });
    const first = pendingServerActionsDb.enqueueGenerationBoundGlobal(input);
    const next = pendingServerActionsDb.enqueueGenerationBoundGlobal({ ...input, ...changed, id: crypto.randomUUID() });
    assert.equal(next.inserted, true); assert.notEqual(next.row.id, first.row.id);
    assert.equal(pendingServerActionsDb.getById(first.row.id)?.status, 'superseded');
  });
});

for (const identity of ['local', 'source', 'human']) test(`B-1158 exact ${identity} executing restart is returned without changing any field`, async () => {
  await withDb(() => {
    const input = makeAction({ expectedServerBuildId: 'a'.repeat(64), reason: identity === 'local' ? 'local-update:1' : 'reviewed restart',
      requestedBy: 'owner', activationIdentitySha256: 'c'.repeat(64), releaseCommit: 'b'.repeat(40),
      ...(identity === 'source' ? { sourceUpdateJobId: 'job', sourceUpdateTransactionId: 'transaction' } : {}) });
    pendingServerActionsDb.enqueueGenerationBoundGlobal(input); pendingServerActionsDb.claimForExecution(input.id);
    // Existing pending rows, including another generation, must not be superseded on this read-only path.
    pendingServerActionsDb.insert(makeAction({ id: 'coexisting-pending', sessionId: 'other', expectedServerBuildId: 'd'.repeat(64), reason: 'unchanged' }));
    const before = getConnection().prepare('SELECT * FROM pending_server_actions ORDER BY id').all();
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = pendingServerActionsDb.enqueueGenerationBoundGlobal({ ...input, id: crypto.randomUUID(), sessionId: 'another-session' });
      assert.equal(result.row.id, input.id); assert.equal(result.row.status, 'executing');
      assert.equal(result.inserted, false); assert.equal(result.superseded, 0);
      assert.deepEqual(getConnection().prepare('SELECT * FROM pending_server_actions ORDER BY id').all(), before);
    }
  });
});
for (const field of ['expectedServerBuildId', 'reason', 'requestedBy', 'activationIdentitySha256', 'releaseCommit', 'sourceUpdateJobId', 'sourceUpdateTransactionId'] as const) {
  test(`B-1158 executing conflict in ${field} rejects before any database row write`, async () => {
    await withDb(() => {
      const input = makeAction({ expectedServerBuildId: 'a'.repeat(64), reason: 'local-update:1', requestedBy: 'local-update:7',
        activationIdentitySha256: 'c'.repeat(64), releaseCommit: 'b'.repeat(40), sourceUpdateJobId: 'job', sourceUpdateTransactionId: 'transaction' });
      pendingServerActionsDb.enqueueGenerationBoundGlobal(input); pendingServerActionsDb.claimForExecution(input.id);
      pendingServerActionsDb.insert(makeAction({ id: 'pending', expectedServerBuildId: 'd'.repeat(64) }));
      const before = getConnection().prepare('SELECT * FROM pending_server_actions ORDER BY id').all();
      assert.throws(() => pendingServerActionsDb.enqueueGenerationBoundGlobal({ ...input, id: crypto.randomUUID(), [field]: 'different' }), /^Error: safe_restart_execution_conflict$/);
      assert.deepEqual(getConnection().prepare('SELECT * FROM pending_server_actions ORDER BY id').all(), before);
    });
  });
}
test('B-1158 multiple identical executing rows reject without choosing or changing either attempt', async () => {
  await withDb(() => {
    const input = makeAction({ expectedServerBuildId: 'a'.repeat(64), reason: 'local-update:1' });
    pendingServerActionsDb.insert(input); pendingServerActionsDb.claimForExecution(input.id);
    const second = { ...input, id: crypto.randomUUID() };
    pendingServerActionsDb.insert(second); pendingServerActionsDb.claimForExecution(second.id);
    const before = getConnection().prepare('SELECT * FROM pending_server_actions ORDER BY id').all();
    assert.throws(() => pendingServerActionsDb.enqueueGenerationBoundGlobal({ ...input, id: crypto.randomUUID() }), /^Error: safe_restart_execution_conflict$/);
    assert.deepEqual(getConnection().prepare('SELECT * FROM pending_server_actions ORDER BY id').all(), before);
  });
});
