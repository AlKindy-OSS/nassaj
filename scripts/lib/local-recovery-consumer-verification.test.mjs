import { createSyntheticBootstrapQualification } from '../update-lab/bootstrap-qualification.fixture.mjs';
import { attachCompletedConsumerBootstrap } from '../fixtures/local-consumer-bootstrap-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { executeOfflineConsumerTransition } from './local-recovery-consumer-transition.mjs';

function recordCoverageSource(file, source) {
    if (process.env.NODE_V8_COVERAGE) fs.writeFileSync(path.join(process.env.NODE_V8_COVERAGE, `consumer-source-${path.basename(file)}-${process.pid}.json`),
        JSON.stringify({ generatedPath: file, originalPath: path.join(import.meta.dirname, 'local-recovery-consumer-verification.mjs'), source }));
}
const root = path.resolve(import.meta.dirname, '../..');
const scratch = fs.mkdtempSync(path.join(root, '.artifacts/consumer-verification-fixture-'));
// Replace the OS boundary only in a disposable copy: production exports accept no verifier overrides.
let source = fs.readFileSync(path.join(import.meta.dirname, 'local-recovery-consumer-verification.mjs'), 'utf8');
source = source.replace(/from '([^']+)'/g, (_, specifier) => `from '${specifier.startsWith('.') ? pathToFileURL(path.resolve(import.meta.dirname, specifier)).href : specifier}'`)
    .replace('function processIdentity(pid)', 'function unusedProcessIdentity(pid)')
    .replace('export function observeConsumer(plan)', 'function unusedObserveConsumer(plan)')
    .replace('verifyRetainedClientPublicationConsumerBundle(folder, plan.runtimeBuildId);', 'fixture.verified.push([folder, plan.runtimeBuildId]);');
source += '\nlet fixture; export function setFixture(value) { fixture = value; }\nfunction observeConsumer() { return fixture.rows.shift() || fixture.last; }\nfunction processIdentity(pid) { return fixture.processes[pid]; }\n';
const moduleFile = path.join(scratch, 'verification.mjs'); fs.writeFileSync(moduleFile, source); recordCoverageSource(moduleFile, source);
const module = await import(pathToFileURL(moduleFile));

function fixture() {
    const plan = { root: scratch, runtimeBuildId: 'a'.repeat(64), databaseDirectory: `${scratch}/private`, dropIn: `${scratch}/enforcement.conf` };
    const entry = `${scratch}/.nassaj-local-preview/client-consumer-runtimes/${plan.runtimeBuildId}/UPDATE_RUNTIME_BUNDLE/scripts/preview-oid-consumer.mjs`;
    const row = { UnitFileState: 'enabled', ActiveState: 'active', MainPID: '101', InvocationID: 'b'.repeat(32), NRestarts: '0', ControlGroup: '/fixture',
        pids: [101, 102], jobs: [], DropInPaths: plan.dropIn, Environment: 'NASSAJ_PREVIEW_OID_DOMAINS=client,server NASSAJ_PREVIEW_OID_ENFORCEMENT=1',
        ProtectHome: 'read-only', ProtectSystem: 'strict', ReadWritePaths: `${scratch} ${plan.databaseDirectory}` };
    const child = { startTicks: '1020', uid: process.getuid(), cwd: scratch, exe: fs.realpathSync(process.execPath), argv: ['node', entry, '--repo', scratch] };
    const value = { rows: [row], last: row, verified: [], processes: {
        101: { startTicks: '1010', uid: process.getuid(), cwd: scratch, exe: fs.realpathSync(process.execPath), argv: ['node', 'scripts/client-publication-consumer-launcher.mjs'] }, 102: child, 103: child } };
    module.setFixture(value); return { plan, row, value };
}
test('readiness proves exact launcher plus one retained child without waiting for claim', async () => {
    const f = fixture(), result = await module.verifyConsumerReadiness(f.plan);
    assert.equal(result.MainPID, '101'); assert.equal(result.childPid, 102); assert.equal(f.value.verified.length, 1);
});
test('duplicate retained children are rejected before claiming readiness', async () => {
    const f = fixture(); f.row.pids.push(103);
    await assert.rejects(module.verifyConsumerReadiness(f.plan), /duplicate_retained_process/);
    assert.equal(f.value.verified.length, 0);
});
for (const field of ['InvocationID', 'NRestarts']) {
    test(`first active observation pins ${field} before retained child appears`, async () => {
        const f = fixture(), first = { ...f.row, pids: [101] };
        f.row[field] = field === 'NRestarts' ? '1' : 'c'.repeat(32); f.value.rows = [first, f.row];
        await assert.rejects(module.verifyConsumerReadiness(f.plan), /startup_incarnation_changed/);
    });
}
test('unexpected writable paths fail readiness', async () => {
    const f = fixture(); f.row.ReadWritePaths += ' /home';
    await assert.rejects(module.verifyConsumerReadiness(f.plan), /startup_identity/);
});
test('production transition cannot accept injected authority or systemctl functions', async () => {
    let called = false;
    await assert.rejects(executeOfflineConsumerTransition({ root: path.join(scratch, 'missing'), execute: true }, {
        lock: async (_root, operation) => operation(), inspect: async () => { called = true; return {}; }, run: () => { called = true; },
    }));
    assert.equal(called, false);
});

