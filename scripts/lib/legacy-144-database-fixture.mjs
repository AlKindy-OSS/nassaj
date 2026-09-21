import { createCipheriv, createHash } from 'node:crypto';
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { canonicalDatabaseSchemaDigest } from '../../server/modules/database/canonical-schema-digest.js';

const CREDENTIAL_STATES = Object.freeze(['clean', 'plaintext-credential', 'already-encrypted', 'partial-markers']);
const MARKER_STATES = Object.freeze(['absent', 'partial', 'complete']);
const DATA_STATES = Object.freeze(['complete', 'missing-participant']);
export const LEGACY_144_SCENARIOS = Object.freeze(CREDENTIAL_STATES.flatMap((credentialState) => MARKER_STATES
    .flatMap((markerState) => DATA_STATES.map((dataState) => `${credentialState}__${markerState}__${dataState}`))));
const LEGACY_SCENARIO_ALIASES = Object.freeze({ clean: 'clean__complete__complete',
    'plaintext-credential': 'plaintext-credential__complete__complete',
    'already-encrypted': 'already-encrypted__complete__complete',
    'partial-markers': 'partial-markers__partial__complete' });
export const LEGACY_144_BLOCKED_DECISIONS = Object.freeze([
    { scenario: 'malformed', decision: 'blocked', ruleId: 'legacy-144-malformed-probe' },
    { scenario: 'auth_failed', decision: 'blocked', ruleId: 'legacy-144-credential-auth-failed' },
    { scenario: 'key_unavailable', decision: 'blocked', ruleId: 'legacy-144-credential-key-unavailable' },
    { scenario: 'inconsistent', decision: 'blocked', ruleId: 'legacy-144-integrity-or-fk-inconsistent' },
    { scenario: 'unknown', decision: 'blocked', ruleId: 'legacy-144-state-unknown' },
    { scenario: 'unsupported', decision: 'blocked', ruleId: 'legacy-144-state-unsupported' },
]);
const FIXTURE_KEY = Buffer.from('4c2ebf16d6b734b92d0203ba772b35f768f0bfa22119e74f3435f74ab9d09f51', 'hex');
const FIXTURE_IV = Buffer.from('00112233445566778899aabb', 'hex');
const LEGACY_TAG = 'v1.44.0.0';
const LEGACY_PEELED_COMMIT = '3b9d2333aff1b87b889e8e237a6f74ebec5a53a7';
const LEGACY_SCHEMA_SOURCE_SHA256 = 'b8d2929cacf9ccc34aaf576f0e43770518f40da539909255b7e5b451c685fa70';
const LEGACY_MIGRATIONS_SOURCE_SHA256 = '6a247f2f0b711e9cbe7fb85c09792e167f37f3076a18de23b4275a6bdcfd0b59';
const LEGACY_INITIALIZER_SOURCE_SHA256 = 'f484755b554be7ba04fb96469b5f6f52a1466ed7174bde09fae948bdad99cff3';
const LEGACY_LIVE_SCHEMA_SHA256 = 'e82914ec2dbe2173c5e82f9244d55df5fd36b2054b5ba2d8e255576b0b61dc2e';

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
function encryptedFixtureCredential(value, { id, userId, credentialType }) {
    const cipher = createCipheriv('aes-256-gcm', FIXTURE_KEY, FIXTURE_IV);
    cipher.setAAD(Buffer.from(`nassaj:user_credentials:v1:${id}:${userId}:${credentialType}`));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `dbcred:v1:${FIXTURE_IV.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}
function schemaDigest(file) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
        return canonicalDatabaseSchemaDigest(db);
    } finally { db.close(); }
}
function tableExists(db, name) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
}
function credentialState(rows) {
    if (!rows.length) return 'clean';
    const encrypted = rows.filter((row) => /^dbcred:v1:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/.test(row.value)).length;
    if (encrypted === 0) return 'plaintext-credential';
    if (encrypted === rows.length) return 'already-encrypted';
    return 'partial-markers';
}
function stateProbe(db) {
    const credentials = db.prepare('SELECT id, user_id AS userId, credential_type AS credentialType, credential_value AS value FROM user_credentials ORDER BY id').all();
    const markers = db.prepare("SELECT key FROM app_config WHERE key LIKE '%migration%' OR key LIKE '%backfill%' OR key LIKE '%repair%' OR key LIKE '%encrypt%' ORDER BY key")
        .all().map((row) => row.key);
    const objects = db.prepare("SELECT type,name FROM sqlite_schema WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type,name")
        .all().map(({ type, name }) => ({ type, name }));
    const tables = objects.filter(({ type }) => type === 'table').map(({ name }) => name);
    const columns = Object.fromEntries(tables.map((table) => [table,
        db.prepare(`PRAGMA table_xinfo(${JSON.stringify(table)})`).all().map((column) => ({ name: column.name,
            type: String(column.type || '').toUpperCase(), notNull: column.notnull === 1, defaultValue: column.dflt_value,
            primaryKeyPosition: column.pk, hidden: column.hidden }))]));
    const foreignKeys = Object.fromEntries(tables.map((table) => [table,
        db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(table)})`).all().map((item) => ({ id: item.id, sequence: item.seq,
            table: item.table, from: item.from, to: item.to, onUpdate: item.on_update, onDelete: item.on_delete,
            match: item.match })).sort((a, b) => a.id - b.id || a.sequence - b.sequence)]));
    const indexes = [];
    for (const table of tables) {
        for (const row of db.prepare(`PRAGMA index_list(${JSON.stringify(table)})`).all()) {
            if (!row.name.startsWith('sqlite_')) indexes.push({ name: row.name, tableName: table,
                unique: row.unique === 1, partial: row.partial === 1,
                columns: db.prepare(`PRAGMA index_xinfo(${JSON.stringify(row.name)})`).all().map((column) => ({ sequence: column.seqno,
                    columnId: column.cid, name: column.name, descending: column.desc === 1, collation: column.coll,
                    key: column.key === 1 })) });
        }
    }
    indexes.sort((left, right) => String(left.name).localeCompare(String(right.name)));
    const structuralConditions = {
        legacySessionNames: tableExists(db, 'session_names'), legacyWorkspacePaths: tableExists(db, 'workspace_original_paths'),
        apiKeysPlaintextShape: columns.api_keys?.some((column) => column.name === 'api_key') === true,
        apiKeysDigestShape: columns.api_keys?.some((column) => column.name === 'key_digest') === true,
    };
    const dynamicConditions = {
        sessionsWithoutProject: tableExists(db, 'sessions')
            ? db.prepare('SELECT EXISTS(SELECT 1 FROM sessions WHERE project_path IS NULL) AS value').get().value === 1 : false,
        sessionsWithoutParticipant: tableExists(db, 'sessions') && tableExists(db, 'session_participants')
            ? db.prepare('SELECT EXISTS(SELECT 1 FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM session_participants p WHERE p.session_id=s.session_id)) AS value').get().value === 1 : false,
        projectsWithoutCreator: tableExists(db, 'projects') && columns.projects?.some((column) => column.name === 'created_by')
            ? db.prepare('SELECT EXISTS(SELECT 1 FROM projects WHERE created_by IS NULL) AS value').get().value === 1 : false,
    };
    const scenario = credentialState(credentials);
    const markerState = markers.includes('participants_ownership_repaired_at') ? 'complete'
        : markers.includes('participants_backfill_completed_at') ? 'partial' : 'absent';
    const dataState = Object.entries(dynamicConditions).filter(([, active]) => active).map(([name]) => name).sort();
    const migrationState = { schema: 'nassaj-database-migration-state/v1', credentialState: scenario,
        markerState, dataState, overall: scenario === 'plaintext-credential' || scenario === 'partial-markers'
            || markerState !== 'complete' || dataState.length ? 'migration-required' : 'compatible' };
    const migrationStateDigest = sha(Buffer.from(canonical(migrationState)));
    const compatibility = { schema: 'nassaj-database-migration-compatibility-shape/v2', objects, columns, foreignKeys, indexes,
        structuralConditions };
    const preservation = {
            users: db.prepare('SELECT count(*) AS count FROM users').get().count,
            projects: tableExists(db, 'projects') ? db.prepare('SELECT count(*) AS count FROM projects').get().count : 0,
            sessions: tableExists(db, 'sessions') ? db.prepare('SELECT count(*) AS count FROM sessions').get().count : 0,
            credentials: credentials.length,
            credentialIdentityDigest: sha(Buffer.from(canonical(credentials.map(({ id, userId, credentialType }) => [id, userId, credentialType])))),
            credentialState: scenario, markers, dynamicConditions,
        };
    const probe = { schema: 'nassaj-database-migration-state-probe/v4', compatibility, migrationState, preservation,
        verification: { integrity: db.pragma('integrity_check', { simple: true }),
            foreignKeyViolations: db.pragma('foreign_key_check').length } };
    return { scenario, probe, compatibilityShapeDigest: sha(Buffer.from(canonical(compatibility))), migrationStateDigest };
}

