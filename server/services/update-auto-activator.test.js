import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AUTO_ACTIVATE_DEADLINE_MS, CONTENTION_BACKOFF_CAP_MS, contentionBackoffMs, createUpdateAutoActivator,
    parseDbTimestamp,
} from './update-auto-activator.js';

const QUEUED_AT = Date.UTC(2026, 8, 12, 10, 0, 0);
const job = (id = 'job-1') => ({ id, owner_id: 1, state: 'restart_queued', auto_activate: 1, updated_at: '2026-09-12 10:00:00' });
const receipts = [{ phase: 'restart_queued', kind: 'done', created_at: '2026-09-12 10:00:00' }];

function harness({ jobs = [job()], rows = [{ id: 7, sourceUpdateJobId: 'job-1', status: 'pending' }],
    sessions = 0, user = { id: 1, role: 'owner' }, reply = { status: 200, body: { status: 'restarting' } },
    now = QUEUED_AT + 1_000, beforeTick, terminals, scheduledDueSoon } = {}) {
    const calls = { executed: [], audit: [], lines: [] };
    const state = { sessions, now, reply, terminals };
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
        scheduledDueSoon,
        openTerminals: terminals === undefined ? null : () => {
            if (state.terminals instanceof Error) throw state.terminals;
            return state.terminals;
        },
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

test('a gate failure that settles the row is terminal: no "retrying", reason and recovery hint', async () => {
    const rows = [{ id: 7, sourceUpdateJobId: 'job-1', status: 'pending' }];
    const { activator, calls, state } = harness({ rows });
    state.reply = { status: 500, body: { status: 'error', code: 'gate_failed', exitCode: 2, reason: 'node required' } };
    const execute = calls.executed;
    // The executor marks the row failed, exactly as system.js does on gate_failed.
    const originalPush = execute.push.bind(execute);
    execute.push = (input) => { rows[0].status = 'failed'; return originalPush(input); };
    await activator.tick();
    const status = activator.statusFor('job-1');
    assert.deepEqual([status.state, status.code, status.terminal, status.reason],
        ['refused', 'gate_failed', true, 'node required']);
    assert.equal(calls.lines.length, 2);
    assert.match(calls.lines[1].message, /gate_failed: node required/);
    assert.match(calls.lines[1].message, /confirm activation again/);
    assert.doesNotMatch(calls.lines[1].message, /retrying/);
    assert.ok(calls.audit.some((entry) => entry.action === 'update_auto_activate_failed'));
    // Later ticks keep the terminal status instead of silently turning into waiting_row.
    await activator.tick();
    await activator.tick();
    assert.equal(calls.executed.length, 1);
    assert.equal(activator.statusFor('job-1').state, 'refused');
    assert.equal(activator.statusFor('job-1').terminal, true);
    assert.equal(calls.lines.length, 2);
});

test('a refusal that leaves the row pending is still retried and not terminal', async () => {
    const { activator } = harness({ reply: { status: 409, body: { status: 'error', code: 'action_in_flight' } } });
    await activator.tick();
    assert.equal(activator.statusFor('job-1').terminal, undefined);
});

test('a refusal while the row is still an unresolved executing claim is not terminal (B-1158)', async () => {
    const rows = [{ id: 7, sourceUpdateJobId: 'job-1', status: 'pending' }];
    const { activator, calls } = harness({ rows, reply: { status: 503, body: { status: 'error', code: 'proc_not_in_pm2' } } });
    const originalPush = calls.executed.push.bind(calls.executed);
    // listActionable excludes an executing claim, so the row disappears from the list.
    calls.executed.push = (input) => { rows.length = 0; return originalPush(input); };
    await activator.tick();
    assert.equal(activator.statusFor('job-1').state, 'refused');
    assert.equal(activator.statusFor('job-1').terminal, undefined);
});

const TERMINALS = { count: 2, attached: 1, detached: 1, usernames: ['owner', 'sara'], detachedClosesAt: QUEUED_AT + 1_800_000 };

test('B-1448: open terminals are waited on without an attempt, named, and logged once per change', async () => {
    const { activator, calls, state } = harness({ terminals: TERMINALS });
    await activator.tick();
    await activator.tick();
    assert.equal(calls.executed.length, 0, 'no executeAsOwner while terminals are open');
    assert.equal(calls.audit.length, 0, 'no attempt audit either');
    const status = activator.statusFor('job-1');
    assert.deepEqual([status.state, status.code, status.openTerminals],
        ['waiting_terminals', 'open_terminals', { ...TERMINALS, snapshot: null }]);
    assert.equal(calls.lines.length, 1);
    assert.match(calls.lines[0].message, /2 open terminal\(s\) \(owner, sara\)/);
    assert.match(calls.lines[0].message, /1 of them detached/);
    state.terminals = { ...TERMINALS, count: 1, attached: 0, usernames: ['sara'] };
    await activator.tick();
    assert.equal(calls.lines.length, 2, 'a changed count is logged again');
    // Closing the last terminal lets the next tick proceed.
    state.terminals = { count: 0 };
    await activator.tick();
    assert.equal(calls.executed.length, 1);
    assert.equal(activator.statusFor('job-1').state, 'restarting');
});

test('B-1448: a failing terminal reader never holds the restart', async () => {
    const { activator, calls } = harness({ terminals: new Error('boom') });
    await activator.tick();
    assert.equal(calls.executed.length, 1);
});

test('B-1448: the executor\'s open-terminal deferral is a wait, never terminal, and is retried', async () => {
    const reply = { status: 200, body: { status: 'deferred', reasonCode: 'open_terminals', retryable: true, requeued: true,
        openTerminals: 1, attachedTerminals: 1, detachedTerminals: 0, terminalUsers: ['sara'], detachedClosesAt: null,
        terminalSnapshot: 'nothex' } };
    const rows = [{ id: 7, sourceUpdateJobId: 'job-1', status: 'pending' }];
    const { activator, calls, state } = harness({ rows, reply });
    await activator.tick();
    let status = activator.statusFor('job-1');
    assert.deepEqual([status.state, status.code, status.terminal], ['waiting_terminals', 'open_terminals', undefined]);
    assert.deepEqual(status.openTerminals,
        { count: 1, attached: 1, detached: 0, usernames: ['sara'], detachedClosesAt: null, snapshot: null });
    assert.match(calls.lines.at(-1).message, /1 open terminal\(s\) \(sara\)/);
    state.reply = { status: 200, body: { status: 'restarting' } };
    await activator.tick();
    assert.equal(calls.executed.length, 2, 'a deferral does not stop the loop');
    status = activator.statusFor('job-1');
    assert.equal(status.state, 'restarting');
    assert.ok(!calls.audit.some((entry) => entry.action === 'update_auto_activate_failed'));
});

test('B-1448: a lock-contention deferral waits and says so; a row not re-queued is reported', async () => {
    const rows = [{ id: 7, sourceUpdateJobId: 'job-1', status: 'pending' }];
    const { activator, calls, state } = harness({ rows, reply: { status: 200,
        body: { status: 'deferred', reasonCode: 'update_lock_contended', retryable: true, requeued: true } } });
    await activator.tick();
    assert.deepEqual([activator.statusFor('job-1').state, activator.statusFor('job-1').code],
        ['waiting_sessions', 'update_lock_contended']);
    assert.match(calls.lines.at(-1).message, /deferred \(update_lock_contended\); retrying/);
    state.reply = { status: 200, body: { status: 'deferred', reasonCode: 'update_lock_contended', requeued: false } };
    state.now += 30_000; // past the first backoff step (M4)
    await activator.tick();
    assert.equal(activator.statusFor('job-1').requeued, false);
    assert.match(calls.lines.at(-1).message, /could not be returned to the queue/);
});

test('B-1448: waiting on terminals still expires at the deadline', async () => {
    const { activator, calls, state } = harness({ terminals: TERMINALS });
    await activator.tick();
    assert.equal(activator.statusFor('job-1').state, 'waiting_terminals');
    state.now = QUEUED_AT + AUTO_ACTIVATE_DEADLINE_MS;
    await activator.tick();
    assert.equal(activator.statusFor('job-1').state, 'expired');
    assert.equal(calls.executed.length, 0);
    assert.ok(calls.audit.some((entry) => entry.action === 'update_auto_activate_expired'));
});

const CONTENDED = { status: 200, body: { status: 'deferred', reasonCode: 'update_lock_contended', requeued: true } };

test('B-1448 M4: the contention backoff doubles from 30 s and is capped at 10 min', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(contentionBackoffMs), [30_000, 60_000, 120_000, 240_000, 480_000, 600_000]);
    assert.equal(contentionBackoffMs(50), CONTENTION_BACKOFF_CAP_MS);
    assert.equal(contentionBackoffMs(0), 0);
});