for (const mutation of ['disabled', 'extra_launcher_arg', 'foreign_node']) {
    test(`startup rejects ${mutation}`, async () => {
        const f = fixture();
        if (mutation === 'disabled') f.row.UnitFileState = 'disabled';
        if (mutation === 'extra_launcher_arg') f.value.processes[101].argv.push('--once');
        if (mutation === 'foreign_node') f.value.processes[101].exe = '/foreign/node';
        await assert.rejects(module.verifyConsumerReadiness(f.plan), /startup_identity/);
    });
}

test('real Node subprocess preserves the unit relative argv and passes entry verification', async t => {
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const directory = fs.mkdtempSync(path.join(scratch, 'real-process-'));
    const plan = { root: directory, runtimeBuildId: 'd'.repeat(64), databaseDirectory: `${directory}/private`, dropIn: `${directory}/enforcement.conf` };
    const entry = `${directory}/.nassaj-local-preview/client-consumer-runtimes/${plan.runtimeBuildId}/UPDATE_RUNTIME_BUNDLE/scripts/preview-oid-consumer.mjs`;
    fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, 'setInterval(() => {}, 1000);');
    fs.mkdirSync(path.join(directory, 'scripts'));
    fs.writeFileSync(path.join(directory, 'scripts/client-publication-consumer-launcher.mjs'),
        `import {spawn} from 'node:child_process'; const child=spawn(process.execPath,[${JSON.stringify(entry)},'--repo',process.cwd()],{stdio:'ignore'}); console.log(child.pid); process.on('SIGTERM',()=>{child.kill('SIGTERM');process.exit(0)});setInterval(()=>{},1000);`);
    const child = spawn(process.execPath, ['scripts/client-publication-consumer-launcher.mjs'], { cwd: directory, stdio: ['ignore','pipe','pipe'] });
    t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
    const [output] = await once(child.stdout, 'data'), retainedPid = Number(output.toString().trim());
    assert.ok(retainedPid > 1);
    assert.equal(fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0')[1], 'scripts/client-publication-consumer-launcher.mjs');
    const row = { ActiveState: 'active', UnitFileState: 'enabled', MainPID: String(child.pid), InvocationID: 'e'.repeat(32), NRestarts: '0',
        ControlGroup: '/isolated-test', pids: [child.pid, retainedPid], jobs: [], DropInPaths: plan.dropIn,
        Environment: 'NASSAJ_PREVIEW_OID_DOMAINS=client,server NASSAJ_PREVIEW_OID_ENFORCEMENT=1',
        ProtectHome: 'read-only', ProtectSystem: 'strict', ReadWritePaths: `${directory} ${plan.databaseDirectory}` };
    let actual = fs.readFileSync(path.join(import.meta.dirname, 'local-recovery-consumer-verification.mjs'), 'utf8');
    actual = actual.replace(/from '([^']+)'/g, (_, specifier) => `from '${specifier.startsWith('.') ? pathToFileURL(path.resolve(import.meta.dirname, specifier)).href : specifier}'`)
        .replace('export function observeConsumer(plan)', 'function unusedObserveConsumer(plan)')
        .replace('verifyRetainedClientPublicationConsumerBundle(folder, plan.runtimeBuildId);', '/* bundle validation covered independently below */');
    actual += `\nfunction observeConsumer() { return ${JSON.stringify(row)}; }\n`;
    const file = path.join(directory, 'actual-process-verification.mjs'); fs.writeFileSync(file, actual); recordCoverageSource(file, actual);
    const { verifyConsumerReadiness } = await import(pathToFileURL(file));
    const result = await verifyConsumerReadiness(plan);
    assert.equal(result.MainPID, String(child.pid)); assert.equal(result.childPid, retainedPid);
});

