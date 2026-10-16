/**
 * T-2024 S2 (ADR-207 §3.3, §6): the prestage slot — schema, atomic writes,
 * CAS under the flock, per-cycle recovery rows, verified group kill before any
 * delete, the one-un-adopted invariant and the quarantine first-seen store.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { tryAcquireBuildMutex } from './source-update-build-mutex.js';
import { flockAsync } from './update-maintenance-gate.js';
import { buildPrestageIdentityKey } from './update-prestage-identity.js';
import { currentProcessIdentity, linuxProc } from './update-prestage-process-group.js';
import {
    PRESTAGE_BUILD_MUTEX_KIND, PRESTAGE_SLOT_SCHEMA, adoptedJobId, createPrestageSlot, isValidSlot,
    newPrestageTransactionId, prestageRefPrefix, quarantineRemainingMs,
} from './update-prestage-slot.js';

const RELEASE = 'b'.repeat(40);
const H = (c) => c.repeat(64);
const OUTPUTS = { manifestSha256: H('a'), trees: { client: H('1'), server: H('2'), nodeModules: H('3') } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd, encoding: 'utf8' }).trim();

function identity(overrides = {}) {
    return buildPrestageIdentityKey({
        releaseCommit: RELEASE,
        sourcePin: { repositoryUrl: 'https://github.com/AlKindy-OSS/nassaj.git', remote: 'origin', branch: 'main', tag: 'v1.42.0.1' },
        runtime: { version: 'v24.0.0', modules: '137', napi: '10', platform: 'linux', arch: 'x64',
            binary: { realpath: '/usr/bin/node', dev: 1, ino: 2, size: 3, mtimeMs: 4 } },
        npm: { realpath: '/usr/bin/npm', version: '11.0.0' },
        builderBuildId: H('e'),
        buildInputs: { candidateScriptSha256: H('1'), publicViteSha256: H('2'), buildEnvSha256: H('3'),
            packageLockBlob: 'f'.repeat(40), strategy: 'git-checkout-v2' },
        ...overrides,
    });
}

const TARGET = { version: '1.42.0.1', tag: 'v1.42.0.1', releaseCommit: RELEASE };

function fixture(t, options = {}) {
    const appRoot = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-prestage-slot-'));
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    git(appRoot, 'init', '-q');
    git(appRoot, 'commit', '-q', '--allow-empty', '-m', 'a');
    const controlRoot = path.join(appRoot, '.git', 'nassaj-source-update');
    fs.mkdirSync(path.join(controlRoot, 'candidates'), { recursive: true, mode: 0o700 });
    let clock = Date.parse('2026-10-14T10:00:00Z');
    const { mutex: holdMutex = true, ...slotOptions } = options;
    const slot = createPrestageSlot({ appRoot, controlRoot, now: () => clock, lockWaitMs: 200, killWaitMs: 2_000, ...slotOptions });
    // qa S3 condition 2: deletes need the prestage build mutex; the prestager holds it in production.
    const mutex = holdMutex ? tryAcquireBuildMutex(appRoot, { kind: PRESTAGE_BUILD_MUTEX_KIND }) : null;
    t.after(() => mutex?.release());
    return { appRoot, controlRoot, slot, mutex, tick: (ms) => { clock += ms; }, now: () => clock };
}

/** Lay out a prestage candidate as the build does: worktree, payload, plan and private refs. */
function candidateFiles(env, transactionId) {
    const candidate = path.join(env.controlRoot, 'candidates', transactionId);
    fs.mkdirSync(candidate, { mode: 0o700 });
    git(env.appRoot, 'worktree', 'add', '-q', '--detach', path.join(candidate, 'source'), 'HEAD');
    fs.writeFileSync(path.join(candidate, 'candidate-manifest.json'), '{}', { mode: 0o600 });
    fs.writeFileSync(path.join(env.controlRoot, `plan-${transactionId}.json`), '{}\n', { mode: 0o600 });
    git(env.appRoot, 'update-ref', `${prestageRefPrefix(transactionId)}tag`, 'HEAD');
    return candidate;
}

