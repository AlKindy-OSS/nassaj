/**
 * T-2024 S3 (ADR-207 §3.2, §3.3, §3.4, §3.7, §8 decision 4): the prestager —
 * policy, settle, eligibility reasons, supersede, watchdog, backoff, kill
 * switch, drain, per-cycle recovery (incl. B-1627 refs) and job-wins.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { buildMutexHolder, tryAcquireBuildMutex } from './source-update-build-mutex.js';
import { createSourceUpdater } from './source-updater.js';
import { buildPrestageIdentityKey } from './update-prestage-identity.js';
import { PRESTAGE_BUILD_MUTEX_KIND, createPrestageSlot, newPrestageTransactionId } from './update-prestage-slot.js';
import {
    PRESTAGE_POLICY_DEFAULT, createUpdatePrestager, prestageBlocker, evaluatePrestagePolicy, prestageModeRefusal, resolvePrestageConfig,
} from './update-prestager.js';

const H = (c) => c.repeat(64);
const COMMIT_1 = '1'.repeat(40);
const COMMIT_2 = '2'.repeat(40);
const HOUR = 3_600_000;
const MIN = 60_000;
const GIB = 1024 ** 3;
const OPEN_JOURNAL = { state: 'OPEN', gateClosed: false, phase: null };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd, encoding: 'utf8' }).trim();

function identity(releaseCommit) {
    return buildPrestageIdentityKey({
        releaseCommit,
        sourcePin: { repositoryUrl: 'https://github.com/AlKindy-OSS/nassaj.git', remote: 'origin', branch: 'main', tag: 'v1' },
        runtime: { version: 'v24.0.0', modules: '137', napi: '10', platform: 'linux', arch: 'x64',
            binary: { realpath: '/usr/bin/node', dev: 1, ino: 2, size: 3, mtimeMs: 4 } },
        npm: { realpath: '/usr/bin/npm', version: '11.0.0' }, builderBuildId: H('e'),
        buildInputs: { candidateScriptSha256: H('1'), publicViteSha256: H('2'), buildEnvSha256: H('3'),
            packageLockBlob: 'f'.repeat(40), strategy: 'git-checkout-v2' },
    });
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

/** A builder that lays out a candidate like the real one; `hold` keeps it running until released or aborted. */
function fakeBuilder(env) {
    const builder = { calls: 0, hold: null, fail: null };
    builder.build = async ({ transactionId, signal, beforeCandidate, expectedVersion }) => {
        builder.calls += 1;
        const releaseCommit = env.release.commit;
        await beforeCandidate({ releaseCommit, identity: identity(releaseCommit) });
        const candidate = path.join(env.controlRoot, 'candidates', transactionId);
        fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(env.controlRoot, `plan-${transactionId}.json`), '{}\n');
        if (builder.hold && !signal.aborted) {
            const aborted = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
            await Promise.race([builder.hold.promise, aborted]);
        }
        if (signal.aborted) throw Object.assign(new Error('aborted'), { code: 'aborted' });
        if (builder.fail) throw Object.assign(new Error(builder.fail), { code: builder.fail });
        // The real candidate manifest shape (scripts/source-update-candidate.mjs): each tree is {sha256, files}.
        const manifest = { version: expectedVersion, trees: { client: { sha256: H('1'), files: 1 },
            server: { sha256: H('2'), files: 2 }, nodeModules: { sha256: H('3'), files: 3 } } };
        return { transactionId, manifest, manifestRaw: Buffer.from(JSON.stringify(manifest)) };
    };
    return builder;
}

/** The owner setting most cycle tests run under: on, with a 12 h delay (T-2030). */
const DELAYED_12H = Object.freeze({ prestageEnabled: true, prestageQuarantineHours: 12 });

function fixture(t, { env: processEnv = {}, settings = DELAYED_12H, ...overrides } = {}) {
    const appRoot = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-prestager-'));
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    git(appRoot, 'init', '-q');
    git(appRoot, 'commit', '-q', '--allow-empty', '-m', 'a');
    const controlRoot = path.join(appRoot, '.git', 'nassaj-source-update');
    fs.mkdirSync(path.join(controlRoot, 'candidates'), { recursive: true, mode: 0o700 });
    const env = {
        appRoot, controlRoot, clock: Date.parse('2026-10-14T10:00:00Z'), activeJob: false, jobs: [],
        journal: OPEN_JOURNAL, memAvailable: 8 * GIB, freeDisk: 50 * GIB, cpu: 10, mem: 10, preflight: { ok: true },
        release: { version: '1.42.0.1', tagName: 'v1.42.0.1', commit: COMMIT_1 }, intervals: [], timeouts: [], processEnv,
        discoveries: 0,
        settings: { ...settings },
    };
    env.now = () => env.clock;
    env.tick = (ms) => { env.clock += ms; };
    env.slot = createPrestageSlot({ appRoot, controlRoot, now: env.now, lockWaitMs: 500 });
    env.builder = fakeBuilder(env);
    const runGit = async (args) => {
        try { return { code: 0, stdout: git(appRoot, ...args) }; } catch { return { code: 1, stdout: '' }; }
    };
    env.prestager = createUpdatePrestager({
        appRoot, slot: env.slot, buildPrestage: env.builder.build, env: processEnv, now: env.now, runGit,
        discoverRelease: async () => { env.discoveries += 1; return { release: { ...env.release } }; },
        readRuntime: () => ({ updateMode: 'release', isPlatform: false, hostReady: true, jobStrategy: 'git-checkout-v2',
            runtimeVersion: '1.42.0.0', runtimeCommit: 'a'.repeat(40), builderBuildId: H('e') }),
        hasActiveJob: () => env.activeJob, listJobReferences: () => env.jobs,
        lookupJob: (jobId) => env.jobs.find((job) => job.id === jobId) ?? null,
        readJournal: () => env.journal, runPreflight: async () => env.preflight,
        sampleResources: async () => ({ cpuPercent: env.cpu, memoryPercent: env.mem }),
        readMemAvailable: () => env.memAvailable, readFreeDisk: () => env.freeDisk,
        sleep: async () => {}, logger: { info() {} }, readSettings: () => env.settings,
        timers: {
            setTimeout: (fn, ms) => { const handle = { fn, ms, cleared: false, unref() {} }; env.timeouts.push(handle); return handle; },
            clearTimeout: (handle) => { if (handle) handle.cleared = true; },
            setInterval: (fn) => { env.intervals.push(fn); return fn; },
            clearInterval: (fn) => { env.intervals = env.intervals.filter((entry) => entry !== fn); },
        },
        ...overrides,
    });
    return env;
}

