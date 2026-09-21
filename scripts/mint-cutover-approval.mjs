#!/usr/bin/env node
/** Mint the signed, short-lived owner approval consumed by the release-runtime first cutover. */
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import {
    closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
    renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_BUILD_KIND, localBuildIdentitySha256, validateLocalPreparedArtifact } from './lib/local-reviewed-build-identity.mjs';

const APPROVAL_SCHEMA = 'nassaj-owner-cutover-approval/v1';
const CONFIG_SCHEMA = 'nassaj-release-runtime-first-cutover-config/v1';
const ACTION = 'release-runtime-first-cutover';
const CONFIG_KEYS = Object.freeze(['approvalFile', 'controlRoot', 'dispatcher', 'dispatcherSha256', 'expected',
    'ownerApprovalPublicKeyFile', 'prepare', 'schema']);
/** Mirrors APPROVAL_KEYS in lib/release-runtime-cutover.mjs; the verifier accepts these sixteen keys and no others. */
const APPROVAL_KEYS = Object.freeze(['action', 'assetSha256', 'databaseContractSha256', 'expiresAt', 'hostIdentitySha256',
    'expectedSha256', 'issuedAt', 'migrationIdentitySha256', 'nodeInstanceId', 'nonce', 'ownerId', 'pm2SnapshotSha256',
    'releaseIdentitySha256', 'requestId', 'schema', 'signature']);
const COPIED_FINGERPRINTS = Object.freeze(['hostIdentitySha256', 'releaseIdentitySha256', 'migrationIdentitySha256',
    'pm2SnapshotSha256', 'databaseContractSha256', 'assetSha256']);
const EXPECTED_HASHES = Object.freeze([...COPIED_FINGERPRINTS, 'ownerApprovalKeySha256']);
const HEX64 = /^[a-f0-9]{64}$/;
const REQUEST = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const INSTANCE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{80,128}$/;
const DEFAULT_TTL_SECONDS = 120;
const MAXIMUM_TTL_SECONDS = 300;
const FLAGS = Object.freeze(['--config', '--expected', '--private-key', '--owner-id', '--ttl-seconds', '--out', '--action', '--forward-config']);

/** SHA-256 hex digest, identical to the verifier primitive. */
function sha(value) { return createHash('sha256').update(value).digest('hex'); }

/** Canonical serialisation, byte-identical to canonical() in lib/release-runtime-cutover.mjs. */
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function syncDirectory(directory) {
    const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Read a non-symlink regular file; `requirePrivate` additionally forbids group and world access. */
function readSafeFile(file, { maximumBytes = 256 * 1024, requirePrivate = false } = {}) {
    const before = lstatSync(file);
    const uid = typeof process.getuid === 'function' ? process.getuid() : before.uid;
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximumBytes
        || (requirePrivate && ((before.mode & 0o077) !== 0 || (before.uid !== uid && before.uid !== 0)))) {
        throw new Error(`mint_file_unsafe:${file}`);
    }
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = fstatSync(fd);
        if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`mint_file_changed:${file}`);
        return readFileSync(fd);
    } finally { closeSync(fd); }
}

/** Mirrors validateExpected() in the verifier: the identity block must be complete before anything is signed. */
function validateExpected(expected) {
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)
        || !INSTANCE.test(expected.nodeInstanceId || '') || !INSTANCE.test(expected.generationId || '')
        || !HEX64.test(expected.targetSchemaDigest || '') || !HEX64.test(expected.serverBuildId || '')
        || !HEX64.test(expected.clientBuildId || '')
        || EXPECTED_HASHES.some((key) => !HEX64.test(expected[key] || ''))) {
        throw new Error('mint_expected_identity_invalid');
    }
    validateLocalExpected(expected);
    return expected;
}

function readConfig(file) {
    const config = JSON.parse(readSafeFile(file, { requirePrivate: true }));
    if (config?.schema !== CONFIG_SCHEMA || Object.keys(config).sort().join(',') !== CONFIG_KEYS.join(',')) {
        throw new Error('mint_config_invalid');
    }
    return config;
}

/** Load the owner signing key from disk and prove it is the key the target host already trusts. */
function loadOwnerKey(file, expected) {
    const bytes = readSafeFile(file, { maximumBytes: 16_384, requirePrivate: true });
    let privateKey;
    try { privateKey = createPrivateKey(bytes); } catch { throw new Error('mint_private_key_invalid'); }
    finally { bytes.fill(0); }
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('mint_private_key_type_unsupported');
    const digest = sha(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }));
    if (digest !== expected.ownerApprovalKeySha256) {
        throw new Error(`mint_key_fingerprint_mismatch:derived=${digest}:expected=${expected.ownerApprovalKeySha256}`);
    }
    return privateKey;
}

