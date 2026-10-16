import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync, spawn } from 'child_process';
import test from 'node:test';

import { readClientPublicationBlockers } from '../../scripts/lib/client-publication-control.mjs';
import { isSourceUpdateActionShape } from '../../scripts/lib/source-update-action-schema.mjs';

import { createUpdateMaintenanceGate } from './update-maintenance-gate.js';
import { createSourceUpdateWorker } from './source-update-worker.js';
import { advanceRemoteTrackingRef, assertUpdateStorage, defaultSourceUpdateControlRoot, evaluateUpdateStorage, publicStorageFigures, createSourceUpdater as createSourceUpdaterImpl, defaultGitCheckoutProbe as defaultGitCheckoutProbeExport, releaseGitEnvironment, resolveCandidateScript, resolveGovernedSshCommand, resolveUpdateHostCapability, runFile, SourceUpdateError, sourceUpdateErrorPayload } from './source-updater.js';

// A non-tmpfs device with ample free space keeps the T-1553 storage gate out of
// the way for tests that exercise other behaviour; the gate itself is covered
// explicitly below with overriding statfs stubs.
const EXT4_MAGIC = 0xef53;
const benignStatfs = () => ({ type: EXT4_MAGIC, bavail: 4_000_000, bsize: 4096 });
// The exchange probe is a HOST capability (WI-11); pinning it keeps these tests
// about the updater rather than about the coreutils version of the test machine.
// The source planner reads real git trees; the fixtures here are fake-git, so
// it is pinned to "no conflict" except where a test exercises it (H1).
const createSourceUpdater = (options) => createSourceUpdaterImpl({
    queueRestartAction: async () => true, statfs: benignStatfs, exchangeProbe: () => true,
    sourcePlanner: () => ({ paths: 0 }), ...options,
});

function fixture() {
    const root = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-source-updater-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts', 'source-update-candidate.mjs'), '// fixture');
    return root;
}

function response(stdout = '', code = 0) {
    return { code, signal: null, stdout, stderr: '' };
}

test('candidate runner resolves compiled-only in dist and rejects missing or symlink runners', (t) => {
    const root = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-candidate-runner-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts', 'source-update-candidate.mjs'), 'source');
    assert.equal(resolveCandidateScript(root, `file://${root}/server/services/source-updater.js`), path.join(root, 'scripts', 'source-update-candidate.mjs'));
    assert.throws(() => resolveCandidateScript(root, `file://${root}/dist-server/server/services/source-updater.js`), /verified v2 update runtime is unavailable/);
    fs.mkdirSync(path.join(root, 'dist-server', 'scripts'), { recursive: true });
    const resolved = path.join(root, 'dist-server', 'UPDATE_RUNTIME_BUNDLE', 'scripts', 'source-update-candidate.mjs');
    assert.equal(resolveCandidateScript(root, `file://${root}/dist-server/server/services/source-updater.js`, (artifact, entry) => {
        assert.equal(artifact, path.join(root, 'dist-server'));
        assert.equal(entry, 'scripts/source-update-candidate.mjs');
        return resolved;
    }), resolved);
});

