import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import { bindMigrationClosureToAsset, collectMigrationClosure } from './lib/release-database-migration-closure.mjs';
import {
    DATABASE_PRESERVATION_POLICY_SHA256, fingerprintDatabase, rehearseIsolatedRuntimeMigration,
} from './lib/release-database-contract.mjs';
import {
    createLegacy144DatabaseFixture, LEGACY_144_BLOCKED_DECISIONS, measureLegacy144FixtureTarget,
    probeLegacy144Predecessor,
} from './lib/legacy-144-database-fixture.mjs';

const PROJECT = path.resolve(new URL('..', import.meta.url).pathname);
const RUNTIME = path.join(PROJECT, 'dist-server');
const ENTRY_RELATIVE = 'server/scripts/release-database-migration.js';
const ENTRY = path.join(RUNTIME, ENTRY_RELATIVE);
const TEMP = process.env.NASSAJ_TEST_TMP || process.env.TMPDIR || '/var/tmp';
const FIXTURE_KEY = Buffer.from('4c2ebf16d6b734b92d0203ba772b35f768f0bfa22119e74f3435f74ab9d09f51', 'hex');
const REPRESENTATIVE_SCENARIOS = Object.freeze([
    'clean__complete__complete',
    'plaintext-credential__absent__complete',
    'already-encrypted__partial__complete',
    'partial-markers__complete__missing-participant',
]);

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function workspace(t) {
    const root = mkdtempSync(path.join(TEMP, 'release-database-isolated-'));
    chmodSync(root, 0o700); t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}

let cachedContract; let cachedDecisions;
function releaseContract(root) {
    if (cachedContract) return cachedContract;
    const matrixDirectory = path.join(root, 'matrix'); mkdirSync(matrixDirectory, { mode: 0o700 });
    const accepted = []; let targetSchemaDigest;
    for (const scenario of REPRESENTATIVE_SCENARIOS) {
        const sourceDatabase = path.join(matrixDirectory, `${scenario}.sqlite`);
        const migratedDatabase = path.join(matrixDirectory, `${scenario}.migrated.sqlite`);
        const fixture = createLegacy144DatabaseFixture({ outputFile: sourceDatabase, scenario });
        const measured = measureLegacy144FixtureTarget({ sourceDatabase, migratedDatabase, migrationEntry: ENTRY });
        const target = probeLegacy144Predecessor(migratedDatabase);
        targetSchemaDigest ||= measured.targetSchemaDigest;
        assert.equal(targetSchemaDigest, measured.targetSchemaDigest);
        accepted.push({ scenario, schemaDigest: fixture.predecessorSchemaDigest,
            compatibilityShapeDigest: fixture.compatibilityShapeDigest, migrationStateDigest: fixture.migrationStateDigest,
            targetCompatibilityShapeDigest: target.compatibilityShapeDigest, targetMigrationStateDigest: target.migrationStateDigest });
    }
    cachedDecisions = [...accepted.map((item) => ({ scenario: item.scenario, decision: 'accepted',
        ruleId: 'legacy-144-supported-state-v1', migrationStateDigest: item.migrationStateDigest })),
    ...LEGACY_144_BLOCKED_DECISIONS];
    const grouped = new Map();
    for (const item of accepted) {
        const key = `${item.schemaDigest}:${item.compatibilityShapeDigest}`;
        const current = grouped.get(key) || { schemaDigest: item.schemaDigest,
            compatibilityShapeDigest: item.compatibilityShapeDigest, allowedMigrationStateDigests: [] };
        current.allowedMigrationStateDigests.push(item.migrationStateDigest); grouped.set(key, current);
    }
    const acceptedPredecessors = [...grouped.values()].map((item) => ({ ...item,
        allowedMigrationStateDigests: [...new Set(item.allowedMigrationStateDigests)].sort() }));
    const closure = collectMigrationClosure(RUNTIME, ENTRY_RELATIVE);
    const assetFiles = [...closure.files, ...closure.packages.flatMap((item) => item.files)]
        .map((item) => ({ path: item.assetPath, mode: item.mode, size: item.size, sha256: item.sha256 }));
    const migrationClosure = bindMigrationClosureToAsset(closure, assetFiles);
    const targetCompatibility = [...new Set(accepted.map((item) => item.targetCompatibilityShapeDigest))];
    cachedContract = {
        schema: 'nassaj-database-release-contract/v1', releaseIdentitySha256: 'a'.repeat(64),
        migrationEntrySha256: sha(readFileSync(ENTRY)), migrationClosureSha256: closure.sha256, migrationClosure,
        acceptedPredecessors, targetSchemaDigest,
        targetCompatibilityShapeDigest: targetCompatibility[0],
        targetMigrationStateDigests: [...new Set(accepted.map((item) => item.targetMigrationStateDigest))].sort(),
        preservationPolicySha256: DATABASE_PRESERVATION_POLICY_SHA256,
        schemaVersion: 1, minimumReadableSchemaVersion: 1, previousReleasePolicy: 'restore_required', rehearsalRequired: true,
    };
    return cachedContract;
}

