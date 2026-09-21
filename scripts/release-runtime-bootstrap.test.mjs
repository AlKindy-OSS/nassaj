import { installCodexImageOnlyTestFixture } from './lib/codex-image-only-test-fixture.mjs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { cpSync, copyFileSync, existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';
import { createUpdateMaintenanceGate } from '../server/services/update-maintenance-gate.js';
import { bootstrapServer } from '../server/bootstrap.js';
import { requireReleaseLayout } from './lib/update-release-layout-adapter.mjs';
import { sealReleaseGeneration, activateReleaseGeneration } from './lib/update-release-layout-activation.mjs';
import { reconcileActivatedHostCapability } from './lib/update-runtime-capability.mjs';
import { createMeasuredPermissionReleaseContract } from './lib/permission-release-contract.mjs';
import { buildReleaseAsset } from './build-release-asset.mjs';
import { prepareInitialReleaseRuntime } from './bootstrap-release-runtime.mjs';
import { inspectSealedRelease, launchSealedRelease, releaseChildEnvironment, readReleaseRunStatus, readGitMaintenanceStatus, releaseFailureCode } from './nassaj-release-launcher.mjs';
import { installUpdateRuntimeBundle } from './lib/update-runtime-bundle.mjs';
import {
    RELEASE_RUNTIME_COMPATIBILITY, verifyReleaseRuntimeHost,
} from './lib/release-runtime-compatibility.mjs';
import { currentReleaseRuntimeTarget, validateReleaseAssetManifest } from './lib/update-release-asset.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = Object.freeze({ platform: 'linux', arch: 'x64', libc: '2.41', nodeMajor: 24, nodeModules: 137 });
const temporary = (prefix) => mkdtempSync(path.join(ROOT, '.artifacts', prefix));

function releaseFixture(bootstrapCode = 'process.exitCode = 0;\n') {
    const root = temporary('release-bootstrap-fixture-'); const source = path.join(root, 'source');
    const output = path.join(root, 'output'); mkdirSync(source); mkdirSync(output);
    mkdirSync(path.join(source, 'dist')); mkdirSync(path.join(source, 'dist-server')); mkdirSync(path.join(source, 'node_modules'));
    mkdirSync(path.join(source, 'dist-server', 'server'));
    mkdirSync(path.join(source, 'server/bin'), { recursive: true });
    copyFileSync(path.join(ROOT, 'server/bin/claude'), path.join(source, 'server/bin/claude'));
    mkdirSync(path.join(source, 'dist-server/server/services/isolation'), { recursive: true });
    writeFileSync(path.join(source, 'dist-server/server/services/isolation/managed-claude-launcher.js'), 'export {};\n');
    mkdirSync(path.join(source, 'dist-server', 'server', 'scripts'));
    writeFileSync(path.join(source, 'dist-server', 'server', 'bootstrap.js'), bootstrapCode);
    writeFileSync(path.join(source, 'dist-server', 'server', 'application.js'), 'export const fixture = true;\n');
    writeFileSync(path.join(source, 'dist-server', 'server', 'scripts', 'release-database-migration.js'),
        'process.exitCode = 0;\n');
    writeFileSync(path.join(source, 'dist', 'index.html'), '<!doctype html>\n');
    installCodexImageOnlyTestFixture(source);
    mkdirSync(path.join(source, 'node_modules', 'runtime-fixture'));
    writeFileSync(path.join(source, 'node_modules', 'runtime-fixture', 'package.json'),
        JSON.stringify({ name: 'runtime-fixture', version: '1.0.0', main: 'index.js' }));
    writeFileSync(path.join(source, 'node_modules', 'runtime-fixture', 'index.js'), 'module.exports = {};\n');
    const runtime = installUpdateRuntimeBundle(ROOT, path.join(source, 'dist-server'));
    const provenance = { version: '1.46.0.0', commit: 'b'.repeat(40), buildId: 'd'.repeat(64) };
    writeFileSync(path.join(source, 'dist', 'BUILD_PROVENANCE.json'), JSON.stringify(provenance));
    writeFileSync(path.join(source, 'dist-server', 'BUILD_PROVENANCE.json'), JSON.stringify(provenance));
    writeFileSync(path.join(source, 'package.json'), '{}\n');
    writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
        '': {}, 'node_modules/@openai/codex-sdk': { version: '0.153.2', integrity: 'sha512-YQ==' }, 'node_modules/runtime-fixture': { version: '1.0.0', integrity: 'sha512-YQ==' },
    } }));
    const runtimeTarget = currentReleaseRuntimeTarget();
    const built = buildReleaseAsset({ sourceRoot: source, outputDirectory: output, temporaryRoot: root,
        version: provenance.version, commit: provenance.commit, repo: 'AlKindy-OSS/nassaj', releaseId: 41,
        permissionProtocolGeneration: 2 }, {
        runtimeHost: HOST, runtimeRoots: () => ['@openai/codex-sdk', 'runtime-fixture'], clientToolchainRoots: [], runtimeSmoke: () => true,
        buildTarget: runtimeTarget, runtimeTarget, predecessorMatrix: { targetSchemaDigest: 'e'.repeat(64),
            acceptedPredecessors: [{ scenario: 'clean', schemaDigest: 'f'.repeat(64),
                compatibilityShapeDigest: 'a'.repeat(64), targetCompatibilityShapeDigest: 'b'.repeat(64),
                migrationStateDigest: 'c'.repeat(64), targetMigrationStateDigest: 'd'.repeat(64),
                targetMigrationState: 'clean', preservation: { before: {}, after: {} } }] },
    });
    assert.equal(built.manifest.bundleBuildId, runtime.manifest.buildId);
    assert.equal(built.manifest.permissionProfile, 'full_delegation');
    assert.equal(built.manifest.permissionProtocolGeneration, 2);
    assert.equal(built.manifest.minimumPermissionBuild, built.manifest.serverBuildId);
    return { root, ...built, expected: { repo: 'AlKindy-OSS/nassaj', releaseId: 41, assetId: 73,
        tag: 'v1.46.0.0', version: '1.46.0.0', commit: provenance.commit,
        assetSize: built.size, assetSha256: built.assetSha256 } };
}

