#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    assertClientPreviewFilesystemLayout,
    buildClientPreviewFromOid,
    promoteClientPreviewFromOid as promoteBootstrapClient,
    planClientPreviewRetention,
    prepareClientPreviewRetention,
    applyClientPreviewRetention,
    prepareClientAssetRestoration,
    restorePublishedClientAssets,
} from './client-preview-from-oid.mjs';
import { computeClientBuildId, mergeLegacyAssets, promoteWithSmokeRollback } from './client-build-atomic.mjs';
import { resolveAtomicClientOutDir } from '../vite.config.js';
import {
    materializePreviewSnapshot,
} from './preview-oid-pipeline.mjs';
import {
    enqueuePreviewEvent,
} from './preview-oid-consumer.mjs';
import { readPreviewLedger } from './local-preview-ledger.mjs';

import { bootstrapFixture, writeBootstrapTestPacket, stopBootstrapTestRuntime } from './lib/bootstrap-publication.test.fixture.mjs';
import { readBootstrapPublicationPacket, recordBootstrapPublicationState } from './lib/node-update-publication-guard.mjs';

async function promoteClientPreviewFromOid(options, injected) {
    execFileSync('git', ['update-ref', 'refs/heads/main', options.expectedOid], { cwd: options.root });
    const { packetFile } = writeBootstrapTestPacket(options.root, { oid: options.expectedOid,
        sequence: Number(options.group.slice(6)), clientBuildId: options.buildId });
    const binding = readBootstrapPublicationPacket(options.root, packetFile);
    const { withPreviewEventMutationLock } = await import('./preview-oid-consumer.mjs');
    await withPreviewEventMutationLock(options.root, () => recordBootstrapPublicationState(options.root, binding, { server: 'prepared', actionId: `synthetic-action-${Number(options.group.slice(6))}` }));
    return promoteBootstrapClient({ ...options, bootstrapPacket: packetFile }, injected);
}

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_ID = 'b'.repeat(64);

function git(root, ...args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function fixture() {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'client-oid-preview-'));
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Client Preview Test');
    git(root, 'config', 'user.email', 'client-preview@example.invalid');
    mkdirSync(path.join(root, 'scripts'));
    writeFileSync(path.join(root, 'package.json'), '{"version":"1.44.0.1"}\n');
    writeFileSync(path.join(root, 'tsconfig.preview.json'), '{"extends":"./tsconfig.json"}\n');
    writeFileSync(path.join(root, 'scripts', 'client-build-atomic.mjs'), 'export const snapshotContract = true;\n');
    git(root, 'add', 'package.json', 'tsconfig.preview.json', 'scripts/client-build-atomic.mjs');
    git(root, 'commit', '-qm', 'client snapshot');
    return { root, oid: git(root, 'rev-parse', 'HEAD') };
}

function cleanup(root) {
    stopBootstrapTestRuntime(root);
    if (!existsSync(root)) return;
    execFileSync('chmod', ['-R', 'u+w', root]);
    rmSync(root, { recursive: true, force: true });
}

test('bootstrap runtime fixture packets ignore a group-permissive umask', t => {
    let f; const previous = process.umask(0o002);
    try { f = bootstrapFixture(t); }
    finally { process.umask(previous); }
    assert.equal(statSync(f.packetFile).mode & 0o777, 0o600, f.packetFile);
    for (const file of [path.join(f.root, 'private-packet/runtime-ready.json'),
        path.join(f.root, 'dist-server/OID_CONTROL_CAPSULE.mjs'), path.join(f.root, 'dist-server/scripts/safe-restart.sh'),
        path.join(f.root, 'dist-server/BUILD_PROVENANCE.json'), path.join(f.root, 'dist-server/OID_CONTROL_MANIFEST.json')]) {
        assert.equal(statSync(file).mode & 0o777, 0o644, file);
    }
});

function requireSingleDirectory(parent) {
    const entries = readdirSync(parent, { withFileTypes: true });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].isDirectory(), true);
    return path.join(parent, entries[0].name);
}

function contract() {
    return {
        computeClientBuildId: () => BUILD_ID,
        viteBuildInvocation: () => ({ command: process.execPath, args: ['mock-vite'] }),
        verifyAssetClosure: (directory) => {
            assert.equal(readFileSync(path.join(directory, 'index.html'), 'utf8'), '<main>new</main>');
        },
        verifyBuildIdentity: (directory, expected) => {
            const version = JSON.parse(readFileSync(path.join(directory, 'version.json'), 'utf8'));
            assert.equal(version.buildId, expected);
        },
        mergeLegacyAssets: () => {},
        promoteWithSmokeRollback: async (candidate, live, smoke) => {
            const previous = `${live}.previous`;
            renameSync(live, previous);
            renameSync(candidate, live);
            renameSync(previous, candidate);
            await smoke(live);
        },
    };
}

test('consumer client dependency and preview-only TypeScript config are present', () => {
    const consumer = readFileSync(path.join(PROJECT_ROOT, 'scripts', 'preview-oid-consumer.mjs'), 'utf8');
    assert.match(consumer, /invoke\('client-preview-from-oid\.mjs'/);
    assert.equal(existsSync(path.join(PROJECT_ROOT, 'scripts', 'client-preview-from-oid.mjs')), true);
    const config = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'tsconfig.preview.json'), 'utf8'));
    assert.equal(config.extends, './tsconfig.json');
    assert.ok(config.exclude.includes('src/**/*.test.*'));
});

