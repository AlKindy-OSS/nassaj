#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import test from 'node:test';

import {
    confirmServerLoaded,
    consumeNewestPreview,
    enqueuePreviewEvent,
    listPreviewEvents,
    parseConsumerDomains,
    readConsumerState,
    reconcileClientRuntimeLedger,
    reconcileServerRuntime,
    requestRuntimeRollback,
    withPreviewEventMutationLock,
} from './preview-oid-consumer.mjs';
import { dispatchCommittedPreview } from './preview-oid-dispatch.mjs';
import { readPreviewLedger } from './local-preview-ledger.mjs';

function git(root, ...args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function fixture() {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'preview-consumer-'));
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Consumer Test');
    git(root, 'config', 'user.email', 'consumer@example.invalid');
    writeFileSync(path.join(root, 'value'), 'one');
    git(root, 'add', 'value');
    git(root, 'commit', '-qm', 'one');
    const first = git(root, 'rev-parse', 'HEAD');
    writeFileSync(path.join(root, 'value'), 'two');
    git(root, 'commit', '-qam', 'two');
    const second = git(root, 'rev-parse', 'HEAD');
    return { root, first, second };
}

function cleanup(root) {
    stopBootstrapTestRuntime(root);
    execFileSync('chmod', ['-R', 'u+w', root]);
    rmSync(root, { recursive: true, force: true });
}

import { writeBootstrapTestPacket, stopBootstrapTestRuntime } from './lib/bootstrap-publication.test.fixture.mjs';
function serverBootstrap(value, sequence, oid, serverBuildId) {
    git(value.root, 'update-ref', 'refs/heads/main', oid);
    const { packetFile } = writeBootstrapTestPacket(value.root, { oid, sequence, serverBuildId });
    return { domains: ['server'], bootstrapPacket: packetFile };
}

const buildId = (character) => character.repeat(64);

test('consumer domain authorization fails closed for missing or invalid environment values', () => {
    assert.throws(() => parseConsumerDomains(undefined), /must contain client and\/or server/);
    assert.throws(() => parseConsumerDomains(''), /must contain client and\/or server/);
    assert.throws(() => parseConsumerDomains('client,filesystem'), /must contain client and\/or server/);
    assert.deepEqual(parseConsumerDomains('client'), ['client']);
    assert.deepEqual(parseConsumerDomains('server'), ['server']);
});

test('shared promotion lock prevents a newer client enqueue from entering the final mutation window', async () => {
    const value = fixture();
    try {
        enqueuePreviewEvent(value.root, { sequence: 60, oid: value.first, domains: ['client'] });
        let enqueuer;
        await withPreviewEventMutationLock(value.root, async () => {
            const moduleUrl = new URL('./preview-oid-consumer.mjs', import.meta.url).href;
            const source = `import { enqueuePreviewEvent } from ${JSON.stringify(moduleUrl)}; enqueuePreviewEvent(process.env.TEST_ROOT, { sequence: 61, oid: process.env.TEST_OID, domains: ['client'] });`;
            enqueuer = spawn(process.execPath, ['--input-type=module', '-e', source], {
                cwd: value.root,
                env: { ...process.env, TEST_ROOT: value.root, TEST_OID: value.second },
                stdio: ['ignore', 'ignore', 'pipe'],
            });
            await new Promise((resolve) => setTimeout(resolve, 75));
            assert.equal(enqueuer.exitCode, null);
            assert.deepEqual(listPreviewEvents(value.root).map(({ sequence }) => sequence), [60]);
        });
        if (enqueuer.exitCode === null) {
            await new Promise((resolve, reject) => {
                enqueuer.once('error', reject);
                enqueuer.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`enqueue child failed: ${code}`)));
            });
        }
        assert.equal(enqueuer.exitCode, 0);
        assert.deepEqual(listPreviewEvents(value.root).map(({ sequence }) => sequence), [60, 61]);
    } finally { cleanup(value.root); }
});