function prestageRefs(env) {
    return git(env.appRoot, 'for-each-ref', '--format=%(refname)', 'refs/nassaj-prestage/').split('\n').filter(Boolean);
}

function worktrees(env) {
    return git(env.appRoot, 'worktree', 'list', '--porcelain').split('\n')
        .filter((line) => line.startsWith('worktree ') && line.includes('/candidates/')).length;
}

async function building(env, { transactionId = newPrestageTransactionId(), owner, files = true } = {}) {
    if (files) candidateFiles(env, transactionId);
    const slot = await env.slot.beginBuild({ target: TARGET, identity: identity().key, transactionId, owner });
    return { transactionId, slot };
}

async function ready(env, options) {
    const { transactionId, slot } = await building(env, options);
    return { transactionId, slot: await env.slot.markReady(slot, OUTPUTS) };
}

/** A live detached group (the launcher's shape) and its effect identity. */
async function liveGroup(t) {
    const child = spawn('bash', ['-c', 'sleep 30 & sleep 30 & wait'], { detached: true, stdio: 'ignore' });
    t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
    const alive = () => linuxProc.listPids().filter((pid) => {
        const stat = linuxProc.stat(pid);
        return stat?.pgid === child.pid && stat.state !== 'Z';
    });
    for (let attempt = 0; attempt < 200 && alive().length < 3; attempt += 1) await sleep(5);
    return { child, alive, effect: { pid: child.pid, pgid: child.pid, startTicks: linuxProc.stat(child.pid).startTicks, bootId: linuxProc.bootId() } };
}

const DEAD_OWNER = { pid: 2_147_483_000, startTicks: '1', bootId: linuxProc.bootId() };
const noJobs = () => null;

// ---------------------------------------------------------------------------
// Schema, atomic writes and CAS
// ---------------------------------------------------------------------------

test('lifecycle building → ready → adopted:<jobId>, revisions and a strict 0600 schema', async (t) => {
    const env = fixture(t);
    const { slot: built } = await building(env);
    assert.equal(built.schema, PRESTAGE_SLOT_SCHEMA);
    assert.equal(built.state, 'building');
    assert.equal(built.revision, 1);
    assert.equal(built.keyDigest, identity().digest);
    assert.deepEqual(built.build.owner, currentProcessIdentity());
    const effect = { pid: 4242, pgid: 4242, startTicks: '77', bootId: linuxProc.bootId() };
    const withEffect = await env.slot.recordBuildEffect(built, effect);
    assert.deepEqual([withEffect.revision, withEffect.build.effect], [2, effect]);
    const readySlot = await env.slot.markReady(withEffect, OUTPUTS);
    assert.deepEqual([readySlot.state, readySlot.build.effect, readySlot.outputs], ['ready', null, OUTPUTS]);
    const adopted = await env.slot.adopt(readySlot, { jobId: 'job-1', keyDigest: identity().digest });
    assert.equal(adopted.state, 'adopted:job-1');
    assert.equal(adoptedJobId(adopted.state), 'job-1');
    assert.equal(fs.statSync(env.slot.paths.slot).mode & 0o777, 0o600);
    assert.deepEqual(env.slot.read(), adopted);
    assert.equal(isValidSlot(adopted), true);
    assert.deepEqual(fs.readdirSync(env.slot.paths.root).filter((name) => name.endsWith('.tmp')), [], 'no temporary files left');
});

