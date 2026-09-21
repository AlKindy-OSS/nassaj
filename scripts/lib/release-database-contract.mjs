import { createDecipheriv, createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { fingerprintDatabase, verifySqliteDatabase } from './release-database-backup.mjs';
export { createVerifiedSqliteBackup, databaseSchemaDigest, fingerprintDatabase, verifySqliteDatabase }
    from './release-database-backup.mjs';
import { probeDatabaseMigrationState } from './legacy-144-database-fixture.mjs';
import { verifyMigrationClosure } from './release-database-migration-closure.mjs';

import { validateCompatibleForwardDatabaseContract } from './update-release-asset.mjs';

const HEX64 = /^[a-f0-9]{64}$/;
const CONTRACT_SCHEMA = 'nassaj-database-release-contract/v1';
const PRESERVATION_POLICY = Object.freeze({ schema: 'nassaj-database-preservation-policy/v1',
    exact: ['users', 'projects', 'sessions', 'credentials', 'credentialIdentityDigest'],
    transform: ['plaintext-credential->authenticated-envelope', 'plaintext-api-key->sha256-digest+prefix'],
    derived: ['migration-markers-monotonic'], markerAllowlist: ['participants_backfill_completed_at',
        'participants_ownership_repaired_at', 'source_update_v1_migration_completed_at',
        'migration.session_workspace_modes.snapshot.v1', 'user_credentials_encrypted_at'],
    allowedDerivedFields: { users: ['password_changed_at'] } });
export const DATABASE_PRESERVATION_POLICY_SHA256 = sha(Buffer.from(JSON.stringify(PRESERVATION_POLICY)));
function predecessorKey(value) { return `${value.schemaDigest}:${value.compatibilityShapeDigest}`; }

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function assertOwnerRegular(file, mode = 0o600) {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== mode
        || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
        throw new Error('database_file_unsafe');
    }
    return metadata;
}
function readPrivate(file) {
    const before = assertOwnerRegular(file); const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = fstatSync(fd);
        if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('database_file_changed');
        return readFileSync(fd);
    } finally { closeSync(fd); }
}
function readPinnedCode(file, runtimeRoot) {
    const root = path.resolve(runtimeRoot); const resolved = path.resolve(file);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('database_migration_entry_escape');
    const before = lstatSync(resolved);
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o022) !== 0
        || ![0, process.getuid?.()].includes(before.uid)) throw new Error('database_migration_entry_unsafe');
    const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const opened = fstatSync(fd);
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.mode !== before.mode) {
            throw new Error('database_migration_entry_changed');
        }
        return readFileSync(fd);
    } finally { closeSync(fd); }
}

/** Validate the database declaration that is sealed into a release manifest. */
export function validateDatabaseReleaseContract(manifest, expectedReleaseIdentity, expectedStartupClosureSha256) {
    const contract = manifest?.databaseContract;
    if (contract?.schema === 'nassaj-database-release-contract/v2') {
        return validateCompatibleForwardDatabaseContract(contract, expectedReleaseIdentity, expectedStartupClosureSha256);
    }
    if (!contract || contract.schema !== CONTRACT_SCHEMA
        || ['activationPolicy', 'failurePolicy', 'databasePolicy', 'migrationId', 'observationPolicy', 'source', 'target', 'startup'].some(key => Object.hasOwn(contract, key)) || contract.releaseIdentitySha256 !== expectedReleaseIdentity
        || !HEX64.test(expectedReleaseIdentity || '') || !HEX64.test(contract.migrationEntrySha256 || '')
        || !HEX64.test(contract.migrationClosureSha256 || '') || contract.migrationClosure?.sha256 !== contract.migrationClosureSha256
        || contract.migrationClosure?.schema !== 'nassaj-database-migration-closure/v2'
        || contract.migrationClosure?.assetManifestBound !== true
        || !HEX64.test(contract.targetSchemaDigest || '')
        || !HEX64.test(contract.targetCompatibilityShapeDigest || '')
        || contract.preservationPolicySha256 !== DATABASE_PRESERVATION_POLICY_SHA256
        || !Array.isArray(contract.targetMigrationStateDigests) || contract.targetMigrationStateDigests.length < 1
        || contract.targetMigrationStateDigests.some((state, index, states) => !HEX64.test(state)
            || (index > 0 && states[index - 1] >= state))
        || !Number.isSafeInteger(contract.schemaVersion) || contract.schemaVersion < 1
        || !Number.isSafeInteger(contract.minimumReadableSchemaVersion) || contract.minimumReadableSchemaVersion < 1
        || contract.minimumReadableSchemaVersion > contract.schemaVersion
        || !['compatible', 'restore_required', 'blocked'].includes(contract.previousReleasePolicy)
        || !Array.isArray(contract.acceptedPredecessors) || contract.acceptedPredecessors.length < 1
        || contract.acceptedPredecessors.length > 8
        || contract.acceptedPredecessors.some((entry) => Object.keys(entry || {}).sort().join(',') !== 'allowedMigrationStateDigests,compatibilityShapeDigest,schemaDigest'
            || !HEX64.test(entry.schemaDigest || '') || !HEX64.test(entry.compatibilityShapeDigest || '')
            || !Array.isArray(entry.allowedMigrationStateDigests) || entry.allowedMigrationStateDigests.length < 1
            || entry.allowedMigrationStateDigests.length > 64
            || entry.allowedMigrationStateDigests.some((state, index, states) => !HEX64.test(state)
                || (index > 0 && states[index - 1] >= state)))
        || contract.acceptedPredecessors.some((entry, index, entries) => index > 0
            && predecessorKey(entries[index - 1]) >= predecessorKey(entry))
        || contract.rehearsalRequired !== true) {
        throw new Error('database_release_contract_invalid');
    }
    return Object.freeze({ ...contract });
}

