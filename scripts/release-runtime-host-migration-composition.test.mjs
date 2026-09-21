import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { bindMigrationClosureToAsset, collectMigrationClosure } from './lib/release-database-migration-closure.mjs';
import { createLegacy144DatabaseFixture, measureLegacy144FixtureTarget } from './lib/legacy-144-database-fixture.mjs';
import { createReleaseRuntimeHostOperations } from './lib/release-runtime-host-operations.mjs';

const PROJECT = path.resolve(new URL('..', import.meta.url).pathname);
const PINNED_NODE = '/usr/bin/node';
const ENTRY_RELATIVE = 'server/scripts/release-database-migration.js';
const KEY = Buffer.from('4c2ebf16d6b734b92d0203ba772b35f768f0bfa22119e74f3435f74ab9d09f51', 'hex');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function releaseEvidence(root, runtime, entry) {
    const source = path.join(root, 'measure-source.sqlite'); const target = path.join(root, 'measure-target.sqlite');
    createLegacy144DatabaseFixture({ outputFile: source, scenario: 'plaintext-credential__absent__complete' });
    const targetEvidence = measureLegacy144FixtureTarget({ sourceDatabase: source, migratedDatabase: target, migrationEntry: entry,
        capabilityBinding: { databaseContractSha256: 'c'.repeat(64), migrationClosureSha256: 'd'.repeat(64) } });
    const closure = collectMigrationClosure(runtime, ENTRY_RELATIVE, { nodeModulesRoot: path.join(PROJECT, 'node_modules'),
        packageLockFile: path.join(PROJECT, 'package-lock.json') });
    const assets = [...closure.files, ...closure.packages.flatMap((item) => item.files)]
        .map((item) => ({ path: item.assetPath, mode: item.mode, size: item.size, sha256: item.sha256 }));
    const measured = { targetSchemaDigest: targetEvidence.targetSchemaDigest,
        migrationClosure: bindMigrationClosureToAsset(closure, assets) };
    return measured;
}

