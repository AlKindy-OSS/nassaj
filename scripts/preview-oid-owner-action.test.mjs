import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { enqueuePreviewEvent, withPreviewEventMutationLock } from './preview-oid-consumer.mjs';
import { advancePreview } from './preview-oid-pipeline.mjs';
import { executeOwnerPreviewAction, inspectOwnerControlRequest } from './preview-oid-owner-action.mjs';
import { inspectServerActivationCandidate } from '../server/services/local-preview-server-control.js';
import { commonGitDir, gitControlPath } from './git-control-root.mjs';
import { listOidControlTransactions, writeOidControlJournal } from './oid-control-journal.mjs';

const BUILD = 'b'.repeat(64);
const PREVIOUS_BUILD = 'c'.repeat(64);
const CONTROL_HASH = 'e'.repeat(64);

function git(root, ...args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function fixture({ linkedWorktree = false } = {}) {
    const mainRoot = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'preview-owner-action-'));
    let root = mainRoot;
    git(mainRoot, 'init', '-q');
    git(mainRoot, 'config', 'user.name', 'Owner Action Test');
    git(mainRoot, 'config', 'user.email', 'owner@example.invalid');
    writeFileSync(path.join(mainRoot, 'package.json'), JSON.stringify({ version: '1.2.3.4' }));
    git(mainRoot, 'add', 'package.json');
    git(mainRoot, 'commit', '-qm', 'fixture');
    if (linkedWorktree) {
        root = `${mainRoot}-linked`;
        git(mainRoot, 'worktree', 'add', '--detach', root);
    }
    const oid = git(root, 'rev-parse', 'HEAD');
    const sequence = 21;
    const group = 'event-0000000000000021';
    enqueuePreviewEvent(root, { sequence, oid, domains: ['server'] });
    // enqueue establishes desired refs; advance through candidate exactly once.
    advancePreview(root, { group, domain: 'server', state: 'candidate', oid });
    mkdirSync(path.join(root, '.nassaj-local-preview', 'server-candidates', BUILD), { recursive: true });
    writeFileSync(path.join(root, '.nassaj-local-preview', 'server-candidates', BUILD, 'BUILD_PROVENANCE.json'), JSON.stringify({
        artifact: 'server', commit: oid, baseCommit: oid, buildId: BUILD, dirty: false,
    }));
    mkdirSync(path.join(root, 'dist-server'), { recursive: true });
    writeFileSync(path.join(root, 'dist-server', 'BUILD_PROVENANCE.json'), JSON.stringify({
        artifact: 'server', commit: 'd'.repeat(40), baseCommit: 'd'.repeat(40),
        buildId: PREVIOUS_BUILD, dirty: false,
    }));
    const control = commonGitDir(root);
    writeFileSync(gitControlPath(root, 'nassaj-preview-oid-consumer-v1.json'), JSON.stringify({
        schemaVersion: 1, acceptedSequence: sequence, acceptedOid: oid, client: null,
        server: { sequence, oid, phase: 'awaiting_owner', buildId: BUILD, controlManifestSha256: CONTROL_HASH },
    }));
    writeFileSync(gitControlPath(root, 'nassaj-preview-oid-control-request-v1.json'), JSON.stringify({
        schemaVersion: 1, action: 'promote-and-safe-restart', sequence, oid, buildId: BUILD, group,
        snapshotOid: oid, controlManifestSha256: CONTROL_HASH,
    }));
    writeFileSync(gitControlPath(root, `nassaj-preview-oid-event-control-${String(sequence).padStart(16, '0')}.json`), JSON.stringify({
        schema: 'nassaj-oid-control-event/v1', sequence, oid, snapshotOid: oid,
        buildId: BUILD, controlManifestSha256: CONTROL_HASH,
    }));
    return { root, mainRoot, control, oid, group };
}

function cleanup(value) {
    if (value.root !== value.mainRoot) rmSync(value.root, { recursive: true, force: true });
    rmSync(value.mainRoot, { recursive: true, force: true });
}

test('owner action promotes, restarts and confirms only the exact attested runtime', async () => {
    const value = fixture();
    const calls = [];
    try {
        assert.equal(inspectOwnerControlRequest(value.root).buildId, BUILD);
        const result = await executeOwnerPreviewAction(value.root, {
            activate: async (options) => calls.push(['activate', options.expectedOid, options.buildId]),
            restart: () => { calls.push(['restart']); return { status: 0 }; },
            rollback: () => assert.fail('exact runtime must not roll back'),
            runtime: { fetchHealth: async () => ({
                status: 'ok', serverLoadedOid: value.oid, serverLoadedBuildId: BUILD,
            }), wait: async () => {} },
            confirm: (_root, health) => calls.push(['confirm', health.serverLoadedBuildId]),
        });
        assert.equal(result.status, 'loaded');
        assert.deepEqual(calls, [
            ['activate', value.oid, BUILD], ['restart'], ['confirm', BUILD],
        ]);
    } finally { cleanup(value); }
});

