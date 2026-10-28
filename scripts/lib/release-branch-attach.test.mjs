/**
 * ADR-216 §6 — the shared re-attach library on real git repositories.
 *
 * Remotes are bare repositories served over a fake ssh transport under the
 * GitHub-shaped URL the configured release source names (see the fixture for
 * why `insteadOf` cannot be used). Every refusal asserts that nothing changed:
 * every ref, `.git/config`, HEAD and `.git/shallow`.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { defaultGitCheckoutProbe, proveTagOnBranch } from '../../server/services/source-updater.js';
import { createUpdateMaintenanceGate } from '../../server/services/update-maintenance-gate.js';
import { readPrestageSlotState } from '../../server/services/update-prestager.js';
import { canonicalJson, sha256Hex } from '../../server/services/update-prestage-identity.js';

import { releasePolicyRequiresVerification } from '../../server/services/update-prestager.js';

import {
    cliRequiresVerifiedRelease, createCliQuiescenceReader, createCliRevertJobs, readStoredPrestageSettingsReadOnly, runDoctorAttach,
} from './doctor-release-attach.mjs';
import {
    ATTACH_RECEIPT_DIR, SOURCE_REF_LEASE, acquireSourceAttachLock, applyReleaseAttachment, createAttachGit,
    evaluateAttachQuiescence, inspectReleaseCheckout, listAttachReceipts, readAttachReceipt, refspecMapsBranch,
    revertReleaseAttachment, runReleaseAttachment,
} from './release-branch-attach.mjs';
import {
    GITHUB_REMOTE, TAG, cloneAttached, cloneFedora, createPublicExportRemote, createRemote, git, idleQuiescence,
    refSnapshot, remoteEnv, scratch, tryGit, worktreeMtimes,
} from './release-branch-attach.test-fixture.mjs';
import { runUpdatePreflightChecks } from './update-preflight-checks.mjs';

const controlRootOf = (node) => path.join(node, '.git', 'nassaj-source-update');
const receiptDirOf = (node) => path.join(controlRootOf(node), ATTACH_RECEIPT_DIR);
const realLease = (node) => (options) => createUpdateMaintenanceGate({ projectPath: node }).acquireExclusiveSourceRefLease(options);

/** One Fedora-shaped node with its remote and governed runner. */
function fedora(t, prefix, remoteOptions = {}) {
    const root = scratch(t, prefix);
    const remote = createRemote(root, remoteOptions);
    const node = cloneFedora(root, remote.bare);
    const env = remoteEnv(root, remote.bare);
    return { root, remote, node, env, run: createAttachGit({ appRoot: node, env }) };
}

function attach(ctx, overrides = {}) {
    return runReleaseAttachment({
        appRoot: ctx.node, controlRoot: controlRootOf(ctx.node), remote: 'origin', branch: 'main',
        configuredRemoteUrl: GITHUB_REMOTE, git: ctx.run, acquireLease: realLease(ctx.node),
        readQuiescence: idleQuiescence(), ...overrides,
    });
}

const privateRefs = (node) => git(node, ['for-each-ref', 'refs/nassaj-attach']);

/** The snapshot minus the gate's own control files (created by the lease, t4). */
function assertUnchanged(node, before, label) {
    assert.deepEqual(refSnapshot(node), before, `${label}: refs/config/HEAD/shallow changed`);
    assert.equal(privateRefs(node), '', `${label}: private refs left behind`);
}