test('CAS: a stale revision, a wrong state, an occupied slot and a foreign key are refused', async (t) => {
    const env = fixture(t);
    const { slot: built } = await building(env);
    const readySlot = await env.slot.markReady(built, OUTPUTS);
    await assert.rejects(env.slot.markReady(built, OUTPUTS), { code: 'prestage_slot_conflict' });
    await assert.rejects(env.slot.markReady(readySlot, OUTPUTS), { code: 'prestage_slot_conflict' });
    await assert.rejects(building(env, { files: false }), { code: 'prestage_slot_occupied' });
    await assert.rejects(env.slot.adopt(readySlot, { jobId: 'job-1', keyDigest: identity({ builderBuildId: H('d') }).digest }),
        { code: 'prestage_identity_mismatch' });
    await assert.rejects(env.slot.adopt(readySlot, { jobId: 'bad job', keyDigest: identity().digest }), { code: 'prestage_job_invalid' });
    await assert.rejects(env.slot.markReady(readySlot, { ...OUTPUTS, trees: {} }), { code: 'prestage_outputs_invalid' });
    assert.equal(env.slot.read().revision, readySlot.revision, 'refusals write nothing');
});

test('a tampered slot (identity no longer matches its key digest) is invalid', async (t) => {
    const env = fixture(t);
    const { slot: built } = await building(env);
    const tampered = { ...built, identity: { ...built.identity, builderBuildId: H('0') } };
    fs.writeFileSync(env.slot.paths.slot, JSON.stringify(tampered));
    assert.deepEqual(env.slot.read(), { corrupt: true });
});

test('every write waits for the exclusive flock; a held lock writes nothing', async (t) => {
    const env = fixture(t);
    fs.mkdirSync(env.slot.paths.root, { recursive: true, mode: 0o700 });
    const held = await flockAsync(env.slot.paths.lock, 'exclusive', { waitMs: 1_000 });
    try {
        await assert.rejects(building(env, { files: false }), (error) => error.message === 'update_lock_contended');
        assert.equal(fs.existsSync(env.slot.paths.slot), false);
    } finally {
        held.release();
    }
    await building(env, { files: false });
    assert.equal(env.slot.read().state, 'building');
});

// ---------------------------------------------------------------------------
// Recovery rows (run from a cycle, not only at boot)
// ---------------------------------------------------------------------------

test('recovery: building with a dead owner → its live group is killed, then everything is discarded', async (t) => {
    const env = fixture(t);
    const { alive, effect } = await liveGroup(t);
    const { transactionId, slot: built } = await building(env, { owner: DEAD_OWNER });
    await env.slot.recordBuildEffect(built, effect);
    const outcome = await env.slot.recover({ lookupJob: noJobs });
    assert.equal(outcome.action, 'discarded_owner_dead');
    assert.deepEqual([outcome.discarded, outcome.killed], [true, 3]);
    assert.deepEqual(alive(), []);
    assert.equal(env.slot.read(), null);
    assert.equal(fs.existsSync(path.join(env.controlRoot, 'candidates', transactionId)), false);
    assert.equal(fs.existsSync(path.join(env.controlRoot, `plan-${transactionId}.json`)), false);
    assert.deepEqual(prestageRefs(env), []);
    assert.equal(worktrees(env), 0);
});

test('recovery: pid reuse — the recorded leader pid is another process: it lives, the slot is discarded', async (t) => {
    const env = fixture(t);
    const { alive, effect } = await liveGroup(t);
    const { slot: built } = await building(env, { owner: DEAD_OWNER });
    await env.slot.recordBuildEffect(built, { ...effect, startTicks: '1' });
    const outcome = await env.slot.recover({ lookupJob: noJobs });
    assert.deepEqual([outcome.action, outcome.discarded, outcome.killed], ['discarded_owner_dead', true, 0]);
    assert.equal(alive().length, 3, 'nothing of the unrelated group was killed');
});