test('explicit bootstrap builds immutable client and publishes outside the consumer', async () => {
    const value = fixture();
    try {
        mkdirSync(path.join(value.root, 'dist'));
        writeFileSync(path.join(value.root, 'dist', 'index.html'), '<main>old</main>');
        enqueuePreviewEvent(value.root, { sequence: 19, oid: value.oid, domains: ['client'] });
        const buildContract = contract();
        let buildCommands = 0;
        let serverOnlyRaceQueued = false;
        const operations = {
            buildClient: ({ root, sourceRoot, event }) => buildClientPreviewFromOid({
                root, sourceRoot, expectedOid: event.oid, group: event.group,
            }, {
                contract: buildContract,
                run: (_command, _args, options) => {
                    buildCommands += 1;
                    if (buildCommands !== 2) return;
                    const staging = options.env.NASSAJ_CLIENT_OUT_DIR;
                    assert.equal(options.env.NASSAJ_CLIENT_PREVIEW_ROOT, value.root);
                    assert.equal(path.dirname(staging), path.join(value.root, '.nassaj-local-preview', 'client'));
                    assert.match(path.basename(staging), /^dist\.atomic\.predeploy-staging-[a-f0-9]{12}-\d+$/);
                    assert.equal(resolveAtomicClientOutDir(sourceRoot, options.env), staging);
                    writeFileSync(path.join(staging, 'index.html'), '<main>new</main>');
                    writeFileSync(path.join(staging, 'version.json'), `${JSON.stringify({ buildId: BUILD_ID })}\n`);
                },
            }),
            promoteClient: ({ root, event, candidate }) => {
                enqueuePreviewEvent(value.root, { sequence: 20, oid: value.oid, domains: ['server'] });
                serverOnlyRaceQueued = true;
                return promoteClientPreviewFromOid({
                    root, expectedOid: event.oid, group: event.group, buildId: candidate.buildId,
                }, { contract: buildContract });
            },
        };
        const sourceRoot = await materializePreviewSnapshot(value.root, value.oid);
        const event = { oid: value.oid, sequence: 19, group: 'event-0000000000000019' };
        const candidate = await operations.buildClient({ root: value.root, sourceRoot, event });
        const result = await operations.promoteClient({ root: value.root, event, candidate });
        assert.equal(result.served, true);
        const packetFile = path.join(value.root, 'private-packet/packet.json');
        const replayOptions = { root: value.root, expectedOid: value.oid, group: event.group, buildId: BUILD_ID, bootstrapPacket: packetFile };
        const forbiddenContract = { ...buildContract, promoteWithSmokeRollback: () => assert.fail('replay must not publish again') };
        assert.equal((await promoteBootstrapClient(replayOptions, { contract: forbiddenContract })).replay, true);
        const liveIndex = path.join(value.root, 'dist/index.html');
        const goodIndex = readFileSync(liveIndex); writeFileSync(liveIndex, '<main>tampered</main>');
        await assert.rejects(promoteBootstrapClient(replayOptions, { contract: forbiddenContract }));
        writeFileSync(liveIndex, goodIndex);
        const binding = readBootstrapPublicationPacket(value.root, packetFile);
        const { withPreviewEventMutationLock } = await import('./preview-oid-consumer.mjs');
        await withPreviewEventMutationLock(value.root, () => recordBootstrapPublicationState(value.root, binding, { client: 'intent' }));
        assert.equal((await promoteBootstrapClient(replayOptions, { contract: forbiddenContract })).replay, true);
        await withPreviewEventMutationLock(value.root, () => recordBootstrapPublicationState(value.root, binding, { terminal: true }));
        await assert.rejects(promoteBootstrapClient(replayOptions, { contract: forbiddenContract }), /terminal/);
        assert.equal(buildCommands, 2);
        assert.equal(serverOnlyRaceQueued, true);
        assert.equal(readPreviewLedger(value.root).clientState, 'served');
        assert.equal(readPreviewLedger(value.root).clientPublisher, 'oid');
        assert.equal(readFileSync(path.join(value.root, 'dist', 'index.html'), 'utf8'), '<main>new</main>');
        const provenance = JSON.parse(readFileSync(path.join(value.root, 'dist', 'BUILD_PROVENANCE.json'), 'utf8'));
        assert.equal(provenance.commit, value.oid);
        assert.equal(provenance.baseCommit, value.oid);
        assert.equal(provenance.buildId, BUILD_ID);
        assert.equal(existsSync(path.join(value.root, '.nassaj-local-preview', 'client-candidates', BUILD_ID)), false);
        const recoveryParent = path.join(value.root, '.nassaj-local-preview', 'client-recovery');
        const recovery = requireSingleDirectory(recoveryParent);
        assert.equal(readFileSync(path.join(recovery, 'index.html'), 'utf8'), '<main>old</main>');
        const snapshot = path.join(value.root, '.nassaj-local-preview', 'oid-snapshots', value.oid);
        assert.equal(statSync(snapshot).mode & 0o222, 0);
    } finally { cleanup(value.root); }
});

test('client OID build rejects a cross-filesystem staging/candidate/live layout', () => {
    const value = fixture();
    try {
        const stagingParent = path.join(value.root, '.nassaj-local-preview', 'client');
        const staging = path.join(stagingParent, 'dist.atomic.predeploy-staging-aaaaaaaaaaaa-1');
        const candidateParent = path.join(value.root, '.nassaj-local-preview', 'client-candidates');
        const live = path.join(value.root, 'dist');
        mkdirSync(staging, { recursive: true });
        mkdirSync(candidateParent, { recursive: true });
        mkdirSync(live);
        assert.throws(() => assertClientPreviewFilesystemLayout({
            root: value.root, stagingParent, staging, candidateParent, live,
        }, {
            stat: (directory) => ({ dev: directory === candidateParent ? 2 : 1 }),
        }), /share one filesystem/);

        const liveReal = `${live}-real`;
        renameSync(live, liveReal);
        symlinkSync(liveReal, live, 'dir');
        assert.throws(() => assertClientPreviewFilesystemLayout({
            root: value.root, stagingParent, staging, candidateParent, live,
        }), /Live client directory/);
    } finally { cleanup(value.root); }
});

test('client OID build detects staging or candidate-parent substitution after Vite', async () => {
    for (const swapped of ['staging', 'candidate-parent']) {
        const value = fixture();
        try {
            mkdirSync(path.join(value.root, 'dist'));
            enqueuePreviewEvent(value.root, { sequence: 20, oid: value.oid, domains: ['client'] });
            const sourceRoot = await materializePreviewSnapshot(value.root, value.oid);
            let commands = 0;
            await assert.rejects(buildClientPreviewFromOid({
                root: value.root, sourceRoot, expectedOid: value.oid, group: 'event-0000000000000020',
            }, {
                contract: contract(),
                run: (_command, _args, options) => {
                    commands += 1;
                    if (commands !== 2) return;
                    const staging = options.env.NASSAJ_CLIENT_OUT_DIR;
                    writeFileSync(path.join(staging, 'index.html'), '<main>new</main>');
                    writeFileSync(path.join(staging, 'version.json'), `${JSON.stringify({ buildId: BUILD_ID })}\n`);
                    const actual = swapped === 'staging'
                        ? staging : path.join(value.root, '.nassaj-local-preview', 'client-candidates');
                    const retained = `${actual}-retained`;
                    renameSync(actual, retained);
                    symlinkSync(retained, actual, 'dir');
                },
            }), /must be an existing real directory/);
        } finally { cleanup(value.root); }
    }
});

