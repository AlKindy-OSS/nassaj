import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { installFixedStateMutexAuthority } from './fixtures/fixed-state-mutex-authority.mjs';
import { executeReleaseRuntimeCutover, planReleaseRuntimeCutover } from './lib/release-runtime-cutover.mjs';

const TEMP = process.env.NASSAJ_TEST_TMP || process.env.TMPDIR || '/var/tmp';
const hash = (character) => character.repeat(64);
const approvalKeys = generateKeyPairSync('ed25519');
const ownerApprovalPublicKeyPem = approvalKeys.publicKey.export({ type: 'spki', format: 'pem' });
const ownerApprovalKeySha256 = createHash('sha256').update(approvalKeys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
const expected = Object.freeze({ nodeInstanceId: 'cutover-node', hostIdentitySha256: hash('a'), releaseIdentitySha256: hash('b'),
    migrationIdentitySha256: hash('c'), pm2SnapshotSha256: hash('d'), databaseContractSha256: hash('e'),
    assetSha256: hash('f'), targetSchemaDigest: hash('1'), serverBuildId: hash('3'), clientBuildId: hash('4'),
    generationId: '1.46.0.2-test', ownerApprovalKeySha256 });

function fixture(t) {
    const root = mkdtempSync(path.join(TEMP, 'release-cutover-')); t.after(() => rmSync(root, { recursive: true, force: true }));
    const controlRoot = path.join(root, 'control'); mkdirSync(controlRoot, { mode: 0o700 });
    const approvalFile = path.join(root, 'approval.json'); const now = Date.now();
    const payload = { schema: 'nassaj-owner-cutover-approval/v1', action: 'release-runtime-first-cutover',
        requestId: 'request-1234', ownerId: 'owner-1234', nodeInstanceId: expected.nodeInstanceId,
        ...Object.fromEntries(Object.entries(expected).filter(([key]) => key.endsWith('Sha256') && key !== 'targetSchemaDigest')),
        expectedSha256: createHash('sha256').update(canonical(expected)).digest('hex'),
        issuedAt: now - 1_000, expiresAt: now + 60_000, nonce: 'nonce-1234' };
    delete payload.ownerApprovalKeySha256;
    const signature = sign(null, Buffer.from(canonical(payload)), approvalKeys.privateKey).toString('base64url');
    writeFileSync(approvalFile, `${JSON.stringify({ ...payload, signature })}\n`, { mode: 0o600 });
    chmodSync(approvalFile, 0o600);
    // Journal mutation runs under the fixed root state mutex; keep its config outside the control root.
    installFixedStateMutexAuthority(t, controlRoot, {}, { file: path.join(root, 'mutex-host.json') });
    return { root, controlRoot, approvalFile, now, ownerApprovalPublicKeyPem };
}

function operations({ failPrivate = false, failPublic = false, semantic = true } = {}) {
    const calls = [];
    const record = (name, result = {}) => async () => { calls.push(name); return result; };
    const facts = { ...expected, oldPid: 400, oldPgid: 400, oldSid: 400, killTimeout: 86_400_000,
        treeKill: false, oldHealth: 'ok' };
    return { calls, inspect: record('inspect', facts), blockIngress: record('blockIngress'), fenceAdmission: record('fenceAdmission'),
        verifyZeroWork: record('verifyZeroWork', { liveSessions: 0, workflows: 0, admittedTurns: 0 }),
        freezeOldWriters: record('freezeOldWriters'), verifyWritersFrozen: record('verifyWritersFrozen',
            { processGroupState: 'T', databaseWriters: 0, unknownDescendants: 0, liveSessions: 0, workflows: 0, admittedTurns: 0 }),
        finalVacuumAndBackup: record('finalVacuumAndBackup', { integrityCheck: 'ok', foreignKeyViolations: 0,
            targetSchemaDigest: expected.targetSchemaDigest, backupSha256: hash('2'), preMigrationBackupSha256: hash('5'),
            fsyncComplete: true, semanticPreservation: semantic ? { schema: 'nassaj-database-semantic-preservation/v1', passed: true,
                beforeReceiptSha256: hash('6'), afterReceiptSha256: hash('7') } : undefined }),
        switchSupervisorToLauncher: record('switchSupervisorToLauncher'), verifyPrivateTarget: record('verifyPrivateTarget',
            { health: failPrivate ? 'bad' : 'ok', releaseIdentitySha256: expected.releaseIdentitySha256,
                updateReady: true, updateStrategy: 'artifact-runtime-v2', visibility: 'private', serverBuildId: expected.serverBuildId,
                clientBuildId: expected.clientBuildId, generationId: expected.generationId }),
        openIngress: record('openIngress'), verifyPublicTarget: record('verifyPublicTarget',
            { health: failPublic ? 'bad' : 'ok', releaseIdentitySha256: expected.releaseIdentitySha256,
                updateReady: true, updateStrategy: 'artifact-runtime-v2', visibility: 'public', serverBuildId: expected.serverBuildId,
                clientBuildId: expected.clientBuildId, generationId: expected.generationId, oldConversationResumed: true }),
        restoreDatabaseFromBackup: record('restoreDatabaseFromBackup'),
        restoreOldSupervisor: record('restoreOldSupervisor'), resumeOldWriters: record('resumeOldWriters'),
        verifyOldHealth: record('verifyOldHealth', { health: 'ok', pm2SnapshotSha256: expected.pm2SnapshotSha256 }),
        restoreIngress: record('restoreIngress') };
}

test('plan and execution reject unsupported recovery before operations or approval consumption', async (t) => {
    const value = fixture(t); const ops = operations();
    const before = readFileSync(value.approvalFile);
    await assert.rejects(() => planReleaseRuntimeCutover({ expected, operations: ops }), /cutover_recovery_contract_unsupported/);
    await assert.rejects(() => executeReleaseRuntimeCutover({ ...value, expected, operations: ops }), /cutover_recovery_contract_unsupported/);
    assert.deepEqual(ops.calls, []);
    assert.deepEqual(readFileSync(value.approvalFile), before);
    assert.deepEqual(readdirSync(value.controlRoot), []);
});

test('existing manual recovery is returned without altering evidence or invoking operations', async (t) => {
    const value = fixture(t); const ops = operations();
    const journal = { schema: 'nassaj-release-runtime-cutover/v1', expected, state: 'manual_recovery',
        phase: 'writers_frozen', sequence: 4, rollbackBlocked: 'operator_review_required', reason: 'existing evidence' };
    const file = path.join(value.controlRoot, 'first-cutover.json');
    writeFileSync(file, JSON.stringify(journal), { mode: 0o600 });
    const bytes = readFileSync(file);
    assert.deepEqual(await executeReleaseRuntimeCutover({ ...value, expected, operations: ops }), journal);
    assert.deepEqual(readFileSync(file), bytes);
    assert.deepEqual(ops.calls, []);
});
