import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { executeReleaseRuntimeCutover } from './lib/release-runtime-cutover.mjs';
import { mintCutoverApproval, parseArguments } from './mint-cutover-approval.mjs';

const TEMP = process.env.NASSAJ_TEST_TMP || process.env.TMPDIR || '/var/tmp';
const hash = (character) => character.repeat(64);
const ownerKeys = generateKeyPairSync('ed25519');
const foreignKeys = generateKeyPairSync('ed25519');
const ownerApprovalPublicKeyPem = ownerKeys.publicKey.export({ type: 'spki', format: 'pem' });
const spkiSha = (key) => createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');

const expected = Object.freeze({ nodeInstanceId: 'cutover-node', hostIdentitySha256: hash('a'),
    releaseIdentitySha256: hash('b'), migrationIdentitySha256: hash('c'), pm2SnapshotSha256: hash('d'),
    databaseContractSha256: hash('e'), assetSha256: hash('f'), targetSchemaDigest: hash('1'),
    serverBuildId: hash('3'), clientBuildId: hash('4'), generationId: '1.46.0.7-test',
    ownerApprovalKeySha256: spkiSha(ownerKeys.publicKey) });

function fixture(t, { key = ownerKeys.privateKey } = {}) {
    const root = mkdtempSync(path.join(TEMP, 'mint-cutover-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const controlRoot = path.join(root, 'control'); mkdirSync(controlRoot, { mode: 0o700 });
    const privateKeyFile = path.join(root, 'owner.key');
    writeFileSync(privateKeyFile, key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const expectedFile = path.join(root, 'expected.json');
    writeFileSync(expectedFile, `${JSON.stringify(expected)}\n`, { mode: 0o600 });
    return { root, controlRoot, privateKeyFile, expectedFile, out: path.join(root, 'approval.json') };
}

function operations() {
    const calls = [];
    const record = (name, result = {}) => async () => { calls.push(name); return result; };
    const facts = { ...expected, oldPid: 400, oldPgid: 400, oldSid: 400, killTimeout: 86_400_000,
        treeKill: false, oldHealth: 'ok' };
    const target = (visibility) => ({ health: 'ok', releaseIdentitySha256: expected.releaseIdentitySha256,
        updateReady: true, updateStrategy: 'artifact-runtime-v2', visibility, serverBuildId: expected.serverBuildId,
        clientBuildId: expected.clientBuildId, generationId: expected.generationId, oldConversationResumed: true });
    return { calls, inspect: record('inspect', facts), blockIngress: record('blockIngress'),
        fenceAdmission: record('fenceAdmission'),
        verifyZeroWork: record('verifyZeroWork', { liveSessions: 0, workflows: 0, admittedTurns: 0 }),
        freezeOldWriters: record('freezeOldWriters'),
        verifyWritersFrozen: record('verifyWritersFrozen', { processGroupState: 'T', databaseWriters: 0,
            unknownDescendants: 0, liveSessions: 0, workflows: 0, admittedTurns: 0 }),
        finalVacuumAndBackup: record('finalVacuumAndBackup', { integrityCheck: 'ok', foreignKeyViolations: 0,
            targetSchemaDigest: expected.targetSchemaDigest, backupSha256: hash('2'),
            preMigrationBackupSha256: hash('5'), fsyncComplete: true,
            semanticPreservation: { schema: 'nassaj-database-semantic-preservation/v1', passed: true,
                beforeReceiptSha256: hash('6'), afterReceiptSha256: hash('7') } }),
        switchSupervisorToLauncher: record('switchSupervisorToLauncher'),
        verifyPrivateTarget: record('verifyPrivateTarget', target('private')), openIngress: record('openIngress'),
        verifyPublicTarget: record('verifyPublicTarget', target('public')),
        restoreDatabaseFromBackup: record('restoreDatabaseFromBackup'),
        restoreOldSupervisor: record('restoreOldSupervisor'), resumeOldWriters: record('resumeOldWriters'),
        verifyOldHealth: record('verifyOldHealth', { health: 'ok', pm2SnapshotSha256: expected.pm2SnapshotSha256 }),
        restoreIngress: record('restoreIngress') };
}

const execute = (value, approvalFile, target = expected) => executeReleaseRuntimeCutover({
    expected: target, operations: operations(), controlRoot: value.controlRoot, approvalFile,
    ownerApprovalPublicKeyPem });

function rewrite(file, mutate) {
    const approval = JSON.parse(readFileSync(file, 'utf8')); mutate(approval);
    writeFileSync(file, `${JSON.stringify(approval)}\n`, { mode: 0o600 }); return file;
}

test('minted signature verifies independently while unsupported cutover preserves approval', async (t) => {
    const value = fixture(t);
    const minted = mintCutoverApproval({ expectedFile: value.expectedFile, privateKeyFile: value.privateKeyFile,
        out: value.out, ownerId: 'owner-1234' });
    assert.match(minted.requestId, /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/);
    assert.equal(minted.expiresAt - minted.issuedAt, 120_000);
    assert.equal(Object.keys(JSON.parse(readFileSync(value.out, 'utf8'))).length, 16);
    assert.equal(lstatSync(value.out).mode & 0o777, 0o600);
    const { signature, ...payload } = JSON.parse(readFileSync(value.out, 'utf8'));
    const canonical = (value) => value && typeof value === 'object'
        ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
        : JSON.stringify(value);
    assert.equal(verify(null, Buffer.from(canonical(payload)), ownerKeys.publicKey, Buffer.from(signature, 'base64url')), true);
    const original = readFileSync(value.out);
    await assert.rejects(execute(value, value.out), /cutover_recovery_contract_unsupported/);
    assert.deepEqual(readFileSync(value.out), original);
    assert.equal(existsSync(`${value.out}.consumed-${minted.requestId}`), false);

});

test('minting reads the config block and writes the configured approval file at 0600', async (t) => {
    const value = fixture(t);
    const publicKeyFile = path.join(value.root, 'owner.pub');
    writeFileSync(publicKeyFile, ownerApprovalPublicKeyPem, { mode: 0o600 });
    const configFile = path.join(value.root, 'config.json');
    writeFileSync(configFile, `${JSON.stringify({ schema: 'nassaj-release-runtime-first-cutover-config/v1',
        approvalFile: value.out, controlRoot: value.controlRoot, dispatcher: '/usr/local/bin/dispatcher',
        dispatcherSha256: hash('9'), expected, ownerApprovalPublicKeyFile: publicKeyFile, prepare: {} })}\n`,
    { mode: 0o600 });
    const minted = mintCutoverApproval({ config: configFile, privateKeyFile: value.privateKeyFile, ttlSeconds: 300 });
    assert.equal(minted.file, value.out);
    assert.equal(minted.expiresAt - minted.issuedAt, 300_000);
    await assert.rejects(execute(value, value.out), /cutover_recovery_contract_unsupported/);
    assert.equal(existsSync(value.out), true);
});

test('minting refuses a ttl above the verifier ceiling and writes nothing', (t) => {
    const value = fixture(t);
    assert.throws(() => mintCutoverApproval({ expectedFile: value.expectedFile,
        privateKeyFile: value.privateKeyFile, out: value.out, ttlSeconds: 301 }), /mint_ttl_out_of_range/);
    assert.equal(existsSync(value.out), false);
});

test('minting refuses a key whose fingerprint is not the trusted owner key', (t) => {
    const value = fixture(t, { key: foreignKeys.privateKey });
    assert.throws(() => mintCutoverApproval({ expectedFile: value.expectedFile,
        privateKeyFile: value.privateKeyFile, out: value.out }), /mint_key_fingerprint_mismatch/);
    assert.equal(existsSync(value.out), false);
});

test('tampered expected identity cannot bypass the unsupported cutover gate', async (t) => {
    const value = fixture(t);
    mintCutoverApproval({ expectedFile: value.expectedFile, privateKeyFile: value.privateKeyFile, out: value.out });
    await assert.rejects(execute(value, value.out, { ...expected, generationId: '1.46.0.7-tampered' }),
        /cutover_recovery_contract_unsupported/);
});

test('an altered approval cannot bypass the unsupported cutover gate', async (t) => {
    const value = fixture(t);
    const extra = path.join(value.root, 'extra.json'); const missing = path.join(value.root, 'missing.json');
    mintCutoverApproval({ expectedFile: value.expectedFile, privateKeyFile: value.privateKeyFile, out: extra });
    mintCutoverApproval({ expectedFile: value.expectedFile, privateKeyFile: value.privateKeyFile, out: missing });
    rewrite(extra, (approval) => { approval.extraKey = 'x'; });
    rewrite(missing, (approval) => { delete approval.nonce; });
    await assert.rejects(execute(value, extra), /cutover_recovery_contract_unsupported/);
    await assert.rejects(execute(value, missing), /cutover_recovery_contract_unsupported/);
});

test('minting refuses to overwrite an unconsumed approval unless forced', (t) => {
    const value = fixture(t);
    const first = mintCutoverApproval({ expectedFile: value.expectedFile, privateKeyFile: value.privateKeyFile,
        out: value.out });
    assert.throws(() => mintCutoverApproval({ expectedFile: value.expectedFile,
        privateKeyFile: value.privateKeyFile, out: value.out }), /mint_output_exists/);
    const second = mintCutoverApproval({ expectedFile: value.expectedFile, privateKeyFile: value.privateKeyFile,
        out: value.out, force: true });
    assert.notEqual(first.requestId, second.requestId);
});

test('the operator flag set refuses ambiguous, unknown and relative arguments', (t) => {
    const value = fixture(t);
    assert.throws(() => parseArguments(['--private-key', '/k']), /mint_requires_config_or_expected/);
    assert.throws(() => parseArguments(['--config', '/c', '--expected', '/e', '--private-key', '/k']),
        /mint_requires_config_or_expected/);
    assert.throws(() => parseArguments(['--expected', '/e']), /mint_requires_private_key/);
    assert.throws(() => parseArguments(['--expected', '/e', '--private-key', '/k', '--rm-rf', '/']),
        /mint_argument_invalid/);
    assert.deepEqual(parseArguments(['--expected', '/e', '--private-key', '/k', '--ttl-seconds', '60']).ttlSeconds, 60);
    assert.throws(() => mintCutoverApproval({ expectedFile: value.expectedFile,
        privateKeyFile: value.privateKeyFile, out: 'approval.json' }), /mint_absolute_path_required/);
});

test('explicit managed restart scope binds one exact target using the existing owner key', t => {
    const f = fixture(t);
    const target = { schema: 'nassaj-managed-restart-approval-target/v1', operationId: 'managed-restart-12345',
        nodeInstanceId: expected.nodeInstanceId, generationId: expected.generationId,
        releaseIdentitySha256: expected.releaseIdentitySha256, databaseContractSha256: expected.databaseContractSha256,
        startupClosureSha256: hash('6'), commitReceiptSha256: hash('7'), ownerApprovalKeySha256: expected.ownerApprovalKeySha256,
        expectedSha256: hash('8'), managedConfigurationSha256: hash('9') };
    writeFileSync(f.expectedFile, JSON.stringify(target));
    const options = { action: 'restartCommittedGeneration', expectedFile: f.expectedFile,
        privateKeyFile: f.privateKeyFile, out: f.out, now: 123456, ttlSeconds: 120 };
    mintCutoverApproval(options);
    const approval = JSON.parse(readFileSync(f.out)); const { signature, ...payload } = approval;
    const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
        : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
    assert.equal(payload.action, 'restartCommittedGeneration');
    assert.equal(payload.scope, 'same-generation-managed-restart/v1');
    assert.deepEqual(payload.target, target);
    assert.equal(verify(null, Buffer.from(canonical(payload)), ownerKeys.publicKey, Buffer.from(signature, 'base64url')), true);
    payload.target.operationId = 'another-operation-12345';
    assert.equal(verify(null, Buffer.from(canonical(payload)), ownerKeys.publicKey, Buffer.from(signature, 'base64url')), false);
    assert.equal(lstatSync(f.out).mode & 0o777, 0o600);
    assert.throws(() => mintCutoverApproval(options), /output_exists/);
    for (const mutate of [v => { delete v.commitReceiptSha256; }, v => { v.extra = true; }, v => { v.operationId = '../escape'; },
        v => { v.managedConfigurationSha256 = 'invalid'; }]) {
        const invalid = structuredClone(target); mutate(invalid); writeFileSync(f.expectedFile, JSON.stringify(invalid));
        assert.throws(() => mintCutoverApproval({ ...options, force: true }), /managed_target_invalid/);
    }
    assert.equal(parseArguments(['--action', 'restartCommittedGeneration', '--expected', f.expectedFile, '--private-key', f.privateKeyFile]).action, 'restartCommittedGeneration');
    assert.throws(() => parseArguments(['--action', 'arbitrary', '--expected', f.expectedFile, '--private-key', f.privateKeyFile]), /action_invalid/);
});
