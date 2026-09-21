import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { installFixedStateMutexAuthority } from './fixtures/fixed-state-mutex-authority.mjs';
import { executeReleaseRuntimeCutover } from './lib/release-runtime-cutover.mjs';

const TEMP = process.env.NASSAJ_TEST_TMP || process.env.TMPDIR || '/var/tmp';
const H = (character) => character.repeat(64);
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

function fixture(t) {
    const root = mkdtempSync(path.join(TEMP, 'release-cutover-adversarial-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const controlRoot = path.join(root, 'control');
    mkdirSync(controlRoot, { mode: 0o700 });
    const expected = {
        nodeInstanceId: 'qa-node', targetSchemaDigest: H('a'), hostIdentitySha256: H('b'),
        releaseIdentitySha256: H('c'), migrationIdentitySha256: H('d'), pm2SnapshotSha256: H('e'),
        databaseContractSha256: H('f'), assetSha256: H('1'), serverBuildId: H('2'), clientBuildId: H('3'),
        generationId: 'v1.46.0.2-qa',
    };
    const keys = generateKeyPairSync('ed25519');
    const ownerApprovalPublicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
    expected.ownerApprovalKeySha256 = createHash('sha256')
        .update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    const now = 1_800_000_000_000;
    const approvalFile = path.join(controlRoot, 'owner-approval.json');
    const approvalPayload = {
        schema: 'nassaj-owner-cutover-approval/v1', action: 'release-runtime-first-cutover',
        requestId: 'request-qa-0001', ownerId: 'owner-qa-0001', nonce: 'nonce-qa-0000001',
        nodeInstanceId: expected.nodeInstanceId, issuedAt: now - 1_000, expiresAt: now + 60_000,
        hostIdentitySha256: expected.hostIdentitySha256,
        releaseIdentitySha256: expected.releaseIdentitySha256,
        migrationIdentitySha256: expected.migrationIdentitySha256,
        pm2SnapshotSha256: expected.pm2SnapshotSha256,
        databaseContractSha256: expected.databaseContractSha256,
        assetSha256: expected.assetSha256,
        expectedSha256: createHash('sha256').update(canonical(expected)).digest('hex'),
    };
    const signature = sign(null, Buffer.from(canonical(approvalPayload)), keys.privateKey).toString('base64url');
    writeFileSync(approvalFile, `${JSON.stringify({ ...approvalPayload, signature })}\n`, { mode: 0o600 });
    // Journal mutation runs under the fixed root state mutex; keep its config outside the control root.
    installFixedStateMutexAuthority(t, controlRoot, {}, { file: path.join(root, 'mutex-host.json') });
    return { root, controlRoot, approvalFile, expected, now, ownerApprovalPublicKeyPem };
}

function operationFixture(expected, overrides = {}) {
    const calls = [];
    const facts = {
        ...expected,
        oldPid: 41, oldPgid: 41, oldSid: 41, killTimeout: 86_400_000, treeKill: false, oldHealth: 'ok',
    };
    const record = (name, value = {}) => async () => { calls.push(name); return value; };
    const operations = {
        inspect: record('inspect', facts),
        blockIngress: record('blockIngress', { blocked: true }),
        fenceAdmission: record('fenceAdmission', { fenced: true }),
        verifyZeroWork: record('verifyZeroWork', { liveSessions: 0, workflows: 0, admittedTurns: 0 }),
        freezeOldWriters: record('freezeOldWriters'),
        verifyWritersFrozen: record('verifyWritersFrozen', {
            processGroupState: 'T', databaseWriters: 0, unknownDescendants: 0,
            liveSessions: 0, workflows: 0, admittedTurns: 0,
        }),
        finalVacuumAndBackup: record('finalVacuumAndBackup', {
            integrityCheck: 'ok', foreignKeyViolations: 0, targetSchemaDigest: expected.targetSchemaDigest,
            backupSha256: H('4'), fsyncComplete: true, preMigrationBackupSha256: H('5'),
            semanticPreservation: { schema: 'nassaj-database-semantic-preservation/v1', passed: true,
                beforeReceiptSha256: H('6'), afterReceiptSha256: H('7') },
        }),
        switchSupervisorToLauncher: record('switchSupervisorToLauncher'),
        verifyPrivateTarget: record('verifyPrivateTarget', {
            health: 'ok', releaseIdentitySha256: expected.releaseIdentitySha256, updateReady: true,
            updateStrategy: 'artifact-runtime-v2', visibility: 'private', serverBuildId: expected.serverBuildId,
            clientBuildId: expected.clientBuildId, generationId: expected.generationId,
        }),
        openIngress: record('openIngress'),
        verifyPublicTarget: record('verifyPublicTarget', {
            health: 'ok', releaseIdentitySha256: expected.releaseIdentitySha256, updateReady: true,
            updateStrategy: 'artifact-runtime-v2', visibility: 'public', serverBuildId: expected.serverBuildId,
            clientBuildId: expected.clientBuildId, generationId: expected.generationId, oldConversationResumed: true,
        }),
        restoreDatabaseFromBackup: record('restoreDatabaseFromBackup'),
        restoreOldSupervisor: record('restoreOldSupervisor'),
        resumeOldWriters: record('resumeOldWriters'),
        verifyOldHealth: record('verifyOldHealth', { health: 'ok', pm2SnapshotSha256: expected.pm2SnapshotSha256 }),
        restoreIngress: record('restoreIngress'),
        ...overrides,
    };
    return { calls, operations, facts };
}

test('every persisted crash boundary contains uncertainty without any host operation', async (t) => {
    const phases = ['accepted', 'ingress_blocked', 'admission_fenced', 'zero_work_verified', 'writers_frozen',
        'final_backup_verified', 'service_switched', 'target_verified', 'ingress_opening', 'ingress_opened',
        'public_verified', 'committed'];
    for (const phase of phases) {
        const value = fixture(t); const op = operationFixture(value.expected);
        // A host effect may have completed before this old checkpoint was written.
        // Never infer that the next effect did not happen from the persisted phase.
        const evidence = { observedMutation: { completed: true, checkpointWriteFailed: true } };
        const journal = { schema: 'nassaj-release-runtime-cutover/v1', expected: value.expected, state: 'running',
            phase, sequence: phases.indexOf(phase), transactionId: 'interrupted-cutover', evidence };
        const file = path.join(value.controlRoot, 'first-cutover.json');
        writeFileSync(file, JSON.stringify(journal), { mode: 0o600 });
        const approval = readFileSync(value.approvalFile);
        const result = await executeReleaseRuntimeCutover({ ...value, operations: op.operations });
        assert.equal(result.state, 'manual_recovery', phase);
        assert.equal(result.rollbackBlocked, phases.indexOf(phase) >= phases.indexOf('ingress_opening')
            ? 'post_public_writes_possible' : 'cutover_recovery_contract_unsupported', phase);
        assert.equal(result.reason, 'cutover_recovery_contract_unsupported');
        assert.deepEqual(result.evidence, evidence);
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), result);
        assert.deepEqual(readFileSync(value.approvalFile), approval);
        assert.deepEqual(op.calls, [], phase);
        assert.deepEqual(await executeReleaseRuntimeCutover({ ...value, operations: op.operations }), result);
    }
});

