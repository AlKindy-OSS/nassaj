/**
 * T-2024 S3 (ADR-207 §3.1, §3.3, §3.7, §3.8): the prestager's candidate
 * builder — private `update-pre-*` transaction and `refs/nassaj-prestage/`
 * refs fetched with `--refmap=`, no live-tree reads, the identity recorded
 * before the candidate exists, the build through the effect launcher at low
 * priority with its effect identity registered before the gate opens.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createPrestageCandidateBuilder, runFile } from './source-updater.js';
import { newPrestageTransactionId, prestageRefPrefix } from './update-prestage-slot.js';

const EXT4_MAGIC = 0xef53;
const RELEASE = 'b'.repeat(40);
const LOCK_BLOB = 'f'.repeat(40);
const VERSION = '1.42.0.1';
const H = (c) => c.repeat(64);
const response = (stdout = '', code = 0) => ({ code, signal: null, stdout, stderr: '' });
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd, encoding: 'utf8' }).trim();

function fixture(t) {
    const root = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-prestage-builder-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts', 'source-update-candidate.mjs'), '// fixture');
    return { root, controlRoot: path.join(root, '.git', 'nassaj-source-update') };
}

function manifest(plan) {
    return {
        schemaVersion: 1, txId: plan.txId, releaseCommit: plan.releaseCommit, version: plan.version,
        serverBuildId: H('c'), clientBuildId: H('d'),
        sourceProvenance: { kind: 'git-worktree', commit: plan.releaseCommit, clean: true },
        artifacts: { client: { commit: plan.releaseCommit, buildId: H('d') },
            server: { commit: plan.releaseCommit, buildId: H('c') }, nodeModules: { commit: plan.releaseCommit } },
        trees: { client: { sha256: H('1'), files: 1 }, server: { sha256: H('2'), files: 2 }, nodeModules: { sha256: H('3'), files: 3 } },
    };
}

/** A fake runner that answers the HEAD-independent build; `calls` records every command. */
function fakeRunner({ candidateCode = 0 } = {}) {
    const calls = [];
    const runner = async (command, args, options = {}) => {
        calls.push({ command, args, options });
        const joined = args.join(' ');
        if (command === process.execPath) {
            await options.onSpawn?.({ pid: 4242, pgid: 4242, startTicks: '77', bootId: 'boot' });
            if (candidateCode !== 0) return response('', candidateCode);
            const plan = JSON.parse(fs.readFileSync(args.at(-1), 'utf8'));
            fs.writeFileSync(plan.outputs.manifest, JSON.stringify(manifest(plan)), { mode: 0o600 });
            return response();
        }
        if (joined.includes('remote get-url')) return response('git@github.com:AlKindy-OSS/nassaj.git\n');
        if (joined.includes('/tag^{commit}')) return response(`${RELEASE}\n`);
        if (joined.includes(':package-lock.json')) return response(`${LOCK_BLOB}\n`);
        if (joined.includes('merge-base --is-ancestor') && joined.includes('/branch')) return response('');
        if (joined.includes('merge-base --is-ancestor')) return response('', 1);
        if (joined.includes(`show ${RELEASE}:package.json`)) return response(`{"version":"${VERSION}"}\n`);
        if (joined.includes('worktree add --detach')) { fs.mkdirSync(args.at(-2), { recursive: true }); return response(); }
        if (joined.includes('worktree remove --force')) { fs.rmSync(args.at(-1), { recursive: true, force: true }); return response(); }
        if (joined.includes('rev-parse --verify HEAD^{commit}')) return response(`${RELEASE}\n`);
        return response();
    };
    return { calls, runner };
}

function builder(env, runner) {
    return createPrestageCandidateBuilder({
        appRoot: env.root, controlRoot: env.controlRoot, commandRunner: runner, env: {},
        statfs: () => ({ type: EXT4_MAGIC, bavail: 4_000_000, bsize: 4096 }), exchangeProbe: () => true,
        probeRuntime: async () => ({ version: 'v24.0.0', modules: '137', napi: '10', platform: 'linux', arch: 'x64',
            binary: { realpath: '/usr/bin/node', dev: 1, ino: 2, size: 3, mtimeMs: 4 } }),
        probeNpm: async () => ({ realpath: '/usr/bin/npm', version: '11.0.0' }),
    });
}

