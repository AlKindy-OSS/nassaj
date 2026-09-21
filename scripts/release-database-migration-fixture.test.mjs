import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    createLegacy144DatabaseFixture, generateLegacy144AcceptedPredecessors, LEGACY_144_SCENARIOS,
} from './lib/legacy-144-database-fixture.mjs';
import { collectMigrationClosure, verifyMigrationClosure } from './lib/release-database-migration-closure.mjs';

const TEMP = process.env.NASSAJ_TEST_TMP || process.env.TMPDIR || '/var/tmp';
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function temporary(t, prefix) {
    const root = mkdtempSync(path.join(TEMP, prefix)); t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}

test('legacy 1.44 fixtures are deterministic and distinguish every predecessor state without exposing values', (t) => {
    const root = temporary(t, 'legacy-144-fixtures-');
    const digests = new Set();
    for (const scenario of LEGACY_144_SCENARIOS) {
        const first = path.join(root, `${scenario}-1.sqlite`); const second = path.join(root, `${scenario}-2.sqlite`);
        const left = createLegacy144DatabaseFixture({ outputFile: first, scenario });
        const right = createLegacy144DatabaseFixture({ outputFile: second, scenario });
        assert.equal(left.databaseSha256, right.databaseSha256);
        assert.equal(left.predecessorSchemaDigest, right.predecessorSchemaDigest);
        assert.equal(left.compatibilityShapeDigest, right.compatibilityShapeDigest);
        assert.doesNotMatch(JSON.stringify(left), /fixture-token-/);
        digests.add(left.stateProbe.preservation.credentialState);
    }
    assert.equal(digests.size, 4);
});

test('migration closure is canonical, transitive, and records package imports', (t) => {
    const root = temporary(t, 'migration-closure-');
    mkdirSync(path.join(root, 'server', 'scripts'), { recursive: true }); mkdirSync(path.join(root, 'server', 'db'));
    writeFileSync(path.join(root, 'server', 'scripts', 'migrate.js'), "import '../db/a.js'; import Database from 'better-sqlite3';\n");
    writeFileSync(path.join(root, 'server', 'db', 'a.js'), "export { value } from './b.js';\n");
    writeFileSync(path.join(root, 'server', 'db', 'b.js'), 'export const value = 1;\n');
    const options = { nodeModulesRoot: path.join(PROJECT, 'node_modules') };
    const closure = collectMigrationClosure(root, 'server/scripts/migrate.js', options);
    assert.deepEqual(closure.files.map((file) => file.assetPath),
        ['dist-server/server/db/a.js', 'dist-server/server/db/b.js', 'dist-server/server/scripts/migrate.js']);
    assert.equal(closure.packages.some((item) => item.name === 'better-sqlite3'
        && item.files.some((file) => file.native && file.assetPath.endsWith('better_sqlite3.node'))), true);
    assert.equal(verifyMigrationClosure(root, closure, options).sha256, closure.sha256);
    writeFileSync(path.join(root, 'server', 'db', 'b.js'), 'export const value = 2;\n');
    assert.throws(() => verifyMigrationClosure(root, closure, options), /closure_mismatch/);
});

test('migration closure rejects entry escape and symlinked transitive imports', (t) => {
    const root = temporary(t, 'migration-closure-adversarial-');
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.js`);
    t.after(() => rmSync(outside, { force: true }));
    writeFileSync(outside, 'export const escaped = true;\n');
    mkdirSync(path.join(root, 'server'), { recursive: true });
    writeFileSync(path.join(root, 'server', 'entry.js'), "import './linked.js';\n");
    symlinkSync(outside, path.join(root, 'server', 'linked.js'));
    assert.throws(() => collectMigrationClosure(root, '../outside.js'), /escape/);
    assert.throws(() => collectMigrationClosure(root, 'server/entry.js'), /graph_escape|file_unsafe/);
});

test('accepted predecessor generator derives one target digest from the exact supplied compiled entry', (t) => {
    const root = temporary(t, 'legacy-144-accepted-'); const entry = path.join(root, 'compiled-migration.js');
    writeFileSync(entry, `
      import crypto from 'node:crypto';
      import { execFileSync } from 'node:child_process';
      const file = process.argv[process.argv.indexOf('--database') + 1];
      execFileSync('sqlite3', [file, 'CREATE TABLE IF NOT EXISTS migrated_fixture(id INTEGER PRIMARY KEY);']);
      const rows = JSON.parse(execFileSync('sqlite3', ['-json', file,
        "SELECT type,name,tbl_name AS tableName,coalesce(sql,'') AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name,tbl_name;"], { encoding: 'utf8' }) || '[]');
      const targetSchemaDigest = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
      process.stdout.write(JSON.stringify({ schema: 'nassaj-migration-only-result/v1', integrity: 'ok', foreignKeyViolations: 0, targetSchemaDigest }) + '\\n');
    `);
    const result = generateLegacy144AcceptedPredecessors({ workspaceDirectory: root, migrationEntry: entry });
    assert.equal(result.acceptedPredecessors.length, LEGACY_144_SCENARIOS.length);
    assert.deepEqual(result.acceptedPredecessors.map((item) => item.scenario), LEGACY_144_SCENARIOS);
    assert.match(result.targetSchemaDigest, /^[a-f0-9]{64}$/);
    assert.equal(new Set(result.acceptedPredecessors.map((item) => item.scenario)).size, LEGACY_144_SCENARIOS.length);
    assert.equal(new Set(result.acceptedPredecessors.map((item) => item.compatibilityShapeDigest)).size, 1);
    for (const item of result.acceptedPredecessors) {
        assert.equal(item.preservation.before.users, item.preservation.after.users);
        assert.equal(item.preservation.before.projects, item.preservation.after.projects);
        assert.equal(item.preservation.before.sessions, item.preservation.after.sessions);
        assert.equal(item.preservation.before.credentialIdentityDigest, item.preservation.after.credentialIdentityDigest);
    }
});