test('the default control root follows the git common dir, also from a linked worktree (B-1334)', () => {
    const base = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-control-root-'));
    try {
        const main = path.join(base, 'main');
        const linked = path.join(base, 'linked');
        const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore',
            env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x',
                GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
        fs.mkdirSync(main);
        git(main, 'init', '-q', '-b', 'main');
        git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
        git(main, 'worktree', 'add', '-q', '--detach', linked);
        const expected = path.join(fs.realpathSync(main), '.git', 'nassaj-source-update');
        assert.equal(defaultSourceUpdateControlRoot(main), expected);
        assert.equal(defaultSourceUpdateControlRoot(linked), expected, 'a linked worktree shares the main control root');
        const nested = path.join(main, 'nested');
        fs.mkdirSync(nested);
        assert.equal(defaultSourceUpdateControlRoot(nested), path.join(nested, '.git', 'nassaj-source-update'),
            'a directory inside another checkout does not borrow its control root');
        assert.equal(defaultSourceUpdateControlRoot(path.join(base, 'absent')),
            path.join(base, 'absent', '.git', 'nassaj-source-update'));
        const seen = [];
        resolveUpdateHostCapability({ appRoot: linked, env: {}, gitProbe: () => ({ ready: false, reason: 'x' }),
            detector: (input) => { seen.push(input.context.controlRoot); return 'unsupported'; } });
        assert.deepEqual(seen, [expected]);
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test('host updater strategy comes only from the verified capability detector', () => {
    const calls = [];
    const absentGit = () => ({ ready: false, reason: 'verified_update_runtime_absent' });
    const legacy = resolveUpdateHostCapability({
        appRoot: '/opt/nassaj', moduleUrl: 'file:///opt/nassaj/server/services/source-updater.js',
        env: {}, detector: (input) => { calls.push(input); return 'legacy-1.44-bridge'; }, gitProbe: absentGit,
    });
    assert.deepEqual(legacy, { ready: false, protocol: null, runtimeStrategy: 'unsupported', jobStrategy: null,
        blockedReasonCode: 'verified_update_runtime_absent' });
    assert.equal(calls[0].artifactRoot, '/opt/nassaj');
    const native = resolveUpdateHostCapability({
        appRoot: '/opt/nassaj', moduleUrl: 'file:///opt/nassaj/dist-server/server/services/source-updater.js',
        env: { NASSAJ_UPDATER_RELEASE_LAYOUT: '1', NASSAJ_UPDATE_CONTROL_ROOT: '/var/lib/nassaj-update', NASSAJ_DEPLOY_ROOT: '/opt/nassaj-runtime', NASSAJ_NODE_INSTANCE_ID: 'node-1' }, detector: () => 'artifact-runtime-v2', gitProbe: absentGit,
    });
    assert.deepEqual(native, {
        ready: true, protocol: 2, runtimeStrategy: 'artifact-runtime-v2', jobStrategy: 'release-layout-v2',
    });
    const unknown = resolveUpdateHostCapability({ appRoot: '/opt/nassaj', detector: () => 'unsupported', gitProbe: absentGit });
    assert.deepEqual(unknown, { ready: false, protocol: null, runtimeStrategy: 'unsupported', jobStrategy: null,
        blockedReasonCode: 'verified_update_runtime_absent' });
});

test('git source installations are offered the credential-free git-checkout-v2 strategy (T-1548)', () => {
    const probes = [];
    const ready = resolveUpdateHostCapability({
        appRoot: '/opt/nassaj', detector: () => 'legacy-1.44-unattested',
        env: { NASSAJ_UPDATE_REMOTE: 'upstream', NASSAJ_UPDATE_BRANCH: 'release' },
        gitProbe: (input) => { probes.push(input); return { ready: true, branch: 'release', remoteIdentity: 'github.com/alkindy-oss/nassaj' }; },
    });
    assert.deepEqual(ready, {
        ready: true, protocol: 2, runtimeStrategy: 'git-checkout-v2', jobStrategy: 'git-checkout-v2',
        remoteIdentity: 'github.com/alkindy-oss/nassaj',
    });
    assert.deepEqual(probes[0], { appRoot: '/opt/nassaj', remote: 'upstream', branch: 'release' });
    // artifact-runtime-v2 still wins over the git strategy when both could apply.
    const artifact = resolveUpdateHostCapability({
        appRoot: '/opt/nassaj', moduleUrl: 'file:///opt/nassaj/dist-server/server/services/source-updater.js',
        env: { NASSAJ_UPDATER_RELEASE_LAYOUT: '1', NASSAJ_UPDATE_CONTROL_ROOT: '/c', NASSAJ_DEPLOY_ROOT: '/d', NASSAJ_NODE_INSTANCE_ID: 'n' },
        detector: () => 'artifact-runtime-v2', gitProbe: () => { throw new Error('git probe must not run for artifact hosts'); },
    });
    assert.equal(artifact.jobStrategy, 'release-layout-v2');
    // A probe rejection surfaces its precise reason as the blocked code.
    for (const reason of ['wrong_branch', 'detached_head', 'unsafe_remote', 'ambiguous_remote', 'unsupported_install_mode']) {
        const blocked = resolveUpdateHostCapability({
            appRoot: '/opt/nassaj', detector: () => 'unsupported', gitProbe: () => ({ ready: false, reason }),
        });
        assert.deepEqual(blocked, { ready: false, protocol: null, runtimeStrategy: 'unsupported', jobStrategy: null,
            blockedReasonCode: reason });
    }
});

test('release-layout-v2 is frozen behind a default-off flag (T-1750, ADR-135→ADR-141)', () => {
    const artifactEnv = { NASSAJ_UPDATE_CONTROL_ROOT: '/c', NASSAJ_DEPLOY_ROOT: '/d', NASSAJ_NODE_INSTANCE_ID: 'n' };
    // Flag off (default): a host that would resolve artifact-runtime-v2 is
    // reported blocked with release_layout_retired, never silently ready.
    const retired = resolveUpdateHostCapability({
        appRoot: '/opt/nassaj', moduleUrl: 'file:///opt/nassaj/dist-server/server/services/source-updater.js',
        env: { ...artifactEnv }, detector: () => 'artifact-runtime-v2',
        gitProbe: () => { throw new Error('git probe must not run for artifact hosts'); },
    });
    assert.deepEqual(retired, { ready: false, protocol: null, runtimeStrategy: 'unsupported', jobStrategy: null,
        blockedReasonCode: 'release_layout_retired' });
    // The retirement gate precedes the configuration check: an absent env
    // triple still reports release_layout_retired while the flag is off.
    const retiredNoConfig = resolveUpdateHostCapability({
        appRoot: '/opt/nassaj', moduleUrl: 'file:///opt/nassaj/dist-server/server/services/source-updater.js',
        env: {}, detector: () => 'artifact-runtime-v2',
        gitProbe: () => { throw new Error('git probe must not run for artifact hosts'); },
    });
    assert.equal(retiredNoConfig.blockedReasonCode, 'release_layout_retired');
    // Flag on: the old behaviour is restored unchanged.
    const enabled = resolveUpdateHostCapability({
        appRoot: '/opt/nassaj', moduleUrl: 'file:///opt/nassaj/dist-server/server/services/source-updater.js',
        env: { NASSAJ_UPDATER_RELEASE_LAYOUT: '1', ...artifactEnv }, detector: () => 'artifact-runtime-v2',
        gitProbe: () => { throw new Error('git probe must not run for artifact hosts'); },
    });
    assert.deepEqual(enabled, { ready: true, protocol: 2, runtimeStrategy: 'artifact-runtime-v2', jobStrategy: 'release-layout-v2' });
    // Flag on but env triple incomplete: the original configuration-absent code.
    const enabledNoConfig = resolveUpdateHostCapability({
        appRoot: '/opt/nassaj', moduleUrl: 'file:///opt/nassaj/dist-server/server/services/source-updater.js',
        env: { NASSAJ_UPDATER_RELEASE_LAYOUT: '1' }, detector: () => 'artifact-runtime-v2',
        gitProbe: () => { throw new Error('git probe must not run for artifact hosts'); },
    });
    assert.equal(enabledNoConfig.blockedReasonCode, 'release_layout_configuration_absent');
});

test('defaultGitCheckoutProbe reads branch and credential-free GitHub remote from a real repo (T-1548)', (t) => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-gitprobe-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'ci@example.com');
    git('config', 'user.name', 'ci');
    git('remote', 'add', 'origin', 'https://github.com/AlKindy-OSS/nassaj.git');
    fs.writeFileSync(path.join(root, 'f'), 'x');
    git('add', 'f');
    git('commit', '-qm', 'init');
    const ok = defaultGitCheckoutProbeExport({ appRoot: root, remote: 'origin', branch: 'main' });
    assert.deepEqual(ok, { ready: true, branch: 'main', remoteIdentity: 'github.com/alkindy-oss/nassaj' });
    assert.equal(defaultGitCheckoutProbeExport({ appRoot: root, remote: 'origin', branch: 'other' }).reason, 'wrong_branch');
    assert.equal(defaultGitCheckoutProbeExport({ appRoot: root, remote: 'missing', branch: 'main' }).reason, 'remote_unavailable');
    // A credential-bearing URL is rejected as an unsafe remote.
    git('remote', 'set-url', 'origin', 'https://user:token@github.com/AlKindy-OSS/nassaj.git');
    assert.equal(defaultGitCheckoutProbeExport({ appRoot: root, remote: 'origin', branch: 'main' }).reason, 'unsafe_remote');
    assert.equal(defaultGitCheckoutProbeExport({ appRoot: '/nonexistent-nassaj-xyz', remote: 'origin', branch: 'main' }).reason, 'unsupported_install_mode');
});

test('abort signal kills the governed child process group and returns no successful result', async () => {
    const controller = new AbortController();
    let spawnedIdentity = null;
    const effectGateRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'effect-gate-test-'));
    const running = runFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        cwd: process.cwd(), env: { PATH: process.env.PATH }, signal: controller.signal,
        effectGateRoot,
        onSpawn: (identity) => { spawnedIdentity = identity; },
    });
    setTimeout(() => controller.abort(), 20);
    const result = await running;
    assert.notEqual(result.code, 0);
    assert.equal(result.signal, 'SIGKILL');
    assert.equal(spawnedIdentity.pgid, spawnedIdentity.pid);
    assert.match(spawnedIdentity.startTicks, /^\d+$/);
    assert.match(spawnedIdentity.bootId, /^[a-f0-9-]+$/);
    fs.rmSync(effectGateRoot, { recursive: true, force: true });
});