function decryptCredentialEnvelope(envelope, row, key) {
    const match = /^dbcred:v1:([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]+={0,2})$/.exec(envelope);
    if (!match) throw new Error('database_credential_envelope_invalid');
    const [iv, tag, ciphertext] = match.slice(1).map((part) => Buffer.from(part, 'base64'));
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length < 1
        || iv.toString('base64') !== match[1] || tag.toString('base64') !== match[2]
        || ciphertext.toString('base64') !== match[3]) throw new Error('database_credential_envelope_invalid');
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(`nassaj:user_credentials:v1:${row.id}:${row.userId}:${row.credentialType}`));
        decipher.setAuthTag(tag); return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch { throw new Error('database_credential_authentication_failed'); }
}

function credentialPreservationEvidence(file, key) {
    const db = new BetterSqlite3(file, { readonly: true, fileMustExist: true });
    try {
        const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='user_credentials'").get();
        if (!exists) return Object.freeze([]);
        const rows = db.prepare('SELECT id,user_id AS userId,credential_type AS credentialType,credential_value AS value FROM user_credentials ORDER BY id').all();
        if (rows.length && (!Buffer.isBuffer(key) || key.length !== 32)) throw new Error('database_migration_key_required');
        return Object.freeze(rows.map((row) => {
            const encrypted = String(row.value).startsWith('dbcred:v1:');
            const plaintext = encrypted ? decryptCredentialEnvelope(String(row.value), row, key) : Buffer.from(String(row.value));
            try {
                const semanticHmac = createHmac('sha256', key).update('nassaj-credential-preservation/v1\0')
                    .update(String(row.id)).update('\0').update(String(row.userId)).update('\0')
                    .update(row.credentialType).update('\0').update(plaintext).digest('hex');
                return Object.freeze({ id: row.id, userId: row.userId, credentialType: row.credentialType, encrypted,
                    semanticHmac, envelopeSha256: encrypted ? sha(Buffer.from(row.value)) : null });
            } finally { plaintext.fill(0); }
        }));
    } finally { db.close(); }
}