test('S3 builder: private update-pre-* transaction, --refmap= fetch into refs/nassaj-prestage, no live-tree reads', async (t) => {
    const env = fixture(t);
    const fake = fakeRunner();
    const transactionId = newPrestageTransactionId();
    const order = [];
    const built = await builder(env, fake.runner)({
        expectedVersion: VERSION, transactionId, refPrefix: prestageRefPrefix(transactionId), builderBuildId: H('e'),
        beforeCandidate: async ({ releaseCommit, identity }) => {
            order.push('beforeCandidate');
            assert.equal(releaseCommit, RELEASE);
            assert.match(identity.digest, /^[0-9a-f]{64}$/);
            assert.equal(identity.key.buildInputs.packageLockBlob, LOCK_BLOB);
            assert.equal(fs.existsSync(path.join(env.controlRoot, 'candidates', transactionId)), false,
                'the slot is written before candidates/<tx> exists');
        },
        onBuildEffect: async (effect) => { order.push(`effect:${effect.pgid}`); },
    });
    assert.equal(built.transactionId, transactionId);
    assert.equal(built.releaseCommit, RELEASE);
    assert.deepEqual(order, ['beforeCandidate', 'effect:4242']);

    const fetch = fake.calls.find((call) => call.args.includes('fetch'));
    const prefix = prestageRefPrefix(transactionId);
    assert.ok(fetch.args.includes('--refmap='), 'B-1625: the prestage fetch empties the refmap');
    assert.ok(fetch.args.some((arg) => arg.endsWith(`:${prefix}tag`)));
    assert.ok(fetch.args.some((arg) => arg.endsWith(`:${prefix}branch`)));
    const dropped = fake.calls.filter((call) => call.args.includes('update-ref') && call.args.includes('-d')).map((call) => call.args.at(-1));
    assert.deepEqual(dropped.sort(), [`${prefix}branch`, `${prefix}tag`]);

    const live = fake.calls.filter((call) => call.command === 'git' && call.options.cwd === env.root).map((call) => call.args.join(' '));
    for (const forbidden of ['symbolic-ref', 'status --porcelain', 'rev-parse --verify HEAD^{commit}', 'update-ref -m']) {
        assert.ok(!live.some((args) => args.includes(forbidden)), `no live-tree "${forbidden}"`);
    }
    const candidate = fake.calls.find((call) => call.command === process.execPath);
    assert.equal(candidate.options.lowPriority, true);
    assert.equal(candidate.options.effectGateRoot, path.join(env.controlRoot, 'prestage', 'effects'));
    const nonBuild = fake.calls.filter((call) => call.command !== process.execPath);
    assert.ok(nonBuild.every((call) => call.options.onSpawn === undefined && call.options.lowPriority === undefined),
        'only the candidate build goes through the launcher');
    assert.ok(fs.existsSync(path.join(env.controlRoot, 'candidates', transactionId, 'source')));
});

test('S3 builder: a failed build removes its candidate and plan and drops its refs', async (t) => {
    const env = fixture(t);
    const fake = fakeRunner({ candidateCode: 1 });
    const transactionId = newPrestageTransactionId();
    await assert.rejects(builder(env, fake.runner)({
        expectedVersion: VERSION, transactionId, refPrefix: prestageRefPrefix(transactionId), builderBuildId: H('e'),
        beforeCandidate: async () => {}, onBuildEffect: async () => {},
    }), { code: 'candidate_build_failed' });
    assert.equal(fs.existsSync(path.join(env.controlRoot, 'candidates', transactionId)), false);
    assert.deepEqual(fs.readdirSync(env.controlRoot).filter((name) => name.startsWith('plan-')), []);
    assert.equal(fake.calls.filter((call) => call.args.includes('update-ref') && call.args.includes('-d')).length, 2);
});

test('B-1625 (S3): a fetch with --refmap= never moves origin/main; without it git does', (t) => {
    const base = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-prestage-refmap-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const remote = path.join(base, 'remote');
    const local = path.join(base, 'local');
    fs.mkdirSync(remote);
    git(remote, 'init', '-q', '-b', 'main');
    git(remote, 'commit', '-q', '--allow-empty', '-m', 'base');
    git(base, 'clone', '-q', remote, local);
    const before = git(local, 'rev-parse', 'refs/remotes/origin/main');
    git(remote, 'commit', '-q', '--allow-empty', '-m', 'tip');
    const tip = git(remote, 'rev-parse', 'HEAD');

    git(local, 'fetch', '-q', '--no-tags', '--refmap=', 'origin', 'refs/heads/main:refs/nassaj-prestage/n1/branch');
    assert.equal(git(local, 'rev-parse', 'refs/nassaj-prestage/n1/branch'), tip);
    assert.equal(git(local, 'rev-parse', 'refs/remotes/origin/main'), before, 'origin/main unchanged after a prestage fetch');

    git(local, 'fetch', '-q', '--no-tags', 'origin', 'refs/heads/main:refs/nassaj-update/n2/branch');
    assert.equal(git(local, 'rev-parse', 'refs/remotes/origin/main'), tip, 'control: the job fetch moves it opportunistically');
});

test('S3 launcher: an async registration opens the gate only once settled; the child runs at nice 19 / oom 1000, the launcher does not', async (t) => {
    const base = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-prestage-launcher-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const marker = path.join(base, 'started');
    let startedBeforeRegistration = null;
    const result = await runFile('/bin/sh', ['-c',
        `touch '${marker}'; sleep 0.3; cat /proc/self/oom_score_adj; cut -d' ' -f19 /proc/self/stat; cat /proc/$PPID/oom_score_adj`], {
        cwd: base, env: { PATH: process.env.PATH }, effectGateRoot: path.join(base, 'effects'), lowPriority: true,
        onSpawn: async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
            startedBeforeRegistration = fs.existsSync(marker);
        },
    });
    assert.equal(result.code, 0);
    assert.equal(startedBeforeRegistration, false, 'the command waits for the registration');
    const [childOom, childNice, launcherOom] = result.stdout.trim().split('\n');
    assert.equal(childOom, '1000');
    assert.equal(childNice, '19');
    assert.notEqual(launcherOom, '1000', 'oom_score_adj is never applied to the launcher');
});

test('S3 launcher: a rejected async registration kills the inert launcher and never runs the command', async (t) => {
    const base = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-prestage-launcher-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const marker = path.join(base, 'started');
    await assert.rejects(runFile('/bin/sh', ['-c', `touch '${marker}'`], {
        cwd: base, env: { PATH: process.env.PATH }, effectGateRoot: path.join(base, 'effects'),
        onSpawn: async () => { throw new Error('prestage_slot_conflict'); },
    }), /prestage_slot_conflict/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(marker), false);
});