test('legacy admission ledger explicitly blocks every unsupported or unverifiable state', (t) => {
    const root = workspace(t); releaseContract(root);
    const blocked = cachedDecisions.filter((item) => item.decision === 'blocked');
    assert.equal(blocked.every((item) => typeof item.ruleId === 'string' && item.ruleId.length > 0), true);
    const evidence = JSON.stringify(blocked);
    for (const reason of ['malformed', 'auth_failed', 'key_unavailable', 'inconsistent', 'unknown', 'unsupported']) {
        assert.match(evidence, new RegExp(reason), `missing explicit blocked decision for ${reason}`);
    }
});

function files(root, scenario, contract, instance = scenario) {
    const sourceDatabase = path.join(root, `${instance}.sqlite`);
    const rehearsalDirectory = path.join(root, `${instance}-rehearsal`); mkdirSync(rehearsalDirectory, { mode: 0o700 });
    const rehearsalDatabase = path.join(rehearsalDirectory, 'database.sqlite');
    createLegacy144DatabaseFixture({ outputFile: sourceDatabase, scenario }); chmodSync(sourceDatabase, 0o600);
    const providerSecretsKeyFile = path.join(root, `${instance}.key`);
    writeFileSync(providerSecretsKeyFile, FIXTURE_KEY, { flag: 'wx', mode: 0o600 });
    const secretCapabilityFile = path.join(root, `${instance}.capability.json`);
    writeFileSync(secretCapabilityFile, `${JSON.stringify({ schema: 'nassaj-migration-secret-capability/v1',
        purpose: 'release-database-migration', providerSecretsKeyFd: 4,
        releaseIdentitySha256: contract.releaseIdentitySha256, migrationEntrySha256: contract.migrationEntrySha256,
        databaseSha256: fingerprintDatabase(sourceDatabase).sha256, expiresAt: Date.now() + 300_000,
        nonce: `qa_${scenario.replaceAll('-', '_')}_nonce` })}\n`, { flag: 'wx', mode: 0o600 });
    return { sourceDatabase, rehearsalDatabase, providerSecretsKeyFile, secretCapabilityFile };
}

function run(contract, value, extras = {}) {
    return rehearseIsolatedRuntimeMigration({ manifest: { databaseContract: contract },
        releaseIdentitySha256: contract.releaseIdentitySha256, runtimeRoot: RUNTIME, migrationEntry: ENTRY, ...value, ...extras });
}

test('exact isolated migration authenticates and preserves clean, plaintext, encrypted, and mixed legacy states', (t) => {
    const root = workspace(t); const contract = releaseContract(root);
    for (const scenario of REPRESENTATIVE_SCENARIOS) {
        const result = run(contract, files(root, scenario, contract));
        assert.equal(result.state, 'rehearsed');
        assert.equal(result.targetSchemaDigest, contract.targetSchemaDigest);
    }
});