test('public opening intent overrides an earlier persisted phase', async (t) => {
    const value = fixture(t); const op = operationFixture(value.expected);
    const file = path.join(value.controlRoot, 'first-cutover.json');
    writeFileSync(file, JSON.stringify({ schema: 'nassaj-release-runtime-cutover/v1', expected: value.expected,
        state: 'running', phase: 'accepted', sequence: 0, publicOpeningIntent: true }), { mode: 0o600 });
    const result = await executeReleaseRuntimeCutover({ ...value, operations: op.operations });
    assert.equal(result.rollbackBlocked, 'post_public_writes_possible');
    assert.deepEqual(op.calls, []);
});

test('supplied approval and test hooks cannot bypass the unsupported contract', async (t) => {
    const value = fixture(t); const op = operationFixture(value.expected);
    const approval = readFileSync(value.approvalFile);
    await assert.rejects(() => executeReleaseRuntimeCutover({ ...value, operations: op.operations,
        recoverySupported: true, testHooks: { beforeCheckpoint() { throw new Error('must not reach'); } } }),
    /cutover_recovery_contract_unsupported/);
    assert.deepEqual(op.calls, []);
    assert.deepEqual(readFileSync(value.approvalFile), approval);
    assert.deepEqual(readdirSync(value.controlRoot), ['owner-approval.json']);
});