test('client OID promotion fails closed on candidate/live cross-filesystem layout', async () => {
    const value = fixture();
    try {
        const live = path.join(value.root, 'dist');
        mkdirSync(live);
        writeFileSync(path.join(live, 'index.html'), '<main>old</main>');
        enqueuePreviewEvent(value.root, { sequence: 21, oid: value.oid, domains: ['client'] });
        const sourceRoot = await materializePreviewSnapshot(value.root, value.oid);
        let commands = 0;
        const buildContract = contract();
        const candidate = await buildClientPreviewFromOid({
            root: value.root, sourceRoot, expectedOid: value.oid, group: 'event-0000000000000021',
        }, {
            contract: buildContract,
            run: (_command, _args, options) => {
                commands += 1;
                if (commands !== 2) return;
                writeFileSync(path.join(options.env.NASSAJ_CLIENT_OUT_DIR, 'index.html'), '<main>new</main>');
                writeFileSync(path.join(options.env.NASSAJ_CLIENT_OUT_DIR, 'version.json'), `${JSON.stringify({ buildId: BUILD_ID })}\n`);
            },
        });
        await assert.rejects(promoteClientPreviewFromOid({
            root: value.root, expectedOid: value.oid, group: 'event-0000000000000021', buildId: candidate.buildId,
        }, {
            contract: buildContract,
            filesystem: { stat: (directory) => ({ dev: directory === candidate.candidatePath ? 2 : 1 }) },
        }), /share one filesystem/);
        assert.equal(readFileSync(path.join(live, 'index.html'), 'utf8'), '<main>old</main>');
    } finally { cleanup(value.root); }
});

test('newer client event in final promotion window leaves live generation unchanged', async () => {
    const value = fixture();
    try {
        const live = path.join(value.root, 'dist');
        mkdirSync(live);
        writeFileSync(path.join(live, 'index.html'), '<main>old</main>');
        enqueuePreviewEvent(value.root, { sequence: 50, oid: value.oid, domains: ['client'] });
        const sourceRoot = await materializePreviewSnapshot(value.root, value.oid);
        let commands = 0;
        const buildContract = contract();
        const candidate = await buildClientPreviewFromOid({
            root: value.root, sourceRoot, expectedOid: value.oid, group: 'event-0000000000000050',
        }, {
            contract: buildContract,
            run: (_command, _args, options) => {
                commands += 1;
                if (commands !== 2) return;
                writeFileSync(path.join(options.env.NASSAJ_CLIENT_OUT_DIR, 'index.html'), '<main>new</main>');
                writeFileSync(path.join(options.env.NASSAJ_CLIENT_OUT_DIR, 'version.json'), `${JSON.stringify({ buildId: BUILD_ID })}\n`);
            },
        });
        await assert.rejects(promoteClientPreviewFromOid({
            root: value.root, expectedOid: value.oid, group: 'event-0000000000000050', buildId: candidate.buildId,
        }, {
            contract: buildContract,
            withEventLock: async (_root, operation) => {
                enqueuePreviewEvent(value.root, { sequence: 51, oid: value.oid, domains: ['client'] });
                return operation();
            },
        }), /preview_superseded/);
        assert.equal(readFileSync(path.join(live, 'index.html'), 'utf8'), '<main>old</main>');
    } finally { cleanup(value.root); }
});

test('a served OID can rebuild the same build id without inheriting the previous live generation', async () => {
    const value = fixture();
    try {
        const live = path.join(value.root, 'dist');
        mkdirSync(live);
        writeFileSync(path.join(live, 'index.html'), '<main>old</main>');
        enqueuePreviewEvent(value.root, { sequence: 60, oid: value.oid, domains: ['client'] });
        const sourceRoot = await materializePreviewSnapshot(value.root, value.oid);
        const build = async (group) => buildClientPreviewFromOid({
            root: value.root, sourceRoot, expectedOid: value.oid, group,
        }, {
            contract: contract(),
            run: (_command, _args, options = {}) => {
                if (!options.env?.NASSAJ_CLIENT_OUT_DIR) return;
                writeFileSync(path.join(options.env.NASSAJ_CLIENT_OUT_DIR, 'index.html'), '<main>new</main>');
                writeFileSync(path.join(options.env.NASSAJ_CLIENT_OUT_DIR, 'version.json'), `${JSON.stringify({ buildId: BUILD_ID })}\n`);
            },
        });
        const first = await build('event-0000000000000060');
        await promoteClientPreviewFromOid({
            root: value.root, expectedOid: value.oid, group: 'event-0000000000000060', buildId: first.buildId,
        }, { contract: contract() });
        enqueuePreviewEvent(value.root, { sequence: 61, oid: value.oid, domains: ['client'] });
        const retry = await build('event-0000000000000061');
        assert.equal(retry.buildId, BUILD_ID);
        assert.equal(JSON.parse(readFileSync(path.join(retry.candidatePath, 'BUILD_PROVENANCE.json'), 'utf8')).buildId, BUILD_ID);
    } finally { cleanup(value.root); }
});

test('a canonical candidate whose provenance conflicts with its directory build id fails closed', async () => {
    const value = fixture();
    try {
        mkdirSync(path.join(value.root, 'dist'));
        enqueuePreviewEvent(value.root, { sequence: 62, oid: value.oid, domains: ['client'] });
        const sourceRoot = await materializePreviewSnapshot(value.root, value.oid);
        const candidate = await buildClientPreviewFromOid({
            root: value.root, sourceRoot, expectedOid: value.oid, group: 'event-0000000000000062',
        }, {
            contract: contract(),
            run: (_command, _args, options = {}) => {
                if (!options.env?.NASSAJ_CLIENT_OUT_DIR) return;
                writeFileSync(path.join(options.env.NASSAJ_CLIENT_OUT_DIR, 'index.html'), '<main>new</main>');
                writeFileSync(path.join(options.env.NASSAJ_CLIENT_OUT_DIR, 'version.json'), `${JSON.stringify({ buildId: BUILD_ID })}\n`);
            },
        });
        const file = path.join(candidate.candidatePath, 'BUILD_PROVENANCE.json');
        const record = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(file, `${JSON.stringify({ ...record, buildId: 'a'.repeat(64) })}\n`);
        await assert.rejects(buildClientPreviewFromOid({
            root: value.root, sourceRoot, expectedOid: value.oid, group: 'event-0000000000000062',
        }, { contract: contract() }), /identity conflict/);
    } finally { cleanup(value.root); }
});

