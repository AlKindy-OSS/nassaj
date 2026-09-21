import assert from 'node:assert/strict';
import test from 'node:test';

import { createUpdatePreflight, preflightResponse } from './update-preflight.js';

const clear = (code) => ({
    code, ok: true, severity: 'ok', autoFixable: false,
    reason_ar: 'سليم', reason_en: 'clear', action_ar: null, action_en: null, command: null,
});

test('the runner refuses to build without an app root or a session counter', () => {
    assert.throws(() => createUpdatePreflight({ activeSessionCount: () => 0 }), TypeError);
    assert.throws(() => createUpdatePreflight({ appRoot: '/fixture' }), TypeError);
});

test('concurrent callers share one probe and a later call starts a fresh one', async () => {
    let runs = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const preflight = createUpdatePreflight({
        appRoot: '/fixture',
        env: {},
        activeSessionCount: () => 0,
        runChecks: async () => { runs += 1; await gate; return { ok: true, target: null, checks: [], repairs: [], blocker: null }; },
    });

    const [first, second, third] = [preflight(), preflight(), preflight()];
    release();
    const results = await Promise.all([first, second, third]);
    assert.equal(runs, 1);
    assert.equal(results[0], results[1]);
    assert.equal(results[1], results[2]);

    await preflight();
    assert.equal(runs, 2);
});

test('a failed probe is not latched: the next caller retries', async () => {
    let runs = 0;
    const preflight = createUpdatePreflight({
        appRoot: '/fixture', env: {}, activeSessionCount: () => 0,
        runChecks: async () => { runs += 1; if (runs === 1) throw new Error('ls-remote exploded'); return { ok: true, target: null, checks: [], repairs: [], blocker: null }; },
    });
    await assert.rejects(preflight(), /exploded/);
    assert.equal((await preflight()).ok, true);
    assert.equal(runs, 2);
});

test('the runner passes the injected host probes straight through', async () => {
    let seen = null;
    const rows = [{ id: 'row-1', expectedServerBuildId: 'f'.repeat(64), sourceUpdateJobId: null }];
    const preflight = createUpdatePreflight({
        appRoot: '/fixture',
        env: { NASSAJ_RELEASE_DISCOVERY_TIMEOUT_MS: '9000' },
        activeSessionCount: () => 4,
        listQueuedSafeRestarts: () => rows,
        isSourceUpdateJobLive: () => true,
        runChecks: async (options) => { seen = options; return { ok: true, target: null, checks: [], repairs: [], blocker: null }; },
    });
    await preflight();
    assert.equal(seen.appRoot, '/fixture');
    assert.equal(seen.timeoutMs, 9000);
    assert.equal(seen.activeSessionCount(), 4);
    assert.deepEqual(seen.listQueuedSafeRestarts(), rows);
    assert.equal(seen.isSourceUpdateJobLive('job-1'), true);
    assert.equal('loadedServerBuildId' in seen, false,
        'a row carrying the running build is a legitimate operator request, not evidence');
});

test('API readiness observes only allowlisted effective values loaded after process exec', async () => {
    const effective = { TMPDIR: '/initial', JWT_SECRET: 'fixture-not-for-disclosure' };
    let observed;
    const preflight = createUpdatePreflight({
        appRoot: '/fixture', env: effective, activeSessionCount: () => 0,
        runChecks: async options => {
            observed = await options.readLiveProcessEnv();
            return { ok: true, checks: [], repairs: [], blocker: null };
        },
    });
    effective.TMPDIR = '/var/tmp';
    await preflight();
    assert.deepEqual(observed, { TMPDIR: '/var/tmp' });
    delete effective.TMPDIR;
    await preflight();
    assert.deepEqual(observed, { TMPDIR: undefined });
});

test('an absurd configured timeout falls back to the default rather than hanging', async () => {
    let seen = null;
    const preflight = createUpdatePreflight({
        appRoot: '/fixture', env: { NASSAJ_RELEASE_DISCOVERY_TIMEOUT_MS: '600000' },
        activeSessionCount: () => 0,
        runChecks: async (options) => { seen = options; return { ok: true, target: null, checks: [], repairs: [], blocker: null }; },
    });
    await preflight();
    assert.equal(seen.timeoutMs, 15_000);
});

test('missing host probes degrade to safe no-ops instead of throwing', async () => {
    let seen = null;
    const preflight = createUpdatePreflight({
        appRoot: '/fixture', env: {}, activeSessionCount: () => 0,
        runChecks: async (options) => { seen = options; return { ok: true, target: null, checks: [], repairs: [], blocker: null }; },
    });
    await preflight();
    assert.equal(seen.listQueuedSafeRestarts(), null);
    assert.equal(seen.isSourceUpdateJobLive('job-1'), false);
});

test('the whole diagnosis is bounded, not only each probe', async () => {
    const preflight = createUpdatePreflight({
        appRoot: '/fixture',
        env: { NASSAJ_RELEASE_DISCOVERY_TIMEOUT_MS: '10' },
        activeSessionCount: () => 0,
        runChecks: () => new Promise(() => {}), // never settles
    });
    await assert.rejects(preflight(), /update_preflight_timeout/);
    // and the latch is released, so the next caller is not stuck behind it
    let ran = false;
    const next = createUpdatePreflight({
        appRoot: '/fixture', env: {}, activeSessionCount: () => 0,
        runChecks: async () => { ran = true; return { ok: true, target: null, checks: [], repairs: [], blocker: null }; },
    });
    await next();
    assert.equal(ran, true);
});

test('the response carries every check and never leaks an unexpected field', () => {
    const shaped = preflightResponse({
        ok: false,
        target: { version: '1.47.0.10', commit: 'a'.repeat(40), local: true },
        repairs: ['stale_restart_row'],
        blocker: { code: 'gitlinks', ar: 'س', en: 'r', action: { ar: 'إ', en: 'a', command: null } },
        installedVersion: '1.47.0.10',
        checks: [{ ...clear('gitlinks'), internalHandle: 'must not ship' }],
    });
    assert.equal(shaped.ok, false);
    assert.equal(shaped.installedVersion, '1.47.0.10');
    assert.equal(shaped.blocker.code, 'gitlinks');
    assert.deepEqual(shaped.repairs, ['stale_restart_row']);
    assert.deepEqual(Object.keys(shaped.checks[0]),
        ['code', 'ok', 'severity', 'autoFixable', 'reason_ar', 'reason_en', 'action_ar', 'action_en', 'command']);
});
