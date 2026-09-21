import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash, sign } from 'node:crypto';
import test from 'node:test';
import { fixture } from './fixtures/startup-admission-fixture.mjs';
import { beginManagedRestartAdmission } from './lib/release-runtime-startup-admission.mjs';
import { dispatchReleaseRuntimeHostOperation } from './lib/release-runtime-host-operations.mjs';
import { canonicalForwardValue } from './lib/release-runtime-forward-child-protocol.mjs';
const digest = value => createHash('sha256').update(canonicalForwardValue(value)).digest('hex');
function prepared(t) {
    const f = fixture(t, 'steady'); const operationId = 'managed-gate-operation-123'; const originalGrant = f.read('startup-admission.json');
    f.config.managedRestart = { approvalFile: path.join(f.root, 'managed-restart-approval.json'),
        parent: { path: '/pinned/parent.mjs', sha256: 'a'.repeat(64) }, nodeExecutable: '/pinned/node', nodeSha256: 'b'.repeat(64) };
    f.config.maintenance = { nonce: 'nassaj-maintenance-v1', retryAfterSeconds: 30, responderPort: 3311, responderUnit: 'fixture-maintenance.service',
        cloudflared: { uid: process.getuid(), originPort: 3300 }, nft: { binary: '/pinned/nft', sha256: 'c'.repeat(64) },
        conntrack: { binary: '/pinned/conntrack', sha256: 'd'.repeat(64) } };
    const now = Date.now();
    const target = { schema: 'nassaj-managed-restart-approval-target/v1', operationId,
        nodeInstanceId: f.config.expected.nodeInstanceId, generationId: f.config.expected.generationId,
        releaseIdentitySha256: f.config.expected.releaseIdentitySha256, databaseContractSha256: f.config.expected.databaseContractSha256,
        startupClosureSha256: f.identity.startupClosureSha256, commitReceiptSha256: originalGrant.commitReceiptSha256,
        ownerApprovalKeySha256: f.config.expected.ownerApprovalKeySha256, expectedSha256: digest(f.config.expected),
        managedConfigurationSha256: digest(f.config.managedRestart) };
    const payload = { schema: 'nassaj-owner-managed-restart-approval/v1', action: 'restartCommittedGeneration',
        scope: 'same-generation-managed-restart/v1', target, ownerId: 'fixture-owner', nonce: 'e'.repeat(48), issuedAt: now - 1000, expiresAt: now + 20000 };
    const approval = { ...payload, signature: sign(null, Buffer.from(canonicalForwardValue(payload)), f.keys.privateKey).toString('base64url') };
    const operator = { pid: process.ppid, startTicks: '12345', bootId: 'fixture-boot' };
    f.write('managed-restart-approval.json', approval);
    f.write('managed-restart.json', { schema: 'nassaj-managed-restart/v1', operationId, phase: 'prepared', revision: 1,
        originalGrant, originalGrantSha256: digest(originalGrant), approvalAcceptedAt: now, approvalNonce: approval.nonce,
        approvalSha256: digest(approval), approval, operator });
    f.write('first-cutover.lock', { schema: 'nassaj-cutover-lock/v1', pid: operator.pid, startTime: operator.startTicks });
    beginManagedRestartAdmission(f.config, operationId, { readRootFile: file => fs.readFileSync(file),
        ownerUid: process.getuid(), effectiveUid: () => process.getuid() });
    const request = { schema: 'nassaj-current-operation-gate-request/v1', operationId, generationEpoch: f.read('startup-admission.json').generationEpoch };
    const effects = [];
    const deps = { gateOwnerUid: process.getuid(), effectiveUid: () => process.getuid(), gateReadRootFile: file => fs.readFileSync(file),
        gateProcess: () => ({ ...operator, uids: [process.getuid(), process.getuid(), process.getuid(), process.getuid()] }),
        gateExecutable: () => '/pinned/node', gateArgv: () => ['/pinned/node', '/pinned/parent.mjs'],
        verifyPinnedExecutable: () => {}, exec: (_file, args) => { effects.push(args.join(' ')); return ''; },
        fetch: async () => new Response('{}', { status: 503, headers: { 'retry-after': '30', 'x-nassaj-maintenance-nonce': 'nassaj-maintenance-v1' } }),
        installMaintenanceGate: () => { assert.equal(f.read('host-dispatch-state.json').managedIngress.phase, 'close_intent'); effects.push('install'); } };
    return { ...f, request, deps, effects };
}
test('signed managed gate close persists intent before simulated host effects and preserves the original cutover anchor', async t => {
    const f = prepared(t); const original = f.read('first-cutover.json'); const host = f.read('host-dispatch-state.json');
    const result = await dispatchReleaseRuntimeHostOperation(f.config, 'closeCurrentOperationGate', f.request, f.deps);
    assert.equal(result.phase, 'closed'); assert.equal(result.generationEpoch, f.request.generationEpoch);
    assert.deepEqual(f.read('first-cutover.json'), original);
    assert.deepEqual(f.read('host-dispatch-state.json').gateInstallIntent, host.gateInstallIntent);
    assert.deepEqual(f.read('host-dispatch-state.json').publicBoundaryOpened, host.publicBoundaryOpened);
    assert.equal(f.read('host-dispatch-state.json').gateActive, true); assert.equal(f.effects.filter(value => value === 'install').length, 1);
    await assert.rejects(dispatchReleaseRuntimeHostOperation(f.config, 'closeCurrentOperationGate', f.request, f.deps), /close_phase/);
});
test('wrong operation epoch, signature or parent denies before any host effect', async t => {
    for (const variant of ['epoch', 'signature', 'parent']) await t.test(variant, async t => {
        const f = prepared(t);
        if (variant === 'epoch') f.request.generationEpoch++;
        if (variant === 'signature') { const approval = f.read('managed-restart-approval.json'); approval.nonce = 'f'.repeat(48); f.write('managed-restart-approval.json', approval); }
        if (variant === 'parent') f.deps.gateArgv = () => ['/pinned/node', '/untrusted/parent'];
        await assert.rejects(dispatchReleaseRuntimeHostOperation(f.config, 'closeCurrentOperationGate', f.request, f.deps));
        assert.deepEqual(f.effects, []);
    });
});
test('changed state during responder check blocks routing effect and never overwrites the changed state', async t => {
    const f = prepared(t); f.deps.fetch = async () => {
        const state = f.read('startup-admission.json'); f.write('startup-admission.json', { ...state, revision: state.revision + 1 });
        return new Response('{}', { status: 503, headers: { 'retry-after': '30', 'x-nassaj-maintenance-nonce': 'nassaj-maintenance-v1' } }); };
    await assert.rejects(dispatchReleaseRuntimeHostOperation(f.config, 'closeCurrentOperationGate', f.request, f.deps), /cas_failed/);
    assert.equal(f.effects.includes('install'), false); assert.equal(f.read('host-dispatch-state.json').managedIngress.phase, 'close_intent');
});

