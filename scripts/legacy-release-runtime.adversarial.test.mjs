import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
    createVerifiedSqliteBackup, databaseSchemaDigest, DATABASE_PRESERVATION_POLICY_SHA256,
    validateDatabaseReleaseContract,
} from './lib/release-database-contract.mjs';
import { collectMigrationClosure } from './lib/release-database-migration-closure.mjs';
import { createLegacy144DatabaseFixture, LEGACY_144_SCENARIOS, probeLegacy144Predecessor } from './lib/legacy-144-database-fixture.mjs';
import { prepareLegacyMigration } from './prepare-legacy-release-runtime.mjs';

const TEMP = process.env.NASSAJ_TEST_TMP || process.env.TMPDIR || '/var/tmp';
const RELEASE_IDENTITY = 'a'.repeat(64);

function databaseContract(overrides = {}) {
    return {
        schema: 'nassaj-database-release-contract/v1',
        releaseIdentitySha256: RELEASE_IDENTITY,
        migrationEntrySha256: 'b'.repeat(64),
        migrationClosureSha256: 'c'.repeat(64),
        migrationClosure: { schema: 'nassaj-database-migration-closure/v2', sha256: 'c'.repeat(64), assetManifestBound: true },
        acceptedPredecessors: [{ schemaDigest: 'd'.repeat(64), compatibilityShapeDigest: 'e'.repeat(64),
            allowedMigrationStateDigests: ['2'.repeat(64)] }],
        targetCompatibilityShapeDigest: 'f'.repeat(64),
        targetMigrationStateDigests: ['1'.repeat(64)],
        preservationPolicySha256: DATABASE_PRESERVATION_POLICY_SHA256,
        schemaVersion: 12,
        minimumReadableSchemaVersion: 11,
        previousReleasePolicy: 'restore_required',
        rehearsalRequired: true,
        ...overrides,
    };
}

