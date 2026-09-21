import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectOidPairAuthority } from './oid-control-capsule.mjs';
import { writeLocalUpdatePolicy } from './lib/local-update-policy-write.mjs';
import { createLocalUpdatePolicyGrant, DEV_FULL_CAPABILITY } from './lib/local-update-policy.mjs';

test('sealed capsule accepts explicit policy authority and rejects revoke, expiry and mixed consent', async t => {
    const root = fs.mkdtempSync(path.join(process.cwd(), '.artifacts', 'oid-policy-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    fs.chmodSync(path.join(root, '.git'), 0o700);
    const capability = { protocol: DEV_FULL_CAPABILITY, serverLoadedBuildId: 'a'.repeat(64), retainedExecutorSha256: 'b'.repeat(64) };
    const policy = await writeLocalUpdatePolicy(root, { mode: 'dev-full-auto', ownerId: 1,
        expectedRevision: 0, idempotencyKey: 'policy-fixture-key-001', capability });
    const state = { sequence: 1, targetDigest: 'c'.repeat(64), prepare: { ownerId: '1', origin: {
        kind: 'policy', policyRevision: policy.revision, receiptDigest: policy.receiptDigest } } };
    const now = Date.now();
    state.policyAuthorization = createLocalUpdatePolicyGrant(root, state, capability, now);
    assert.equal(inspectOidPairAuthority(root, state, 1, now).kind, 'policy');
    assert.throws(() => inspectOidPairAuthority(root, { ...state, consent: {} }, 1, now), /ambiguous/);
    assert.throws(() => inspectOidPairAuthority(root, state, 2, now), /consent_invalid/);
    assert.throws(() => inspectOidPairAuthority(root, state, 1, now + 86_400_000), /grant_invalid/);
    await writeLocalUpdatePolicy(root, { mode: 'disabled', ownerId: 1, expectedRevision: 1, idempotencyKey: 'policy-fixture-revoke-001' });
    assert.throws(() => inspectOidPairAuthority(root, state, 1, now), /disabled/);
});
test('manual consent remains explicit and missing authority fails closed', () => {
    const state = { targetDigest: 'a'.repeat(64), consent: { targetDigest: 'a'.repeat(64), ownerId: '1', expiresAt: 100 } };
    assert.equal(inspectOidPairAuthority('/unused', state, 1, 99).kind, 'manual');
    assert.throws(() => inspectOidPairAuthority('/unused', state, 1, 100), /consent_invalid/);
    assert.throws(() => inspectOidPairAuthority('/unused', { targetDigest: state.targetDigest }, 1, 0), /consent_invalid/);
});