test('a failed smoke rolls the exchange back and retains the new canonical candidate', async () => {
    const value = fixture();
    try {
        const live = path.join(value.root, 'dist');
        mkdirSync(live);
        writeFileSync(path.join(live, 'index.html'), '<main>old</main>');
        enqueuePreviewEvent(value.root, { sequence: 63, oid: value.oid, domains: ['client'] });
        const sourceRoot = await materializePreviewSnapshot(value.root, value.oid);
        const candidate = await buildClientPreviewFromOid({
            root: value.root, sourceRoot, expectedOid: value.oid, group: 'event-0000000000000063',
        }, {
            contract: contract(),
            run: (_command, _args, options = {}) => {
                if (!options.env?.NASSAJ_CLIENT_OUT_DIR) return;
                writeFileSync(path.join(options.env.NASSAJ_CLIENT_OUT_DIR, 'index.html'), '<main>new</main>');
                writeFileSync(path.join(options.env.NASSAJ_CLIENT_OUT_DIR, 'version.json'), `${JSON.stringify({ buildId: BUILD_ID })}\n`);
            },
        });
        const failedSmoke = {
            ...contract(),
            promoteWithSmokeRollback: async (staged, current, smoke) => {
                const previous = `${current}.previous`;
                renameSync(current, previous);
                renameSync(staged, current);
                try { await smoke(current); throw new Error('smoke probe failed'); }
                catch (error) {
                    renameSync(current, staged);
                    renameSync(previous, current);
                    throw error;
                }
            },
        };
        await assert.rejects(promoteClientPreviewFromOid({
            root: value.root, expectedOid: value.oid, group: 'event-0000000000000063', buildId: candidate.buildId,
        }, { contract: failedSmoke }), /smoke probe failed/);
        assert.equal(readFileSync(path.join(live, 'index.html'), 'utf8'), '<main>old</main>');
        assert.equal(readFileSync(path.join(candidate.candidatePath, 'index.html'), 'utf8'), '<main>new</main>');
        assert.deepEqual(readdirSync(path.join(value.root, '.nassaj-local-preview', 'client-recovery')), []);
    } finally { cleanup(value.root); }
});

test('client OID promotion forwards the base guard context to the exchange chokepoint', async () => {
    const value = fixture();
    try {
        mkdirSync(path.join(value.root, 'dist'));
        writeFileSync(path.join(value.root, 'dist', 'index.html'), '<main>old</main>');
        enqueuePreviewEvent(value.root, { sequence: 70, oid: value.oid, domains: ['client'] });
        const sourceRoot = await materializePreviewSnapshot(value.root, value.oid);
        const candidate = await buildClientPreviewFromOid({
            root: value.root, sourceRoot, expectedOid: value.oid, group: 'event-0000000000000070',
        }, {
            contract: contract(),
            run: (_command, _args, options = {}) => {
                if (!options.env?.NASSAJ_CLIENT_OUT_DIR) return;
                writeFileSync(path.join(options.env.NASSAJ_CLIENT_OUT_DIR, 'index.html'), '<main>new</main>');
                writeFileSync(path.join(options.env.NASSAJ_CLIENT_OUT_DIR, 'version.json'), `${JSON.stringify({ buildId: BUILD_ID })}\n`);
            },
        });
        let seen = null;
        const capturing = contract();
        const inner = capturing.promoteWithSmokeRollback;
        capturing.promoteWithSmokeRollback = async (c, l, smoke, guardOptions) => { seen = guardOptions; return inner(c, l, smoke); };
        await promoteClientPreviewFromOid({
            root: value.root, expectedOid: value.oid, group: 'event-0000000000000070', buildId: candidate.buildId,
        }, { contract: capturing });
        assert.deepEqual(seen, { root: path.resolve(value.root), allowNonMain: false });
    } finally { cleanup(value.root); }
});

function retentionFixture(t) {
    const root = mkdtempSync(path.join(PROJECT_ROOT, '.artifacts', 'b896-test-'));
    t.after(() => cleanup(root));
    git(root, 'init', '-q');
    for (const name of ['nassaj-local-preview-build.lock', 'nassaj-client-build.lock', 'nassaj-preview-event-mutation.lock']) {
        writeFileSync(path.join(root, '.git', name), '', { flag: 'wx', mode: 0o600 });
    }
    mkdirSync(path.join(root, '.nassaj-local-preview/client-candidates'), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(root, '.nassaj-local-preview/client-recovery'), { mode: 0o700 });
    function generation(directory, index) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const buildId = index.toString(16).padStart(64, '0');
        const oid = index.toString(16).padStart(40, '0');
        writeFileSync(path.join(directory, 'BUILD_PROVENANCE.json'), JSON.stringify({
            artifact: 'client', buildId, commit: oid, dirty: false,
            builtAt: new Date(index * 1000).toISOString(),
        }), { mode: 0o644 });
        writeFileSync(path.join(directory, 'version.json'), JSON.stringify({ buildId }), { mode: 0o644 });
        writeFileSync(path.join(directory, 'payload'), 'retained content', { mode: 0o644 });
        return { directory, buildId, oid };
    }
    const live = generation(path.join(root, 'dist'), 100);
    const recoveries = [];
    for (let i = 1; i <= 5; i++) recoveries.push(generation(path.join(root,
        '.nassaj-local-preview/client-recovery', `${'f'.repeat(64)}-${i.toString().padStart(36, '0')}`), i));
    return { root, live, recoveries, generation, plan: (extra = {}) =>
        planClientPreviewRetention({ root, startupBuildId: live.buildId, ...extra }) };
}

test('retention dry-run uses contained identity, preserves latest three and changes no files', (t) => {
    const f = retentionFixture(t); const p = f.plan();
    assert.equal(p.dryRun, true); assert.equal(p.remove.length, 2);
    assert.deepEqual(p.remove.map((x) => x.buildId), [f.recoveries[1].buildId, f.recoveries[0].buildId]);
    assert.ok(p.reclaimableBytes > 0);
    for (const item of f.recoveries) assert.equal(existsSync(item.directory), true);
});

