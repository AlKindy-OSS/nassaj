/**
 * T-2024 S1 (ADR-207 §6, qa M7): characterization of updateSource()'s failure
 * and abort matrix, written against the code BEFORE it was split into
 * buildCandidate() + sealAndQueue(). Every row pins the observable outcome:
 * the error code, which cleanup ran and through which runner (the fenced
 * `guarded` runner or the plain `discardPrivateCandidate`/`dropPrivateRefs`
 * one), what is left on disk, the restart-queue calls, the release waiter and
 * the B-1625 tracking-ref advance. The B-1585 flags (`sealHandedOff`,
 * `candidatePersisted`, `restartQueued`) are locals, so they are pinned through
 * the cleanup decisions they drive. The sweeps pin the exact count and order
 * of fence checks, lease renewals and commands: a split that adds, drops or
 * moves one fails here.
 */
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import test from 'node:test';

import { createSourceUpdateWorker } from './source-update-worker.js';
import { createSourceUpdater } from './source-updater.js';

const EXT4_MAGIC = 0xef53;
const ORIGINAL = 'a'.repeat(40);
const RELEASE = 'b'.repeat(40);
const VERSION = '1.42.0.1';

function response(stdout = '', code = 0) {
    return { code, signal: null, stdout, stderr: '' };
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-source-updater-char-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts', 'source-update-candidate.mjs'), '// fixture');
    return root;
}

function candidateManifest(plan, overrides = {}) {
    return {
        schemaVersion: 1, txId: plan.txId, releaseCommit: plan.releaseCommit, version: plan.version,
        serverBuildId: 'c'.repeat(64), clientBuildId: 'd'.repeat(64),
        sourceProvenance: { kind: 'git-worktree', commit: plan.releaseCommit, clean: true },
        artifacts: {
            client: { commit: plan.releaseCommit, buildId: 'd'.repeat(64) },
            server: { commit: plan.releaseCommit, buildId: 'c'.repeat(64) },
            nodeModules: { commit: plan.releaseCommit },
        },
        ...overrides,
    };
}

/** Name the command for the event log; null for reads that carry no decision. */
function label(command, args) {
    const joined = args.join(' ');
    if (command === process.execPath && args.includes('--plan')) return 'candidate';
    if (joined.includes(' fetch ')) return 'fetch';
    if (joined.includes('worktree add')) return 'worktree-add';
    if (joined.includes('worktree remove')) return 'worktree-remove';
    if (joined.includes('update-ref -d')) return 'drop-ref';
    if (joined.includes('update-ref -m')) return 'tracking-advance';
    return null;
}

/**
 * The governed fake of source-updater.test.js, plus knobs for each failure
 * point. `controller` is the worker's abort signal: an abort makes the fake
 * answer as runFile does after SIGKILL (code null), never a success.
 */
function fakeGit(events, {
    failOn = null, candidateCode = 0, onCandidate = null, stageHead = RELEASE, fastForward = true,
    headAfterQueue = null, abortAtCall = 0, controller = null, state = { queued: false },
} = {}) {
    const calls = [];
    const runner = async (command, args, options = {}) => {
        calls.push({ command, args, options });
        const name = label(command, args);
        if (name) events.push(`${name}:${Object.hasOwn(options, 'signal') ? 'guarded' : 'plain'}`);
        if (abortAtCall && calls.length === abortAtCall) {
            controller.abort(new Error('source_update_worker_fenced'));
            return { code: null, signal: 'SIGKILL', stdout: '', stderr: '' };
        }
        const joined = args.join(' ');
        if (failOn && command === 'git' && joined.includes(failOn)) return response('', 1);
        if (command === process.execPath && args.includes('--plan')) {
            if (candidateCode !== 0) return response('', candidateCode);
            const plan = JSON.parse(fs.readFileSync(args.at(-1), 'utf8'));
            fs.writeFileSync(plan.outputs.manifest, JSON.stringify(candidateManifest(plan)), { mode: 0o600 });
            onCandidate?.(plan);
            return response();
        }
        if (joined.includes('diff --raw') || joined.includes('diff --name-only')) return response('');
        if (joined.includes('status --porcelain')) return response('');
        if (joined.includes('symbolic-ref')) return response('main\n');
        if (joined.includes('remote get-url')) return response('git@github.com:AlKindy-OSS/nassaj.git\n');
        if (joined.includes('worktree add --detach')) {
            fs.mkdirSync(args.at(-2), { recursive: true });
            return response();
        }
        if (joined.includes('worktree remove --force')) {
            fs.rmSync(args.at(-1), { recursive: true, force: true });
            return response();
        }
        if (joined.includes('ls-tree')) return response(`100644 blob ${RELEASE}\tpackage.json\0`);
        if (joined.includes('/tag^{commit}')) return response(`${RELEASE}\n`);
        if (joined.includes('--quiet') && joined.includes('/branch^{commit}')) return response(`${RELEASE}\n`);
        if (joined.includes('--quiet refs/remotes/origin/main^{commit}')) return response(`${ORIGINAL}\n`);
        if (joined.includes('rev-parse --verify HEAD^{commit}')) {
            if (options.cwd?.includes('/candidates/')) return response(`${stageHead}\n`);
            return response(`${state.queued && headAfterQueue ? headAfterQueue : ORIGINAL}\n`);
        }
        if (joined.includes('merge-base --is-ancestor') && joined.includes('/branch')) return response('');
        if (joined.endsWith(`--is-ancestor ${ORIGINAL} ${RELEASE}`)) return response('', fastForward ? 0 : 1);
        if (joined.includes('merge-base --is-ancestor')) return response('', 1);
        if (joined.includes(`show ${RELEASE}:package.json`)) return response(`{"name":"nassaj","version":"${VERSION}"}\n`);
        return response();
    };
    return { calls, runner };
}