async function opening(t, mutate) {
    const f = prepared(t); await dispatchReleaseRuntimeHostOperation(f.config, 'closeCurrentOperationGate', f.request, f.deps);
    const stat = fs.readFileSync('/proc/self/stat', 'utf8'); const state = f.read('startup-admission.json');
    // Startup receipts are fixture setup here; actual claim lifecycle has its separate core integration tests.
    const claim = { ...state.lastClaim, mode: 'steady', claimId: '12345678-1234-1234-1234-123456789abc',
        generationEpoch: state.generationEpoch, uid: process.getuid(), pid: process.pid,
        startTicks: stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ')[19], bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
    const security = { ...state.securityStartup, claimId: claim.claimId, generationEpoch: claim.generationEpoch };
    const receipt = { schema: 'nassaj-managed-health-receipt/v1', visibility: 'private', operationId: f.request.operationId,
        claimId: claim.claimId, generationEpoch: claim.generationEpoch, securityStartupSha256: digest(security), observedAt: Date.now(),
        process: Object.fromEntries(['uid', 'pid', 'startTicks', 'bootId'].map(key => [key, claim[key]])),
        ...Object.fromEntries(['releaseIdentitySha256', 'databaseContractSha256', 'serverBuildId', 'clientBuildId'].map(key => [key, f.config.expected[key]])) };
    f.write('startup-admission.json', { ...state, lastClaim: claim, securityStartup: security });
    f.write('managed-restart.json', { ...f.read('managed-restart.json'), phase: 'private_verified',
        replacementClaim: claim, securityStartup: security, privateReceipt: receipt });
    f.config.bootstrapClaim.applicationUid = process.getuid(); f.config.bootstrapClaim.nodeExecutable = fs.realpathSync(process.execPath);
    const server = http.createServer((_request, response) => {
        const body = { status: 'ok', privateSecurityReady: true, normalAdmissionReady: false, startupPhase: 'security_startup_authorized',
            ...Object.fromEntries(['claimId', 'generationEpoch', 'pid', 'startTicks', 'bootId'].map(key => [key, claim[key]])),
            ...Object.fromEntries(['releaseIdentitySha256', 'generationId', 'serverBuildId', 'clientBuildId'].map(key => [key, f.config.expected[key]])) };
        mutate?.(f, body); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    f.config.health.privateUrl = `http://127.0.0.1:${server.address().port}/health`;
    f.deps.gateHealth = { effectiveUid: () => 0 };
    f.deps.removeMaintenanceGate = () => { assert.equal(f.read('host-dispatch-state.json').managedIngress.phase, 'open_intent'); f.effects.push('remove'); };
    return f;
}
test('opening requires actual current-claim HTTP health before its durable intent and simulated routing removal', async t => {
    const f = await opening(t); const anchor = f.read('first-cutover.json');
    const receipt = await dispatchReleaseRuntimeHostOperation(f.config, 'openCurrentOperationGate', f.request, f.deps);
    assert.equal(receipt.phase, 'opened'); assert.equal(receipt.claimId, f.read('startup-admission.json').lastClaim.claimId);
    assert.deepEqual(f.read('first-cutover.json'), anchor); assert.equal(f.effects.filter(value => value === 'remove').length, 1);
});
test('stale same-build health and a concurrent epoch change both prevent routing removal', async t => {
    for (const variant of ['old-claim', 'epoch']) await t.test(variant, async t => {
        const f = await opening(t, (f, body) => { if (variant === 'old-claim') body.claimId = 'old';
            else { const state = f.read('startup-admission.json'); f.write('startup-admission.json', { ...state, generationEpoch: state.generationEpoch + 1 }); } });
        await assert.rejects(dispatchReleaseRuntimeHostOperation(f.config, 'openCurrentOperationGate', f.request, f.deps));
        assert.equal(f.effects.includes('remove'), false); assert.equal(f.read('host-dispatch-state.json').managedIngress.phase, 'closed');
    });
});

function invalidateInChild(f) {
    const module = new URL('./lib/release-runtime-cutover.mjs', import.meta.url).href;
    const authorityUrl = new URL('./fixtures/fixed-state-mutex-authority.mjs', import.meta.url).href;
    // The revoker is a real second process, so it installs the same measured authority for itself;
    // contention is now the kernel mutex refusing the lock, not an exclusive-create collision.
    const code = `import fs from 'node:fs'; import {mock as mutexMock} from 'node:test';
        import {installFixedStateMutexAuthority, isCutoverStateAcquisitionBusy} from ${JSON.stringify(authorityUrl)};
        import {invalidateCutoverStartupAdmission} from ${JSON.stringify(module)};
        installFixedStateMutexAuthority({mock: mutexMock}, process.argv[1],
            JSON.parse(fs.readFileSync(${JSON.stringify(f.authority.file)}, 'utf8')), {file: ${JSON.stringify(f.authority.file)}});
        try { invalidateCutoverStartupAdmission(process.argv[1], 'fixture-revoke'); process.stdout.write('revoked'); }
        catch(error) { if(isCutoverStateAcquisitionBusy(error))process.stdout.write('locked'); else throw error; }`;
    return execFileSync(process.execPath, ['--input-type=module', '-e', code, f.root], { encoding: 'utf8', timeout: 3000,
        cwd: f.root, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
}
test('independent revoker cannot pass the state lock between final CAS and routing removal', async t => {
    const f = await opening(t); const epoch = f.read('startup-admission.json').generationEpoch;
    f.deps.removeMaintenanceGate = () => {
        assert.equal(invalidateInChild(f), 'locked');
        assert.equal(f.read('startup-admission.json').generationEpoch, epoch); f.effects.push('remove');
    };
    await dispatchReleaseRuntimeHostOperation(f.config, 'openCurrentOperationGate', f.request, f.deps);
    assert.equal(invalidateInChild(f), 'revoked');
    assert.equal(f.read('startup-admission.json').generationEpoch, epoch + 1);
    await assert.rejects(dispatchReleaseRuntimeHostOperation(f.config, 'openCurrentOperationGate', f.request, f.deps));
    assert.equal(f.effects.filter(value => value === 'remove').length, 1);
});
test('independent revocation completed during network wait prevents the later routing effect', async t => {
    const f = await opening(t, f => assert.equal(invalidateInChild(f), 'revoked'));
    await assert.rejects(dispatchReleaseRuntimeHostOperation(f.config, 'openCurrentOperationGate', f.request, f.deps), /authority_changed/);
    assert.equal(f.effects.includes('remove'), false);
});