test('recovery: a group that survives the kill keeps the slot discarding; the next cycle finishes it', async (t) => {
    const env = fixture(t, { kill: () => {}, killWaitMs: 30 });
    const { effect } = await liveGroup(t);
    const { transactionId, slot: built } = await building(env, { owner: DEAD_OWNER });
    await env.slot.recordBuildEffect(built, effect);
    const first = await env.slot.recover({ lookupJob: noJobs });
    assert.deepEqual([first.discarded, first.reason, first.slot], [false, 'group_survived', 'discarding']);
    assert.ok(fs.existsSync(path.join(env.controlRoot, 'candidates', transactionId)), 'nothing deleted while a member may run');
    const healed = createPrestageSlot({ appRoot: env.appRoot, controlRoot: env.controlRoot, lockWaitMs: 200 });
    const second = await healed.recover({ lookupJob: noJobs });
    assert.deepEqual([second.action, second.discarded], ['discard_finished', true]);
    assert.equal(healed.read(), null);
});

test('recovery: drain — a building slot owned by another live server process is left alone', async (t) => {
    const env = fixture(t);
    const { child, effect } = await liveGroup(t);
    await building(env, { owner: { pid: child.pid, startTicks: effect.startTicks, bootId: effect.bootId } });
    const outcome = await env.slot.recover({ lookupJob: noJobs });
    assert.deepEqual([outcome.action, outcome.slot], ['building_kept_foreign_live', 'building']);
});

test('recovery: this process\'s own building slot is kept while its build runs, discarded once it is lost', async (t) => {
    const env = fixture(t);
    await building(env);
    assert.equal((await env.slot.recover({ lookupJob: noJobs, ownBuildActive: () => true })).action, 'building_kept_own');
    const lost = await env.slot.recover({ lookupJob: noJobs });
    assert.deepEqual([lost.action, lost.discarded, lost.slot], ['discarded_own_lost', true, null]);
});

test('recovery: ready is kept when whole and current; a missing candidate or another identity discards it', async (t) => {
    const env = fixture(t);
    await ready(env);
    assert.equal((await env.slot.recover({ lookupJob: noJobs, expectedKeyDigest: identity().digest })).action, 'ready_kept');
    const mismatch = await env.slot.recover({ lookupJob: noJobs, expectedKeyDigest: identity({ builderBuildId: H('d') }).digest });
    assert.deepEqual([mismatch.action, mismatch.discarded], ['discarded_identity_mismatch', true]);
    await ready(env, { files: false });
    assert.equal((await env.slot.recover({ lookupJob: noJobs })).action, 'discarded_candidate_missing');
    assert.equal(env.slot.read(), null);
});

test('recovery: adopted:<jobId> stays until the job carries the transaction or ends; the candidate stays with the job', async (t) => {
    const env = fixture(t);
    const { transactionId, slot: readySlot } = await ready(env);
    await env.slot.adopt(readySlot, { jobId: 'job-7', keyDigest: identity().digest });
    const rows = [
        [undefined, 'adopted_kept_unknown_job'],
        [{ state: 'staging', transactionId: null }, 'adopted_kept'],
        [{ state: 'manual_recovery_required', transactionId: null }, 'adopted_kept'],
    ];
    for (const [job, action] of rows) {
        assert.equal((await env.slot.recover({ lookupJob: () => job })).action, action);
        assert.equal(env.slot.read().state, 'adopted:job-7');
    }
    assert.equal((await env.slot.recover({ lookupJob: () => { throw new Error('db'); } })).action, 'adopted_kept_unknown_job');
    const settled = await env.slot.recover({ lookupJob: (id) => (id === 'job-7' ? { state: 'candidate_sealed', transactionId } : null) });
    assert.deepEqual([settled.action, settled.slot], ['adoption_settled', null]);
    assert.ok(fs.existsSync(path.join(env.controlRoot, 'candidates', transactionId)), 'the job owns the candidate now');
});