test('runtime compatibility rejects ABI, Node major, libc and unknown contract changes', () => {
    assert.equal(verifyReleaseRuntimeHost(RELEASE_RUNTIME_COMPATIBILITY, HOST), true);
    for (const incompatible of [
        { ...HOST, nodeModules: 127 }, { ...HOST, nodeMajor: 22 }, { ...HOST, libc: '2.38' }, { ...HOST, arch: 'arm64' },
    ]) assert.throws(() => verifyReleaseRuntimeHost(RELEASE_RUNTIME_COMPATIBILITY, incompatible), /incompatible/);
    assert.throws(() => verifyReleaseRuntimeHost({ ...RELEASE_RUNTIME_COMPATIBILITY, extra: true }, HOST), /contract is invalid/);
});

test('initial bootstrap resumes after the sealed-generation checkpoint and remains prepare-only', () => {
    const fixture = releaseFixture(); const deployParent = temporary('release-bootstrap-deploy-');
    const deploy = path.join(deployParent, 'nassaj'); let injected = false;
    try {
        assert.throws(() => prepareInitialReleaseRuntime({ deployRoot: deploy, assetFile: fixture.asset,
            manifestFile: fixture.publishedManifest, nodeInstanceId: 'node-fixture', runtimeHost: HOST,
            expected: { ...fixture.expected, assetSha256: 'a'.repeat(64) },
        }), /caller-pinned identity|asset bytes/);
        assert.throws(() => prepareInitialReleaseRuntime({ deployRoot: deploy, assetFile: fixture.asset,
            manifestFile: fixture.publishedManifest, nodeInstanceId: 'node-fixture', runtimeHost: HOST, expected: fixture.expected,
            testHooks: { afterCheckpoint(phase) { if (!injected && phase === 'generation-sealed') { injected = true; throw new Error('simulated-crash'); } } },
        }), /simulated-crash/);
        const result = prepareInitialReleaseRuntime({ deployRoot: deploy, assetFile: fixture.asset,
            manifestFile: fixture.publishedManifest, nodeInstanceId: 'node-fixture', runtimeHost: HOST, expected: fixture.expected });
        assert.equal(result.state, 'prepared_not_activated'); assert.equal(result.healthVerified, false);
        assert.equal(result.serviceActivated, false); assert.equal(result.requiresServiceActivation, true);
        assert.equal(prepareInitialReleaseRuntime({ deployRoot: deploy, assetFile: fixture.asset,
            manifestFile: fixture.publishedManifest, nodeInstanceId: 'node-fixture', runtimeHost: HOST, expected: fixture.expected }).state, 'prepared_not_activated');
        const inspected = inspectSealedRelease({ deployRoot: deploy, nodeInstanceId: 'node-fixture', host: HOST });
        assert.equal(inspected.generationId, result.generationId);
        assert.equal(inspected.permissionContract.permissionCapabilityDigest,
            fixture.manifest.permissionCapabilityDigest);
        const generationFile = path.join(deploy, 'releases', result.generationId, 'runtime-generation.json');
        const generationBytes = readFileSync(generationFile);
        const mixedGeneration = JSON.parse(generationBytes);
        mixedGeneration.identity.permissionCapabilityDigest = `sha256:${'f'.repeat(64)}`;
        writeFileSync(generationFile, JSON.stringify(mixedGeneration), { mode: 0o600 });
        assert.throws(() => inspectSealedRelease({ deployRoot: deploy,
            nodeInstanceId: 'node-fixture', host: HOST }), /Generation seal/);
        writeFileSync(generationFile, generationBytes, { mode: 0o600 });
        const releaseManifestFile = path.join(deploy, 'releases', result.generationId, 'RELEASE_ASSET_MANIFEST.json');
        const releaseManifestBytes = readFileSync(releaseManifestFile);
        const downgradedManifest = JSON.parse(releaseManifestBytes);
        downgradedManifest.permissionProtocolGeneration = 1;
        writeFileSync(releaseManifestFile, JSON.stringify(downgradedManifest), { mode: 0o644 });
        assert.throws(() => inspectSealedRelease({ deployRoot: deploy,
            nodeInstanceId: 'node-fixture', host: HOST }), /Permission release contract/);
        writeFileSync(releaseManifestFile, releaseManifestBytes, { mode: 0o644 });
        const environment = releaseChildEnvironment(inspected, {
            NASSAJ_PERMISSION_PROFILE: 'forged', NASSAJ_PERMISSION_MANIFEST_SHA256: 'forged', KEEP: 'yes',
        });
        assert.equal(environment.NASSAJ_PERMISSION_PROFILE, 'full_delegation');
        assert.equal(environment.NASSAJ_PERMISSION_CAPABILITY_DIGEST,
            fixture.manifest.permissionCapabilityDigest);
        assert.equal(environment.NASSAJ_PERMISSION_MINIMUM_BUILD, fixture.manifest.serverBuildId);
        assert.equal(environment.NASSAJ_PERMISSION_PROTOCOL_GENERATION, '2');
        assert.equal(environment.NASSAJ_PERMISSION_MANIFEST_SHA256, inspected.manifestSha256);
        assert.equal(environment.KEEP, 'yes');
        const legacyEnvironment = releaseChildEnvironment({ externalEnvironment: {
            NASSAJ_PERMISSION_PROFILE: 'forged-external',
        }, permissionContract: null }, { NASSAJ_PERMISSION_PROFILE: 'forged-inherited', KEEP: 'yes' });
        assert.equal(legacyEnvironment.NASSAJ_PERMISSION_PROFILE, undefined);
        assert.equal(readFileSync(result.configFile, 'utf8'), '');
    } finally { rmSync(fixture.root, { recursive: true, force: true }); rmSync(deployParent, { recursive: true, force: true }); }
});