test('durable launcher executes nothing when parent is killed between spawn and registration', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'effect-handshake-kill-'));
    const marker = path.join(root, 'external-effect');
    const moduleUrl = new URL('./source-updater.js', import.meta.url).href;
    const script = `
      import { runFile } from ${JSON.stringify(moduleUrl)};
      await runFile(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)}], {
        cwd: process.cwd(), env: process.env, effectGateRoot: ${JSON.stringify(root)},
        onSpawn() { process.send({ phase: 'spawned-before-register' }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000); }
      });`;
    const coordinator = spawn(process.execPath, ['--input-type=module', '-e', script], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    try {
        await new Promise((resolve, reject) => {
            coordinator.once('message', resolve); coordinator.once('error', reject);
        });
        coordinator.kill('SIGKILL');
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal(fs.existsSync(marker), false);
    } finally {
        try { coordinator.kill('SIGKILL'); } catch {}
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('durable launcher kills a surviving descendant before reporting close', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'effect-descendant-'));
    let identity;
    try {
        const command = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); c.unref();`;
        const result = await runFile(process.execPath, ['-e', command], {
            cwd: process.cwd(), env: process.env, effectGateRoot: root,
            onSpawn(value) { identity = value; },
        });
        assert.equal(result.code, 0);
        assert.throws(() => process.kill(-identity.pgid, 0), (error) => error.code === 'ESRCH');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fails closed before Git when an active agent session exists', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const calls = [];
    const update = createSourceUpdater({ appRoot, activeSessionCount: () => 1, commandRunner: async (...args) => { calls.push(args); return response(); } });
    await assert.rejects(update('1.42.0.1'), (error) => error instanceof SourceUpdateError && error.code === 'active_sessions');
    assert.equal(calls.every(([command]) => command === 'git'), true);
    assert.equal(calls.some(([, args]) => args.includes('fetch')), false);
});

test('rejects a modified tracked file before fetching a release', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const calls = [];
    const runner = async (command, args) => {
        calls.push([command, args]);
        if (args.includes('status')) return response(' M server/index.js\0');
        return response();
    };
    const update = createSourceUpdater({ appRoot, activeSessionCount: () => 0, commandRunner: runner });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'dirty_worktree'
        && /server\/index\.js/.test(error.message));
    // The pre-fetch guard asks only about tracked files now (WI-10, B-1050).
    assert.equal(calls.some(([, args]) => args.includes('--untracked-files=no')), true);
    assert.equal(calls.some(([, args]) => args.includes('fetch')), false);
});

test('rejects argument injection and non-four-part versions without spawning', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    let calls = 0;
    const update = createSourceUpdater({ appRoot, activeSessionCount: () => 0, commandRunner: async () => { calls += 1; return response(); } });
    for (const version of ['1.42.1', '--upload-pack=evil', '1.42.0.1; touch owned']) {
        await assert.rejects(update(version), (error) => error.code === 'invalid_release_version');
    }
    assert.equal(calls, 0);
});

function governedRunner({
    tagOnBranch = true,
    candidateCode = 0,
    remoteUrl = 'git@github.com:AlKindy-OSS/nassaj.git',
    ghAuthCode = 0,
    onFetch,
    // WI-10: the working tree as `--untracked-files=all` reports it, and the
    // paths the release rewrites, both NUL-delimited as the updater reads them.
    untrackedStatus = '',
    releasePaths = [],
    // `git diff --raw -z --abbrev=40` output for the release (WI-11 gitlink gate).
    rawDiff = '',
} = {}) {
    const calls = [];
    const original = 'a'.repeat(40);
    const release = 'b'.repeat(40);
    let currentHead = original;
    let dirty = false;
    const runner = async (command, args, options) => {
        calls.push({ command, args, options });
        const joined = args.join(' ');
        if (command === process.execPath && args.includes('--plan')) {
            if (candidateCode !== 0) return response('', candidateCode);
            const plan = JSON.parse(fs.readFileSync(args.at(-1), 'utf8'));
            fs.writeFileSync(plan.outputs.manifest, JSON.stringify({
                schemaVersion: 1, txId: plan.txId, releaseCommit: plan.releaseCommit,
                version: plan.version, createdAt: new Date().toISOString(), serverBuildId: 'c'.repeat(64),
                clientBuildId: 'b'.repeat(64),
                sourceProvenance: { kind: 'git-worktree', commit: plan.releaseCommit, clean: true },
                artifacts: {
                    client: { commit: plan.releaseCommit, buildId: 'b'.repeat(64) },
                    server: { commit: plan.releaseCommit, buildId: 'c'.repeat(64) },
                    nodeModules: { commit: plan.releaseCommit },
                },
            }), { mode: 0o600 });
            return response();
        }
        if (command === 'gh') return response('', ghAuthCode);
        if (joined.includes('diff --raw')) return response(rawDiff);
        if (joined.includes('diff --name-only')) return response(releasePaths.map((file) => `${file}\0`).join(''));
        if (joined.includes('--untracked-files=no')) return response(dirty ? ' M package-lock.json\0' : '');
        if (joined.includes('status --porcelain')) return response(dirty ? ' M package-lock.json\0' : untrackedStatus);
        if (joined.includes('symbolic-ref')) return response('main\n');
        if (joined.includes('remote get-url --all')) return response(`${remoteUrl}\n`);
        if (joined.includes('remote get-url origin')) return response(`${remoteUrl}\n`);
        if (joined.includes('fetch')) {
            onFetch?.({ command, args, options });
            return response();
        }
        if (joined.includes('worktree add --detach')) {
            const stage = args.at(-2);
            fs.mkdirSync(stage, { recursive: true });
            fs.writeFileSync(path.join(stage, 'package-lock.json'), '{}');
            return response();
        }
        if (joined.includes('worktree remove --force')) {
            fs.rmSync(args.at(-1), { recursive: true, force: true });
            return response();
        }
        if (joined.includes('ls-tree -rz --full-tree')) {
            return response(`100644 blob ${release}\tpackage.json\0`);
        }
        if (joined.includes('rev-parse --verify') && joined.includes('/tag^{commit}')) return response(`${release}\n`);
        if (joined.includes('rev-parse --verify HEAD^{commit}')) {
            return response(`${options?.cwd?.includes('/nassaj-source-update/candidates/') ? release : currentHead}\n`);
        }
        if (joined.includes('merge-base --is-ancestor') && joined.includes('/branch')) return response('', tagOnBranch ? 0 : 1);
        // Only the source HEAD is an ancestor of the release; any other pair
        // (e.g. the release against a loaded runtime commit) is unrelated.
        if (joined.includes('merge-base --is-ancestor')) return response('', joined.endsWith(`${original} ${release}`) ? 0 : 1);
        if (joined.includes(`show ${release}:package.json`)) return response('{"name":"nassaj","version":"1.42.0.1"}\n');
        if (args.includes('merge')) {
            currentHead = release;
            return response();
        }
        return response();
    };
    return { calls, runner, release, original };
}

test('rejects a release tag that is not on the configured source branch', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner({ tagOnBranch: false });
    const update = createSourceUpdater({ appRoot, activeSessionCount: () => 0, commandRunner: fake.runner });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'tag_mismatch');
    assert.equal(fake.calls.some(({ command }) => command === 'npm'), false);
});

test('rejects an origin that differs from the default public release source', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner({ remoteUrl: 'https://github.com/example/legacy-release.git' });
    const update = createSourceUpdater({ appRoot, activeSessionCount: () => 0, commandRunner: fake.runner });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'remote_mismatch');
    assert.equal(fake.calls.some(({ args }) => args.includes('fetch')), false);
});

test('an untracked file outside the release paths no longer blocks the update (WI-10, B-1050)', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner({
        untrackedStatus: '?? .env.bak-2026-09-01\0?? operator-notes.md\0',
        releasePaths: ['package.json', 'server/index.js'],
    });
    const update = createSourceUpdater({ appRoot, activeSessionCount: () => 0, commandRunner: fake.runner });
    const result = await update('1.42.0.1');
    assert.equal(result.success, true);
    assert.equal(result.commit, fake.release);
    // The scope came from the release itself, not from a blanket status read.
    assert.equal(fake.calls.some(({ args }) => args.includes('diff') && args.includes('--name-only')), true);
});

test('a local change inside the release paths is refused by name (WI-10)', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner({
        untrackedStatus: '?? operator-notes.md\0?? server/index.js\0',
        releasePaths: ['server/index.js'],
    });
    const update = createSourceUpdater({ appRoot, activeSessionCount: () => 0, commandRunner: fake.runner });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'dirty_worktree'
        && /server\/index\.js/.test(error.message) && !/operator-notes/.test(error.message));
    assert.equal(fake.calls.some(({ command }) => command === process.execPath), false);
});

test('a release that drops a submodule gitlink is refused before any build (WI-11, B-1054)', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const gitlink = '4895cd3fd33362471e739b786493aba048487bcc';
    const fake = governedRunner({
        rawDiff: `:160000 000000 ${gitlink} ${'0'.repeat(40)} D\0plugins/starter\0`,
    });
    const update = createSourceUpdater({ appRoot, activeSessionCount: () => 0, commandRunner: fake.runner });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'gitlink_change_unsupported'
        && /plugins\/starter/.test(error.message) && error.status === 409);
    // Never reached the candidate build, so no `npm ci` was spent on a release
    // this node could not have activated — and activation is never entered.
    assert.equal(fake.calls.some(({ command }) => command === process.execPath), false);
    assert.equal(fake.calls.some(({ args }) => args.includes('worktree')), false);
});

test('an unchanged gitlink in the release diff is not a blocker (WI-11)', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const blob = 'a'.repeat(40);
    const fake = governedRunner({ rawDiff: `:100644 100644 ${blob} ${'c'.repeat(40)} M\0package.json\0` });
    const update = createSourceUpdater({ appRoot, activeSessionCount: () => 0, commandRunner: fake.runner });
    assert.equal((await update('1.42.0.1')).success, true);
});

test('a source plan conflict (an ignored file on a release path) is refused before the build (H1)', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner();
    const planned = [];
    const update = createSourceUpdater({
        appRoot, activeSessionCount: () => 0, commandRunner: fake.runner,
        sourcePlanner: (input) => { planned.push(input); throw new Error('Source activation CAS mismatch: build/generated.js'); },
    });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'source_plan_conflict'
        && error.status === 409 && /CAS mismatch: build\/generated\.js/.test(error.message));
    assert.deepEqual(planned, [{ projectRoot: appRoot, originalHead: fake.original, targetCommit: fake.release }]);
    assert.equal(fake.calls.some(({ command }) => command === process.execPath), false, 'no candidate build');
});

test('a host without mv --exchange is refused before the build (WI-11)', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner();
    const update = createSourceUpdater({
        appRoot, activeSessionCount: () => 0, commandRunner: fake.runner, exchangeProbe: () => false,
    });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'exchange_capability' && error.status === 409);
    assert.equal(fake.calls.some(({ command }) => command === process.execPath), false);
    assert.deepEqual(candidateLeftovers(appRoot), [], 'no empty candidates/<tx> is left behind (L1)');
});

/** Entries under candidates/ — a refused preparation must leave none (qa-critic L1). */
function candidateLeftovers(appRoot) {
    const candidatesRoot = path.join(appRoot, '.git', 'nassaj-source-update', 'candidates');
    return fs.existsSync(candidatesRoot) ? fs.readdirSync(candidatesRoot) : [];
}

test('a candidates root on another filesystem is refused, and nothing is left behind (L1)', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner();
    const update = createSourceUpdater({
        appRoot, activeSessionCount: () => 0, commandRunner: fake.runner,
        stat: (target) => ({ dev: String(target).endsWith('candidates') ? 66 : 65 }),
    });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'activation_filesystem_mismatch'
        && /candidates/.test(error.message));
    assert.deepEqual(candidateLeftovers(appRoot), []);
});

test('generations spread across two filesystems are refused before the build (WI-11)', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.join(appRoot, 'node_modules'));
    const fake = governedRunner();
    const update = createSourceUpdater({
        appRoot, activeSessionCount: () => 0, commandRunner: fake.runner,
        stat: (target) => ({ dev: String(target).endsWith('node_modules') ? 66 : 65 }),
    });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'activation_filesystem_mismatch'
        && /node_modules/.test(error.message));
    assert.equal(fake.calls.some(({ command }) => command === process.execPath), false);
    assert.deepEqual(candidateLeftovers(appRoot), [], 'no empty candidates/<tx> is left behind (L1)');
});

test('stages only the exact fast-forward commit and builds both runtime artifacts off-tree', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner();
    const update = createSourceUpdater({
        appRoot,
        activeSessionCount: () => 0,
        commandRunner: fake.runner,
        env: {
            PATH: '/usr/bin', HOME: '/synthetic/operator-home', HTTPS_PROXY: 'http://proxy.invalid',
            DATABASE_PATH: 'SENTINEL_DATABASE', ANTHROPIC_API_KEY: 'SENTINEL_PROVIDER',
            OIDC_CLIENT_SECRET: 'SENTINEL_OAUTH', SESSION_SECRET: 'SENTINEL_SESSION',
            NASSAJ_RELEASE_CHANNEL: 'legacy',
            NASSAJ_SOURCE_REPOSITORY_URL: 'https://github.com/example/legacy-release',
        },
        loadedRuntimeCommit: () => 'c'.repeat(40),
    });
    const result = await update('1.42.0.1');
    assert.equal(result.commit, fake.release);
    // B-1264: the immutable activation action records the runtime a rollback restores.
    const candidates = path.join(appRoot, '.git', 'nassaj-source-update', 'candidates');
    const actions = fs.readdirSync(candidates).map((id) => path.join(candidates, id, 'activation-action.json'))
        .filter((file) => fs.existsSync(file)).map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
    assert.equal(actions.length, 1);
    assert.equal(actions[0].previousRuntimeOid, 'c'.repeat(40));
    // B-1583: what the real writer persisted is a shape every strict reader accepts.
    assert.equal(isSourceUpdateActionShape(actions[0]), true);
    assert.equal(fake.calls.some(({ args }) => args.includes('merge') || args.includes('reset') || args.includes('clean')), false);
    assert.equal(result.restartActionQueued, true);
    assert.match(result.candidateManifestSha256, /^[0-9a-f]{64}$/);
    const candidate = fake.calls.filter(({ command, args }) => command === process.execPath && args.includes('--plan'));
    assert.equal(candidate.length, 1);
    for (const { options } of candidate) {
        assert.equal(options.env.HUSKY, '0');
        assert.equal(options.env.PATH, '/usr/bin');
        assert.equal(options.env.HTTPS_PROXY, 'http://proxy.invalid');
        assert.equal(Object.hasOwn(options.env, 'DATABASE_PATH'), false);
        assert.equal(Object.hasOwn(options.env, 'ANTHROPIC_API_KEY'), false);
        assert.equal(Object.hasOwn(options.env, 'OIDC_CLIENT_SECRET'), false);
        assert.equal(Object.hasOwn(options.env, 'SESSION_SECRET'), false);
        assert.equal(Object.hasOwn(options.env, ['NASSAJ', 'UPDATE', 'GITHUB', 'TOKEN'].join('_')), false);
    }
    assert.equal(fake.calls.some(({ command, args }) => command === 'sh' || args.includes('-c') && command !== 'git'), false);
});

test('refuses to move HEAD when a session starts during release validation', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner();
    let checks = 0;
    const update = createSourceUpdater({
        appRoot,
        activeSessionCount: () => checks++ === 0 ? 0 : 1,
        commandRunner: fake.runner,
    });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'active_sessions');
    assert.equal(fake.calls.some(({ args }) => args.includes('merge')), false);
});

test('removes only its transient candidate when candidate construction fails', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner({ candidateCode: 1 });
    const update = createSourceUpdater({ appRoot, activeSessionCount: () => 0, commandRunner: fake.runner });
    await assert.rejects(update('1.42.0.1'), (error) => {
        assert.equal(error.code, 'candidate_build_failed');
        return true;
    });
    assert.equal(fake.calls.some(({ args }) => args.includes('worktree') && args.includes('remove')), true);
    assert.equal(fake.calls.some(({ args }) => args.includes('reset') || args.includes('clean')), false);
});

test('rejects a concurrent update while the first preflight is pending', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    let releaseStatus;
    const statusGate = new Promise((resolve) => { releaseStatus = resolve; });
    let firstStatus = true;
    const runner = async (_command, args) => {
        if (firstStatus && args.includes('status')) {
            firstStatus = false;
            await statusGate;
        }
        return response('', 1);
    };
    const update = createSourceUpdater({ appRoot, activeSessionCount: () => 0, commandRunner: runner });
    const first = update('1.42.0.1');
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'update_in_progress');
    releaseStatus();
    await assert.rejects(first);
});

/** Put the fixture's maintenance gate in the ب.5 degraded state, checksum and all. */
function markGateDegraded(appRoot) {
    const gate = createUpdateMaintenanceGate({ projectPath: appRoot });
    const journal = JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8'));
    const { checksum: _old, ...payload } = {
        ...journal, degraded: 'source_tree_at_target', exitPath: 'complete_source_rollback_or_pin_release_ref',
    };
    const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
        : value && typeof value === 'object'
            ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
            : JSON.stringify(value));
    fs.writeFileSync(gate.paths.journal, JSON.stringify({
        ...payload, checksum: crypto.createHash('sha256').update(canonical(payload)).digest('hex'),
    }));
}

test('a degraded gate refuses the update before any fetch or build (C2)', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    markGateDegraded(appRoot);
    const fake = governedRunner();
    const update = createSourceUpdater({ appRoot, activeSessionCount: () => 0, commandRunner: fake.runner });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'update_source_state_degraded'
        && error.status === 409 && error.details.exitPath === 'complete_source_rollback_or_pin_release_ref');
    assert.equal(fake.calls.length, 0, 'not one git command, let alone npm ci');
});

test('governed git composes with the node ssh command instead of replacing it (H5)', async (t) => {
    const governed = '-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10';
    assert.equal(releaseGitEnvironment({ PATH: '/usr/bin' }).GIT_SSH_COMMAND, `ssh ${governed}`);
    // A deploy key, port 443 and a wrapper all keep their program and arguments.
    assert.equal(releaseGitEnvironment({ GIT_SSH_COMMAND: 'ssh -i "/keys/deploy key" -p 443' }).GIT_SSH_COMMAND,
        `ssh -i "/keys/deploy key" -p 443 ${governed}`);
    assert.equal(releaseGitEnvironment({ GIT_SSH_COMMAND: '/opt/wrap.sh --profile ci' }).GIT_SSH_COMMAND,
        `/opt/wrap.sh --profile ci ${governed}`);
    assert.equal(releaseGitEnvironment({ GIT_SSH: "/opt/o'ssh" }).GIT_SSH_COMMAND, `'/opt/o'\\''ssh' ${governed}`);

    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    // The repository's own core.sshCommand — what git would have used — survives.
    execFileSync('git', ['config', 'core.sshCommand', 'ssh -i /keys/node -o ProxyJump=bastion'], { cwd: appRoot });
    assert.deepEqual(resolveGovernedSshCommand({ env: {}, appRoot }), {
        command: `ssh -i /keys/node -o ProxyJump=bastion ${governed}`, source: 'core.sshCommand', conflict: null,
    });
    assert.equal(releaseGitEnvironment({}, { appRoot }).GIT_SSH_COMMAND, `ssh -i /keys/node -o ProxyJump=bastion ${governed}`);
    // GIT_SSH_COMMAND outranks core.sshCommand, exactly as it does in git.
    assert.equal(resolveGovernedSshCommand({ env: { GIT_SSH_COMMAND: 'ssh -p 443' }, appRoot }).source, 'GIT_SSH_COMMAND');

    let fetchEnv = null;
    const fake = governedRunner({ onFetch: ({ options }) => { fetchEnv = options.env; } });
    const update = createSourceUpdater({
        appRoot, activeSessionCount: () => 0, commandRunner: fake.runner, env: { PATH: process.env.PATH },
    });
    await update('1.42.0.1');
    assert.equal(fetchEnv.GIT_SSH_COMMAND, `ssh -i /keys/node -o ProxyJump=bastion ${governed}`,
        'the release fetch itself carries the composed command');
});

