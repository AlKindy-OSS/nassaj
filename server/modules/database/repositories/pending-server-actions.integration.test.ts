/**
 * Integration tests for pending-server-actions.db.ts repository (ADR-066, T-944).
 *
 * Each test group uses a fully isolated in-process SQLite database (temp dir +
 * process.env.DATABASE_PATH swap + closeConnection) so the live DB is never
 * touched. Schema is bootstrapped via initializeDatabase (which calls
 * runMigrations, creating the table and its indexes).
 *
 * Coverage:
 *   - insert: new row returns 1; dedup (same actionType+sessionId pending) returns 0
 *   - insert: null-session dedup (IFNULL(session_id,'') key)
 *   - listActionable: pending+failed visible, executing excluded
 *   - listActionable ordering: oldest first
 *   - countActionable: reflects pending+failed only
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

import { closeConnection } from '@/modules/database/connection.js';
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

test('countActionable: reflects pending + failed count, excludes executing', async () => {
  await withDb(() => {
    assert.equal(pendingServerActionsDb.countActionable(), 0, 'empty queue must return 0');

    const p = makeAction({ sessionId: 'cnt-p' });
    const f = makeAction({ sessionId: 'cnt-f' });
    const e = makeAction({ sessionId: 'cnt-e' });
    pendingServerActionsDb.insert(p);
    pendingServerActionsDb.insert(f);
    pendingServerActionsDb.insert(e);
    assert.equal(pendingServerActionsDb.countActionable(), 3);

    pendingServerActionsDb.markFailed(f.id, 'err');
    pendingServerActionsDb.claimForExecution(e.id);

    assert.equal(
      pendingServerActionsDb.countActionable(),
      2,
      'executing row must not be counted'
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

    pendingServerActionsDb.resetToPending(action.id);
    const row = pendingServerActionsDb.getById(action.id);
    assert.ok(row !== null);
    assert.equal(row!.status, 'pending');
    assert.equal(row!.executedAt, null);
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

test('B-200 resetToPending: a retry whose dedup twin is already pending drops the row instead of throwing', async () => {
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
    assert.equal(pendingServerActionsDb.getById(failed.id), null, 'the redundant row is dropped');
    assert.equal(pendingServerActionsDb.getById(fresh.id)!.status, 'pending', 'the twin survives');
  });
});

// ── B-185 (ب): abandoned 'executing' rows are reaped ─────────────────────────

test('B-185 reapStaleExecuting: an executing row older than the horizon returns to pending', async () => {
  await withDb(() => {
    const action = makeAction({ sessionId: 'b185-stale' });
    pendingServerActionsDb.insert(action);
    pendingServerActionsDb.claimForExecution(action.id);
    assert.equal(pendingServerActionsDb.listActionable().length, 0, 'executing is invisible to the queue');

    // maxAgeMs=0 → every executing row counts as stale (deterministic; no sleep).
    const reaped = pendingServerActionsDb.reapStaleExecuting(0);
    assert.equal(reaped, 1);
    assert.equal(pendingServerActionsDb.getById(action.id)!.status, 'pending');
    assert.equal(pendingServerActionsDb.listActionable().length, 1, 'the row is actionable again');
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

// ── B-200: pruneTerminal is flag-gated but no longer dead ────────────────────

test('B-200 pruneTerminal: returns 0 and deletes nothing while the retention flag is off', async () => {
  await withDb(() => {
    const prev = process.env.NASSAJ_PENDING_ACTIONS_RETENTION;
    delete process.env.NASSAJ_PENDING_ACTIONS_RETENTION;
    try {
      const action = makeAction({ sessionId: 'prune-off' });
      pendingServerActionsDb.insert(action);
      pendingServerActionsDb.claimForExecution(action.id);
      pendingServerActionsDb.markFailed(action.id, 'old');
      assert.equal(pendingServerActionsDb.pruneTerminal(), 0);
      assert.ok(pendingServerActionsDb.getById(action.id) !== null);
    } finally {
      if (prev === undefined) delete process.env.NASSAJ_PENDING_ACTIONS_RETENTION;
      else process.env.NASSAJ_PENDING_ACTIONS_RETENTION = prev;
    }
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

test('clearSiblings removes every OTHER queued row of the same action, keeping the executed one', async () => {
  await withDb(() => {
    pendingServerActionsDb.insert(makeAction({ id: 'k-run', sessionId: 'a' }));
    pendingServerActionsDb.insert(makeAction({ id: 'k-other-1', sessionId: 'b' }));
    pendingServerActionsDb.insert(makeAction({ id: 'k-other-2', sessionId: 'c' }));
    pendingServerActionsDb.markFailed('k-other-2', 'earlier gate deferral');

    const cleared = pendingServerActionsDb.clearSiblings('safe-restart', 'k-run');

    assert.equal(cleared, 2, 'both the pending and the failed sibling are satisfied by this run');
    assert.equal(pendingServerActionsDb.getById('k-run')?.id, 'k-run', 'the executed row is untouched here');
    assert.equal(pendingServerActionsDb.getById('k-other-1'), null);
    assert.equal(pendingServerActionsDb.getById('k-other-2'), null);
  });
});

test('clearSiblings never touches an executing row or a different action type', async () => {
  await withDb(() => {
    pendingServerActionsDb.insert(makeAction({ id: 'c-run', sessionId: 'a' }));
    pendingServerActionsDb.insert(makeAction({ id: 'c-executing', sessionId: 'b' }));
    pendingServerActionsDb.claimForExecution('c-executing');
    pendingServerActionsDb.insert(makeAction({ id: 'c-other-type', actionType: 'some-other', sessionId: 'c' }));

    const cleared = pendingServerActionsDb.clearSiblings('safe-restart', 'c-run');

    assert.equal(cleared, 0, 'an in-flight run and an unrelated action are not satisfied by this one');
    assert.equal(pendingServerActionsDb.getById('c-executing')?.status, 'executing');
    assert.equal(pendingServerActionsDb.getById('c-other-type')?.id, 'c-other-type');
  });
});
