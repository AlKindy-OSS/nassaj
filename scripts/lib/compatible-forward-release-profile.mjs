/** Fixed, source-reviewed profile for the measured 349-object predecessor. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectMigrationClosure } from './release-database-migration-closure.mjs';

export const STARTUP_MODE_POLICY = 'release-file-mode-normalization/v1';
export const FORWARD_PROFILE_ID = 'local-forward-349/v2';
export const FORWARD_PROFILE_MODULE = "export const ROOT_ADMISSION_REQUIRED = true;\nexport const PROFILE_ID = 'local-forward-349/v2';\n";
export const FORWARD_FIXTURE_PATH = 'server/scripts/fixtures/compatible-forward-schema-v1.json';
const FIXTURE_SHA256 = '0bb67fea8559d5413d5c4944352a003c73439684a4d8df15f9ab42c911760960';
export const STARTUP_ROOTS = Object.freeze([
    'server/bootstrap.js', 'server/bootstrap-release-profile.js', 'server/bootstrap-startup-context.js',
    'server/modules/connectors/connector-substrate-only.production.js',
    'server/modules/database/connection.js', 'server/modules/database/existing-security-state.js',
    'server/modules/database/init-db.js', 'server/modules/execution-permissions/runtime-gateway.js',
    'server/services/server-background-lifecycle.service.js',
].sort());
export const canonicalForward = value => Array.isArray(value) ? `[${value.map(canonicalForward).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalForward(value[key])}`).join(',')}}`
        : JSON.stringify(value);
export const forwardSha256 = value => createHash('sha256').update(value).digest('hex');
const HEX = /^[a-f0-9]{64}$/;

/** Reject arbitrary profiles and attest the fixed version-controlled fixture. */
export function forwardBuildInput(sourceRoot, baseSourceFingerprint) {
    if (!HEX.test(baseSourceFingerprint)) throw Error('forward_source_fingerprint_invalid');
    const fixture = readFileSync(path.join(sourceRoot, FORWARD_FIXTURE_PATH));
    if (forwardSha256(fixture) !== FIXTURE_SHA256) throw Error('forward_reviewed_fixture_changed');
    const material = { schema: 'nassaj-forward-build-input/v1', baseSourceFingerprint,
        profileId: FORWARD_PROFILE_ID,
        profileGeneratorSha256: forwardSha256(readFileSync(fileURLToPath(import.meta.url))),
        profileModuleSha256: forwardSha256(FORWARD_PROFILE_MODULE), fixtureSha256: FIXTURE_SHA256 };
    return Object.freeze({ material: Object.freeze(material), buildId: forwardSha256(canonicalForward(material)) });
}

/** Generate only inside the caller's unsealed candidate, before any provenance is written. */
export function materializeForwardProfile(runtimeRoot) {
    const file = path.join(runtimeRoot, 'server/bootstrap-release-profile.js');
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw Error('forward_profile_module_unsafe');
    // Compilation already materialized the ordinary module. This is an explicit build input,
    // never a post-seal alteration or an environment-selected runtime override.
    writeFileSync(file, FORWARD_PROFILE_MODULE, { mode: 0o644 });
}