/** A lease on a fake clock; `loseAtRenew`/`loseAtFence` take it away at the Nth call. */
function fakeLease({ loseAtRenew = 0, loseAtFence = 0 } = {}) {
    const controller = new AbortController();
    const counts = { renew: 0, fence: 0 };
    let owned = true;
    const fenced = () => {
        controller.abort(new Error('source_update_worker_fenced'));
        return new Error('source_update_worker_fenced');
    };
    const assertFence = () => {
        counts.fence += 1;
        if (counts.fence === loseAtFence) owned = false;
        if (controller.signal.aborted || !owned) throw fenced();
        return true;
    };
    const renewLease = () => {
        counts.renew += 1;
        if (counts.renew === loseAtRenew) owned = false;
        if (controller.signal.aborted || !owned) throw fenced();
        return assertFence();
    };
    return { controller, counts, signal: controller.signal, assertFence, renewLease };
}

function listOrEmpty(directory) {
    return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

/** The release waiter's phase from the control events beside the git dir. */
function waiterPhase(appRoot) {
    const phases = [];
    const walk = (directory) => {
        for (const entry of listOrEmpty(directory)) {
            const full = path.join(directory, entry);
            if (fs.statSync(full).isDirectory()) walk(full);
            else if (/^nassaj-preview-oid-event-control-\d{16}\.json$/.test(entry)) {
                phases.push(JSON.parse(fs.readFileSync(full, 'utf8')).fullUpdateWaiter?.phase ?? 'none');
            }
        }
    };
    walk(path.join(appRoot, '.git'));
    return phases.join(',') || 'none';
}

/**
 * Run one updateSource() call and summarize what it left behind. Scenario
 * knobs go to fakeGit/fakeLease; `updater` and `identity` extend the
 * updater's dependencies and the jobIdentity.
 */
async function run(t, { git = {}, lease: leaseOptions = null, updater = {}, identity = {}, setup } = {}) {
    const appRoot = fixture(t);
    setup?.(appRoot);
    const events = [];
    const lease = leaseOptions ? fakeLease(leaseOptions) : null;
    const state = { queued: false };
    const fake = fakeGit(events, { ...git, controller: lease?.controller, state });
    const record = { queued: 0, removed: 0, beforeQueue: 0, settled: 0 };
    const update = createSourceUpdater({
        appRoot, activeSessionCount: () => 0, commandRunner: fake.runner,
        statfs: () => ({ type: EXT4_MAGIC, bavail: 4_000_000, bsize: 4096 }),
        exchangeProbe: () => true, sourcePlanner: () => ({ paths: 0 }),
        queueRestartAction: async () => { record.queued += 1; events.push('queue'); state.queued = true; return true; },
        removeRestartAction: async () => { record.removed += 1; events.push('remove-action'); },
        ...updater,
    });
    const jobIdentity = {
        ...(lease ? { signal: lease.signal, assertFence: lease.assertFence, renewLease: lease.renewLease } : {}),
        beforeQueue: () => { record.beforeQueue += 1; events.push('beforeQueue'); },
        settleLostLease: async () => { record.settled += 1; events.push('settle'); return 'failed'; },
        ...identity,
    };
    let outcome;
    try {
        outcome = { ok: true, value: await update(VERSION, jobIdentity) };
    } catch (error) {
        outcome = { ok: false, error };
    }
    const controlRoot = path.join(appRoot, '.git', 'nassaj-source-update');
    const summary = {
        result: outcome.ok ? 'success' : (outcome.error.code ?? outcome.error.message),
        events: events.join(' '),
        candidatesLeft: listOrEmpty(path.join(controlRoot, 'candidates')).length,
        plansLeft: listOrEmpty(controlRoot).filter((name) => name.startsWith('plan-')).length,
        waiter: waiterPhase(appRoot),
        ...record,
    };
    return { summary, outcome, fake, lease };
}

const FETCH = 'fetch:guarded';
const DROP_GUARDED = 'drop-ref:guarded drop-ref:guarded';
const BUILT = `${FETCH} worktree-add:guarded candidate:guarded`;

// ---------------------------------------------------------------------------
// Named failure points (M7 matrix rows).
// ---------------------------------------------------------------------------

const SCENARIOS = [
    ['success: queue, advance origin/main, then drop the private refs', {}, {
        result: 'success',
        events: `${BUILT} beforeQueue queue tracking-advance:guarded ${DROP_GUARDED}`,
        candidatesLeft: 1, plansLeft: 1, waiter: 'waiting', queued: 1, removed: 0, beforeQueue: 1, settled: 0,
    }],
    ['fetch fails: nothing staged, no refs to drop, no waiter', { git: { failOn: ' fetch ' } }, {
        result: 'release_fetch_failed', events: FETCH,
        candidatesLeft: 0, plansLeft: 0, waiter: 'none', queued: 0, removed: 0, beforeQueue: 0, settled: 0,
    }],
    ['preflight fails before fetch (dirty tracked tree probe fails)', { git: { failOn: '--untracked-files=no' } }, {
        result: 'git_status_failed', events: '',
        candidatesLeft: 0, plansLeft: 0, waiter: 'none', queued: 0, removed: 0, beforeQueue: 0, settled: 0,
    }],
    ['preflight fails after fetch (source plan conflict): refs dropped, no waiter', {
        updater: { sourcePlanner: () => { throw new Error('Source activation path blocked'); } },
    }, {
        result: 'source_plan_conflict', events: `${FETCH} ${DROP_GUARDED}`,
        candidatesLeft: 0, plansLeft: 0, waiter: 'none', queued: 0, removed: 0, beforeQueue: 0, settled: 0,
    }],
    ['non_fast_forward: refused after fetch, refs dropped', { git: { fastForward: false } }, {
        result: 'non_fast_forward', events: `${FETCH} ${DROP_GUARDED}`,
        candidatesLeft: 0, plansLeft: 0, waiter: 'none', queued: 0, removed: 0, beforeQueue: 0, settled: 0,
    }],
    ['host capability refused after the waiter is reserved: waiter released', {
        updater: { exchangeProbe: () => false },
    }, {
        result: 'exchange_capability', events: `${FETCH} ${DROP_GUARDED}`,
        candidatesLeft: 0, plansLeft: 0, waiter: 'released', queued: 0, removed: 0, beforeQueue: 0, settled: 0,
    }],
    ['worktree add fails: candidate dir removed', { git: { failOn: 'worktree add' } }, {
        result: 'candidate_checkout_failed',
        events: `${FETCH} worktree-add:guarded worktree-remove:guarded ${DROP_GUARDED}`,
        candidatesLeft: 0, plansLeft: 0, waiter: 'released', queued: 0, removed: 0, beforeQueue: 0, settled: 0,
    }],
    ['candidate build fails: guarded worktree removal, dir and plan removed', { git: { candidateCode: 1 } }, {
        result: 'candidate_build_failed', events: `${BUILT} worktree-remove:guarded ${DROP_GUARDED}`,
        candidatesLeft: 0, plansLeft: 0, waiter: 'released', queued: 0, removed: 0, beforeQueue: 0, settled: 0,
    }],
    ['verify fails: staged HEAD is not the release', { git: { stageHead: 'e'.repeat(40) } }, {
        result: 'candidate_identity_mismatch', events: `${BUILT} worktree-remove:guarded ${DROP_GUARDED}`,
        candidatesLeft: 0, plansLeft: 0, waiter: 'released', queued: 0, removed: 0, beforeQueue: 0, settled: 0,
    }],
    ['verify fails: candidate manifest invalid', {
        git: { onCandidate: (plan) => fs.writeFileSync(plan.outputs.manifest,
            JSON.stringify(candidateManifest(plan, { serverBuildId: 'short' }))) },
    }, {
        result: 'candidate_manifest_invalid', events: `${BUILT} worktree-remove:guarded ${DROP_GUARDED}`,
        candidatesLeft: 0, plansLeft: 0, waiter: 'released', queued: 0, removed: 0, beforeQueue: 0, settled: 0,
    }],
    ['client publication fails on the candidate client generation', {
        git: { onCandidate: (plan) => {
            fs.mkdirSync(plan.outputs.client, { recursive: true });
            fs.writeFileSync(path.join(plan.outputs.client, 'CLIENT_ASSET_MANIFEST.json'), '{"schema":"bad"}');
        } },
    }, {
        result: 'client_asset_manifest_invalid', events: `${BUILT} worktree-remove:guarded ${DROP_GUARDED}`,
        candidatesLeft: 0, plansLeft: 0, waiter: 'released', queued: 0, removed: 0, beforeQueue: 0, settled: 0,
    }],
    ['client publication fails on the live dist generation', {
        setup: (appRoot) => {
            fs.mkdirSync(path.join(appRoot, 'dist'));
            fs.writeFileSync(path.join(appRoot, 'dist', 'CLIENT_ASSET_MANIFEST.json'), '{"schema":"bad"}');
        },
        git: { onCandidate: (plan) => {
            fs.mkdirSync(plan.outputs.client, { recursive: true });
            fs.writeFileSync(path.join(plan.outputs.client, 'CLIENT_ASSET_MANIFEST.json'), '{}');
        } },
    }, {
        result: 'client_asset_manifest_invalid', events: `${BUILT} worktree-remove:guarded ${DROP_GUARDED}`,
        candidatesLeft: 0, plansLeft: 0, waiter: 'released', queued: 0, removed: 0, beforeQueue: 0, settled: 0,
    }],
    ['restart queue unavailable: refused before the seal', { updater: { queueRestartAction: null } }, {
        result: 'restart_queue_unavailable', events: `${BUILT} worktree-remove:guarded ${DROP_GUARDED}`,
        candidatesLeft: 0, plansLeft: 0, waiter: 'released', queued: 0, removed: 0, beforeQueue: 0, settled: 0,
    }],
    ['seal fails: the activation action file cannot be created', {
        git: { onCandidate: (plan) => fs.writeFileSync(path.join(plan.candidateRoot, 'activation-action.json'), '{}') },
    }, {
        result: 'EEXIST', events: `${BUILT} worktree-remove:guarded ${DROP_GUARDED}`,
        candidatesLeft: 0, plansLeft: 0, waiter: 'released', queued: 0, removed: 0, beforeQueue: 0, settled: 0,
    }],
    ['beforeQueue fails after the seal hand-off: not aborted, so the candidate is removed', {
        identity: { beforeQueue: () => { throw Object.assign(new Error('seal refused'), { code: 'seal_refused' }); } },
    }, {
        result: 'seal_refused', events: `${BUILT} worktree-remove:guarded ${DROP_GUARDED}`,
        candidatesLeft: 0, plansLeft: 0, waiter: 'released', queued: 0, removed: 0, beforeQueue: 0, settled: 0,
    }],
    ['restart queue refuses: restart_queue_failed, candidate removed', {
        updater: { queueRestartAction: async () => false },
    }, {
        result: 'restart_queue_failed', events: `${BUILT} beforeQueue worktree-remove:guarded ${DROP_GUARDED}`,
        candidatesLeft: 0, plansLeft: 0, waiter: 'released', queued: 0, removed: 0, beforeQueue: 1, settled: 0,
    }],
    ['live source moved after queueing: action removed, candidate removed, waiter kept', {
        git: { headAfterQueue: 'f'.repeat(40) },
    }, {
        result: 'source_changed',
        events: `${BUILT} beforeQueue queue remove-action worktree-remove:guarded ${DROP_GUARDED}`,
        candidatesLeft: 0, plansLeft: 0, waiter: 'waiting', queued: 1, removed: 1, beforeQueue: 1, settled: 0,
    }],
];

// ---------------------------------------------------------------------------
// qa A3: deferrable refusals after the waiter is reserved keep the waiter.
// The refusal is raised at the first step after the reservation (the host
// probe, right after the writer lease); releaseWaiterOnFailure reads only the
// error code, so the point of failure inside the build does not matter.
// ---------------------------------------------------------------------------

const refuseWith = (error) => ({ updater: { exchangeProbe: () => { throw error; } } });
const coded = (code) => Object.assign(new Error(code), { code });

for (const code of ['resource_ceiling', 'insufficient_disk', 'update_lock_contended']) {
    SCENARIOS.push([`${code} after the waiter is reserved: the waiter is NOT failed`, refuseWith(coded(code)), {
        result: code, events: `${FETCH} ${DROP_GUARDED}`,
        candidatesLeft: 0, plansLeft: 0, waiter: 'waiting', queued: 0, removed: 0, beforeQueue: 0, settled: 0,
    }]);
}
SCENARIOS.push(['a non-deferrable code after the waiter is reserved: the waiter is failed',
    refuseWith(coded('activation_filesystem_mismatch')), {
        result: 'activation_filesystem_mismatch', events: `${FETCH} ${DROP_GUARDED}`,
        candidatesLeft: 0, plansLeft: 0, waiter: 'released', queued: 0, removed: 0, beforeQueue: 0, settled: 0,
    }]);
// Pinned as found: the gate's flockAsync rejects with a plain Error whose
// MESSAGE is update_lock_contended and which has no `code`, and the exclusion
// list matches `error.code` only, so a real writer-lease contention fails the
// waiter (the worker then fails the job with that message as its code).
SCENARIOS.push(['a code-less update_lock_contended (the gate\'s real flock error) fails the waiter',
    refuseWith(new Error('update_lock_contended')), {
        result: 'update_lock_contended', events: `${FETCH} ${DROP_GUARDED}`,
        candidatesLeft: 0, plansLeft: 0, waiter: 'released', queued: 0, removed: 0, beforeQueue: 0, settled: 0,
    }]);

for (const [name, scenario, expected] of SCENARIOS) {
    test(`T-2024 S1 characterization: ${name}`, async (t) => {
        const { summary } = await run(t, scenario);
        assert.deepEqual(summary, expected);
    });
}

test('T-2024 S1 characterization: the success result keeps its exact shape', async (t) => {
    const { outcome } = await run(t, { updater: { loadedRuntimeCommit: () => 'c'.repeat(40) } });
    assert.equal(outcome.ok, true);
    const { value } = outcome;
    assert.deepEqual(Object.keys(value), [
        'success', 'version', 'commit', 'restartRequired', 'restartActionQueued', 'transactionId',
        'candidateManifestSha256', 'expectedServerBuildId', 'expectedClientBuildId',
        'activationIdentitySha256', 'originalHead', 'previousRuntimeOid',
    ]);
    assert.equal(value.commit, RELEASE);
    assert.equal(value.originalHead, ORIGINAL);
    assert.equal(value.previousRuntimeOid, 'c'.repeat(40));
    assert.match(value.transactionId, /^update-\d+-\d+-[0-9a-f]+$/);
});

test('T-2024 S1 characterization: beforeQueue receives the sealed identity before the queue', async (t) => {
    const seen = [];
    const queuedWith = [];
    const { outcome } = await run(t, {
        identity: { beforeQueue: (facts) => seen.push(facts) },
        updater: { queueRestartAction: async (action) => { queuedWith.push(action); return true; } },
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(Object.keys(seen[0]), ['transaction_id', 'release_commit', 'expected_server_build_id',
        'expected_client_build_id', 'activation_identity_sha256', 'source_tree_sha256']);
    assert.equal(seen[0].transaction_id, outcome.value.transactionId);
    assert.equal(seen[0].activation_identity_sha256, outcome.value.activationIdentitySha256);
    assert.deepEqual(Object.keys(queuedWith[0]), ['transactionId', 'expectedServerBuildId', 'sourceUpdateJobId',
        'activationIdentitySha256', 'releaseCommit', 'reason']);
    assert.equal(queuedWith[0].transactionId, outcome.value.transactionId);
});

// ---------------------------------------------------------------------------
// Sweeps: lease lost at each renewal, at each fence check, abort at each command.
// ---------------------------------------------------------------------------

/** Compact row: result | events | candidates/plans left | waiter | queued/removed/beforeQueue/settled. */
const row = (s) => [s.result, s.events, `${s.candidatesLeft}/${s.plansLeft}`, s.waiter,
    `${s.queued}/${s.removed}/${s.beforeQueue}/${s.settled}`].join(' | ');

const HAPPY_COUNTS = { renew: 6, fence: 42, commands: 25 };

test('T-2024 S1 characterization: a happy run has an exact count of renewals, fence checks and commands', async (t) => {
    const { summary, lease, fake } = await run(t, { lease: {} });
    assert.equal(summary.result, 'success');
    assert.deepEqual({ ...lease.counts, commands: fake.calls.length }, HAPPY_COUNTS);
});

/** Golden rows, one per index; regenerate with CHAR_PRINT=1 only for an intended behaviour change. */
async function sweep(t, count, scenarioAt, describe = () => '') {
    const rows = [];
    for (let index = 1; index <= count; index += 1) {
        const outcome = await run(t, scenarioAt(index));
        rows.push(`${index} ${describe(outcome, index)}=> ${row(outcome.summary)}`);
    }
    if (process.env.CHAR_PRINT) console.log(JSON.stringify(rows, null, 1));
    return rows;
}

// 1-2 around the source planner: before the waiter, so only the private refs go
// (plain runner). 3-6 after the candidate build: the never-sealed candidate is
// discarded by the plain runner and the waiter is released via settleLostLease.
const RENEW_SWEEP = [
    "1 => source_update_worker_fenced | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "2 => source_update_worker_fenced | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "3 => source_update_worker_fenced | fetch:guarded worktree-add:guarded candidate:guarded worktree-remove:plain settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "4 => source_update_worker_fenced | fetch:guarded worktree-add:guarded candidate:guarded worktree-remove:plain settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "5 => source_update_worker_fenced | fetch:guarded worktree-add:guarded candidate:guarded worktree-remove:plain settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "6 => source_update_worker_fenced | fetch:guarded worktree-add:guarded candidate:guarded worktree-remove:plain settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
];

test('T-2024 S1 characterization: lease lost at each renewLease', async (t) => {
    assert.deepEqual(await sweep(t, HAPPY_COUNTS.renew, (index) => ({ lease: { loseAtRenew: index } })), RENEW_SWEEP);
});

// 1-5 before the fetch; 6-17 after it, before the waiter (refs only); 18-30 the
// waiter is reserved and nothing is sealed (discard + settle; 21 leaves the
// empty candidates/<tx> dir, a pre-existing leak); 31-35 after the seal hand-off
// (beforeQueue) the candidate and waiter stay with the activation path; 36-39
// inside the best-effort tracking-ref advance: still a success; 40-42 inside the
// finally block, where a lost fence skips the remaining private-ref drops.
const FENCE_SWEEP = [
    "1 => source_update_worker_fenced |  | 0/0 | none | 0/0/0/0",
    "2 => source_update_worker_fenced |  | 0/0 | none | 0/0/0/0",
    "3 => source_update_worker_fenced |  | 0/0 | none | 0/0/0/0",
    "4 => source_update_worker_fenced |  | 0/0 | none | 0/0/0/0",
    "5 => source_update_worker_fenced |  | 0/0 | none | 0/0/0/0",
    "6 => source_update_worker_fenced | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "7 => source_update_worker_fenced | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "8 => source_update_worker_fenced | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "9 => source_update_worker_fenced | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "10 => source_update_worker_fenced | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "11 => source_update_worker_fenced | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "12 => source_update_worker_fenced | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "13 => source_update_worker_fenced | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "14 => source_update_worker_fenced | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "15 => source_update_worker_fenced | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "16 => source_update_worker_fenced | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "17 => source_update_worker_fenced | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "18 => source_update_worker_fenced | fetch:guarded settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "19 => source_update_worker_fenced | fetch:guarded settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "20 => source_update_worker_fenced | fetch:guarded settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "21 => source_update_worker_fenced | fetch:guarded settle drop-ref:plain drop-ref:plain | 1/0 | released | 0/0/0/1",
    "22 => source_update_worker_fenced | fetch:guarded worktree-remove:plain settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "23 => source_update_worker_fenced | fetch:guarded worktree-add:guarded worktree-remove:plain settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "24 => source_update_worker_fenced | fetch:guarded worktree-add:guarded worktree-remove:plain settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "25 => source_update_worker_fenced | fetch:guarded worktree-add:guarded worktree-remove:plain settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "26 => source_update_worker_fenced | fetch:guarded worktree-add:guarded candidate:guarded worktree-remove:plain settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "27 => source_update_worker_fenced | fetch:guarded worktree-add:guarded candidate:guarded worktree-remove:plain settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "28 => source_update_worker_fenced | fetch:guarded worktree-add:guarded candidate:guarded worktree-remove:plain settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "29 => source_update_worker_fenced | fetch:guarded worktree-add:guarded candidate:guarded worktree-remove:plain settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "30 => source_update_worker_fenced | fetch:guarded worktree-add:guarded candidate:guarded worktree-remove:plain settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "31 => source_update_worker_fenced | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue drop-ref:plain drop-ref:plain | 1/1 | waiting | 0/0/1/0",
    "32 => source_update_worker_fenced | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue drop-ref:plain drop-ref:plain | 1/1 | waiting | 0/0/1/0",
    "33 => source_update_worker_fenced | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue drop-ref:plain drop-ref:plain | 1/1 | waiting | 1/0/1/0",
    "34 => source_update_worker_fenced | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue drop-ref:plain drop-ref:plain | 1/1 | waiting | 1/0/1/0",
    "35 => source_update_worker_fenced | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue drop-ref:plain drop-ref:plain | 1/1 | waiting | 1/0/1/0",
    "36 => success | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue drop-ref:plain drop-ref:plain | 1/1 | waiting | 1/0/1/0",
    "37 => success | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue drop-ref:plain drop-ref:plain | 1/1 | waiting | 1/0/1/0",
    "38 => success | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue drop-ref:plain drop-ref:plain | 1/1 | waiting | 1/0/1/0",
    "39 => success | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue drop-ref:plain drop-ref:plain | 1/1 | waiting | 1/0/1/0",
    "40 => success | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue tracking-advance:guarded | 1/1 | waiting | 1/0/1/0",
    "41 => success | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue tracking-advance:guarded | 1/1 | waiting | 1/0/1/0",
    "42 => success | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue tracking-advance:guarded drop-ref:guarded | 1/1 | waiting | 1/0/1/0",
];

test('T-2024 S1 characterization: lease lost at each fence check', async (t) => {
    assert.deepEqual(await sweep(t, HAPPY_COUNTS.fence, (index) => ({ lease: { loseAtFence: index } })), FENCE_SWEEP);
});

// The fake answers an aborted command as runFile does after SIGKILL (code null).
// 9-10 (qa A1): the tag's package version is release identity, checked inside
// the HEAD-independent identity step, so it now runs before the click-time
// fast-forward check; same refusal outcome, same command count. 18-19: the restart is queued, so an abort keeps the action and the candidate.
const ABORT_SWEEP = [
    "1 status --porcelain=v1 => git_status_failed |  | 0/0 | none | 0/0/0/0",
    "2 symbolic-ref --quiet => detached_head |  | 0/0 | none | 0/0/0/0",
    "3 rev-parse --verify => head_unavailable |  | 0/0 | none | 0/0/0/0",
    "4 remote get-url => remote_unavailable |  | 0/0 | none | 0/0/0/0",
    "5 fetch => release_fetch_failed | fetch:guarded | 0/0 | none | 0/0/0/0",
    "6 remote get-url => remote_unavailable | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "7 rev-parse --verify => tag_mismatch | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "8 merge-base --is-ancestor => tag_mismatch | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "9 show <sha>:package.json => release_manifest_unavailable | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "10 merge-base --is-ancestor => non_fast_forward | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "11 diff --name-only => release_diff_failed | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "12 diff --raw => release_diff_failed | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "13 rev-parse --verify => head_unavailable | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "14 status --porcelain=v1 => git_status_failed | fetch:guarded drop-ref:plain drop-ref:plain | 0/0 | none | 0/0/0/0",
    "15 worktree-add => candidate_checkout_failed | fetch:guarded worktree-add:guarded worktree-remove:plain settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "16 candidate => candidate_build_failed | fetch:guarded worktree-add:guarded candidate:guarded worktree-remove:plain settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "17 HEAD^{commit} => candidate_identity_mismatch | fetch:guarded worktree-add:guarded candidate:guarded worktree-remove:plain settle drop-ref:plain drop-ref:plain | 0/0 | released | 0/0/0/1",
    "18 rev-parse --verify => head_unavailable | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue drop-ref:plain drop-ref:plain | 1/1 | waiting | 1/0/1/0",
    "19 status --porcelain=v1 => git_status_failed | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue drop-ref:plain drop-ref:plain | 1/1 | waiting | 1/0/1/0",
    "20 rev-parse --verify => success | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue drop-ref:plain drop-ref:plain | 1/1 | waiting | 1/0/1/0",
    "21 rev-parse --verify => success | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue drop-ref:plain drop-ref:plain | 1/1 | waiting | 1/0/1/0",
    "22 merge-base --is-ancestor => success | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue drop-ref:plain drop-ref:plain | 1/1 | waiting | 1/0/1/0",
    "23 tracking-advance => success | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue tracking-advance:guarded drop-ref:plain drop-ref:plain | 1/1 | waiting | 1/0/1/0",
    "24 drop-ref => success | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue tracking-advance:guarded drop-ref:guarded | 1/1 | waiting | 1/0/1/0",
    "25 drop-ref => success | fetch:guarded worktree-add:guarded candidate:guarded beforeQueue queue tracking-advance:guarded drop-ref:guarded drop-ref:guarded | 1/1 | waiting | 1/0/1/0",
];

test('T-2024 S1 characterization: abort signal during each command', async (t) => {
    const describe = ({ fake }, index) => {
        const { command, args } = fake.calls[index - 1];
        return `${label(command, args) ?? args.slice(2, 4).join(' ').replace(/[0-9a-f]{40}/g, '<sha>')} `;
    };
    const rows = await sweep(t, HAPPY_COUNTS.commands,
        (index) => ({ lease: {}, git: { abortAtCall: index } }), describe);
    assert.deepEqual(rows, ABORT_SWEEP);
});

// ---------------------------------------------------------------------------
// T-2024 S0 ordering: the real worker over the real updater.
// ---------------------------------------------------------------------------

/** A one-job store that logs every transition and the lease release. */
function loggingJobStore(events) {
    const job = {
        id: 'job-char', state: 'staging', worker_fence: 3, expected_version: VERSION, strategy: 'git-checkout-v2',
        release_id: '1', release_tag: `v${VERSION}`, release_asset_id: '1', release_asset_name: 'source',
        release_asset_size: 1, release_asset_sha256: 'e'.repeat(64), release_commit: RELEASE, auto_activate: 1,
    };
    let claimable = true;
    return {
        job,
        claim() { if (!claimable) return null; claimable = false; return { ...job }; },
        renew: () => true, assertFence: () => true,
        release: () => { events.push('release'); return true; },
        listRuntimeReferences: () => [], listReceipts: () => [],
        appendReceipt: (_id, fence) => ({ sequence: 1, factsJson: '{}', factsSha256: 'f'.repeat(64), workerFence: fence }),
        transition(_id, _fence, expected, next, fields = {}) {
            if (!expected.includes(job.state)) return false;
            if (job.state !== next) events.push(`state:${next}`);
            job.state = next; Object.assign(job, fields); return true;
        },
    };
}

async function runWorker(t, git = {}) {
    const appRoot = fixture(t);
    const events = [];
    const fake = fakeGit(events, git);
    const update = createSourceUpdater({
        appRoot, activeSessionCount: () => 0, commandRunner: fake.runner,
        statfs: () => ({ type: EXT4_MAGIC, bavail: 4_000_000, bsize: 4096 }),
        exchangeProbe: () => true, sourcePlanner: () => ({ paths: 0 }),
        queueRestartAction: async () => { events.push('queue'); return true; },
    });
    const jobs = loggingJobStore(events);
    const worker = createSourceUpdateWorker({
        jobs, identity: { workerId: 'w', pid: 1, startTicks: '1', bootId: 'b', pgid: 1 },
        resolveRelease: async () => { throw new Error('must not resolve'); },
        runUpdate: (job, _release, context) => update(job.expected_version, {
            signal: context.signal, assertFence: context.assertFence, renewLease: context.renewLease,
            settleLostLease: context.settleLostLease, beforeQueue: context.beforeQueue,
        }),
        afterRestartQueued: (input) => events.push(`afterRestartQueued:${input.jobId}:${input.autoActivate}`),
    });
    const processed = await worker.processOne();
    return { processed, state: jobs.job.state, events: events.join(' ') };
}

test('T-2024 S1 characterization: seal, queue, advance, drop, restart_queued, release, then the S0 wake', async (t) => {
    assert.deepEqual(await runWorker(t), {
        processed: true, state: 'restart_queued',
        events: `${BUILT} state:candidate_sealed queue tracking-advance:guarded ${DROP_GUARDED}`
            + ' state:restart_queued release afterRestartQueued:job-char:true',
    });
});

test('T-2024 S1 characterization: a failed build fails the job and never wakes the activator', async (t) => {
    assert.deepEqual(await runWorker(t, { candidateCode: 1 }), {
        processed: false, state: 'failed',
        events: `${BUILT} worktree-remove:guarded ${DROP_GUARDED} state:failed release`,
    });
});