test('retention protects startup and all candidate generation identities', (t) => {
    const f = retentionFixture(t);
    f.generation(path.join(f.root, '.nassaj-local-preview/client-candidates', f.recoveries[1].buildId), 2);
    const p = f.plan({ startupBuildId: f.recoveries[0].buildId });
    assert.equal(p.remove.length, 0);
});

test('retention keeps symlink and unknown provenance generations without following them', (t) => {
    const f = retentionFixture(t);
    symlinkSync(path.join(f.root, 'dist'), path.join(f.recoveries[0].directory, 'link'));
    writeFileSync(path.join(f.recoveries[1].directory, 'version.json'), '{}');
    const p = f.plan(); assert.equal(p.remove.length, 0);
    assert.equal(p.retained.filter((x) => x.reason === 'unverified-generation').length, 2);
});

test('retention refuses symlinked parents and cannot operate without startup identity', (t) => {
    const f = retentionFixture(t);
    assert.throws(() => f.plan({ startupBuildId: null }), /build id/);
    const parent = path.join(f.root, '.nassaj-local-preview/client-recovery');
    renameSync(parent, `${parent}-real`); symlinkSync(`${parent}-real`, parent);
    assert.throws(() => f.plan(), /real directory/);
});

test('retention proposal hash changes when a retained payload changes', (t) => {
    const f = retentionFixture(t); const before = f.plan().remove[0];
    writeFileSync(path.join(before.directory, 'payload'), 'changed content');
    const after = f.plan().remove[0];
    assert.notEqual(after.inventorySha256, before.inventorySha256);
});

function retentionEvents(f, { pendingServer = false } = {}) {
    git(f.root, 'config', 'user.name', 'Retention Test');
    git(f.root, 'config', 'user.email', 'retention@example.invalid');
    git(f.root, 'commit', '--allow-empty', '-qm', 'old');
    const old = git(f.root, 'rev-parse', 'HEAD');
    git(f.root, 'commit', '--allow-empty', '-qm', 'latest');
    const latest = git(f.root, 'rev-parse', 'HEAD');
    enqueuePreviewEvent(f.root, { sequence: 1, oid: old, domains: pendingServer ? ['client', 'server'] : ['client'] });
    enqueuePreviewEvent(f.root, { sequence: 2, oid: latest, domains: ['client'] });
    for (const [sequence, oid] of [[1, old], [2, latest]]) {
        const base = `refs/nassaj/previews/v1/groups/event-${String(sequence).padStart(16, '0')}/client`;
        for (const state of ['candidate', 'promoted', 'served']) git(f.root, 'update-ref', `${base}/${state}`, oid);
    }
    writeFileSync(path.join(f.root, '.git/nassaj-preview-oid-consumer-v1.json'), JSON.stringify({
        schemaVersion: 1, acceptedSequence: 2, client: { sequence: 2, oid: latest, phase: 'served' },
        server: pendingServer ? { sequence: 1, oid: old, phase: 'awaiting_owner' } : null,
    }));
    writeFileSync(path.join(f.root, '.git/nassaj-local-preview-ledger-v1.json'), JSON.stringify({
        schemaVersion: 1, clientSourceGeneration: 2, clientState: 'served', clientServedBuildId: f.live.buildId,
    }));
    const file = path.join(f.recoveries[0].directory, 'BUILD_PROVENANCE.json');
    const p = JSON.parse(readFileSync(file)); p.commit = old; writeFileSync(file, JSON.stringify(p));
    return { old, latest };
}

test('retention archives only coherent terminal historical groups, retaining latest event', (t) => {
    const f = retentionFixture(t); retentionEvents(f);
    const p = f.plan(); assert.deepEqual(p.archivedGroups.map((x) => x.sequence), [1]);
    assert.ok(p.remove.some((x) => x.buildId === f.recoveries[0].buildId));
});

test('client served cannot archive a group whose server still awaits owner', (t) => {
    const f = retentionFixture(t); retentionEvents(f, { pendingServer: true });
    const p = f.plan(); assert.equal(p.archivedGroups.length, 0);
    assert.ok(!p.remove.some((x) => x.buildId === f.recoveries[0].buildId));
});

test('retention refuses an incoherent or busy consumer before offering deletions', (t) => {
    const f = retentionFixture(t); retentionEvents(f);
    const file = path.join(f.root, '.git/nassaj-preview-oid-consumer-v1.json');
    const p = JSON.parse(readFileSync(file)); p.client.phase = 'building'; writeFileSync(file, JSON.stringify(p));
    assert.throws(() => f.plan(), /coherent and idle/);
});

test('a separate pending reference protects an otherwise archived generation', (t) => {
    const f = retentionFixture(t); const { old } = retentionEvents(f);
    git(f.root, 'update-ref', 'refs/nassaj/previews/v1/groups/manual-pending/desired', old);
    assert.ok(!f.plan().remove.some((x) => x.buildId === f.recoveries[0].buildId));
});

async function preparedRetention(t) {
    const f = retentionFixture(t);
    mkdirSync(path.join(f.root, '.artifacts'));
    const health = { status: 'ok', service: 'nassaj-server', pid: 123,
        clientBuildIdServed: f.live.buildId, clientBuildIdAtServerStartup: f.live.buildId };
    const injected = { fetchHealth: async () => health };
    const plan = await prepareClientPreviewRetention({ root: f.root }, injected);
    const manifestFile = path.join(f.root, '.artifacts/reviewed.json');
    const bytes = JSON.stringify(plan); writeFileSync(manifestFile, bytes, { mode: 0o600 });
    const options = { root: f.root, manifestFile,
        expectedManifestSha256: createHash('sha256').update(bytes).digest('hex') };
    return { ...f, options, injected, health, plan };
}

test('reviewed retention applies only exact old recoveries through quarantine', async (t) => {
    const f = await preparedRetention(t);
    const result = await applyClientPreviewRetention(f.options, f.injected);
    assert.equal(result.removed.length, 2);
    for (const item of f.recoveries.slice(0, 2)) assert.equal(existsSync(item.directory), false);
    for (const item of f.recoveries.slice(2)) assert.equal(existsSync(item.directory), true);
    assert.equal(existsSync(path.join(f.root, 'dist/payload')), true);
    assert.ok(!readdirSync(path.join(f.root, '.nassaj-local-preview/client-recovery')).some((n) => n.startsWith('.retention')));
});