test('an ssh command that weakens host-key checking is refused by name before any git command (H5)', async (t) => {
    for (const unsafe of ['ssh -o StrictHostKeyChecking=no', 'ssh -oBatchMode=no', 'ssh -o "StrictHostKeyChecking accept-new"']) {
        assert.match(resolveGovernedSshCommand({ env: { GIT_SSH_COMMAND: unsafe } }).conflict, /=(no|accept-new)$/, unsafe);
    }
    assert.equal(resolveGovernedSshCommand({ env: { GIT_SSH_COMMAND: 'ssh -o StrictHostKeyChecking=yes' } }).conflict, null);

    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    execFileSync('git', ['config', 'core.sshCommand', 'ssh -i /keys/node -o StrictHostKeyChecking=no'], { cwd: appRoot });
    const fake = governedRunner();
    const update = createSourceUpdater({
        appRoot, activeSessionCount: () => 0, commandRunner: fake.runner, env: { PATH: process.env.PATH },
    });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'ssh_command_conflict' && error.status === 409
        && /core\.sshCommand/.test(error.message) && /StrictHostKeyChecking=no/.test(error.message));
    assert.equal(fake.calls.length, 0, 'refused before the first git command');
});

test('source updater ignores legacy release variables and never passes their token to Git', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const legacyToken = 'SYNTHETIC_ONLY_UPDATE_TOKEN';
    const fake = governedRunner({
        onFetch: ({ options }) => assert.equal(JSON.stringify(options.env).includes(legacyToken), false),
    });
    const update = createSourceUpdater({
        appRoot,
        activeSessionCount: () => 0,
        commandRunner: fake.runner,
        env: { NASSAJ_RELEASE_CHANNEL: 'legacy', NASSAJ_SOURCE_REPOSITORY_URL: 'https://github.com/example/legacy-release', [['NASSAJ', 'UPDATE', 'GITHUB', 'TOKEN'].join('_')]: legacyToken },
    });
    await update('1.42.0.1');
    assert.equal(fake.calls.some(({ command }) => command === 'gh'), false);
});