test('launcher fails closed on release tampering and current symlink escape', () => {
    const fixture = releaseFixture(); const deployParent = temporary('release-launcher-deploy-');
    const deploy = path.join(deployParent, 'nassaj');
    try {
        const result = prepareInitialReleaseRuntime({ deployRoot: deploy, assetFile: fixture.asset,
            manifestFile: fixture.publishedManifest, nodeInstanceId: 'node-fixture', runtimeHost: HOST, expected: fixture.expected });
        const bootstrap = path.join(deploy, 'releases', result.generationId, 'dist-server', 'server', 'bootstrap.js');
        writeFileSync(bootstrap, 'tampered\n');
        assert.throws(() => inspectSealedRelease({ deployRoot: deploy, nodeInstanceId: 'node-fixture', host: HOST }), /file tree was modified/);
        writeFileSync(bootstrap, 'process.exitCode = 0;\n');
        const config = path.join(deploy, 'config'); const outsideConfig = path.join(deployParent, 'outside-config');
        rmSync(config, { recursive: true }); mkdirSync(outsideConfig); symlinkSync(outsideConfig, config);
        assert.throws(() => inspectSealedRelease({ deployRoot: deploy, nodeInstanceId: 'node-fixture', host: HOST }), /config directory is unsafe/);
        unlinkSync(config); mkdirSync(config, { mode: 0o700 }); writeFileSync(path.join(config, 'nassaj.env'), '', { mode: 0o600 });
        chmodSync(path.join(config, 'nassaj.env'), 0o600);
        unlinkSync(path.join(deploy, 'current'));
        symlinkSync('../outside', path.join(deploy, 'current'));
        assert.throws(() => inspectSealedRelease({ deployRoot: deploy, nodeInstanceId: 'node-fixture', host: HOST }), /ENOENT|escapes/);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); rmSync(deployParent, { recursive: true, force: true }); }
});