test('credential tag tampering and a wrong provider key fail closed before acceptance', (t) => {
    const root = workspace(t); const contract = releaseContract(root);
    const tampered = files(root, 'already-encrypted__partial__complete', contract);
    const db = new Database(tampered.sourceDatabase);
    try {
        const row = db.prepare('SELECT id,credential_value AS value FROM user_credentials LIMIT 1').get();
        const parts = row.value.split(':'); parts[3] = `${parts[3][0] === 'A' ? 'B' : 'A'}${parts[3].slice(1)}`;
        db.prepare('UPDATE user_credentials SET credential_value=? WHERE id=?').run(parts.join(':'), row.id);
    } finally { db.close(); }
    const capability = JSON.parse(readFileSync(tampered.secretCapabilityFile));
    capability.databaseSha256 = fingerprintDatabase(tampered.sourceDatabase).sha256;
    writeFileSync(tampered.secretCapabilityFile, `${JSON.stringify(capability)}\n`);
    assert.throws(() => run(contract, tampered), /runtime_failed|authentication|credential/i);

    const wrongKey = files(root, 'already-encrypted__partial__complete', contract, 'already-encrypted-wrong-key');
    writeFileSync(wrongKey.providerSecretsKeyFile, Buffer.alloc(32, 0x5a));
    assert.throws(() => run(contract, wrongKey), /runtime_failed|authentication|credential/i);
});

test('keyed preservation receipts reject same-count stable-row substitution after migration', (t) => {
    const root = workspace(t); const contract = releaseContract(root);
    const value = files(root, 'clean__complete__complete', contract, 'same-count-substitution');
    let checks;
    assert.throws(() => run(contract, value, { testHooks: {
        afterRuntimeBeforeVerification({ database }) {
            const db = new Database(database);
            try { db.prepare("UPDATE users SET username='same-count-substitute' WHERE id=1").run(); } finally { db.close(); }
        },
        capturePreservationFailure(observed) { checks = observed; },
    } }), /preservation_mismatch:.*stableRows/i);
    assert.equal(checks?.stableCounts, true);
    assert.equal(checks?.stableRows, false);
});

test('exact-table preservation rejects same-count semantic project mutation after migration', (t) => {
    const root = workspace(t); const contract = releaseContract(root);
    const value = files(root, 'clean__complete__complete', contract, 'semantic-project-substitution');
    let checks;
    assert.throws(() => run(contract, value, { testHooks: {
        afterRuntimeBeforeVerification({ database }) {
            const db = new Database(database);
            try {
                db.prepare("UPDATE projects SET custom_project_name='corrupted-project' WHERE project_id='fixture-project'").run();
            } finally { db.close(); }
        },
        capturePreservationFailure(observed) { checks = observed; },
    } }), /preservation_mismatch:.*stableRows/i);
    assert.equal(checks?.stableCounts, true);
    assert.equal(checks?.stableRows, false);
});

test('API-key transform evidence rejects post-migration digest corruption', (t) => {
    const root = workspace(t); const contract = releaseContract(root);
    const value = files(root, 'clean__complete__complete', contract, 'api-key-digest-corruption');
    let checks;
    assert.throws(() => run(contract, value, { testHooks: {
        afterRuntimeBeforeVerification({ database }) {
            const db = new Database(database);
            try { db.prepare("UPDATE api_keys SET key_digest=? WHERE id=(SELECT id FROM api_keys LIMIT 1)").run('f'.repeat(64)); }
            finally { db.close(); }
        },
        capturePreservationFailure(observed) { checks = observed; },
    } }), /preservation_mismatch:.*apiKeys/i);
    assert.equal(checks?.stableCounts, true);
    assert.equal(checks?.apiKeys, false);
});