function verifyCredentialPreservation(before, after) {
    if (before.length !== after.length) return false;
    return before.every((source, index) => {
        const target = after[index];
        return source.id === target.id && source.userId === target.userId && source.credentialType === target.credentialType
            && source.semanticHmac === target.semanticHmac && target.encrypted === true
            && (!source.encrypted || source.envelopeSha256 === target.envelopeSha256);
    });
}
function apiKeyPreservationEvidence(file, receiptKey) {
    const db = new BetterSqlite3(file, { readonly: true, fileMustExist: true });
    try {
        const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='api_keys'").get();
        if (!exists) return Object.freeze({ shape: 'absent', records: Object.freeze([]) });
        const columns = db.prepare('PRAGMA table_info(api_keys)').all().map((column) => column.name);
        const plaintext = columns.includes('api_key'); const digested = columns.includes('key_digest') && columns.includes('key_prefix');
        if (plaintext === digested) throw new Error('database_api_key_shape_invalid');
        const rows = db.prepare(plaintext
            ? 'SELECT id,api_key AS secret FROM api_keys ORDER BY id'
            : 'SELECT id,key_digest AS digest,key_prefix AS prefix FROM api_keys ORDER BY id').all();
        const records = rows.map((row) => {
            if (plaintext) {
                if (!/^ck_[0-9a-f]{64}$/.test(row.secret || '')) throw new Error('database_api_key_plaintext_invalid');
                return Object.freeze({ id: row.id,
                    semanticHmac: createHmac('sha256', receiptKey).update('api-key\0').update(row.secret).digest('hex'),
                    expectedDigest: `sha256:${sha(Buffer.from(row.secret))}`, expectedPrefix: row.secret.slice(0, 10) });
            }
            if (!/^sha256:[0-9a-f]{64}$/.test(row.digest || '') || !/^ck_[0-9a-f]{7}$/.test(row.prefix || '')) {
                throw new Error('database_api_key_digest_invalid');
            }
            return Object.freeze({ id: row.id, digest: row.digest, prefix: row.prefix });
        });
        return Object.freeze({ shape: plaintext ? 'plaintext' : 'digested', records: Object.freeze(records) });
    } finally { db.close(); }
}
function verifyApiKeyPreservation(before, after) {
    if (before.shape === 'absent') return after.shape === 'absent';
    if (before.shape !== 'plaintext' || after.shape !== 'digested' || before.records.length !== after.records.length) return false;
    return before.records.every((source, index) => { const target = after.records[index]; return source.id === target.id
        && source.expectedDigest === target.digest && source.expectedPrefix === target.prefix; });
}