function initializedSchemaFromTag() {
    const peeled = execFileSync('git', ['rev-parse', `${LEGACY_TAG}^{}`], { encoding: 'utf8' }).trim();
    if (peeled !== LEGACY_PEELED_COMMIT) throw new Error('legacy_144_tag_identity_mismatch');
    const source = execFileSync('git', ['show', `${LEGACY_TAG}:server/modules/database/schema.ts`], { encoding: 'utf8' });
    if (sha(Buffer.from(source)) !== LEGACY_SCHEMA_SOURCE_SHA256) throw new Error('legacy_144_schema_source_mismatch');
    const migrations = execFileSync('git', ['show', `${LEGACY_TAG}:server/modules/database/migrations.ts`], { encoding: 'utf8' });
    const initializer = execFileSync('git', ['show', `${LEGACY_TAG}:server/modules/database/init-db.ts`], { encoding: 'utf8' });
    const liveSchema = execFileSync('git', ['show', `${LEGACY_TAG}:server/modules/database/__fixtures__/live-schema.sql`], { encoding: 'utf8' });
    if (sha(Buffer.from(migrations)) !== LEGACY_MIGRATIONS_SOURCE_SHA256
        || sha(Buffer.from(initializer)) !== LEGACY_INITIALIZER_SOURCE_SHA256
        || sha(Buffer.from(liveSchema)) !== LEGACY_LIVE_SCHEMA_SHA256) throw new Error('legacy_144_boot_source_mismatch');
    const schemaPosition = initializer.indexOf('db.exec(INIT_SCHEMA_SQL)');
    const migrationsPosition = initializer.indexOf('runMigrations(db)');
    if (schemaPosition < 0 || migrationsPosition <= schemaPosition || !/export const runMigrations\s*=/.test(migrations)
        || (liveSchema.match(/^CREATE (?:TABLE|INDEX|VIEW|TRIGGER)/gm) || []).length !== 55) {
        throw new Error('legacy_144_initializer_fidelity_invalid');
    }
    return liveSchema;
}

