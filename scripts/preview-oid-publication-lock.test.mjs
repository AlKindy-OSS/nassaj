import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { enqueuePreviewEvent, withPreviewEventMutationLock, consumeNewestPreview, confirmServerLoaded } from './preview-oid-consumer.mjs';
import { bootstrapFixture } from './lib/bootstrap-publication.test.fixture.mjs';
import { tryOrdinarySafeRestart } from './preview-oid-owner-action.mjs';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t) {
    const value = bootstrapFixture(t);
    return { ...value, request: path.join(value.root, '.git/nassaj-preview-oid-control-request-v1.json'),
        event: path.join(value.root, `.git/nassaj-preview-oid-event-control-${String(value.sequence).padStart(16, '0')}.json`) };
}
function producer(value) {
    const { root, packetFile, scope, sequence } = value;
    const source = `import { consumeNewestPreview } from ${JSON.stringify(new URL('./preview-oid-consumer.mjs', import.meta.url).href)};
    const root=process.env.OID_PRODUCER_TEST_ROOT;
    const {writeFileSync}=await import('node:fs');writeFileSync(root+'/producer-started','yes');
    await consumeNewestPreview(root, { materialize: async()=>root,
        buildServer: async()=>({buildId:${JSON.stringify(scope.serverBuildId)},controlManifestSha256:'c'.repeat(64)}),
        requestServerControlPlane: async()=>({actionId:${JSON.stringify('synthetic-action-')}+${sequence}}) }, {domains:['server'],bootstrapPacket:${JSON.stringify(packetFile)}});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
        cwd: root, env: { ...process.env, OID_PRODUCER_TEST_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    const done = new Promise(resolve => { child.once('error', error => resolve({ code: -1, stderr: error.message })); child.once('exit', code => resolve({ code, stderr })); });
    return { child, done };
}
async function candidateReached(root) {
    for (let i = 0; i < 100; i++) {
        if (existsSync(path.join(root, 'producer-started'))) return;
        await wait(10);
    }
    throw new Error('producer did not start');
}
test('actual producer cannot publish event or request while the shared handoff lock is held', async t => {
    const value = fixture(t); let task;
    try {
        await withPreviewEventMutationLock(value.root, async () => {
            task = producer(value); await candidateReached(value.root); await wait(50);
            assert.equal(existsSync(value.event), false, 'event publication escaped the shared lock');
            assert.equal(existsSync(value.request), false, 'request publication escaped the shared lock');
            assert.equal(task.child.exitCode, null); return { status: 0 };
        });
        const outcome = await task.done; assert.equal(outcome.code, 0, outcome.stderr);
        assert.equal(JSON.parse(readFileSync(value.request)).sequence, value.sequence);
    } finally { if (task?.child.exitCode === null) { task.child.kill(); await task.done; } }
});
test('actual waiting producer rechecks newest server event after acquiring publication lock', async t => {
    const value = fixture(t); let task;
    try {
        await withPreviewEventMutationLock(value.root, async () => {
            task = producer(value); await candidateReached(value.root);
            // Fixture event refs change under the same event lock, before the waiting producer owns it.
            const prefix = 'refs/nassaj/previews/v1/events/0000000000000032';
            execFileSync('git', ['update-ref', '--stdin'], { cwd: value.root,
                input: `start\nupdate ${prefix}/event ${value.oid}\nupdate ${prefix}/server ${value.oid}\nprepare\ncommit\n` });
        });
        const outcome = await task.done;
        assert.notEqual(outcome.code, 0); assert.match(outcome.stderr, /preview_superseded/);
        assert.equal(existsSync(value.request), false); assert.equal(existsSync(value.event), false);
    } finally { if (task?.child.exitCode === null) { task.child.kill(); await task.done; } }
});
test('historical unpublished server event does not block ordinary restart with control absence locked', async t => {
    const value = fixture(t);
    let ran = false;
    await tryOrdinarySafeRestart(value.root, {}, { run() {
        ran = true; assert.equal(existsSync(value.request), false);
        assert.notEqual(spawnSync('flock', ['-n', path.join(value.root, '.git/nassaj-preview-event-mutation.lock'), 'true']).status, 0);
        return { status: 0 };
    } });
    assert.equal(ran, true);
});
test('queue callback failure preserves intent; build is outside and queue inside event lock', async t => {
    const value = fixture(t); const lock = path.join(value.root, '.git/nassaj-preview-event-mutation.lock');
    await assert.rejects(() => consumeNewestPreview(value.root, {
        materialize: async () => value.root,
        buildServer: async () => {
            assert.equal(spawnSync('flock', ['-n', lock, 'true']).status, 0);
            return { buildId: value.scope.serverBuildId, controlManifestSha256: 'c'.repeat(64) };
        },
        requestServerControlPlane: async () => {
            assert.notEqual(spawnSync('flock', ['-n', lock, 'true']).status, 0);
            throw new Error('queue failed');
        },
    }, { domains: ['server'], bootstrapPacket: value.packetFile }), /queue failed/);
    assert.equal(JSON.parse(readFileSync(value.event)).bootstrapPublication.server, 'queue_intent');
});
test('confirmer rechecks exact request after lock wait and never removes successor', async t => {
    const value = fixture(t); let confirmation;
    writeFileSync(value.request, JSON.stringify({ sequence: 129, oid: value.oid, buildId: 'b'.repeat(64) }));
    const successor = JSON.stringify({ sequence: 130, oid: value.oid, buildId: 'd'.repeat(64) });
    await withPreviewEventMutationLock(value.root, async () => {
        confirmation = confirmServerLoaded(value.root, { status: 'ok', serverLoadedOid: value.oid, serverLoadedBuildId: 'b'.repeat(64) });
        writeFileSync(value.request, successor);
    });
    await assert.rejects(() => confirmation, /preview_owner_control_changed/);
    assert.equal(readFileSync(value.request, 'utf8'), successor);
});
test('successor introduced by queue callback refuses awaiting_owner commit', async t => {
    const value = fixture(t);
    await assert.rejects(() => consumeNewestPreview(value.root, {
        materialize: async () => value.root,
        buildServer: async () => ({ buildId: value.scope.serverBuildId, controlManifestSha256: 'c'.repeat(64) }),
        requestServerControlPlane: async () => { writeFileSync(value.request, '{"sequence":130}'); return { actionId: `synthetic-action-${value.sequence}` }; },
    }, { domains: ['server'], bootstrapPacket: value.packetFile }), /preview_owner_control_changed/);
    assert.equal(JSON.parse(readFileSync(value.event)).bootstrapPublication.server, 'queue_intent');
    assert.equal(readFileSync(value.request, 'utf8'), '{"sequence":130}');
});