test('attestation mismatch atomically rolls disk back and proves previous runtime recovery', async () => {
    const value = fixture();
    const calls = [];
    let restartCount = 0;
    try {
        await assert.rejects(() => executeOwnerPreviewAction(value.root, {
            activate: async () => calls.push('activate'),
            rollback: () => calls.push('rollback'),
            restart: () => { restartCount += 1; calls.push(`restart-${restartCount}`); return { status: 0 }; },
            runtime: {
                attempts: 1, wait: async () => {},
                fetchHealth: async () => ({ status: 'ok', serverLoadedOid: value.oid, serverLoadedBuildId: 'e'.repeat(64) }),
            },
            recoveryRuntime: {
                attempts: 1, wait: async () => {},
                fetchHealth: async () => ({
                    status: 'ok', serverLoadedOid: 'd'.repeat(40), serverLoadedBuildId: PREVIOUS_BUILD,
                }),
            },
            confirm: () => assert.fail('mismatched runtime must never be confirmed'),
        }), /previous generation restored/);
        assert.deepEqual(calls, ['activate', 'restart-1', 'rollback', 'restart-2']);
    } finally { cleanup(value); }
});

test('superseded control request fails before activation', () => {
    const value = fixture();
    try {
        writeFileSync(path.join(value.root, 'newer'), 'newer');
        git(value.root, 'add', 'newer');
        git(value.root, 'commit', '-qm', 'newer');
        enqueuePreviewEvent(value.root, { sequence: 22, oid: git(value.root, 'rev-parse', 'HEAD'), domains: ['server'] });
        assert.throws(() => inspectOwnerControlRequest(value.root), /superseded/);
    } finally { cleanup(value); }
});

test('command-board candidate resolver gives an exact OID request precedence over legacy lineage', () => {
    const value = fixture();
    try {
        const exact = inspectServerActivationCandidate(BUILD, value.root);
        assert.equal(exact.allowed, true);
        assert.equal(exact.activationKind, 'oid');
        assert.equal(exact.oid, value.oid);
        assert.equal(inspectServerActivationCandidate('e'.repeat(64), value.root).code, 'superseded');

        writeFileSync(
            gitControlPath(value.root, 'nassaj-preview-oid-control-request-v1.json'),
            JSON.stringify({ schemaVersion: 1, action: 'malformed', buildId: BUILD }),
        );
        const malformed = inspectServerActivationCandidate(BUILD, value.root);
        assert.equal(malformed.allowed, false);
        assert.equal(malformed.code, 'candidate_evidence_invalid');
        assert.equal(malformed.activationKind, 'oid');
    } finally { cleanup(value); }
});

test('linked worktree keeps request, preview control, lock and restart flow in the shared Git control directory', async () => {
    const value = fixture({ linkedWorktree: true });
    try {
        assert.equal(commonGitDir(value.root), value.control);
        assert.equal(existsSync(path.join(value.root, '.git', 'nassaj-preview-oid-control-request-v1.json')), false);
        assert.equal(existsSync(gitControlPath(value.root, 'nassaj-preview-oid-control-request-v1.json')), true);
        await withPreviewEventMutationLock(value.root, async () => {
            assert.equal(existsSync(path.join(value.control, 'nassaj-preview-event-mutation.lock')), true);
        });
        const journal = gitControlPath(value.root, 'nassaj-oid-control-transaction-21-linked-worktree.json');
        writeOidControlJournal(journal, { state: 'loaded', transactionNonce: 'linked-worktree' });
        assert.equal(listOidControlTransactions(value.root).at(-1)?.file, journal);
        const calls = [];
        const result = await executeOwnerPreviewAction(value.root, {
            activate: async () => calls.push('preview'),
            restart: () => { calls.push('restart'); return { status: 0 }; },
            rollback: () => assert.fail('exact linked-worktree restart must not roll back'),
            runtime: { fetchHealth: async () => ({
                status: 'ok', serverLoadedOid: value.oid, serverLoadedBuildId: BUILD,
            }), wait: async () => {} },
            confirm: () => calls.push('confirm'),
        });
        assert.equal(result.status, 'loaded');
        assert.deepEqual(calls, ['preview', 'restart', 'confirm']);
        assert.equal(existsSync(gitControlPath(value.root, 'nassaj-preview-owner-action.lock')), false);
    } finally { cleanup(value); }
});
