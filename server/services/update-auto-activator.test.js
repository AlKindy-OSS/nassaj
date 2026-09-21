import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AUTO_ACTIVATE_DEADLINE_MS, createUpdateAutoActivator, parseDbTimestamp,
} from './update-auto-activator.js';

const QUEUED_AT = Date.UTC(2026, 8, 12, 10, 0, 0);
const job = (id = 'job-1') => ({ id, owner_id: 1, state: 'restart_queued', auto_activate: 1, updated_at: '2026-09-12 10:00:00' });
const receipts = [{ phase: 'restart_queued', kind: 'done', created_at: '2026-09-12 10:00:00' }];

function harness({ jobs = [job()], rows = [{ id: 7, sourceUpdateJobId: 'job-1', status: 'pending' }],
    sessions = 0, user = { id: 1, role: 'owner' }, reply = { status: 200, body: { status: 'restarting' } },
    now = QUEUED_AT + 1_000, beforeTick } = {}) {
    const calls = { executed: [], audit: [], lines: [] };
    const state = { sessions, now, reply };
    const activator = createUpdateAutoActivator({
        jobs: { listAutoActivatable: () => jobs, listReceipts: () => receipts },
        listQueuedRestarts: () => rows,
        countSessions: () => { if (state.sessions instanceof Error) throw state.sessions; return state.sessions; },
        executeAsOwner: async (input) => { calls.executed.push(input); return state.reply; },
        getUser: () => user,
        audit: (action, details) => calls.audit.push({ action, details }),
        jobLog: { line: (jobId, message) => calls.lines.push({ jobId, message }) },
        now: () => state.now,
        beforeTick,
    });
    return { activator, calls, state };
}

test('parses SQLite UTC timestamps and ISO strings (T-1751)', () => {
    assert.equal(parseDbTimestamp('2026-09-12 10:00:00'), QUEUED_AT);
    assert.equal(parseDbTimestamp('2026-09-12T10:00:00.000Z'), QUEUED_AT);
    assert.equal(parseDbTimestamp(''), null);
    assert.equal(parseDbTimestamp('not a date'), null);
});

test('recovery runs before queue reads and closed admission defers activation until a later tick', async () => {
    let open = false;
    let recoveries = 0;
    const { activator, calls } = harness({ beforeTick: async () => { recoveries += 1; return open; } });
    await activator.tick();
    assert.equal(recoveries, 1);
    assert.equal(calls.executed.length, 0);
    open = true;
    await activator.tick();
    assert.equal(recoveries, 2);
    assert.equal(calls.executed.length, 1);
});

test('an idle node runs the job\'s own queued row as the consenting owner', async () => {
    const { activator, calls } = harness();
    await activator.tick();
    assert.deepEqual(calls.executed, [{ id: 7, user: { id: 1, role: 'owner' } }]);
    assert.equal(activator.statusFor('job-1').state, 'restarting');
    assert.equal(activator.statusFor('job-1').deadlineAt, QUEUED_AT + AUTO_ACTIVATE_DEADLINE_MS);
    assert.deepEqual(calls.audit.map((entry) => entry.action), ['update_auto_activate_attempt']);
});

test('live sessions are waited on, never executed against, and logged once per change', async () => {
    const { activator, calls, state } = harness({ sessions: 2 });
    await activator.tick();
    await activator.tick();
    assert.equal(calls.executed.length, 0);
    assert.deepEqual(activator.statusFor('job-1'), {
        state: 'waiting_sessions', code: 'live_sessions', liveSessions: 2,
        deadlineAt: QUEUED_AT + AUTO_ACTIVATE_DEADLINE_MS, checkedAt: state.now,
    });
    assert.equal(calls.lines.length, 1);
    state.sessions = 1;
    await activator.tick();
    assert.equal(calls.lines.length, 2);
    state.sessions = 0;
    await activator.tick();
    assert.equal(calls.executed.length, 1);
});

test('an unreadable session count is treated as busy, not idle', async () => {
    const { activator, calls } = harness({ sessions: new Error('boom') });
    await activator.tick();
    assert.equal(calls.executed.length, 0);
    assert.equal(activator.statusFor('job-1').state, 'waiting_sessions');
});