function fixture(t, name) {
    const root = mkdtempSync(path.join(PROJECT, `.host-migration-${name}-`)); chmodSync(root, 0o700);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const generationRoot = path.join(root, 'generation'); const runtime = path.join(generationRoot, 'dist-server');
    mkdirSync(generationRoot, { mode: 0o700 }); cpSync(path.join(PROJECT, 'dist-server'), runtime, { recursive: true });
    // A release generation carries normalized modes; do not inherit the live build umask.
    execFileSync('/usr/bin/chmod', ['-R', 'go-w', runtime]);
    copyFileSync(path.join(PROJECT, 'server/services/isolation/provider-secrets-key-manager.js'),
        path.join(runtime, 'server/services/isolation/provider-secrets-key-manager.js'));
    const entry = path.join(runtime, ENTRY_RELATIVE); const evidence = releaseEvidence(root, runtime, entry);
    const databaseFile = path.join(root, 'database.sqlite');
    createLegacy144DatabaseFixture({ outputFile: databaseFile, scenario: 'plaintext-credential__absent__complete' });
    chmodSync(databaseFile, 0o600); const entrySha256 = sha(readFileSync(entry));
    const releaseIdentitySha256 = 'a'.repeat(64);
    const contract = { schema: 'nassaj-database-release-contract/v1', releaseIdentitySha256,
        migrationEntrySha256: entrySha256, migrationClosureSha256: evidence.migrationClosure.sha256,
        migrationClosure: evidence.migrationClosure, targetSchemaDigest: evidence.targetSchemaDigest };
    const contractFile = path.join(root, 'database-contract.json'); writeFileSync(contractFile, JSON.stringify(contract), { mode: 0o444 });
    assert.equal(lstatSync(entry).mode & 0o777, 0o644); assert.equal(lstatSync(contractFile).mode & 0o777, 0o444);
    const contractSha256 = sha(readFileSync(contractFile)); const keyFile = path.join(root, 'provider-secrets.key');
    writeFileSync(keyFile, KEY, { mode: 0o600 }); const capabilityFile = path.join(root, 'migration-capability.json');
    writeFileSync(capabilityFile, JSON.stringify({ schema: 'nassaj-migration-secret-capability/v1',
        purpose: 'release-database-migration', providerSecretsKeyFd: 4, releaseIdentitySha256,
        migrationEntrySha256: entrySha256, databaseContractSha256: contractSha256,
        migrationClosureSha256: evidence.migrationClosure.sha256, databaseSha256: sha(readFileSync(databaseFile)),
        expiresAt: Date.now() + 300_000, nonce: `composition_${name}_nonce` }), { mode: 0o600 });
    const controlRoot = path.join(root, 'control'); mkdirSync(controlRoot, { mode: 0o700 });
    const nodeMetadata = lstatSync(PINNED_NODE);
    assert.equal(nodeMetadata.isFile(), true); assert.equal(nodeMetadata.isSymbolicLink(), false);
    assert.equal(nodeMetadata.uid, 0); assert.equal(nodeMetadata.gid, 0); assert.equal(nodeMetadata.mode & 0o022, 0);
    const nodeSha256 = sha(readFileSync(PINNED_NODE));
    const config = { schema: 'nassaj-release-runtime-host-config/v1', controlRoot, databaseFile,
        preMigrationBackupFile: path.join(root, 'pre.sqlite'), finalBackupFile: path.join(root, 'final.sqlite'),
        expected: { releaseIdentitySha256, databaseContractSha256: contractSha256,
            targetSchemaDigest: evidence.targetSchemaDigest },
        oldProcess: { pid: 400, pgid: 400, sid: 400, startTime: '1', killTimeout: 86_400_000, treeKill: false },
        pm2: { binary: PINNED_NODE, binarySha256: nodeSha256, launcher: PINNED_NODE,
            launcherSha256: nodeSha256 },
        migration: { node: { file: PINNED_NODE, sha256: nodeSha256 }, entry: { file: entry, sha256: entrySha256 },
            contractFile, contractSha256, runtimeRoot: generationRoot, nodeModulesRoot: path.join(PROJECT, 'node_modules'),
            providerSecretsKeyFile: keyFile,
            secretCapabilityFile: capabilityFile, serviceUid: process.getuid(), serviceGid: process.getgid() } };
    const deps = { databaseWriters: () => 0,
        verifyPinnedMigrationData(file, expected) { assert.equal(sha(readFileSync(file)), expected); } };
    return { config, deps, databaseFile, entry };
}

test('production node pin rejects digest tampering and a raceable symlink alias', async (t) => {
    const tampered = fixture(t, 'node-tamper'); tampered.config.migration.node.sha256 = '0'.repeat(64);
    await assert.rejects(createReleaseRuntimeHostOperations(tampered.config, tampered.deps).finalVacuumAndBackup(),
        /executable_identity_invalid/);
    const aliased = fixture(t, 'node-symlink'); const alias = path.join(aliased.config.controlRoot, '..', 'node-link');
    symlinkSync(PINNED_NODE, alias); aliased.config.migration.node.file = alias;
    await assert.rejects(createReleaseRuntimeHostOperations(aliased.config, aliased.deps).finalVacuumAndBackup(),
        /executable_identity_invalid/);
});

test('real 1.44 compiled migration resumes after a post-mutation crash and proves final receipts', async (t) => {
    const value = fixture(t, 'resume'); let crash = true;
    value.deps.afterMigrationBeforePreservation = () => { if (crash) { crash = false; throw new Error('simulated_crash'); } };
    const first = createReleaseRuntimeHostOperations(value.config, value.deps);
    await assert.rejects(first.finalVacuumAndBackup(), /simulated_crash/);
    delete value.deps.afterMigrationBeforePreservation;
    const result = await createReleaseRuntimeHostOperations(value.config, value.deps).finalVacuumAndBackup();
    assert.equal(result.semanticPreservation.passed, true); assert.equal(result.targetSchemaDigest, value.config.expected.targetSchemaDigest);
});

