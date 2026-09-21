import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { bootstrapFixture } from './bootstrap-publication.test.fixture.mjs';
import { readBootstrapPublicationPacket, assertBootstrapPublicationContext, recordBootstrapPublicationState } from './node-update-publication-guard.mjs';
import { assertStandaloneNodePublication } from './node-update-mode.mjs';
import { consumeNewestPreview, enqueuePreviewEvent, withPreviewEventMutationLock } from '../preview-oid-consumer.mjs';
import { promoteClientPreviewFromOid } from '../client-preview-from-oid.mjs';
import { publishIsolatedClient } from '../client-isolated-publish.mjs';
import { buildAndPublishServer } from '../server-build-atomic.mjs';
const scoped = v => ({ domains: ['server'], bootstrapPacket: v.packetFile });
function operations(v, counters) { return {
    materialize: () => { counters.materialize++; return v.root; },
    buildServer: () => { counters.build++;
        const directory = path.join(v.root, '.nassaj-local-preview/server-candidates', v.scope.serverBuildId);
        fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
        fs.writeFileSync(path.join(directory, 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact: 'server', buildId: v.scope.serverBuildId, commit: v.oid, baseCommit: v.oid, dirty: false }), { mode: 0o644 });
        const manifest = JSON.stringify({ schema: 'nassaj-oid-control-runtime/v1', serverBuildId: v.scope.serverBuildId });
        fs.writeFileSync(path.join(directory, 'OID_CONTROL_MANIFEST.json'), manifest, { mode: 0o644 });
        return { buildId: v.scope.serverBuildId, controlManifestSha256: createHash('sha256').update(manifest).digest('hex') }; },
    requestServerControlPlane: () => { counters.queue++; return { actionId: `synthetic-action-${v.sequence}` }; },
    buildClient: () => assert.fail('consumer must not build bootstrap client'),
    promoteClient: () => assert.fail('consumer must never publish client'),
}; }
for (const mode of ['release', 'local-main']) test(`standalone ${mode} publication refuses before any build/promotion`, async t => {
    const v = bootstrapFixture(t); fs.writeFileSync(path.join(v.root, '.env'), `NASSAJ_UPDATE_MODE=${mode}\n`);
    assert.throws(() => assertStandaloneNodePublication(v.root), /button_required/);
    assert.throws(() => buildAndPublishServer({ root: v.root }, { run: () => assert.fail('build') }), /button_required/);
    await assert.rejects(publishIsolatedClient({ root: v.root, sourceRef: v.oid }), /button_required/);
    await assert.rejects(promoteClientPreviewFromOid({ root: v.root }), /button_required/);
});
for (const mode of [undefined, 'release', 'legacy', 'local-main']) test(`release consumer mode=${mode} cannot restore legacy publication`, async t => {
    const v = bootstrapFixture(t), calls = { materialize: 0, build: 0, queue: 0 };
    await assert.rejects(consumeNewestPreview(v.root, operations(v, calls), { mode, domains: ['client', 'server'] }), /button_required|mode_override/);
    assert.deepEqual(calls, { materialize: 0, build: 0, queue: 0 });
});
test('valid server packet prepares once, and replay reads same receipt without following a newer event', async t => {
    const v = bootstrapFixture(t), calls = { materialize: 0, build: 0, queue: 0 }, ops = operations(v, calls);
    const first = await consumeNewestPreview(v.root, ops, scoped(v)); assert.equal(first.state.server.phase, 'awaiting_owner');
    enqueuePreviewEvent(v.root, { sequence: 32, oid: v.oid, domains: ['server'] });
    const replay = await consumeNewestPreview(v.root, ops, scoped(v)); assert.equal(replay.event.sequence, 31);
    assert.deepEqual(calls, { materialize: 1, build: 1, queue: 1 });
});
for (const field of ['root', 'oid', 'sequence', 'group', 'serviceUid', 'configBindingSha256']) test(`packet rejects wrong ${field} before effects`, async t => {
    const v = bootstrapFixture(t), calls = { materialize: 0, build: 0, queue: 0 };
    v.scope[field] = typeof v.scope[field] === 'number' ? v.scope[field] + 1 : 'invalid'; v.writePacket();
    await assert.rejects(consumeNewestPreview(v.root, operations(v, calls), scoped(v)), /bootstrap/);
    assert.deepEqual(calls, { materialize: 0, build: 0, queue: 0 });
});
test('packet refuses client scope, wrong file mode, outside path and symlink', async t => {
    const v = bootstrapFixture(t), calls = { materialize: 0, build: 0, queue: 0 };
    await assert.rejects(consumeNewestPreview(v.root, operations(v, calls), { ...scoped(v), domains: ['client', 'server'] }), /server_only/);
    fs.chmodSync(v.packetFile, 0o644); assert.throws(() => readBootstrapPublicationPacket(v.root, v.packetFile), /unsafe/);
    fs.chmodSync(v.packetFile, 0o600); const alias = path.join(v.root, 'alias'); fs.symlinkSync(v.packetFile, alias);
    assert.throws(() => readBootstrapPublicationPacket(v.root, alias), /packet_path/);
    assert.throws(() => readBootstrapPublicationPacket(path.join(v.root, 'private-packet'), v.packetFile), /packet_path|root|identity/);
});
test('build mismatch never queues and cannot rebuild on replay', async t => {
    const v = bootstrapFixture(t), calls = { materialize: 0, build: 0, queue: 0 }, ops = operations(v, calls);
    ops.buildServer = () => { calls.build++; return { buildId: v.scope.clientBuildId }; };
    await assert.rejects(consumeNewestPreview(v.root, ops, scoped(v)), /context_serverBuildId/);
    await assert.rejects(consumeNewestPreview(v.root, ops, scoped(v)), /incomplete_step/);
    assert.equal(calls.build, 1); assert.equal(calls.queue, 0);
});
test('queue interruption refuses duplicate request and preserves intent', async t => {
    const v = bootstrapFixture(t), calls = { materialize: 0, build: 0, queue: 0 }, ops = operations(v, calls);
    ops.requestServerControlPlane = () => { calls.queue++; throw Error('simulated lost queue response'); };
    await assert.rejects(consumeNewestPreview(v.root, ops, scoped(v)), /simulated/);
    await assert.rejects(consumeNewestPreview(v.root, ops, scoped(v)), /incomplete_step/);
    assert.equal(calls.queue, 1); assert.equal(calls.build, 1);
});
test('packet replacement and terminal state close authorization', async t => {
    const v = bootstrapFixture(t), binding = readBootstrapPublicationPacket(v.root, v.packetFile);
    v.packet.note = 'changed'; v.writePacket(); assert.throws(() => assertBootstrapPublicationContext(v.root, binding, {}), /changed/);
    delete v.packet.note; v.writePacket();
    await withPreviewEventMutationLock(v.root, () => recordBootstrapPublicationState(v.root, binding, { terminal: true }));
    const calls = { materialize: 0, build: 0, queue: 0 };
    await assert.rejects(consumeNewestPreview(v.root, operations(v, calls), scoped(v)), /terminal/);
    assert.equal(calls.build, 0);
});