/** Generate a byte-stable sanitized database from the exact schema declarations in tag v1.44.0.0. */
export function createLegacy144DatabaseFixture({ outputFile, scenario }) {
    const expandedScenario = LEGACY_SCENARIO_ALIASES[scenario] || scenario;
    if (!path.isAbsolute(outputFile) || !LEGACY_144_SCENARIOS.includes(expandedScenario)) throw new Error('legacy_144_fixture_options_invalid');
    const [credentialScenario, markerScenario, dataScenario] = expandedScenario.split('__');
    const db = new Database(outputFile);
    try {
        db.pragma('page_size = 4096'); db.pragma('journal_mode = DELETE');
        db.exec(initializedSchemaFromTag());
        const initializedObjects = db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get().count;
        if (initializedObjects !== 56) throw new Error('legacy_144_initialized_schema_object_count_mismatch');
        db.prepare('INSERT INTO users(id,username,password_hash,created_at,role,status) VALUES(?,?,?,?,?,?)')
            .run(1, 'fixture-owner', '$2b$12$sanitized.fixture.hash', '2026-01-01 00:00:00', 'owner', 'active');
        db.prepare('INSERT INTO projects(project_id,project_path,custom_project_name,visibility,created_by) VALUES(?,?,?,?,?)')
            .run('fixture-project', '/srv/fixture/project', 'Sanitized fixture', 'private', 1);
        db.prepare('INSERT INTO sessions(session_id,provider,custom_name,project_path,jsonl_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
            .run('fixture-session', 'codex', 'Sanitized fixture', '/srv/fixture/project', '/srv/fixture/session.jsonl',
                '2026-01-01 00:00:00', '2026-01-01 00:00:00');
        if (dataScenario !== 'missing-participant') db.prepare('INSERT INTO session_participants(session_id,user_id,role,first_seen,last_seen,message_count) VALUES(?,?,?,?,?,?)')
            .run('fixture-session', 1, 'owner', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 1);
        db.prepare('INSERT INTO project_members(project_id,user_id,role,added_by,created_at) VALUES(?,?,?,?,?)')
            .run('fixture-project', 1, 'owner', 1, '2026-01-01 00:00:00');
        db.prepare('INSERT INTO api_keys(id,user_id,key_name,api_key,created_at,is_active) VALUES(?,?,?,?,?,1)')
            .run(1, 1, 'sanitized-fixture-key', `ck_${'ab'.repeat(32)}`, '2026-01-01 00:00:00');
        const insert = db.prepare(`INSERT INTO user_credentials
          (id,user_id,credential_name,credential_type,credential_value,description,created_at,is_active)
          VALUES(?,?,?,?,?,?,?,1)`);
        const aad = { id: 1, userId: 1, credentialType: 'github_token' };
        if (credentialScenario === 'plaintext-credential' || credentialScenario === 'partial-markers') {
            insert.run(1, 1, 'sanitized-plaintext', aad.credentialType, 'fixture-token-plaintext', null, '2026-01-01 00:00:00');
        }
        if (credentialScenario === 'already-encrypted') {
            insert.run(1, 1, 'sanitized-encrypted', aad.credentialType,
                encryptedFixtureCredential('fixture-token-encrypted', aad), null, '2026-01-01 00:00:00');
        }
        if (credentialScenario === 'partial-markers') {
            const second = { id: 2, userId: 1, credentialType: 'gitlab_token' };
            insert.run(2, 1, 'sanitized-encrypted', second.credentialType,
                encryptedFixtureCredential('fixture-token-encrypted', second), null, '2026-01-01 00:00:00');
        }
        const marker = db.prepare('INSERT INTO app_config(key,value,created_at) VALUES(?,?,?)');
        if (markerScenario === 'partial' || markerScenario === 'complete') {
            marker.run('participants_backfill_completed_at', '2026-01-01 00:00:00', '2026-01-01 00:00:00');
        }
        if (markerScenario === 'complete') {
            marker.run('participants_ownership_repaired_at', '2026-01-01 00:00:00', '2026-01-01 00:00:00');
        }
        db.exec('VACUUM');
        const predecessorSchemaDigest = schemaDigest(outputFile); const state = stateProbe(db);
        if (state.scenario !== credentialScenario || state.probe.migrationState.markerState !== markerScenario
            || (dataScenario === 'missing-participant') !== state.probe.migrationState.dataState.includes('sessionsWithoutParticipant')) {
            throw new Error('legacy_144_fixture_scenario_mismatch');
        }
        return Object.freeze({ schema: 'nassaj-legacy-144-fixture/v1', scenario, predecessorSchemaDigest,
            compatibilityShapeDigest: state.compatibilityShapeDigest, migrationStateDigest: state.migrationStateDigest,
            stateProbe: Object.freeze(state.probe),
            databaseSha256: sha(readFileSync(outputFile)) });
    } finally { db.close(); }
}

/** Probe any candidate predecessor with the same broad migration-condition measurement used by fixtures. */
export function probeLegacy144Predecessor(file) {
    if (!path.isAbsolute(file)) throw new Error('legacy_144_probe_path_invalid');
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
        const state = stateProbe(db);
        return Object.freeze({ schemaDigest: schemaDigest(file), compatibilityShapeDigest: state.compatibilityShapeDigest,
            migrationState: state.probe.migrationState, migrationStateDigest: state.migrationStateDigest,
            stateProbe: Object.freeze(state.probe) });
    } finally { db.close(); }
}