function validateLocalExpected(expected) {
    if (expected.artifactPolicy === undefined) {
        if (expected.localBuild !== undefined || expected.localArtifact !== undefined) throw Error('mint_mixed_local_identity');
        return;
    }
    if (expected.artifactPolicy !== LOCAL_BUILD_KIND) throw Error('mint_artifact_policy_invalid');
    const artifact = validateLocalPreparedArtifact(expected.localArtifact, expected.localBuild);
    if (expected.releaseIdentitySha256 !== localBuildIdentitySha256(expected.localBuild)
        || expected.assetSha256 !== artifact.archiveSha256 || expected.databaseContractSha256 !== artifact.databaseContractSha256
        || expected.serverBuildId !== expected.localBuild.serverBuildId || expected.clientBuildId !== expected.localBuild.clientBuildId
        || ['releaseId', 'assetId', 'detachedManifestId', 'repo', 'repository', 'tag'].some(key => Object.hasOwn(expected, key)))
        throw Error('mint_local_identity_binding');
}
function readForwardConfig(file) {
    const config = JSON.parse(readSafeFile(requireAbsolute(file, '--forward-config'), { requirePrivate: true }));
    if (config.schema !== 'nassaj-release-runtime-host-config/v1') throw Error('mint_forward_config_invalid');
    const expected = validateExpected(config.expected); const identity = config.bootstrapClaim?.identity;
    if (['supervisorPlanSha256', 'mutatorPlanSha256', 'forwardExecutableClosureSha256'].some(key => !HEX64.test(expected[key] || ''))
        || !config.forwardActivation?.supervisorPlan || !config.forwardActivation?.mutatorPlan
        || sha(canonical(config.forwardActivation.supervisorPlan)) !== expected.supervisorPlanSha256
        || sha(canonical(config.forwardActivation.mutatorPlan)) !== expected.mutatorPlanSha256
        || config.forwardMigration?.closure?.sha256 !== expected.forwardExecutableClosureSha256) throw Error('mint_forward_plan_binding');
    const keys = 'nodeInstanceId,generationId,releaseIdentitySha256,startupClosureSha256,databaseContractSha256,databaseDev,databaseIno,startupPolicyId,startupAdmissionPolicy';
    if (!identity || Object.keys(identity).sort().join(',') !== keys.split(',').sort().join(',')
        || identity.startupPolicyId !== 'existing-security-state/v1' || identity.startupAdmissionPolicy !== 'same-generation-auto-restart/v1'
        || !/^(0|[1-9][0-9]*)$/.test(identity.databaseDev) || !/^[1-9][0-9]*$/.test(identity.databaseIno)
        || !HEX64.test(identity.startupClosureSha256)
        || ['nodeInstanceId', 'generationId', 'releaseIdentitySha256', 'databaseContractSha256'].some(key => identity[key] !== expected[key])
        || (expected.artifactPolicy === LOCAL_BUILD_KIND && identity.startupClosureSha256 !== expected.localArtifact.startupClosureSha256))
        throw Error('mint_forward_startup_identity_invalid');
    const publicKey = createPublicKey(readSafeFile(requireAbsolute(config.bootstrapClaim.ownerApprovalPublicKeyFile, 'owner-public-key')));
    if (sha(publicKey.export({ type: 'spki', format: 'der' })) !== expected.ownerApprovalKeySha256) throw Error('mint_forward_public_key_mismatch');
    return { ...config, approvalFile: config.bootstrapClaim.approvalFile,
        ownerApprovalPublicKeyFile: config.bootstrapClaim.ownerApprovalPublicKeyFile };
}

/** Best-effort cross-check against the public key the operator will verify with. */
function assertPublicKeyFile(file, digest) {
    if (!file) return;
    let bytes;
    try { bytes = readFileSync(file); } catch { return; }
    let publicKey;
    try { publicKey = createPublicKey(bytes); } catch { throw new Error('mint_public_key_file_invalid'); }
    if (sha(publicKey.export({ type: 'spki', format: 'der' })) !== digest) throw new Error('mint_public_key_file_mismatch');
}

function resolveOwnerId(ownerId) {
    const value = ownerId || `owner-${os.userInfo().username}`;
    if (!REQUEST.test(value)) throw new Error('mint_owner_id_invalid');
    return value;
}