const TMPFS = 0x01021994;
const EXT4 = 0xef53;

test('assertUpdateStorage rejects insufficient disk, tmpfs candidate root and tmpfs TMPDIR (T-1553)', () => {
    const appRoot = fixture();
    try {
        // Ample free space on a non-tmpfs device passes.
        assert.doesNotThrow(() => assertUpdateStorage({
            appRoot, env: { TMPDIR: '/var/tmp' },
            statfs: () => ({ type: EXT4, bavail: 4_000_000, bsize: 4096 }),
        }));
        // Below the minimum free bytes is rejected before any work.
        assert.throws(() => assertUpdateStorage({
            appRoot, env: { TMPDIR: '/var/tmp', NASSAJ_UPDATE_MIN_FREE_BYTES: String(8 * 1024 ** 3) },
            statfs: () => ({ type: EXT4, bavail: 100, bsize: 4096 }),
        }), (error) => error instanceof SourceUpdateError && error.code === 'insufficient_disk' && error.status === 507);
        // A tmpfs candidate root (source device) is rejected. The candidate root
        // lives under appRoot; the build TMPDIR is a distinct non-tmpfs path.
        assert.throws(() => assertUpdateStorage({
            appRoot, env: { TMPDIR: '/var/tmp' },
            statfs: (target) => ({ type: String(target).startsWith(appRoot) ? TMPFS : EXT4, bavail: 4_000_000, bsize: 4096 }),
        }), (error) => error.code === 'tmpfs_candidate_root');
        // A build TMPDIR redirected to tmpfs is rejected.
        assert.throws(() => assertUpdateStorage({
            appRoot, env: { TMPDIR: '/tmp' },
            statfs: (target) => ({ type: String(target).startsWith('/tmp') ? TMPFS : EXT4, bavail: 4_000_000, bsize: 4096 }),
        }), (error) => error.code === 'tmpfs_build_tmpdir');
    } finally { fs.rmSync(appRoot, { recursive: true, force: true }); }
});

