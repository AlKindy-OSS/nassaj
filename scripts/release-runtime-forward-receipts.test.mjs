import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fixture } from './fixtures/startup-admission-fixture.mjs';
import { recordForwardTargetHealth } from './lib/release-runtime-forward-receipts.mjs';

async function target(t, change) {
    const f = fixture(t, 'cutover');
    // B899 maps several host supplementary groups to the same overflow GID; fixture policy is a set.
    const identity = f.config.forwardMigration.serviceIdentity;
    identity.supplementaryGids = [...new Set(identity.supplementaryGids)];
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    Object.assign(f.caller, { pid: process.pid, startTicks: stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ')[19],
        bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() });
    Object.assign(f.config.bootstrapClaim, { applicationUid: process.getuid(), nodeExecutable: fs.realpathSync(process.execPath) });
    f.bindInitialCaller();
    f.call(f.consume(f.call(f.request()))); f.phase('security');
    const server = http.createServer((_req, response) => {
        const body = { status: 'ok', privateSecurityReady: true, normalAdmissionReady: false,
            startupPhase: 'security_startup_authorized',
            ...Object.fromEntries(['claimId', 'generationEpoch', 'pid', 'startTicks', 'bootId'].map(key => [key, f.read('startup-admission.json').lastClaim[key]])), ...Object.fromEntries(['releaseIdentitySha256', 'generationId', 'serverBuildId', 'clientBuildId'].map(key => [key, f.config.expected[key]])) };
        if (change?.(f, body) === 'hang') return;
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    f.config.health.privateUrl = `http://127.0.0.1:${server.address().port}/health`;
    return { ...f, dependencies: { effectiveUid: () => 0, readRootRecord: file => JSON.parse(fs.readFileSync(file, 'utf8')) } };
}
test('real HTTP and kernel listener ownership produce a private receipt without invalidating the claim', async t => {
    const f = await target(t); const before = f.read('startup-admission.json');
    const receipt = await recordForwardTargetHealth(f.config, 'private', f.dependencies);
    assert.equal(receipt.process.pid, process.pid); assert.equal(receipt.claimId, before.lastClaim.claimId);
    assert.equal(f.read('first-cutover.json').phase, 'target_verified');
    assert.deepEqual(f.read('startup-admission.json'), before);
});
test('a transition while health is in flight cannot overwrite the fresh journal', async t => {
    const f = await target(t, f => {
        const state = f.read('startup-admission.json'); f.write('startup-admission.json', { ...state, generationEpoch: state.generationEpoch + 1 });
    });
    await assert.rejects(recordForwardTargetHealth(f.config, 'private', f.dependencies), /claim_invalid|state_changed/);
    assert.equal(f.read('first-cutover.json').forwardReceipts.private, undefined);
});
test('wrong body identity and public-before-opening cannot create a receipt', async t => {
    const f = await target(t, (_f, body) => { body.serverBuildId = 'f'.repeat(64); });
    await assert.rejects(recordForwardTargetHealth(f.config, 'private', f.dependencies), /health_identity/);
    await assert.rejects(recordForwardTargetHealth(f.config, 'public', f.dependencies), /phase_invalid/);
    assert.equal(f.read('first-cutover.json').forwardReceipts.private, undefined);
});
test('legacy migration intent is rejected before observing a target', async t => {
    const f = await target(t); f.write('host-dispatch-state.json', { ...f.read('host-dispatch-state.json'), migrationIntent: {} });
    await assert.rejects(recordForwardTargetHealth(f.config, 'private', f.dependencies), /legacy_intent/);
    assert.ok(fs.existsSync(path.join(f.root, 'first-cutover.json')));
});

// Opening state is isolated fixture input; this test proves the actual public observer, not an nft cutover.
function opened(f) {
    f.config.health.publicUrl = f.config.health.privateUrl;
    f.write('first-cutover.json', { ...f.read('first-cutover.json'), phase: 'ingress_opened' });
    f.write('host-dispatch-state.json', { ...f.read('host-dispatch-state.json'), gateActive: false,
        publicBoundaryOpened: { nonce: f.config.maintenance.nonce, at: Date.now() } });
}
test('actual public HTTP success records the current process claim after the opening phase', async t => {
    const f = await target(t); await recordForwardTargetHealth(f.config, 'private', f.dependencies); opened(f);
    const receipt = await recordForwardTargetHealth(f.config, 'public', f.dependencies);
    assert.equal(receipt.claimId, f.read('startup-admission.json').lastClaim.claimId);
    assert.equal(f.read('first-cutover.json').phase, 'public_verified');
});
test('cached HTTP200 with the same build and an old claim, epoch or process never passes either observer', async t => {
    for (const visibility of ['private', 'public']) for (const key of ['claimId', 'generationEpoch', 'pid', 'startTicks', 'bootId']) {
        await t.test(`${visibility}:${key}`, async t => {
            const f = await target(t, (_f, body) => { body[key] = typeof body[key] === 'number' ? body[key] + 1 : `old-${body[key]}`; });
            if (visibility === 'public') opened(f);
            await assert.rejects(recordForwardTargetHealth(f.config, visibility, f.dependencies), /health_identity/);
            assert.equal(f.read('first-cutover.json').forwardReceipts[visibility], undefined);
        });
    }
});
test('an actual HTTP timeout does not leave a receipt or hold the state lock', async t => {
    const f = await target(t, () => 'hang');
    await assert.rejects(recordForwardTargetHealth(f.config, 'private', { ...f.dependencies, healthTimeoutMs: 25 }), /abort|timeout/i);
    assert.equal(f.read('first-cutover.json').forwardReceipts.private, undefined);
    assert.equal(fs.existsSync(path.join(f.root, 'first-cutover-state.lock')), false);
});

function listenerMode(f) {
    const port = Number(new URL(f.config.health.privateUrl).port);
    Object.assign(f.config.maintenance, {responderPort:3311, cloudflared:{originHost:'127.0.0.1',originPort:port},
        boundary:{mode:'local-origin-listener/v1',originHost:'127.0.0.1',originPort:port}});
}
test('B816 actual scoped listener and HTTP observation preserve claim and produce private/public receipts', async t => {
    const f = await target(t); listenerMode(f);
    const receipt = await recordForwardTargetHealth(f.config, 'private', f.dependencies);
    assert.equal(receipt.process.pid, process.pid); opened(f);
    assert.equal((await recordForwardTargetHealth(f.config, 'public', f.dependencies)).claimId, receipt.claimId);
});
test('B816 a sibling listener appearing during HTTP cannot create a private receipt', async t => {
    let sibling, ready;
    const f = await target(t, (_f, body) => {
        sibling = http.createServer((_req, response) => response.end());
        ready = new Promise(resolve => sibling.listen(Number(new URL(f.config.health.privateUrl).port), '127.0.0.2', resolve));
    });
    listenerMode(f); t.after(async () => { if (ready) await ready; if (sibling) await new Promise(resolve => sibling.close(resolve)); });
    await assert.rejects(recordForwardTargetHealth(f.config, 'private', f.dependencies), /listener_topology/);
    assert.equal(f.read('first-cutover.json').forwardReceipts.private, undefined);
});
test('B816 private observation refuses an unprivileged caller before HTTP', async t => {
    const f = await target(t); listenerMode(f);
    await assert.rejects(recordForwardTargetHealth(f.config, 'private', {...f.dependencies,effectiveUid:()=>1000}), /root_required/);
    assert.equal(f.read('first-cutover.json').forwardReceipts.private, undefined);
});
