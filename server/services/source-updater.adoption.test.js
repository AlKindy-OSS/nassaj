/**
 * T-2024 S4 (ADR-207 §3.4, §3.5, §3.10): adoption of a prestaged candidate
 * at click. A real slot, a real candidate laid out on disk (plan, 0600
 * manifest, three trees hashed by the real child hasher), a real prestager
 * port and a spied command runner. Covers: the happy path (no build command,
 * the slot's transaction sealed), every rejection falling back to a normal
 * build after the discard finished (qa a), a sealAndQueue failure after the
 * adoption (cleanup by removeFailedCandidate), an abort after the CAS and the
 * recovery of the adopted marker, the check-order parity (qa d), the legacy
 * transition gate in the prestage builder (qa c) and the off-loop hashing.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { hashTree } from '../../scripts/lib/source-update-tree-identity.mjs';
import { tryAcquireBuildMutex } from './source-update-build-mutex.js';
import { __test__, createPrestageCandidateBuilder, createSourceUpdater, runFile } from './source-updater.js';
import { PRESTAGE_BUILD_MUTEX_KIND, createPrestageSlot, newPrestageTransactionId } from './update-prestage-slot.js';
import { createUpdatePrestager } from './update-prestager.js';

const EXT4_MAGIC = 0xef53;
const ORIGINAL = 'a'.repeat(40);
const RELEASE = 'b'.repeat(40);
const LOADED = 'c'.repeat(40);
const LOCK_BLOB = 'f'.repeat(40);
const VERSION = '1.42.0.1';
const JOB = 'job-1';
const H = (c) => c.repeat(64);
const { TREE_HASHER } = __test__;
const response = (stdout = '', code = 0) => ({ code, signal: null, stdout, stderr: '' });

/**
 * The button path's golden (source-updater.check-parity.test.js, BUTTON_PATH_CHECKS),
 * copied here so the adopted path is compared against the same order.
 */
const BUTTON_PATH_CHECKS = [
    'storage', 'sessions', 'tracked-clean', 'branch', 'head', 'remote',
    'fetch', 'remote-recheck', 'tag', 'not-older', 'on-branch', 'version',
    'fast-forward', 'release-paths', 'gitlinks', 'overlay',
    'sessions', 'head-recheck', 'scoped-clean', 'source-plan', 'waiter',
    'writer-lease', 'exchange', 'worktree-add', 'candidate-build', 'stage-head',
    'live-head', 'live-status',
];
/** The steps only a build runs, and the steps only an adoption runs (§3.5 steps 1–4). */
const BUILD_ONLY = new Set(['worktree-add', 'candidate-build', 'stage-head']);
const ADOPTION_ONLY = new Set(['identity-lockfile', 'stage-head', 'stage-status', 'tree-hash']);

function fixture(t) {
    const appRoot = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-source-updater-adopt-'));
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: appRoot });
    fs.mkdirSync(path.join(appRoot, 'scripts'));
    fs.writeFileSync(path.join(appRoot, 'scripts', 'source-update-candidate.mjs'), '// fixture');
    fs.mkdirSync(path.join(appRoot, 'config'));
    fs.writeFileSync(path.join(appRoot, 'config', 'node-overlay.json'),
        JSON.stringify({ schema: 1, static: [{ mount: '/hub', dir: 'static/hub' }] }));
    const controlRoot = path.join(appRoot, '.git', 'nassaj-source-update');
    const slot = createPrestageSlot({ appRoot, controlRoot, lockWaitMs: 2_000 });
    const prestager = createUpdatePrestager({
        appRoot, slot, buildPrestage: null, env: {}, logger: { info() {} },
        discoverRelease: async () => ({ release: { version: VERSION, tagName: `v${VERSION}`, commit: RELEASE } }),
        readRuntime: () => ({ updateMode: 'release', isPlatform: false, hostReady: true, jobStrategy: 'git-checkout-v2' }),
        hasActiveJob: () => true, listJobReferences: () => [], lookupJob: () => null, readJournal: () => null,
        sampleResources: async () => ({ cpuPercent: 0, memoryPercent: 0 }), readMemAvailable: () => 0, readFreeDisk: () => 0,
    });
    const state = {
        trace: [], calls: [], queued: false, heads: 0, receipts: [], npmVersion: '11.0.0', queueResult: true,
        onHash: null, onBuild: null, abort: new AbortController(), fenced: false,
    };
    return { appRoot, controlRoot, slot, prestager, state };
}

