/**
 * T-2024 (ADR-207 §6, qa A1): check parity of the button path and the
 * HEAD-independence of buildCandidate().
 *
 * The spy records every check updateSource() runs, from its command, its
 * dependency call or the state it leaves, as one named step. The button path
 * must run each check it ran before the split, exactly once, in the defined
 * order below. buildCandidate() alone must run none of the click-time checks.
 */
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import test from 'node:test';

import { createSourceUpdater, __test__ } from './source-updater.js';

const EXT4_MAGIC = 0xef53;
const ORIGINAL = 'a'.repeat(40);
const RELEASE = 'b'.repeat(40);
const LOADED = 'c'.repeat(40);
const VERSION = '1.42.0.1';

/**
 * The button path's checks in their defined order (ADR-207 §3.1). Before the
 * split the only difference was `version` running after `fast-forward`; the
 * tag's package version is release identity, so it moved into the
 * HEAD-independent identity step.
 */
const BUTTON_PATH_CHECKS = [
    'storage', 'sessions', 'tracked-clean', 'branch', 'head', 'remote',
    // release identity (HEAD-independent, shared with buildCandidate)
    'fetch', 'remote-recheck', 'tag', 'not-older', 'on-branch', 'version',
    // click-time, from the live HEAD
    'fast-forward', 'release-paths', 'gitlinks', 'overlay',
    'sessions', 'head-recheck', 'scoped-clean', 'source-plan', 'waiter',
    // the build
    'writer-lease', 'exchange', 'worktree-add', 'candidate-build', 'stage-head',
    // sealAndQueue: post-queue race guard
    'live-head', 'live-status',
];

/** Steps that read the live tree, its sessions or the job's waiter: never part of a build. */
const CLICK_TIME_CHECKS = new Set([
    'sessions', 'tracked-clean', 'branch', 'head', 'fast-forward', 'release-paths', 'gitlinks', 'overlay',
    'head-recheck', 'scoped-clean', 'source-plan', 'waiter', 'live-head', 'live-status',
]);

function response(stdout = '', code = 0) {
    return { code, signal: null, stdout, stderr: '' };
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-source-updater-parity-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts', 'source-update-candidate.mjs'), '// fixture');
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config', 'node-overlay.json'),
        JSON.stringify({ schema: 1, static: [{ mount: '/hub', dir: 'static/hub' }] }));
    return root;
}

function candidateManifest(plan) {
    return {
        schemaVersion: 1, txId: plan.txId, releaseCommit: plan.releaseCommit, version: plan.version,
        serverBuildId: 'c'.repeat(64), clientBuildId: 'd'.repeat(64),
        sourceProvenance: { kind: 'git-worktree', commit: plan.releaseCommit, clean: true },
        artifacts: {
            client: { commit: plan.releaseCommit, buildId: 'd'.repeat(64) },
            server: { commit: plan.releaseCommit, buildId: 'c'.repeat(64) },
            nodeModules: { commit: plan.releaseCommit },
        },
    };
}

/** Name the check a command performs; null for commands that decide nothing (cleanup, tracking ref). */
function checkOf(command, args, options, state) {
    const joined = args.join(' ');
    if (command === process.execPath && args.includes('--plan')) return 'candidate-build';
    if (joined.includes('--untracked-files=no')) return 'tracked-clean';
    if (joined.includes('--untracked-files=all')) return state.queued ? 'live-status' : 'scoped-clean';
    if (joined.includes('symbolic-ref')) return 'branch';
    if (joined.includes('remote get-url --all')) return 'remote';
    if (joined.includes('remote get-url')) return 'remote-recheck';
    if (joined.includes(' fetch ')) return 'fetch';
    if (joined.includes('/tag^{commit}')) return 'tag';
    if (joined.includes(`--is-ancestor ${RELEASE} ${LOADED}`)) return 'not-older';
    if (joined.includes('merge-base --is-ancestor') && joined.includes('/branch')) return 'on-branch';
    if (joined.includes(`--is-ancestor ${ORIGINAL} ${RELEASE}`)) return 'fast-forward';
    if (joined.includes(':package.json')) return 'version';
    if (joined.includes('diff --name-only')) return 'release-paths';
    if (joined.includes('diff --raw')) return 'gitlinks';
    if (joined.includes('ls-tree')) return 'overlay';
    if (joined.includes('worktree add')) return 'worktree-add';
    if (joined.includes('rev-parse --verify HEAD^{commit}')) {
        if (options.cwd?.includes('/candidates/')) return 'stage-head';
        if (state.queued) return 'live-head';
        state.heads += 1;
        return state.heads === 1 ? 'head' : 'head-recheck';
    }
    return null;
}

function waiterReserved(appRoot) {
    const found = [];
    const walk = (directory) => {
        for (const entry of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
            const full = path.join(directory, entry);
            if (fs.statSync(full).isDirectory()) walk(full);
            else if (/^nassaj-preview-oid-event-control-\d{16}\.json$/.test(entry)) {
                found.push(JSON.parse(fs.readFileSync(full, 'utf8')).fullUpdateWaiter?.phase);
            }
        }
    };
    walk(path.join(appRoot, '.git'));
    return found.includes('waiting');
}

