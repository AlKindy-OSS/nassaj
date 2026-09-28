import { installCodexImageOnlyTestFixture } from './codex-image-only-test-fixture.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import {
    chmodSync, closeSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync,
    readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    collectUpdateRuntimeClosure, computeUpdateRuntimeBuildId, installUpdateRuntimeBundle,
    verifyUpdateRuntimeBundle,
} from './update-runtime-bundle.mjs';
import { bootstrapLegacy144HostCapability, createHostCapability, detectUpdateStrategy, planBridgeTransition, reconcileActivatedHostCapability, resolveUpdateRuntimeEntry, restoreHostCapability, writeHostCapability } from './update-runtime-capability.mjs';
import { FORWARD_EXECUTABLE_MANIFEST_PATH, compareReleasePaths, computeReleaseFileTreeSha256, currentReleaseRuntimeTarget, downloadExactGithubAsset, extractTarGzExact, inspectTarGz, selectExactReleaseAsset, validateReleaseAssetManifest, verifyExtractedReleaseAsset } from './update-release-asset.mjs';
import { validateDatabaseReleaseContract, DATABASE_PRESERVATION_POLICY_SHA256 } from './release-database-contract.mjs';
import { collectRuntimeReferences, createRuntimeReference, pruneUpdateRuntime, withUpdateRuntimeLock } from './update-runtime-janitor.mjs';
import { inspectReleaseLayout } from './update-release-layout-adapter.mjs';
import { createUpdateRuntimeOrchestrator } from './update-runtime-orchestrator.mjs';
import { attestNpmBinLinkFarms, buildReleaseAsset, collectForwardExecutableClosure } from '../build-release-asset.mjs';
import { materializeUpdateRuntimeImports } from '../server-build-atomic.mjs';
import { STARTUP_ROOTS, FORWARD_PROFILE_MODULE, collectForwardStartupMaterial } from './compatible-forward-release-profile.mjs';
import { RELEASE_RUNTIME_COMPATIBILITY } from './release-runtime-compatibility.mjs';
import {
    createMeasuredPermissionReleaseContract, validatePermissionReleaseContract,
} from './permission-release-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RELEASE_HOST = Object.freeze({ platform: 'linux', arch: 'x64', libc: '2.41', nodeMajor: 24, nodeModules: 137 });
const temporary = () => mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'update-runtime-v2-'));
const EMPTY_BIN_ATTESTATION = Object.freeze({ count: 0,
    sha256: createHash('sha256').update('').digest('hex'), records: [] });
const HOST_RUNTIME = currentReleaseRuntimeTarget();
const NODE24_RUNTIME = Object.freeze({ ...HOST_RUNTIME, nodeVersion: 'v24.18.1', nodeMajor: 24, nodeModulesAbi: '137' });
const NODE22_RUNTIME = Object.freeze({ ...HOST_RUNTIME, nodeVersion: 'v22.23.1', nodeMajor: 22, nodeModulesAbi: '127' });

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
function withDatabaseContract(value) {
    if (value.databaseContract) return value;
    const H = (character) => character.repeat(64);
    const releaseIdentitySha256 = createHash('sha256').update(canonical({ repo: value.repo, releaseId: value.releaseId,
        tag: value.tag, version: value.version, commit: value.commit, serverBuildId: value.serverBuildId,
        clientBuildId: value.clientBuildId, bundleBuildId: value.bundleBuildId })).digest('hex');
    return { ...value, databaseContract: { schema: 'nassaj-database-release-contract/v1', releaseIdentitySha256,
        migrationEntrySha256: H('1'), migrationClosureSha256: H('2'),
        migrationClosure: { schema: 'nassaj-database-migration-closure/v2', assetManifestBound: true, sha256: H('2') },
        targetSchemaDigest: H('3'), targetCompatibilityShapeDigest: H('4'), targetMigrationStateDigests: [H('5')],
        preservationPolicySha256: H('6'), acceptedPredecessors: [{ schemaDigest: H('7'), compatibilityShapeDigest: H('8'),
            allowedMigrationStateDigests: [H('9')] }], schemaVersion: 1, minimumReadableSchemaVersion: 1,
        previousReleasePolicy: 'restore_required', rehearsalRequired: true } };
}
function validateFixtureManifest(value, expected, runtimeTarget = NODE24_RUNTIME) {
    return validateReleaseAssetManifest(withDatabaseContract(value), expected, { runtimeTarget });
}

function runtimeMetadata(packages = [{ path: 'node_modules/runtime-fixture', name: 'runtime-fixture',
    resolvedName: 'runtime-fixture', version: '1.0.0', integrity: 'sha512-YQ==', enginesNode: null,
    os: null, cpu: null, libc: null, native: false, packageJsonSha256: '9'.repeat(64) }]) {
    const hash = createHash('sha256');
    for (const entry of packages) hash.update(entry.path).update('\0').update(entry.name).update('\0')
        .update(entry.resolvedName).update('\0').update(entry.version).update('\0').update(entry.integrity).update('\0')
        .update(JSON.stringify([entry.enginesNode, entry.os, entry.cpu, entry.libc, entry.native])).update('\0')
        .update(entry.packageJsonSha256).update('\0');
    return { targetRuntime: NODE24_RUNTIME, runtimeCompatibility: RELEASE_RUNTIME_COMPATIBILITY,
        runtimeClosure: { schemaVersion: 1, packages, sha256: hash.digest('hex') } };
}

function binAttestation(records) {
    const hash = createHash('sha256');
    for (const record of records) hash.update(record.link).update('\0').update(record.package).update('\0').update(record.target).update('\0');
    return { count: records.length, sha256: hash.digest('hex'), records };
}

test('one recursive runtime closure installs and verifies with path+mode+content buildId', () => {
    const out = temporary();
    const releaseOut = temporary();
    try {
        const closure = collectUpdateRuntimeClosure(ROOT);
        for (const required of ['scripts/build-provenance.mjs', 'scripts/client-build-atomic.mjs', 'scripts/server-build-atomic.mjs',
            'scripts/source-update-candidate.mjs', 'scripts/lib/source-update-activation.mjs', 'scripts/local-preview-ledger.mjs',
            'scripts/local-preview-server-activation.mjs', 'scripts/lib/permission-release-contract.mjs',
            'scripts/safe-restart.sh']) assert.ok(closure.includes(required), required);
        const installed = installUpdateRuntimeBundle(ROOT, out);
        assert.equal(installed.manifest.schemaVersion, 2);
        assert.equal(computeUpdateRuntimeBuildId(installed.manifest.files), installed.manifest.buildId);
        assert.equal(verifyUpdateRuntimeBundle(out).manifest.buildId, installed.manifest.buildId);
        assert.equal(verifyUpdateRuntimeBundle(path.relative(process.cwd(), out)).manifest.buildId,
            installed.manifest.buildId, 'relative artifact paths verify the same closure');
        const releaseInstalled = installUpdateRuntimeBundle(ROOT, releaseOut);
        assert.deepEqual(releaseInstalled.manifest, installed.manifest, 'normal and release builds consume one deterministic bundle source');
        const executable = installed.manifest.files.find((entry) => entry.path === 'scripts/safe-restart.sh');
        assert.ok(executable.mode & 0o100);
        chmodSync(path.join(out, 'UPDATE_RUNTIME_BUNDLE', 'scripts', 'safe-restart.sh'), 0o644);
        assert.throws(() => verifyUpdateRuntimeBundle(out), /fingerprint mismatch/);
    } finally { rmSync(out, { recursive: true, force: true }); rmSync(releaseOut, { recursive: true, force: true }); }
});