test('retention refuses stale manifest, changed startup, and missing live resources', async (t) => {
    const f = await preparedRetention(t);
    await assert.rejects(applyClientPreviewRetention({ ...f.options, expectedManifestSha256: '0'.repeat(64) }, f.injected), /digest mismatch/);
    f.health.clientBuildIdAtServerStartup = 'c'.repeat(64);
    await assert.rejects(applyClientPreviewRetention(f.options, f.injected), /proposal changed/);
    f.health.clientBuildIdAtServerStartup = f.live.buildId;
    writeFileSync(path.join(f.recoveries[0].directory, 'payload'), 'different resource bytes');
    await assert.rejects(applyClientPreviewRetention(f.options, f.injected), /proposal changed/);
    for (const item of f.recoveries) assert.equal(existsSync(item.directory), true);
});

test('retention lock fixtures stay private with a group-permissive umask', t => {
    let f; const previous = process.umask(0o002);
    try { f = retentionFixture(t); }
    finally { process.umask(previous); }
    for (const name of ['nassaj-local-preview-build.lock', 'nassaj-client-build.lock', 'nassaj-preview-event-mutation.lock']) {
        assert.equal(statSync(path.join(f.root, '.git', name)).mode & 0o777, 0o600, name);
    }
});

test('retention proof actually holds both build domains and event promotion lock', async (t) => {
    const f = await preparedRetention(t);
    let checked = 0;
    const injected = { fetchHealth: async () => {
        for (const name of ['nassaj-local-preview-build.lock', 'nassaj-client-build.lock', 'nassaj-preview-event-mutation.lock']) {
            assert.throws(() => execFileSync('flock', ['-n', '-E', '75', path.join(f.root, '.git', name), 'true']),
                (error) => error.status === 75);
        }
        checked++; return f.health;
    } };
    await applyClientPreviewRetention(f.options, injected); assert.equal(checked, 2);
});

test('pre-existing ambiguous quarantine is retained, never resumed', async (t) => {
    const f = retentionFixture(t);
    const quarantine = path.join(f.root, '.nassaj-local-preview/client-recovery/.retention-quarantine-unknown');
    mkdirSync(quarantine); writeFileSync(path.join(quarantine, 'evidence'), 'keep');
    const p = f.plan(); assert.ok(p.retained.some((x) => x.directory === quarantine));
    assert.equal(readFileSync(path.join(quarantine, 'evidence'), 'utf8'), 'keep');
});

test('late recovery mutation aborts before any rename or remove', async (t) => {
    const f = await preparedRetention(t); let calls = 0;
    await assert.rejects(applyClientPreviewRetention(f.options, { fetchHealth: async () => {
        if (++calls === 2) writeFileSync(path.join(f.plan.remove[0].directory, 'payload'), 'late mutation');
        return f.health;
    } }), /changed before quarantine/);
    for (const item of f.recoveries) assert.equal(existsSync(item.directory), true);
});

test('an existing apply journal blocks retries rather than resuming an ambiguous effect', async (t) => {
    const f = await preparedRetention(t);
    writeFileSync(path.join(f.root, '.artifacts', `b896-retention-${f.options.expectedManifestSha256}.json`), '{}');
    await assert.rejects(applyClientPreviewRetention(f.options, f.injected), /EEXIST/);
    for (const item of f.recoveries) assert.equal(existsSync(item.directory), true);
});

async function restorationFixture(t) {
    const f = retentionFixture(t);
    git(f.root, 'config', 'user.name', 'Restoration Test');
    git(f.root, 'config', 'user.email', 'restoration@example.invalid');
    mkdirSync(path.join(f.root, 'scripts'));
    writeFileSync(path.join(f.root, 'package.json'), '{"version":"1.44.0.1"}');
    writeFileSync(path.join(f.root, 'scripts/client-build-atomic.mjs'),
        `export { mergeLegacyAssets, verifyAssetClosure, verifyBuildIdentity } from ${JSON.stringify(pathToFileURL(path.join(PROJECT_ROOT, 'scripts/client-build-atomic.mjs')).href)};
import { renameSync } from "node:fs";
// Explicit exchange fixture: real exchange/rollback behavior is covered by client-build-atomic.test.mjs.
export const promoteWithSmokeRollback = ${contract().promoteWithSmokeRollback.toString()};`);
    git(f.root, 'add', 'package.json', 'scripts/client-build-atomic.mjs');
    git(f.root, 'commit', '-qm', 'reviewed contract');
    const { latest } = retentionEvents(f);
    // The live base commit must be an ancestor-or-equal of the candidate source
    // for the shared publish base guard on the real promote path; a real served
    // generation is always stamped with a real commit, so pin it to `latest`.
    const liveProvenanceFile = path.join(f.live.directory, 'BUILD_PROVENANCE.json');
    writeFileSync(liveProvenanceFile, JSON.stringify({ ...JSON.parse(readFileSync(liveProvenanceFile)), commit: latest }));
    const sourceRoot = await materializePreviewSnapshot(f.root, latest);
    const candidate = f.generation(path.join(f.root, '.nassaj-local-preview/client-candidates', f.live.buildId), 100);
    const provenanceFile = path.join(candidate.directory, 'BUILD_PROVENANCE.json');
    const provenance = JSON.parse(readFileSync(provenanceFile));
    Object.assign(provenance, { commit: latest, baseCommit: latest });
    writeFileSync(provenanceFile, JSON.stringify(provenance));
    writeFileSync(path.join(candidate.directory, 'index.html'), '<main>new</main>', { mode: 0o644 });
    const survivor = f.recoveries.at(-1);
    for (const [directory, assets] of [[f.live.directory, { 'live.js': 'live' }],
        [candidate.directory, { 'new.js': `new ${candidate.buildId}` }], [survivor.directory, { 'lost.js': 'lost' }]]) {
        mkdirSync(path.join(directory, 'assets'), { mode: 0o700 });
        for (const [name, data] of Object.entries(assets)) writeFileSync(path.join(directory, 'assets', name), data, { mode: 0o644 });
    }
    writeFileSync(path.join(survivor.directory, 'ATOMIC_GENERATION.json'), JSON.stringify({
        assets: [{ path: 'assets/lost.js', size: 4, lastFreshAt: null }], emittedAssets: ['assets/lost.js'],
    }), { mode: 0o644 });
    const injected = { fetchHealth: async () => ({ status: 'ok', service: 'nassaj-server', pid: 123,
        clientBuildIdServed: f.live.buildId, clientBuildIdAtServerStartup: f.live.buildId }),
        contract: { ...contract(), mergeLegacyAssets, promoteWithSmokeRollback }, run: () => { throw new Error('Restoration must never build'); } };
    const prepareOptions = { root: f.root, sourceRoot, expectedOid: latest,
        group: 'event-0000000000000002', buildId: candidate.buildId, recoveryDirectory: survivor.directory };
    const plan = await prepareClientAssetRestoration(prepareOptions, injected);
    mkdirSync(path.join(f.root, '.artifacts'));
    const manifestFile = path.join(f.root, '.artifacts/restoration.json'), bytes = JSON.stringify(plan);
    writeFileSync(manifestFile, bytes, { mode: 0o600 });
    return { ...f, candidate, survivor, plan, injected, prepareOptions,
        options: { root: f.root, manifestFile, expectedManifestSha256: createHash('sha256').update(bytes).digest('hex') } };
}