function git(root, ...args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function sqlite(file, sql) {
    return execFileSync('sqlite3', [file, sql], { encoding: 'utf8' }).trim();
}

function fixture(t, { killTimeout = 86_400_000 } = {}) {
    const root = mkdtempSync(path.join(TEMP, 'legacy-release-adversarial-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const legacyRoot = path.join(root, 'legacy');
    const deployRoot = path.join(root, 'deploy');
    mkdirSync(legacyRoot, { mode: 0o700 });
    mkdirSync(deployRoot, { mode: 0o700 });
    for (const name of ['control', 'control/legacy-snapshots']) {
        mkdirSync(path.join(deployRoot, name), { recursive: true, mode: 0o700 });
    }
    git(legacyRoot, 'init', '-q');
    git(legacyRoot, 'config', 'user.name', 'Legacy QA');
    git(legacyRoot, 'config', 'user.email', 'legacy-qa@example.invalid');
    writeFileSync(path.join(legacyRoot, 'package.json'), '{}\n', { mode: 0o600 });
    git(legacyRoot, 'add', 'package.json');
    git(legacyRoot, 'commit', '-qm', 'fixture');
    const legacyHead = git(legacyRoot, 'rev-parse', 'HEAD');
    chmodSync(path.join(legacyRoot, '.git'), 0o700);

    const databaseFile = path.join(root, 'nassaj.sqlite');
    sqlite(databaseFile, 'CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample(value) VALUES (\'kept\');');
    chmodSync(databaseFile, 0o600);
    const pm2SnapshotFile = path.join(root, 'pm2.json');
    writeFileSync(pm2SnapshotFile, JSON.stringify({
        schema: 'nassaj-pm2-snapshot/v1', name: 'nassaj-dev', pmExecPath: '/opt/nassaj/server/index.js', killTimeout,
    }), { mode: 0o600 });
    return { root, legacyRoot, deployRoot, legacyHead, databaseFile, pm2SnapshotFile };
}

function prepare(value) {
    return prepareLegacyMigration({
        legacyRoot: value.legacyRoot,
        deployRoot: value.deployRoot,
        legacyHead: value.legacyHead,
        releaseIdentitySha256: RELEASE_IDENTITY,
        nodeInstanceId: 'qa-node',
        pm2SnapshotFile: value.pm2SnapshotFile,
        databaseFile: value.databaseFile,
    });
}

test('raw Git preservation rejects alternates and lock files before copying bytes', (t) => {
    for (const relative of ['objects/info/alternates', 'index.lock']) {
        const value = fixture(t);
        const file = path.join(value.legacyRoot, '.git', relative);
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, relative.endsWith('alternates') ? '/outside/objects\n' : 'lock\n', { mode: 0o600 });
        assert.throws(() => prepare(value), /alternates|lock|git.*unsafe/i);
    }
});

test('an existing partial Git snapshot is never accepted as a resumable preservation', (t) => {
    const value = fixture(t);
    // The snapshot identity is intentionally opaque to this test. Crash at the first
    // checkpoint, discover the generated slot, then replace its Git copy with a partial tree.
    assert.throws(() => prepareLegacyMigration({
        legacyRoot: value.legacyRoot,
        deployRoot: value.deployRoot,
        legacyHead: value.legacyHead,
        releaseIdentitySha256: RELEASE_IDENTITY,
        nodeInstanceId: 'qa-node',
        pm2SnapshotFile: value.pm2SnapshotFile,
        databaseFile: value.databaseFile,
        testHooks: { afterCheckpoint(phase) { if (phase === 'git-preserved') throw new Error('simulated-kill'); } },
    }), /simulated-kill/);
    const snapshots = path.join(value.deployRoot, 'control', 'legacy-snapshots');
    const [slotName] = readdirSync(snapshots);
    const slot = path.join(snapshots, slotName);
    rmSync(path.join(slot, 'git'), { recursive: true, force: true });
    mkdirSync(path.join(slot, 'git'), { mode: 0o700 });
    writeFileSync(path.join(slot, 'git', 'HEAD'), 'ref: refs/heads/missing\n', { mode: 0o600 });
    assert.throws(() => prepare(value), /partial|inventory|git.*mismatch|fsck/i);
});

test('Git source mutation between copy and verification fails closed', (t) => {
    const value = fixture(t);
    assert.throws(() => prepareLegacyMigration({
        legacyRoot: value.legacyRoot,
        deployRoot: value.deployRoot,
        legacyHead: value.legacyHead,
        releaseIdentitySha256: RELEASE_IDENTITY,
        nodeInstanceId: 'qa-node',
        pm2SnapshotFile: value.pm2SnapshotFile,
        databaseFile: value.databaseFile,
        testHooks: {
            afterGitCopyBeforeRescan() {
                writeFileSync(path.join(value.legacyRoot, '.git', 'mutation-evidence'), 'changed\n', { mode: 0o600 });
            },
        },
    }), /git_source_changed/);
});

test('preserved Git must contain every caller-pinned required commit', (t) => {
    const value = fixture(t);
    assert.throws(() => prepareLegacyMigration({
        legacyRoot: value.legacyRoot,
        deployRoot: value.deployRoot,
        legacyHead: value.legacyHead,
        releaseIdentitySha256: RELEASE_IDENTITY,
        nodeInstanceId: 'qa-node',
        pm2SnapshotFile: value.pm2SnapshotFile,
        databaseFile: value.databaseFile,
        requiredCommits: ['f'.repeat(40)],
    }), /git_fsck_failed|required.*commit/i);
});

test('preserving extra host commits requires an exact reviewed commit map', (t) => {
    const value = fixture(t);
    const hostCommit = value.legacyHead;
    writeFileSync(path.join(value.legacyRoot, 'next.txt'), 'next\n', { mode: 0o600 });
    git(value.legacyRoot, 'add', 'next.txt');
    git(value.legacyRoot, 'commit', '-qm', 'next');
    const newHead = git(value.legacyRoot, 'rev-parse', 'HEAD');
    assert.throws(() => prepareLegacyMigration({
        legacyRoot: value.legacyRoot,
        deployRoot: value.deployRoot,
        legacyHead: newHead,
        releaseIdentitySha256: RELEASE_IDENTITY,
        nodeInstanceId: 'qa-node',
        pm2SnapshotFile: value.pm2SnapshotFile,
        databaseFile: value.databaseFile,
        requiredCommits: [hostCommit],
    }), /required_commits_(?:need_mapping|map_required)/);
});

test('legacy PM2 snapshot requires the reviewed one-day drain timeout', (t) => {
    const value = fixture(t, { killTimeout: 600_000 });
    assert.throws(() => prepare(value), /pm2.*invalid|kill.*timeout/i);
});

test('configuration evidence is private and failures never disclose its secret bytes', (t) => {
    const value = fixture(t);
    const config = path.join(value.root, 'nassaj.env');
    const secret = 'NASSAJ_PRIVATE_TEST_SECRET=do-not-print-this-value';
    writeFileSync(config, `${secret}\n`, { mode: 0o644 });
    let error;
    try {
        prepareLegacyMigration({
            legacyRoot: value.legacyRoot,
            deployRoot: value.deployRoot,
            legacyHead: value.legacyHead,
            releaseIdentitySha256: RELEASE_IDENTITY,
            nodeInstanceId: 'qa-node',
            pm2SnapshotFile: value.pm2SnapshotFile,
            databaseFile: value.databaseFile,
            configFiles: [config],
        });
    } catch (caught) { error = caught; }
    assert.ok(error, 'world-readable configuration must be rejected');
    assert.doesNotMatch(String(error?.stack || error), /do-not-print-this-value/);
});

test('database release contract pins the exact post-migration schema digest', () => {
    const contract = databaseContract();
    assert.throws(() => validateDatabaseReleaseContract({ databaseContract: contract }, RELEASE_IDENTITY), /contract_invalid/);
    const targetSchemaDigest = 'c'.repeat(64);
    const validated = validateDatabaseReleaseContract({ databaseContract: { ...contract, targetSchemaDigest } }, RELEASE_IDENTITY);
    assert.equal(validated.targetSchemaDigest, targetSchemaDigest);
    for (const acceptedPredecessors of [
        [...contract.acceptedPredecessors, ...contract.acceptedPredecessors],
        Array.from({ length: 9 }, (_, index) => ({
            schemaDigest: index.toString(16).padStart(64, '0'), stateProbeDigest: 'f'.repeat(64),
        })),
        [{ ...contract.acceptedPredecessors[0], extra: true }],
    ]) assert.throws(() => validateDatabaseReleaseContract({
        databaseContract: { ...contract, targetSchemaDigest, acceptedPredecessors },
    }, RELEASE_IDENTITY), /contract_invalid/);
});

test('migration entry and runtime probe share one canonical schema digest', (t) => {
    const value = fixture(t);
    const database = path.join(value.root, 'canonical-schema.sqlite');
    createLegacy144DatabaseFixture({ outputFile: database, scenario: 'clean' });
    chmodSync(database, 0o600);
    const rows = JSON.parse(execFileSync('sqlite3', ['-json', database,
        "SELECT type,name,tbl_name AS tableName,coalesce(sql,'') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name;"],
    { encoding: 'utf8' }) || '[]');
    const entryDigest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    assert.equal(databaseSchemaDigest(database), entryDigest);
});

test('verified SQLite backup includes committed WAL bytes and is owner-private', (t) => {
    const value = fixture(t);
    const live = new Database(value.databaseFile);
    t.after(() => live.close());
    live.pragma('journal_mode = WAL');
    live.exec("INSERT INTO sample(value) VALUES ('committed-in-wal')");
    const backupDirectory = path.join(value.root, 'verified-backups');
    mkdirSync(backupDirectory, { mode: 0o700 });
    const backup = path.join(backupDirectory, 'final.sqlite');
    const receipt = createVerifiedSqliteBackup(value.databaseFile, backup);
    assert.equal(receipt.integrityCheck, 'ok');
    assert.equal(receipt.foreignKeyViolations, 0);
    assert.equal(receipt.sourceWalIncluded, true);
    assert.equal(sqlite(backup, "SELECT count(*) FROM sample WHERE value='committed-in-wal';"), '1');
    assert.equal(statSync(backup).mode & 0o777, 0o600);
});

test('migration isolation permits only the private database directory', (t) => {
    const value = fixture(t);
    const runtime = path.join(value.root, 'runtime');
    const databaseDirectory = path.join(value.root, 'rehearsal');
    mkdirSync(runtime, { mode: 0o700 });
    mkdirSync(databaseDirectory, { mode: 0o700 });
    const database = path.join(databaseDirectory, 'database.sqlite');
    writeFileSync(database, '', { mode: 0o600 });
    const entry = path.join(runtime, 'migration.js');
    writeFileSync(entry, `
        import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
        let runtimeWriteDenied = false; let childDenied = false; let networkDenied = false;
        try { fs.writeFileSync(new URL('./tamper', import.meta.url), 'x'); } catch { runtimeWriteDenied = true; }
        try { spawnSync('/usr/bin/true'); } catch { childDenied = true; }
        try { await fetch('http://127.0.0.1:9', { signal: AbortSignal.timeout(500) }); } catch { networkDenied = true; }
        fs.writeFileSync(process.argv[process.argv.indexOf('--database') + 1], 'database-write-allowed');
        console.log(JSON.stringify({ runtimeWriteDenied, childDenied, networkDenied }));
    `, { mode: 0o600 });
    const helper = path.resolve('scripts/run-release-database-rehearsal.sh');
    const result = execFileSync('/usr/bin/unshare', [
        '--user', '--map-root-user', '--mount', '--net', '--fork', '--', helper,
        runtime, databaseDirectory, entry, database,
    ], { encoding: 'utf8', env: { HOME: databaseDirectory, LC_ALL: 'C', NODE_ENV: 'production', NASSAJ_MIGRATION_ONLY: '1' } });
    const observed = JSON.parse(result.trim().split('\n').at(-1));
    assert.deepEqual(observed, { runtimeWriteDenied: true, childDenied: true, networkDenied: true });
    assert.equal(readFileSync(database, 'utf8'), 'database-write-allowed');
});

test('migration closure includes literal CommonJS edges and rejects computed loading', (t) => {
    const value = fixture(t);
    const runtime = path.join(value.root, 'closure-runtime');
    mkdirSync(runtime, { mode: 0o700 });
    writeFileSync(path.join(value.root, 'package-lock.json'), readFileSync(path.resolve('package-lock.json')), { mode: 0o600 });
    writeFileSync(path.join(runtime, 'entry.cjs'), "require('./hidden.cjs');\n", { mode: 0o600 });
    writeFileSync(path.join(runtime, 'hidden.cjs'), 'module.exports = 1;\n', { mode: 0o600 });
    const measured = collectMigrationClosure(runtime, 'entry.cjs');
    assert.deepEqual(measured.files.map((file) => file.assetPath), ['dist-server/entry.cjs', 'dist-server/hidden.cjs']);
    writeFileSync(path.join(runtime, 'computed.js'), "const target = './hidden.cjs'; await import(target);\n", { mode: 0o600 });
    assert.throws(() => collectMigrationClosure(runtime, 'computed.js'), /dynamic|computed|unsupported/);
});

test('legacy predecessor fixture carries the exact v1.44 table surface', (t) => {
    const value = fixture(t);
    const database = path.join(value.root, 'legacy-144-exact.sqlite');
    createLegacy144DatabaseFixture({ outputFile: database, scenario: 'clean' });
    assert.equal(sqlite(database, 'PRAGMA user_version;'), '0');
    assert.equal(sqlite(database, "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%';"), '23');
    assert.equal(sqlite(database, "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%';"), '56');
    const required = ['projects', 'sessions', 'session_participants', 'message_authors', 'project_members', 'pending_server_actions'];
    for (const table of required) {
        assert.equal(sqlite(database, `SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='${table}';`), '1');
    }
});

test('predecessor compatibility identity is independent of tenant row counts', (t) => {
    const value = fixture(t);
    const database = path.join(value.root, 'legacy-144-variable-data.sqlite');
    createLegacy144DatabaseFixture({ outputFile: database, scenario: 'clean' });
    const before = probeLegacy144Predecessor(database);
    const db = new Database(database);
    try {
        db.prepare('INSERT INTO users(id,username,password_hash,created_at,role,status) VALUES(?,?,?,?,?,?)')
            .run(99, 'another-sanitized-user', '$2b$12$another.sanitized.fixture', '2026-01-02 00:00:00', 'member', 'active');
    } finally { db.close(); }
    const after = probeLegacy144Predecessor(database);
    assert.notEqual(before.stateProbe.preservation.users, after.stateProbe.preservation.users);
    assert.match(before.compatibilityShapeDigest, /^[a-f0-9]{64}$/);
    assert.equal(before.compatibilityShapeDigest, after.compatibilityShapeDigest,
        'accepted predecessor identity must describe compatibility, not one fixture tenant data set');
});

test('compatibility identity excludes database health while health remains observable', (t) => {
    const value = fixture(t);
    const database = path.join(value.root, 'legacy-144-health-separated.sqlite');
    createLegacy144DatabaseFixture({ outputFile: database, scenario: 'clean' });
    const healthy = probeLegacy144Predecessor(database);
    const db = new Database(database);
    try {
        db.pragma('foreign_keys = OFF');
        db.prepare('INSERT INTO project_members(project_id,user_id,role,added_by,created_at) VALUES(?,?,?,?,?)')
            .run('missing-project', 1, 'member', 1, '2026-01-02 00:00:00');
    } finally { db.close(); }
    const unhealthy = probeLegacy144Predecessor(database);
    assert.equal(unhealthy.stateProbe.verification.foreignKeyViolations, 1);
    assert.equal(healthy.compatibilityShapeDigest, unhealthy.compatibilityShapeDigest,
        'integrity/FK evidence is an admission gate, not part of a normalized structural identity');
});

test('migration state distinguishes independent data-dependent migration conditions', (t) => {
    const value = fixture(t);
    const database = path.join(value.root, 'legacy-144-state-dimensions.sqlite');
    createLegacy144DatabaseFixture({ outputFile: database, scenario: 'clean' });
    const complete = probeLegacy144Predecessor(database);
    const db = new Database(database);
    try { db.prepare("DELETE FROM session_participants WHERE session_id='fixture-session'").run(); }
    finally { db.close(); }
    const missingParticipant = probeLegacy144Predecessor(database);
    assert.equal(complete.compatibilityShapeDigest, missingParticipant.compatibilityShapeDigest);
    assert.notDeepEqual(complete.migrationState, missingParticipant.migrationState,
        'credential state alone cannot represent participant/backfill migration conditions');
});

test('accepted legacy state matrix covers independent credential, marker, and data-condition combinations', (t) => {
    const value = fixture(t);
    const declared = new Set();
    for (const scenario of LEGACY_144_SCENARIOS) {
        const file = path.join(value.root, `declared-${scenario}.sqlite`);
        createLegacy144DatabaseFixture({ outputFile: file, scenario });
        declared.add(probeLegacy144Predecessor(file).migrationStateDigest);
    }
    const variants = [
        { name: 'plaintext-without-markers', scenario: 'plaintext-credential', mutate(db) {
            db.prepare("DELETE FROM app_config WHERE key LIKE '%migration%' OR key LIKE '%backfill%' OR key LIKE '%repair%'").run();
        } },
        { name: 'encrypted-with-partial-marker', scenario: 'already-encrypted', mutate(db) {
            db.prepare("DELETE FROM app_config WHERE key='participants_ownership_repaired_at'").run();
        } },
        { name: 'clean-with-missing-participant', scenario: 'clean', mutate(db) {
            db.prepare("DELETE FROM session_participants WHERE session_id='fixture-session'").run();
        } },
    ];
    for (const variant of variants) {
        const file = path.join(value.root, `${variant.name}.sqlite`);
        createLegacy144DatabaseFixture({ outputFile: file, scenario: variant.scenario });
        const db = new Database(file); try { variant.mutate(db); } finally { db.close(); }
        const observed = probeLegacy144Predecessor(file);
        assert.equal(declared.has(observed.migrationStateDigest), true, `${variant.name} is absent from the accepted matrix`);
    }
});

test('adversarial fixture itself preserves the expected committed Git bytes', (t) => {
    const value = fixture(t);
    assert.equal(git(value.legacyRoot, 'cat-file', '-t', value.legacyHead), 'commit');
    assert.equal(readFileSync(path.join(value.legacyRoot, 'package.json'), 'utf8'), '{}\n');
});