/** Run cycles past the settle window and the 12 h quarantine; the build starts on the last one. */
async function reachBuild(env) {
    await env.prestager.runCycle();
    env.tick(5 * MIN);
    await env.prestager.runCycle();
    env.tick(12 * HOUR);
    await env.prestager.runCycle();
}

/** Wait until the background build has written its `building` slot. */
async function building(env) {
    for (let attempt = 0; attempt < 200 && env.slot.read()?.state !== 'building'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(env.slot.read()?.state, 'building');
}

async function settle(env) {
    for (let attempt = 0; attempt < 200 && env.prestager.buildInFlight(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

const candidates = (env) => fs.readdirSync(path.join(env.controlRoot, 'candidates')).sort();

// ---------------------------------------------------------------------------
// Decision 4 policy and configuration
// ---------------------------------------------------------------------------

test('config: decision 4 default is prestage immediately; kill switch, opt-in, owner flag and bad values', () => {
    assert.deepEqual(PRESTAGE_POLICY_DEFAULT, { policy: 'quarantine', quarantineHours: 0 });
    const base = resolvePrestageConfig({});
    assert.deepEqual([base.policy, base.quarantineMs, base.killed, base.optedIn], ['quarantine', 0, false, false]);
    assert.deepEqual(base.envOverrides, { policy: false, quarantineHours: false });
    assert.equal(base.minMemBytes, 3072 * 1024 * 1024);
    assert.ok(Math.abs(base.minFreeBytes - 6.4 * GIB) < 0.01 * GIB);
    assert.equal(resolvePrestageConfig({ NASSAJ_UPDATE_PRESTAGE: '0' }).killed, true);
    assert.equal(resolvePrestageConfig({ NASSAJ_UPDATE_PRESTAGE: 'off' }).killed, true);
    assert.equal(resolvePrestageConfig({ NASSAJ_UPDATE_PRESTAGE: '1' }).optedIn, true);
    assert.equal(resolvePrestageConfig({ NASSAJ_UPDATE_PRESTAGE_QUARANTINE_HOURS: '2' }).quarantineMs, 2 * HOUR);
    const bad = resolvePrestageConfig({ NASSAJ_UPDATE_PRESTAGE_POLICY: 'always' });
    assert.deepEqual([bad.policy, bad.policyInvalid], ['quarantine', true]);
    assert.equal(resolvePrestageConfig({ NASSAJ_UPDATE_PRESTAGE_POLL_MS: '1000' }).pollMs, 5 * MIN, 'poll floor 5 min');
});

test('config: quarantine 0 h is an explicit "no quarantine"; negative or NaN warns once and falls back', async () => {
    const warnings = [];
    const logger = { warn: (...args) => warnings.push(args.join(' ')) };
    const zero = resolvePrestageConfig({ NASSAJ_UPDATE_PRESTAGE_QUARANTINE_HOURS: '0' }, { logger });
    assert.equal(zero.quarantineMs, 0);
    assert.deepEqual(await evaluatePrestagePolicy(zero, { firstSeen: null, nowMs: 5 }), { ok: true });
    assert.equal(warnings.length, 0);
    const stored = { prestageEnabled: true, prestageQuarantineHours: 12 };
    assert.equal(resolvePrestageConfig({ NASSAJ_UPDATE_PRESTAGE_QUARANTINE_HOURS: ' ' }, { logger, stored }).quarantineMs, 12 * HOUR);
    assert.equal(warnings.length, 0, 'empty is unset, not invalid');
    for (const value of ['-3', 'abc', 'NaN']) {
        const config = resolvePrestageConfig({ NASSAJ_UPDATE_PRESTAGE_QUARANTINE_HOURS: value }, { logger, stored });
        assert.equal(config.quarantineMs, 12 * HOUR, `${value} falls back to the owner setting`);
        assert.equal(config.envOverrides.quarantineHours, false);
        resolvePrestageConfig({ NASSAJ_UPDATE_PRESTAGE_QUARANTINE_HOURS: value }, { logger });
    }
    assert.equal(warnings.length, 3, 'one warning per distinct invalid value, not per cycle');
    assert.ok(warnings.every((line) => line.includes('invalid_quarantine_hours')));
    // The policy still governs: owner-node ignores the quarantine value entirely.
    const ownerNode = resolvePrestageConfig({ NASSAJ_UPDATE_PRESTAGE_QUARANTINE_HOURS: '0', NASSAJ_UPDATE_PRESTAGE_POLICY: 'owner-node' });
    assert.deepEqual(await evaluatePrestagePolicy(ownerNode, {}), { reason: 'not_owner_node' });
});

test('policy (a) quarantine counts from the node-local first sighting, never the tag date', async () => {
    const config = resolvePrestageConfig({}, { stored: { prestageEnabled: true, prestageQuarantineHours: 12 } });
    const firstSeen = { targetCommit: COMMIT_1, firstSeenAt: 1_000 };
    assert.deepEqual(await evaluatePrestagePolicy(config, { firstSeen, nowMs: 1_000 + HOUR }),
        { reason: 'quarantine', until: 1_000 + 12 * HOUR });
    assert.deepEqual(await evaluatePrestagePolicy(config, { firstSeen, nowMs: 1_000 + 12 * HOUR }), { ok: true });
});

test('policy (b) owner-node and (c) verified: off unless flagged / verified / opted in; off is off', async () => {
    const owner = (env) => evaluatePrestagePolicy(resolvePrestageConfig({ NASSAJ_UPDATE_PRESTAGE_POLICY: 'owner-node', ...env }), {});
    assert.deepEqual(await owner({}), { reason: 'not_owner_node' });
    assert.deepEqual(await owner({ NASSAJ_UPDATE_PRESTAGE_OWNER_NODE: '1' }), { ok: true });
    assert.deepEqual(await owner({ NASSAJ_UPDATE_PRESTAGE: '1' }), { ok: true });
    const verified = (env, verifySignedRelease) => evaluatePrestagePolicy(
        resolvePrestageConfig({ NASSAJ_UPDATE_PRESTAGE_POLICY: 'verified', ...env }), { verifySignedRelease });
    assert.deepEqual(await verified({}, async () => false), { reason: 'release_unverified' });
    assert.deepEqual(await verified({}, async () => { throw new Error('x'); }), { reason: 'release_unverified' });
    assert.deepEqual(await verified({}, async () => true), { ok: true });
    assert.deepEqual(await verified({ NASSAJ_UPDATE_PRESTAGE: '1' }, async () => false), { ok: true });
    assert.deepEqual(await evaluatePrestagePolicy(resolvePrestageConfig({ NASSAJ_UPDATE_PRESTAGE_POLICY: 'off' }), {}),
        { reason: 'policy_off' });
});

test('mode: only release-mode git-checkout-v2 nodes, never platform', () => {
    const ok = { updateMode: undefined, isPlatform: false, hostReady: true, jobStrategy: 'git-checkout-v2' };
    assert.equal(prestageModeRefusal(ok), null);
    assert.equal(prestageModeRefusal({ ...ok, updateMode: 'local-main' }), 'update_mode_not_release');
    assert.equal(prestageModeRefusal({ ...ok, isPlatform: true }), 'platform_mode');
    assert.equal(prestageModeRefusal({ ...ok, hostReady: false }), 'update_host_not_ready');
    assert.equal(prestageModeRefusal({ ...ok, jobStrategy: 'release-layout-v2' }), 'strategy_not_git_checkout');
});

// ---------------------------------------------------------------------------
// Cycle: settle → quarantine → build → ready
// ---------------------------------------------------------------------------

test('cycle: settle window, then quarantine_until, then one build to ready', async (t) => {
    const env = fixture(t);
    await env.prestager.runCycle();
    assert.equal(env.prestager.status().reasonCode, 'settling');
    env.tick(5 * MIN);
    await env.prestager.runCycle();
    const blocked = env.prestager.status();
    assert.deepEqual([blocked.state, blocked.reasonCode], ['blocked', 'quarantine']);
    assert.equal(blocked.quarantineUntil, new Date(Date.parse('2026-10-14T10:00:00Z') + 12 * HOUR).toISOString());
    assert.equal(env.builder.calls, 0);
    env.tick(12 * HOUR);
    await env.prestager.runCycle();
    await settle(env);
    const ready = env.prestager.status();
    assert.deepEqual([ready.state, ready.version, ready.reasonCode], ['ready', '1.42.0.1', null]);
    assert.equal(env.slot.read().state, 'ready');
    assert.equal(buildMutexHolder(env.appRoot), null, 'the mutex is released after the build');
    await env.prestager.runCycle();
    assert.equal(env.builder.calls, 1, 'a ready slot for the latest release is not rebuilt');
});

test('cycle: nothing newer than the runtime → up_to_date, no build', async (t) => {
    const env = fixture(t);
    env.release = { version: '1.42.0.0', tagName: 'v1.42.0.0', commit: COMMIT_1 };
    await env.prestager.runCycle();
    assert.equal(env.prestager.status().reasonCode, 'up_to_date');
});

for (const [name, mutate, reason] of [
    ['low memory', (env) => { env.memAvailable = 2 * GIB; }, 'low_memory'],
    ['low disk', (env) => { env.freeDisk = 5 * GIB; }, 'low_disk'],
    ['cpu ceiling', (env) => { env.cpu = 85; }, 'resource_ceiling_cpu'],
    ['memory ceiling', (env) => { env.mem = 90; }, 'resource_ceiling_memory'],
    ['an active job', (env) => { env.activeJob = true; }, 'job_active'],
    ['a journal not OPEN', (env) => { env.journal = { ...OPEN_JOURNAL, state: 'RECOVERING' }; }, 'journal_recovering'],
    ['a preflight blocker', (env) => { env.preflight = { ok: false, blocker: { code: 'dirty_worktree' } }; }, 'blocked:dirty_worktree'],
]) {
    test(`eligibility: ${name} → "${reason}", no build`, async (t) => {
        const env = fixture(t);
        mutate(env);
        await reachBuild(env);
        assert.deepEqual([env.prestager.status().state, env.prestager.status().reasonCode], ['blocked', reason]);
        assert.equal(env.builder.calls, 0);
    });
}

test('preflight: active sessions never block a prestage (owner decision 1); the next blocker is reported', async () => {
    assert.equal(prestageBlocker({ ok: false, blocker: { code: 'active_sessions' } }), null);
    assert.equal(prestageBlocker({ ok: false, checks: [{ code: 'active_sessions', severity: 'blocker' },
        { code: 'remote_mismatch', severity: 'blocker' }] }), 'remote_mismatch');
    assert.equal(prestageBlocker({ ok: true, checks: [{ code: 'gitlinks', severity: 'warning' }] }), null);
});

test('kill switch and policy off: an existing ready slot is discarded on the next cycle', async (t) => {
    const processEnv = {};
    const env = fixture(t, { env: processEnv });
    await reachBuild(env);
    await settle(env);
    assert.equal(env.slot.read().state, 'ready');
    processEnv.NASSAJ_UPDATE_PRESTAGE = '0';
    await env.prestager.runCycle();
    assert.deepEqual([env.prestager.status().state, env.prestager.status().reasonCode], ['off', 'killed']);
    assert.equal(env.slot.read(), null);
    assert.deepEqual(candidates(env), []);
});

test('kill switch while building: the status reports off at once', async (t) => {
    const processEnv = {};
    const env = fixture(t, { env: processEnv });
    env.builder.hold = deferred();
    await reachBuild(env);
    await building(env);
    processEnv.NASSAJ_UPDATE_PRESTAGE = '0';
    await env.prestager.runCycle();
    assert.deepEqual([env.prestager.status().state, env.prestager.status().reasonCode, env.prestager.status().version],
        ['off', 'killed', null]);
    assert.equal(env.prestager.buildInFlight(), null);
    env.builder.hold = null;
});

// ---------------------------------------------------------------------------
// T-2030: the owner's stored setting and its precedence
// ---------------------------------------------------------------------------

test('precedence: env kill switch > env overrides > stored setting > default', () => {
    const off = { prestageEnabled: false, prestageQuarantineHours: 6 };
    const on = { prestageEnabled: true, prestageQuarantineHours: 6 };
    assert.equal(resolvePrestageConfig({}, { stored: null }).quarantineMs, 0, 'default: immediately');
    assert.deepEqual([resolvePrestageConfig({}, { stored: on }).policy, resolvePrestageConfig({}, { stored: on }).quarantineMs],
        ['quarantine', 6 * HOUR], 'stored beats default');
    assert.equal(resolvePrestageConfig({}, { stored: off }).policy, 'off', 'stored off = policy off');
    const envPolicy = resolvePrestageConfig({ NASSAJ_UPDATE_PRESTAGE_POLICY: 'quarantine' }, { stored: off });
    assert.deepEqual([envPolicy.policy, envPolicy.envOverrides.policy], ['quarantine', true], 'env policy beats stored off');
    const envHours = resolvePrestageConfig({ NASSAJ_UPDATE_PRESTAGE_QUARANTINE_HOURS: '3' }, { stored: on });
    assert.deepEqual([envHours.quarantineMs, envHours.envOverrides.quarantineHours], [3 * HOUR, true], 'env hours beat stored');
    const killed = resolvePrestageConfig({ NASSAJ_UPDATE_PRESTAGE: '0', NASSAJ_UPDATE_PRESTAGE_POLICY: 'quarantine' }, { stored: on });
    assert.equal(killed.killed, true, 'the kill switch wins over every other source');
    const corrupt = resolvePrestageConfig({}, { stored: { prestageEnabled: 'yes', prestageQuarantineHours: -1 } });
    assert.deepEqual([corrupt.policy, corrupt.quarantineMs], ['quarantine', 0], 'malformed stored fields fall back to defaults');
});

test('setting: the default (on, 0 h) builds right after the settle window', async (t) => {
    const env = fixture(t, { settings: { prestageEnabled: true, prestageQuarantineHours: 0 } });
    await env.prestager.runCycle();
    assert.equal(env.prestager.status().reasonCode, 'settling');
    env.tick(5 * MIN);
    await env.prestager.runCycle();
    await settle(env);
    assert.deepEqual([env.prestager.status().state, env.builder.calls], ['ready', 1]);
});

test('setting: turning prestage off discards a ready slot on the next cycle (policy_off)', async (t) => {
    const env = fixture(t);
    await reachBuild(env);
    await settle(env);
    assert.equal(env.slot.read().state, 'ready');
    env.settings = { prestageEnabled: false, prestageQuarantineHours: 12 };
    await env.prestager.runCycle();
    const status = env.prestager.status();
    assert.deepEqual([status.enabled, status.state, status.reasonCode, status.policy], [false, 'off', 'policy_off', 'off']);
    assert.equal(env.slot.read(), null);
    assert.deepEqual(candidates(env), []);
});

test('setting: turning prestage off while building aborts and discards the build', async (t) => {
    const env = fixture(t);
    env.builder.hold = deferred();
    await reachBuild(env);
    await building(env);
    env.settings = { prestageEnabled: false, prestageQuarantineHours: 12 };
    await env.prestager.runCycle();
    assert.deepEqual([env.prestager.status().state, env.prestager.status().reasonCode], ['off', 'policy_off']);
    assert.equal(env.prestager.buildInFlight(), null);
    await env.prestager.runCycle();
    assert.equal(env.slot.read(), null);
    env.builder.hold = null;
});

test('setting: an hours change applies on the next cycle, counted from the first sighting', async (t) => {
    const env = fixture(t, { settings: { prestageEnabled: true, prestageQuarantineHours: 48 } });
    const firstSeenAt = env.clock;
    await env.prestager.runCycle();
    env.tick(5 * MIN);
    await env.prestager.runCycle();
    assert.equal(env.prestager.status().quarantineUntil, new Date(firstSeenAt + 48 * HOUR).toISOString());
    env.settings = { prestageEnabled: true, prestageQuarantineHours: 2 };
    await env.prestager.runCycle();
    assert.deepEqual([env.prestager.status().reasonCode, env.prestager.status().quarantineUntil],
        ['quarantine', new Date(firstSeenAt + 2 * HOUR).toISOString()], 'shorter delay, same first sighting');
    assert.equal(env.builder.calls, 0);
    env.tick(2 * HOUR);
    await env.prestager.runCycle();
    await settle(env);
    assert.deepEqual([env.prestager.status().state, env.builder.calls], ['ready', 1]);
});

test('qa 1: an unreadable store with no earlier read → settings_unavailable, no build, no adoption', async (t) => {
    const env = fixture(t, { settings: { prestageEnabled: true, prestageQuarantineHours: 0 },
        readSettings: () => { throw new Error('db down'); } });
    for (let i = 0; i < 3; i += 1) { await env.prestager.runCycle(); env.tick(10 * MIN); }
    assert.deepEqual([env.prestager.status().state, env.prestager.status().reasonCode, env.prestager.status().enabled],
        ['blocked', 'settings_unavailable', false]);
    assert.equal(env.builder.calls, 0);
    assert.equal(env.prestager.adoptionPort().adoptable(), false);
});

test('qa 1: owner disabled, then the store fails → the last read (off) holds, never the enabled default', async (t) => {
    let failing = false;
    const env = fixture(t, { readSettings: () => {
        if (failing) throw new Error('db down');
        return env.settings;
    } });
    env.settings = { prestageEnabled: false, prestageQuarantineHours: 0 };
    await env.prestager.runCycle();
    failing = true;
    for (let i = 0; i < 3; i += 1) { await env.prestager.runCycle(); env.tick(13 * HOUR); }
    assert.deepEqual([env.prestager.status().state, env.prestager.status().reasonCode], ['off', 'policy_off']);
    assert.equal(env.builder.calls, 0);
    assert.equal(env.prestager.adoptionPort().adoptable(), false);
});

test('qa 2: a click right after disabling does not adopt the ready slot (no cycle in between)', async (t) => {
    const env = fixture(t);
    await reachBuild(env);
    await settle(env);
    assert.equal(env.slot.read().state, 'ready');
    assert.equal(env.prestager.adoptionPort().adoptable(), true);
    env.settings = { prestageEnabled: false, prestageQuarantineHours: 12 };
    assert.equal(env.prestager.adoptionPort().adoptable(), false);
});

test('qa 3: wake() after disabling aborts an in-flight build at once; no-op while stopped', async (t) => {
    const env = fixture(t);
    env.builder.hold = deferred();
    await reachBuild(env);
    await building(env);
    env.settings = { prestageEnabled: false, prestageQuarantineHours: 12 };
    assert.equal(await env.prestager.wake(), null, 'not started: wake does nothing');
    assert.ok(env.prestager.buildInFlight(), 'the build is still running');
    env.prestager.start();
    await env.prestager.wake();
    assert.deepEqual([env.prestager.status().state, env.prestager.status().reasonCode], ['off', 'policy_off']);
    assert.equal(env.prestager.buildInFlight(), null);
    await env.prestager.wake();
    assert.equal(env.slot.read(), null, 'the aborted slot is discarded');
    await env.prestager.stop();
    env.builder.hold = null;
});

test('qa 3: wake() after enabling starts settling at once', async (t) => {
    const env = fixture(t, { settings: { prestageEnabled: false, prestageQuarantineHours: 0 } });
    env.prestager.start();
    await env.prestager.wake();
    assert.equal(env.prestager.status().reasonCode, 'policy_off');
    env.settings = { prestageEnabled: true, prestageQuarantineHours: 0 };
    await env.prestager.wake();
    assert.equal(env.prestager.status().reasonCode, 'settling');
    await env.prestager.stop();
});

// ---------------------------------------------------------------------------
// Supersede, watchdog, backoff, drain
// ---------------------------------------------------------------------------

test('supersede: a newer release while ready discards the old slot, then settles the new one', async (t) => {
    const env = fixture(t);
    await reachBuild(env);
    await settle(env);
    env.release = { version: '1.42.0.2', tagName: 'v1.42.0.2', commit: COMMIT_2 };
    await env.prestager.runCycle();
    assert.equal(env.slot.read(), null, 'only the latest remains');
    assert.deepEqual(candidates(env), []);
    assert.equal(env.prestager.status().reasonCode, 'settling');
});

test('supersede: a newer release while building aborts the build and discards it, without backoff', async (t) => {
    const env = fixture(t);
    env.builder.hold = deferred();
    await reachBuild(env);
    await building(env);
    assert.ok(env.prestager.buildInFlight());
    assert.equal(env.slot.read().state, 'building');
    env.release = { version: '1.42.0.2', tagName: 'v1.42.0.2', commit: COMMIT_2 };
    await env.prestager.runCycle();
    await settle(env);
    assert.equal(env.slot.read(), null);
    assert.deepEqual(candidates(env), []);
    // S7 finding: the status names the newest release at once, not the aborted one.
    assert.deepEqual([env.prestager.status().state, env.prestager.status().reasonCode, env.prestager.status().version],
        ['settling', 'settling', '1.42.0.2']);
    env.builder.hold = null;
    await env.prestager.runCycle();
    assert.equal(env.prestager.status().reasonCode, 'settling', 'the newer release settles; no failure backoff');
});

test('watchdog: resource pressure aborts the build (aborted_resources) and backs off', async (t) => {
    const env = fixture(t);
    env.builder.hold = deferred();
    await reachBuild(env);
    await building(env);
    assert.equal(env.intervals.length, 1);
    env.freeDisk = GIB;
    env.intervals[0]();
    await settle(env);
    assert.equal(env.prestager.status().reasonCode, 'aborted_resources');
    assert.equal(env.slot.read(), null);
    assert.equal(env.intervals.length, 0, 'the watchdog stops with the build');
    env.freeDisk = 50 * GIB;
    env.builder.hold = null;
    await env.prestager.runCycle();
    assert.equal(env.prestager.status().reasonCode, 'failed_backoff');
});

test('backoff: 30 min doubling; after 3 failures for a target it gives up', async (t) => {
    const env = fixture(t);
    env.builder.fail = 'candidate_build_failed';
    await reachBuild(env);
    await settle(env);
    assert.equal(env.prestager.status().reasonCode, 'failed:candidate_build_failed');
    for (const wait of [30 * MIN, 60 * MIN]) {
        await env.prestager.runCycle();
        assert.equal(env.prestager.status().reasonCode, 'failed_backoff');
        env.tick(wait);
        await env.prestager.runCycle();
        await settle(env);
    }
    assert.equal(env.builder.calls, 3);
    env.tick(24 * HOUR);
    await env.prestager.runCycle();
    assert.equal(env.prestager.status().reasonCode, 'failed_gave_up');
    assert.deepEqual(candidates(env), []);
});

test('drain: stop({drain}) aborts the build and discards it before resolving', async (t) => {
    const env = fixture(t);
    env.builder.hold = deferred();
    await reachBuild(env);
    await building(env);
    await env.prestager.stop({ drain: true });
    assert.equal(env.prestager.buildInFlight(), null);
    assert.equal(env.slot.read(), null);
    assert.deepEqual(candidates(env), []);
});

// ---------------------------------------------------------------------------
// Recovery, sweep and refs (qa conditions 1, B-1627)
// ---------------------------------------------------------------------------

test('qa condition 1: the cycle sweep keeps an update-pre-* an activated job references', async (t) => {
    const env = fixture(t);
    const activated = newPrestageTransactionId();
    const orphan = `${newPrestageTransactionId()}o`;
    for (const tx of [activated, orphan]) fs.mkdirSync(path.join(env.controlRoot, 'candidates', tx));
    env.jobs = [{ id: 'job-1', state: 'activated', transactionId: activated }];
    await env.prestager.runCycle();
    assert.deepEqual(candidates(env), [activated]);
});

test('B-1627: leftover refs/nassaj-update and unnamed refs/nassaj-prestage go each cycle, never with an active job', async (t) => {
    const env = fixture(t);
    const old = env.clock - 11 * MIN;
    git(env.appRoot, 'update-ref', `refs/nassaj-update/111-${old}-a/tag`, 'HEAD');
    git(env.appRoot, 'update-ref', `refs/nassaj-prestage/222-${old}-b/tag`, 'HEAD');
    const refs = () => git(env.appRoot, 'for-each-ref', '--format=%(refname)', 'refs/nassaj-update/', 'refs/nassaj-prestage/');
    env.activeJob = true;
    await env.prestager.runCycle();
    assert.equal(refs().split('\n').filter(Boolean).length, 2, 'an active job keeps every ref');
    env.activeJob = false;
    await env.prestager.runCycle();
    assert.equal(refs(), '');
});

test('S4 qa condition (b): B-1627 cleanup removes only private refs whose nonce is at least 10 minutes old', async (t) => {
    const env = fixture(t);
    const stale = env.clock - 10 * MIN;
    const fresh = env.clock - 9 * MIN;
    const created = [
        `refs/nassaj-update/111-${stale}-a/tag`, `refs/nassaj-update/111-${fresh}-b/tag`,
        `refs/nassaj-prestage/222-${stale}-c/branch`, `refs/nassaj-prestage/222-${fresh}-d/branch`,
        'refs/nassaj-update/undatable/tag', `refs/nassaj-update/333-${env.clock + MIN}-e/tag`,
        'refs/heads/keep-me',
    ];
    for (const ref of created) git(env.appRoot, 'update-ref', ref, 'HEAD');
    await env.prestager.runCycle();
    const left = git(env.appRoot, 'for-each-ref', '--format=%(refname)', 'refs/nassaj-update/', 'refs/nassaj-prestage/',
        'refs/heads/keep-me').split('\n').filter(Boolean).sort();
    assert.deepEqual(left, [
        'refs/heads/keep-me', `refs/nassaj-prestage/222-${fresh}-d/branch`,
        `refs/nassaj-update/111-${fresh}-b/tag`, `refs/nassaj-update/333-${env.clock + MIN}-e/tag`,
        'refs/nassaj-update/undatable/tag',
    ].sort(), 'stale ones go; fresh, future-dated, undatable and foreign refs stay');
});

// ---------------------------------------------------------------------------
// Job wins (qa condition 3)
// ---------------------------------------------------------------------------

test('qa condition 3: a click while prestaging aborts it, waits for the discard, then builds under its own mutex', async (t) => {
    const env = fixture(t);
    env.builder.hold = deferred();
    await reachBuild(env);
    await building(env);
    assert.equal(buildMutexHolder(env.appRoot)?.kind, PRESTAGE_BUILD_MUTEX_KIND);
    const prestaged = env.slot.read().transactionId;
    env.activeJob = true; // the worker claimed the job before calling updateSource
    let seenAtFirstCommand = null;
    const update = createSourceUpdater({
        appRoot: env.appRoot, activeSessionCount: () => 0, env: {},
        statfs: () => ({ type: 0xef53, bavail: 4_000_000, bsize: 4096 }),
        yieldPrestage: () => env.prestager.abortForJob(),
        commandRunner: async () => {
            seenAtFirstCommand ??= {
                holder: buildMutexHolder(env.appRoot)?.kind, slot: env.slot.read(),
                candidate: fs.existsSync(path.join(env.controlRoot, 'candidates', prestaged)),
            };
            return { code: 1, signal: null, stdout: '', stderr: '' };
        },
    });
    await assert.rejects(update('1.42.0.1', {}), (error) => error.code !== 'update_in_progress');
    assert.deepEqual(seenAtFirstCommand, { holder: 'source-update', slot: null, candidate: false });
    assert.equal(env.prestager.status().reasonCode, 'job_claimed');
    assert.equal(buildMutexHolder(env.appRoot), null);
});

test('abortForJob with nothing running resolves at once', async (t) => {
    const env = fixture(t);
    assert.equal(await env.prestager.abortForJob(), true);
});

// ---------------------------------------------------------------------------
// T-2025: wake on discovery, reason-code transition logging
// ---------------------------------------------------------------------------

const IMMEDIATE = Object.freeze({ prestageEnabled: true, prestageQuarantineHours: 0 });

/** A logger that keeps every parsed `[update-prestager]` event. */
function recordingLogger() {
    const events = [];
    return { events, info: (_tag, line) => { events.push(JSON.parse(line)); } };
}
const named = (logger, event) => logger.events.filter((entry) => entry.event === event);

test('T-2025: a discovered newer release wakes one cycle, once per release, across repeated polls', async (t) => {
    const logger = recordingLogger();
    const env = fixture(t, { settings: IMMEDIATE, logger });
    env.prestager.start();
    const woken = env.prestager.noteRelease({ ...env.release });
    assert.ok(woken, 'the first sighting wakes');
    await woken;
    assert.deepEqual([env.prestager.status().state, env.prestager.status().reasonCode], ['settling', 'settling']);
    for (let poll = 0; poll < 5; poll += 1) assert.equal(env.prestager.noteRelease({ ...env.release }), null);
    assert.equal(named(logger, 'wake_on_discovery').length, 1);
    env.tick(5 * MIN);
    await env.prestager.runCycle();
    await settle(env);
    assert.equal(env.prestager.status().state, 'ready', 'the settle window still applies, then one build');
    assert.equal(env.prestager.noteRelease({ ...env.release }), null, 'a ready release never wakes again');
    env.release = { version: '1.42.0.2', tagName: 'v1.42.0.2', commit: COMMIT_2 };
    const again = env.prestager.noteRelease({ ...env.release });
    assert.ok(again, 'a newer release wakes once more');
    await again;
    assert.deepEqual(named(logger, 'wake_on_discovery').map((entry) => entry.version), ['1.42.0.1', '1.42.0.2']);
    assert.equal(env.builder.calls, 1);
    await env.prestager.stop();
});

test('T-2025: a release the prestager already settles is not woken again', async (t) => {
    const logger = recordingLogger();
    const env = fixture(t, { settings: IMMEDIATE, logger });
    env.prestager.start();
    await env.prestager.runCycle();
    assert.equal(env.prestager.noteRelease({ ...env.release }), null);
    assert.equal(named(logger, 'wake_on_discovery').length, 0);
    await env.prestager.stop();
});

test('T-2025: no wake for a release not newer than the runtime, or the runtime commit itself', async (t) => {
    const logger = recordingLogger();
    const env = fixture(t, { settings: IMMEDIATE, logger });
    env.prestager.start();
    assert.equal(env.prestager.noteRelease({ version: '1.42.0.0', tagName: 'v1.42.0.0', commit: COMMIT_1 }), null);
    assert.equal(env.prestager.noteRelease({ version: '1.41.9.9', tagName: 'v1.41.9.9', commit: COMMIT_2 }), null);
    assert.equal(env.prestager.noteRelease({ version: '1.42.0.9', tagName: 'v1.42.0.9', commit: 'a'.repeat(40) }), null);
    assert.equal(env.prestager.noteRelease({ version: 'not-a-version', commit: COMMIT_2 }), null);
    assert.equal(env.prestager.noteRelease(null), null);
    assert.equal(named(logger, 'wake_on_discovery').length, 0);
    assert.equal(env.prestager.status().reasonCode, 'not_started', 'no cycle ran');
    await env.prestager.stop();
});

test('T-2025: no wake while stopped, disabled or killed; enabling later still wakes once', async (t) => {
    const logger = recordingLogger();
    const env = fixture(t, { settings: { prestageEnabled: false, prestageQuarantineHours: 0 }, logger });
    assert.equal(env.prestager.noteRelease({ ...env.release }), null, 'not started');
    env.prestager.start();
    assert.equal(env.prestager.noteRelease({ ...env.release }), null, 'owner disabled');
    env.settings = { ...IMMEDIATE };
    const killed = fixture(t, { settings: IMMEDIATE, env: { NASSAJ_UPDATE_PRESTAGE: '0' }, logger });
    killed.prestager.start();
    assert.equal(killed.prestager.noteRelease({ ...killed.release }), null, 'kill switch');
    assert.equal(named(logger, 'wake_on_discovery').length, 0);
    assert.ok(env.prestager.noteRelease({ ...env.release }), 'a refused call does not use up the wake');
    await env.prestager.wake();
    assert.equal(env.prestager.status().reasonCode, 'settling');
    await env.prestager.stop();
    await killed.prestager.stop();
});

test('T-2025: no wake while a job is active or the settings are unreadable; later polls may wake', async (t) => {
    const logger = recordingLogger();
    let unreadable = true;
    const env = fixture(t, { settings: IMMEDIATE, logger,
        readSettings: () => { if (unreadable) throw new Error('store down'); return IMMEDIATE; } });
    env.prestager.start();
    assert.equal(env.prestager.noteRelease({ ...env.release }), null, 'settings unavailable');
    unreadable = false;
    env.activeJob = true;
    assert.equal(env.prestager.noteRelease({ ...env.release }), null, 'job active');
    assert.equal(named(logger, 'wake_on_discovery').length, 0);
    env.activeJob = false;
    const woken = env.prestager.noteRelease({ ...env.release });
    assert.ok(woken);
    await woken;
    assert.equal(named(logger, 'wake_on_discovery').length, 1);
    await env.prestager.stop();
});

test('T-2025: each state or reason-code change is logged once, repeats are not', async (t) => {
    const logger = recordingLogger();
    const env = fixture(t, { logger });
    await env.prestager.runCycle();
    await env.prestager.runCycle();
    env.tick(5 * MIN);
    await env.prestager.runCycle();
    await env.prestager.runCycle();
    env.activeJob = true;
    env.tick(12 * HOUR);
    await env.prestager.runCycle();
    const transitions = named(logger, 'status_changed').map((entry) => [entry.previousReasonCode, entry.reasonCode]);
    assert.deepEqual(transitions, [['not_started', 'settling'], ['settling', 'quarantine'], ['quarantine', 'job_active']]);
    const entry = named(logger, 'status_changed').at(-1);
    assert.deepEqual(Object.keys(entry).sort(), ['event', 'previousReasonCode', 'previousState', 'reasonCode', 'state', 'version']);
    assert.deepEqual([entry.state, entry.previousState, entry.version], ['blocked', 'blocked', '1.42.0.1']);
    env.activeJob = false;
    await env.prestager.runCycle();
    await settle(env);
    const tail = named(logger, 'status_changed').slice(3).map((item) => [item.state, item.reasonCode]);
    assert.deepEqual(tail, [['building', null], ['ready', null]]);
});

// The probe timer: `random: () => 0` removes its (upward) jitter, `probeMs` 7 min tells it from the 5 min first poll.
const PROBE = Object.freeze({ random: () => 0, options: { probeMs: 7 * MIN } });
const probeTimers = (env) => env.timeouts.filter((handle) => handle.ms === 7 * MIN && !handle.cleared);

/** Fire the one live probe timer and wait for its discovery and any wake to finish. */
async function fireProbe(env) {
    const [timer] = probeTimers(env);
    assert.ok(timer, 'a probe timer is armed');
    timer.cleared = true; // fired: it no longer counts as live
    timer.fn();
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    await env.prestager.wake();
}

test('T-2025 probe: a tick that discovers a newer release wakes one cycle, then re-arms', async (t) => {
    const logger = recordingLogger();
    const env = fixture(t, { settings: IMMEDIATE, logger, ...PROBE });
    env.prestager.start();
    assert.equal(probeTimers(env).length, 1, 'start() arms one probe');
    await fireProbe(env);
    assert.equal(named(logger, 'wake_on_discovery').length, 1);
    assert.equal(env.prestager.status().reasonCode, 'settling');
    assert.equal(env.builder.calls, 0, 'the tick itself builds nothing');
    assert.equal(probeTimers(env).length, 1, 'the probe re-arms once');
    await fireProbe(env);
    assert.equal(named(logger, 'wake_on_discovery').length, 1, 'no change: no second wake');
    assert.equal(env.discoveries >= 2, true);
    await env.prestager.stop();
    assert.equal(probeTimers(env).length, 0, 'stop() clears the probe');
});

test('T-2025 probe: a tick with nothing newer wakes nothing; a direct probe while stopped does nothing', async (t) => {
    const logger = recordingLogger();
    const env = fixture(t, { settings: IMMEDIATE, logger, ...PROBE });
    env.release = { version: '1.42.0.0', tagName: 'v1.42.0.0', commit: COMMIT_1 };
    env.prestager.start();
    await fireProbe(env);
    assert.equal(named(logger, 'wake_on_discovery').length, 0);
    await env.prestager.stop();
    const before = env.discoveries;
    assert.equal(await env.prestager.probe(), null);
    assert.equal(env.discoveries, before, 'stopped: no discovery');
    assert.equal(probeTimers(env).length, 0);
});

test('T-2025 probe: a timer that fires after stop() neither discovers nor re-arms', async (t) => {
    const env = fixture(t, { settings: IMMEDIATE, ...PROBE });
    env.prestager.start();
    const [timer] = probeTimers(env);
    await env.prestager.stop();
    const before = env.discoveries;
    timer.fn();
    for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(env.discoveries, before);
    assert.equal(probeTimers(env).length, 0);
});

test('T-2025 probe: owner off skips the discovery but keeps probing; the kill switch ends the probe', async (t) => {
    const env = fixture(t, { settings: { prestageEnabled: false, prestageQuarantineHours: 0 }, ...PROBE });
    env.prestager.start();
    await fireProbe(env);
    assert.equal(env.discoveries, 0, 'off: no ls-remote');
    assert.equal(probeTimers(env).length, 1, 'off keeps the probe for a later enable');
    await env.prestager.stop();
    const killed = fixture(t, { settings: IMMEDIATE, env: { NASSAJ_UPDATE_PRESTAGE: '0' }, ...PROBE });
    killed.prestager.start();
    await fireProbe(killed);
    assert.equal(probeTimers(killed).length, 0, 'kill switch: the probe ends');
    await killed.prestager.stop();
});

const flush = async (turns = 20) => { for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };

test('T-2025 qa 1a: a woken cycle that finds the mutex taken keeps the wake for the next probe', async (t) => {
    const logger = recordingLogger();
    const env = fixture(t, { settings: IMMEDIATE, logger });
    env.prestager.start();
    const held = tryAcquireBuildMutex(env.appRoot, { kind: 'source-update-job' });
    t.after(() => held?.release());
    await env.prestager.noteRelease({ ...env.release });
    assert.equal(env.prestager.status().reasonCode, 'build_in_progress');
    held.release();
    const again = env.prestager.noteRelease({ ...env.release });
    assert.ok(again, 'the wake was not used up');
    await again;
    assert.equal(env.prestager.status().reasonCode, 'settling');
    assert.equal(env.prestager.noteRelease({ ...env.release }), null, 'now it is used up');
    assert.equal(named(logger, 'wake_on_discovery').length, 2);
    await env.prestager.stop();
});

test('T-2025 qa 1b: a newer release while an older one builds supersedes it and settles at once, with a timer', async (t) => {
    const env = fixture(t, { settings: IMMEDIATE });
    env.builder.hold = deferred();
    env.prestager.start();
    await env.prestager.runCycle();
    env.tick(5 * MIN);
    await env.prestager.runCycle();
    await building(env);
    // Fire the first poll (nothing newer yet): the next poll is then ~30 min away.
    const firstPoll = env.timeouts.find((handle) => handle.ms === 5 * MIN && !handle.cleared);
    firstPoll.cleared = true;
    firstPoll.fn();
    await flush();
    env.release = { version: '1.42.0.2', tagName: 'v1.42.0.2', commit: COMMIT_2 };
    const before = env.timeouts.length;
    await env.prestager.noteRelease({ ...env.release });
    assert.equal(env.prestager.buildInFlight(), null, 'the older build is aborted');
    assert.deepEqual([env.prestager.status().reasonCode, env.prestager.status().version], ['settling', '1.42.0.2']);
    assert.ok(env.timeouts.slice(before).some((handle) => handle.ms === 5 * MIN && !handle.cleared), 'settle timer armed');
    assert.equal(env.prestager.noteRelease({ ...env.release }), null, 'the wake is used up once settling');
    env.tick(5 * MIN);
    env.builder.hold = null;
    await env.prestager.runCycle();
    await settle(env);
    assert.deepEqual([env.prestager.status().state, env.prestager.status().version], ['ready', '1.42.0.2']);
    await env.prestager.stop();
});

test('T-2025 qa 4: a new tag on the commit being built supersedes the build', async (t) => {
    const env = fixture(t, { settings: IMMEDIATE });
    env.builder.hold = deferred();
    await env.prestager.runCycle();
    env.tick(5 * MIN);
    await env.prestager.runCycle();
    await building(env);
    env.release = { version: '1.42.0.2', tagName: 'v1.42.0.2', commit: COMMIT_1 };
    await env.prestager.runCycle();
    assert.equal(env.prestager.buildInFlight(), null);
    assert.deepEqual([env.prestager.status().reasonCode, env.prestager.status().version], ['settling', '1.42.0.2']);
    env.builder.hold = null;
});

test('T-2025 qa 2: a re-tag of the same tag on a new commit wakes again', async (t) => {
    const logger = recordingLogger();
    const env = fixture(t, { settings: IMMEDIATE, logger });
    env.prestager.start();
    await env.prestager.noteRelease({ ...env.release });
    env.release = { ...env.release, commit: COMMIT_2 };
    const again = env.prestager.noteRelease({ ...env.release });
    assert.ok(again);
    await again;
    assert.equal(named(logger, 'wake_on_discovery').length, 2);
    await env.prestager.stop();
});

test('T-2025 qa 2: past maxWokenReleases the oldest key is evicted and may wake again', async (t) => {
    const logger = recordingLogger();
    const env = fixture(t, { settings: IMMEDIATE, logger, options: { maxWokenReleases: 2 } });
    env.prestager.start();
    const release = (n) => ({ version: `1.42.0.${n}`, tagName: `v1.42.0.${n}`, commit: String(n).repeat(40) });
    for (const n of [1, 2, 3]) {
        env.release = release(n);
        await env.prestager.noteRelease(release(n));
    }
    assert.equal(env.prestager.noteRelease(release(2)), null, 'still remembered');
    env.release = release(1);
    const evicted = env.prestager.noteRelease(release(1));
    assert.ok(evicted, 'the evicted oldest key wakes again');
    await evicted;
    assert.deepEqual(named(logger, 'wake_on_discovery').map((entry) => entry.version),
        ['1.42.0.1', '1.42.0.2', '1.42.0.3', '1.42.0.1']);
    await env.prestager.stop();
});

test('T-2025 qa 2: a probe whose discovery rejects wakes nothing and re-arms', async (t) => {
    const logger = recordingLogger();
    const env = fixture(t, { settings: IMMEDIATE, logger, ...PROBE,
        discoverRelease: async () => { env.discoveries += 1; throw Object.assign(new Error('down'), { code: 'release_source_unavailable' }); } });
    env.prestager.start();
    await fireProbe(env);
    assert.equal(env.discoveries >= 1, true);
    assert.equal(named(logger, 'wake_on_discovery').length, 0);
    assert.equal(probeTimers(env).length, 1, 're-armed after the rejection');
    await env.prestager.stop();
});

test('T-2025 qa 2: stop() then start() while a probe is in flight leaves exactly one probe timer', async (t) => {
    const gate = deferred();
    const env = fixture(t, { settings: IMMEDIATE, ...PROBE,
        discoverRelease: async () => { env.discoveries += 1; await gate.promise; return { release: { ...env.release } }; } });
    env.prestager.start();
    const [timer] = probeTimers(env);
    timer.cleared = true;
    timer.fn();
    await flush(5);
    assert.equal(env.discoveries, 1, 'the probe is in flight');
    await env.prestager.stop();
    env.prestager.start();
    gate.resolve();
    await flush();
    assert.equal(probeTimers(env).length, 1);
    await env.prestager.stop();
});