test('recovery: an adopted marker of a terminal or missing job is released', async (t) => {
    for (const job of [{ state: 'failed', transactionId: null }, null]) {
        const env = fixture(t);
        const { slot: readySlot } = await ready(env);
        await env.slot.adopt(readySlot, { jobId: 'job-8', keyDigest: identity().digest });
        assert.equal((await env.slot.recover({ lookupJob: () => job })).action, 'adoption_settled');
    }
});

test('recovery: a crash during discard (discarding) is finished by the next cycle', async (t) => {
    const env = fixture(t);
    const { transactionId, slot: built } = await building(env);
    fs.writeFileSync(env.slot.paths.slot, JSON.stringify({ ...built, state: 'discarding', revision: 2, discardReason: 'superseded' }));
    const outcome = await env.slot.recover({ lookupJob: noJobs });
    assert.deepEqual([outcome.action, outcome.discarded, outcome.reason], ['discard_finished', true, 'superseded']);
    assert.equal(fs.existsSync(path.join(env.controlRoot, 'candidates', transactionId)), false);
});

test('recovery: a corrupt slot.json is quarantined, never trusted', async (t) => {
    const env = fixture(t);
    fs.mkdirSync(env.slot.paths.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(env.slot.paths.slot, '{"schema":"nassaj-prestage-slot/v1"');
    const outcome = await env.slot.recover({ lookupJob: noJobs });
    assert.equal(outcome.action, 'corrupt_quarantined');
    assert.equal(env.slot.read(), null);
    assert.equal(fs.readdirSync(env.slot.paths.root).filter((name) => name.startsWith('slot.corrupt-')).length, 1);
});

test('discard: a ready slot is discarded explicitly, with history', async (t) => {
    const env = fixture(t);
    const { slot: readySlot } = await ready(env);
    assert.deepEqual(await env.slot.discard(readySlot, 'superseded'), { discarded: true, reason: 'superseded', killed: 0 });
    const history = fs.readFileSync(env.slot.paths.history, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(history.at(-1).outcome, 'discarded');
    assert.equal(history.at(-1).reason, 'superseded');
});

// ---------------------------------------------------------------------------
// Invariant: at most one un-adopted update-pre-* candidate (M4)
// ---------------------------------------------------------------------------

test('the orphan sweep keeps the slot\'s and the jobs\' candidates and removes every other update-pre-*', async (t) => {
    const env = fixture(t);
    const orphanA = newPrestageTransactionId();
    const orphanB = `${newPrestageTransactionId()}b`;
    const jobOwned = `${newPrestageTransactionId()}j`;
    const activated = `${newPrestageTransactionId()}a`;
    for (const tx of [orphanA, orphanB, jobOwned, activated]) candidateFiles(env, tx);
    // qa S3 condition 1: every job row counts, an activated one (the rollback candidate) included.
    const jobReferences = [{ state: 'restart_queued', transactionId: jobOwned },
        { state: 'activated', transactionId: activated }, { state: 'failed', transactionId: null }];
    fs.mkdirSync(path.join(env.controlRoot, 'candidates', 'update-not-prestage'));
    const { transactionId: current } = await ready(env);

    const deferred = await env.slot.recover({ lookupJob: noJobs, sweep: { allowed: false, jobReferences } });
    assert.deepEqual(deferred.sweep, { status: 'deferred', orphans: 2 });
    assert.equal(fs.readdirSync(path.join(env.controlRoot, 'candidates')).length, 6, 'refused sweep deletes nothing');

    // S4 qa (b): an unnamed ref goes only once its nonce (stamped with the real clock) is 10 min old.
    const freshRefs = await env.slot.recover({ lookupJob: noJobs, sweep: { allowed: true, jobReferences } });
    assert.equal(freshRefs.sweep.refs, 0, 'refs younger than 10 minutes stay');
    for (const tx of [orphanA, orphanB]) candidateFiles(env, tx);
    env.tick(Date.now() + 10 * 60_000 - env.now());
    const swept = await env.slot.recover({ lookupJob: noJobs, sweep: { allowed: true, jobReferences } });
    assert.equal(swept.sweep.status, 'swept');
    assert.deepEqual(swept.sweep.removed, [orphanA, orphanB].sort());
    assert.deepEqual(fs.readdirSync(path.join(env.controlRoot, 'candidates')).sort(), [current, jobOwned, activated, 'update-not-prestage'].sort());
    assert.deepEqual(fs.readdirSync(env.controlRoot).filter((name) => name.startsWith('plan-')).sort(),
        [`plan-${current}.json`, `plan-${jobOwned}.json`, `plan-${activated}.json`].sort());
    assert.deepEqual(prestageRefs(env).sort(), [current, jobOwned, activated].map((tx) => `${prestageRefPrefix(tx)}tag`).sort());
    assert.equal(worktrees(env), 3);
});

test('qa S3 condition 2: without the prestage build mutex nothing is deleted — discard, recovery, sweep', async (t) => {
    const env = fixture(t, { mutex: false });
    const orphan = newPrestageTransactionId();
    candidateFiles(env, orphan);
    const { transactionId, slot } = await ready(env);
    await assert.rejects(env.slot.discard(slot, 'superseded'), { code: 'prestage_mutex_not_held' });
    await assert.rejects(env.slot.recover({ lookupJob: noJobs, sweep: { allowed: true, jobReferences: [] } }),
        { code: 'prestage_mutex_not_held' });
    // A job's build holds the mutex under another kind: still refused.
    const jobMutex = tryAcquireBuildMutex(env.appRoot, { kind: 'source-update' });
    try {
        await assert.rejects(env.slot.discard(slot, 'superseded'), { code: 'prestage_mutex_not_held' });
    } finally {
        jobMutex.release();
    }
    assert.equal(env.slot.read().state, 'ready');
    assert.ok(fs.existsSync(path.join(env.controlRoot, 'candidates', transactionId)));
    assert.ok(fs.existsSync(path.join(env.controlRoot, 'candidates', orphan)));
    const mutex = tryAcquireBuildMutex(env.appRoot, { kind: PRESTAGE_BUILD_MUTEX_KIND });
    try {
        assert.equal((await env.slot.discard(slot, 'superseded')).discarded, true);
    } finally {
        mutex.release();
    }
});

test('S4: a job discards only under its OWN build mutex (the prestager passes its jobId); another job or none is refused', async (t) => {
    const env = fixture(t, { mutex: false });
    const { transactionId, slot } = await ready(env);
    const jobMutex = tryAcquireBuildMutex(env.appRoot, { kind: 'source-update', jobId: 'job-9' });
    t.after(() => jobMutex.release());
    await assert.rejects(env.slot.discard(slot, 'other_version'), { code: 'prestage_mutex_not_held' });
    await assert.rejects(env.slot.discard(slot, 'other_version', { jobId: 'job-8' }), { code: 'prestage_mutex_not_held' });
    assert.equal(env.slot.read().state, 'ready');
    assert.equal((await env.slot.discard(slot, 'other_version', { jobId: 'job-9' })).discarded, true);
    assert.equal(env.slot.read(), null);
    assert.equal(fs.existsSync(path.join(env.controlRoot, 'candidates', transactionId)), false);
});

test('S4: rejectAdoption — only the adopting job, under its mutex, turns adopted:<jobId> into a finished discard', async (t) => {
    const env = fixture(t, { mutex: false });
    const { transactionId, slot } = await ready(env);
    const adopted = await env.slot.adopt(slot, { jobId: 'job-9', keyDigest: identity().digest });
    const jobMutex = tryAcquireBuildMutex(env.appRoot, { kind: 'source-update', jobId: 'job-9' });
    t.after(() => jobMutex.release());
    await assert.rejects(env.slot.rejectAdoption(adopted, { jobId: 'job-8', reason: 'tree_hash_mismatch' }),
        { code: 'prestage_mutex_not_held' });
    assert.equal(env.slot.read().state, 'adopted:job-9');
    const outcome = await env.slot.rejectAdoption(adopted, { jobId: 'job-9', reason: 'tree_hash_mismatch' });
    assert.deepEqual([outcome.discarded, outcome.reason], [true, 'tree_hash_mismatch']);
    assert.equal(env.slot.read(), null);
    assert.equal(fs.existsSync(path.join(env.controlRoot, 'candidates', transactionId)), false);
    const outcomes = fs.readFileSync(env.slot.paths.history, 'utf8').trim().split('\n').map((line) => JSON.parse(line).outcome);
    assert.deepEqual(outcomes.slice(-3), ['adopted', 'adoption_rejected', 'discarded']);
});

// ---------------------------------------------------------------------------
// First-seen store (quarantine clock)
// ---------------------------------------------------------------------------

test('first-seen: node-local, bound to tag + commit, reset when the tag moves; a back-dated tag changes nothing', async (t) => {
    const env = fixture(t);
    const backDated = new Date(Date.parse('2026-09-01T00:00:00Z')).toISOString();
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'tag', '-a', 'v1.42.0.1', '-m', 'old'],
        { cwd: env.appRoot, env: { ...process.env, GIT_COMMITTER_DATE: backDated, GIT_AUTHOR_DATE: backDated } });
    const commit = git(env.appRoot, 'rev-parse', 'v1.42.0.1^{commit}');
    const first = await env.slot.observeFirstSeen({ tag: 'v1.42.0.1', targetCommit: commit });
    assert.deepEqual(first, { targetCommit: commit, firstSeenAt: env.now(), reset: false }, 'the clock starts now, not at the tag date');
    const twelveHours = 12 * 60 * 60 * 1000;
    assert.equal(quarantineRemainingMs(first, twelveHours, env.now()), twelveHours);

    env.tick(60_000);
    const again = await env.slot.observeFirstSeen({ tag: 'v1.42.0.1', targetCommit: commit });
    assert.equal(again.firstSeenAt, first.firstSeenAt);
    assert.equal(quarantineRemainingMs(again, twelveHours, env.now()), twelveHours - 60_000);

    env.tick(60_000);
    const moved = await env.slot.observeFirstSeen({ tag: 'v1.42.0.1', targetCommit: 'c'.repeat(40) });
    assert.deepEqual([moved.firstSeenAt, moved.reset], [env.now(), true]);
    assert.deepEqual(env.slot.readFirstSeen('v1.42.0.1'), { targetCommit: 'c'.repeat(40), firstSeenAt: env.now() });
    assert.equal(env.slot.readFirstSeen('v9.9.9.9'), null);
    assert.equal(fs.statSync(env.slot.paths.firstSeen).mode & 0o777, 0o600);
    await assert.rejects(env.slot.observeFirstSeen({ tag: 'v1', targetCommit: 'nope' }), { code: 'prestage_first_seen_invalid' });
    assert.equal(quarantineRemainingMs(null, twelveHours, env.now()), twelveHours);
});

test('history is bounded to the last 50 outcomes', async (t) => {
    const env = fixture(t);
    for (let index = 0; index < 27; index += 1) {
        const { slot: readySlot } = await ready(env, { files: false });
        await env.slot.discard(readySlot, `r${index}`);
    }
    const lines = fs.readFileSync(env.slot.paths.history, 'utf8').trim().split('\n');
    assert.equal(lines.length, 27, 'one line per discard');
    for (let index = 27; index < 60; index += 1) {
        const { slot: readySlot } = await ready(env, { files: false });
        await env.slot.discard(readySlot, `r${index}`);
    }
    const bounded = fs.readFileSync(env.slot.paths.history, 'utf8').trim().split('\n');
    assert.equal(bounded.length, 50);
    assert.equal(JSON.parse(bounded.at(-1)).reason, 'r59');
});