test('the storage gate rejects before any git command runs (T-1553)', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    let calls = 0;
    const update = createSourceUpdater({
        appRoot, activeSessionCount: () => 0,
        commandRunner: async () => { calls += 1; return response(); },
        statfs: () => ({ type: EXT4, bavail: 1, bsize: 4096 }),
    });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'insufficient_disk');
    assert.equal(calls, 0);
});

test('a failed candidate build removes its transient candidate directory (T-1553)', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner({ candidateCode: 1 });
    const update = createSourceUpdater({ appRoot, activeSessionCount: () => 0, commandRunner: fake.runner });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'candidate_build_failed');
    const candidatesRoot = path.join(appRoot, '.git', 'nassaj-source-update', 'candidates');
    const leftovers = fs.existsSync(candidatesRoot) ? fs.readdirSync(candidatesRoot) : [];
    assert.deepEqual(leftovers, [], 'the transient candidate directory must be cleaned up on failure');
});

test('storage blockers carry an operator remedy in their message (T-1553 م1)', () => {
    const appRoot = fixture();
    try {
        const tmp = evaluateUpdateStorage({
            appRoot, env: { TMPDIR: '/tmp' },
            statfs: (target) => ({ type: String(target).startsWith('/tmp') ? TMPFS : EXT4, bavail: 4_000_000, bsize: 4096 }),
        });
        assert.equal(tmp.ok, false);
        assert.equal(tmp.code, 'tmpfs_build_tmpdir');
        assert.match(tmp.message, /TMPDIR/);
        assert.match(tmp.message, /\/var\/tmp/);
        assert.match(tmp.message, /safe restart/i);

        const low = evaluateUpdateStorage({
            appRoot, env: { TMPDIR: '/var/tmp', NASSAJ_UPDATE_MIN_FREE_BYTES: String(8 * 1024 ** 3) },
            statfs: () => ({ type: EXT4, bavail: 10, bsize: 4096 }),
        });
        assert.equal(low.code, 'insufficient_disk');
        assert.match(low.message, /free disk|Free space/i);
        assert.ok(Number.isSafeInteger(low.availableBytes) && Number.isSafeInteger(low.requiredBytes));
        assert.ok(low.availableBytes < low.requiredBytes);
        assert.equal(low.availableBytes, 10 * 4096);
        assert.ok(low.requiredBytes >= 8 * 1024 ** 3);
        assert.equal(publicStorageFigures(tmp), null, 'tmpfs blockers carry no storage figures');
        assert.equal('availableBytes' in tmp, false);

        assert.deepEqual(evaluateUpdateStorage({
            appRoot, env: { TMPDIR: '/var/tmp' },
            statfs: () => ({ type: EXT4, bavail: 4_000_000, bsize: 4096 }),
        }), { ok: true });
    } finally { fs.rmSync(appRoot, { recursive: true, force: true }); }
});

test('publicStorageFigures coarsens insufficient_disk figures to whole MiB and ignores other codes', () => {
    const MiB = 1024 * 1024;
    assert.deepEqual(publicStorageFigures({
        ok: false, code: 'insufficient_disk', availableBytes: 5 * MiB + 123, requiredBytes: 7 * MiB + 1,
    }), { availableBytes: 5 * MiB, requiredBytes: 8 * MiB });
    assert.deepEqual(publicStorageFigures({
        ok: false, code: 'insufficient_disk', availableBytes: 3 * MiB, requiredBytes: 4 * MiB,
    }), { availableBytes: 3 * MiB, requiredBytes: 4 * MiB });
    for (const other of [{ ok: true }, { ok: false, code: 'tmpfs_build_tmpdir' }, { ok: false, code: 'storage_probe_failed' },
        { ok: false, code: 'insufficient_disk' }, null, undefined]) {
        assert.equal(publicStorageFigures(other), null);
    }
});

test('capacity sums candidate and TMPDIR requirements on a shared device', () => {
    const appRoot = fixture();
    try {
        assert.throws(() => assertUpdateStorage({ appRoot,
            env: { TMPDIR: appRoot, DATABASE_PATH: path.join(appRoot, 'absent.sqlite'), NASSAJ_UPDATE_MIN_FREE_BYTES: String(1024 ** 3) },
            statfs: () => ({ type: EXT4, bavail: 400000, bsize: 4096 }),
        }), error => error.code === 'insufficient_disk');
        assert.throws(() => assertUpdateStorage({ appRoot, env: { TMPDIR: appRoot },
            statfs: () => ({ type: EXT4, bavail: NaN, bsize: 4096 }),
        }), error => error.code === 'storage_probe_failed');
    } finally { fs.rmSync(appRoot, { recursive: true, force: true }); }
});

test('independent DB or TMPDIR device exhaustion rejects despite ample candidate space', () => {
    const appRoot = fixture();
    try {
        const databaseRoot = path.join(appRoot, 'database');
        const temporaryRoot = path.join(appRoot, 'temporary');
        fs.mkdirSync(databaseRoot); fs.mkdirSync(temporaryRoot);
        for (const exhausted of [databaseRoot, temporaryRoot]) {
            assert.throws(() => assertUpdateStorage({ appRoot,
                env: { TMPDIR: temporaryRoot, DATABASE_PATH: path.join(databaseRoot, 'db.sqlite') },
                stat: target => ({ dev: target === databaseRoot ? 2 : target === temporaryRoot ? 3 : 1 }),
                statfs: target => ({ type: EXT4, bavail: target === exhausted ? 1 : 4000000, bsize: 4096 }),
            }), error => error.code === 'insufficient_disk');
        }
        // The reported figures belong to the device with the largest shortfall.
        const result = evaluateUpdateStorage({ appRoot,
            env: { TMPDIR: temporaryRoot, DATABASE_PATH: path.join(databaseRoot, 'db.sqlite') },
            stat: target => ({ dev: target === databaseRoot ? 2 : target === temporaryRoot ? 3 : 1 }),
            statfs: target => ({ type: EXT4, bavail: target === temporaryRoot ? 1 : target === databaseRoot ? 2 : 4000000, bsize: 4096 }),
        });
        assert.equal(result.code, 'insufficient_disk');
        assert.equal(result.availableBytes, 4096, 'TMPDIR device (2 GiB short) outranks the DB device (~16 MiB short)');
        assert.equal(result.requiredBytes, 2 * 1024 ** 3);
    } finally { fs.rmSync(appRoot, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// B-1585 — lease renewal across long synchronous steps, cleanup of a fenced
// candidate, and the equal-target guard.
// ---------------------------------------------------------------------------

/** A lease on a fake clock: assertFence is strict; renewLease is the owner CAS. */
function fakeLease({ leaseMs = 30_000 } = {}) {
    const state = { now: 0, expiresAt: leaseMs, owned: true, renewals: 0 };
    const controller = new AbortController();
    const fencedError = () => {
        controller.abort(new Error('source_update_worker_fenced'));
        return new Error('source_update_worker_fenced');
    };
    const assertFence = () => {
        if (controller.signal.aborted || !state.owned || state.now >= state.expiresAt) throw fencedError();
        return true;
    };
    const renewLease = () => {
        if (controller.signal.aborted || !state.owned) throw fencedError();
        state.renewals += 1;
        state.expiresAt = state.now + leaseMs;
        return assertFence();
    };
    return { state, signal: controller.signal, assertFence, renewLease };
}

test('B-1585: the lease is renewed across a long synchronous step instead of lapsing', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner();
    const lease = fakeLease();
    const update = createSourceUpdater({
        appRoot, activeSessionCount: () => 0, commandRunner: fake.runner,
        // The planner is synchronous: the event loop (and the heartbeat) is blocked for 40s.
        sourcePlanner: () => { lease.state.now += 40_000; return { paths: 0 }; },
    });
    const result = await update('1.42.0.1', { signal: lease.signal, assertFence: lease.assertFence, renewLease: lease.renewLease });
    assert.equal(result.commit, fake.release);
    assert.ok(lease.state.renewals >= 4, `renewed around each heavy step (${lease.state.renewals})`);
});

test('B-1585: without renewLease the same long step still fences strictly', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner();
    const lease = fakeLease();
    const update = createSourceUpdater({
        appRoot, activeSessionCount: () => 0, commandRunner: fake.runner,
        sourcePlanner: () => { lease.state.now += 40_000; return { paths: 0 }; },
    });
    await assert.rejects(update('1.42.0.1', { signal: lease.signal, assertFence: lease.assertFence }),
        /source_update_worker_fenced/);
});

test('B-1585: a genuinely lost lease aborts, then removes only its own private candidate and refs', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner();
    const lease = fakeLease();
    const runner = async (command, args, options) => {
        const result = await fake.runner(command, args, options);
        // Another worker takes over while the candidate is being built.
        if (command === process.execPath && args.includes('--plan')) lease.state.owned = false;
        return result;
    };
    const queued = [];
    const update = createSourceUpdater({
        appRoot, activeSessionCount: () => 0, commandRunner: runner,
        queueRestartAction: async (action) => { queued.push(action); return true; },
    });
    await assert.rejects(update('1.42.0.1', { signal: lease.signal, assertFence: lease.assertFence, renewLease: lease.renewLease }),
        /source_update_worker_fenced/);
    assert.deepEqual(queued, []);
    const candidates = path.join(appRoot, '.git', 'nassaj-source-update', 'candidates');
    assert.deepEqual(fs.existsSync(candidates) ? fs.readdirSync(candidates) : [], []);
    const removed = fake.calls.filter(({ args }) => args.includes('worktree') && args.includes('remove'));
    assert.equal(removed.length, 1);
    assert.match(removed[0].args.at(-1), /\/candidates\/update-[^/]+\/source$/);
    const refs = fake.calls.filter(({ args }) => args.includes('update-ref') && args.includes('-d')).map(({ args }) => args.at(-1));
    assert.equal(refs.length, 2);
    assert.ok(refs.every((ref) => ref.startsWith('refs/nassaj-update/')));
});

test('B-1585: a release equal to the loaded runtime commit is refused before any staging', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner();
    const update = createSourceUpdater({
        appRoot, activeSessionCount: () => 0, commandRunner: fake.runner,
        loadedRuntimeCommit: () => fake.release,
    });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'source_update_target_already_loaded');
    assert.equal(fake.calls.some(({ args }) => args.includes('worktree') && args.includes('add')), false);
    assert.equal(fake.calls.some(({ command, args }) => command === process.execPath && args.includes('--plan')), false);
});