test('restoration real Git plan publishes same-build served event through actual merge without rebuilding', async t => {
    const f = await restorationFixture(t);
    assert.equal(f.plan.assets.length, 1);
    assert.equal(existsSync(path.join(f.live.directory, 'assets/lost.js')), false);
    const { contract: _fixtureContract, ...actualLoader } = f.injected;
    const result = await restorePublishedClientAssets(f.options, actualLoader);
    assert.equal(result.served, true);
    assert.equal(readFileSync(path.join(f.live.directory, 'assets/lost.js'), 'utf8'), 'lost');
    assert.equal(readFileSync(path.join(f.live.directory, 'assets/live.js'), 'utf8'), 'live');
    assert.equal(readFileSync(path.join(f.live.directory, 'assets/new.js'), 'utf8'), `new ${f.candidate.buildId}`);
    const metadata = JSON.parse(readFileSync(path.join(f.live.directory, 'ATOMIC_GENERATION.json')));
    assert.equal(metadata.assets.find(x => x.path === 'assets/lost.js').lastFreshAt, null);
    assert.equal(readPreviewLedger(f.root).clientState, 'served');
});

for (const kind of ['candidate', 'witness', 'live', 'contract', 'wrong-approval']) {
    test(`restoration rejects ${kind} drift before exchange`, async t => {
        const f = await restorationFixture(t);
        const original = readFileSync(path.join(f.live.directory, 'payload'));
        if (kind === 'candidate') writeFileSync(path.join(f.candidate.directory, 'payload'), 'candidate drift');
        if (kind === 'witness') writeFileSync(path.join(f.survivor.directory, 'payload'), 'witness drift');
        if (kind === 'live') writeFileSync(path.join(f.live.directory, 'assets/live.js'), 'live drift');
        if (kind === 'contract') {
            execFileSync('chmod', ['u+w', f.plan.mergeContract.path]);
            writeFileSync(f.plan.mergeContract.path, 'throw new Error("unreviewed contract must not execute");');
        }
        if (kind === 'wrong-approval') f.options.expectedManifestSha256 = '0'.repeat(64);
        await assert.rejects(restorePublishedClientAssets(f.options, f.injected), /changed|drift|digest|snapshot|OID|contract/i);
        assert.deepEqual(readFileSync(path.join(f.live.directory, 'payload')), original);
        assert.equal(existsSync(path.join(f.live.directory, 'assets/lost.js')), false);
    });
}

test('restoration partial candidate mutation leaves live untouched and invalidates old plan', async t => {
    const f = await restorationFixture(t);
    const broken = { ...f.injected, contract: { ...f.injected.contract, mergeLegacyAssets: (...args) => {
        mergeLegacyAssets(...args); throw new Error('copy completion interrupted');
    } } };
    await assert.rejects(restorePublishedClientAssets(f.options, broken), /interrupted/);
    assert.equal(existsSync(path.join(f.live.directory, 'assets/lost.js')), false);
    assert.equal(existsSync(path.join(f.candidate.directory, 'assets/lost.js')), true);
    await assert.rejects(restorePublishedClientAssets(f.options, f.injected), /plan changed/);
});

test('restoration cannot publish if an older contract ignores restoration input', async t => {
    const f = await restorationFixture(t);
    const old = { ...f.injected, contract: { ...f.injected.contract,
        mergeLegacyAssets: (live, candidate) => mergeLegacyAssets(live, candidate) } };
    await assert.rejects(restorePublishedClientAssets(f.options, old), /omitted reviewed asset/);
    assert.equal(existsSync(path.join(f.live.directory, 'assets/lost.js')), false);
});

for (const kind of ['live-conflict', 'dangling-live', 'candidate-witness', 'unprotected-witness']) {
    test(`restoration plan rejects ${kind}`, async t => {
        const f = await restorationFixture(t);
        if (kind === 'live-conflict') writeFileSync(path.join(f.live.directory, 'assets/lost.js'), 'conflict');
        if (kind === 'dangling-live') symlinkSync('missing', path.join(f.live.directory, 'assets/lost.js'));
        if (kind === 'candidate-witness') f.prepareOptions.recoveryDirectory = f.candidate.directory;
        if (kind === 'unprotected-witness') f.prepareOptions.recoveryDirectory = f.recoveries[0].directory;
        await assert.rejects(prepareClientAssetRestoration(f.prepareOptions, f.injected), /conflict|unsafe|protected/i);
    });
}

test('restoration rechecks full protected witness after merge and before actual exchange', async t => {
    const f = await restorationFixture(t);
    const changed = { ...f.injected, contract: { ...f.injected.contract, mergeLegacyAssets: (...args) => {
        mergeLegacyAssets(...args);
        writeFileSync(path.join(f.survivor.directory, 'payload'), 'late witness drift');
    } } };
    await assert.rejects(restorePublishedClientAssets(f.options, changed), /witness|references/);
    assert.equal(existsSync(path.join(f.live.directory, 'assets/lost.js')), false);
    assert.equal(readFileSync(path.join(f.live.directory, 'payload'), 'utf8'), 'retained content');
});

test('restoration CLI rejects duplicate, unknown and lock bypass flags before filesystem access', () => {
    const entry = path.join(PROJECT_ROOT, 'scripts/client-preview-from-oid.mjs');
    for (const args of [
        ['--repo', '/missing', '--repo', '/missing'], ['--locked'], ['--force', 'yes'],
        ['--recovery', '/missing', '--unknown', 'yes'],
    ]) {
        assert.throws(() => execFileSync(process.execPath, [entry, 'restoration-plan', ...args],
            { encoding: 'utf8', stdio: 'pipe' }), error => /Invalid restoration argument/.test(error.stderr));
    }
});