test('a valid bundle from another server generation cannot authorize the consumer transition', async () => {
    const { createHash } = await import('node:crypto');
    const { hashTree } = await import('./source-update-tree-identity.mjs');
    const { verifyApprovedConsumerBundle } = await import('./local-recovery-consumer-verification.mjs');
    const { verifyClientPublicationConsumerBundle } = await import('../client-publication-consumer-launcher.mjs');
    const directory = fs.mkdtempSync(path.join(scratch, 'bundle-')), artifact = path.join(directory, 'dist-server');
    const entries = ['scripts/preview-oid-consumer.mjs','scripts/lib/client-publication-executor.mjs','scripts/lib/client-publication-isolation.mjs','scripts/client-build-atomic.mjs'].sort();
    const hash = value => createHash('sha256').update(value).digest('hex');
    const files = entries.map(entry => {
        const file = path.join(artifact, 'UPDATE_RUNTIME_BUNDLE', entry), bytes = Buffer.from('export {};\n');
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { mode: 0o644 });
        return { path: entry, mode: 0o644, size: bytes.length, sha256: hash(bytes) };
    }).sort((a,b) => a.path.localeCompare(b.path));
    const build = createHash('sha256');
    for (const record of files) build.update(record.path).update('\0').update(String(record.mode)).update('\0').update(String(record.size)).update('\0').update(record.sha256).update('\0');
    const buildId = build.digest('hex'), serverBuildId = 'a'.repeat(64), releaseCommit = 'b'.repeat(40);
    const write = (name,value) => fs.writeFileSync(path.join(artifact,name), JSON.stringify(value));
    write('UPDATE_RUNTIME_MANIFEST.json', {schemaVersion:2,buildIdMode:'path-mode-size-content-sha256',buildId,files,entries});
    const control = {serverBuildId,updateRuntimeBuildId:buildId,capabilities:{clientPublicationV1:'nassaj-dev-client-publication/v1'}};
    const provenance = {artifact:'server',buildId:serverBuildId,commit:releaseCommit,baseCommit:releaseCommit,dirty:false};
    write('OID_CONTROL_MANIFEST.json',control);write('BUILD_PROVENANCE.json',provenance);write('SERVER_INPUT_MANIFEST.json',{buildId:serverBuildId});
    const manifest = {serverBuildId,releaseCommit,trees:{server:hashTree(artifact)}};
    assert.equal(verifyApprovedConsumerBundle(directory,manifest).buildId,buildId);
    write('OID_CONTROL_MANIFEST.json',{...control,serverBuildId:'c'.repeat(64)});
    assert.equal(verifyClientPublicationConsumerBundle(directory).buildId,buildId,'bundle remains internally valid');
    assert.throws(()=>verifyApprovedConsumerBundle(directory,manifest),/installed_generation_changed/);
    write('OID_CONTROL_MANIFEST.json',control);write('BUILD_PROVENANCE.json',{...provenance,commit:'d'.repeat(40)});
    assert.throws(()=>verifyApprovedConsumerBundle(directory,manifest),/installed_generation_changed/);
});

// The bootstrap inspector owns receipt/claim verification; substitute only that and OS observations.
// All consumer packet, policy, profile, source-unit and installed/retained bundle checks below are real.
const v2ModuleFile = path.join(scratch, 'verification-v2.mjs');
let v2Source = fs.readFileSync(path.join(import.meta.dirname, 'local-recovery-consumer-verification.mjs'), 'utf8')
    .replace(/from '([^']+)'/g, (_, specifier) => `from '${specifier.startsWith('.') ? pathToFileURL(path.resolve(import.meta.dirname, specifier)).href : specifier}'`)
    .replace('await recoveryOperator.inspectCompletedBootstrap(root, packet)', 'fixture.completed')
    .replace('const home = os.homedir()', 'const home = fixture.home')
    .replace('function processIdentity(pid)', 'function unusedProcessIdentity(pid)')
    .replace('export function observeConsumer(plan)', 'function unusedObserveConsumer(plan)');