test('a terminal consumer record for an older sequence does not block a new exact packet', async t => {
    const v = bootstrapFixture(t), calls = { materialize: 0, build: 0, queue: 0 };
    fs.writeFileSync(path.join(v.root, '.git/nassaj-preview-oid-consumer-v1.json'), JSON.stringify({ schemaVersion: 1,
        acceptedSequence: 30, server: { sequence: 30, oid: v.oid, phase: 'loaded' } }));
    assert.equal((await consumeNewestPreview(v.root, operations(v, calls), scoped(v))).status, 'consumed');
});
for (const artifact of ['OID_CONTROL_CAPSULE.mjs', 'scripts/safe-restart.sh', 'BUILD_PROVENANCE.json']) {
    test(`changed old runtime ${artifact} rejects before build`, async t => {
        const v = bootstrapFixture(t), calls = { materialize: 0, build: 0, queue: 0 };
        fs.writeFileSync(path.join(v.root, 'dist-server', artifact), artifact.endsWith('.json') ? '{}' : 'changed');
        await assert.rejects(consumeNewestPreview(v.root, operations(v, calls), scoped(v)), /runtime_executor_changed/);
        assert.equal(calls.build, 0);
    });
}
test('changed process ticks reject even when the packet is rewritten coherently', async t => {
    const v = bootstrapFixture(t), calls = { materialize: 0, build: 0, queue: 0 };
    v.scope.oldStartTicks = String(Number(v.scope.oldStartTicks) + 1); v.writePacket();
    await assert.rejects(consumeNewestPreview(v.root, operations(v, calls), scoped(v)), /runtime_process_changed/);
    assert.equal(calls.queue, 0);
});
for (const lost of ['request', 'candidate', 'action']) test(`prepared replay rejects missing ${lost} evidence without requeue`, async t => {
    const v = bootstrapFixture(t), calls = { materialize: 0, build: 0, queue: 0 }, ops = operations(v, calls);
    await consumeNewestPreview(v.root, ops, scoped(v));
    if (lost === 'request') fs.unlinkSync(path.join(v.root, '.git/nassaj-preview-oid-control-request-v1.json'));
    if (lost === 'candidate') fs.unlinkSync(path.join(v.root, '.nassaj-local-preview/server-candidates', v.scope.serverBuildId, 'BUILD_PROVENANCE.json'));
    if (lost === 'action') {
        const { createRequire } = await import('node:module'), Database = createRequire(import.meta.url)('better-sqlite3');
        const db = new Database(v.packet.configBinding.database.path); db.prepare('DELETE FROM pending_server_actions WHERE id=?').run('synthetic-action-31'); db.close();
    }
    await assert.rejects(consumeNewestPreview(v.root, ops, scoped(v)), /evidence_changed|candidate_changed/);
    assert.deepEqual(calls, { materialize: 1, build: 1, queue: 1 });
});
test('symlinked event control and external hardlink packet refuse', async t => {
    const v = bootstrapFixture(t), calls = { materialize: 0, build: 0, queue: 0 };
    fs.symlinkSync(v.packetFile, path.join(v.root, '.git/nassaj-preview-oid-event-control-0000000000000031.json'));
    await assert.rejects(consumeNewestPreview(v.root, operations(v, calls), scoped(v)), /ELOOP|unsafe/);
    fs.linkSync(v.packetFile, path.join(v.root, 'packet-alias'));
    assert.throws(() => readBootstrapPublicationPacket(v.root, v.packetFile), /unsafe/);
});

