/**
 * ADR-216 §6 test 11 — the installer's `release-checkout` step on real git
 * repositories (the rest of the installer keeps its injected `spawn`).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { defaultGitCheckoutProbe } from '../server/services/source-updater.js';

import { installNode, runReleaseCheckoutStep } from './install-node.mjs';
import { runUpdatePreflightChecks } from './lib/update-preflight-checks.mjs';
import {
    GITHUB_REMOTE, TAG, cloneAttached, cloneFedora, createRemote, git, remoteEnv, scratch, tryGit,
} from './lib/release-branch-attach.test-fixture.mjs';

const SOURCE_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const META_KEYS = [
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
    'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT',
    'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt',
];

function node(t, prefix, shape = 'fedora', at = TAG) {
    const root = scratch(t, prefix);
    const remote = createRemote(root);
    const appRoot = shape === 'fedora' ? cloneFedora(root, remote.bare) : cloneAttached(root, remote.bare, { at });
    const env = { ...remoteEnv(root, remote.bare), DATABASE_PATH: path.join(root, 'absent.db') };
    return { root, remote, appRoot, env };
}

const step = (ctx, overrides = {}) => runReleaseCheckoutStep({
    appRoot: ctx.appRoot, remote: 'origin', branch: 'main', configuredRemoteUrl: GITHUB_REMOTE, env: ctx.env,
    databasePath: ctx.env.DATABASE_PATH, ...overrides,
});

/** The pre-flight's detached_head finding on the real repository (other probes stubbed). */
async function detachedHeadCheck(ctx) {
    const result = await runUpdatePreflightChecks({
        appRoot: ctx.appRoot, env: ctx.env, activeSessionCount: () => 0, listPm2Processes: async () => [],
        readLiveProcessEnv: async () => ({}), exchangeProbe: async () => true, listQueuedSafeRestarts: () => [],
    });
    return result.checks.find((check) => check.code === 'detached_head');
}

/** The installer's other steps, faked as in install-node.test.mjs. */
function fakeSpawn() {
    return (command, args) => {
        if (command === 'git' && args.includes('get-url')) return { status: 0, stdout: GITHUB_REMOTE, stderr: '' };
        if (command === 'git' && args.includes('check-ignore')) return { status: 0, stdout: args.slice(args.indexOf('--') + 1).join('\n'), stderr: '' };
        if (command === 'ssh') return { status: 1, stdout: '', stderr: "Hi node! You've successfully authenticated" };
        if (command === process.execPath) return { status: 0, stdout: 'update pre-flight: ok', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
    };
}

/** The tracked files the installer's later steps read (untracked here, which an attach allows). */
function copyInstallerInputs(appRoot) {
    for (const file of ['scripts/pm2-entry.mjs', 'scripts/nassaj-release-launcher.mjs', 'ecosystem.config.example.cjs',
        'scripts/lib/pm2-install-layout.cjs']) {
        fs.mkdirSync(path.dirname(path.join(appRoot, file)), { recursive: true });
        fs.copyFileSync(path.join(SOURCE_ROOT, file), path.join(appRoot, file));
    }
}

test('11 a detached eligible clone is repaired by the full installer; the capability probe is then ready', async (t) => {
    const ctx = node(t, 'install-detached');
    copyInstallerInputs(ctx.appRoot);
    const detachedCheck = await detachedHeadCheck(ctx);
    assert.equal(detachedCheck.severity, 'blocker');
    assert.equal(detachedCheck.command, 'npm run doctor -- --attach-release-branch');
    const homeDir = scratch(t, 'install-home');
    const result = await installNode({
        appRoot: ctx.appRoot, homeDir, node: 'demo', env: { ...ctx.env, USER: 'svc' }, spawn: fakeSpawn(),
        databasePath: ctx.env.DATABASE_PATH,
        fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ssh_keys: META_KEYS }) }),
        confirm: async () => true, output: { write: () => {} },
    });
    const checkout = result.steps.find((entry) => entry.step === 'release-checkout');
    assert.equal(checkout.shape, 'detached');
    assert.equal(checkout.repaired, true);
    assert.equal(git(ctx.appRoot, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
    assert.equal(defaultGitCheckoutProbe({ appRoot: ctx.appRoot, remote: 'origin', branch: 'main' }).ready, true);
    // t4: the lease created the gate's control files inside .git (OPEN, sequence 0) — no untracked trace.
    const journal = JSON.parse(fs.readFileSync(path.join(ctx.appRoot, '.git', 'nassaj-source-update', 'journal.json'), 'utf8'));
    assert.deepEqual([journal.state, journal.sequence], ['OPEN', 0]);
    assert.ok(fs.existsSync(path.join(ctx.appRoot, '.git', 'nassaj-source-update', 'token')));
    const untracked = git(ctx.appRoot, ['status', '--porcelain', '--untracked-files=all']).split('\n')
        .filter((line) => line.startsWith('??') && !/ (config|dist|dist-server|scripts)\/|ecosystem\.config\.example/.test(line));
    assert.deepEqual(untracked, [], 'nothing the release-checkout step wrote is untracked');
    assert.equal((await detachedHeadCheck(ctx)).severity, 'ok', 'the final pre-flight no longer reports detached_head');
});