test('resume rejects stable-row corruption after the real migration before final backup', async (t) => {
    const value = fixture(t, 'corrupt');
    value.deps.afterMigrationBeforePreservation = (database) => {
        execFileSync('/usr/bin/sqlite3', [database, "UPDATE projects SET custom_project_name='corrupted' WHERE project_id=(SELECT project_id FROM projects LIMIT 1)"]);
        throw new Error('simulated_crash');
    };
    await assert.rejects(createReleaseRuntimeHostOperations(value.config, value.deps).finalVacuumAndBackup(), /simulated_crash/);
    delete value.deps.afterMigrationBeforePreservation;
    await assert.rejects(createReleaseRuntimeHostOperations(value.config, value.deps).finalVacuumAndBackup(),
        /semantic_preservation_failed/);
});

test('real 1.44 migration rollback restores the exact original database bytes', async (t) => {
    const value = fixture(t, 'rollback'); const original = readFileSync(value.databaseFile);
    const operations = createReleaseRuntimeHostOperations(value.config, value.deps);
    const migrated = await operations.finalVacuumAndBackup(); assert.equal(migrated.semanticPreservation.passed, true);
    assert.equal(readFileSync(value.databaseFile).equals(original), false);
    const restored = await operations.restoreDatabaseFromBackup(); assert.equal(restored.restored, true);
    assert.equal(readFileSync(value.databaseFile).equals(original), true);
    chmodSync(value.entry, 0o755);
    await assert.rejects(operations.finalVacuumAndBackup(), /closure_mismatch|entry_mode|data_identity/);
});


test('compiled migration CLI recognizes only its own direct entry or retained FD5 and keeps imports inert', t => {
    const value = fixture(t, 'entry-dispatch'); const root = path.dirname(value.databaseFile);
    const missingDatabase = path.join(root, 'must-not-create.sqlite');
    const importer = path.join(root, 'importer.mjs');
    writeFileSync(importer, `await import(${JSON.stringify(new URL(`file://${value.entry}`).href)});process.stdout.write('import-only');`);
    const missingFdImporter = path.join(root, 'missing-fd.mjs');
    writeFileSync(missingFdImporter, `process.argv[1]='/proc/self/fd/5';await import(${JSON.stringify(new URL(`file://${value.entry}`).href)});process.stdout.write('import-only');`);
    for (const [name, target, retained, fdNumber, executes] of [
        ['direct', value.entry, value.entry, 5, true],
        ['retained-fd5', '/proc/self/fd/5', value.entry, 5, true],
        ['ordinary-import', importer, value.entry, 5, false],
        ['other-entry-fd5', '/proc/self/fd/5', importer, 5, false],
        ['wrong-fd6', '/proc/self/fd/6', value.entry, 6, false],
        ['missing-fd5', missingFdImporter, null, null, false],
    ]) {
        const fd = retained ? openSync(retained, 'r') : null;
        const stdio = ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore'];
        if (fd !== null) stdio[fdNumber] = fd;
        let result;
        try { result = spawnSync(PINNED_NODE, [target, '--database', missingDatabase], {
            stdio, encoding: 'utf8', timeout: 10000, env: { PATH: '/usr/bin:/bin', HOME: root, NODE_ENV: 'test' },
        }); } finally { if (fd !== null) closeSync(fd); }
        assert.equal(result.signal, null, name); assert.equal(result.error, undefined, name);
        assert.equal(result.status, executes ? 1 : 0, `${name}: ${result.stderr}`);
        if (executes) assert.match(result.stderr, /runLegacyMigrationCli/, name);
        else { assert.equal(result.stderr, '', name); assert.equal(result.stdout, name === 'wrong-fd6' ? '' : 'import-only', name); }
        assert.equal(existsSync(missingDatabase), false, name);
    }
});
