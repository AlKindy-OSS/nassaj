import { execFileSync } from 'node:child_process';
import { createDecipheriv, createHash, createHmac } from 'node:crypto';

const STABLE_QUERIES = Object.freeze({
    users: `SELECT id,username,password_hash AS passwordHash,created_at AS createdAt,last_login AS lastLogin,
      is_active AS isActive,git_name AS gitName,git_email AS gitEmail,has_completed_onboarding AS hasCompletedOnboarding,
      role,status,invited_by AS invitedBy,must_change_password AS mustChangePassword,avatar_url AS avatarUrl FROM users ORDER BY id`,
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
const TABLE_NAMES = Object.freeze({ credentials: 'user_credentials', apiKeys: 'api_keys',
    projectMembers: 'project_members', participants: 'session_participants' });

function query(file, sql, injected) {
    if (injected?.query) return injected.query(file, sql);
    const output = execFileSync('/usr/bin/sqlite3', ['-json', file, sql], { encoding: 'utf8', timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C' } });
    return JSON.parse(output || '[]');
}
function exists(file, table, injected) {
    return query(file, `SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='${table}'`, injected).length > 0;
}
function canonical(value) {
    if (Buffer.isBuffer(value)) return JSON.stringify({ $buffer: value.toString('base64') });
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
function decryptCredential(value, row, key) {
    if (!String(value).startsWith('dbcred:v1:')) return Buffer.from(String(value));
    const match = /^dbcred:v1:([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]+={0,2}):([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match) throw new Error('database_credential_envelope_invalid');
    const [iv, tag, ciphertext] = match.slice(1).map((part) => Buffer.from(part, 'base64'));
    try { const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(`nassaj:user_credentials:v1:${row.id}:${row.userId}:${row.credentialType}`));
        decipher.setAuthTag(tag); return Buffer.concat([decipher.update(ciphertext), decipher.final()]); }
    catch { throw new Error('database_credential_authentication_failed'); }
}

/** Capture secret-free HMAC receipts for every semantically preserved row. */
export function captureDatabasePreservation(file, providerKey, releaseIdentity, sourceDatabaseSha256, injected = {}) {
    if (!Buffer.isBuffer(providerKey) || providerKey.length !== 32 || !/^[a-f0-9]{64}$/.test(releaseIdentity || '')
        || !/^[a-f0-9]{64}$/.test(sourceDatabaseSha256 || '')) throw new Error('database_preservation_identity_invalid');
    const receiptKey = createHmac('sha256', providerKey).update('nassaj-database-preservation-receipt/v1\0')
        .update(releaseIdentity).update('\0').update(sourceDatabaseSha256).digest();
    try {
        const stableRows = Object.fromEntries(Object.entries(STABLE_QUERIES).map(([name, sql]) => {
            const table = TABLE_NAMES[name] || name; const rows = exists(file, table, injected) ? query(file, sql, injected) : [];
            return [name, rows.map((row) => createHmac('sha256', receiptKey).update(name).update('\0').update(canonical(row)).digest('hex'))];
        }));
        const credentials = !exists(file, 'user_credentials', injected) ? []
            : query(file, `SELECT id,user_id AS userId,credential_type AS credentialType,credential_value AS value
              FROM user_credentials ORDER BY id`, injected).map((row) => { const encrypted = String(row.value).startsWith('dbcred:v1:');
                const plaintext = decryptCredential(row.value, row, providerKey);
                try { return { id: row.id, userId: row.userId, credentialType: row.credentialType, encrypted,
                    semanticHmac: createHmac('sha256', providerKey).update('nassaj-credential-preservation/v1\0')
                        .update(String(row.id)).update('\0').update(String(row.userId)).update('\0')
                        .update(row.credentialType).update('\0').update(plaintext).digest('hex'),
                    envelopeSha256: encrypted ? createHash('sha256').update(String(row.value)).digest('hex') : null }; }
                finally { plaintext.fill(0); } });
        let apiKeys = { shape: 'absent', records: [] };
        if (exists(file, 'api_keys', injected)) {
            const columns = query(file, 'PRAGMA table_info(api_keys)', injected).map((column) => column.name);
            const plaintext = columns.includes('api_key'); const digested = columns.includes('key_digest') && columns.includes('key_prefix');
            if (plaintext === digested) throw new Error('database_api_key_shape_invalid');
            const rows = query(file, plaintext ? 'SELECT id,api_key AS secret FROM api_keys ORDER BY id'
                : 'SELECT id,key_digest AS digest,key_prefix AS prefix FROM api_keys ORDER BY id', injected);
            apiKeys = { shape: plaintext ? 'plaintext' : 'digested', records: rows.map((row) => {
                if (plaintext) {
                    if (!/^ck_[0-9a-f]{64}$/.test(row.secret || '')) throw new Error('database_api_key_plaintext_invalid');
                    return { id: row.id, expectedDigest: `sha256:${createHash('sha256').update(row.secret).digest('hex')}`,
                        expectedPrefix: row.secret.slice(0, 10) };
                }
                if (!/^sha256:[0-9a-f]{64}$/.test(row.digest || '') || !/^ck_[0-9a-f]{7}$/.test(row.prefix || '')) {
                    throw new Error('database_api_key_digest_invalid');
                }
                return { id: row.id, digest: row.digest, prefix: row.prefix };
            }) };
        }
        return Object.freeze({ schema: 'nassaj-database-preservation-receipt/v1', stableRows, credentials, apiKeys });
    } finally { receiptKey.fill(0); }
}

/** Compare pre/post receipts; plaintext API keys must become their exact SHA-256 digest and prefix. */
export function verifyDatabasePreservation(before, after) {
    const mismatches = [];
    for (const table of ['users', 'projects', 'sessions', 'credentials', 'apiKeys', 'projectMembers']) {
        if (JSON.stringify(before?.stableRows?.[table]) !== JSON.stringify(after?.stableRows?.[table])) mismatches.push(table);
    }
    const participants = new Set(after?.stableRows?.participants || []);
    if (!(before?.stableRows?.participants || []).every((receipt) => participants.has(receipt))) mismatches.push('participants');
    const credentials = before?.credentials?.length === after?.credentials?.length && before.credentials.every((row, index) => {
        const target = after.credentials[index]; return row.id === target.id && row.userId === target.userId
            && row.credentialType === target.credentialType && row.semanticHmac === target.semanticHmac && target.encrypted === true
            && (!row.encrypted || row.envelopeSha256 === target.envelopeSha256);
    });
    if (!credentials) mismatches.push('credentialSecrets');
    const apiKeys = before?.apiKeys?.shape === 'absent' ? after?.apiKeys?.shape === 'absent'
        : before?.apiKeys?.shape === 'plaintext' && after?.apiKeys?.shape === 'digested'
            && before.apiKeys.records.length === after.apiKeys.records.length
            && before.apiKeys.records.every((row, index) => row.id === after.apiKeys.records[index].id
                && row.expectedDigest === after.apiKeys.records[index].digest && row.expectedPrefix === after.apiKeys.records[index].prefix);
    if (!apiKeys) mismatches.push('apiKeySecrets');
    return Object.freeze({ passed: mismatches.length === 0, mismatches: Object.freeze(mismatches) });
}
