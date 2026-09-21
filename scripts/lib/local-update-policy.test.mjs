import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeLocalUpdatePolicy } from './local-update-policy-write.mjs';
import { readLocalUpdatePolicy, createLocalUpdatePolicyGrant, inspectLocalUpdatePolicyGrant,
    verifyLocalUpdatePolicyCapability, DEV_FULL_CAPABILITY, LOCAL_UPDATE_POLICY_FILE } from './local-update-policy.mjs';

const capability = { protocol: DEV_FULL_CAPABILITY, serverLoadedBuildId: 'a'.repeat(64), retainedExecutorSha256: 'b'.repeat(64) };
const input = { mode: 'dev-full-auto', ownerId: 1, expectedRevision: 0, idempotencyKey: 'enable-policy-test-001', capability };
function fixture(t) {
    const root = fs.mkdtempSync(path.join(process.cwd(), '.artifacts', 'local-policy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q', root]); fs.chmodSync(path.join(root, '.git'), 0o700);
    return root;
}

test('policy defaults disabled and requires explicit capability, input and revision', async t => {
    const root = fixture(t);
    assert.equal(readLocalUpdatePolicy(root).mode, 'disabled');
    await assert.rejects(writeLocalUpdatePolicy(root, { ...input, capability: null }), /capability_required/);
    for (const change of [{ ownerId: 0 }, { expectedRevision: -1 }, { mode: 'main' }, { idempotencyKey: '../a' }]) {
        await assert.rejects(writeLocalUpdatePolicy(root, { ...input, ...change }), /invalid_request/);
    }
    const enabled = await writeLocalUpdatePolicy(root, input);
    assert.equal(enabled.revision, 1);
    assert.deepEqual(await writeLocalUpdatePolicy(root, input), enabled);
    await assert.rejects(writeLocalUpdatePolicy(root, { ...input, mode: 'disabled' }), /idempotency_conflict/);
    await assert.rejects(writeLocalUpdatePolicy(root, { ...input, idempotencyKey: 'different-enable-key' }), /revision_conflict/);
    assert.equal(fs.statSync(path.join(root, '.git', LOCAL_UPDATE_POLICY_FILE)).mode & 0o777, 0o600);
});

test('parallel CAS permits exactly one policy mutation and orphan receipt grants nothing', async t => {
    const root = fixture(t);
    const results = await Promise.allSettled([writeLocalUpdatePolicy(root, input),
        writeLocalUpdatePolicy(root, { ...input, idempotencyKey: 'second-parallel-key' })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    fs.unlinkSync(path.join(root, '.git', LOCAL_UPDATE_POLICY_FILE));
    assert.equal(readLocalUpdatePolicy(root).mode, 'disabled');
    assert.equal((await writeLocalUpdatePolicy(root, input)).revision, 1);
});

test('policy receipt, installation and unsafe file cannot silently authorize', async t => {
    const root = fixture(t), enabled = await writeLocalUpdatePolicy(root, input);
    const file = path.join(root, '.git', LOCAL_UPDATE_POLICY_FILE);
    const receipt = path.join(root, '.git', `nassaj-local-update-policy-receipt-${enabled.receiptKey}.json`);
    fs.writeFileSync(receipt, '{}');
    assert.throws(() => readLocalUpdatePolicy(root), /receipt_invalid/);
    fs.writeFileSync(file, JSON.stringify({ ...enabled, serviceUid: process.getuid() + 1 }));
    assert.throws(() => readLocalUpdatePolicy(root), /installation_mismatch/);
    fs.unlinkSync(file); fs.symlinkSync(receipt, file);
    assert.throws(() => readLocalUpdatePolicy(root));
});

test('target grants are separate from consent, bounded, tamper evident and revoked immediately', async t => {
    const root = fixture(t), policy = await writeLocalUpdatePolicy(root, input);
    const state = { sequence: 1, targetDigest: 'c'.repeat(64), consent: null,
        prepare: { ownerId: '1', origin: { kind: 'policy', policyRevision: 1, receiptDigest: policy.receiptDigest } } };
    state.policyAuthorization = createLocalUpdatePolicyGrant(root, state, capability, 1000);
    const inspect = value => inspectLocalUpdatePolicyGrant(root, value, 1001);
    assert.equal(inspect(state).kind, 'policy');
    for (const value of [{ ...state, consent: {} }, { ...state, targetDigest: 'd'.repeat(64) },
        { ...state, sequence: 2 }, { ...state, policyAuthorization: { ...state.policyAuthorization, ownerId: '2' } }]) {
        assert.throws(() => inspect(value), /grant_invalid/);
    }
    assert.throws(() => inspectLocalUpdatePolicyGrant(root, state, 86_401_000), /grant_invalid/);
    await writeLocalUpdatePolicy(root, { mode: 'disabled', ownerId: 1, expectedRevision: 1, idempotencyKey: 'revoke-policy-test-001' });
    assert.throws(() => inspect(state), /disabled/);
});

test('capability requires loaded identity and exact installed executor, not a source flag', t => {
    const root = fixture(t), dir = path.join(root, 'dist-server'); fs.mkdirSync(dir);
    const capsule = path.join(dir, 'OID_CONTROL_CAPSULE.mjs'); fs.writeFileSync(capsule, '// retained executor');
    const sha = createHash('sha256').update(fs.readFileSync(capsule)).digest('hex');
    fs.writeFileSync(path.join(dir, 'OID_CONTROL_MANIFEST.json'), JSON.stringify({ serverBuildId: capability.serverLoadedBuildId,
        capsuleSha256: sha, capabilities: { oidDevFullPolicyV1: DEV_FULL_CAPABILITY } }));
    const health = { status: 'ok', updateMode: 'local-main', degraded: false, normalAdmissionReady: true,
        serverBuildIdLoadedAtStartup: capability.serverLoadedBuildId,
        localUpdatePolicyCapability: { ...capability, retainedExecutorSha256: sha } };
    assert.equal(verifyLocalUpdatePolicyCapability(root, health).retainedExecutorSha256, sha);
    for (const change of [{ normalAdmissionReady: false }, { updateMode: 'release' }, { degraded: true },
        { serverBuildIdLoadedAtStartup: 'e'.repeat(64) }, { localUpdatePolicyCapability: null }]) {
        assert.throws(() => verifyLocalUpdatePolicyCapability(root, { ...health, ...change }));
    }
    fs.appendFileSync(capsule, 'tampered');
    assert.throws(() => verifyLocalUpdatePolicyCapability(root, health), /capability_required/);
});