test('update runtime identity canonicalizes checkout modes independently of umask', () => {
    const source = temporary(); const out = temporary();
    try {
        writeFileSync(path.join(source, 'entry.mjs'), "import './tool.mjs';\n");
        writeFileSync(path.join(source, 'tool.mjs'), 'export const ready = true;\n');
        chmodSync(path.join(source, 'entry.mjs'), 0o664);
        chmodSync(path.join(source, 'tool.mjs'), 0o775);
        const installed = installUpdateRuntimeBundle(source, out, { entries: ['entry.mjs'] });
        assert.deepEqual(installed.manifest.files.map(({ path: file, mode }) => [file, mode]), [
            ['entry.mjs', 0o644],
            ['tool.mjs', 0o755],
        ]);
        assert.equal(verifyUpdateRuntimeBundle(out).manifest.buildId, installed.manifest.buildId);
    } finally { rmSync(source, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

test('server candidate runtime imports are self-contained when source scripts are absent', async () => {
    const artifact = temporary();
    try {
        const installed = installUpdateRuntimeBundle(ROOT, artifact);
        materializeUpdateRuntimeImports(artifact, installed);
        const imported = await import(`${pathToFileURL(path.join(artifact, 'scripts/lib/update-runtime-capability.mjs')).href}?fixture=${Date.now()}`);
        assert.equal(typeof imported.detectUpdateStrategy, 'function');
        assert.equal(collectUpdateRuntimeClosure(ROOT).every((relative) => readFileSync(path.join(artifact, relative)).equals(
            readFileSync(path.join(artifact, 'UPDATE_RUNTIME_BUNDLE', relative)))), true);
    } finally { rmSync(artifact, { recursive: true, force: true }); }
});

test('release asset builder emits one exact manifest whose tree hash includes normalized modes', () => {
    const source = temporary(); const output = temporary(); const extracted = temporary();
    try {
        mkdirSync(path.join(source, 'dist')); mkdirSync(path.join(source, 'dist-server')); mkdirSync(path.join(source, 'node_modules'));
        installCodexImageOnlyTestFixture(source);
        mkdirSync(path.join(source, 'node_modules', 'better-sqlite3'));
        writeFileSync(path.join(source, 'node_modules', 'better-sqlite3', 'package.json'),
            JSON.stringify({ name: 'better-sqlite3', version: '1.0.0', main: 'index.js' }));
        writeFileSync(path.join(source, 'node_modules', 'better-sqlite3', 'index.js'), 'module.exports = function Database() {};\n');
        mkdirSync(path.join(source, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), { recursive: true });
        writeFileSync(path.join(source, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
            JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '1.0.0', main: 'index.js' }));
        writeFileSync(path.join(source, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'index.js'), 'export {};\n');
        const tool = path.join(source, 'node_modules', 'fixture-tool');
        mkdirSync(path.join(tool, 'bin'), { recursive: true }); mkdirSync(path.join(source, 'node_modules', '.bin'));
        writeFileSync(path.join(tool, 'package.json'), JSON.stringify({ name: 'fixture-tool', version: '1.0.0', bin: { fixture: 'bin/cli.js' } }));
        writeFileSync(path.join(tool, 'bin', 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
        symlinkSync('../fixture-tool/bin/cli.js', path.join(source, 'node_modules', '.bin', 'fixture'));
        mkdirSync(path.join(source, 'server/bin'), { recursive: true });
        cpSync(path.join(ROOT, 'server/bin/claude'), path.join(source, 'server/bin/claude'));
        const installed = installUpdateRuntimeBundle(ROOT, path.join(source, 'dist-server'));
        materializeUpdateRuntimeImports(path.join(source, 'dist-server'), installed);
        mkdirSync(path.join(source, 'dist-server', 'server', 'services', 'isolation'), { recursive: true });
        writeFileSync(path.join(source, 'dist-server', 'server', 'services', 'isolation', 'managed-claude-launcher.js'), 'export {};\n');
        writeFileSync(path.join(source, 'dist-server', 'server', 'runtime-imports.js'),
            "import 'better-sqlite3'; import '@anthropic-ai/claude-agent-sdk'; import 'fixture-tool';\n");
        mkdirSync(path.join(source, 'dist-server', 'server', 'scripts'), { recursive: true });
        writeFileSync(path.join(source, 'dist-server', 'server', 'scripts', 'release-database-migration.js'),
            "import fs from 'node:fs';\nif (!fs) throw new Error('unreachable');\n");
        const provenance = { version: '1.44.0.1', commit: 'b'.repeat(40), buildId: 'd'.repeat(64) };
        writeFileSync(path.join(source, 'dist', 'BUILD_PROVENANCE.json'), JSON.stringify(provenance));
        writeFileSync(path.join(source, 'dist-server', 'BUILD_PROVENANCE.json'), JSON.stringify(provenance));
        writeFileSync(path.join(source, 'package.json'), '{}\n');
        writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
            '': {},
            'node_modules/@openai/codex-sdk': { version: '0.153.2', integrity: 'sha512-YQ==' },
            'node_modules/@anthropic-ai/claude-agent-sdk': { version: '1.0.0', integrity: 'sha512-YQ==' },
            'node_modules/better-sqlite3': { version: '1.0.0', integrity: 'sha512-Yg==' },
            'node_modules/fixture-tool': { version: '1.0.0', integrity: 'sha512-Yw==' },
        } }));
        const result = buildReleaseAsset({ sourceRoot: source, outputDirectory: output, temporaryRoot: output,
            version: '1.44.0.1', commit: 'b'.repeat(40), repo: 'AlKindy-OSS/nassaj', releaseId: 22 }, {
            runtimeRoots: () => ['@openai/codex-sdk', '@anthropic-ai/claude-agent-sdk', 'better-sqlite3', 'fixture-tool'], runtimeSmoke: () => true,
            clientToolchainRoots: ['fixture-tool'],
            buildTarget: NODE24_RUNTIME, runtimeTarget: NODE24_RUNTIME, runtimeHost: RELEASE_HOST,
            predecessorMatrix: { targetSchemaDigest: 'a'.repeat(64), acceptedPredecessors: [{ schemaDigest: 'b'.repeat(64),
                compatibilityShapeDigest: 'c'.repeat(64), migrationStateDigest: 'd'.repeat(64),
                targetCompatibilityShapeDigest: 'e'.repeat(64), targetMigrationStateDigest: 'f'.repeat(64) }] },
        });
        assert.equal(readFileSync(result.publishedManifest, 'utf8'), `${JSON.stringify(result.manifest, null, 2)}\n`);
        assert.equal(result.manifest.sourceTreeSha256, computeReleaseFileTreeSha256(result.manifest.files));
        assert.equal(result.manifest.files.every((file) => [0o644, 0o755].includes(file.mode)), true);
        assert.equal(result.manifest.npmBinLinksExcluded.count, 1);
        assert.equal(result.manifest.npmBinLinksExcluded.records[0].link, 'node_modules/.bin/fixture');
        assert.equal(result.manifest.runtimeClosure.schemaVersion, 2);
        assert.deepEqual(result.manifest.runtimeClosure.clientToolchainRoots, ['fixture-tool']);
        assert.throws(() => validateFixtureManifest({
            ...result.manifest,
            runtimeClosure: { ...result.manifest.runtimeClosure, roots: ['@anthropic-ai/claude-agent-sdk', 'better-sqlite3'] },
        }, { repo: 'AlKindy-OSS/nassaj', releaseId: 22, tag: 'v1.44.0.1',
            version: '1.44.0.1', commit: 'b'.repeat(40) }), /roots are not bound/);
        extractTarGzExact(readFileSync(result.asset), extracted);
        assert.equal(existsSync(path.join(extracted, 'node_modules', '.bin')), false);
        assert.equal(existsSync(path.join(extracted, 'node_modules', 'fixture-tool', 'bin', 'cli.js')), true);
        assert.equal(existsSync(path.join(extracted, 'dist-server', 'server', 'services', 'isolation', 'managed-claude-launcher.js')), true);
        const runtimeRequire = createRequire(path.join(extracted, 'package.json'));
        assert.equal(typeof runtimeRequire('better-sqlite3'), 'function');
        assert.equal(typeof runtimeRequire.resolve('@anthropic-ai/claude-agent-sdk'), 'string');
        assert.equal(verifyExtractedReleaseAsset(extracted, { repo: 'AlKindy-OSS/nassaj', releaseId: 22,
            tag: 'v1.44.0.1', version: '1.44.0.1', commit: 'b'.repeat(40) },
        { runtimeTarget: NODE24_RUNTIME }).manifest.serverBuildId, 'd'.repeat(64));
        assert.equal(validateFixtureManifest(JSON.parse(readFileSync(path.join(extracted, 'RELEASE_ASSET_MANIFEST.json'))),
            { repo: 'AlKindy-OSS/nassaj', releaseId: 22, tag: 'v1.44.0.1', version: '1.44.0.1', commit: 'b'.repeat(40) }), true);
        const manifestPath = path.join(extracted, 'RELEASE_ASSET_MANIFEST.json');
        const v2 = JSON.parse(readFileSync(manifestPath));
        const prior = v2.databaseContract;
        v2.databaseContract = { schema: 'nassaj-database-release-contract/v2',
            releaseIdentitySha256: prior.releaseIdentitySha256,
            migrationEntrySha256: prior.migrationEntrySha256,
            migrationClosureSha256: prior.migrationClosureSha256, migrationClosure: {
                schema: prior.migrationClosure.schema, assetManifestBound: true, sha256: prior.migrationClosureSha256 },
            activationPolicy: 'compatible-forward', failurePolicy: 'maintenance-preserve-current-db',
            databasePolicy: 'existing-inode-no-restore', migrationId: 'permission-receipt-forward/v1',
            observationPolicy: 'permission-receipt-metadata/v1',
            source: { schemaDigest: '3'.repeat(64), compatibilityShapeDigest: '4'.repeat(64), migrationStateDigest: '5'.repeat(64) },
            target: { schemaDigest: '6'.repeat(64), compatibilityShapeDigest: '7'.repeat(64), migrationStateDigest: '8'.repeat(64) },
            startup: { policyId: 'existing-security-state/v1', closureSha256: '9'.repeat(64) } };
        for (const entry of STARTUP_ROOTS) {
            const destination = path.join(extracted, 'dist-server', entry);
            mkdirSync(path.dirname(destination), { recursive: true });
            writeFileSync(destination, entry === 'server/bootstrap-release-profile.js' ? FORWARD_PROFILE_MODULE : 'export {};\n');
            chmodSync(destination, 0o644);
        }
        const startup = collectForwardStartupMaterial(path.join(extracted, 'dist-server'),
            { packageLockFile: path.join(extracted, 'package-lock.json') });
        const startupBytes = Buffer.from(JSON.stringify(startup.material));
        writeFileSync(path.join(extracted, 'dist-server/STARTUP_CLOSURE.json'), startupBytes);
        // The manifest record below claims 0644; do not inherit the runner umask.
        chmodSync(path.join(extracted, 'dist-server/STARTUP_CLOSURE.json'), 0o644);
        v2.databaseContract.startup.closureSha256 = startup.sha256;
        const executableClosure = collectForwardExecutableClosure(ROOT);
        const executableFiles = executableClosure.files.map(({ path, mode, size, sha256 }) => ({ path, mode, size, sha256 }));
        for (const record of executableFiles) {
            const destination = path.join(extracted, record.path);
            mkdirSync(path.dirname(destination), { recursive: true });
            cpSync(path.join(ROOT, record.path), destination); chmodSync(destination, record.mode);
        }
        const anchorBytes = Buffer.from(JSON.stringify({ schema: 'nassaj-forward-executable-files/v1',
            roots: executableClosure.roots, files: executableFiles }));
        writeFileSync(path.join(extracted, FORWARD_EXECUTABLE_MANIFEST_PATH), anchorBytes, { mode: 0o644 });
        const records = new Map(v2.files.map(record => [record.path, record]));
        for (const { path, mode, size, sha256 } of [...executableFiles, ...startup.material.files]) {
            records.set(path, { path, mode, size, sha256 });
        }
        records.set('dist-server/STARTUP_CLOSURE.json', { path: 'dist-server/STARTUP_CLOSURE.json', mode: 0o644,
            size: startupBytes.length, sha256: createHash('sha256').update(startupBytes).digest('hex') });
        records.set(FORWARD_EXECUTABLE_MANIFEST_PATH, { path: FORWARD_EXECUTABLE_MANIFEST_PATH, mode: 0o644,
            size: anchorBytes.length, sha256: createHash('sha256').update(anchorBytes).digest('hex') });
        v2.files = [...records.values()].sort((a, b) => compareReleasePaths(a.path, b.path));
        v2.sourceTreeSha256 = computeReleaseFileTreeSha256(v2.files);
        writeFileSync(manifestPath, JSON.stringify(v2));
        const expected = { repo: v2.repo, releaseId: v2.releaseId, tag: v2.tag, version: v2.version, commit: v2.commit };
        assert.equal(verifyExtractedReleaseAsset(extracted, expected, { runtimeTarget: NODE24_RUNTIME,
            expectedStartupClosureSha256: startup.sha256 }).manifest.databaseContract.schema, 'nassaj-database-release-contract/v2');
        assert.throws(() => verifyExtractedReleaseAsset(extracted, expected, { runtimeTarget: NODE24_RUNTIME,
            expectedStartupClosureSha256: '0'.repeat(64) }), /database_release_contract_invalid/);
        assert.throws(() => verifyExtractedReleaseAsset(extracted, expected, { runtimeTarget: NODE24_RUNTIME }),
            /database_release_contract_invalid/);

    } finally { rmSync(source, { recursive: true, force: true }); rmSync(output, { recursive: true, force: true }); rmSync(extracted, { recursive: true, force: true }); }
});

function npmBinFixture() {
    const root = temporary(); const modules = path.join(root, 'node_modules'); const packageRoot = path.join(modules, 'tool');
    mkdirSync(path.join(packageRoot, 'bin'), { recursive: true }); mkdirSync(path.join(modules, '.bin'));
    writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'tool', bin: { tool: 'bin/cli.js' } }));
    writeFileSync(path.join(packageRoot, 'bin', 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
    symlinkSync('../tool/bin/cli.js', path.join(modules, '.bin', 'tool'));
    return { root, modules, packageRoot, farm: path.join(modules, '.bin'), link: path.join(modules, '.bin', 'tool') };
}

test('npm bin attestation accepts and excludes valid top-level and nested link farms', () => {
    const value = npmBinFixture();
    try {
        const nestedBase = path.join(value.modules, 'host', 'node_modules'); const nestedPackage = path.join(nestedBase, '@scope', 'nested');
        mkdirSync(path.join(nestedPackage, 'bin'), { recursive: true }); mkdirSync(path.join(nestedBase, '.bin'));
        writeFileSync(path.join(nestedPackage, 'package.json'), JSON.stringify({ name: '@scope/nested', bin: 'bin/run.js' }));
        writeFileSync(path.join(nestedPackage, 'bin', 'run.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
        symlinkSync('../@scope/nested/bin/run.js', path.join(nestedBase, '.bin', 'nested'));
        const attestation = attestNpmBinLinkFarms(value.modules);
        assert.equal(attestation.count, 2); assert.equal(attestation.records.length, 2);
        assert.deepEqual(attestation.records.map((record) => record.link),
            ['node_modules/.bin/tool', 'node_modules/host/node_modules/.bin/nested']);
        assert.match(attestation.sha256, /^[a-f0-9]{64}$/);
    } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test('release path ordering is locale-independent code-unit order for punctuation and scoped paths', () => {
    const paths = ['node_modules/.bin/_tool', 'node_modules/.bin/a',
        'node_modules/host/node_modules/.bin/scoped', 'node_modules/.bin/@tool', 'node_modules/.bin/-tool'];
    assert.deepEqual(paths.sort(compareReleasePaths), [
        'node_modules/.bin/-tool', 'node_modules/.bin/@tool', 'node_modules/.bin/_tool',
        'node_modules/.bin/a', 'node_modules/host/node_modules/.bin/scoped',
    ]);
});

test('npm bin attestation fails closed for malformed farms and targets', () => {
    const cases = [
        ['outside farm', (v) => symlinkSync('tool/bin/cli.js', path.join(v.modules, 'outside-link'))],
        ['absolute target', (v) => { rmSync(v.link); symlinkSync(path.join(v.packageRoot, 'bin', 'cli.js'), v.link); }],
        ['escaping target', (v) => { const outside = path.join(v.root, 'outside'); writeFileSync(outside, '#!/bin/sh\n', { mode: 0o755 }); rmSync(v.link); symlinkSync('../../outside', v.link); }],
        ['dangling target', (v) => { rmSync(v.link); symlinkSync('../tool/bin/missing.js', v.link); }],
        ['directory target', (v) => { writeFileSync(path.join(v.packageRoot, 'package.json'), JSON.stringify({ name: 'tool', bin: { tool: 'bin' } })); rmSync(v.link); symlinkSync('../tool/bin', v.link); }],
        ['non-symlink farm child', (v) => { rmSync(v.link); writeFileSync(v.link, 'plain'); }],
        ['non-executable target', (v) => chmodSync(path.join(v.packageRoot, 'bin', 'cli.js'), 0o644)],
        ['declaration mismatch', (v) => writeFileSync(path.join(v.packageRoot, 'package.json'), JSON.stringify({ name: 'tool', bin: { other: 'bin/cli.js' } }))],
    ];
    for (const [label, mutate] of cases) {
        const value = npmBinFixture();
        try { mutate(value); assert.throws(() => attestNpmBinLinkFarms(value.modules), undefined, label); }
        finally { rmSync(value.root, { recursive: true, force: true }); }
    }
});

test('capability is host-bound and legacy 1.44 transition is explicit', () => {
    const root = temporary();
    try {
        const artifact = path.join(root, 'artifact'); const control = path.join(root, 'control');
        mkdirSync(artifact); mkdirSync(control);
        installUpdateRuntimeBundle(ROOT, artifact);
        const value = createHostCapability({ artifactRoot: artifact, projectRoot: root, controlRoot: control,
            nodeInstanceId: 'fixture-node', createdByReleaseIdentitySha256: 'a'.repeat(64) });
        const marker = path.join(control, 'capability.json'); writeHostCapability(marker, value);
        assert.equal(resolveUpdateRuntimeEntry(artifact, 'scripts/source-update-candidate.mjs'),
            path.join(artifact, 'UPDATE_RUNTIME_BUNDLE', 'scripts/source-update-candidate.mjs'));
        assert.equal(detectUpdateStrategy({ artifactRoot: artifact, capabilityFile: marker,
            context: { projectRoot: root, controlRoot: control, nodeInstanceId: 'fixture-node' } }), 'artifact-runtime-v2');
        assert.equal(detectUpdateStrategy({ artifactRoot: artifact, capabilityFile: marker,
            context: { projectRoot: root, controlRoot: control, nodeInstanceId: 'other' } }), 'unsupported');
        const legacy = path.join(root, 'legacy'); mkdirSync(path.join(legacy, 'scripts'), { recursive: true });
        writeFileSync(path.join(legacy, 'scripts', 'source-update-candidate.mjs'), 'export {};\n');
        assert.equal(detectUpdateStrategy({ artifactRoot: legacy, capabilityFile: path.join(root, 'absent') }), 'legacy-1.44-unattested');
        assert.deepEqual(planBridgeTransition('legacy-1.44-unattested'), { mode: 'legacy-stages-v2', requiresBootstrapRestart: true, activationProtocol: 2 });
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy 1.44 capability bootstrap is explicit, current-bound and one-shot', () => {
    const root = temporary();
    try {
        const deploy = path.join(root, 'deploy'); const generation = path.join(deploy, 'releases', 'gen-144');
        const artifact = path.join(generation, 'dist-server'); const control = path.join(deploy, 'control');
        mkdirSync(artifact, { recursive: true }); mkdirSync(control); symlinkSync('releases/gen-144', path.join(deploy, 'current'));
        installUpdateRuntimeBundle(ROOT, artifact);
        mkdirSync(path.join(artifact, 'scripts')); writeFileSync(path.join(artifact, 'scripts', 'source-update-candidate.mjs'), 'export {};\n');
        writeFileSync(path.join(artifact, 'BUILD_PROVENANCE.json'), JSON.stringify({ version: '1.44.0.0',
            commit: 'b'.repeat(40), buildId: 'c'.repeat(64) }));
        const marker = path.join(control, 'host-capability.json');
        assert.throws(() => bootstrapLegacy144HostCapability({ authorization: 'wrong', deployRoot: deploy, artifactRoot: artifact,
            projectRoot: generation, controlRoot: control, capabilityFile: marker, nodeInstanceId: 'node-144' }), /not authorized/);
        assert.equal(bootstrapLegacy144HostCapability({ authorization: 'legacy-1.44-to-artifact-runtime-v2', deployRoot: deploy,
            artifactRoot: artifact, projectRoot: generation, controlRoot: control, capabilityFile: marker, nodeInstanceId: 'node-144' }).state, 'created');
        assert.equal(detectUpdateStrategy({ artifactRoot: artifact, capabilityFile: marker,
            context: { projectRoot: generation, controlRoot: control, nodeInstanceId: 'node-144' } }), 'artifact-runtime-v2');
        assert.throws(() => bootstrapLegacy144HostCapability({ authorization: 'legacy-1.44-to-artifact-runtime-v2', deployRoot: deploy,
            artifactRoot: artifact, projectRoot: generation, controlRoot: control, capabilityFile: marker, nodeInstanceId: 'node-144' }), /one-shot/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

function octal(value, length) { return `${value.toString(8).padStart(length - 1, '0')}\0`; }
function tar(entries) {
    const chunks = [];
    for (const entry of entries) {
        const header = Buffer.alloc(512); const body = Buffer.from(entry.body || '');
        header.write(entry.name, 0, 100); header.write(octal(entry.mode ?? 0o644, 8), 100, 8);
        header.write(octal(0, 8), 108, 8); header.write(octal(0, 8), 116, 8); header.write(octal(body.length, 12), 124, 12);
        header.write(octal(0, 12), 136, 12); header.fill(32, 148, 156); header[156] = (entry.type || '0').charCodeAt(0);
        header.write('ustar\0', 257, 6); header.write('00', 263, 2);
        let sum = 0; for (const byte of header) sum += byte; header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
        chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
    }
    chunks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(chunks));
}

test('exact public asset transport has no Authorization and hardened archive rejects adversarial entries', async () => {
    const calls = [];
    const bytes = tar([{ name: 'runtime/file.sh', body: '#!/bin/sh\n', mode: 0o755 }]);
    const fetchImpl = async (url, options) => {
        calls.push({ url: String(url), headers: options.headers });
        return calls.length === 1
            ? new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com/signed' } })
            : new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    };
    const downloaded = await downloadExactGithubAsset({ repo: 'AlKindy-OSS/nassaj', assetId: 9,
        expectedSize: bytes.length, expectedSha256: createHash('sha256').update(bytes).digest('hex'), fetchImpl });
    assert.deepEqual(downloaded, bytes); assert.equal(calls[0].headers.Authorization, undefined); assert.equal(calls[1].headers.Authorization, undefined);
    assert.equal(selectExactReleaseAsset({ id: 2, tag_name: 'v1', assets: [{ id: 9, name: 'runtime.tgz', state: 'uploaded', size: 3 }] },
        { releaseId: 2, tag: 'v1', name: 'runtime.tgz', assetId: 9 }).assetId, 9);
    assert.throws(() => selectExactReleaseAsset({ id: 2, tag_name: 'v1', assets: [{ id: 10, name: 'runtime.tgz', state: 'uploaded', size: 3 }] },
        { releaseId: 2, tag: 'v1', name: 'runtime.tgz', assetId: 9 }), /asset id/);
    const out = temporary(); try { extractTarGzExact(bytes, out); assert.equal(readFileSync(path.join(out, 'runtime/file.sh'), 'utf8'), '#!/bin/sh\n'); }
    finally { rmSync(out, { recursive: true, force: true }); }
    const unsafe = temporary(); const outside = temporary();
    try {
        symlinkSync(outside, path.join(unsafe, 'runtime'));
        assert.throws(() => extractTarGzExact(bytes, unsafe), /new empty owner-only/);
        assert.equal(readdirSync(outside).length, 0);
    } finally { rmSync(unsafe, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
    assert.throws(() => inspectTarGz(tar([{ name: '../escape', body: 'x' }])), /escapes|non-canonical/);
    assert.throws(() => inspectTarGz(tar([{ name: 'link', type: '2' }])), /forbidden/);
    assert.throws(() => inspectTarGz(tar([{ name: 'large', body: 'x'.repeat(4096) }]), { expandedBytes: 1024 }), /output length|expands|limit/i);
    const exactFiles = [{ path: 'runtime/file.sh', mode: 0o755, size: 10, sha256: 'c'.repeat(64) }];
    assert.equal(validateFixtureManifest({ schemaVersion: 2, updaterProtocol: 2, repo: 'AlKindy-OSS/nassaj', releaseId: 2,
        tag: 'v1.44.0.1', version: '1.44.0.1', commit: 'b'.repeat(40), bundleBuildId: 'e'.repeat(64),
        bundleManifestSha256: 'f'.repeat(64), sourceTreeSha256: computeReleaseFileTreeSha256(exactFiles), serverBuildId: '2'.repeat(64), clientBuildId: '3'.repeat(64),
        ...runtimeMetadata(), files: exactFiles },
    { repo: 'AlKindy-OSS/nassaj', releaseId: 2, tag: 'v1.44.0.1', version: '1.44.0.1', commit: 'b'.repeat(40) }), true);
});

test('schema-2 npm bin attestation accepts a missing legacy field but rejects strict tampering and limits', () => {
    const files = [{ path: 'runtime/file.sh', mode: 0o755, size: 10, sha256: 'c'.repeat(64) }];
    const expected = { repo: 'AlKindy-OSS/nassaj', releaseId: 2, tag: 'v1.44.0.1', version: '1.44.0.1', commit: 'b'.repeat(40) };
    const manifest = { schemaVersion: 2, updaterProtocol: 2, ...expected,
        bundleBuildId: 'e'.repeat(64), bundleManifestSha256: 'f'.repeat(64),
        sourceTreeSha256: computeReleaseFileTreeSha256(files), serverBuildId: '2'.repeat(64),
        clientBuildId: '3'.repeat(64), ...runtimeMetadata(), files };
    assert.equal(validateFixtureManifest(manifest, expected), true, 'legacy schema-2 manifests normalize a missing field to empty');
    assert.throws(() => validateFixtureManifest({ ...manifest, npmBinLinksExcluded: null }, expected));
    const validRecords = [
        { link: 'node_modules/.bin/-tool', package: 'tool', target: 'node_modules/tool/bin/cli.js' },
        { link: 'node_modules/host/node_modules/.bin/scoped', package: '@scope/pkg',
            target: 'node_modules/host/node_modules/@scope/pkg/bin/run.js' },
    ];
    assert.equal(validateFixtureManifest({ ...manifest, npmBinLinksExcluded: binAttestation(validRecords) }, expected), true);
    const tampered = [
        [{ ...validRecords[0], package: 'other' }],
        [{ ...validRecords[0], target: 'node_modules/other/bin/cli.js' }],
        [{ ...validRecords[0], target: 'node_modules/tool/.bin' }],
        [[validRecords[1], validRecords[0]]],
        [{ ...validRecords[0], package: 'Tool' }],
        [{ ...validRecords[0], target: `node_modules/tool/${'x'.repeat(129)}` }],
    ];
    for (const candidate of tampered) {
        const records = Array.isArray(candidate[0]) ? candidate[0] : candidate;
        assert.throws(() => validateFixtureManifest({ ...manifest, npmBinLinksExcluded: binAttestation(records) }, expected));
    }
    assert.throws(() => validateFixtureManifest({ ...manifest, npmBinLinksExcluded:
        { ...EMPTY_BIN_ATTESTATION, count: 20_001 } }, expected));
    assert.throws(() => validateFixtureManifest({ ...manifest, npmBinLinksExcluded:
        { count: 20_001, sha256: EMPTY_BIN_ATTESTATION.sha256, records: Array(20_001).fill(validRecords[0]) } }, expected));
});

test('permission release contract is additive for legacy schema-2 and strict once any field is present', () => {
    const serverBuildId = '2'.repeat(64);
    const legacy = { schemaVersion: 2, serverBuildId };
    assert.equal(validatePermissionReleaseContract(legacy), null);
    const contract = createMeasuredPermissionReleaseContract(serverBuildId);
    assert.equal(contract.permissionProfile, 'full_delegation');
    assert.equal(contract.minimumPermissionBuild, serverBuildId);
    assert.equal(validatePermissionReleaseContract({ ...legacy, ...contract })?.permissionCapabilityDigest,
        contract.permissionCapabilityDigest);
    const generationTwo = createMeasuredPermissionReleaseContract(serverBuildId, 2);
    assert.equal(generationTwo.permissionProtocolGeneration, 2);
    assert.notEqual(generationTwo.permissionCapabilityDigest, contract.permissionCapabilityDigest);
    assert.equal(validatePermissionReleaseContract({ ...legacy, ...generationTwo })?.permissionProtocolGeneration, 2);
    assert.throws(() => validatePermissionReleaseContract({ ...legacy, ...generationTwo,
        permissionProtocolGeneration: 1 }), /digest mismatch/);
    assert.throws(() => validatePermissionReleaseContract({ ...legacy,
        permissionProfile: contract.permissionProfile }), /identity mismatch/);
    for (const field of ['permissionProfileDigest', 'permissionCapabilityDigest']) {
        assert.throws(() => validatePermissionReleaseContract({ ...legacy, ...contract,
            [field]: `sha256:${'f'.repeat(64)}` }), /digest mismatch/);
    }
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => validatePermissionReleaseContract({ ...legacy, ...contract,
            permissionProtocolGeneration: invalid }), /identity mismatch/);
    }
    assert.throws(() => validatePermissionReleaseContract({ ...legacy, ...contract,
        minimumPermissionBuild: '3'.repeat(64) }), /identity mismatch/);
    assert.throws(() => validatePermissionReleaseContract({ ...legacy, ...contract,
        serverBuildId: '3'.repeat(64) }), /identity mismatch|digest mismatch/);
});

test('release manifest rejects incompatible Node engines and native alias identity drift', () => {
    const files = [{ path: 'runtime/file.sh', mode: 0o755, size: 10, sha256: 'c'.repeat(64) }];
    const expected = { repo: 'AlKindy-OSS/nassaj', releaseId: 2, tag: 'v1.44.0.1', version: '1.44.0.1', commit: 'b'.repeat(40) };
    const manifest = (packages) => ({ schemaVersion: 2, updaterProtocol: 2, ...expected,
        bundleBuildId: 'e'.repeat(64), bundleManifestSha256: 'f'.repeat(64),
        sourceTreeSha256: computeReleaseFileTreeSha256(files), serverBuildId: '2'.repeat(64), clientBuildId: '3'.repeat(64),
        ...runtimeMetadata(packages), files });
    const base = { path: 'node_modules/runtime-fixture', name: 'runtime-fixture', resolvedName: 'runtime-fixture',
        version: '1.0.0', integrity: 'sha512-YQ==', enginesNode: null, os: null, cpu: null, libc: null,
        native: false, packageJsonSha256: '9'.repeat(64) };
    assert.throws(() => validateFixtureManifest(manifest([{ ...base, enginesNode: '<1' }]), expected), /Node engine mismatch/);
    assert.throws(() => validateFixtureManifest(manifest([{ ...base, name: '@vscode/ripgrep',
        resolvedName: 'unknown-native', native: true }]), expected), /closure is invalid/);
});

test('release runtime accepts Node 24 minor drift and rejects major, ABI and glibc floor drift', () => {
    const files = [{ path: 'runtime/file.sh', mode: 0o755, size: 10, sha256: 'c'.repeat(64) }];
    const expected = { repo: 'AlKindy-OSS/nassaj', releaseId: 2, tag: 'v1.44.0.1', version: '1.44.0.1', commit: 'b'.repeat(40) };
    const base = { schemaVersion: 2, updaterProtocol: 2, ...expected,
        bundleBuildId: 'e'.repeat(64), bundleManifestSha256: 'f'.repeat(64),
        sourceTreeSha256: computeReleaseFileTreeSha256(files), serverBuildId: '2'.repeat(64), clientBuildId: '3'.repeat(64),
        ...runtimeMetadata(), files };
    assert.equal(validateFixtureManifest({ ...base,
        targetRuntime: { ...base.targetRuntime, nodeVersion: 'v24.0.0' } }, expected), true);
    assert.throws(() => validateFixtureManifest(base, expected, NODE22_RUNTIME), /identity mismatch/);
    assert.throws(() => validateFixtureManifest({ ...base,
        targetRuntime: { ...base.targetRuntime, nodeVersion: 'v25.0.0', nodeMajor: 25 } }, expected), /identity mismatch/);
    assert.throws(() => validateFixtureManifest({ ...base,
        targetRuntime: { ...base.targetRuntime, nodeModulesAbi: '127' } }, expected), /identity mismatch/);
    if (base.targetRuntime.libcFamily === 'glibc') {
        assert.throws(() => validateFixtureManifest({ ...base,
            targetRuntime: { ...base.targetRuntime, glibcMinimum: '999.0' } }, expected), /identity mismatch/);
    }
});

test('fd-relative extraction root cannot be redirected by swapping its pathname ancestors', () => {
    const parent = temporary();
    try {
        const root = path.join(parent, 'staging'); const held = path.join(parent, 'held'); mkdirSync(root, { mode: 0o700 });
        const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
            renameSync(root, held); mkdirSync(root, { mode: 0o700 });
            writeFileSync(path.join('/proc/self/fd', String(fd), 'proof'), 'bound-to-fd', { flag: 'wx' });
            assert.equal(readFileSync(path.join(held, 'proof'), 'utf8'), 'bound-to-fd');
            assert.equal(readdirSync(root).length, 0);
        } finally { closeSync(fd); }
    } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('extractor holds every internal ancestor fd across a swap to an external symlink', () => {
    const root = temporary(); const outside = temporary();
    try {
        const bytes = tar([{ name: 'runtime/nested/file.txt', body: 'secret-safe' }]);
        let swapped = false;
        assert.throws(() => extractTarGzExact(bytes, root, { testHooks: { beforeLeafOpen({ entry }) {
            if (swapped || entry !== 'runtime/nested/file.txt') return;
            swapped = true;
            renameSync(path.join(root, 'runtime'), path.join(root, 'held-runtime'));
            symlinkSync(outside, path.join(root, 'runtime'));
        } } }), /parent|ENOTDIR|ELOOP/i);
        assert.equal(swapped, true);
        assert.equal(readdirSync(outside).length, 0);
        assert.equal(readFileSync(path.join(root, 'held-runtime/nested/file.txt'), 'utf8'), 'secret-safe');
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('janitor preserves refs, newest two and retention, and journals planned/done under one lock', () => {
    const root = temporary();
    try {
        mkdirSync(path.join(root, 'generations')); mkdirSync(path.join(root, 'refs'));
        const now = Date.parse('2026-08-19T00:00:00Z');
        const add = (id, days, state = 'sealed') => { const dir = path.join(root, 'generations', id); mkdirSync(dir);
            writeFileSync(path.join(dir, 'runtime-generation.json'), JSON.stringify({ createdAt: new Date(now - days * 86400000).toISOString(), state })); };
        add('newest', 1); add('second', 2); add('old-ref', 30); add('old-delete', 31); add('failed-delete', 15, 'failed');
        createRuntimeReference(root, 'manual', 'pin', 'old-ref');
        assert.deepEqual([...collectRuntimeReferences(root)], ['old-ref']);
        assert.throws(() => pruneUpdateRuntime(root, { now, afterTombstoneRename(id) { if (id === 'failed-delete') throw new Error('simulated-crash'); } }), /simulated-crash/);
        assert.ok(readdirSync(path.join(root, 'generations')).some((name) => name.startsWith('.deleting-failed-delete-')));
        const removed = pruneUpdateRuntime(root, { now });
        assert.deepEqual(removed, ['old-delete']);
        assert.equal(readdirSync(path.join(root, 'generations')).some((name) => name.startsWith('.deleting-')), false);
        assert.match(readFileSync(path.join(root, 'janitor-tombstones.jsonl'), 'utf8'), /"state":"planned"[\s\S]*"resumed":true/);
        withUpdateRuntimeLock(root, () => assert.throws(() => withUpdateRuntimeLock(root, () => {}), /lock is held/));
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('janitor refuses unresolved nonterminal jobs and preserves resolved live transaction refs', () => {
    const root = temporary();
    try {
        mkdirSync(path.join(root, 'generations')); mkdirSync(path.join(root, 'refs'));
        const now = Date.parse('2026-08-19T00:00:00Z');
        for (const [id, days, state = 'sealed'] of [['new', 1], ['second', 2], ['active-tx', 30], ['unsafe-active', 31, 'activating'],
            ['manual-recovery', 40, 'manual_recovery_required']]) {
            const dir = path.join(root, 'generations', id); mkdirSync(dir);
            writeFileSync(path.join(dir, 'runtime-generation.json'), JSON.stringify({ createdAt: new Date(now - days * 86400000).toISOString(), state }));
        }
        assert.throws(() => pruneUpdateRuntime(root, { now, loadLiveReferences: () => [{ jobId: 'job-1', state: 'accepted', transactionId: null }] }),
            (error) => error.code === 'update_runtime_nonterminal_unresolved');
        assert.equal(readdirSync(path.join(root, 'generations')).includes('active-tx'), true);
        assert.deepEqual(pruneUpdateRuntime(root, { now, loadLiveReferences: () => [{ jobId: 'job-1', state: 'staging', transactionId: 'active-tx' }] }), []);
        const manualIdentity = { jobId: 'job-manual', state: 'manual_recovery_required', transactionId: 'manual-recovery',
            activationIdentitySha256: 'a'.repeat(64), releaseCommit: 'b'.repeat(40), sourceTreeSha256: 'c'.repeat(64),
            assetSha256: 'd'.repeat(64), archiveSha256: 'e'.repeat(64), serverBuildId: 'f'.repeat(64),
            clientBuildId: '1'.repeat(64), releaseId: '7', assetId: '9' };
        assert.deepEqual(pruneUpdateRuntime(root, { now, loadLiveReferences: () => [manualIdentity] }), ['active-tx']);
        assert.throws(() => pruneUpdateRuntime(root, { now, loadLiveReferences: () => [{ ...manualIdentity, sourceTreeSha256: null }] }),
            (error) => error.code === 'update_runtime_manual_identity_unresolved');
        assert.equal(readdirSync(path.join(root, 'generations')).includes('unsafe-active'), true);
        assert.equal(readdirSync(path.join(root, 'generations')).includes('manual-recovery'), true);
        const lock = path.join(root, '.update-runtime.lock'); mkdirSync(lock);
        writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 99999999, startTicks: '1',
            bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), nonce: 'dead-owner' }));
        assert.equal(withUpdateRuntimeLock(root, () => 'recovered'), 'recovered');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('janitor restores a crash tombstone that becomes manual-recovery protected before resume', () => {
    const root = temporary();
    try {
        mkdirSync(path.join(root, 'generations')); mkdirSync(path.join(root, 'refs'));
        const now = Date.parse('2026-08-19T00:00:00Z');
        for (const [id, days] of [['new', 1], ['second', 2], ['manual-crash', 30]]) {
            const directory = path.join(root, 'generations', id); mkdirSync(directory);
            writeFileSync(path.join(directory, 'runtime-generation.json'), JSON.stringify({
                createdAt: new Date(now - days * 86400000).toISOString(), state: 'failed',
            }));
        }
        assert.throws(() => pruneUpdateRuntime(root, { now,
            afterTombstoneRename(id) { if (id === 'manual-crash') throw new Error('crash-before-delete'); } }), /crash-before-delete/);
        assert.deepEqual(pruneUpdateRuntime(root, { now, loadLiveReferences: () => [{ jobId: 'job-manual',
            state: 'manual_recovery_required', transactionId: 'manual-crash', activationIdentitySha256: 'a'.repeat(64),
            releaseCommit: 'b'.repeat(40), sourceTreeSha256: 'c'.repeat(64), assetSha256: 'd'.repeat(64),
            archiveSha256: 'e'.repeat(64), serverBuildId: 'f'.repeat(64), clientBuildId: '1'.repeat(64),
            releaseId: 2, assetId: 7 }] }), []);
        assert.equal(readdirSync(path.join(root, 'generations')).includes('manual-crash'), true);
        const journal = readFileSync(path.join(root, 'janitor-tombstones.jsonl'), 'utf8');
        assert.match(journal, /"state":"protected-manual"/); assert.match(journal, /"state":"restored"/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('release-layout adapter is fail-closed and production orchestrator wires jobs and fenced asset operations', async () => {
    const root = temporary();
    try {
        const deploy = path.join(root, 'deploy'); const releases = path.join(deploy, 'releases');
        const generation = path.join(releases, 'gen-current'); const artifact = path.join(generation, 'dist-server');
        const control = path.join(deploy, 'control');
        mkdirSync(artifact, { recursive: true }); mkdirSync(control); mkdirSync(path.join(control, 'refs'));
        symlinkSync('releases/gen-current', path.join(deploy, 'current'));
        installUpdateRuntimeBundle(ROOT, artifact);
        const marker = path.join(control, 'host-capability.json');
        writeHostCapability(marker, createHostCapability({ artifactRoot: artifact, projectRoot: generation, controlRoot: control,
            nodeInstanceId: 'node-fixture', createdByReleaseIdentitySha256: 'a'.repeat(64) }));
        const layoutOptions = { deployRoot: deploy, projectRoot: generation, artifactRoot: artifact, controlRoot: control,
            capabilityFile: marker, nodeInstanceId: 'node-fixture' };
        assert.equal(inspectReleaseLayout(layoutOptions).ready, true);
        assert.equal(inspectReleaseLayout({ ...layoutOptions, nodeInstanceId: 'wrong' }).ready, false);
        const bundleManifest = Buffer.from(JSON.stringify({ buildId: 'e'.repeat(64) }));
        const script = Buffer.from('#!/bin/sh\n');
        const runtimePackage = Buffer.from(JSON.stringify({ name: 'runtime-fixture', version: '1.0.0' }));
        const runtimeLock = Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: {
            'node_modules/runtime-fixture': { version: '1.0.0', integrity: 'sha512-YQ==' },
        } }));
        const closurePackages = [{ path: 'node_modules/runtime-fixture', name: 'runtime-fixture', version: '1.0.0',
            resolvedName: 'runtime-fixture', integrity: 'sha512-YQ==', enginesNode: null, os: null, cpu: null, libc: null,
            native: false, packageJsonSha256: createHash('sha256').update(runtimePackage).digest('hex') }];
        const releaseFiles = [
            { path: 'dist-server/UPDATE_RUNTIME_MANIFEST.json', mode: 0o644, size: bundleManifest.length, sha256: createHash('sha256').update(bundleManifest).digest('hex') },
            { path: 'node_modules/runtime-fixture/package.json', mode: 0o644, size: runtimePackage.length,
                sha256: createHash('sha256').update(runtimePackage).digest('hex') },
            { path: 'package-lock.json', mode: 0o644, size: runtimeLock.length,
                sha256: createHash('sha256').update(runtimeLock).digest('hex') },
            { path: 'runtime/file.sh', mode: 0o755, size: script.length, sha256: createHash('sha256').update(script).digest('hex') },
        ].sort((left, right) => compareReleasePaths(left.path, right.path));
        const releaseManifest = withDatabaseContract({
            schemaVersion: 2, updaterProtocol: 2, repo: 'AlKindy-OSS/nassaj', releaseId: 2, tag: 'v1.44.0.2', version: '1.44.0.2',
            commit: 'b'.repeat(40), bundleBuildId: 'e'.repeat(64), bundleManifestSha256: createHash('sha256').update(bundleManifest).digest('hex'),
            runtimeCompatibility: RELEASE_RUNTIME_COMPATIBILITY,
            sourceTreeSha256: computeReleaseFileTreeSha256(releaseFiles), serverBuildId: '1'.repeat(64), clientBuildId: '2'.repeat(64),
            ...createMeasuredPermissionReleaseContract('1'.repeat(64), 2),
            ...runtimeMetadata(closurePackages), files: releaseFiles,
        });
        const archive = tar([
            { name: 'dist-server/UPDATE_RUNTIME_MANIFEST.json', body: bundleManifest, mode: 0o644 },
            { name: 'node_modules/runtime-fixture/package.json', body: runtimePackage, mode: 0o644 },
            { name: 'package-lock.json', body: runtimeLock, mode: 0o644 },
            { name: 'runtime/file.sh', body: script, mode: 0o755 },
            { name: 'RELEASE_ASSET_MANIFEST.json', body: JSON.stringify(releaseManifest), mode: 0o644 },
        ]);
        const runtime = createUpdateRuntimeOrchestrator({ layoutOptions,
            listRuntimeReferences: () => [{ jobId: 'job', state: 'accepted', transactionId: null }],
            fetchImpl: async () => new Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } }),
            runtimeTarget: NODE24_RUNTIME,
            runtimeHost: RELEASE_HOST,
        });
        assert.deepEqual(runtime.beforeWorkerClaim(), { state: 'deferred', code: 'update_runtime_nonterminal_unresolved', removed: [] });
        const checkpoints = []; let fences = 0;
        const result = await runtime.downloadAndExtractExactAsset({
            release: { id: 2, tag_name: 'v1.44.0.2', assets: [{ id: 7, name: 'runtime.tgz', state: 'uploaded', size: archive.length }] },
            expected: { ...releaseManifest, name: 'runtime.tgz', assetId: 7, assetSize: archive.length,
                assetSha256: createHash('sha256').update(archive).digest('hex'), generationId: 'gen-next', jobId: 'job-one' },
            token: 'secret', destination: path.join(releases, 'gen-next'),
            context: { assertFence: async () => { fences += 1; }, checkpoint: async (...args) => checkpoints.push(args) },
        });
        assert.equal(fences, 4); assert.deepEqual(checkpoints.map(([phase]) => phase), ['downloading', 'archive_verified', 'extracting']);
        assert.equal(result.manifest.bundleBuildId, 'e'.repeat(64));
        const recoveredDownload = await runtime.downloadAndExtractExactAsset({
            release: { id: 2, tag_name: 'v1.44.0.2', assets: [{ id: 7, name: 'runtime.tgz', state: 'uploaded', size: archive.length }] },
            expected: { ...releaseManifest, name: 'runtime.tgz', assetId: 7, assetSize: archive.length,
                assetSha256: createHash('sha256').update(archive).digest('hex'), generationId: 'gen-next', jobId: 'job-one' },
            token: 'secret', destination: path.join(releases, 'gen-next'),
            context: { assertFence: async () => { fences += 1; }, checkpoint: async (...args) => checkpoints.push(args) },
        });
        assert.equal(recoveredDownload.recovered, true);
        const activationContext = { assertFence: async () => { fences += 1; }, checkpoint: async (...args) => checkpoints.push(args) };
        const sealed = await runtime.sealGeneration({ staging: recoveredDownload.staging, identity: recoveredDownload.identity, context: activationContext });
        assert.equal(sealed.action.schema, 'nassaj-release-layout-activation/v2');
        assert.equal(sealed.action.repository, 'AlKindy-OSS/nassaj'); assert.equal(sealed.action.releaseId, 2);
        assert.equal(sealed.action.permissionCapabilityDigest, releaseManifest.permissionCapabilityDigest);
        assert.equal(sealed.action.permissionProtocolGeneration, 2);
        assert.equal(sealed.identity.minimumPermissionBuild, releaseManifest.serverBuildId);
        assert.equal((await runtime.sealGeneration({ staging: recoveredDownload.staging, identity: recoveredDownload.identity, context: activationContext })).recovered, true);
        const activated = await runtime.activateGeneration({ action: sealed.action, context: activationContext });
        assert.equal(activated.current, 'gen-next'); assert.equal(readlinkSync(path.join(deploy, 'current')), 'releases/gen-next');
        const nextArtifact = path.join(releases, 'gen-next', 'dist-server'); rmSync(nextArtifact, { recursive: true, force: true }); mkdirSync(nextArtifact);
        installUpdateRuntimeBundle(ROOT, nextArtifact);
        const bridged = reconcileActivatedHostCapability({ deployRoot: deploy, artifactRoot: nextArtifact,
            projectRoot: path.join(releases, 'gen-next'), controlRoot: control, capabilityFile: marker,
            nodeInstanceId: 'node-fixture', action: sealed.action });
        assert.equal(bridged.state, 'renewed');
        assert.equal(reconcileActivatedHostCapability({ deployRoot: deploy, artifactRoot: nextArtifact,
            projectRoot: path.join(releases, 'gen-next'), controlRoot: control, capabilityFile: marker,
            nodeInstanceId: 'node-fixture', action: sealed.action }).state, 'unchanged');
        assert.equal((await runtime.activateGeneration({ action: sealed.action, context: activationContext })).recovered, true);
        const rolledBack = await runtime.rollbackGeneration({ action: sealed.action, context: activationContext });
        assert.equal(rolledBack.current, 'gen-current'); assert.equal(readlinkSync(path.join(deploy, 'current')), 'releases/gen-current');
        assert.equal(restoreHostCapability({ capabilityFile: marker, rollbackSnapshot: bridged.rollbackSnapshot, action: sealed.action }).state, 'restored');
        assert.equal(detectUpdateStrategy({ artifactRoot: artifact, capabilityFile: marker,
            context: { projectRoot: generation, controlRoot: control, nodeInstanceId: 'node-fixture' } }), 'artifact-runtime-v2');
        assert.equal((await runtime.rollbackGeneration({ action: sealed.action, context: activationContext })).state, 'already_rolled_back');
        assert.ok(readdirSync(path.join(control, 'receipts', 'job-one')).some((name) => name.includes('activate-done')));
    } finally { rmSync(root, { recursive: true, force: true }); }
});


test('compatible-forward contract has identical asset/runtime validation and requires independent startup binding', () => {
    const H = value => value.repeat(64);
    const expected = { repo:'AlKindy-OSS/nassaj',releaseId:2,tag:'v1.44.0.1',version:'1.44.0.1',commit:'b'.repeat(40) };
    const base=withDatabaseContract({schemaVersion:2,updaterProtocol:2,...expected,
        bundleBuildId:H('e'),bundleManifestSha256:H('f'),sourceTreeSha256:computeReleaseFileTreeSha256([]),
        serverBuildId:H('2'),clientBuildId:H('3'),...runtimeMetadata(),files:[]});
    base.databaseContract.preservationPolicySha256=DATABASE_PRESERVATION_POLICY_SHA256;
    const identity=base.databaseContract.releaseIdentitySha256;
    const contract={schema:'nassaj-database-release-contract/v2',releaseIdentitySha256:identity,
        migrationEntrySha256:H('1'),migrationClosureSha256:H('2'),migrationClosure:base.databaseContract.migrationClosure,
        activationPolicy:'compatible-forward',failurePolicy:'maintenance-preserve-current-db',databasePolicy:'existing-inode-no-restore',
        migrationId:'permission-receipt-forward/v1',observationPolicy:'permission-receipt-metadata/v1',
        source:{schemaDigest:H('3'),compatibilityShapeDigest:H('4'),migrationStateDigest:H('5')},
        target:{schemaDigest:H('6'),compatibilityShapeDigest:H('7'),migrationStateDigest:H('8')},
        startup:{policyId:'existing-security-state/v1',closureSha256:H('9')}};
    const validate = (value, closure=H('9')) => {
        const manifest={...base,databaseContract:value};
        const results=[() => validateReleaseAssetManifest(manifest,expected,{runtimeTarget:NODE24_RUNTIME,expectedStartupClosureSha256:closure}),
            () => validateDatabaseReleaseContract(manifest,identity,closure)];
        return results.map(run=>{try{run();return true;}catch{return false;}});
    };
    assert.deepEqual(validate(base.databaseContract),[true,true]);
    assert.deepEqual(validate(contract),[true,true]);
    for(const change of [{previousReleasePolicy:'restore_required'}, {unknown:true}, {releaseIdentitySha256:H('0')},
        {migrationEntrySha256:'invalid'}, {startup:{...contract.startup,closureSha256:H('0')}},
        {startup:{...contract.startup,extra:true}}, {source:{...contract.source,extra:true}},
        {target:contract.source}, {observationPolicy:'legacy'}, {migrationId:'other'},
        {databasePolicy:'restore'}, {migrationClosure:{...contract.migrationClosure,sha256:H('0')}},
        {migrationClosure:{...contract.migrationClosure,extra:true}}]) {
        assert.deepEqual(validate({...contract,...change}),[false,false]);
    }
    assert.deepEqual(validate({...base.databaseContract,activationPolicy:'compatible-forward'}),[false,false]);
    const v2={...base,databaseContract:contract};
    assert.throws(()=>validateReleaseAssetManifest(v2,expected,{runtimeTarget:NODE24_RUNTIME}));
    assert.throws(()=>validateDatabaseReleaseContract(v2,identity));
});