/** Name the check a command performs (the parity file's names plus the adoption steps). */
function checkOf(command, args, options, state) {
    const joined = args.join(' ');
    const inCandidate = options.cwd?.includes('/candidates/');
    if (command === process.execPath && args[0] === TREE_HASHER) return 'tree-hash';
    if (command === process.execPath && args.includes('--plan')) return 'candidate-build';
    if (inCandidate && joined.includes('status --porcelain')) return 'stage-status';
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
    if (joined.includes(':package-lock.json')) return 'identity-lockfile';
    if (joined.includes(':package.json')) return 'version';
    if (joined.includes('diff --name-only')) return 'release-paths';
    if (joined.includes('diff --raw')) return 'gitlinks';
    if (joined.includes('ls-tree')) return 'overlay';
    if (joined.includes('worktree add')) return 'worktree-add';
    if (joined.includes('rev-parse --verify HEAD^{commit}')) {
        if (inCandidate) return 'stage-head';
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

function activityLockHeld(appRoot) {
    const lock = path.join(appRoot, '.git', 'nassaj-source-update', 'activity.lock');
    if (!fs.existsSync(lock)) return false;
    return execFileSync('bash', ['-c', `flock -n -x "${lock}" true && echo free || echo held`], { encoding: 'utf8' }).trim() === 'held';
}

function candidateManifest(plan, trees = undefined) {
    return {
        schemaVersion: 1, txId: plan.txId, releaseCommit: plan.releaseCommit, version: plan.version,
        serverBuildId: H('c'), clientBuildId: H('d'),
        sourceProvenance: { kind: 'git-worktree', commit: plan.releaseCommit, clean: true },
        artifacts: { client: { commit: plan.releaseCommit, buildId: H('d') },
            server: { commit: plan.releaseCommit, buildId: H('c') }, nodeModules: { commit: plan.releaseCommit } },
        ...(trees ? { trees } : {}),
    };
}

/** The spied runner: answers the button path and runs the real tree hasher in a real child. */
function commandRunner(env) {
    const { state } = env;
    return async (command, args, options = {}) => {
        // A durable job registers every command as an effect (the launcher's job in production).
        options.onSpawn?.({ pid: process.pid, pgid: process.pid, startTicks: '1', bootId: 'boot' });
        const name = checkOf(command, args, options, state);
        if (name) state.trace.push(name);
        state.calls.push({ command, args, cwd: options.cwd });
        const joined = args.join(' ');
        if (name === 'tree-hash') {
            if (state.onHash) await state.onHash();
            return runFile(command, args, { cwd: options.cwd, env: options.env });
        }
        if (name === 'candidate-build') {
            state.onBuild?.();
            const plan = JSON.parse(fs.readFileSync(args.at(-1), 'utf8'));
            fs.writeFileSync(plan.outputs.manifest, JSON.stringify(candidateManifest(plan)), { mode: 0o600 });
            return response();
        }
        if (name === 'worktree-add') {
            state.onBuild?.();
            fs.mkdirSync(args.at(-2), { recursive: true });
            return response();
        }
        if (name === 'stage-status') return response('');
        if (joined.includes('symbolic-ref')) return response('main\n');
        if (joined.includes('remote get-url')) return response('git@github.com:AlKindy-OSS/nassaj.git\n');
        if (joined.includes('/tag^{commit}')) return response(`${RELEASE}\n`);
        if (joined.includes('rev-parse --verify HEAD^{commit}')) return response(`${options.cwd?.includes('/candidates/') ? RELEASE : ORIGINAL}\n`);
        if (joined.includes(':package-lock.json')) return response(`${LOCK_BLOB}\n`);
        if (joined.includes('merge-base --is-ancestor') && joined.includes('/branch')) return response('');
        if (joined.endsWith(`--is-ancestor ${ORIGINAL} ${RELEASE}`)) return response('');
        if (joined.includes('merge-base --is-ancestor')) return response('', 1);
        if (joined.includes(':package.json')) return response(`{"name":"nassaj","version":"${VERSION}"}\n`);
        return response();
    };
}

function updaterDeps(env) {
    const { appRoot, state } = env;
    return {
        appRoot, commandRunner: commandRunner(env), env: { PATH: process.env.PATH },
        activeSessionCount: () => { state.trace.push('sessions'); return 0; },
        statfs: () => { if (state.trace.at(-1) !== 'storage') state.trace.push('storage'); return { type: EXT4_MAGIC, bavail: 4_000_000, bsize: 4096 }; },
        exchangeProbe: () => {
            if (waiterReserved(appRoot)) state.trace.push('waiter');
            if (activityLockHeld(appRoot)) state.trace.push('writer-lease');
            state.trace.push('exchange');
            return true;
        },
        sourcePlanner: () => { state.trace.push('source-plan'); return { paths: 0 }; },
        loadedRuntimeCommit: () => LOADED,
        queueRestartAction: async () => { state.queued = true; return state.queueResult; },
        removeRestartAction: async () => true,
        prestageAdoption: () => env.prestager.adoptionPort(),
        builderBuildId: () => H('e'),
        probeRuntime: async () => ({ version: 'v24.0.0', modules: '137', napi: '10', platform: 'linux', arch: 'x64',
            binary: { realpath: '/usr/bin/node', dev: 1, ino: 2, size: 3, mtimeMs: 4 } }),
        probeNpm: async () => ({ realpath: '/usr/bin/npm', version: state.npmVersion }),
    };
}

function jobIdentity(env, extra = {}) {
    return {
        jobId: JOB, signal: env.state.abort.signal, registerEffect: () => {}, completeEffect: async () => {},
        assertFence: () => { if (env.state.fenced) throw new Error('source_update_worker_fenced'); return true; },
        receipt: (phase, kind, facts) => env.state.receipts.push({ phase, kind, facts }), ...extra,
    };
}

/** The identity key a build by these dependencies records, computed by the updater's own code. */
async function prestageIdentity(env) {
    const { createUpdaterDeps, createUpdateContext } = __test__;
    const deps = createUpdaterDeps({ ...updaterDeps(env), remote: 'origin', branch: 'main', stat: fs.statSync });
    const ctx = createUpdateContext(deps, VERSION, {});
    return __test__.collectPrestageIdentity(ctx, { releaseCommit: RELEASE, builderBuildId: H('e') });
}

/** Lay out a built prestage candidate and record it `ready` in the slot, as the prestager does. */
async function readySlot(env, { version = VERSION, files = 40 } = {}) {
    const transactionId = newPrestageTransactionId();
    const candidateRoot = path.join(env.controlRoot, 'candidates', transactionId);
    const outputs = {
        client: path.join(candidateRoot, 'client'), server: path.join(candidateRoot, 'server'),
        nodeModules: path.join(candidateRoot, 'node_modules'), manifest: path.join(candidateRoot, 'candidate-manifest.json'),
    };
    fs.mkdirSync(path.join(candidateRoot, 'source'), { recursive: true, mode: 0o700 });
    for (const name of ['client', 'server', 'nodeModules']) {
        fs.mkdirSync(path.join(outputs[name], 'lib'), { recursive: true });
        for (let index = 0; index < files; index += 1) {
            fs.writeFileSync(path.join(outputs[name], 'lib', `f${index}.js`), `// ${name} ${index}\n`.repeat(20));
        }
    }
    const plan = { schemaVersion: 1, txId: transactionId, sourceRoot: path.join(candidateRoot, 'source'), candidateRoot,
        releaseCommit: RELEASE, version, publicVite: {}, outputs };
    fs.writeFileSync(path.join(env.controlRoot, `plan-${transactionId}.json`), `${JSON.stringify(plan)}\n`, { mode: 0o600 });
    const trees = { client: hashTree(outputs.client), server: hashTree(outputs.server), nodeModules: hashTree(outputs.nodeModules) };
    const manifestRaw = Buffer.from(JSON.stringify(candidateManifest(plan, trees)));
    fs.writeFileSync(outputs.manifest, manifestRaw, { mode: 0o600 });
    const identity = await prestageIdentity(env);
    const mutex = tryAcquireBuildMutex(env.appRoot, { kind: PRESTAGE_BUILD_MUTEX_KIND });
    try {
        const building = await env.slot.beginBuild({ target: { version, tag: `v${version}`, releaseCommit: RELEASE },
            identity: identity.key, transactionId });
        await env.slot.markReady(building, {
            manifestSha256: crypto.createHash('sha256').update(manifestRaw).digest('hex'),
            trees: { client: trees.client.sha256, server: trees.server.sha256, nodeModules: trees.nodeModules.sha256 },
        });
    } finally {
        mutex.release();
    }
    env.state.trace.length = 0; // the identity computed above is setup, not part of the run
    return { transactionId, candidateRoot, outputs, manifestRaw };
}

const prestageReceipts = (env) => env.state.receipts.filter((row) => row.facts?.prestage).map((row) => row.facts);
const buildCommands = (env) => env.state.trace.filter((step) => step === 'worktree-add' || step === 'candidate-build');

/** Recovery as the prestager's next cycle runs it (prestage mutex held). */
async function recover(env, lookupJob, sweep = null) {
    const mutex = tryAcquireBuildMutex(env.appRoot, { kind: PRESTAGE_BUILD_MUTEX_KIND });
    try { return await env.slot.recover({ lookupJob, sweep }); } finally { mutex.release(); }
}

/** Assert a normal build ran AFTER the slot and its candidate were gone (qa condition a). */
function assertDiscardedBeforeBuild(env, prestaged, observed) {
    assert.deepEqual(buildCommands(env), ['worktree-add', 'candidate-build']);
    assert.deepEqual(observed, { slot: null, candidate: false }, 'the discard finished before the first build command');
    assert.equal(fs.existsSync(prestaged.candidateRoot), false);
}

function observeAtBuild(env, prestaged) {
    const observed = {};
    env.state.onBuild = () => {
        if ('slot' in observed) return;
        observed.slot = env.slot.read();
        observed.candidate = fs.existsSync(prestaged.candidateRoot);
    };
    return observed;
}

// ---------------------------------------------------------------------------

test('S4 adopt: no build command runs; the seal uses the slot transaction and the manifest bytes read once', async (t) => {
    const env = fixture(t);
    const prestaged = await readySlot(env);
    const result = await createSourceUpdater(updaterDeps(env))(VERSION, jobIdentity(env));
    assert.equal(result.success, true);
    assert.deepEqual(buildCommands(env), []);
    assert.equal(result.transactionId, prestaged.transactionId);
    const sha = crypto.createHash('sha256').update(prestaged.manifestRaw).digest('hex');
    assert.equal(result.candidateManifestSha256, sha);
    const action = JSON.parse(fs.readFileSync(path.join(prestaged.candidateRoot, 'activation-action.json'), 'utf8'));
    assert.deepEqual([action.transactionId, action.manifestSha256, action.originalHead, action.targetCommit],
        [prestaged.transactionId, sha, ORIGINAL, RELEASE], 'click-time originalHead, slot txId');
    const [receipt] = prestageReceipts(env);
    assert.equal(receipt.prestage, 'adopted');
    assert.match(receipt.keyDigest, /^[0-9a-f]{64}$/);
    assert.equal(env.slot.read().state, `adopted:${JOB}`);
    assert.equal(env.prestager.status().state, 'adopted');
    // M2: the marker stays until the job row carries the transaction, then only slot.json goes.
    assert.equal((await recover(env, () => ({ state: 'staging', transactionId: null }))).action, 'adopted_kept');
    assert.equal((await recover(env, () => ({ state: 'restart_queued', transactionId: prestaged.transactionId }))).action,
        'adoption_settled');
    assert.equal(env.slot.read(), null);
    assert.ok(fs.existsSync(prestaged.candidateRoot), 'the candidate belongs to the job');
});

test('S4 qa (d) parity: the adopted path runs every click-time check, in order; only the build is replaced', async (t) => {
    const env = fixture(t);
    await readySlot(env);
    await createSourceUpdater(updaterDeps(env))(VERSION, jobIdentity(env));
    const adopted = env.state.trace;
    assert.deepEqual(adopted, [
        ...BUTTON_PATH_CHECKS.slice(0, BUTTON_PATH_CHECKS.indexOf('worktree-add')),
        'identity-lockfile', 'stage-head', 'stage-status', 'tree-hash',
        'live-head', 'live-status',
    ]);
    assert.deepEqual(adopted.filter((step) => !ADOPTION_ONLY.has(step)),
        BUTTON_PATH_CHECKS.filter((step) => !BUILD_ONLY.has(step)), 'every non-build check, once, in the button order');
});

test('S4 qa (a): a ready slot for ANOTHER version is discarded, and the discard finishes before the build', async (t) => {
    const env = fixture(t);
    const prestaged = await readySlot(env, { version: '1.42.0.0' });
    const observed = observeAtBuild(env, prestaged);
    const result = await createSourceUpdater(updaterDeps(env))(VERSION, jobIdentity(env));
    assert.equal(result.success, true);
    assertDiscardedBeforeBuild(env, prestaged, observed);
    assert.deepEqual(prestageReceipts(env), [{ prestage: 'rejected', reason: 'other_version' }]);
    assert.notEqual(result.transactionId, prestaged.transactionId);
});

test('S4 qa (a): an identity key mismatch (npm changed) discards the slot first, then builds normally', async (t) => {
    const env = fixture(t);
    const prestaged = await readySlot(env);
    env.state.npmVersion = '11.0.1';
    const observed = observeAtBuild(env, prestaged);
    const result = await createSourceUpdater(updaterDeps(env))(VERSION, jobIdentity(env));
    assert.equal(result.success, true);
    assertDiscardedBeforeBuild(env, prestaged, observed);
    assert.deepEqual(prestageReceipts(env), [{ prestage: 'rejected', reason: 'identity_mismatch:npm', fields: ['npm'] }]);
});

test('S4: a tree hash mismatch (a file changed after ready) rejects the adoption and builds normally', async (t) => {
    const env = fixture(t);
    const prestaged = await readySlot(env);
    fs.appendFileSync(path.join(prestaged.outputs.nodeModules, 'lib', 'f3.js'), '// tampered\n');
    const observed = observeAtBuild(env, prestaged);
    const result = await createSourceUpdater(updaterDeps(env))(VERSION, jobIdentity(env));
    assert.equal(result.success, true);
    assertDiscardedBeforeBuild(env, prestaged, observed);
    assert.deepEqual(prestageReceipts(env), [{ prestage: 'rejected', reason: 'tree_hash_mismatch' }]);
    const history = fs.readFileSync(env.slot.paths.history, 'utf8').trim().split('\n').map((line) => JSON.parse(line).outcome);
    assert.deepEqual(history.slice(-3), ['adopted', 'adoption_rejected', 'discarded']);
});

test('S4: a missing candidate directory rejects the adoption and builds normally', async (t) => {
    const env = fixture(t);
    const prestaged = await readySlot(env);
    fs.rmSync(prestaged.candidateRoot, { recursive: true, force: true });
    const observed = observeAtBuild(env, prestaged);
    const result = await createSourceUpdater(updaterDeps(env))(VERSION, jobIdentity(env));
    assert.equal(result.success, true);
    assertDiscardedBeforeBuild(env, prestaged, observed);
    assert.deepEqual(prestageReceipts(env).map((facts) => facts.reason), ['candidate_missing']);
});

test('S4: the kill switch turns adoption off; the ready slot is discarded and the job builds', async (t) => {
    const env = fixture(t);
    const prestaged = await readySlot(env);
    const port = env.prestager.adoptionPort();
    const deps = { ...updaterDeps(env), prestageAdoption: () => ({ ...port, adoptable: () => false }) };
    const observed = observeAtBuild(env, prestaged);
    await createSourceUpdater(deps)(VERSION, jobIdentity(env));
    assertDiscardedBeforeBuild(env, prestaged, observed);
    assert.deepEqual(prestageReceipts(env).map((facts) => facts.reason), ['adoption_disabled']);
});

test('S4 M7: sealAndQueue fails after the adoption → removeFailedCandidate removes the adopted candidate; recovery the marker', async (t) => {
    const env = fixture(t);
    const prestaged = await readySlot(env);
    env.state.queueResult = false;
    await assert.rejects(createSourceUpdater(updaterDeps(env))(VERSION, jobIdentity(env)), { code: 'restart_queue_failed' });
    assert.deepEqual(buildCommands(env), []);
    assert.equal(fs.existsSync(prestaged.candidateRoot), false, 'the job cleanup owns the adopted candidate');
    assert.equal(fs.existsSync(path.join(env.controlRoot, `plan-${prestaged.transactionId}.json`)), false);
    assert.ok(env.state.calls.some((call) => call.args.join(' ').includes(`worktree remove --force ${path.join(prestaged.candidateRoot, 'source')}`)));
    assert.equal(env.slot.read().state, `adopted:${JOB}`);
    assert.equal((await recover(env, () => ({ state: 'failed', transactionId: null }))).action, 'adoption_settled');
    assert.equal(env.slot.read(), null);
});

test('S4 crash after the CAS: adopted, no transaction on the job → kept until the job is terminal, then swept', async (t) => {
    const env = fixture(t);
    const prestaged = await readySlot(env);
    // The worker loses its lease while hashing, after the CAS: the run dies like a crash.
    env.state.onHash = async () => {
        env.state.fenced = true;
        env.state.abort.abort(new Error('source_update_worker_fenced'));
    };
    await assert.rejects(createSourceUpdater(updaterDeps(env))(VERSION, jobIdentity(env)), /source_update_worker_fenced/);
    assert.deepEqual(prestageReceipts(env), [], 'no adoption receipt and no rejection: the fence loss propagates');
    assert.equal(env.slot.read().state, `adopted:${JOB}`);
    assert.ok(fs.existsSync(prestaged.candidateRoot));
    const running = () => ({ state: 'staging', transactionId: null });
    const kept = await recover(env, running, { allowed: false, jobReferences: [] });
    assert.deepEqual([kept.action, kept.slot], ['adopted_kept', `adopted:${JOB}`]);
    assert.ok(fs.existsSync(prestaged.candidateRoot), 'never deleted while the job is live');
    const settled = await recover(env, () => ({ state: 'failed', transactionId: null }), { allowed: true, jobReferences: [] });
    assert.equal(settled.action, 'adoption_settled');
    assert.deepEqual(settled.sweep.removed, [prestaged.transactionId], 'the unnamed candidate goes in the orphan sweep');
});

test('S4: a run with no durable job id never adopts and never deletes the slot', async (t) => {
    const env = fixture(t);
    const prestaged = await readySlot(env);
    await createSourceUpdater(updaterDeps(env))(VERSION, {});
    assert.deepEqual(buildCommands(env), ['worktree-add', 'candidate-build']);
    assert.equal(env.slot.read().state, 'ready');
    assert.ok(fs.existsSync(prestaged.candidateRoot));
});

test('S4 qa (c): the prestage builder refuses through assertLegacyTransitionAllowed before any command', async (t) => {
    const env = fixture(t);
    const calls = [];
    const build = createPrestageCandidateBuilder({
        appRoot: env.appRoot, controlRoot: env.controlRoot, env: {},
        commandRunner: async (...args) => { calls.push(args); return response(); },
        assertTransition: () => { throw new Error('root_governed_activation_required'); },
    });
    const transactionId = newPrestageTransactionId();
    await assert.rejects(build({ expectedVersion: VERSION, transactionId, refPrefix: 'refs/nassaj-prestage/x/',
        builderBuildId: H('e'), beforeCandidate: async () => {}, onBuildEffect: async () => {} }), /root_governed_activation_required/);
    assert.deepEqual(calls, []);
});

test('S4: the tree hash runs in a child — the event loop keeps ticking while a large tree is hashed', async (t) => {
    const base = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-prestage-hash-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const trees = {};
    const chunk = crypto.randomBytes(256 * 1024);
    for (const name of ['client', 'server', 'nodeModules']) {
        trees[name] = path.join(base, name);
        fs.mkdirSync(trees[name]);
        for (let index = 0; index < 120; index += 1) fs.writeFileSync(path.join(trees[name], `f${index}`), chunk);
    }
    const inProcessStart = process.hrtime.bigint();
    const expected = Object.fromEntries(Object.entries(trees).map(([name, dir]) => [name, hashTree(dir)]));
    const inProcessMs = Number(process.hrtime.bigint() - inProcessStart) / 1e6;

    let last = performance.now();
    let maxGap = 0;
    const ticker = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 5);
    const start = performance.now();
    const result = await runFile(process.execPath, [TREE_HASHER, JSON.stringify(trees)], { cwd: base, env: {} });
    const childMs = performance.now() - start;
    clearInterval(ticker);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
    t.diagnostic(`in-process hashTree blocked ${inProcessMs.toFixed(0)} ms; child ${childMs.toFixed(0)} ms, max loop gap ${maxGap.toFixed(0)} ms`);
    assert.ok(maxGap < Math.max(100, inProcessMs / 2), `event loop gap ${maxGap} ms`);
});
