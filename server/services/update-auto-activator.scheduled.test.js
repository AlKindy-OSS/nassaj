import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createUpdateAutoActivator, resolveScheduledUpdateWindowMs,
    SCHEDULED_DEFERRAL_CAP_MS, SCHEDULED_UPDATE_WINDOW_MS,
} from './update-auto-activator.js';
import { deriveUpdateJobScheduledDueSoon } from './update-job-snapshot.js';

// T-1912: soft scheduled-message hold on the restart transition.
const QUEUED_AT = Date.UTC(2026, 8, 12, 10, 0, 0);
const TICK_MS = 30_000;
const DUE = { count: 2, earliestAt: '2026-09-12T10:05:00.000Z' };
const job = () => ({ id: 'job-1', owner_id: 1, state: 'restart_queued', auto_activate: 1, updated_at: '2026-09-12 10:00:00' });
const receipts = [{ phase: 'restart_queued', kind: 'done', created_at: '2026-09-12 10:00:00' }];

function harness({ due = DUE, sessions = 0, withReader = true } = {}) {
    const calls = { executed: [], audit: [], lines: [] };
    const state = { due, sessions, now: QUEUED_AT + 1_000 };
    const activator = createUpdateAutoActivator({
        jobs: { listAutoActivatable: () => [job()], listReceipts: () => receipts },
        listQueuedRestarts: () => [{ id: 7, sourceUpdateJobId: 'job-1', status: 'pending' }],
        countSessions: () => state.sessions,
        executeAsOwner: async (input) => { calls.executed.push(input); return { status: 200, body: { status: 'restarting' } }; },
        getUser: () => ({ id: 1, role: 'owner' }),
        audit: (action, details) => calls.audit.push({ action, details }),
        jobLog: { line: (jobId, message) => calls.lines.push({ jobId, message }) },
        now: () => state.now,
        scheduledDueSoon: withReader ? () => {
            if (state.due instanceof Error) throw state.due;
            return state.due;
        } : null,
    });
    const tickAt = async (advanceMs = TICK_MS) => { state.now += advanceMs; await activator.tick(); };
    return { activator, calls, state, tickAt };
}

test('window resolves from env: default 10 min, 0 disables, malformed keeps default', () => {
    assert.equal(SCHEDULED_UPDATE_WINDOW_MS, 10 * 60_000);
    assert.equal(resolveScheduledUpdateWindowMs({}), SCHEDULED_UPDATE_WINDOW_MS);
    assert.equal(resolveScheduledUpdateWindowMs({ NASSAJ_UPDATE_SCHEDULED_WINDOW_MINUTES: '0' }), 0);
    assert.equal(resolveScheduledUpdateWindowMs({ NASSAJ_UPDATE_SCHEDULED_WINDOW_MINUTES: '15' }), 15 * 60_000);
    for (const bad of ['-5', 'ten', '1.5', '', '99999']) {
        assert.equal(resolveScheduledUpdateWindowMs({ NASSAJ_UPDATE_SCHEDULED_WINDOW_MINUTES: bad }),
            SCHEDULED_UPDATE_WINDOW_MS, bad);
    }
});

test('an idle node holds the restart while a scheduled message is due soon', async () => {
    const { activator, calls, state, tickAt } = harness();
    await tickAt();
    assert.equal(calls.executed.length, 0);
    assert.deepEqual(activator.statusFor('job-1'), {
        state: 'waiting_scheduled', code: 'scheduled_messages_due', liveSessions: 0, scheduledDueSoon: DUE,
        deadlineAt: QUEUED_AT + 24 * 60 * 60 * 1000, checkedAt: state.now,
    });
    state.due = { count: 0, earliestAt: null };
    await tickAt();
    assert.equal(calls.executed.length, 1, 'restart proceeds once nothing is due');
});

test('nothing due, no reader (window 0), or a failing reader never holds the restart', async () => {
    for (const options of [{ due: { count: 0, earliestAt: null } }, { withReader: false }, { due: new Error('db') }]) {
        const { calls, tickAt } = harness(options);
        await tickAt();
        assert.equal(calls.executed.length, 1, JSON.stringify(options));
    }
});