async function sameContentClientFixture(t) {
    const value = fixture(); t.after(()=>cleanup(value.root));
    mkdirSync(path.join(value.root,'dist')); writeFileSync(path.join(value.root,'dist/index.html'),'live-unchanged');
    const buildContract={...contract(),computeClientBuildId};
    const run=(_cmd,_args,options={})=>{
        if(!options.env?.NASSAJ_CLIENT_OUT_DIR)return;
        writeFileSync(path.join(options.env.NASSAJ_CLIENT_OUT_DIR,'index.html'),'<main>new</main>');
        writeFileSync(path.join(options.env.NASSAJ_CLIENT_OUT_DIR,'version.json'),JSON.stringify({buildId:options.env.NASSAJ_BUILD_ID}));
    };
    const build=async(oid,sequence,overrides={})=>{
        enqueuePreviewEvent(value.root,{sequence,oid,domains:['client']});
        const sourceRoot=await materializePreviewSnapshot(value.root,oid);
        return buildClientPreviewFromOid({root:value.root,sourceRoot,expectedOid:oid,group:`event-${String(sequence).padStart(16,'0')}`},
            {contract:buildContract,run,...overrides});
    };
    const first=await build(value.oid,90);
    const oldProvenance=readFileSync(path.join(first.candidatePath,'BUILD_PROVENANCE.json'));
    writeFileSync(path.join(value.root,'docs-only.md'),'new docs');git(value.root,'add','docs-only.md');git(value.root,'commit','-qm','docs only');
    const nextOid=git(value.root,'rev-parse','HEAD');
    assert.notEqual(nextOid,value.oid);
    const nextSnapshot=await materializePreviewSnapshot(value.root,nextOid);
    assert.equal(computeClientBuildId(nextSnapshot),first.buildId);
    return {...value,first,oldProvenance,nextOid,build,run};
}

test('two real commits with identical client inputs rebuild provenance atomically',async t=>{
    const v=await sameContentClientFixture(t);
    const next=await v.build(v.nextOid,91);
    assert.equal(next.buildId,v.first.buildId);
    assert.equal(next.candidatePath,v.first.candidatePath);
    const record=JSON.parse(readFileSync(path.join(next.candidatePath,'BUILD_PROVENANCE.json')));
    assert.equal(record.commit,v.nextOid);assert.equal(record.baseCommit,v.nextOid);
    assert.equal(readFileSync(path.join(v.root,'dist/index.html'),'utf8'),'live-unchanged');
});

for(const failure of ['build','exchange']) test(`failed same-content ${failure} replacement preserves the old candidate`,async t=>{
    const v=await sameContentClientFixture(t);
    const failureFn=()=>{throw Error('replacement-failed');};
    await assert.rejects(v.build(v.nextOid,91,failure==='build'?{run:failureFn}:{exchangeCandidate:failureFn}),/replacement-failed/);
    assert.deepEqual(readFileSync(path.join(v.first.candidatePath,'BUILD_PROVENANCE.json')),v.oldProvenance);
    assert.equal(readFileSync(path.join(v.first.candidatePath,'index.html'),'utf8'),'<main>new</main>');
});

test('new OID does not excuse a tampered existing build identity',async t=>{
    const v=await sameContentClientFixture(t),file=path.join(v.first.candidatePath,'version.json');
    writeFileSync(file,JSON.stringify({buildId:'0'.repeat(64)}));
    await assert.rejects(v.build(v.nextOid,91));
    assert.deepEqual(readFileSync(path.join(v.first.candidatePath,'BUILD_PROVENANCE.json')),v.oldProvenance);
});

for(const phase of ['prepared','awaiting_sessions','manual_recovery_required']) test(`sealed ${phase} event protects a same-content candidate`,async t=>{
    const v=await sameContentClientFixture(t);
    writeFileSync(path.join(v.root,'.git','nassaj-preview-oid-event-control-0000000000000090.json'),JSON.stringify({localUpdate:{phase,target:{clientBuildId:v.first.buildId}}}));
    await assert.rejects(v.build(v.nextOid,91),/client_candidate_bound_to_local_update/);
    assert.deepEqual(readFileSync(path.join(v.first.candidatePath,'BUILD_PROVENANCE.json')),v.oldProvenance);
});

test('replacement compares the original complete candidate again under the event lock',async t=>{
    const v=await sameContentClientFixture(t);
    await assert.rejects(v.build(v.nextOid,91,{run:(cmd,args,options)=>{
        v.run(cmd,args,options);
        if(options?.env?.NASSAJ_CLIENT_OUT_DIR)writeFileSync(path.join(v.first.candidatePath,'concurrent'),'another operation');
    }}),/client_candidate_compare_exchange_conflict/);
    assert.deepEqual(readFileSync(path.join(v.first.candidatePath,'BUILD_PROVENANCE.json')),v.oldProvenance);
});

test('active pair transaction protects the canonical client candidate',async t=>{
    const v=await sameContentClientFixture(t),nonce='d'.repeat(64);
    writeFileSync(path.join(v.root,'.git',`nassaj-oid-control-transaction-90-${nonce}.json`),JSON.stringify({
        schema:'nassaj-oid-control-transaction/v1',sequence:90,oid:v.oid,transactionNonce:nonce,state:'pair_prepared',buildId:v.first.buildId,
    }));
    await assert.rejects(v.build(v.nextOid,91),/oid_control_transaction_in_progress/);
    assert.deepEqual(readFileSync(path.join(v.first.candidatePath,'BUILD_PROVENANCE.json')),v.oldProvenance);
});

test('failed post-exchange verification atomically restores the previous candidate',async t=>{
    const v=await sameContentClientFixture(t);let exchanges=0;
    await assert.rejects(v.build(v.nextOid,91,{exchangeCandidate:(left,right)=>{
        execFileSync('/usr/bin/mv',['--exchange','--no-copy','-T',left,right]);
        if(++exchanges===1){
            const file=path.join(right,'BUILD_PROVENANCE.json'),record=JSON.parse(readFileSync(file));
            writeFileSync(file,JSON.stringify({...record,commit:'a'.repeat(40)}));
        }
    }}),/identity conflict/);
    assert.equal(exchanges,2);
    assert.deepEqual(readFileSync(path.join(v.first.candidatePath,'BUILD_PROVENANCE.json')),v.oldProvenance);
});
