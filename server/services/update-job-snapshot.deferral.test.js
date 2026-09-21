/**
 * T-1730 W7 (ADR-156 §3.3, M15). The `deferral` snapshot field is built in the
 * snapshot alone: deadlineAt and rearmCount from the durable row, sessionCount
 * and gateReason from live values passed in. It appears only while the job is
 * parked, and `cancelled` is a clean terminal state, never a failure. A new
 * file; the existing update-job-snapshot.test.js belongs to the tester.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveUpdateJobDeferral, deriveUpdateJobFailure } from './update-job-snapshot.js';

test('W7 snapshot: deferral is null unless the job is parked in awaiting_sessions', () => {
    for (const state of ['accepted', 'staging', 'restart_queued', 'cancelled', 'failed']) {
        assert.equal(deriveUpdateJobDeferral({ state }, { sessionCount: 2 }), null, `no deferral for ${state}`);
    }
});

test('W7 snapshot: deferral merges the durable row with live session/gate values', () => {
    const job = {
        state: 'awaiting_sessions', deferral_deadline_at: 1_700_000_000_000, deferral_rearm_count: 2,
    };
    assert.deepEqual(deriveUpdateJobDeferral(job, { sessionCount: 3, gateReason: 'pty_shell' }), {
        deadlineAt: 1_700_000_000_000, sessionCount: 3, gateReason: 'pty_shell', rearmCount: 2,
    });
});

test('W7 snapshot: missing live values and a null deadline degrade cleanly', () => {
    const job = { state: 'awaiting_sessions', deferral_deadline_at: null, deferral_rearm_count: 0 };
    assert.deepEqual(deriveUpdateJobDeferral(job), {
        deadlineAt: null, sessionCount: null, gateReason: null, rearmCount: 0,
    });
});

test('W7 snapshot: cancelled is not a failure — no red error panel', () => {
    const failure = deriveUpdateJobFailure({ id: 'j', state: 'cancelled' }, { listReceipts: () => [] });
    assert.deepEqual(failure, { failedPhase: null, errorCode: null, message: null, manifestDrift: null });
});