/** Canonical shared probe for predecessor admission and post-migration verification. */
export const probeDatabaseMigrationState = probeLegacy144Predecessor;

/** Run the exact compiled migration entry over a fixture clone and capture its declared target digest. */
export function measureLegacy144FixtureTarget({ sourceDatabase, migratedDatabase, migrationEntry, capabilityBinding = null }) {
    if (![sourceDatabase, migratedDatabase, migrationEntry].every(path.isAbsolute)) throw new Error('legacy_144_measurement_paths_invalid');
    copyFileSync(sourceDatabase, migratedDatabase); const keyFile = `${migratedDatabase}.fixture-key`;
    const capabilityFile = `${migratedDatabase}.fixture-capability`;
    const releaseIdentitySha256 = sha(Buffer.from('nassaj-legacy-144-fixture-release'));
    const migrationEntrySha256 = sha(readFileSync(migrationEntry));
    const databaseSha256 = sha(readFileSync(migratedDatabase));
    const bound = capabilityBinding && /^[a-f0-9]{64}$/.test(capabilityBinding.databaseContractSha256 || '')
        && /^[a-f0-9]{64}$/.test(capabilityBinding.migrationClosureSha256 || '') ? capabilityBinding : null;
    writeFileSync(keyFile, FIXTURE_KEY, { flag: 'wx', mode: 0o600 });
    writeFileSync(capabilityFile, `${JSON.stringify({ schema: 'nassaj-migration-secret-capability/v1',
        purpose: 'release-database-migration', providerSecretsKeyFd: 4, releaseIdentitySha256,
        migrationEntrySha256, ...(bound || {}), databaseSha256,
        expiresAt: Date.now() + 300_000, nonce: 'fixture_nonce_v1' })}\n`,
    { flag: 'wx', mode: 0o600 });
    const capabilityFd = openSync(capabilityFile, 'r'); const keyFd = openSync(keyFile, 'r');
    let output;
    try {
        output = execFileSync(process.execPath, [migrationEntry, '--database', migratedDatabase], { encoding: 'utf8',
            env: { PATH: process.env.PATH, HOME: path.dirname(migratedDatabase), LC_ALL: 'C', NODE_ENV: 'production',
                NASSAJ_MIGRATION_ONLY: '1', NASSAJ_SECRET_CAPABILITY_FD: '3',
                NASSAJ_MIGRATION_RELEASE_IDENTITY_SHA256: releaseIdentitySha256,
                NASSAJ_MIGRATION_ENTRY_SHA256: migrationEntrySha256,
                ...(bound ? { NASSAJ_MIGRATION_DATABASE_CONTRACT_SHA256: bound.databaseContractSha256,
                    NASSAJ_MIGRATION_CLOSURE_SHA256: bound.migrationClosureSha256 } : {}),
                NASSAJ_MIGRATION_DATABASE_SHA256: databaseSha256 }, stdio: ['ignore', 'pipe', 'pipe', capabilityFd, keyFd] });
    } finally {
        closeSync(capabilityFd); closeSync(keyFd);
        rmSync(keyFile, { force: true }); rmSync(capabilityFile, { force: true });
    }
    let result;
    try { result = JSON.parse(output.trim().split('\n').at(-1)); } catch { throw new Error('legacy_144_migration_result_invalid'); }
    if (result?.schema !== 'nassaj-migration-only-result/v1' || !/^[a-f0-9]{64}$/.test(result.targetSchemaDigest || '')) {
        throw new Error('legacy_144_migration_result_invalid');
    }
    return Object.freeze({ schema: 'nassaj-legacy-144-target-measurement/v1', targetSchemaDigest: result.targetSchemaDigest,
        integrity: result.integrity, foreignKeyViolations: result.foreignKeyViolations,
        migratedDatabaseSha256: sha(readFileSync(migratedDatabase)) });
}

