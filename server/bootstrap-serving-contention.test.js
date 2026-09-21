import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

import ts from 'typescript';

const source = fs.readFileSync(new URL('./bootstrap-startup-context.js', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('context.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const select = names => parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name.text))
    .map(node => node.getText(parsed).replace(/^export /, '')).join('\n');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',')}}` : JSON.stringify(value);

// Evaluate the actual phase/polling functions with an already-verified context and transport/clock seams.
// This tests neither initial admission nor root authentication; real IPC composition covers those separately.
function fixture(transport) {
    let clock = 0n; const calls = []; const delays = [];
    const caller = { uid: 1000, pid: 42, startTicks: '100', bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
    const claim = { mode: 'steady', claimId: '11111111-1111-1111-1111-111111111111', authorityId: 'operation',
        generationEpoch: 3, releaseIdentitySha256: 'a'.repeat(64), startupClosureSha256: 'b'.repeat(64), databaseContractSha256: 'c'.repeat(64) };
    const descriptor = { descriptorSha256: 'descriptor', nodeInstanceId: 'node', release: { generationId: 'generation' },
        databaseContractSha256: claim.databaseContractSha256, databaseDev: '1', databaseIno: '2' };
    const initial = Object.freeze({ phase: 'security_startup_authorized', revision: 8 });
    const scope = { claimedState: { caller, claim, descriptor }, verifiedContext: initial, canonical, randomBytes,
        HEX: /^[a-f0-9]{64}$/, targetManifest: () => ({}), processBinding: () => caller,
        sha: () => 'descriptor', readRootFile: () => Buffer.from('descriptor'), PUBLIC_DESCRIPTOR: '/fixture',
        process: { hrtime: { bigint: () => clock } }, Date: { now: () => { throw Error('wall clock used'); } },
        delay: async ms => { delays.push(ms); clock += BigInt(ms) * 1_000_000n; },
        exchange: async (d, request, deadline) => {
            calls.push({ request, deadline }); assert.equal(scope.verifiedContext, initial);
            return transport({ request, deadline, advance: ms => { clock += BigInt(ms) * 1_000_000n; }, calls, caller, claim, descriptor });
        } };
    vm.runInNewContext(select(['exchangeStartupPhase', 'confirmStartupServing', 'checkResponse']), scope);
    return { scope, calls, delays, initial, now: () => clock };
}
const busy = request => ({ ...request, schema: 'nassaj-startup-serving-busy/v1', decision: 'busy', reason: 'state_lock_contended', retryAfterMs: 100 });
function serving({ request, caller, claim, descriptor }) {
    return { ...request, schema: 'nassaj-startup-serving-confirmation-response/v1', decision: 'serving', uid: caller.uid,
        mode: claim.mode, authorityId: claim.authorityId, revision: 9, nodeInstanceId: descriptor.nodeInstanceId,
        generationId: descriptor.release.generationId, databaseDev: descriptor.databaseDev, databaseIno: descriptor.databaseIno,
        startupPolicyId: 'existing-security-state/v1', startupAdmissionPolicy: 'same-generation-auto-restart/v1' };
}
test('busy preserves verified context, uses fresh challenges and capped exponential backoff until serving', async () => {
    const f = fixture(input => input.calls.length <= 6 ? busy(input.request) : serving(input));
    const result = await f.scope.confirmStartupServing();
    assert.equal(result.phase, 'serving'); assert.equal(result.revision, 9);
    assert.deepEqual(f.delays, [100, 200, 400, 800, 1000, 1000]);
    assert.equal(new Set(f.calls.map(item => item.request.challenge)).size, 7);
    assert.ok(f.calls.every(item => item.deadline === 90_000_000_000n));
});
test('one monotonic budget includes every RPC and backoff and never advances phase at expiration', async () => {
    const f = fixture(({ request, advance, deadline }) => {
        const remaining = Number((deadline - f.now()) / 1_000_000n);
        advance(Math.min(10_000, remaining)); return busy(request);
    });
    await assert.rejects(f.scope.confirmStartupServing(), /serving_timeout/);
    assert.equal(f.now(), 90_000_000_000n); assert.equal(f.scope.verifiedContext, f.initial);
    assert.ok(f.calls.every(item => item.deadline === 90_000_000_000n));
});
for (const key of ['challenge', 'pid', 'startTicks', 'bootId', 'claimId', 'generationEpoch', 'releaseIdentitySha256',
    'startupClosureSha256', 'databaseContractSha256', 'decision', 'reason', 'retryAfterMs', 'schema', 'revision']) {
    test(`busy echo rejects changed or extra ${key} without another poll`, async () => {
        const f = fixture(({ request }) => ({ ...busy(request), [key]: 'tampered' }));
        await assert.rejects(f.scope.confirmStartupServing(), /binding_mismatch/);
        assert.equal(f.calls.length, 1); assert.equal(f.scope.verifiedContext, f.initial); assert.deepEqual(f.delays, []);
    });
}
test('unknown RPC outcome is terminal even after an earlier valid busy response', async () => {
    const f = fixture(({ request, calls }) => { if (calls.length === 1) return busy(request); throw Error('root_startup_claim_timeout'); });
    await assert.rejects(f.scope.confirmStartupServing(), /claim_timeout/);
    assert.equal(f.calls.length, 2); assert.equal(f.scope.verifiedContext, f.initial);
});
test('serving reply arriving after the fixed deadline cannot grant serving', async () => {
    const f = fixture(input => { input.advance(90_001); return serving(input); });
    await assert.rejects(f.scope.confirmStartupServing(), /serving_timeout/);
    assert.equal(f.scope.verifiedContext, f.initial);
});
test('busy echo missing a binding and busy received during security are terminal', async () => {
    const missing = fixture(({ request }) => { const value = busy(request); delete value.challenge; return value; });
    await assert.rejects(missing.scope.confirmStartupServing(), /binding_mismatch/);
    assert.equal(missing.calls.length, 1);
    const security = fixture(({ request }) => busy(request));
    await assert.rejects(security.scope.exchangeStartupPhase('security'), /binding_mismatch/);
    assert.equal(security.scope.verifiedContext, security.initial);
});
test('the final busy backoff is capped to the original remaining budget', async () => {
    const f = fixture(({ request, advance }) => { advance(89_950); return busy(request); });
    await assert.rejects(f.scope.confirmStartupServing(), /serving_timeout/);
    assert.deepEqual(f.delays, [50]); assert.equal(f.now(), 90_000_000_000n); assert.equal(f.calls.length, 1);
});
test('actual exchange limits each RPC timer to min(10 seconds, remaining) and kills unknown timed-out RPC once', async () => {
    for (const remaining of [15_000, 9_999, 1]) {
        let timeout; let onTimeout; let spawns = 0; let kills = 0;
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.stdin = new EventEmitter(); child.kill = signal => { assert.equal(signal, 'SIGKILL'); kills++; };
        child.stdin.end = () => queueMicrotask(() => onTimeout());
        const scope = { process: { hrtime: { bigint: () => 0n } },
            spawn: () => { spawns++; return child; },
            setTimeout: (fn, ms) => { onTimeout = fn; timeout = ms; return 1; }, clearTimeout: () => {} };
        vm.runInNewContext(select(['exchange']), scope);
        await assert.rejects(scope.exchange({ sudo: { path: '/fixture/sudo' }, dispatcher: { path: '/fixture/dispatcher' } },
            {}, BigInt(remaining) * 1_000_000n, 'root_startup_serving_timeout'), /claim_timeout/);
        assert.equal(timeout, Math.min(10_000, remaining)); assert.equal(spawns, 1); assert.equal(kills, 1);
    }
});