function resolveTtl(ttlSeconds) {
    const value = ttlSeconds === undefined ? DEFAULT_TTL_SECONDS : Number(ttlSeconds);
    if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_TTL_SECONDS) throw new Error('mint_ttl_out_of_range');
    return value;
}

/** Build the exact sixteen-key approval payload (fifteen here, plus the signature added after signing). */
function buildPayload(expected, { ownerId, ttlSeconds, now }) {
    const payload = {
        schema: APPROVAL_SCHEMA, action: ACTION,
        requestId: `req-${randomBytes(16).toString('hex')}`, ownerId, nonce: randomBytes(24).toString('hex'),
        nodeInstanceId: expected.nodeInstanceId,
        expectedSha256: sha(canonical(expected)),
        issuedAt: now, expiresAt: now + (ttlSeconds * 1000),
    };
    for (const key of COPIED_FINGERPRINTS) payload[key] = expected[key];
    return payload;
}

function atomicApproval(file, approval) {
    const temporary = `${file}.partial-${process.pid}-${randomBytes(8).toString('hex')}`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(approval)}\n`); fsyncSync(fd); }
    catch (error) { closeSync(fd); unlinkSync(temporary); throw error; }
    closeSync(fd);
    renameSync(temporary, file); syncDirectory(path.dirname(file));
}

/**
 * Mint one signed owner approval for the release-runtime first cutover.
 * @param {{config?: string, expectedFile?: string, privateKeyFile: string, ownerId?: string,
 *   ttlSeconds?: number, out?: string, force?: boolean, now?: number}} options
 * @returns {{file: string, requestId: string, ownerId: string, nodeInstanceId: string,
 *   issuedAt: number, expiresAt: number, expiresAtIso: string, ttlSeconds: number,
 *   expectedSha256: string, ownerApprovalKeySha256: string, signaturePreview: string}}
 */
export function mintCutoverApproval(options = {}) {
    if (options.action === 'restartCommittedGeneration') return mintManagedRestartApproval(options);
    if (options.action !== undefined && options.action !== ACTION) throw new Error('mint_action_invalid');
    if (options.forwardConfig && (options.config || options.expectedFile)) throw Error('mint_forward_mixed_input');
    const config = options.forwardConfig ? readForwardConfig(options.forwardConfig) : options.config ? readConfig(options.config) : undefined;
    const expected = validateExpected(config ? config.expected
        : JSON.parse(readSafeFile(requireAbsolute(options.expectedFile, '--expected'))));
    const file = requireAbsolute(options.out || config?.approvalFile, '--out');
    if (existsSync(file) && !options.force) throw new Error('mint_output_exists');
    const ttlSeconds = resolveTtl(options.ttlSeconds);
    const now = Number.isSafeInteger(options.now) ? options.now : Date.now();
    const payload = buildPayload(expected, { ownerId: resolveOwnerId(options.ownerId), ttlSeconds, now });
    if (options.forwardConfig) payload.startupAdmission = config.bootstrapClaim.identity;
    assertPublicKeyFile(config?.ownerApprovalPublicKeyFile, expected.ownerApprovalKeySha256);
    const privateKey = loadOwnerKey(requireAbsolute(options.privateKeyFile, '--private-key'), expected);
    const raw = sign(null, Buffer.from(canonical(payload)), privateKey);
    const signature = raw.toString('base64url'); raw.fill(0);
    const approval = { ...payload, signature };
    if (Object.keys(approval).sort().join('\0') !== [...APPROVAL_KEYS, ...(options.forwardConfig ? ['startupAdmission'] : [])].sort().join('\0')) throw new Error('mint_payload_keys_invalid');
    if (!SIGNATURE.test(signature)) throw new Error('mint_signature_encoding_invalid');
    atomicApproval(file, approval);
    return Object.freeze({ file, requestId: approval.requestId, ownerId: approval.ownerId,
        nodeInstanceId: approval.nodeInstanceId, issuedAt: approval.issuedAt, expiresAt: approval.expiresAt,
        expiresAtIso: new Date(approval.expiresAt).toISOString(), ttlSeconds,
        expectedSha256: approval.expectedSha256, ownerApprovalKeySha256: expected.ownerApprovalKeySha256,
        signaturePreview: `${signature.slice(0, 8)}...` });
}

const MANAGED_TARGET_KEYS = Object.freeze(['schema', 'operationId', 'nodeInstanceId', 'generationId',
    'releaseIdentitySha256', 'databaseContractSha256', 'startupClosureSha256', 'commitReceiptSha256',
    'ownerApprovalKeySha256', 'expectedSha256', 'managedConfigurationSha256']);
/** Mint the existing owner's explicit, single-operation same-generation restart approval. */
export function mintManagedRestartApproval(options = {}) {
    if (options.config || options.forwardConfig) throw new Error('mint_managed_requires_expected');
    const target = JSON.parse(readSafeFile(requireAbsolute(options.expectedFile, '--expected'), { requirePrivate: true }));
    if (target?.schema !== 'nassaj-managed-restart-approval-target/v1'
        || Object.keys(target).sort().join(',') !== [...MANAGED_TARGET_KEYS].sort().join(',')
        || !/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(target.operationId || '')
        || !INSTANCE.test(target.nodeInstanceId || '') || !INSTANCE.test(target.generationId || '')
        || MANAGED_TARGET_KEYS.filter(key => key.endsWith('Sha256')).some(key => !HEX64.test(target[key] || ''))) {
        throw new Error('mint_managed_target_invalid');
    }
    const file = requireAbsolute(options.out, '--out');
    if (existsSync(file) && !options.force) throw new Error('mint_output_exists');
    const ttlSeconds = resolveTtl(options.ttlSeconds);
    const now = options.now === undefined ? Date.now() : options.now;
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + ttlSeconds * 1000)) throw new Error('mint_time_invalid');
    const payload = { schema: 'nassaj-owner-managed-restart-approval/v1', action: 'restartCommittedGeneration',
        scope: 'same-generation-managed-restart/v1', target, ownerId: resolveOwnerId(options.ownerId),
        nonce: randomBytes(24).toString('hex'), issuedAt: now, expiresAt: now + ttlSeconds * 1000 };
    const key = loadOwnerKey(requireAbsolute(options.privateKeyFile, '--private-key'), target);
    const raw = sign(null, Buffer.from(canonical(payload)), key);
    const signature = raw.toString('base64url'); raw.fill(0);
    atomicApproval(file, { ...payload, signature });
    return Object.freeze({ file, requestId: target.operationId, ownerId: payload.ownerId,
        nodeInstanceId: target.nodeInstanceId, issuedAt: now, expiresAt: payload.expiresAt,
        expiresAtIso: new Date(payload.expiresAt).toISOString(), ttlSeconds,
        expectedSha256: target.expectedSha256, ownerApprovalKeySha256: target.ownerApprovalKeySha256,
        signaturePreview: `${signature.slice(0, 8)}...` });
}

function requireAbsolute(value, flag) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`mint_absolute_path_required:${flag}`);
    return value;
}

/** Parse the fixed operator flag set; unknown or repeated flags are refused. */
export function parseArguments(argv) {
    const values = new Map();
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (flag === '--force') { values.set(flag, 'true'); continue; }
        if (!FLAGS.includes(flag) || values.has(flag) || index + 1 >= argv.length) throw new Error(`mint_argument_invalid:${flag}`);
        values.set(flag, argv[index + 1]); index += 1;
    }
    if (['--config', '--expected', '--forward-config'].filter(flag => values.has(flag)).length !== 1) throw new Error('mint_requires_config_or_expected');
    if (values.has('--action') && ![ACTION, 'restartCommittedGeneration'].includes(values.get('--action'))) throw new Error('mint_action_invalid');
    if (!values.has('--private-key')) throw new Error('mint_requires_private_key');
    return { ...(values.has('--action') ? { action: values.get('--action') } : {}), ...(values.has('--forward-config') ? { forwardConfig: values.get('--forward-config') } : {}), config: values.get('--config'), expectedFile: values.get('--expected'),
        privateKeyFile: values.get('--private-key'), ownerId: values.get('--owner-id'), out: values.get('--out'),
        force: values.has('--force'),
        ttlSeconds: values.has('--ttl-seconds') ? Number(values.get('--ttl-seconds')) : undefined };
}

function report(result) {
    return [
        'Nassaj owner cutover approval minted.',
        `  file:        ${result.file}`,
        `  requestId:   ${result.requestId}`,
        `  ownerId:     ${result.ownerId}`,
        `  node:        ${result.nodeInstanceId}`,
        `  expiresAt:   ${result.expiresAtIso} (${result.ttlSeconds}s)`,
        `  expectedSha: ${result.expectedSha256}`,
        `  keySha256:   ${result.ownerApprovalKeySha256}`,
        `  signature:   ${result.signaturePreview} (truncated)`,
        '',
    ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const result = mintCutoverApproval(parseArguments(process.argv.slice(2)));
        process.stdout.write(report(result));
    } catch (error) {
        process.stderr.write(`Nassaj owner approval minting blocked (${error?.message || 'failed'}).\n`);
        process.exitCode = 78;
    }
}