v2Source += '\nlet fixture; export function setFixture(value) { fixture = value; }\nfunction observeConsumer() { return fixture.row; }\nfunction processIdentity(pid) { return fixture.processes[pid]; }\n';
fs.writeFileSync(v2ModuleFile, v2Source); recordCoverageSource(v2ModuleFile, v2Source);
const v2Module = await import(pathToFileURL(v2ModuleFile));
const { createHash } = await import('node:crypto');
const { execFileSync } = await import('node:child_process');
const { hashTree } = await import('./source-update-tree-identity.mjs');
const { localBuildDependencyInputDigest, localBuildSourceInputs } = await import('./local-build-profile.mjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const H = 'a'.repeat(64);
function writeFixture(file, value, mode = 0o600) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
    return digest(fs.readFileSync(file));
}
function createFullBundle(directory, oid) {
    const artifact = path.join(directory, 'dist-server');
    const entries = ['scripts/preview-oid-consumer.mjs', 'scripts/lib/client-publication-executor.mjs',
        'scripts/lib/client-publication-isolation.mjs', 'scripts/client-build-atomic.mjs',
        'scripts/oid-update-candidate.mjs', 'scripts/client-publication-consumer-launcher.mjs'].sort();
    const names = [...entries, 'scripts/lib/local-build-profile.mjs', 'scripts/lib/local-update-policy.mjs'].sort();
    const records = names.map(name => {
        const file = path.join(artifact, 'UPDATE_RUNTIME_BUNDLE', name);
        const sha256 = writeFixture(file, 'export {};\n', 0o644);
        return { path: name, mode: 0o644, size: fs.statSync(file).size, sha256 };
    }).sort((a, b) => a.path.localeCompare(b.path));
    const hash = createHash('sha256');
    for (const r of records) hash.update(r.path).update('\0').update(String(r.mode)).update('\0').update(String(r.size)).update('\0').update(r.sha256).update('\0');
    const buildId = hash.digest('hex');
    writeFixture(path.join(artifact, 'UPDATE_RUNTIME_MANIFEST.json'), { schemaVersion: 2, buildIdMode: 'path-mode-size-content-sha256', buildId, entries, files: records });
    const capsuleSha256 = writeFixture(path.join(artifact, 'OID_CONTROL_CAPSULE.mjs'), 'export {};\n');
    writeFixture(path.join(artifact, 'OID_CONTROL_MANIFEST.json'), { serverBuildId: H, updateRuntimeBuildId: buildId, capsuleSha256,
        capabilities: { clientPublicationV1: 'nassaj-dev-client-publication/v1', oidDevFullPolicyV1: 'nassaj-dev-full-policy/v1' } });
    writeFixture(path.join(artifact, 'BUILD_PROVENANCE.json'), { artifact: 'server', buildId: H, commit: oid, baseCommit: oid, dirty: false });
    writeFixture(path.join(artifact, 'SERVER_INPUT_MANIFEST.json'), { buildId: H });
    const retained = path.join(directory, '.nassaj-local-preview/client-consumer-runtimes', buildId);
    fs.mkdirSync(retained, { recursive: true });
    fs.cpSync(artifact, retained, { recursive: true });
    return { buildId, capsuleSha256, manifest: { releaseCommit: oid, serverBuildId: H, clientBuildId: H, trees: { server: hashTree(artifact) } } };
}
function createBuildProfile(directory, oid) {
    const cachePath = path.join(directory, 'cache'), headersPath = path.join(directory, 'headers');
    fs.mkdirSync(cachePath, { mode: 0o700 }); writeFixture(path.join(headersPath, 'include/node/node.h'), 'fixture');
    const runtime = { nodeVersion: process.version, nodeModuleAbi: process.versions.modules,
        nodeBinarySha256: digest(fs.readFileSync(fs.realpathSync(process.execPath))),
        npmCliPath: fs.realpathSync(process.execPath), npmCliSha256: digest(fs.readFileSync(fs.realpathSync(process.execPath))) };
    const dependencyInputSha256 = localBuildDependencyInputDigest({}, { lockfileVersion: 3, packages: {} });
    const source = localBuildSourceInputs(directory, oid), phaseAdditionalBytes = { prepare: 100, install: 100, build: 100, store: 100 };
    const measurementPath = path.join(directory, 'measurement.json');
    const material = { dependencyInputSha256, runtime, phaseAdditionalBytes, sourceInventoryBytesMax: source.sourceBytes,
        buildConfigurationSha256: source.buildConfigurationSha256 };
    const measurementSha256 = writeFixture(measurementPath, { schema: 'nassaj-local-build-working-set/v1', ...material });
    return writeFixture(path.join(directory, '.git/nassaj-local-build-profile-v1.json'), {
        schema: 'nassaj-local-build-profile/v1', root: directory, ...material, measurementPath, measurementSha256, cachePath, headersPath });
}
function bootstrapConsumerFixture(t) {
    const directory = fs.mkdtempSync(path.join(scratch, 'v2-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const git = args => execFileSync('git', args, { cwd: directory, stdio: 'pipe' }).toString().trim();
    git(['init', '--initial-branch=main']);
    const unitName = 'nassaj-preview-oid-consumer.service', unitBytes = fs.readFileSync(path.join(root, 'scripts/systemd', unitName), 'utf8');
    writeFixture(path.join(directory, 'scripts/systemd', unitName), unitBytes);
    writeFixture(path.join(directory, 'scripts/client-publication-consumer-launcher.mjs'), 'export {};\n', 0o644);
    writeFixture(path.join(directory, 'package.json'), {}); writeFixture(path.join(directory, 'package-lock.json'), { lockfileVersion: 3, packages: {} });
    git(['add', 'scripts/systemd/nassaj-preview-oid-consumer.service', 'scripts/client-publication-consumer-launcher.mjs', 'package.json', 'package-lock.json']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
    const oid = git(['rev-parse', 'HEAD']), bundle = createFullBundle(directory, oid), home = path.join(directory, 'unit-home');
    const unit = path.join(home, '.config/systemd/user', unitName), dropIn = `${unit}.d/enforcement.conf`;
    const originalDropIn = '[Service]\nInaccessiblePaths=/unrelated-secret\n';
    const unitSha256 = writeFixture(unit, unitBytes), originalDropInSha256 = writeFixture(dropIn, originalDropIn);
    const appData = path.join(directory, 'appdata'); fs.mkdirSync(appData, { mode: 0o700 });
    const appStat = fs.statSync(appData);
    const appDataGuard = { directory: appData, dev: String(appStat.dev), ino: String(appStat.ino), dedicated: true, attestationSha256: H };
    const packet = { schema: 'nassaj-local-recovery-consumer/v2', profile: 'bootstrap-offline-v2', operation: 'offline-client-server-transition',
        root: directory, nodeIdentity: (fixtureHostname()), serviceUid: process.getuid(), approvalReference: 'fixture:consumer-approval',
        unitSha256, originalDropInSha256, originalDropIn, appDataGuard, policySha256: 'absent', fullPolicySha256: 'absent', buildProfileSha256: createBuildProfile(directory, oid),
        bootstrapCompletion: { sequence: 1, transactionNonce: H, targetDigest: H, actionId: 'fixture-action', receiptSha256: H,
            claimSha256: H, ticketSha256: H, qualificationSha256: H, executorCodeClosureSha256: H, manifestSha256: H } };
    const packetPath = path.join(directory, '.git/nassaj-source-update/consumer.json');
    const fixture = { home, completed: { appDataGuard, manifest: bundle.manifest, transactionId: 'fixture-bootstrap',
        health: { status: 'ok', updateMode: 'local-main', normalAdmissionReady: true, serverBuildIdLoadedAtStartup: H,
            localUpdatePolicyCapability: { protocol: 'nassaj-dev-full-policy/v1', serverLoadedBuildId: H, retainedExecutorSha256: bundle.capsuleSha256 } } } };
    v2Module.setFixture(fixture);
    return { directory, packet, packetPath, fixture, dropIn, bundle,
        options: () => ({ root: directory, packetPath, packetSha256: writeFixture(packetPath, packet) }) };
}
const { hostname: fixtureHostname } = await import('node:os');
function setV2Runtime(f, plan) {
    const entry = `${f.directory}/.nassaj-local-preview/client-consumer-runtimes/${plan.runtimeBuildId}/UPDATE_RUNTIME_BUNDLE/scripts/preview-oid-consumer.mjs`;
    const identity = { uid: process.getuid(), cwd: f.directory, exe: fs.realpathSync(process.execPath) };
    f.fixture.processes = { 101: { ...identity, startTicks: '100', argv: ['node', 'scripts/client-publication-consumer-launcher.mjs'] },
        102: { ...identity, startTicks: '101', argv: ['node', entry, '--repo', f.directory] } };
    f.fixture.row = { ActiveState: 'active', UnitFileState: 'enabled', MainPID: '101', InvocationID: 'b'.repeat(32), NRestarts: '0',
        ControlGroup: '/fixture', pids: [101, 102], jobs: [], DropInPaths: plan.dropIn,
        Environment: 'NODE_ENV=production TMPDIR=/var/tmp NASSAJ_PREVIEW_OID_ENFORCEMENT=1 NASSAJ_PREVIEW_OID_DOMAINS=client,server',
        ProtectHome: 'read-only', ProtectSystem: 'strict', ReadWritePaths: f.directory,
        IPAddressAllow: '::1/128 127.0.0.0/8', IPAddressDeny: '0.0.0.0/0 ::/0', RestrictAddressFamilies: 'AF_UNIX AF_INET AF_INET6',
        InaccessiblePaths: `/unrelated-secret ${plan.appDataGuard.directory}`, BindPaths: '', BindReadOnlyPaths: '', RootDirectory: '', RootImage: '', TemporaryFileSystem: '',
        NoNewPrivileges: 'yes', PrivateTmp: 'yes', PrivateDevices: 'yes', CapabilityBoundingSet: '',
        MemoryHigh: '2147483648', MemoryMax: '3221225472', CPUQuotaPerSecUSec: '1.500000s', TasksMax: '256', UMask: '0077',
        ReadOnlyPaths: ['src', 'public', 'docs', 'shared', 'server', 'scripts', 'node_modules', 'package.json', 'package-lock.json'].map(name => `-${f.directory}/${name}`).join(' ') };
    writeFixture(plan.dropIn, plan.proposed);
}

test('v2 validates real installed/retained builder and measured profile while both policies stay off', async t => {
    const f = bootstrapConsumerFixture(t), plan = await v2Module.inspectOfflineConsumerInputs(f.options());
    assert.equal(plan.profile, 'bootstrap-offline-v2'); assert.equal(plan.databaseDirectory, undefined); assert.equal(plan.jobId, undefined);
    assert.equal(plan.proposed, `${f.packet.originalDropIn}\n[Service]\nEnvironment=NASSAJ_PREVIEW_OID_ENFORCEMENT=1\nEnvironment=NASSAJ_PREVIEW_OID_DOMAINS=client,server\nReadWritePaths=\nReadWritePaths=${f.directory}\nInaccessiblePaths=${f.packet.appDataGuard.directory}\n`);
    setV2Runtime(f, plan);
    assert.equal((await v2Module.verifyConsumerReadiness(plan)).retainedBuildId, f.bundle.buildId);
    assert.equal(fs.existsSync(path.join(f.directory, '.git/nassaj-local-update-policy-v1.json')), false);
});
for (const [field, value] of [['ReadWritePaths', '/database'], ['IPAddressAllow', 'any'], ['IPAddressDeny', ''],
    ['Environment', 'NASSAJ_PREVIEW_OID_DOMAINS=client'], ['Environment', 'NODE_OPTIONS=--require=/foreign'],
    ['ReadOnlyPaths', ''], ['MemoryMax', 'infinity'], ['NoNewPrivileges', 'no']]) {
    test(`v2 refuses effective ${field} drift (${value})`, async t => {
        const f = bootstrapConsumerFixture(t), plan = await v2Module.inspectOfflineConsumerInputs(f.options()); setV2Runtime(f, plan);
        f.fixture.row[field] = value;
        await assert.rejects(v2Module.verifyConsumerReadiness(plan), /startup_identity|offline_sandbox|offline_environment/);
    });
}
for (const field of ['registrationPacketPath', 'registrationPacketSha256', 'database', 'jobId']) {
    test(`v2 rejects legacy ${field} authority`, async t => {
        const f = bootstrapConsumerFixture(t); f.packet[field] = 'legacy';
        await assert.rejects(v2Module.inspectOfflineConsumerInputs(f.options()), /bootstrap_profile/);
    });
}
for (const mutation of ['cache_path', 'profile_bytes', 'launcher', 'full_policy', 'drop_in', 'retained_bundle', 'full_capability']) {
    test(`v2 rejects ${mutation} drift`, async t => {
        const f = bootstrapConsumerFixture(t), plan = await v2Module.inspectOfflineConsumerInputs(f.options()); setV2Runtime(f, plan);
        if (mutation === 'cache_path') fs.renameSync(path.join(f.directory, 'cache'), path.join(f.directory, 'cache-moved'));
        if (mutation === 'profile_bytes') fs.appendFileSync(path.join(f.directory, '.git/nassaj-local-build-profile-v1.json'), ' ');
        if (mutation === 'launcher') fs.appendFileSync(path.join(f.directory, 'scripts/client-publication-consumer-launcher.mjs'), ' ');
        if (mutation === 'full_policy') writeFixture(path.join(f.directory, '.git/nassaj-local-update-policy-v1.json'), { mode: 'dev-full-auto' });
        if (mutation === 'drop_in') fs.appendFileSync(plan.dropIn, 'ReadWritePaths=/database\n');
        if (mutation === 'retained_bundle') fs.appendFileSync(path.join(f.directory, '.nassaj-local-preview/client-consumer-runtimes', plan.runtimeBuildId, 'UPDATE_RUNTIME_BUNDLE/scripts/oid-update-candidate.mjs'), ' ');
        if (mutation === 'full_capability') {
            f.fixture.completed.health.localUpdatePolicyCapability.protocol = 'unsupported';
            await assert.rejects(v2Module.inspectOfflineConsumerInputs(f.options()), /capability_required/); return;
        }
        await assert.rejects(v2Module.verifyConsumerReadiness(plan));
    });
}

test('v2 refuses a missing real bootstrap before opening database or mutating consumer configuration', async t => {
    const f = bootstrapConsumerFixture(t);
    f.packet.bootstrapCompletion.actionId = '12345678-1234-1234-1234-123456789abc';
    const { inspectOfflineConsumerInputs } = await import('./local-recovery-consumer-verification.mjs');
    const before = fs.readFileSync(f.dropIn), originalOpen = fs.openSync;
    let databaseOpened = false;
    fs.openSync = function (file, ...args) {
        if (/\.db(?:-(?:wal|shm))?$/.test(String(file))) { databaseOpened = true; throw Error('unexpected_database_open'); }
        return originalOpen.call(this, file, ...args);
    };
    try {
        await assert.rejects(inspectOfflineConsumerInputs(f.options()), error => error.code === 'ENOENT' && /nassaj-oid-control-transaction/.test(error.path));
    } finally { fs.openSync = originalOpen; }
    assert.equal(databaseOpened, false); assert.deepEqual(fs.readFileSync(f.dropIn), before);
});

test('v2 refuses an otherwise valid installed bundle missing the full builder entry', async t => {
    const f = bootstrapConsumerFixture(t), file = path.join(f.directory, 'dist-server/UPDATE_RUNTIME_MANIFEST.json');
    const bundle = JSON.parse(fs.readFileSync(file));
    bundle.entries = bundle.entries.filter(entry => entry !== 'scripts/oid-update-candidate.mjs');
    writeFixture(file, bundle);
    f.fixture.completed.manifest.trees.server = hashTree(path.join(f.directory, 'dist-server'));
    await assert.rejects(v2Module.inspectOfflineConsumerInputs(f.options()), /full_builder_missing/);
});

for (const mutation of ['unattested', 'shared', 'alias', 'inode', 'directory_changed', 'optional_mask', 'prior_mask_removed', 'bind', 'read_only_bind', 'rw_alias']) {
    test(`v2 appdata rejects ${mutation}`, async t => {
        const f = bootstrapConsumerFixture(t);
        if (mutation === 'unattested') delete f.fixture.completed.appDataGuard;
        if (mutation === 'shared') f.fixture.completed.appDataGuard.dedicated = false;
        if (mutation === 'alias') {
            const alias = `${f.directory}/alias`; fs.symlinkSync(f.packet.appDataGuard.directory, alias);
            f.fixture.completed.appDataGuard.directory = alias;
        }
        if (mutation === 'inode') f.fixture.completed.appDataGuard.ino = '1';
        if (['unattested', 'shared', 'alias', 'inode'].includes(mutation)) {
            await assert.rejects(v2Module.inspectOfflineConsumerInputs(f.options()), /appdata_/); return;
        }
        const plan = await v2Module.inspectOfflineConsumerInputs(f.options()); setV2Runtime(f, plan);
        if (mutation === 'directory_changed') {
            fs.renameSync(plan.appDataGuard.directory, `${f.directory}/old-appdata`); fs.mkdirSync(plan.appDataGuard.directory);
        }
        if (mutation === 'optional_mask') f.fixture.row.InaccessiblePaths = `-${plan.appDataGuard.directory}`;
        if (mutation === 'prior_mask_removed') f.fixture.row.InaccessiblePaths = plan.appDataGuard.directory;
        if (mutation === 'bind') f.fixture.row.BindPaths = `${plan.appDataGuard.directory}:${f.directory}/exposed`;
        if (mutation === 'read_only_bind') f.fixture.row.BindReadOnlyPaths = `${f.directory}:${f.directory}/exposed`;
        if (mutation === 'rw_alias') {
            fs.symlinkSync(plan.appDataGuard.directory, `${f.directory}/alias`); f.fixture.row.ReadWritePaths += ` ${f.directory}/alias`;
        }
        await assert.rejects(v2Module.verifyConsumerReadiness(plan), /appdata_|startup_identity/);
        await assert.rejects(async () => v2Module.verifyConsumerConfiguration(plan), /appdata_|offline_configuration/);
    });
}

async function inspectConsumerWithoutDatabase(f) {
    const { execFile } = await import('node:child_process');
    const file = path.join(f.directory, 'consumer-inspection-options.json'); writeFixture(file, f.options());
    const verifier = new URL('./local-recovery-consumer-verification.mjs', import.meta.url).href;
    const program = `import assert from 'node:assert/strict';import fs from 'node:fs';import Module from 'node:module';
const sqlite=process.getBuiltinModule('node:sqlite');let opens=0, imports=0, fileOpens=0;
sqlite.DatabaseSync=class{constructor(){opens++;throw Error('database_access_forbidden')}};
assert.throws(()=>new sqlite.DatabaseSync(':memory:'),/database_access_forbidden/);opens=0;
const load=Module._load;Module._load=function(name,...args){if(name==='better-sqlite3'){imports++;throw Error('database_import_forbidden')}return load.call(this,name,...args)};
assert.throws(()=>Module._load('better-sqlite3'),/database_import_forbidden/);imports=0;
const open=fs.openSync;fs.openSync=function(file,...args){if(/\\.db(?:-(?:wal|shm))?$/.test(String(file))){fileOpens++;throw Error('database_file_forbidden')}return open.call(this,file,...args)};
assert.throws(()=>fs.openSync('synthetic.db','r'),/database_file_forbidden/);fileOpens=0;
const {inspectOfflineConsumerInputs}=await import(${JSON.stringify(verifier)});
const plan=await inspectOfflineConsumerInputs(JSON.parse(fs.readFileSync(${JSON.stringify(file)})));
assert.equal(opens,0);assert.equal(imports,0);assert.equal(fileOpens,0);console.log(JSON.stringify(plan));`;
    const stdout = await new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', program],
        { cwd: f.directory, timeout: 10000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, HOME: f.fixture.home, ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}) } },
        (error, output, stderr) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(output)));
    return JSON.parse(stdout);
}

