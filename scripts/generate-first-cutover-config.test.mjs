import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { canonical, expectedSha256, ownerApprovalKeySha256FromPublicKeyPem, sha } from './generate-first-cutover-config.mjs';
import { mintCutoverApproval } from './mint-cutover-approval.mjs';
import { planReleaseRuntimeCutover } from './lib/release-runtime-cutover.mjs';

const HEX64 = /^[a-f0-9]{64}$/;
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** A format-valid `expected` whose ownerApprovalKeySha256 is bound to a real ed25519 key. */
function makeExpected(publicKeyPem, overrides = {}) {
    return {
        nodeInstanceId: 'node-304dae85-01c8-4edd-b431-2753e404a257',
        generationId: '1.47.0.0-af46176e4a60',
        targetSchemaDigest: sha('targetSchemaDigest'),
        serverBuildId: sha('serverBuildId'),
        clientBuildId: sha('clientBuildId'),
        releaseIdentitySha256: sha('releaseIdentitySha256'),
        assetSha256: sha('assetSha256'),
        pm2SnapshotSha256: sha('pm2SnapshotSha256'),
        hostIdentitySha256: sha('hostIdentitySha256'),
        migrationIdentitySha256: sha('migrationIdentitySha256'),
        databaseContractSha256: sha('databaseContractSha256'),
        ownerApprovalKeySha256: ownerApprovalKeySha256FromPublicKeyPem(publicKeyPem),
        ...overrides,
    };
}

function factsFor(expected) {
    return {
        nodeInstanceId: expected.nodeInstanceId,
        hostIdentitySha256: expected.hostIdentitySha256, releaseIdentitySha256: expected.releaseIdentitySha256,
        migrationIdentitySha256: expected.migrationIdentitySha256, pm2SnapshotSha256: expected.pm2SnapshotSha256,
        databaseContractSha256: expected.databaseContractSha256, assetSha256: expected.assetSha256,
        oldPid: 4242, oldPgid: 4242, oldSid: 4242, killTimeout: 86_400_000, treeKill: false, oldHealth: 'ok',
    };
}

function stubOps(facts) {
    const names = ['inspect', 'blockIngress', 'fenceAdmission', 'verifyZeroWork', 'freezeOldWriters', 'verifyWritersFrozen',
        'finalVacuumAndBackup', 'switchSupervisorToLauncher', 'verifyPrivateTarget', 'openIngress', 'verifyPublicTarget',
        'restoreDatabaseFromBackup', 'restoreOldSupervisor', 'resumeOldWriters', 'verifyOldHealth', 'restoreIngress'];
    const ops = {};
    for (const name of names) ops[name] = async () => ({});
    ops.inspect = async () => facts;
    return ops;
}

test('canonical/expectedSha256 parity with mint and verifier; owner key digest parity', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const expected = makeExpected(publicKeyPem);

    const dir = mkdtempSync(path.join(SCRIPTS_DIR, '.first-cutover-test-'));
    try {
        const expectedFile = path.join(dir, 'expected.json');
        const keyFile = path.join(dir, 'owner.key');
        const outFile = path.join(dir, 'approval.json');
        writeFileSync(expectedFile, `${JSON.stringify(expected)}\n`, { mode: 0o600 });
        writeFileSync(keyFile, privateKeyPem, { mode: 0o600 });

        // Real reviewed mint accepts our expected (validateExpected parity) and signs with the bound key.
        const minted = mintCutoverApproval({ expectedFile, privateKeyFile: keyFile, out: outFile });
        assert.equal(minted.ownerApprovalKeySha256, expected.ownerApprovalKeySha256, 'owner key digest parity');
        // canonical() parity: mint's expectedSha256 must equal ours byte-for-byte.
        assert.equal(minted.expectedSha256, expectedSha256(expected), 'expectedSha256 canonical parity');
        assert.equal(minted.expectedSha256, sha(canonical(expected)));
        assert.match(minted.expectedSha256, HEX64);

        // A valid generated identity cannot bypass the unsupported recovery contract.
        await assert.rejects(planReleaseRuntimeCutover({ expected, operations: stubOps(factsFor(expected)) }),
            /cutover_recovery_contract_unsupported/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('derived fingerprint tampering fails mint validation and cannot bypass the cutover gate', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

    // Flip one hex nibble to a non-hex char -> malformed HEX64.
    const good = makeExpected(publicKeyPem);
    const tamperedFormat = { ...good, assetSha256: `g${good.assetSha256.slice(1)}` };

    const dir = mkdtempSync(path.join(SCRIPTS_DIR, '.first-cutover-test-'));
    try {
        const expectedFile = path.join(dir, 'expected.json');
        const keyFile = path.join(dir, 'owner.key');
        writeFileSync(expectedFile, `${JSON.stringify(tamperedFormat)}\n`, { mode: 0o600 });
        writeFileSync(keyFile, privateKeyPem, { mode: 0o600 });

        // Mint refuses the malformed identity.
        assert.throws(() => mintCutoverApproval({ expectedFile, privateKeyFile: keyFile, out: path.join(dir, 'a.json') }),
            /mint_expected_identity_invalid/);

        // Planning is unavailable even for malformed identity.
        await assert.rejects(planReleaseRuntimeCutover({ expected: tamperedFormat, operations: stubOps(factsFor(good)) }),
            /cutover_recovery_contract_unsupported/);

        // A valid-but-different byte changes the canonical digest (binding sensitivity), and the verifier
        // remains blocked independently of the supplied live facts.
        const tamperedValue = { ...good, assetSha256: sha('DIFFERENT-asset') };
        assert.notEqual(expectedSha256(tamperedValue), expectedSha256(good), 'canonical digest must change');
        await assert.rejects(planReleaseRuntimeCutover({ expected: tamperedValue, operations: stubOps(factsFor(good)) }),
            /cutover_recovery_contract_unsupported/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