/** True while some process holds a lock on the gate's activity lock (the writer lease takes it shared). */
function activityLockHeld(appRoot) {
    const lock = path.join(appRoot, '.git', 'nassaj-source-update', 'activity.lock');
    if (!fs.existsSync(lock)) return false;
    const probe = execFileSync('bash', ['-c', `flock -n -x "${lock}" true && echo free || echo held`], { encoding: 'utf8' });
    return probe.trim() === 'held';
}

/** Updater dependencies whose every check call is recorded in `trace`. */
function spiedDeps(appRoot, trace, state) {
    const commandRunner = async (command, args, options = {}) => {
        const name = checkOf(command, args, options, state);
        if (name) trace.push(name);
        const joined = args.join(' ');
        if (command === process.execPath && args.includes('--plan')) {
            const plan = JSON.parse(fs.readFileSync(args.at(-1), 'utf8'));
            fs.writeFileSync(plan.outputs.manifest, JSON.stringify(candidateManifest(plan)), { mode: 0o600 });
            return response();
        }
        if (joined.includes('symbolic-ref')) return response('main\n');
        if (joined.includes('remote get-url')) return response('git@github.com:AlKindy-OSS/nassaj.git\n');
        if (joined.includes('worktree add --detach')) {
            fs.mkdirSync(args.at(-2), { recursive: true });
            return response();
        }
        if (joined.includes('/tag^{commit}')) return response(`${RELEASE}\n`);
        if (joined.includes('rev-parse --verify HEAD^{commit}')) {
            return response(`${options.cwd?.includes('/candidates/') ? RELEASE : ORIGINAL}\n`);
        }
        if (joined.includes('merge-base --is-ancestor') && joined.includes('/branch')) return response('');
        if (joined.endsWith(`--is-ancestor ${ORIGINAL} ${RELEASE}`)) return response('');
        if (joined.includes('merge-base --is-ancestor')) return response('', 1);
        if (joined.includes(':package.json')) return response(`{"name":"nassaj","version":"${VERSION}"}\n`);
        return response();
    };
    return {
        appRoot, commandRunner,
        activeSessionCount: () => { trace.push('sessions'); return 0; },
        statfs: () => { if (trace.at(-1) !== 'storage') trace.push('storage'); return { type: EXT4_MAGIC, bavail: 4_000_000, bsize: 4096 }; },
        exchangeProbe: () => {
            // The first effects the probe can observe: the waiter (absent at the
            // source plan, see below) and the writer lease, both held by now.
            if (waiterReserved(appRoot)) trace.push('waiter');
            if (activityLockHeld(appRoot)) trace.push('writer-lease');
            trace.push('exchange');
            return true;
        },
        sourcePlanner: () => {
            trace.push(waiterReserved(appRoot) ? 'source-plan-after-waiter' : 'source-plan');
            return { paths: 0 };
        },
        loadedRuntimeCommit: () => LOADED,
        queueRestartAction: async () => { state.queued = true; return true; },
    };
}

test('ADR-207 parity: the button path runs every check it ran before the split, once, in the defined order', async (t) => {
    const appRoot = fixture(t);
    const trace = [];
    const state = { queued: false, heads: 0 };
    const update = createSourceUpdater(spiedDeps(appRoot, trace, state));
    const result = await update(VERSION, {});
    assert.equal(result.success, true);
    assert.deepEqual(trace, BUTTON_PATH_CHECKS);
});

test('ADR-207 parity: the click-time facts in the sealed action come from the click, not the build', async (t) => {
    const appRoot = fixture(t);
    const state = { queued: false, heads: 0 };
    const update = createSourceUpdater(spiedDeps(appRoot, [], state));
    const result = await update(VERSION, {});
    const action = JSON.parse(fs.readFileSync(
        path.join(appRoot, '.git', 'nassaj-source-update', 'candidates', result.transactionId, 'activation-action.json'), 'utf8'));
    assert.equal(result.originalHead, ORIGINAL);
    assert.equal(action.originalHead, ORIGINAL);
});

test('ADR-207 §3.1: buildCandidate() alone runs no click-time check and reserves no waiter', async (t) => {
    const appRoot = fixture(t);
    const trace = [];
    const state = { queued: false, heads: 0 };
    const { createUpdaterDeps, createUpdateContext, createRunState, assertUpdateEntry, buildCandidate } = __test__;
    const deps = createUpdaterDeps({
        ...spiedDeps(appRoot, trace, state), env: process.env, remote: 'origin', branch: 'main',
        stat: fs.statSync, removeRestartAction: undefined,
    });
    const ctx = createUpdateContext(deps, VERSION, {});
    ctx.maintenance = assertUpdateEntry(ctx);
    ctx.run = createRunState();
    let built;
    try {
        built = await buildCandidate(ctx);
    } finally {
        ctx.run.writerLease?.release();
    }
    assert.deepEqual(trace, [
        'storage', 'remote', 'fetch', 'remote-recheck', 'tag', 'not-older', 'on-branch', 'version',
        'writer-lease', 'exchange', 'worktree-add', 'candidate-build', 'stage-head',
    ]);
    assert.deepEqual(trace.filter((step) => CLICK_TIME_CHECKS.has(step)), []);
    assert.equal(waiterReserved(appRoot), false);
    assert.equal(Object.hasOwn(built, 'originalHead'), false);
    assert.equal(Object.hasOwn(built, 'releasePaths'), false);
    assert.equal(built.releaseCommit, RELEASE);
});