const STABLE_ROW_QUERIES = Object.freeze({
    users: `SELECT id,username,password_hash AS passwordHash,created_at AS createdAt,last_login AS lastLogin,
      is_active AS isActive,git_name AS gitName,git_email AS gitEmail,has_completed_onboarding AS hasCompletedOnboarding,
      role,status,invited_by AS invitedBy,must_change_password AS mustChangePassword,
      avatar_url AS avatarUrl FROM users ORDER BY id`,
    projects: `SELECT project_id AS projectId,project_path AS projectPath,custom_project_name AS customProjectName,
      isStarred,isArchived,visibility,created_by AS createdBy FROM projects ORDER BY project_id`,
    sessions: `SELECT session_id AS sessionId,provider,custom_name AS customName,project_path AS projectPath,
      jsonl_path AS jsonlPath,isArchived,created_at AS createdAt,updated_at AS updatedAt FROM sessions ORDER BY session_id`,
    credentials: `SELECT id,user_id AS userId,credential_name AS credentialName,credential_type AS credentialType,
      description,created_at AS createdAt,is_active AS isActive FROM user_credentials ORDER BY id`,
    apiKeys: `SELECT id,user_id AS userId,key_name AS keyName,created_at AS createdAt,last_used AS lastUsed,
      is_active AS isActive FROM api_keys ORDER BY id`,
    projectMembers: `SELECT project_id AS projectId,user_id AS userId,role,added_by AS addedBy,
      created_at AS createdAt FROM project_members ORDER BY project_id,user_id`,
    participants: `SELECT session_id AS sessionId,user_id AS userId,role,first_seen AS firstSeen,last_seen AS lastSeen,
      message_count AS messageCount FROM session_participants ORDER BY session_id,user_id`,
});
function canonicalReceiptValue(value) {
    if (Buffer.isBuffer(value)) return JSON.stringify({ $buffer: value.toString('base64') });
    if (Array.isArray(value)) return `[${value.map(canonicalReceiptValue).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalReceiptValue(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
function stableRowReceipts(file, providerKey, releaseIdentity, databaseSha256) {
    const receiptKey = createHmac('sha256', providerKey).update('nassaj-database-preservation-receipt/v1\0')
        .update(releaseIdentity).update('\0').update(databaseSha256).digest();
    const db = new BetterSqlite3(file, { readonly: true, fileMustExist: true });
    try {
        return Object.freeze(Object.fromEntries(Object.entries(STABLE_ROW_QUERIES).map(([table, sql]) => {
            const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(
                table === 'apiKeys' ? 'api_keys' : table === 'projectMembers' ? 'project_members'
                    : table === 'participants' ? 'session_participants' : table === 'credentials' ? 'user_credentials' : table);
            const rows = exists ? db.prepare(sql).all() : [];
            const receipts = rows.map((row) => createHmac('sha256', receiptKey).update(table).update('\0')
                .update(canonicalReceiptValue(row)).digest('hex'));
            return [table, Object.freeze(receipts)];
        })));
    } finally { receiptKey.fill(0); db.close(); }
}
function verifyStableRowReceipts(before, after) {
    const mismatches = [];
    for (const table of ['users', 'projects', 'sessions', 'credentials', 'apiKeys', 'projectMembers']) {
        if (JSON.stringify(before[table]) !== JSON.stringify(after[table])) mismatches.push(table);
    }
    const targetParticipants = new Set(after.participants);
    if (!before.participants.every((receipt) => targetParticipants.has(receipt))) mismatches.push('participants');
    return Object.freeze({ passed: mismatches.length === 0, mismatches: Object.freeze(mismatches) });
}

function durableClone(source, target) {
    assertOwnerRegular(source);
    const parent = path.dirname(target);
    if (statSync(parent).dev !== statSync(source).dev) throw new Error('database_rehearsal_cross_device');
    const temporary = `${target}.partial-${process.pid}`;
    const fd = openSync(temporary, 'wx', 0o600); closeSync(fd);
    try {
        copyFileSync(source, temporary); const copied = openSync(temporary, 'r');
        try { fsyncSync(copied); } finally { closeSync(copied); }
        renameSync(temporary, target); const directory = openSync(parent, 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
}

/** Rehearse the compiled migration-only runtime entry under fs permissions and an isolated network namespace. */
export function rehearseIsolatedRuntimeMigration(options) {
    const contract = validateDatabaseReleaseContract(options.manifest, options.releaseIdentitySha256);
    const runtimeRoot = path.resolve(options.runtimeRoot); const entryBytes = readPinnedCode(options.migrationEntry, runtimeRoot);
    const entryRelative = path.relative(runtimeRoot, path.resolve(options.migrationEntry)).split(path.sep).join('/');
    const closure = verifyMigrationClosure(options.runtimeRoot, contract.migrationClosure);
    if (contract.migrationClosure.entry !== `dist-server/${entryRelative}`
        || sha(entryBytes) !== contract.migrationEntrySha256 || closure.sha256 !== contract.migrationClosureSha256
        || existsSync(`${options.sourceDatabase}-wal`)
        || existsSync(`${options.sourceDatabase}-shm`)) throw new Error('database_migration_runtime_identity_invalid');
    let sourceEvidence; let sourceProbe;
    try { sourceEvidence = verifySqliteDatabase(options.sourceDatabase); }
    catch { throw new Error('legacy_admission_blocked:legacy-144-integrity-or-fk-inconsistent'); }
    try { sourceProbe = probeDatabaseMigrationState(options.sourceDatabase); }
    catch { throw new Error('legacy_admission_blocked:legacy-144-malformed-probe'); }
    const predecessor = contract.acceptedPredecessors.find((entry) => entry.schemaDigest === sourceProbe.schemaDigest
        && entry.compatibilityShapeDigest === sourceProbe.compatibilityShapeDigest
        && entry.allowedMigrationStateDigests.includes(sourceProbe.migrationStateDigest));
    if (!predecessor) {
        if (options.providerSecretsKeyFile && sourceProbe.stateProbe.preservation.credentials > 0) {
            const diagnosticKey = readPrivate(options.providerSecretsKeyFile);
            try { credentialPreservationEvidence(options.sourceDatabase, diagnosticKey); }
            catch (error) {
                if (/database_credential_(?:authentication_failed|envelope_invalid)/.test(error?.message || '')) {
                    throw new Error('legacy_admission_blocked:legacy-144-credential-auth-failed');
                }
                throw error;
            } finally { diagnosticKey.fill(0); }
        }
        throw new Error('legacy_admission_blocked:legacy-144-state-unsupported');
    }
    if (!options.providerSecretsKeyFile || !options.secretCapabilityFile) {
        throw new Error('legacy_admission_blocked:legacy-144-credential-key-unavailable');
    }
    durableClone(options.sourceDatabase, options.rehearsalDatabase);
    const database = path.resolve(options.rehearsalDatabase);
    const databaseDirectory = path.dirname(database); const runtimeReal = path.resolve(runtimeRoot);
    const nodeModulesRoot = path.join(path.dirname(runtimeRoot), 'node_modules');
    const entryReal = path.resolve(options.migrationEntry);
    const directoryMetadata = lstatSync(databaseDirectory);
    const nodeModulesMetadata = lstatSync(nodeModulesRoot);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || (directoryMetadata.mode & 0o077) !== 0
        || !nodeModulesMetadata.isDirectory() || nodeModulesMetadata.isSymbolicLink()
        || !entryReal.startsWith(`${runtimeReal}${path.sep}`)) throw new Error('database_migration_runtime_boundary_invalid');
    const isolationHelper = path.resolve(options.isolationHelper || path.join(path.dirname(new URL(import.meta.url).pathname), '..',
        'run-release-database-rehearsal.sh'));
    const helperMetadata = lstatSync(isolationHelper);
    if (!helperMetadata.isFile() || helperMetadata.isSymbolicLink() || (helperMetadata.mode & 0o111) === 0) {
        throw new Error('database_migration_isolation_helper_invalid');
    }
    let output; let keyFd = null; let capabilityFd = null; let keyBytes = null; let credentialBefore = null;
    let stableRowsBefore = null; let apiKeysBefore = null;
    try {
        const stdio = ['ignore', 'pipe', 'pipe']; const environment = { PATH: process.env.PATH, HOME: path.dirname(database), LC_ALL: 'C',
            NODE_ENV: 'production', NASSAJ_MIGRATION_ONLY: '1' };
        if (options.providerSecretsKeyFile && options.secretCapabilityFile) {
            const keyMetadata = assertOwnerRegular(options.providerSecretsKeyFile);
            if (keyMetadata.size !== 32) throw new Error('database_migration_key_invalid');
            keyBytes = readPrivate(options.providerSecretsKeyFile);
            credentialBefore = credentialPreservationEvidence(options.sourceDatabase, keyBytes);
            apiKeysBefore = apiKeyPreservationEvidence(options.sourceDatabase, keyBytes);
            stableRowsBefore = stableRowReceipts(options.sourceDatabase, keyBytes, contract.releaseIdentitySha256,
                sourceEvidence.fingerprint.sha256);
            keyFd = openSync(options.providerSecretsKeyFile, constants.O_RDONLY | constants.O_NOFOLLOW);
            const capability = JSON.parse(readPrivate(options.secretCapabilityFile));
            if (capability?.schema !== 'nassaj-migration-secret-capability/v1'
                || capability.providerSecretsKeyFd !== 4 || capability.purpose !== 'release-database-migration'
                || capability.releaseIdentitySha256 !== contract.releaseIdentitySha256
                || capability.migrationEntrySha256 !== contract.migrationEntrySha256
                || (capability.databaseContractSha256 !== undefined
                    && capability.databaseContractSha256 !== sha(Buffer.from(JSON.stringify(contract)))
                    || capability.migrationClosureSha256 !== undefined
                    && capability.migrationClosureSha256 !== contract.migrationClosureSha256)
                || capability.databaseSha256 !== sourceEvidence.fingerprint.sha256
                || !Number.isSafeInteger(capability.expiresAt) || capability.expiresAt <= Date.now()
                || !/^[A-Za-z0-9_-]{8,128}$/.test(capability.nonce || '')) {
                throw new Error('database_migration_capability_invalid');
            }
            capabilityFd = openSync(options.secretCapabilityFile, constants.O_RDONLY | constants.O_NOFOLLOW);
            stdio.push(capabilityFd, keyFd); environment.NASSAJ_SECRET_CAPABILITY_FD = '3';
            environment.NASSAJ_MIGRATION_RELEASE_IDENTITY_SHA256 = contract.releaseIdentitySha256;
            environment.NASSAJ_MIGRATION_ENTRY_SHA256 = contract.migrationEntrySha256;
            environment.NASSAJ_MIGRATION_DATABASE_SHA256 = sourceEvidence.fingerprint.sha256;
            if (capability.databaseContractSha256) {
                environment.NASSAJ_MIGRATION_DATABASE_CONTRACT_SHA256 = capability.databaseContractSha256;
                environment.NASSAJ_MIGRATION_CLOSURE_SHA256 = contract.migrationClosureSha256;
            }
        } else if (options.providerSecretsKeyFile || options.secretCapabilityFile) throw new Error('database_migration_capability_incomplete');
        output = execFileSync('/usr/bin/unshare', ['--user', '--map-root-user', '--mount', '--net', '--fork', '--',
            isolationHelper, runtimeRoot, databaseDirectory, entryReal, database, nodeModulesRoot], {
            encoding: 'utf8', env: environment, stdio, timeout: 300_000 });
    } catch (error) {
        keyBytes?.fill(0);
        if (/database_credential_(?:authentication_failed|envelope_invalid)/.test(error?.message || '')) {
            throw new Error('legacy_admission_blocked:legacy-144-credential-auth-failed');
        }
        const stderr = String(error?.stderr || '');
        const reasonCode = /ERR_ACCESS_DENIED/.test(stderr) ? 'permission_denied'
            : /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/.test(stderr) ? 'module_not_found'
            : /provider_secrets_[a-z_]+/.exec(stderr)?.[0] || 'child_failed';
        options.testHooks?.captureRuntimeFailure?.(Object.freeze({ status: error?.status ?? null,
            signal: error?.signal ?? null, reasonCode }));
        throw new Error(`database_migration_runtime_failed:${reasonCode}`);
    }
    finally { if (keyFd !== null) closeSync(keyFd); if (capabilityFd !== null) closeSync(capabilityFd); }
    let observed;
    try { observed = JSON.parse(output.trim().split('\n').at(-1)); } catch { throw new Error('database_migration_runtime_result_invalid'); }
    options.testHooks?.afterRuntimeBeforeVerification?.(Object.freeze({ database }));
    const targetProbe = probeDatabaseMigrationState(database);
    const beforePreservation = sourceProbe.stateProbe.preservation;
    const afterPreservation = targetProbe.stateProbe.preservation;
    const preserved = ['users', 'projects', 'sessions', 'credentials', 'credentialIdentityDigest']
        .every((key) => beforePreservation[key] === afterPreservation[key]);
    const sourceMarkers = new Set(beforePreservation.markers);
    const markersPreserved = beforePreservation.markers.every((marker) => afterPreservation.markers.includes(marker))
        && afterPreservation.markers.every((marker) => sourceMarkers.has(marker)
            || PRESERVATION_POLICY.markerAllowlist.includes(marker));
    const expectedCredentialState = beforePreservation.credentialState === 'clean' ? 'clean' : 'already-encrypted';
    if (observed?.schema !== 'nassaj-migration-only-result/v1' || observed.integrity !== 'ok'
        || observed.foreignKeyViolations !== 0 || observed.targetSchemaDigest !== contract.targetSchemaDigest) {
        throw new Error('database_rehearsal_contract_mismatch');
    }
    let credentialsPreserved; let stableRowsPreserved; let apiKeysPreserved;
    try {
        const credentialAfter = credentialBefore === null ? [] : credentialPreservationEvidence(database, keyBytes);
        credentialsPreserved = verifyCredentialPreservation(credentialBefore, credentialAfter);
        const stableRowsAfter = stableRowReceipts(database, keyBytes, contract.releaseIdentitySha256,
            sourceEvidence.fingerprint.sha256);
        stableRowsPreserved = verifyStableRowReceipts(stableRowsBefore, stableRowsAfter);
        try { apiKeysPreserved = verifyApiKeyPreservation(apiKeysBefore, apiKeyPreservationEvidence(database, keyBytes)); }
        catch { apiKeysPreserved = false; }
    } finally { keyBytes?.fill(0); }
    const preservationChecks = Object.freeze({ schema: targetProbe.schemaDigest === contract.targetSchemaDigest,
        compatibility: targetProbe.compatibilityShapeDigest === contract.targetCompatibilityShapeDigest,
        migrationState: contract.targetMigrationStateDigests.includes(targetProbe.migrationStateDigest),
        credentialState: targetProbe.migrationState.credentialState === expectedCredentialState,
        stableCounts: preserved, stableRows: stableRowsPreserved.passed, markers: markersPreserved,
        credentials: credentialsPreserved, apiKeys: apiKeysPreserved });
    if (Object.values(preservationChecks).includes(false)) {
        options.testHooks?.capturePreservationFailure?.(preservationChecks);
        const failures = Object.entries(preservationChecks).filter(([, passed]) => !passed).map(([name]) => name);
        if (!stableRowsPreserved.passed) failures.push(`tables(${stableRowsPreserved.mismatches.join('+')})`);
        throw new Error(`database_rehearsal_preservation_mismatch:${failures.join(',')}`);
    }
    return Object.freeze({ state: 'rehearsed', migrationEntrySha256: contract.migrationEntrySha256,
        targetSchemaDigest: observed.targetSchemaDigest, isolation: 'node-permissions+user-network-namespace+migration-only-entry',
        rehearsal: fingerprintDatabase(database), preservation: Object.freeze({ before: beforePreservation, after: afterPreservation }) });
}