/** The governed runner, with the ancestry of the release against `loaded` under test control. */
function ancestryRunner(fake, { loaded, releaseInLoaded = false, fastForward = true }) {
    return async (command, args, options) => {
        const joined = args.join(' ');
        if (joined.includes('merge-base --is-ancestor') && args.at(-1) === loaded) {
            fake.calls.push({ command, args, options });
            return response('', releaseInLoaded ? 0 : 1);
        }
        if (joined.includes('merge-base --is-ancestor') && !joined.includes('/branch') && !fastForward) {
            fake.calls.push({ command, args, options });
            return response('', 1);
        }
        return fake.runner(command, args, options);
    };
}

/** A one-job store for driving the real worker over the real updater. */
function singleJobStore(state = 'staging') {
    const job = {
        id: 'job-ancestor', state, worker_fence: 3, expected_version: '1.42.0.1', strategy: 'git-checkout-v2',
        release_id: '1', release_tag: 'v1.42.0.1', release_asset_id: '1', release_asset_name: 'source',
        release_asset_size: 1, release_asset_sha256: 'e'.repeat(64), release_commit: 'b'.repeat(40),
    };
    let claimable = true;
    return {
        job,
        claim() { if (!claimable) return null; claimable = false; return { ...job }; },
        renew: () => true, assertFence: () => true, release: () => true,
        listRuntimeReferences: () => [], listReceipts: () => [],
        appendReceipt: (_id, fence) => ({ sequence: 1, factsJson: '{}', factsSha256: 'f'.repeat(64), workerFence: fence }),
        transition(_id, _fence, expected, next, fields = {}) {
            if (!expected.includes(job.state)) return false;
            job.state = next; Object.assign(job, fields); return true;
        },
    };
}

test('B-1585: a node already running a newer release refuses the older target before any build', async (t) => {
    // The node was installed to 2.3.1.3 (loaded) while a job for 2.3.1.2 (release) was stranded.
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner();
    const loaded = 'd'.repeat(40);
    const queued = [];
    const update = createSourceUpdater({
        appRoot, activeSessionCount: () => 0, loadedRuntimeCommit: () => loaded,
        commandRunner: ancestryRunner(fake, { loaded, releaseInLoaded: true }),
        queueRestartAction: async (action) => { queued.push(action); return true; },
    });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'source_update_target_not_newer' && error.status === 409);
    assert.ok(fake.calls.some(({ args }) => args.join(' ') === `-c core.hooksPath=/dev/null merge-base --is-ancestor ${fake.release} ${loaded}`));
    assert.equal(fake.calls.some(({ args }) => args.includes('worktree') && args.includes('add')), false);
    assert.deepEqual(queued, []);
});

test('B-1585: the worker settles a stranded older-target job superseded, never failed and never queued', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner();
    const loaded = 'd'.repeat(40);
    const queued = [];
    const update = createSourceUpdater({
        appRoot, activeSessionCount: () => 0, loadedRuntimeCommit: () => loaded,
        commandRunner: ancestryRunner(fake, { loaded, releaseInLoaded: true }),
        queueRestartAction: async (action) => { queued.push(action); return true; },
    });
    const jobs = singleJobStore('staging');
    const worker = createSourceUpdateWorker({
        jobs, identity: { workerId: 'w', pid: 1, startTicks: '1', bootId: 'b', pgid: 1 },
        loadedRuntimeCommit: () => loaded,
        resolveRelease: async () => { throw new Error('must not resolve'); },
        runUpdate: (job, _release, context) => update(job.expected_version, {
            signal: context.signal, assertFence: context.assertFence, renewLease: context.renewLease,
        }),
    });
    assert.equal(await worker.processOne(), false);
    assert.equal(jobs.job.state, 'superseded');
    assert.equal(jobs.job.error_code, 'source_update_target_not_newer');
    assert.equal(fake.calls.some(({ command, args }) => command === process.execPath && args.includes('--plan')), false);
    assert.deepEqual(queued, []);
});

test('B-1585: a target not contained in the loaded runtime still stages normally', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner();
    const loaded = 'd'.repeat(40);
    const update = createSourceUpdater({
        appRoot, activeSessionCount: () => 0, loadedRuntimeCommit: () => loaded,
        commandRunner: ancestryRunner(fake, { loaded, releaseInLoaded: false }),
    });
    const result = await update('1.42.0.1');
    assert.equal(result.commit, fake.release);
});

test('non_fast_forward: a release the source HEAD is not an ancestor of is refused before any build', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = governedRunner();
    const update = createSourceUpdater({
        appRoot, activeSessionCount: () => 0,
        commandRunner: ancestryRunner(fake, { loaded: null, fastForward: false }),
    });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'non_fast_forward' && error.status === 409);
    assert.ok(fake.calls.some(({ args }) => args.join(' ').endsWith(`merge-base --is-ancestor ${fake.original} ${fake.release}`)));
    assert.equal(fake.calls.some(({ args }) => args.includes('worktree') && args.includes('add')), false);
});