/** Generate the complete accepted-predecessor set against one exact compiled migration entry. */
export function generateLegacy144AcceptedPredecessors({ workspaceDirectory, migrationEntry }) {
    if (!path.isAbsolute(workspaceDirectory) || !path.isAbsolute(migrationEntry)) {
        throw new Error('legacy_144_generator_paths_invalid');
    }
    mkdirSync(workspaceDirectory, { recursive: true, mode: 0o700 });
    const acceptedPredecessors = []; const decisions = []; let targetSchemaDigest = null;
    for (const scenario of LEGACY_144_SCENARIOS) {
        const sourceDatabase = path.join(workspaceDirectory, `${scenario}.sqlite`);
        const migratedDatabase = path.join(workspaceDirectory, `${scenario}.migrated.sqlite`);
        const fixture = createLegacy144DatabaseFixture({ outputFile: sourceDatabase, scenario });
        const measured = measureLegacy144FixtureTarget({ sourceDatabase, migratedDatabase, migrationEntry });
        if (measured.integrity !== 'ok' || measured.foreignKeyViolations !== 0) {
            throw new Error('legacy_144_migration_integrity_failed');
        }
        if (targetSchemaDigest !== null && targetSchemaDigest !== measured.targetSchemaDigest) {
            throw new Error('legacy_144_target_schema_diverged');
        }
        targetSchemaDigest = measured.targetSchemaDigest;
        const target = probeLegacy144Predecessor(migratedDatabase);
        acceptedPredecessors.push(Object.freeze({ scenario, schemaDigest: fixture.predecessorSchemaDigest,
            compatibilityShapeDigest: fixture.compatibilityShapeDigest, migrationStateDigest: fixture.migrationStateDigest,
            targetCompatibilityShapeDigest: target.compatibilityShapeDigest, targetMigrationStateDigest: target.migrationStateDigest,
            preservation: Object.freeze({ before: fixture.stateProbe.preservation, after: target.stateProbe.preservation }) }));
        decisions.push(Object.freeze({ scenario, decision: 'accepted', ruleId: 'legacy-144-supported-state-v1',
            migrationStateDigest: fixture.migrationStateDigest }));
    }
    return Object.freeze({ schema: 'nassaj-legacy-144-accepted-predecessors/v1',
        acceptedPredecessors: Object.freeze(acceptedPredecessors),
        decisions: Object.freeze([...decisions, ...LEGACY_144_BLOCKED_DECISIONS]), targetSchemaDigest });
}