for (const mode of ['release', 'local-main']) test(`actual standalone CLI/watch entry points deny ${mode} before starting work`, t => {
    const v = bootstrapFixture(t), scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const entries = [
        ['client-build-watch.mjs'], ['client-build-atomic.mjs'], ['server-build-atomic.mjs'],
        ['client-isolated-publish.mjs', '--repo', v.root, '--source-ref', v.oid],
        ['client-preview-from-oid.mjs', 'promote', '--repo', v.root, '--expected-oid', v.oid, '--group', v.group, '--build-id', v.scope.clientBuildId],
        ['preview-oid-activate.mjs', 'activate', '--repo', v.root, '--expected-oid', v.oid, '--group', v.group, '--build-id', v.scope.serverBuildId],
    ];
    if (mode === 'release') entries.push(['preview-oid-consumer.mjs', '--repo', v.root]);
    for (const [entry, ...args] of entries) {
        const result = spawnSync(process.execPath, [path.join(scripts, entry), ...args], { cwd: v.root, encoding: 'utf8', timeout: 5000,
            env: { PATH: process.env.PATH, TMPDIR: '/var/tmp', NASSAJ_UPDATE_MODE: mode,
                NASSAJ_PREVIEW_OID_ENFORCEMENT: '1', NASSAJ_PREVIEW_OID_DOMAINS: 'server' } });
        assert.equal(result.status, 1, `${entry}: ${result.stderr}`);
        assert.match(result.stderr, /node_update_button_required/, entry);
    }
    assert.equal(fs.existsSync(path.join(v.root, '.git/nassaj-client-build.lock')), false);
    assert.equal(fs.existsSync(path.join(v.root, '.nassaj-client-snapshots')), false);
    assert.equal(fs.existsSync(path.join(v.root, '.git/nassaj-preview-oid-control-request-v1.json')), false);
});

for (const state of ['promoted', 'rolled_back', 'unknown']) for (const action of ['activate', 'rollback']) {
    test(`standalone ${action} cannot reuse terminal or unknown ${state} authority`, t => {
        const v = bootstrapFixture(t), file = path.join(v.root, `.git/nassaj-preview-oid-activation-${v.group}.json`);
        const bytes = JSON.stringify({ schemaVersion: 1, state, group: v.group, oid: v.oid, buildId: v.scope.serverBuildId });
        fs.writeFileSync(file, bytes);
        const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../preview-oid-activate.mjs');
        const result = spawnSync(process.execPath, [cli, action, '--repo', v.root, '--group', v.group,
            '--expected-oid', v.oid, '--build-id', v.scope.serverBuildId, '--locked'], { encoding: 'utf8', timeout: 5000 });
        assert.equal(result.status, 1); assert.match(result.stderr, /node_update_button_required/);
        assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    });
}

test('bootstrap reads the pinned outside-root database through its loaded FD under a private ancestor', async t => {
    const v = bootstrapFixture(t), calls = { materialize: 0, build: 0, queue: 0 };
    assert.equal(v.packet.configBinding.database.path.startsWith(`${v.root}/`), false);
    fs.chmodSync(path.dirname(v.packet.configBinding.database.path), 0o775);
    const result = await consumeNewestPreview(v.root, operations(v, calls), scoped(v));
    assert.equal(result.bootstrap.server, 'prepared'); assert.equal(calls.queue, 1);
});
test('packet cannot substitute a different regular database not open in the loaded process', async t => {
    const v = bootstrapFixture(t), calls = { materialize: 0, build: 0, queue: 0 };
    const original = v.packet.configBinding.database.path, substitute = `${original}.other`;
    fs.copyFileSync(original, substitute); fs.chmodSync(substitute, 0o600);
    const stat = fs.statSync(substitute);
    v.packet.configBinding.database = { path: substitute, dev: stat.dev, ino: stat.ino, uid: stat.uid };
    v.scope.configBindingSha256 = createHash('sha256').update(JSON.stringify(v.packet.configBinding)).digest('hex'); v.writePacket();
    await assert.rejects(consumeNewestPreview(v.root, operations(v, calls), scoped(v)), /database_not_loaded/);
    assert.deepEqual(calls, { materialize: 0, build: 0, queue: 0 });
});