/** Collect actual compiled imports and their complete runtime packages using the existing scanner. */
export function collectForwardStartupMaterial(runtimeRoot, options = {}) {
    const records = new Map();
    const observations = new Map();
    for (const root of STARTUP_ROOTS) {
        const closure = collectMigrationClosure(runtimeRoot, root, { ...options,
            // T-1667: reviewed Linux/glibc x64 image binding; generic migration admission stays unchanged.
            nativePackageAllowlist: ['better-sqlite3', 'argon2', 'bcrypt', 'node-pty', '@vscode/ripgrep', '@openai/codex',
                '@img/sharp-linux-x64'] });
        for (const entry of [...closure.files, ...closure.packages.flatMap(pkg => pkg.files)]) {
            const record = { path: entry.assetPath, size: entry.size, mode: entry.mode & 0o111 ? 0o755 : 0o644, sha256: entry.sha256 };
            const physical = entry.assetPath.startsWith('dist-server/')
                ? path.join(runtimeRoot, entry.assetPath.slice('dist-server/'.length))
                : path.join(options.nodeModulesRoot || path.join(path.dirname(runtimeRoot), 'node_modules'), entry.assetPath.slice('node_modules/'.length));
            const priorObservation = observations.get(physical);
            if (priorObservation && canonicalForward(priorObservation) !== canonicalForward(entry)) throw Error('forward_startup_source_raced');
            observations.set(physical, entry);
            const previous = records.get(record.path);
            if (previous && canonicalForward(previous) !== canonicalForward(record)) throw Error('forward_startup_closure_raced');
            records.set(record.path, record);
        }
    }
    options.testHooks?.afterScan?.();
    for (const [file, entry] of observations) {
        const info = lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.size || (info.mode & 0o777) !== entry.mode
            || forwardSha256(readFileSync(file)) !== entry.sha256) throw Error('forward_startup_source_raced');
    }
    const material = { schema: 'nassaj-startup-closure/v1', profileId: FORWARD_PROFILE_ID, modePolicy: STARTUP_MODE_POLICY,
        roots: STARTUP_ROOTS.map(root => `dist-server/${root}`),
        files: [...records.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
    const module = material.files.find(file => file.path === 'dist-server/server/bootstrap-release-profile.js');
    if (module?.sha256 !== forwardSha256(FORWARD_PROFILE_MODULE)) throw Error('forward_compiled_profile_mismatch');
    return Object.freeze({ material, sha256: forwardSha256(canonicalForward(material)) });
}

/** Verify a recorded closure against actual bytes and independently pinned hash. */
export function verifyForwardStartupMaterial(releaseRoot, expectedSha256) {
    if (!HEX.test(expectedSha256 || '')) throw Error('forward_startup_pin_required');
    const file = path.join(releaseRoot, 'dist-server/STARTUP_CLOSURE.json');
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('forward_startup_material_unsafe');
    const material = JSON.parse(readFileSync(file, 'utf8'));
    if (Object.keys(material).sort().join(',') !== 'files,modePolicy,profileId,roots,schema'
        || material.schema !== 'nassaj-startup-closure/v1' || material.profileId !== FORWARD_PROFILE_ID
        || material.modePolicy !== STARTUP_MODE_POLICY
        || canonicalForward(material.roots) !== canonicalForward(STARTUP_ROOTS.map(root => `dist-server/${root}`))
        || !Array.isArray(material.files) || !material.files.length
        || forwardSha256(canonicalForward(material)) !== expectedSha256) throw Error('forward_startup_material_mismatch');
    let previous = '';
    for (const entry of material.files) {
        if (Object.keys(entry).sort().join(',') !== 'mode,path,sha256,size'
            || ![0o644, 0o755].includes(entry.mode) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !HEX.test(entry.sha256)
            || typeof entry.path !== 'string' || entry.path <= previous || !/^(dist-server|node_modules)\//.test(entry.path)
            || entry.path.split('/').some(part => !part || part === '.' || part === '..') || entry.path.includes('\\')) {
            throw Error('forward_startup_path_invalid');
        }
        let resolved = releaseRoot;
        for (const part of entry.path.split('/')) {
            resolved = path.join(resolved, part);
            if (lstatSync(resolved).isSymbolicLink()) throw Error('forward_startup_symlink');
        }
        const metadata = lstatSync(resolved);
        if (!metadata.isFile() || metadata.size !== entry.size || (metadata.mode & 0o777) !== entry.mode
            || forwardSha256(readFileSync(resolved)) !== entry.sha256) throw Error('forward_startup_bytes_changed');
        previous = entry.path;
    }
    if (material.files.find(entry => entry.path === 'dist-server/server/bootstrap-release-profile.js')?.sha256
        !== forwardSha256(FORWARD_PROFILE_MODULE)) throw Error('forward_compiled_profile_mismatch');
    return material;
}

// Only an isolated in-memory fixture is opened. The imported production routines
// supply the same observation and bounded permission/receipt migration used by the governed child.
const OBSERVE_FIXTURE = `
import fs from 'node:fs'; import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const require=createRequire(input.lockFile); const Database=require('better-sqlite3');
const {observeCompatibleForwardDatabase:observe}=await import(pathToFileURL(input.migrationEntry));
const {migrateCompatibleForwardPermissionReceipt:migrate}=await import(pathToFileURL(input.deltaModule));
const fixture=JSON.parse(fs.readFileSync(input.fixtureFile,'utf8')); const db=new Database(':memory:');
try {
 for(const type of ['table','index','view','trigger']) for(const item of fixture.objects.filter(v=>v.type===type)) db.exec(item.sql);
 for(const marker of fixture.markers) if(marker.present) db.prepare('INSERT INTO app_config(key,value) VALUES (?,?)').run(marker.key,'fixture-only');
 const source=observe(db); if(fixture.objects.length!==349||source.schemaDigest!==fixture.sourceSchemaDigest) throw Error('forward_source_fixture_mismatch');
 const oldTables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
   .map(({name})=>({name,columns:db.prepare('SELECT name FROM pragma_table_info(?)').all(name).map(row=>row.name)}));
 const rows=()=>oldTables.map(({name,columns})=>({name,rows:db.prepare('SELECT '+columns.map(name=>JSON.stringify(name)).join(',')+' FROM '+JSON.stringify(name)).all()}));
 const before=rows(); const control=new Database(db.serialize());
 // Independent exact candidate-10caa DDL oracle; never import the implementation SQL.
 control.exec("ALTER TABLE pending_server_actions ADD COLUMN execution_attempt_nonce TEXT;\\nALTER TABLE permission_admission_leases ADD COLUMN effect_footprint TEXT NOT NULL\\n        DEFAULT 'external' CHECK (effect_footprint IN ('local', 'external'));\\nALTER TABLE permission_admission_leases ADD COLUMN effect_child_pid INTEGER;\\nALTER TABLE permission_admission_leases ADD COLUMN effect_child_boot_id TEXT;\\nALTER TABLE permission_admission_leases ADD COLUMN effect_child_start_ticks TEXT;\\nALTER TABLE message_coordination_ingress ADD COLUMN accepted_at TEXT;\\nCREATE TABLE IF NOT EXISTS permission_effect_fences (\\n  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'user_provider_purpose')),\\n  scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 512),\\n  protocol_generation INTEGER NOT NULL CHECK (protocol_generation > 0),\\n  decision_id TEXT,\\n  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),\\n  created_at_ms INTEGER NOT NULL,\\n  PRIMARY KEY (scope_kind, scope_key),\\n  FOREIGN KEY (decision_id) REFERENCES permission_launch_decisions(decision_id)\\n    ON DELETE RESTRICT\\n);");
 const expectedTarget=observe(control); control.close();
 db.exec('BEGIN IMMEDIATE'); migrate(db); const target=observe(db);
 if(JSON.stringify(before)!==JSON.stringify(rows())) throw Error('forward_fixture_data_changed');
 if(JSON.stringify(target)!==JSON.stringify(expectedTarget)) throw Error('forward_fixture_extra_schema_effect');
 const after=db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
 if(after.length!==350||db.prepare('SELECT count(*) AS n FROM permission_effect_fences').get().n!==0||source.schemaDigest===target.schemaDigest) throw Error('forward_fixture_mutation_invalid');
 db.exec('ROLLBACK'); if(JSON.stringify(observe(db))!==JSON.stringify(source)) throw Error('forward_fixture_rollback_failed');
 process.stdout.write(JSON.stringify({source,target}));
} finally {db.close();}
`;

/** Derive the finite source/target observations from reviewed fixture and actual compiled routines. */
export function observeForwardProfile({ sourceRoot, runtimeRoot, packageLockFile }, injected = {}) {
    const fixtureFile = path.join(sourceRoot, FORWARD_FIXTURE_PATH);
    if (forwardSha256(readFileSync(fixtureFile)) !== FIXTURE_SHA256) throw Error('forward_reviewed_fixture_changed');
    const run = injected.run || spawnSync;
    const result = run(process.execPath, ['--input-type=module', '-e', OBSERVE_FIXTURE], {
        input: JSON.stringify({ fixtureFile, lockFile: packageLockFile,
            migrationEntry: path.join(runtimeRoot, 'server/scripts/release-database-migration.js'),
            deltaModule: path.join(runtimeRoot, 'server/modules/database/compatible-forward-permission-receipt.migration.js') }),
        encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0) throw Error(`forward_fixture_failed: ${result.stderr || result.error?.message || result.status}`);
    const observation = JSON.parse(result.stdout);
    if (Object.keys(observation).sort().join(',') !== 'source,target'
        || [observation.source, observation.target].some(state => Object.keys(state).sort().join(',') !== 'compatibilityShapeDigest,migrationStateDigest,schemaDigest'
            || Object.values(state).some(value => !HEX.test(value)))
        || observation.source.schemaDigest !== '9dd61e321dee9789d48d1f30b7fe3c828ceb87a45242d0f1d3e67905f60d11de'
        || observation.source.schemaDigest === observation.target.schemaDigest) throw Error('forward_observation_invalid');
    return observation;
}

/** Bind the fixed observations to the genuine release identity and independently built startup material. */
export function createForwardDatabaseContract({ releaseIdentitySha256, migrationEntrySha256, migrationClosure,
    startupClosureSha256, observation }) {
    if ([releaseIdentitySha256, migrationEntrySha256, startupClosureSha256].some(value => !HEX.test(value))) throw Error('forward_contract_identity_invalid');
    return { schema: 'nassaj-database-release-contract/v2', releaseIdentitySha256, migrationEntrySha256,
        migrationClosureSha256: migrationClosure.sha256,
        migrationClosure: { schema: 'nassaj-database-migration-closure/v2', assetManifestBound: true, sha256: migrationClosure.sha256 },
        activationPolicy: 'compatible-forward', failurePolicy: 'maintenance-preserve-current-db',
        databasePolicy: 'existing-inode-no-restore', migrationId: 'permission-receipt-forward/v1',
        observationPolicy: 'permission-receipt-metadata/v1', source: observation.source, target: observation.target,
        startup: { policyId: 'existing-security-state/v1', closureSha256: startupClosureSha256 } };
}