test('1 Fedora reproduction: a shallow detached tag clone is attached in place', async (t) => {
    const ctx = fedora(t, 'fedora');
    const shallowBefore = fs.readFileSync(path.join(ctx.node, '.git', 'shallow'), 'utf8');
    const mtimes = worktreeMtimes(ctx.node);
    const inspection = await inspectReleaseCheckout({ appRoot: ctx.node, remote: 'origin', branch: 'main', git: ctx.run });
    assert.equal(inspection.shape, 'detached');
    assert.equal(inspection.eligible, true);
    assert.equal(inspection.shallow, true);
    assert.equal(inspection.tag, TAG);
    assert.equal(defaultGitCheckoutProbe({ appRoot: ctx.node, remote: 'origin', branch: 'main' }).reason, 'detached_head');

    const result = await attach(ctx);
    assert.equal(result.ok, true, result.code);
    assert.equal(git(ctx.node, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
    assert.equal(git(ctx.node, ['rev-parse', 'HEAD']), ctx.remote.tagCommit);
    assert.equal(git(ctx.node, ['config', 'branch.main.remote']), 'origin');
    assert.equal(git(ctx.node, ['config', 'branch.main.merge']), 'refs/heads/main');
    assert.equal(git(ctx.node, ['rev-parse', 'refs/remotes/origin/main']), ctx.remote.mainTip);
    assert.match(git(ctx.node, ['config', '--get-all', 'remote.origin.fetch']), /refs\/tags\/v9\.1\.0\.1/, 'tag-only refspec kept');
    assert.equal(git(ctx.node, ['status', '--porcelain', '--untracked-files=no']), '');
    assert.equal(fs.readFileSync(path.join(ctx.node, '.git', 'shallow'), 'utf8'), shallowBefore);
    assert.deepEqual(worktreeMtimes(ctx.node), mtimes);
    git(ctx.node, ['fsck', '--no-progress']);
    assert.equal(privateRefs(ctx.node), '');
    assert.deepEqual(defaultGitCheckoutProbe({ appRoot: ctx.node, remote: 'origin', branch: 'main' }),
        { ready: true, branch: 'main', remoteIdentity: 'github.com/test/repo' });
    // t4: the lease created the gate's control files inside .git (sequence 0, OPEN).
    const journal = JSON.parse(fs.readFileSync(path.join(controlRootOf(ctx.node), 'journal.json'), 'utf8'));
    assert.equal(journal.sequence, 0);
    assert.equal(journal.state, 'OPEN');
    const receipt = readAttachReceipt(result.receiptPath);
    assert.deepEqual(receipt.appliedSteps, ['branch', 'upstream', 'tracking', 'head']);
    assert.equal(fs.statSync(result.receiptPath).mode & 0o777, 0o600);
    assert.equal(receipt.localBranchBefore, null);
    assert.ok(result.exclusiveHoldMs < 1000, `exclusive hold ${result.exclusiveHoldMs} ms`);

    // A second run on the attached tree has nothing to do.
    const again = await attach(ctx);
    assert.equal(again.code, 'already_attached');
});

test('2 merge topology: the fetch brings the old side, ancestry holds, shallow unchanged; a slow remote times out with no write', async (t) => {
    const ctx = fedora(t, 'merge', { topology: 'merge' });
    const shallowBefore = fs.readFileSync(path.join(ctx.node, '.git', 'shallow'), 'utf8');
    const countBefore = git(ctx.node, ['count-objects', '-v']);
    const result = await attach(ctx);
    assert.equal(result.ok, true, result.code);
    assert.equal(fs.readFileSync(path.join(ctx.node, '.git', 'shallow'), 'utf8'), shallowBefore);
    git(ctx.node, ['fsck', '--no-progress']);
    const countAfter = git(ctx.node, ['count-objects', '-v']);
    t.diagnostic(`objects before: ${countBefore.replace(/\n/g, ' ')} | after: ${countAfter.replace(/\n/g, ' ')}`);
    assert.equal(tryGit(ctx.node, ['cat-file', '-e', `${git(ctx.remote.bare, ['rev-parse', 'old-side'])}^{commit}`]).ok, true,
        'the merged side branched before the tag came along');

    const slow = fedora(t, 'slow', { topology: 'merge' });
    const before = refSnapshot(slow.node);
    const slowEnv = remoteEnv(slow.root, slow.remote.bare, { delaySeconds: 5 });
    const started = Date.now();
    const timedOut = await attach({ ...slow, run: createAttachGit({ appRoot: slow.node, env: slowEnv }) }, { deadlineMs: 700 });
    assert.equal(timedOut.code, 'release_fetch_failed');
    assert.ok(Date.now() - started < 4000, 'the deadline is honored');
    assertUnchanged(slow.node, before, 'slow remote');
});

test('3 after attach the updater path works without unshallow: tag-on-branch, fast-forward, branch CAS with symbolic HEAD', async (t) => {
    const ctx = fedora(t, 'updater');
    assert.equal((await attach(ctx)).ok, true);
    // The updater's own fetch shape (resolveReleaseIdentity) into private refs.
    git(ctx.node, ['fetch', '-q', '--no-tags', '--refmap=', 'origin', 'refs/tags/v9.1.0.2:refs/nassaj-update/t/tag',
        'refs/heads/main:refs/nassaj-update/t/branch'], ctx.env);
    const proof = await proveTagOnBranch(ctx.run, { tagRef: 'refs/nassaj-update/t/tag', branchRef: 'refs/nassaj-update/t/branch',
        requireAnnotated: false });
    assert.equal(proof.ok, true);
    assert.equal(proof.commit, ctx.remote.nextCommit);
    const head = git(ctx.node, ['rev-parse', 'HEAD']);
    assert.equal(tryGit(ctx.node, ['merge-base', '--is-ancestor', head, proof.commit]).ok, true, 'assertFastForward');
    // Activation CASes the branch ref behind a symbolic HEAD, rollback CASes it back.
    git(ctx.node, ['update-ref', 'refs/heads/main', proof.commit, head]);
    assert.equal(git(ctx.node, ['rev-parse', 'HEAD']), proof.commit);
    git(ctx.node, ['update-ref', 'refs/heads/main', head, proof.commit]);
    assert.equal(git(ctx.node, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
    assert.equal(fs.existsSync(path.join(ctx.node, '.git', 'shallow')), true, 'still shallow');
});

/** A minimal job table, as the CLI reads it (read-only). */
function jobDatabase(root, rows) {
    const file = path.join(root, 'auth.db');
    const db = new Database(file);
    db.exec('CREATE TABLE source_update_jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    for (const row of rows) db.prepare('INSERT INTO source_update_jobs (id, state, created_at) VALUES (?, ?, ?)').run(row.id, row.state, row.createdAt ?? '2026-01-01 00:00:00');
    db.close();
    return file;
}

/** A prestage slot record that isValidSlot accepts, in `state`. */
function writePrestageSlot(controlRoot, state = 'ready') {
    const identity = { releaseCommit: 'a'.repeat(40), key: 'fixture' };
    const slot = {
        schema: 'nassaj-prestage-slot/v1', slotId: crypto.randomUUID(), revision: 1, transactionId: 'update-pre-fixture',
        target: { version: '9.1.0.2', tag: 'v9.1.0.2', releaseCommit: 'a'.repeat(40) }, identity,
        keyDigest: sha256Hex(canonicalJson(identity)),
        build: { owner: { pid: 1, startTicks: '1', bootId: 'b' }, effect: null }, state,
        outputs: { manifestSha256: 'b'.repeat(64), trees: { client: 'c'.repeat(64), server: 'd'.repeat(64), nodeModules: 'e'.repeat(64) } },
    };
    fs.mkdirSync(path.join(controlRoot, 'prestage'), { recursive: true });
    fs.writeFileSync(path.join(controlRoot, 'prestage', 'slot.json'), JSON.stringify(slot));
}

test('4 refusals leave every ref and config value untouched', async (t) => {
    const cases = [
        ['tracked change', 'dirty_worktree', (ctx) => fs.appendFileSync(path.join(ctx.node, 'README.md'), 'x\n')],
        ['staged change', 'dirty_worktree', (ctx) => { fs.writeFileSync(path.join(ctx.node, 'new.txt'), 'n\n'); git(ctx.node, ['add', 'new.txt']); }],
        ['local commit on top of the tag', 'head_not_release_tag', (ctx) => {
            fs.writeFileSync(path.join(ctx.node, 'local.txt'), 'l\n');
            git(ctx.node, ['add', 'local.txt']);
            git(ctx.node, ['commit', '-q', '-m', 'local']);
            git(ctx.node, ['tag', '-d', TAG]);
        }],
        ['remote is not the configured source', 'remote_mismatch', null, { configuredRemoteUrl: 'git@github.com:other/repo.git' }],
        ['remote unreachable', 'release_fetch_failed', (ctx) => { ctx.env.FAKE_SSH_REPO = path.join(ctx.root, 'missing.git'); }],
        ['local main diverged', 'local_branch_diverged', (ctx) => {
            git(ctx.node, ['fetch', '-q', '--no-tags', `file://${ctx.remote.bare}`, 'refs/heads/main:refs/heads/main']);
        }],
        ['journal MANUAL', 'update_maintenance_active', null, { readQuiescence: idleQuiescence({ journal: { state: 'MANUAL', gateClosed: true } }) }],
        ['journal degraded', 'update_maintenance_active', null, { readQuiescence: idleQuiescence({ journal: { state: 'OPEN', gateClosed: false, degraded: 'source_tree_at_target' } }) }],
        ['unfinished job row', 'update_job_active', null, (ctx) => ({ readQuiescence: createCliQuiescenceReader({
            controlRoot: controlRootOf(ctx.node), databasePath: jobDatabase(ctx.root, [{ id: 'j1', state: 'staging' }]) }) })],
        ['prestage slot ready', 'prestage_active', null, (ctx) => {
            writePrestageSlot(controlRootOf(ctx.node), 'ready');
            return { readQuiescence: createCliQuiescenceReader({ controlRoot: controlRootOf(ctx.node), databasePath: path.join(ctx.root, 'none.db') }) };
        }],
    ];
    for (const [label, code, mutate, overrides] of cases) {
        const ctx = fedora(t, 'refuse');
        mutate?.(ctx);
        const extra = typeof overrides === 'function' ? overrides(ctx) : overrides;
        const run = createAttachGit({ appRoot: ctx.node, env: ctx.env });
        const before = refSnapshot(ctx.node);
        const result = await attach({ ...ctx, run }, extra || {});
        assert.equal(result.code, code, label);
        assert.equal(result.ok, false, label);
        assertUnchanged(ctx.node, before, label);
    }
});

test('4b remote-side refusals: lightweight tag, tag off main, NASSAJ_UPDATE_BRANCH=release without the tag', async (t) => {
    const light = fedora(t, 'light', { lightweight: true });
    let before = refSnapshot(light.node);
    assert.equal((await attach(light)).code, 'tag_not_annotated');
    assertUnchanged(light.node, before, 'lightweight');

    const side = fedora(t, 'side', { topology: 'side' });
    before = refSnapshot(side.node);
    assert.equal((await attach(side)).code, 'tag_not_on_release_branch');
    assertUnchanged(side.node, before, 'side');

    const other = fedora(t, 'branch');
    git(other.remote.bare, ['branch', 'release', git(other.remote.bare, ['rev-list', '--max-parents=0', 'main'])]);
    before = refSnapshot(other.node);
    assert.equal((await attach(other, { branch: 'release' })).code, 'tag_not_on_release_branch');
    assertUnchanged(other.node, before, 'release branch');
});

test('5 an untracked file keeps the node eligible and is never touched', async (t) => {
    const ctx = fedora(t, 'untracked');
    const file = path.join(ctx.node, 'operator-notes.txt');
    fs.writeFileSync(file, 'mine\n');
    const mtime = fs.statSync(file).mtimeMs;
    const result = await attach(ctx);
    assert.equal(result.ok, true, result.code);
    assert.equal(fs.readFileSync(file, 'utf8'), 'mine\n');
    assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test('6 a crash after each apply step is completed by a re-run; the receipt lists the steps', async (t) => {
    for (const step of ['branch', 'upstream', 'tracking', 'head']) {
        const ctx = fedora(t, `crash-${step}`);
        const crashed = await attach(ctx, { hooks: { afterStep: (name) => { if (name === step) throw new Error('injected crash'); } } });
        assert.equal(crashed.ok, false, step);
        const [receiptPath] = listAttachReceipts(controlRootOf(ctx.node));
        assert.equal(readAttachReceipt(receiptPath).appliedSteps.at(-1), step);
        if (step !== 'head') assert.equal(tryGit(ctx.node, ['symbolic-ref', '-q', 'HEAD']).ok, false, `${step}: HEAD still detached`);
        const rerun = await attach(ctx);
        if (step === 'head') assert.equal(rerun.code, 'already_attached');
        else assert.equal(rerun.ok, true, `${step}: ${rerun.code}`);
        assert.equal(git(ctx.node, ['symbolic-ref', 'HEAD']), 'refs/heads/main', step);
        assert.equal(git(ctx.node, ['rev-parse', 'HEAD']), ctx.remote.tagCommit, step);
        assert.equal(git(ctx.node, ['config', 'branch.main.merge']), 'refs/heads/main', step);
        assert.equal(privateRefs(ctx.node), '', step);
    }
});

test('7 a failed post-flip verification rolls back to the pre-apply state', async (t) => {
    const ctx = fedora(t, 'verify');
    const before = refSnapshot(ctx.node);
    const result = await attach(ctx, { hooks: { failVerify: () => true } });
    assert.equal(result.code, 'attach_verify_failed');
    assert.equal(result.rolledBack, true);
    assertUnchanged(ctx.node, before, 'rollback');
    assert.equal(readAttachReceipt(result.receiptPath).outcome.state, 'rolled_back');
});

const fakeLease = (journalSequence) => ({ [SOURCE_REF_LEASE]: true, held: true, journalSequence, release() {} });
const noJobs = { createdSince: () => false, prestageSlotExists: () => false };

test('8 revert restores the detached shape exactly, and refuses after a move or an update', async (t) => {
    const ctx = fedora(t, 'revert');
    const before = refSnapshot(ctx.node);
    const result = await attach(ctx);
    assert.equal(result.ok, true);

    const lease = await realLease(ctx.node)({ kind: 'source-attach-revert' });
    try {
        assert.equal((await revertReleaseAttachment({ receiptPath: result.receiptPath, receiptDir: receiptDirOf(ctx.node), git: ctx.run, lease: fakeLease(1), jobs: noJobs })).code,
            'update_since_attach', 'journal sequence bump');
        assert.equal((await revertReleaseAttachment({ receiptPath: result.receiptPath, receiptDir: receiptDirOf(ctx.node), git: ctx.run, lease,
            jobs: { createdSince: () => true, prestageSlotExists: () => false } })).code, 'update_since_attach', 'new job row');
        assert.equal((await revertReleaseAttachment({ receiptPath: result.receiptPath, receiptDir: receiptDirOf(ctx.node), git: ctx.run, lease,
            jobs: { createdSince: () => false, prestageSlotExists: () => true } })).code, 'update_since_attach', 'prestage slot');
        const reverted = await revertReleaseAttachment({ receiptPath: result.receiptPath, receiptDir: receiptDirOf(ctx.node), git: ctx.run, lease, jobs: noJobs });
        assert.equal(reverted.ok, true, reverted.code);
    } finally { lease.release(); }
    assert.deepEqual(refSnapshot(ctx.node).refs, before.refs);
    assert.equal(refSnapshot(ctx.node).head, before.head);
    assert.equal(tryGit(ctx.node, ['config', 'branch.main.remote']).ok, false);
    assert.equal(git(ctx.node, ['config', '--get-all', 'remote.origin.fetch']), `+refs/tags/${TAG}:refs/tags/${TAG}`);

    // Re-attach, then move HEAD: the revert refuses source_changed.
    const second = await attach(ctx);
    assert.equal(second.ok, true);
    git(ctx.node, ['update-ref', '--no-deref', 'HEAD', ctx.remote.mainTip]);
    const moved = await revertReleaseAttachment({ receiptPath: second.receiptPath, receiptDir: receiptDirOf(ctx.node), git: ctx.run, lease: fakeLease(0), jobs: noJobs });
    assert.equal(moved.code, 'source_changed');
    assert.equal(git(ctx.node, ['rev-parse', 'HEAD']), ctx.remote.mainTip, 'untouched');
    // And without a lease nothing runs.
    assert.equal((await revertReleaseAttachment({ receiptPath: second.receiptPath, receiptDir: receiptDirOf(ctx.node), git: ctx.run, lease: null, jobs: noJobs })).code, 'lease_required');
});

test('8b the CLI revert port reads job rows created at or after the receipt, read-only', async (t) => {
    const root = scratch(t, 'jobs');
    const controlRoot = path.join(root, 'control');
    const databasePath = jobDatabase(root, [{ id: 'old', state: 'activated', createdAt: '2026-01-01 00:00:00' }]);
    const jobs = createCliRevertJobs({ controlRoot, databasePath });
    assert.equal(jobs.createdSince('2026-06-01T00:00:00.000Z'), false);
    assert.equal(jobs.createdSince('2025-12-31T23:59:59.000Z'), true);
    assert.equal(jobs.prestageSlotExists(), false);
    fs.mkdirSync(path.join(controlRoot, 'prestage'), { recursive: true });
    fs.writeFileSync(path.join(controlRoot, 'prestage', 'slot.json'), '{bad');
    assert.equal(readPrestageSlotState(controlRoot), 'corrupt');
    assert.equal(jobs.prestageSlotExists(), true);
    assert.equal(evaluateAttachQuiescence({ journal: null, unfinishedJobs: false, prestageState: 'corrupt' }), 'prestage_active');
    assert.equal(evaluateAttachQuiescence({ journal: null, unfinishedJobs: null, prestageState: null }), 'update_job_state_unavailable');
    assert.equal(evaluateAttachQuiescence({ journal: null, unfinishedJobs: false, prestageState: 'adopted:job-1' }), null);
});

test('9g HEAD moved between the proof and the lease: source_changed, no write', async (t) => {
    const ctx = fedora(t, 'moved');
    const result = await attach(ctx, {
        acquireLease: async (options) => {
            git(ctx.node, ['update-ref', '--no-deref', 'HEAD', ctx.remote.mainTip]);
            return realLease(ctx.node)(options);
        },
    });
    assert.equal(result.code, 'source_changed');
    assert.equal(tryGit(ctx.node, ['rev-parse', '--verify', '-q', 'refs/heads/main']).ok, false, 'no branch written');
    assert.equal(tryGit(ctx.node, ['config', 'branch.main.remote']).ok, false, 'no config written');
    assert.equal(privateRefs(ctx.node), '');
});

test('9h the attach lock refuses a symlink or a group/other-accessible file, and a second holder', async (t) => {
    const root = scratch(t, 'lock');
    const controlRoot = path.join(root, 'control');
    fs.mkdirSync(controlRoot, { mode: 0o700 });
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(controlRoot, 'source-attach.lock'));
    assert.throws(() => acquireSourceAttachLock(controlRoot), { code: 'source_attach_lock_unsafe' });
    fs.rmSync(path.join(controlRoot, 'source-attach.lock'));
    fs.writeFileSync(path.join(controlRoot, 'source-attach.lock'), '', { mode: 0o644 });
    fs.chmodSync(path.join(controlRoot, 'source-attach.lock'), 0o644);
    assert.throws(() => acquireSourceAttachLock(controlRoot), { code: 'source_attach_lock_unsafe' });
    fs.chmodSync(path.join(controlRoot, 'source-attach.lock'), 0o600);
    const held = acquireSourceAttachLock(controlRoot);
    assert.throws(() => acquireSourceAttachLock(controlRoot), { code: 'source_attach_in_progress' });
    held.release();
    acquireSourceAttachLock(controlRoot).release();
});

test('12 policy verified refuses release_unverified with no write while signing is not built', async (t) => {
    const ctx = fedora(t, 'verified');
    const before = refSnapshot(ctx.node);
    const result = await attach(ctx, { requireVerified: true, verifySignedRelease: async () => false });
    assert.equal(result.code, 'release_unverified');
    assertUnchanged(ctx.node, before, 'verified');
});

test('13 a linear public-export remote with a fresh root behaves as test 1', async (t) => {
    const root = scratch(t, 'public');
    const remote = createPublicExportRemote(root);
    const node = cloneFedora(root, remote.bare);
    const env = remoteEnv(root, remote.bare);
    const result = await attach({ node, root, remote, env, run: createAttachGit({ appRoot: node, env }) });
    assert.equal(result.ok, true, result.code);
    assert.equal(git(node, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
});

test('apply refuses without a lease, and an already attached checkout is reported as attached', async (t) => {
    const root = scratch(t, 'apply');
    const remote = createRemote(root);
    const node = cloneAttached(root, remote.bare);
    const env = remoteEnv(root, remote.bare);
    const run = createAttachGit({ appRoot: node, env });
    const plan = { head: remote.tagCommit, branch: 'main', remote: 'origin', tag: TAG, remoteBranchOid: remote.mainTip };
    assert.equal((await applyReleaseAttachment({ plan, git: run, receiptDir: path.join(root, ATTACH_RECEIPT_DIR), lease: null })).code, 'lease_required');
    const inspection = await inspectReleaseCheckout({ appRoot: node, remote: 'origin', branch: 'main', git: run });
    assert.equal(inspection.shape, 'attached');
    assert.equal(inspection.eligible, false);
    const wrong = await inspectReleaseCheckout({ appRoot: node, remote: 'origin', branch: 'release', git: run });
    assert.equal(wrong.shape, 'wrong_branch');
    assert.equal((await inspectReleaseCheckout({ appRoot: node, remote: 'bad remote', branch: 'main', git: run })).reason, 'invalid_update_source');
    assert.equal((await inspectReleaseCheckout({ appRoot: root, remote: 'origin', branch: 'main', git: run })).reason, 'unsupported_install_mode');
});

test('refspecMapsBranch recognizes exact and glob sources only', () => {
    assert.equal(refspecMapsBranch('+refs/heads/main:refs/remotes/origin/main', 'main'), true);
    assert.equal(refspecMapsBranch('+refs/heads/*:refs/remotes/origin/*', 'main'), true);
    assert.equal(refspecMapsBranch('+refs/tags/v1:refs/tags/v1', 'main'), false);
    assert.equal(refspecMapsBranch('+refs/heads/release:refs/remotes/origin/release', 'main'), false);
});

test('T1 a receipt that cannot be written after the HEAD flip does not skip verification', async (t) => {
    const ctx = fedora(t, 'receipt-ro');
    const dir = receiptDirOf(ctx.node);
    t.after(() => { try { fs.chmodSync(dir, 0o700); } catch { /* removed */ } });
    const result = await attach(ctx, { hooks: { afterStep: (step) => { if (step === 'tracking') fs.chmodSync(dir, 0o500); } } });
    fs.chmodSync(dir, 0o700);
    assert.equal(result.ok, true, result.code);
    assert.equal(result.receiptWriteFailed, true, 'surfaced to the caller');
    assert.equal(git(ctx.node, ['symbolic-ref', 'HEAD']), 'refs/heads/main');
    assert.deepEqual(readAttachReceipt(result.receiptPath).appliedSteps, ['branch', 'upstream', 'tracking'],
        'the last durable receipt state; the flip itself was verified');
});

test('T3 a revert reads receipts only from <controlRoot>/source-attach and validates configBefore', async (t) => {
    const ctx = fedora(t, 'receipt-scope');
    const result = await attach(ctx);
    assert.equal(result.ok, true);
    const outside = path.join(ctx.root, 'copied.json');
    fs.copyFileSync(result.receiptPath, outside);
    const call = (receiptPath) => revertReleaseAttachment({ receiptPath, receiptDir: receiptDirOf(ctx.node), git: ctx.run,
        lease: fakeLease(0), jobs: noJobs });
    assert.equal((await call(outside)).code, 'receipt_outside_control_root');
    const forged = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
    forged.configBefore = { remote: ['origin'], merge: [], fetch: ['x\ny'] };
    const forgedPath = path.join(receiptDirOf(ctx.node), '2026-01-01T00-00-00.000Z-000000000000.json');
    fs.writeFileSync(forgedPath, JSON.stringify(forged), { mode: 0o600 });
    assert.equal((await call(forgedPath)).code, 'receipt_invalid');
    forged.configBefore = { remote: [], merge: [], fetch: [], extra: [] };
    fs.writeFileSync(forgedPath, JSON.stringify(forged), { mode: 0o600 });
    assert.equal((await call(forgedPath)).code, 'receipt_invalid');
    const linked = path.join(receiptDirOf(ctx.node), '2026-01-02T00-00-00.000Z-111111111111.json');
    fs.symlinkSync(result.receiptPath, linked);
    assert.equal((await call(linked)).code, 'receipt_unsafe', 'a symlinked receipt is refused');
    assert.equal(git(ctx.node, ['symbolic-ref', 'HEAD']), 'refs/heads/main', 'nothing reverted');
    // A revert whose outcome cannot be recorded still succeeds and says so.
    fs.rmSync(forgedPath);
    fs.rmSync(linked);
    fs.chmodSync(receiptDirOf(ctx.node), 0o500);
    t.after(() => { try { fs.chmodSync(receiptDirOf(ctx.node), 0o700); } catch { /* removed */ } });
    const reverted = await call(result.receiptPath);
    fs.chmodSync(receiptDirOf(ctx.node), 0o700);
    assert.equal(reverted.ok, true, reverted.code);
    assert.equal(reverted.receiptWriteFailed, true);
    assert.equal(tryGit(ctx.node, ['symbolic-ref', '-q', 'HEAD']).ok, false, 'detached again');
});

test('M5 the CLI verified policy reads env over the owner stored setting, as the server does', async (t) => {
    const root = scratch(t, 'policy');
    const databasePath = path.join(root, 'auth.db');
    assert.deepEqual(readStoredPrestageSettingsReadOnly(databasePath), { prestageEnabled: true, prestageQuarantineHours: 0 });
    const db = new Database(databasePath);
    db.exec('CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?)').run('update_prestage_settings',
        JSON.stringify({ prestageEnabled: false, prestageQuarantineHours: 5 }));
    db.close();
    const stored = readStoredPrestageSettingsReadOnly(databasePath);
    assert.deepEqual(stored, { prestageEnabled: false, prestageQuarantineHours: 5 });
    for (const env of [{}, { NASSAJ_UPDATE_PRESTAGE_POLICY: 'verified' }, { NASSAJ_UPDATE_PRESTAGE_POLICY: 'quarantine' }]) {
        assert.equal(cliRequiresVerifiedRelease(env, databasePath), releasePolicyRequiresVerification(env, stored), JSON.stringify(env));
    }
    assert.equal(cliRequiresVerifiedRelease({ NASSAJ_UPDATE_PRESTAGE_POLICY: 'verified' }, databasePath), true);
    fs.writeFileSync(path.join(root, 'broken.db'), 'not a database');
    assert.equal(readStoredPrestageSettingsReadOnly(path.join(root, 'broken.db')), null);

    // The doctor path refuses where the server would.
    const ctx = fedora(t, 'policy-doctor');
    const before = refSnapshot(ctx.node);
    const outcome = await runDoctorAttach({ appRoot: ctx.node, confirmed: true,
        env: { ...ctx.env, DATABASE_PATH: databasePath, NASSAJ_UPDATE_PRESTAGE_POLICY: 'verified' } });
    assert.equal(outcome.result.code, 'release_unverified');
    assert.deepEqual(refSnapshot(ctx.node).refs, before.refs);
});

test('M2 an attached checkout keeps its L3–L5 verdict separate from its shape', async (t) => {
    const root = scratch(t, 'attached-verdict');
    const remote = createRemote(root);
    const node = cloneAttached(root, remote.bare);
    const run = createAttachGit({ appRoot: node, env: remoteEnv(root, remote.bare) });
    fs.appendFileSync(path.join(node, 'README.md'), 'dirty\n');
    const dirty = await inspectReleaseCheckout({ appRoot: node, remote: 'origin', branch: 'main', git: run });
    assert.deepEqual([dirty.shape, dirty.reason, dirty.eligible], ['attached', 'dirty_worktree', false]);
    git(node, ['checkout', '-q', '--', 'README.md']);
    const clean = await inspectReleaseCheckout({ appRoot: node, remote: 'origin', branch: 'main', git: run });
    assert.deepEqual([clean.shape, clean.reason], ['attached', null]);
});

/** The pre-flight's detached_head finding on a real repository (other probes stubbed). */
async function detachedHeadCheck(appRoot, env) {
    const result = await runUpdatePreflightChecks({
        appRoot, env, activeSessionCount: () => 0, listPm2Processes: async () => [], readLiveProcessEnv: async () => ({}),
        exchangeProbe: async () => true, listQueuedSafeRestarts: () => [],
    });
    return result.checks.find((check) => check.code === 'detached_head');
}

test('T6 checkDetachedHead: attached clear, eligible repair, dirty remedy, non-release reinstall remedy', async (t) => {
    const ctx = fedora(t, 'preflight');
    const eligible = await detachedHeadCheck(ctx.node, ctx.env);
    assert.equal(eligible.severity, 'blocker');
    assert.equal(eligible.command, 'npm run doctor -- --attach-release-branch');
    fs.appendFileSync(path.join(ctx.node, 'README.md'), 'x\n');
    const dirty = await detachedHeadCheck(ctx.node, ctx.env);
    assert.match(dirty.reason_en, /dirty_worktree/);
    assert.match(dirty.action_en, /Commit or revert/);
    git(ctx.node, ['checkout', '-q', '--', 'README.md']);
    fs.writeFileSync(path.join(ctx.node, 'package.json'), '{"version":"not-a-release"}\n');
    git(ctx.node, ['commit', '-q', '-am', 'local']);
    const nonRelease = await detachedHeadCheck(ctx.node, ctx.env);
    assert.match(nonRelease.reason_en, /head_not_release/);
    assert.match(nonRelease.action_en, /RELEASING\.md/);
    assert.equal((await attach(ctx)).code, 'head_not_release');
    const attachedRoot = scratch(t, 'preflight-attached');
    const remote = createRemote(attachedRoot);
    const attachedNode = cloneAttached(attachedRoot, remote.bare);
    assert.equal((await detachedHeadCheck(attachedNode, remoteEnv(attachedRoot, remote.bare))).severity, 'ok');
});

test('M6 a lease refused for a node without a git common dir surfaces unsupported_install_mode', async (t) => {
    const ctx = fedora(t, 'artifact');
    const result = await attach(ctx, { acquireLease: async () => { throw new Error('unsupported_install_mode'); } });
    assert.equal(result.code, 'unsupported_install_mode');
    assert.equal(privateRefs(ctx.node), '');
});