for (const [outcome, released] of [['failed', true], ['not_owner', false], [undefined, false]]) {
    test(`B-1585: a fenced attempt fails its release waiter only when the job is proven terminal (${outcome})`, async (t) => {
        const appRoot = fixture();
        t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
        const fake = governedRunner();
        const lease = fakeLease();
        const runner = async (command, args, options) => {
            const result = await fake.runner(command, args, options);
            if (command === process.execPath && args.includes('--plan')) lease.state.owned = false;
            return result;
        };
        const settleCalls = [];
        const update = createSourceUpdater({ appRoot, activeSessionCount: () => 0, commandRunner: runner });
        await assert.rejects(update('1.42.0.1', {
            signal: lease.signal, assertFence: lease.assertFence, renewLease: lease.renewLease,
            ...(outcome ? { settleLostLease: async () => { settleCalls.push(1); return outcome; } } : {}),
        }), /source_update_worker_fenced/);
        assert.equal(settleCalls.length, outcome ? 1 : 0);
        assert.equal(readClientPublicationBlockers(appRoot).fullUpdates.length, released ? 0 : 1);
    });
}

/** A real repository with a linear history base -> mid -> tip, for B-1625. */
function trackingRepository(t) {
    const root = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-tracking-ref-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sh = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    sh('init', '-q', '-b', 'main');
    sh('config', 'user.email', 'tracking@example.invalid');
    sh('config', 'user.name', 'Tracking');
    const commits = {};
    for (const name of ['base', 'mid', 'tip']) {
        sh('commit', '-q', '--allow-empty', '-m', name);
        commits[name] = sh('rev-parse', 'HEAD');
    }
    const git = async (args) => {
        try { return { code: 0, stdout: execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }; }
        catch (error) { return { code: error.status ?? 1, stdout: '' }; }
    };
    return { sh, git, commits };
}

test('B-1625: the tracking ref advances to the fetched branch by fast-forward', async (t) => {
    const { sh, git, commits } = trackingRepository(t);
    sh('update-ref', 'refs/remotes/origin/main', commits.base);
    sh('update-ref', 'refs/nassaj-update/n/branch', commits.tip);
    const outcome = await advanceRemoteTrackingRef({ git, remote: 'origin', branch: 'main', fetchedRef: 'refs/nassaj-update/n/branch' });
    assert.equal(outcome, 'advanced');
    assert.equal(sh('rev-parse', 'refs/remotes/origin/main'), commits.tip);
    assert.equal(await advanceRemoteTrackingRef({ git, remote: 'origin', branch: 'main', fetchedRef: 'refs/nassaj-update/n/branch' }), 'unchanged');
});

test('B-1625: the tracking ref is created when absent and never rewound', async (t) => {
    const { sh, git, commits } = trackingRepository(t);
    sh('update-ref', 'refs/nassaj-update/n/branch', commits.mid);
    assert.equal(await advanceRemoteTrackingRef({ git, remote: 'origin', branch: 'main', fetchedRef: 'refs/nassaj-update/n/branch' }), 'advanced');
    assert.equal(sh('rev-parse', 'refs/remotes/origin/main'), commits.mid);

    sh('update-ref', 'refs/remotes/origin/main', commits.tip);
    const lines = [];
    const outcome = await advanceRemoteTrackingRef({
        git, remote: 'origin', branch: 'main', fetchedRef: 'refs/nassaj-update/n/branch', log: (line) => lines.push(line),
    });
    assert.equal(outcome, 'not_fast_forward');
    assert.equal(sh('rev-parse', 'refs/remotes/origin/main'), commits.tip, 'a newer tracking ref is never rewound');
    assert.match(lines.join(''), /left unchanged \(not_fast_forward\)/);
});

test('B-1625: a failing git never throws out of the tracking-ref advance', async () => {
    const lines = [];
    const outcome = await advanceRemoteTrackingRef({
        git: async () => { throw new Error('spawn failed'); }, remote: 'origin', branch: 'main',
        fetchedRef: 'refs/nassaj-update/n/branch', log: (line) => lines.push(line),
    });
    assert.equal(outcome, 'git_failed');
    assert.equal(lines.length, 1);
    assert.equal(await advanceRemoteTrackingRef({
        git: async () => ({ code: 1, stdout: '' }), remote: 'origin', branch: 'main', fetchedRef: 'refs/x',
    }), 'fetched_ref_unavailable');
});

/** The governed fake, plus the two reads the B-1625 tracking-ref advance needs. */
function trackingAwareRunner(options) {
    const fake = governedRunner(options);
    const runner = async (command, args, runOptions) => {
        const joined = args.join(' ');
        if (joined.includes('rev-parse --verify --quiet') && joined.includes('/branch^{commit}')) {
            fake.calls.push({ command, args, options: runOptions });
            return response(`${fake.release}\n`);
        }
        if (joined.includes('rev-parse --verify --quiet refs/remotes/origin/main^{commit}')) {
            fake.calls.push({ command, args, options: runOptions });
            return response(`${fake.original}\n`);
        }
        return fake.runner(command, args, runOptions);
    };
    return { ...fake, runner };
}

const updateRefCalls = (calls) => calls
    .map(({ args }, index) => ({ index, args: args.slice(args.indexOf('update-ref')) }))
    .filter(({ args }) => args[0] === 'update-ref');

test('B-1625: a successful update advances origin/main before dropping its private refs', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = trackingAwareRunner();
    const update = createSourceUpdater({ appRoot, activeSessionCount: () => 0, commandRunner: fake.runner });
    assert.equal((await update('1.42.0.1')).success, true);
    const refs = updateRefCalls(fake.calls);
    const advance = refs.find(({ args }) => args.includes('refs/remotes/origin/main'));
    assert.ok(advance, 'the tracking ref is advanced');
    assert.deepEqual(advance.args.slice(-3), ['refs/remotes/origin/main', fake.release, fake.original], 'CAS on the old value');
    const dropBranch = refs.find(({ args }) => args[1] === '-d' && args[2].endsWith('/branch'));
    assert.ok(dropBranch, 'the private branch ref is dropped');
    assert.ok(advance.index < dropBranch.index, 'advance happens while the fetched ref still exists');
});

test('B-1625: a failed candidate build never touches origin/main', async (t) => {
    const appRoot = fixture();
    t.after(() => fs.rmSync(appRoot, { recursive: true, force: true }));
    const fake = trackingAwareRunner({ candidateCode: 1 });
    const update = createSourceUpdater({ appRoot, activeSessionCount: () => 0, commandRunner: fake.runner });
    await assert.rejects(update('1.42.0.1'), (error) => error.code === 'candidate_build_failed');
    assert.equal(updateRefCalls(fake.calls).some(({ args }) => args.includes('refs/remotes/origin/main')), false);
    assert.equal(fake.calls.some(({ args }) => args.join(' ').includes('refs/remotes/origin/main')), false);
});

test('B-1625: a throw after update-ref was spawned logs "may be unchanged"', async () => {
    const lines = [];
    const git = async (args) => {
        if (args[0] === 'update-ref') throw new Error('fence lost');
        if (args.join(' ').includes('/branch^{commit}')) return { code: 0, stdout: `${'b'.repeat(40)}\n` };
        return { code: 1, stdout: '' };
    };
    const outcome = await advanceRemoteTrackingRef({ git, remote: 'origin', branch: 'main', fetchedRef: 'refs/x/branch', log: (line) => lines.push(line) });
    assert.equal(outcome, 'git_failed');
    assert.match(lines.join(''), /may be unchanged \(git_failed\)/);
});