test('B-1448 M4: consecutive lock contention backs off; no attempt or audit inside the window', async () => {
    const { activator, calls, state } = harness({ reply: CONTENDED });
    const attempts = () => calls.audit.filter((entry) => entry.action === 'update_auto_activate_attempt').length;
    await activator.tick();
    assert.equal(calls.executed.length, 1);
    assert.equal(activator.statusFor('job-1').retryAt, state.now + 30_000);
    // Streak 1: the next 30 s tick may try again.
    state.now += 30_000;
    await activator.tick();
    assert.equal(calls.executed.length, 2);
    // Streak 2: 60 s. A tick 30 s later is skipped without an attempt or an audit row.
    const secondAt = state.now;
    state.now += 30_000;
    await activator.tick();
    assert.equal(calls.executed.length, 2);
    assert.equal(attempts(), 2);
    assert.equal(activator.statusFor('job-1').state, 'waiting_sessions');
    assert.equal(activator.statusFor('job-1').retryAt, secondAt + 60_000);
    state.now = secondAt + 60_000;
    await activator.tick();
    assert.equal(calls.executed.length, 3);
    // Streak 3: 120 s.
    assert.equal(activator.statusFor('job-1').retryAt, state.now + 120_000);
});

test('B-1448 M4: any other outcome resets the backoff', async () => {
    const { activator, calls, state } = harness({ reply: CONTENDED });
    await activator.tick();
    state.now += 30_000;
    await activator.tick(); // streak 2 → next attempt in 60 s
    state.now += 60_000;
    state.reply = { status: 200, body: { status: 'deferred', reasonCode: 'live_sessions', sessionCount: 1 } };
    await activator.tick();
    assert.equal(calls.executed.length, 3);
    assert.equal(activator.statusFor('job-1').retryAt, undefined);
    // Contended again: the streak starts over at 30 s, not 120 s.
    state.reply = CONTENDED;
    state.now += 30_000;
    await activator.tick();
    assert.equal(calls.executed.length, 4);
    assert.equal(activator.statusFor('job-1').retryAt, state.now + 30_000);
});