test('release manifest validation rejects version traversal before a generation path is built', () => {
    const fixture = releaseFixture();
    try {
        const malicious = { ...fixture.manifest, version: '../escape', tag: 'v../escape' };
        assert.throws(() => validateReleaseAssetManifest(malicious, { ...fixture.expected,
            version: '../escape', tag: 'v../escape' }), /identity mismatch/);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});


async function compiledPermissionRegistry(directory) {
    for (const name of ['parity', 'types', 'validation', 'capability-registry']) {
        const relative = `server/modules/execution-permissions/${name}`;
        mkdirSync(path.dirname(path.join(directory, relative)), { recursive: true });
        writeFileSync(path.join(directory, `${relative}.js`), ts.transpileModule(readFileSync(path.join(ROOT, `${relative}.ts`), 'utf8'), {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText);
    }
    mkdirSync(path.join(directory, 'server/shared'), { recursive: true });
    copyFileSync(path.join(ROOT, 'server/shared/codex-executable.js'), path.join(directory, 'server/shared/codex-executable.js'));
    const fixture = 'server/modules/execution-permissions/fixtures/permission-capabilities.v1.json';
    mkdirSync(path.dirname(path.join(directory, fixture)), { recursive: true });
    copyFileSync(path.join(ROOT, fixture), path.join(directory, fixture));
    return import(pathToFileURL(path.join(directory, 'server/modules/execution-permissions/capability-registry.js')).href);
}

test('real launcher child agrees with current builder and compiled permission registry; bad seals never spawn', async () => {
    const code = "const fs = require('node:fs'); fs.writeFileSync(process.argv[2], JSON.stringify({ capability: process.env.NASSAJ_PERMISSION_CAPABILITY_DIGEST, generation: process.env.NASSAJ_PERMISSION_PROTOCOL_GENERATION }));\n";
    const fixture = releaseFixture(code); const deployParent = temporary('release-launcher-cross-proof-');
    const deploy = path.join(deployParent, 'nassaj'); const output = path.join(deployParent, 'child-env.json');
    try {
        const registry = await compiledPermissionRegistry(path.join(deployParent, 'compiled'));
        const contract = createMeasuredPermissionReleaseContract(fixture.manifest.serverBuildId, 2);
        assert.equal(contract.permissionCapabilityDigest, registry.computePermissionReleaseCapabilityDigest(
            fixture.manifest.serverBuildId, contract.permissionProfileDigest, 2));
        const prepared = prepareInitialReleaseRuntime({ deployRoot: deploy, assetFile: fixture.asset,
            manifestFile: fixture.publishedManifest, nodeInstanceId: 'node-fixture', runtimeHost: HOST, expected: fixture.expected });
        const options = { deployRoot: deploy, nodeInstanceId: 'node-fixture', host: HOST, args: [output] };
        assert.equal(inspectSealedRelease(options).permissionContract.permissionCapabilityDigest, contract.permissionCapabilityDigest);
        await launchSealedRelease(options);
        assert.deepEqual(JSON.parse(readFileSync(output)), { capability: contract.permissionCapabilityDigest, generation: '2' });
        unlinkSync(output);
        const manifestFile = path.join(deploy, 'releases', prepared.generationId, 'RELEASE_ASSET_MANIFEST.json');
        const manifest = JSON.parse(readFileSync(manifestFile)); manifest.permissionCapabilityDigest = `sha256:${'0'.repeat(64)}`;
        writeFileSync(manifestFile, JSON.stringify(manifest));
        await assert.rejects(launchSealedRelease(options), /Permission release contract identity mismatch/);
        assert.equal(existsSync(output), false);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); rmSync(deployParent, { recursive: true, force: true }); }
});

test('forward bootstrap rejects missing independent pins and default profile before deployment writes', () => {
    const fixture = releaseFixture(); const deploy = path.join(fixture.root, 'uncreated');
    const manifest = structuredClone(fixture.manifest);
    manifest.databaseContract.schema = 'nassaj-database-release-contract/v2';
    const detached = path.join(fixture.root, 'RELEASE_ASSET_MANIFEST.forward.json');
    writeFileSync(detached, JSON.stringify(manifest));
    const asset = path.join(fixture.root, `nassaj-runtime-forward-v${fixture.expected.version}.tar.gz`);
    copyFileSync(fixture.asset, asset);
    const options = { deployRoot: deploy, assetFile: asset, manifestFile: detached,
        nodeInstanceId: 'node-fixture', runtimeHost: HOST, expected: fixture.expected };
    try {
        assert.throws(() => prepareInitialReleaseRuntime(options), /Default bootstrap requires/);
        assert.throws(() => prepareInitialReleaseRuntime({ ...options, profile: 'forward' }), /independent profile/);
        const bytes = readFileSync(detached);
        const expected = { ...fixture.expected, profile: 'forward', assetName: path.basename(asset),
            detachedManifestName: path.basename(detached), detachedManifestId: fixture.expected.assetId,
            detachedManifestSize: bytes.length, detachedManifestSha256: createHash('sha256').update(bytes).digest('hex'),
            databaseContractSha256: 'a'.repeat(64), expectedStartupClosureSha256: 'b'.repeat(64) };
        assert.throws(() => prepareInitialReleaseRuntime({ ...options, profile: 'forward', expected }), /independent profile/);
        assert.equal(existsSync(deploy), false);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

async function unusedPort() {
    const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const HEALTH_BOOTSTRAP = `
import fs from 'node:fs'; import http from 'node:http';
const manifest = JSON.parse(fs.readFileSync('RELEASE_ASSET_MANIFEST.json'));
const server = http.createServer((req,res) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({
 status:'ok',service:'nassaj-server',normalAdmissionReady:true,pid:process.pid,sourceVersion:manifest.version,
 serverLoadedOid:manifest.commit,serverLoadedBuildId:manifest.serverBuildId,clientBuildIdServed:manifest.clientBuildId })); });
server.listen(Number(process.env.SERVER_PORT),'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`;
function preparedRunFixture(code = HEALTH_BOOTSTRAP) {
    const fixture = releaseFixture(code), deploy = path.join(fixture.root, 'deploy');
    const nodeInstanceId = 'node-12345678-1234-4234-8234-123456789abc';
    const prepared = prepareInitialReleaseRuntime({ deployRoot: deploy, assetFile: fixture.asset,
        manifestFile: fixture.publishedManifest, nodeInstanceId, expected: fixture.expected, runtimeHost: HOST });
    writeFileSync(path.join(prepared.controlRoot, 'installer-selection.json'), JSON.stringify(fixture.expected), { mode: 0o600 });
    writeFileSync(path.join(prepared.controlRoot, 'node-instance-id'), nodeInstanceId, { mode: 0o600 });
    return { ...fixture, prepared, deploy };
}
function launchFixture(fixture, port, timeout = 2000) {
    const runner = `import {launchSealedRelease} from ${JSON.stringify(pathToFileURL(path.join(ROOT,'scripts/nassaj-release-launcher.mjs')).href)};
    await launchSealedRelease({deployRoot:${JSON.stringify(fixture.deploy)}, mode:'run',port:${port},healthTimeoutMs:${timeout},onVerified:()=>process.stdout.write('VERIFIED\\n')});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', runner], { stdio: ['ignore','pipe','pipe'] });
    let output = '', error = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { error += bytes; });
    const completion = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, output, error })));
    return { child, completion, output: () => output };
}
async function awaitVerified(run) {
    const end = Date.now()+5000;
    while (!run.output().includes('VERIFIED') && Date.now()<end && run.child.exitCode === null) await new Promise(resolve=>setTimeout(resolve,20));
    assert.match(run.output(), /VERIFIED/);
}
test('fresh foreground run verifies, excludes a rival, stops and restarts the pinned generation', async () => {
    const fixture = preparedRunFixture(); let first, second;
    try {
        const port = await unusedPort(); first = launchFixture(fixture,port); await awaitVerified(first);
        const rival = launchFixture(fixture,port); const denied = await rival.completion;
        assert.equal(denied.code,1); assert.match(denied.error,/runtime_lock_contended/);
        first.child.kill('SIGTERM'); assert.equal((await first.completion).code,0);
        assert.equal(existsSync(path.join(fixture.prepared.controlRoot,'run.lock')),true);
        const stopped=JSON.parse(readFileSync(path.join(fixture.prepared.controlRoot,'run-status.json'))); assert.equal(stopped.state,'stopped');
        second=launchFixture(fixture,port); await awaitVerified(second); second.child.kill('SIGTERM'); assert.equal((await second.completion).code,0);
    } finally { first?.child.kill('SIGTERM'); second?.child.kill('SIGTERM'); rmSync(fixture.root,{recursive:true,force:true}); }
});
test('wrong health identity never reports verified and retains truthful failed status', async () => {
    const fixture=preparedRunFixture(HEALTH_BOOTSTRAP.replace('pid:process.pid','pid:1')); let run;
    try {
        run=launchFixture(fixture,await unusedPort(),250); const result=await run.completion;
        assert.equal(result.code,1); assert.doesNotMatch(result.output,/VERIFIED/);
        const receipt=JSON.parse(readFileSync(path.join(fixture.prepared.controlRoot,'run-status.json')));
        assert.equal(receipt.state,'failed'); assert.equal(receipt.failureCode,'runtime_health_not_verified');
        assert.equal(existsSync(path.join(fixture.prepared.controlRoot,'run.lock')),true);
    } finally { run?.child.kill('SIGTERM'); rmSync(fixture.root,{recursive:true,force:true}); }
});
test('early child exit and invalid ports do not become a successful run', async () => {
    const fixture=preparedRunFixture('process.exit(0);');
    try {
        const invalid=await launchFixture(fixture,0).completion; assert.equal(invalid.code,1);
        assert.equal(existsSync(path.join(fixture.prepared.controlRoot,'run.lock')),false);
        const early=await launchFixture(fixture,await unusedPort(),250).completion; assert.equal(early.code,1);
        assert.doesNotMatch(early.output,/VERIFIED/);
    } finally { rmSync(fixture.root,{recursive:true,force:true}); }
});

test('durable status treats stale running as interrupted and rejects unsafe or oversized receipts', () => {
    const root=temporary('run-status-'), control=path.join(root,'control'); mkdirSync(control,{mode:0o700});
    const file=path.join(control,'run-status.json');
    try {
        writeFileSync(path.join(control,'initial-bootstrap.json'),JSON.stringify({state:'prepared',phase:'prepared',generationId:'fixture'}),{mode:0o600});
        assert.equal(readReleaseRunStatus({deployRoot:root}).state,'prepared_not_activated');
        writeFileSync(file,JSON.stringify({schema:'nassaj-release-run/v1',state:'verified_running',child:{pid:99999999,startTicks:'1',bootId:'no'},secret:'excluded'}),{mode:0o600});
        const status=readReleaseRunStatus({deployRoot:root}); assert.equal(status.state,'interrupted'); assert.equal(status.healthVerified,false); assert.equal(status.secret,undefined);
        writeFileSync(file,' '.repeat(65537)); assert.throws(()=>readReleaseRunStatus({deployRoot:root}),/Unsafe/);
        unlinkSync(file); symlinkSync('initial-bootstrap.json',file); assert.throws(()=>readReleaseRunStatus({deployRoot:root}));
    } finally { rmSync(root,{recursive:true,force:true}); }
});

test('kernel run lock survives parent crash while child lives and permits restart after both exit', async () => {
    const fixture=preparedRunFixture(); let run, restarted, orphan;
    try {
        const port=await unusedPort(); run=launchFixture(fixture,port); await awaitVerified(run);
        orphan=JSON.parse(readFileSync(path.join(fixture.prepared.controlRoot,'run-status.json'))).child.pid;
        run.child.kill('SIGKILL'); await run.completion;
        const rival=await launchFixture(fixture,port).completion; assert.equal(rival.code,1); assert.match(rival.error,/runtime_lock_contended/);
        const status=readReleaseRunStatus({deployRoot:fixture.deploy}); assert.equal(status.ownerAlive,false); assert.equal(status.childAlive,true);
        process.kill(orphan,'SIGTERM'); await new Promise(resolve=>setTimeout(resolve,150));
        restarted=launchFixture(fixture,port); await awaitVerified(restarted); restarted.child.kill('SIGTERM'); assert.equal((await restarted.completion).code,0);
    } finally { run?.child.kill('SIGTERM'); restarted?.child.kill('SIGTERM'); if(orphan) try {process.kill(orphan,'SIGTERM');} catch {} rmSync(fixture.root,{recursive:true,force:true}); }
});
test('Git MANUAL diagnostics validate checksum and never expose tokens or permit retry', () => {
    const root=temporary('git-status-');
    try {
        const value={schema:'nassaj-source-update-maintenance/v1',state:'MANUAL',phase:'BOOTSTRAP_CLAIMED',sequence:3,
            transactionId:'transaction-12345678',gateClosed:true,tokenDigest:'private',updatedAt:new Date().toISOString()};
        const canonical=value=>value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')}}`:JSON.stringify(value);
        const record={...value,checksum:createHash('sha256').update(canonical(value)).digest('hex')};
        writeFileSync(path.join(root,'journal.json'),JSON.stringify(record),{mode:0o600});
        const status=readGitMaintenanceStatus({controlRoot:root}); assert.equal(status.state,'MANUAL'); assert.equal(status.automaticRetryAllowed,false); assert.equal(status.tokenDigest,undefined);
        record.state='OPEN'; writeFileSync(path.join(root,'journal.json'),JSON.stringify(record)); assert.throws(()=>readGitMaintenanceStatus({controlRoot:root}),/journal/);
        assert.equal(releaseFailureCode(new Error('secret /path root invalid')),'runtime_root_invalid');
        assert.equal(releaseFailureCode(new Error('runtime_lock_contended')),'runtime_lock_contended');
        assert.equal(releaseFailureCode(new Error('secret identity value')),'runtime_identity_mismatch');
    } finally {rmSync(root,{recursive:true,force:true});}
});

test('legacy launcher retains explicit argument forwarding', async () => {
    const fixture=releaseFixture("if(process.argv.slice(2).join(',') !== '--legacy-flag,value') process.exitCode=1;");
    const deploy=path.join(fixture.root,'deploy'); const previous=process.exitCode;
    try {
        prepareInitialReleaseRuntime({deployRoot:deploy,assetFile:fixture.asset,manifestFile:fixture.publishedManifest,nodeInstanceId:'node-fixture',expected:fixture.expected,runtimeHost:HOST});
        assert.equal(await launchSealedRelease({deployRoot:deploy,nodeInstanceId:'node-fixture',args:['--legacy-flag','value']}),0);
    } finally {process.exitCode=previous;rmSync(fixture.root,{recursive:true,force:true});}
});

function artifactEnvironment(fixture) {
    const env={NASSAJ_DEPLOY_ROOT:fixture.deploy,NASSAJ_UPDATE_CONTROL_ROOT:fixture.prepared.controlRoot,
        NASSAJ_UPDATE_CAPABILITY_FILE:fixture.prepared.capabilityFile,NASSAJ_NODE_INSTANCE_ID:'node-12345678-1234-4234-8234-123456789abc',
        DATABASE_PATH:path.join(fixture.prepared.dataRoot,'nassaj.db')};
    const prior=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
    return ()=>{for(const [key,value] of Object.entries(prior)) if(value===undefined) delete process.env[key]; else process.env[key]=value;};
}
test('real artifact gate admits initial no-Git layout and preserves MANUAL on restart', async () => {
    const fixture=preparedRunFixture();const restore=artifactEnvironment(fixture);
    try {
        const projectPath=path.join(fixture.deploy,'releases',fixture.prepared.generationId);
        const gate=createUpdateMaintenanceGate({projectPath}); assert.equal(gate.paths.commonGitDir,null);gate.assertArtifactStartup();
        const again=createUpdateMaintenanceGate({projectPath});assert.equal(again.readPublicStatus().state,'OPEN');
        const owner=await gate.beginUpdate({transactionId:'artifact-transaction-1234',originalHead:fixture.manifest.commit,targetCommit:fixture.manifest.commit,expectedVersion:fixture.manifest.version,
            artifact:{jobId:'job-fixture',nodeInstanceId:process.env.NASSAJ_NODE_INSTANCE_ID,activationIdentitySha256:'a'.repeat(64)}});
        owner.declareManual('test_containment');
        let imported=false;
        // Since C1 a closed gate is held in 503 maintenance instead of thrown; the stub stops the hold before any listen.
        await assert.rejects(bootstrapServer({projectPath,loadServer:()=>{imported=true;},serveMaintenance:async()=>{throw new Error('maintenance_held');}}),/maintenance_held/);
        assert.equal(imported,false); assert.equal(again.readPublicStatus().state,'MANUAL');
    } finally {restore();rmSync(fixture.root,{recursive:true,force:true});}
});
for (const outcome of ['complete','claim-process-crash']) test(`artifact seal/exchange and pre-import admission: ${outcome}`, async () => {
    const fixture=preparedRunFixture();const restore=artifactEnvironment(fixture);let owner,claim,run;
    try {
        const current=path.join(fixture.deploy,'releases',fixture.prepared.generationId);
        const gate=createUpdateMaintenanceGate({projectPath:current});
        const layout=requireReleaseLayout({deployRoot:fixture.deploy,projectRoot:current,artifactRoot:path.join(current,'dist-server'),
            controlRoot:fixture.prepared.controlRoot,capabilityFile:fixture.prepared.capabilityFile,nodeInstanceId:process.env.NASSAJ_NODE_INSTANCE_ID});
        const db=new DatabaseSync(process.env.DATABASE_PATH);db.exec('CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES (\'keep\')');db.close();chmodSync(process.env.DATABASE_PATH,0o600);
        const staging=path.join(fixture.root,'staging');cpSync(current,staging,{recursive:true});unlinkSync(path.join(staging,'runtime-generation.json'));
        const identity={...fixture.manifest,...fixture.expected,repository:fixture.manifest.repo,assetName:'nassaj-runtime-v1.46.0.0.tar.gz',
            strategy:'release-layout-v2',updaterProtocol:2,jobId:'job-artifact-12345678',generationId:'release-artifact-12345678',archiveSha256:fixture.expected.assetSha256};
        const context={assertFence(){},checkpoint(){}};
        const writer=await gate.acquireWriterLease({kind:'artifact-seal'});
        const sealed=await sealReleaseGeneration({layout,staging,identity,context});writer.release();
        owner=await gate.beginUpdate({transactionId:identity.generationId,originalHead:identity.commit,targetCommit:identity.commit,expectedVersion:identity.version,
            artifact:{jobId:identity.jobId,nodeInstanceId:process.env.NASSAJ_NODE_INSTANCE_ID,activationIdentitySha256:sealed.action.activationIdentitySha256}});
        const snapshot=owner.captureArtifactSnapshot();assert.equal(snapshot.phase,'CAPTURED');
        owner.transition(['PREPARED'],'ARTIFACT_ACTIVATING');await activateReleaseGeneration({layout,action:sealed.action,context});
        const target=path.join(layout.releasesRoot,identity.generationId);
        reconcileActivatedHostCapability({deployRoot:fixture.deploy,artifactRoot:path.join(target,'dist-server'),projectRoot:target,controlRoot:layout.controlRoot,
            capabilityFile:fixture.prepared.capabilityFile,nodeInstanceId:process.env.NASSAJ_NODE_INSTANCE_ID,action:sealed.action});
        owner.transition(['ARTIFACT_ACTIVATING'],'ARTIFACT_SWITCHED');const handoff=owner.prepareBootstrapHandoff(['ARTIFACT_SWITCHED']);owner.release();
        const next=createUpdateMaintenanceGate({projectPath:target});
        if(outcome==='claim-process-crash') {
            const script=`import {createUpdateMaintenanceGate} from ${JSON.stringify(pathToFileURL(path.join(ROOT,'server/services/update-maintenance-gate.js')).href)};
              const gate=createUpdateMaintenanceGate({projectPath:${JSON.stringify(target)}});
              await gate.claimBootstrapOwnership(${JSON.stringify({...handoff.descriptor,applicationPath:path.join(target,'dist-server','server','application.js')})});
              process.stdout.write('CLAIMED');setInterval(()=>{},1000);`;
            const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
            let output='';child.stdout.on('data',bytes=>{output+=bytes});const exited=new Promise(resolve=>child.once('exit',resolve));
            try {
                const until=Date.now()+5000;while(!output.includes('CLAIMED') && Date.now()<until && child.exitCode===null) await new Promise(resolve=>setTimeout(resolve,20));
                assert.match(output,/CLAIMED/);child.kill('SIGKILL');await exited;
                let imported=false;await assert.rejects(bootstrapServer({projectPath:target,loadServer:()=>{imported=true},serveMaintenance:async()=>{throw new Error('maintenance_held');}}),/maintenance_held/);
                assert.equal(imported,false);assert.equal(next.readPublicStatus().state,'MANUAL');return;
            } finally {child.kill('SIGKILL');await exited;}
        }
        claim=await next.claimBootstrapOwnership({...handoff.descriptor,applicationPath:path.join(target,'dist-server','server','application.js')});
        assert.equal(claim.artifact.jobId,identity.jobId);
        const proof={jobId:identity.jobId,generationId:identity.generationId,activationIdentitySha256:sealed.action.activationIdentitySha256,
            serverBuildId:identity.serverBuildId,clientBuildId:identity.clientBuildId,commit:identity.commit,receiptSequence:1};
        assert.throws(()=>claim.complete({artifactCompletion:proof}),/ENOENT/);
        const receipts=path.join(layout.controlRoot,'job-receipts');mkdirSync(receipts,{mode:0o700});const factsJson=JSON.stringify({...proof});
        writeFileSync(path.join(receipts,`${identity.jobId}.00000001.json`),JSON.stringify({schemaVersion:2,jobId:identity.jobId,sequence:1,phase:'runtime_verifying',kind:'recovery',factsJson,
            factsSha256:createHash('sha256').update(factsJson).digest('hex')}),{mode:0o600});
        claim.complete({artifactCompletion:proof});const restarted=createUpdateMaintenanceGate({projectPath:target});restarted.assertArtifactStartup();assert.equal(restarted.readPublicStatus().state,'OPEN');
        const check=new DatabaseSync(process.env.DATABASE_PATH);assert.equal(check.prepare('SELECT value FROM retained').get().value,'keep');check.close();
        run=launchFixture(fixture,await unusedPort());await awaitVerified(run);run.child.kill('SIGTERM');assert.equal((await run.completion).code,0);
    } finally {run?.child.kill('SIGTERM');claim?.release();owner?.release();restore();rmSync(fixture.root,{recursive:true,force:true});}
});

test('bootstrap rejects FIFO, symlink and oversized existing journal before reading', () => {
    const fixture=preparedRunFixture(), file=path.join(fixture.prepared.controlRoot,'initial-bootstrap.json');
    const original=readFileSync(file);
    try {
        for(const kind of ['fifo','symlink','oversized']) {
            unlinkSync(file);
            if(kind==='fifo') execFileSync('mkfifo',['-m','600',file]);
            if(kind==='symlink') symlinkSync('installer-selection.json',file);
            if(kind==='oversized') writeFileSync(file,' '.repeat(65537),{mode:0o600});
            assert.throws(()=>prepareInitialReleaseRuntime({deployRoot:fixture.deploy,assetFile:fixture.asset,manifestFile:fixture.publishedManifest,
                nodeInstanceId:'node-12345678-1234-4234-8234-123456789abc',expected:fixture.expected,runtimeHost:HOST}));
            unlinkSync(file);writeFileSync(file,original,{mode:0o600});
        }
    } finally {rmSync(fixture.root,{recursive:true,force:true});}
});