test('11 a detached ineligible clone stops the install with release_checkout_invalid and nothing in config/', async (t) => {
    const ctx = node(t, 'install-dirty');
    fs.appendFileSync(path.join(ctx.appRoot, 'README.md'), 'local edit\n');
    const homeDir = scratch(t, 'install-home');
    await assert.rejects(installNode({
        appRoot: ctx.appRoot, homeDir, node: 'demo', env: { ...ctx.env, USER: 'svc' }, spawn: fakeSpawn(),
        fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ssh_keys: META_KEYS }) }),
        confirm: async () => true, output: { write: () => {} },
    }), (error) => error.code === 'release_checkout_invalid' && /dirty_worktree/.test(error.message));
    assert.deepEqual(fs.readdirSync(path.join(ctx.appRoot, 'config')), []);
    assert.equal(tryGit(ctx.appRoot, ['symbolic-ref', '-q', 'HEAD']).ok, false, 'never finished on a detached HEAD');
});

test('11 attached on main at the release commit passes; upstream config and tracking are kept', async (t) => {
    const ctx = node(t, 'install-attached', 'attached');
    const outcome = await step(ctx);
    assert.equal(outcome.shape, 'attached');
    assert.equal(outcome.head, ctx.remote.tagCommit);
    assert.equal(git(ctx.appRoot, ['config', 'branch.main.merge']), 'refs/heads/main');
});

test('11 attached on main at a non-release commit: install_head_not_release in release mode, accepted in local-main', async (t) => {
    const ctx = node(t, 'install-nonrelease', 'attached', 'main~1');
    await assert.rejects(step(ctx, { updateMode: 'release' }), { code: 'install_head_not_release' });
    const local = await step(ctx, { updateMode: 'local-main' });
    assert.equal(local.shape, 'attached');
});

test('11 another branch is refused release_checkout_invalid', async (t) => {
    const ctx = node(t, 'install-branch', 'attached');
    git(ctx.appRoot, ['checkout', '-q', '-b', 'feature']);
    await assert.rejects(step(ctx), (error) => error.code === 'release_checkout_invalid' && /wrong_branch/.test(error.message));
});

test('11 an attached checkout without upstream gets it set and the tracking ref created when absent', async (t) => {
    const ctx = node(t, 'install-upstream', 'attached');
    git(ctx.appRoot, ['branch', '--unset-upstream']);
    git(ctx.appRoot, ['update-ref', '-d', 'refs/remotes/origin/main']);
    const outcome = await step(ctx);
    assert.equal(outcome.upstreamChanged, true);
    assert.equal(outcome.tracking, 'advanced');
    assert.equal(git(ctx.appRoot, ['rev-parse', 'refs/remotes/origin/main']), ctx.remote.mainTip);
});

test('11 --unshallow deepens a repaired shallow clone', async (t) => {
    const ctx = node(t, 'install-unshallow');
    const outcome = await step(ctx, { unshallow: true });
    assert.equal(outcome.repaired, true);
    assert.equal(outcome.unshallowed, true);
    assert.equal(git(ctx.appRoot, ['rev-parse', '--is-shallow-repository']), 'false');
});

test('11 (M2) attached + dirty tracked tree is refused release_checkout_invalid in both modes', async (t) => {
    const ctx = node(t, 'install-attached-dirty', 'attached');
    fs.appendFileSync(path.join(ctx.appRoot, 'README.md'), 'local edit\n');
    for (const updateMode of ['release', 'local-main']) {
        await assert.rejects(step(ctx, { updateMode }),
            (error) => error.code === 'release_checkout_invalid' && /dirty_worktree/.test(error.message), updateMode);
    }
});