test('B-1448 T6: an invalid detached deadline never throws while formatting the wait', async () => {
    const { activator, calls } = harness({ terminals: { count: 1, attached: 0, detached: 1, usernames: [], detachedClosesAt: null } });
    await activator.tick();
    assert.equal(activator.statusFor('job-1').state, 'waiting_terminals');
    assert.match(calls.lines.at(-1).message, /1 of them detached, closing by themselves\.$/);
});

test('B-1448 slice 2: activateNow clears the contention backoff and ticks at once', async () => {
    const { activator, calls, state } = harness({ reply: CONTENDED });
    await activator.tick();
    state.now += 30_000;
    await activator.tick(); // streak 2: the next attempt would wait 60 s
    state.reply = { status: 200, body: { status: 'restarting' } };
    await activator.tick();
    assert.equal(calls.executed.length, 2, 'still backing off');
    assert.equal(activator.activateNow('job-1'), true);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.executed.length, 3, 'the scheduled tick attempted immediately');
    assert.equal(activator.statusFor('job-1').state, 'restarting');
    assert.equal(activator.activateNow(''), false);
});

test('B-1448 slice 2: the terminal snapshot reaches the owner\'s status so the close can be confirmed', async () => {
    const snapshot = 'a'.repeat(32);
    const { activator } = harness({ terminals: { ...TERMINALS, snapshot } });
    await activator.tick();
    assert.equal(activator.statusFor('job-1').openTerminals.snapshot, snapshot);
});