test('startup reconciliation repairs a stale failed ledger only from matching live OID proof', async () => {
    const value = fixture();
    try {
        const { recordPreviewLedgerEvent } = await import('./local-preview-ledger.mjs');
        recordPreviewLedgerEvent(value.root, {
            target: 'client', sourceGeneration: 547, state: 'failed', runtimeBuildId: buildId('1'),
        });
        enqueuePreviewEvent(value.root, { sequence: 27, oid: value.first, domains: ['client'] });
        writeFileSync(path.join(value.root, '.git', 'nassaj-preview-oid-consumer-v1.json'), JSON.stringify({
            schemaVersion: 1, acceptedSequence: 27, acceptedOid: value.first,
            client: { sequence: 27, oid: value.first, phase: 'served', buildId: buildId('2') },
            server: null, updatedAt: new Date().toISOString(),
        }));
        mkdirSync(path.join(value.root, 'dist'));
        writeFileSync(path.join(value.root, 'dist', 'version.json'), JSON.stringify({ buildId: buildId('2') }));
        writeFileSync(path.join(value.root, 'dist', 'BUILD_PROVENANCE.json'), JSON.stringify({
            artifact: 'client', commit: value.first, buildId: buildId('2'),
        }));
        const result = reconcileClientRuntimeLedger(value.root);
        assert.equal(result.status, 'reconciled');
        assert.equal(readPreviewLedger(value.root).clientState, 'served');
        assert.equal(readPreviewLedger(value.root).clientSourceGeneration, 27);
    } finally { cleanup(value.root); }
});

test('event refs are globally ordered and a sequence cannot change OID', () => {
    const value = fixture();
    try {
        enqueuePreviewEvent(value.root, { sequence: 9, oid: value.first, domains: ['client'] });
        enqueuePreviewEvent(value.root, { sequence: 11, oid: value.second, domains: ['server'] });
        assert.deepEqual(listPreviewEvents(value.root).map(({ sequence }) => sequence), [9, 11]);
        assert.throws(() => enqueuePreviewEvent(value.root, {
            sequence: 11, oid: value.first, domains: ['server'],
        }), /already bound/);
    } finally { cleanup(value.root); }
});

test('server stays awaiting_owner until health proves exact OID and buildId', async () => {
    const value = fixture();
    try {
        enqueuePreviewEvent(value.root, { sequence: 7, oid: value.first, domains: ['server'] });
        const requested = [];
        await consumeNewestPreview(value.root, {
            materialize: async () => value.root,
            buildServer: async () => {
                // The real builder advances desired -> candidate.
                const { advancePreview } = await import('./preview-oid-pipeline.mjs');
                advancePreview(value.root, {
                    group: 'event-0000000000000007', domain: 'server', state: 'candidate', oid: value.first,
                });
                return { buildId: buildId('c'), controlManifestSha256: buildId('0') };
            },
            requestServerControlPlane: async ({ request }) => { requested.push(request); return { actionId: 'synthetic-action-7' }; },
        }, serverBootstrap(value, 7, value.first, buildId('c')));
        assert.equal(readConsumerState(value.root).server.phase, 'awaiting_owner');
        assert.equal(requested[0].action, 'promote-and-safe-restart');
        await assert.rejects(() => confirmServerLoaded(value.root, {
            status: 'ok', serverLoadedOid: value.second, serverLoadedBuildId: buildId('c'),
        }), /did not prove/);
        await confirmServerLoaded(value.root, {
            status: 'ok', serverLoadedOid: value.first, serverLoadedBuildId: buildId('c'),
        });
        assert.equal(readConsumerState(value.root).server.phase, 'loaded');
        assert.equal(readPreviewLedger(value.root).serverState, 'loaded');
        assert.equal(readPreviewLedger(value.root).serverPublisher, 'oid');
        assert.equal(readPreviewLedger(value.root).serverLoadedBuildId, buildId('c'));
        const { recordPreviewLedgerEvent } = await import('./local-preview-ledger.mjs');
        recordPreviewLedgerEvent(value.root, {
            target: 'server', sourceGeneration: 999, state: 'failed', runtimeBuildId: buildId('d'),
        });
        assert.equal(readPreviewLedger(value.root).serverState, 'loaded');
        assert.equal(readPreviewLedger(value.root).serverPublisher, 'oid');
        assert.equal(readPreviewLedger(value.root).serverLoadedBuildId, buildId('c'));
    } finally { cleanup(value.root); }
});