function consumerQualificationFixture(expected, input) {
    const previousMaterial = { oid: 'b'.repeat(40), clientOid: 'b'.repeat(40), mode: 'release',
        nodeVersion: process.version, nodeModuleAbi: process.versions.modules };
    for (const key of ['serverBuildId', 'clientBuildId', 'controlManifestSha256', 'serverInputManifestSha256',
        'serverProvenanceSha256', 'clientProvenanceSha256', 'clientTreeSha256', 'serverTreeSha256', 'nodeModulesTreeSha256',
        'dependencyLegacyActualSha256', 'nodeBinarySha256', 'pm2PackageTreeSha256', 'safeRestartSha256', 'admissionImplementationSha256']) previousMaterial[key] = H;
    const liveManifest = { runtimeDependenciesSha256: H }, manifestBytes = Buffer.from(JSON.stringify(liveManifest));
    previousMaterial.controlManifestSha256 = digest(manifestBytes);
    expected.previous.controlManifestSha256 = digest(manifestBytes);
    const value = createSyntheticBootstrapQualification({ installation: expected.installation, previous: previousMaterial, liveManifest,
        executorCodeClosureSha256: expected.executor.codeClosureSha256, verifierClosureSha256: digest(input.capsule), databasePath: expected.database.path });
    const stat = fs.statSync(path.dirname(expected.database.path));
    return { reference: value.qualificationReference, previousMaterial, previousControlManifestBase64: manifestBytes.toString('base64'),
        baseline: { attestationSha256: value.qualificationReference.sha256, rehearsalSha256: value.qualification.rehearsal.reportSha256 },
        appDataGuard: { directory: path.dirname(expected.database.path), dev: String(stat.dev), ino: String(stat.ino), dedicated: true,
            attestationSha256: value.qualificationReference.sha256 } };
}