test('B-1448 slice 2 M1: closing terminals is allowed only while they alone hold the job', async () => {
    const { activator, state } = harness({ terminals: TERMINALS });
    assert.equal(activator.closeTerminalsRefusal('job-1'), 'not_waiting_terminals', 'no tick yet');
    await activator.tick();
    assert.equal(activator.closeTerminalsRefusal('job-1'), null);
    state.sessions = 2;
    assert.equal(activator.closeTerminalsRefusal('job-1'), 'sessions_active');
    state.sessions = new Error('unreadable');
    assert.equal(activator.closeTerminalsRefusal('job-1'), 'sessions_active', 'unknown counts as busy');
});

test('B-1448 slice 2 M1: a due scheduled message refuses even though terminals are checked first', async () => {
    const { activator } = harness({ terminals: TERMINALS, scheduledDueSoon: () => ({ count: 1, earliestAt: null }) });
    await activator.tick();
    assert.equal(activator.statusFor('job-1').state, 'waiting_terminals');
    assert.equal(activator.closeTerminalsRefusal('job-1'), 'scheduled_wait');
    activator.overrideScheduled('job-1');
    assert.equal(activator.closeTerminalsRefusal('job-1'), null, 'the owner skipped the scheduled wait first');
});

test('B-1448 slice 2 M1: a terminal refusal or an expired job is activator_failed', async () => {
    const rows = [{ id: 7, sourceUpdateJobId: 'job-1', status: 'pending' }];
    const { activator, calls } = harness({ rows,
        reply: { status: 500, body: { status: 'error', code: 'gate_failed' } } });
    const originalPush = calls.executed.push.bind(calls.executed);
    calls.executed.push = (input) => { rows[0].status = 'failed'; return originalPush(input); };
    await activator.tick();
    assert.equal(activator.statusFor('job-1').terminal, true);
    assert.equal(activator.closeTerminalsRefusal('job-1'), 'activator_failed');
    const expired = harness({ terminals: TERMINALS });
    expired.state.now = QUEUED_AT + AUTO_ACTIVATE_DEADLINE_MS;
    await expired.activator.tick();
    assert.equal(expired.activator.closeTerminalsRefusal('job-1'), 'activator_failed');
});

test('B-1448 slice 2 T2: activateNow during a running tick re-runs the tick afterwards', async () => {
    let release = () => {};
    let block = true;
    const executed = [];
    const activator = createUpdateAutoActivator({
        jobs: { listAutoActivatable: () => [job()], listReceipts: () => receipts },
        listQueuedRestarts: () => [{ id: 7, sourceUpdateJobId: 'job-1', status: 'pending' }],
        countSessions: () => 0,
        // The first tick is held inside considerJob until released.
        prepareJob: async () => { if (block) await new Promise((resolve) => { release = () => resolve(undefined); }); },
        executeAsOwner: async (input) => { executed.push(input); return { status: 200, body: { status: 'deferred', reasonCode: 'live_sessions' } }; },
        getUser: () => ({ id: 1, role: 'owner' }),
        now: () => QUEUED_AT + 1_000,
    });
    const first = activator.tick();
    await new Promise((resolve) => setImmediate(resolve));
    block = false;
    activator.activateNow('job-1'); // lands while the first tick is running
    await new Promise((resolve) => setImmediate(resolve)); // its own tick finds one running: dropped
    release();
    await first;
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executed.length, 2, 'the first tick attempted, then the re-run attempted again');
});