test('a deferral from the safe-restart gate keeps waiting with the gate\'s count', async () => {
    const { activator } = harness({ reply: { status: 200, body: { status: 'deferred', reasonCode: 'live_sessions', sessionCount: 1 } } });
    await activator.tick();
    assert.equal(activator.statusFor('job-1').state, 'waiting_sessions');
    assert.equal(activator.statusFor('job-1').liveSessions, 1);
});

test('a refusal is reported with its code and retried on the next tick', async () => {
    const { activator, calls, state } = harness({ reply: { status: 409, body: { status: 'error', code: 'action_in_flight' } } });
    await activator.tick();
    assert.deepEqual([activator.statusFor('job-1').state, activator.statusFor('job-1').code], ['refused', 'action_in_flight']);
    state.reply = { status: 200, body: { status: 'restarting' } };
    await activator.tick();
    assert.equal(calls.executed.length, 2);
    assert.equal(activator.statusFor('job-1').state, 'restarting');
});

test('after the deadline the row is left for the button and the expiry is audited once', async () => {
    const { activator, calls } = harness({ now: QUEUED_AT + AUTO_ACTIVATE_DEADLINE_MS });
    await activator.tick();
    await activator.tick();
    assert.equal(calls.executed.length, 0);
    assert.equal(activator.statusFor('job-1').state, 'expired');
    assert.deepEqual(calls.audit.map((entry) => entry.action), ['update_auto_activate_expired']);
});

test('no restart without the job\'s own pending row or an active owner', async () => {
    const noRow = harness({ rows: [{ id: 9, sourceUpdateJobId: 'other-job', status: 'pending' }] });
    await noRow.activator.tick();
    assert.equal(noRow.calls.executed.length, 0);
    assert.equal(noRow.activator.statusFor('job-1').state, 'waiting_row');

    const failedRow = harness({ rows: [{ id: 7, sourceUpdateJobId: 'job-1', status: 'failed' }] });
    await failedRow.activator.tick();
    assert.equal(failedRow.calls.executed.length, 0);

    const demoted = harness({ user: { id: 1, role: 'admin' } });
    await demoted.activator.tick();
    assert.equal(demoted.calls.executed.length, 0);
    assert.equal(demoted.activator.statusFor('job-1').code, 'owner_unavailable');

    const gone = harness({ user: null });
    await gone.activator.tick();
    assert.equal(gone.calls.executed.length, 0);
});

test('one restart per tick, and statuses of finished jobs are dropped', async () => {
    const jobs = [job('job-1'), job('job-2')];
    const rows = [
        { id: 7, sourceUpdateJobId: 'job-1', status: 'pending' },
        { id: 8, sourceUpdateJobId: 'job-2', status: 'pending' },
    ];
    const { activator, calls } = harness({ jobs, rows });
    await activator.tick();
    assert.deepEqual(calls.executed.map((input) => input.id), [7]);
    jobs.splice(0, jobs.length);
    await activator.tick();
    assert.equal(activator.statusFor('job-1'), null);
});

test('dependencies are required', () => {
    assert.throws(() => createUpdateAutoActivator({}), TypeError);
});

test('policy authority activates without a manual receipt and revocation after preparation blocks execution', async () => {
    const authority = { kind: 'policy', grantDigest: 'a'.repeat(64), issuedAt: QUEUED_AT };
    let valid = true, revokeOnPrepare = true, prepares = 0, executions = 0, activeOwner = true;
    const policyJob = { id: 'local-update:1', owner_id: 1, activationAuthority: authority };
    const activator = createUpdateAutoActivator({
        jobs: { listAutoActivatable: () => [policyJob], listReceipts: () => assert.fail('no fake manual receipt'),
            readActivationAuthority: () => valid ? authority : null },
        prepareJob: async () => { prepares++; if (revokeOnPrepare) valid = false; },
        listQueuedRestarts: () => [{ id: 1, sourceUpdateJobId: policyJob.id, status: 'pending' }], countSessions: () => 0,
        getUser: () => activeOwner ? { id: 1, role: 'owner' } : null,
        executeAsOwner: async () => { executions++; return { status: 200, body: { status: 'restarting' } }; },
        now: () => QUEUED_AT + 1000,
    });
    await activator.tick(); assert.equal(prepares, 1); assert.equal(executions, 0);
    valid = true; revokeOnPrepare = false; activeOwner = false;
    await activator.tick(); assert.equal(prepares, 1); assert.equal(executions, 0);
    activeOwner = true;
    await activator.tick(); assert.equal(executions, 1);
});