test('runtime reconciler is the production caller that advances exact health only', async () => {
    const value = fixture();
    try {
        enqueuePreviewEvent(value.root, { sequence: 12, oid: value.first, domains: ['server'] });
        await consumeNewestPreview(value.root, {
            materialize: async () => value.root,
            buildServer: async ({ event }) => {
                const { advancePreview } = await import('./preview-oid-pipeline.mjs');
                advancePreview(value.root, {
                    group: event.group, domain: 'server', state: 'candidate', oid: event.oid,
                });
                return { buildId: buildId('9'), controlManifestSha256: buildId('0') };
            },
            requestServerControlPlane: async () => ({ actionId: 'synthetic-action-12' }),
        }, serverBootstrap(value, 12, value.first, buildId('9')));
        const mismatch = await reconcileServerRuntime(value.root, async () => ({
            status: 'ok', serverLoadedOid: value.first, serverLoadedBuildId: buildId('8'),
        }));
        assert.equal(mismatch.status, 'awaiting_owner');
        const exact = await reconcileServerRuntime(value.root, async () => ({
            status: 'ok', serverLoadedOid: value.first, serverLoadedBuildId: buildId('9'),
        }));
        assert.equal(exact.status, 'loaded');
        assert.equal(readConsumerState(value.root).server.phase, 'loaded');
    } finally { cleanup(value.root); }
});

test('runtime rollback is routed through the same exact owner control path', async () => {
    const value = fixture();
    try {
        mkdirSync(path.join(value.root, '.git'), { recursive: true });
        writeFileSync(path.join(value.root, '.git', 'nassaj-preview-oid-consumer-v1.json'), JSON.stringify({
            schemaVersion: 1, acceptedSequence: 5, acceptedOid: value.first,
            client: null, server: { sequence: 5, oid: value.first, buildId: buildId('d'), phase: 'loaded' },
        }));
        const calls = [];
        await requestRuntimeRollback(value.root, { oid: value.first, buildId: buildId('d') }, async (request) => calls.push(request));
        assert.equal(calls[0].action, 'rollback-and-safe-restart');
        await assert.rejects(() => requestRuntimeRollback(value.root, {
            oid: value.second, buildId: buildId('d'),
        }, async () => {}), /identity mismatch/);
    } finally { cleanup(value.root); }
});

test('e2e commit -> atomic event -> consume -> owner action -> health loaded', async () => {
    const value = fixture();
    try {
        const dispatched = await dispatchCommittedPreview(value.root, 'ignored-legacy-group', {
            commit: value.first, sequence: 31, changedPaths: ['server/index.js'],
        });
        assert.equal(dispatched.group, 'event-0000000000000031');
        const ownerActions = [];
        await consumeNewestPreview(value.root, {
            buildServer: async ({ event }) => {
                const { advancePreview } = await import('./preview-oid-pipeline.mjs');
                advancePreview(value.root, {
                    group: event.group, domain: 'server', state: 'candidate', oid: event.oid,
                });
                return { buildId: buildId('e'), controlManifestSha256: buildId('0') };
            },
            requestServerControlPlane: async ({ request }) => { ownerActions.push(request); return { actionId: 'synthetic-action-31' }; },
        }, serverBootstrap(value, 31, value.first, buildId('e')));
        assert.deepEqual(ownerActions.map(({ sequence, oid, buildId: id }) => ({ sequence, oid, id })), [{
            sequence: 31, oid: value.first, id: buildId('e'),
        }]);
        await confirmServerLoaded(value.root, {
            status: 'ok', serverLoadedOid: value.first, serverLoadedBuildId: buildId('e'),
        });
        assert.equal(readConsumerState(value.root).server.phase, 'loaded');
    } finally { cleanup(value.root); }
});