test('consumer v2 accepts the real bootstrap reader, evidence, claim and serving chain without importing or opening a database', async t => {
    const { createServer } = await import('node:http');
    const f = bootstrapConsumerFixture(t), health = attachCompletedConsumerBootstrap(f, consumerQualificationFixture);
    const server = createServer((_request, response) => response.end(JSON.stringify(health)));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    f.packet.privateHealthUrl = `http://127.0.0.1:${server.address().port}/health`;
    const cwd = process.cwd();
    try {
        process.chdir(f.directory);
        const plan = await inspectConsumerWithoutDatabase(f);
        assert.equal(plan.profile, 'bootstrap-offline-v2'); assert.equal(plan.databaseDirectory, undefined);
        assert.deepEqual(plan.appDataGuard, f.packet.appDataGuard);
        assert.ok(plan.proposed.includes(`InaccessiblePaths=${plan.appDataGuard.directory}\n`));
        assert.equal(plan.runtimeBuildId, f.bundle.buildId);
        const identity = f.packet.appDataGuard.ino;
        f.packet.appDataGuard.ino = '1';
        await assert.rejects(inspectConsumerWithoutDatabase(f), /appdata_attestation/);
        f.packet.appDataGuard.ino = identity;
        const receipt = f.packet.bootstrapCompletion.receiptSha256; f.packet.bootstrapCompletion.receiptSha256 = H;
        await assert.rejects(inspectConsumerWithoutDatabase(f), /file_changed/);
        f.packet.bootstrapCompletion.receiptSha256 = receipt;
        assert.equal(fs.readFileSync(f.dropIn, 'utf8'), f.packet.originalDropIn);
    } finally { process.chdir(cwd); }
});

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