test('live sessions keep precedence and do not advance the scheduled cap clock', async () => {
    const { activator, calls, state, tickAt } = harness({ sessions: 1 });
    for (let index = 0; index < 200; index += 1) await tickAt(); // 100 min of live-session waiting
    assert.equal(activator.statusFor('job-1').state, 'waiting_sessions');
    state.sessions = 0;
    await tickAt();
    assert.equal(activator.statusFor('job-1').state, 'waiting_scheduled', 'cap must not count session time');
    assert.equal(calls.executed.length, 0);
});

test('after 60 cumulative minutes held by scheduled messages alone, the restart proceeds', async () => {
    const { activator, calls, state, tickAt } = harness();
    await tickAt(); // the job's first tick: no previous tick, nothing to charge
    for (let index = 0; index < 60; index += 1) await tickAt(); // 30 min
    state.sessions = 1;
    for (let index = 0; index < 40; index += 1) await tickAt(); // 20 min of sessions, not charged
    state.sessions = 0;
    await tickAt(); // a new streak charges its first interval: 30.5 min
    for (let index = 0; index < 58; index += 1) await tickAt(); // 59.5 min held in total
    assert.equal(activator.statusFor('job-1').state, 'waiting_scheduled');
    assert.equal(calls.executed.length, 0);
    await tickAt(); // 60 min
    assert.equal(calls.executed.length, 1);
    assert.ok(calls.audit.some((entry) => entry.action === 'update_scheduled_deferral_capped'
        && entry.details.heldMs === SCHEDULED_DEFERRAL_CAP_MS));
});

test('owner override skips only the scheduled condition, never live sessions', async () => {
    const { activator, calls, state, tickAt } = harness({ sessions: 2 });
    await tickAt();
    assert.equal(activator.overrideScheduled('job-1'), true);
    assert.equal(activator.overrideScheduled(''), false);
    await tickAt();
    assert.equal(activator.statusFor('job-1').state, 'waiting_sessions', 'override never bypasses live sessions');
    assert.equal(activator.statusFor('job-1').scheduledOverride, true);
    assert.equal(calls.executed.length, 0);
    state.sessions = 0;
    await tickAt();
    assert.equal(calls.executed.length, 1, 'scheduled hold skipped after override');
});

test('status snapshot reports the hold only while scheduled messages hold the restart', () => {
    const holding = {
        state: 'waiting_scheduled', code: 'scheduled_messages_due', liveSessions: 0,
        scheduledDueSoon: { count: 3, earliestAt: '2026-09-12T10:05:00Z', content: 'secret', owners: ['x'] },
    };
    const queuedJob = { state: 'restart_queued' };
    assert.deepEqual(deriveUpdateJobScheduledDueSoon(queuedJob, holding),
        { count: 3, earliestAt: '2026-09-12T10:05:00.000Z' });
    // No hold in effect: awaiting_sessions, restart_queued waiting on sessions or
    // without auto-activation (no activator status), or any other job state.
    assert.equal(deriveUpdateJobScheduledDueSoon({ state: 'awaiting_sessions' }, holding), null);
    assert.equal(deriveUpdateJobScheduledDueSoon({ state: 'downloading' }, holding), null);
    assert.equal(deriveUpdateJobScheduledDueSoon(queuedJob, null), null);
    assert.equal(deriveUpdateJobScheduledDueSoon(queuedJob, { state: 'waiting_sessions', liveSessions: 1 }), null);
    assert.equal(deriveUpdateJobScheduledDueSoon(queuedJob,
        { ...holding, scheduledDueSoon: { count: 0, earliestAt: null } }), null);
});

test('the snapshot never calls a reader: it reuses the activator status', async () => {
    const { activator, tickAt } = harness();
    await tickAt();
    assert.deepEqual(deriveUpdateJobScheduledDueSoon({ state: 'restart_queued' }, activator.statusFor('job-1')), DUE);
});
