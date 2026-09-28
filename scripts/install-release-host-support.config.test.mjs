import { installCodexImageOnlyTestFixture } from './lib/codex-image-only-test-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { readRootConfig } from './release-runtime-host-dispatcher.mjs';
import { readForwardChildMaterial } from './release-runtime-forward-child.mjs';
import { runPreparedForwardMigrationOperator, runResumedForwardOperator, runReconciledForwardOperator } from './release-runtime-forward-parent.mjs';
import { withVerifiedCutoverStateMutex } from './lib/release-runtime-state-mutex.mjs';
import { buildReleaseInstaller } from './build-release-installer.mjs';
import { buildReleaseAsset, collectForwardExecutableClosure } from './build-release-asset.mjs';
import { installUpdateRuntimeBundle } from './lib/update-runtime-bundle.mjs';
import { currentReleaseRuntimeTarget } from './lib/update-release-asset.mjs';
import { collectForwardStartupMaterial, STARTUP_ROOTS, FORWARD_PROFILE_MODULE, FORWARD_PROFILE_ID } from './lib/compatible-forward-release-profile.mjs';
import { prepareInitialReleaseRuntime } from './bootstrap-release-runtime.mjs';
import { generateFirstForwardConfiguration } from './lib/prepare-first-forward-config.mjs';
import { mintCutoverApproval } from './mint-cutover-approval.mjs';
import { preflightFirstForwardConfiguration } from './lib/release-runtime-forward-initialization.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = file => ({ path: fs.realpathSync(file), sha256: sha(fs.readFileSync(file)) });
const H = char => char.repeat(64);
function write(file, bytes, mode = 0o644) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); fs.chmodSync(file, mode);
}
function runtimeFixture(root, options = {}) {
    const source = path.join(root, 'source'), runtime = path.join(source, 'dist-server');
    fs.mkdirSync(runtime, { recursive: true });
    installCodexImageOnlyTestFixture(source);
    write(path.join(source, 'server/bin/claude'), fs.readFileSync(path.join(ROOT, 'server/bin/claude')), 0o755);
    write(path.join(runtime, 'server/services/isolation/managed-claude-launcher.js'), 'export {};\n');
    for (const entry of STARTUP_ROOTS) write(path.join(runtime, entry), entry === 'server/bootstrap-release-profile.js'
        ? FORWARD_PROFILE_MODULE : 'export const ready=true;\n');
    write(path.join(runtime, 'server/bootstrap.js'), "import 'runtime-fixture'; import 'semver'; export const ready=true;\n");
    write(path.join(runtime, 'server/scripts/release-database-migration.js'), 'export const migrate=true;\n');
    write(path.join(source, 'node_modules/runtime-fixture/package.json'), JSON.stringify({ name: 'runtime-fixture', version: '1.0.0', main: 'index.js' }));
    write(path.join(source, 'node_modules/runtime-fixture/index.js'), 'module.exports=42;\n');
    fs.cpSync(path.join(ROOT, 'node_modules/semver'), path.join(source, 'node_modules/semver'), { recursive: true });
    const semverLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'))).packages['node_modules/semver'];
    write(path.join(source, 'package.json'), JSON.stringify({ type: 'module' }));
    write(path.join(source, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {},
        'node_modules/@openai/codex-sdk': { version: '0.153.2', integrity: 'sha512-YQ==' }, 'node_modules/runtime-fixture': { version: '1.0.0', integrity: 'sha512-YQ==' }, 'node_modules/semver': semverLock } }));
    for (const file of collectForwardExecutableClosure(ROOT).files) write(path.join(source, file.path), fs.readFileSync(path.join(ROOT, file.path)), file.mode);
    fs.cpSync(path.join(ROOT, 'scripts/vendor/pm2-codec'), path.join(source, 'scripts/vendor/pm2-codec'), { recursive: true });
    installUpdateRuntimeBundle(ROOT, runtime);
    if (options.responder) write(path.join(runtime, 'scripts/nassaj-maintenance-responder.mjs'), fs.readFileSync(path.join(ROOT, 'scripts/nassaj-maintenance-responder.mjs')), fs.statSync(path.join(ROOT, 'scripts/nassaj-maintenance-responder.mjs')).mode & 0o777);
    const provenance = { version: '1.47.0.3', commit: 'b'.repeat(40), buildId: H('d') };
    for (const directory of [runtime, path.join(source, 'dist')]) write(path.join(directory, 'BUILD_PROVENANCE.json'), JSON.stringify(provenance));
    write(path.join(source, 'dist/index.html'), '<!doctype html>');
    write(path.join(runtime, 'SERVER_INPUT_MANIFEST.json'), JSON.stringify({ commit: provenance.commit, buildId: provenance.buildId }));
    const startup = collectForwardStartupMaterial(runtime, { packageLockFile: path.join(source, 'package-lock.json') });
    write(path.join(runtime, 'STARTUP_CLOSURE.json'), JSON.stringify(startup.material));
    const target = currentReleaseRuntimeTarget();
    const built = buildReleaseAsset({ kind: 'owner-reviewed-local-build/v1', projectId: 'fixture', sourceRoot: source,
        temporaryRoot: root, version: provenance.version, commit: provenance.commit, profile: FORWARD_PROFILE_ID, outputDirectory: path.join(root, 'runtime-archive') },
    { verifyLocalServerCandidate: () => {}, verifyLocalClientCandidate: () => {}, runtimeHost: { platform: 'linux', arch: 'x64', libc: '2.41', nodeMajor: 24, nodeModules: 137 }, buildTarget: target, runtimeTarget: target,
        runtimeRoots: () => ['@openai/codex-sdk', 'runtime-fixture', 'semver'], runtimeSmoke: () => {}, observeForwardProfile: () => ({
            source: { schemaDigest: H('1'), compatibilityShapeDigest: H('2'), migrationStateDigest: H('3') },
            target: { schemaDigest: H('4'), compatibilityShapeDigest: H('5'), migrationStateDigest: H('6') } }) });
    const identity = { kind: 'owner-reviewed-local-build/v1', build: built.manifest.build, artifact: built.preparedArtifact };
    const prepared = prepareInitialReleaseRuntime({ kind: identity.kind, profile: 'forward', deployRoot: path.join(root, 'deploy'),
        assetFile: built.asset, manifestFile: built.publishedManifest, nodeInstanceId: 'fixture-node', expected: identity, runtimeHost: { platform: 'linux', arch: 'x64', libc: '2.41', nodeMajor: 24, nodeModules: 137 } });
    return { built, identity, generation: path.join(root, 'deploy/releases', prepared.generationId) };
}
async function fixture(t, options = {}) {
    const root = fs.mkdtempSync(path.join(ROOT, '.artifacts/b951-config-'));
    // Model trusted deployment ancestors without changing this shared host's modes.
    // Descendants are deliberately excluded so unsafe-parent negatives stay real.
    const ancestors = new Set();
    for (let directory = root; ; directory = path.dirname(directory)) {
        ancestors.add(directory);
        if (directory === path.dirname(directory)) break;
    }
    const nativeLstat = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (file, ...args) => {
        const info = nativeLstat(file, ...args);
        if (typeof file === 'string' && ancestors.has(file) && info.isDirectory()) {
            info.mode = typeof info.mode === 'bigint' ? info.mode & ~0o022n : info.mode & ~0o022;
        }
        return info;
    });
    const execPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath');
    t.after(() => {
        Object.defineProperty(process, 'execPath', execPathDescriptor);
        execFileSync('/usr/bin/chmod', ['-R', 'u+w', root]); fs.rmSync(root, { recursive: true, force: true });
    });
    const fixtureNode = path.join(root, 'bin/node'); fs.mkdirSync(path.dirname(fixtureNode), { mode: 0o700 });
    fs.chmodSync(path.dirname(fixtureNode), 0o700);
    fs.copyFileSync(process.execPath, fixtureNode, fs.constants.COPYFILE_EXCL); fs.chmodSync(fixtureNode, 0o755);
    const nodeSha256 = pin(process.execPath).sha256;
    assert.equal(pin(fixtureNode).sha256, nodeSha256);
    const probe = spawnSync(fixtureNode, ['-e', `const fs=require('node:fs'),crypto=require('node:crypto');
        console.log(JSON.stringify({path:process.execPath,sha256:crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex')}));`], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout), { path: fixtureNode, sha256: nodeSha256 });
    // Only the parent API path is simulated; the child above executed the exact copied binary.
    Object.defineProperty(process, 'execPath', { ...execPathDescriptor, value: fixtureNode });
    const runtime = runtimeFixture(root, options);
    // The fixture owns the archive location; keep it private regardless of the runner umask.
    fs.mkdirSync(path.join(root, 'installer'), { mode: 0o700 });
    fs.chmodSync(path.join(root, 'installer'), 0o700);
    const installer = buildReleaseInstaller({ profile: 'forward', runtime: runtime.identity, version: runtime.identity.build.version,
        commit: runtime.identity.build.commit, temporaryRoot: root, outputDirectory: path.join(root, 'installer') });
    fs.chmodSync(installer.asset, 0o644);
    const extracted = path.join(root, 'extracted'); fs.mkdirSync(extracted, { mode: 0o700 });
    execFileSync('/usr/bin/tar', ['-xzf', installer.asset, '-C', extracted]);
    const api = await import(pathToFileURL(path.join(extracted, 'scripts/install-release-host-support.mjs')).href);
    const host = path.join(root, 'host'); fs.mkdirSync(path.join(host, 'etc/nassaj'), { recursive: true, mode: 0o755 });
    const map = file => path.join(host, file), calls = [], unit = fs.readFileSync(path.join(extracted, 'ops/nassaj-maintenance.service'), 'utf8');
    const injected = { allowUnprivileged: true, fixtureRoot: root, sourceRoot: extracted, mapTarget: map,
        exec(file, args) { calls.push([file, args]); return file === '/usr/bin/systemctl' && args[0] === 'cat'
            ? `# /etc/systemd/system/nassaj-maintenance.service\n${unit}` : ''; } };
    const installRequest = { schema: 'nassaj-release-host-support-install-request/v1', installerArchive: { path: installer.asset,
        sha256: installer.assetSha256, size: installer.size }, flockSha256: pin('/usr/bin/flock').sha256 };
    const support = api.installForwardReleaseHostSupport(installRequest, injected);
    const dispatcher = pin(map('/usr/local/lib/nassaj-release-operator/scripts/release-runtime-host-dispatcher.mjs'));
    const generation = runtime.generation, artifact = runtime.identity.artifact;
    const database = path.join(root, 'database-stat-only'); write(database, 'stat-only fixture', 0o600);
    const saved = path.join(root, 'dump.json'); write(saved, JSON.stringify([{ name: 'nassaj-dev', namespace: 'default' }]), 0o600);
    const unitFile = path.join(root, 'fixture.service'), ingressFile = path.join(root, 'cloudflared.yml');
    write(unitFile, '[Service]\nExecStart=/usr/bin/false'); write(ingressFile, 'service: http://127.0.0.1:3004');
    const unitRecord = { Id: 'fixture.service', LoadState: 'loaded', ActiveState: 'active', UnitFileState: 'enabled',
        ControlGroup: '/fixture', FragmentPath: unitFile, DropInPaths: '', ExecStart: '/fixture', ExecStartPre: '' };
    const serviceIdentity = { uid: process.getuid(), gid: process.getgid(), supplementaryGids: [...new Set(process.getgroups())].sort((a,b) => a-b) };
    const old = { pid: 4242, startTicks: '5', bootId: '12345678-1234-1234-1234-123456789012', uids: Array(4).fill(serviceIdentity.uid),
        gids: Array(4).fill(serviceIdentity.gid), supplementaryGids: serviceIdentity.supplementaryGids, capabilities: ['0','0','0'] };
    const keys = generateKeyPairSync('ed25519'), ownerKey = path.join(root, 'fixture-owner-public.pem');
    write(ownerKey, keys.publicKey.export({ type: 'spki', format: 'pem' }), 0o600);
    const node = pin(process.execPath);
    // Maintenance commands use the exec seam below; only their pinned identity is real.
    const maintenanceExecutable = pin('/usr/bin/true');
    assert.equal(fs.statSync(maintenanceExecutable.path).uid, 0);
    const input = { schema: 'nassaj-forward-preparation-input/v1', operationId: 'fixture-operation-0001', nodeInstanceId: 'fixture-node',
        generationRoot: generation, build: runtime.identity.build, artifact, observer: { daemon: { pid: process.pid } },
        slot: { pm2Id: 4, name: 'nassaj-dev', namespace: 'default' },
        definitions: [{ sourceId: 'dump', path: saved, format: 'pm2-dump-json', writerSourceIds: ['writer'] }],
        controllers: [{ sourceId: 'writer', scope: 'system', user: null, unit: unitRecord.Id, cgroupPath: '/fixture', optional: false, creationSourceIds: [] }],
        inventory: [{ kind: 'file', path: saved }], serviceIdentity,
        targetPolicy: { exec_mode: 'fork_mode', pm_out_log_path: path.join(root,'out'), pm_err_log_path: path.join(root,'err'), pm_pid_path: path.join(root,'pid'),
            status: 'stopped', autostart: true, autorestart: false, watch: false, pmx: false, vizion: false, wait_ready: false,
            restart_time: 0, unstable_restarts: 0, prev_restart_delay: 0, env: {} },
        hostIdentityFiles: [saved, ...support.files.map(file => file.path)], policies: { health: { privateUrl: 'http://127.0.0.1:3004/health', publicUrl: 'https://fixture.invalid/health' },
            maintenance: { nonce: 'nassaj-maintenance-v1', retryAfterSeconds: 30, responderUnit: 'fixture-maintenance.service', responderPort: 3311,
                cloudflared: { unit: 'fixture-ingress.service', configFile: ingressFile, originHost: '127.0.0.1', originPort: 3004 } }, probeTimeoutMs: 1000 },
        executables: { node, sudo: pin('/usr/bin/sudo'), dispatcher, systemctl: pin('/usr/bin/systemctl'), zeroWorkProbe: node, nft: maintenanceExecutable, conntrack: maintenanceExecutable },
        locations: { outputRoot: path.join(root, 'prepared'), controlRoot: root, databaseFile: database,
            approvalFile: path.join(root, 'fixture-approval.json'), ownerPublicKeyFile: ownerKey } };
    const deps = { observe: async () => ({ privateEntries: [{ pm_id: 4, name: 'nassaj-dev', pid: old.pid, pm2_env: { namespace: 'default', status: 'online' } }] }),
        inspectProcess: () => old, metadata: () => ({ version: 'fixture', nodeVersion: process.versions.node }), trustedFile: pin,
        inspectIngress: () => ({ ...old, startTicks: '12345678' }), ingressExecutable: () => maintenanceExecutable.path,
        maintenance: { ingressProcessIdentity: () => ({ pid: old.pid, startTime: '12345678' }),
            readIngressProc: file => file.endsWith('/status') ? `Uid:\t${serviceIdentity.uid}\n` : '0::/system.slice/fixture-ingress.service', ingressExecutable: () => maintenanceExecutable.path },
        exec: (_file,args) => args.includes('--property=MainPID') ? String(old.pid) : args.includes('--value') ? unitFile
            : Object.entries(unitRecord).map(([key,value]) => `${key}=${value}`).join('\n'),
        startup: { effectiveUid: () => 0, readRootBytes: file => fs.readFileSync(file) } };
    const produced = await generateFirstForwardConfiguration(input, deps);
    assert.equal(produced.complete, true, JSON.stringify(produced.report));
    const privateFile = path.join(produced.outputRoot, 'release-runtime-host.forward.json');
    const publicFile = path.join(produced.outputRoot, 'startup-admission-client.json');
    const request = { ...installRequest, schema: 'nassaj-release-host-support-config-request/v1',
        preparedConfig: { ...pin(privateFile), size: fs.statSync(privateFile).size }, publicDescriptor: { ...pin(publicFile), size: fs.statSync(publicFile).size } };
    return { root, runtime, api, injected, map, request, calls, keys, producerExec: deps.exec, approvalFile: input.locations.approvalFile, install: () => api.installForwardReleaseConfiguration(request, injected) };
}
test('actual tiny archive and bootstrap prepare exact configuration for the installed standalone writer', { concurrency: false }, async t => {
    const f = await fixture(t);
    const result = f.install(); assert.equal(result.phase, 'configuration_attested'); assert.equal(result.state, 'configured');
    assert.deepEqual(fs.readFileSync(f.map('/etc/nassaj/release-runtime-host.json')), fs.readFileSync(f.request.preparedConfig.path));
    assert.equal(f.install().state, 'already_configured');
    const installedConfig = f.map('/etc/nassaj/release-runtime-host.json'), privateKey = path.join(f.root, 'fixture-owner-private.pem');
    write(privateKey, f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), 0o600);
    assert.ok(mintCutoverApproval({ forwardConfig: installedConfig, privateKeyFile: privateKey, out: f.approvalFile }));
    const config = JSON.parse(fs.readFileSync(installedConfig));
    const request = preflightFirstForwardConfiguration(config, { pin: value => fs.readFileSync(value.path),
        pinnedRecord: value => JSON.parse(fs.readFileSync(value.path)), exec: f.producerExec });
    assert.equal(request.transactionId, 'fixture-operation-0001');
});

function consumeCrashState(t, f) {
    const prefix = '/etc/nassaj', native = { lstat: fs.lstatSync, fstat: fs.fstatSync, open: fs.openSync, realpath: fs.realpathSync };
    const mapped = file => typeof file === 'string' && (file === '/etc' || file === prefix || file.startsWith(prefix + '/')) ? f.map(file) : file;
    const identities = new Set();
    t.mock.method(process, 'geteuid', () => 0);
    t.mock.method(fs, 'lstatSync', (file, ...args) => {
        const info = native.lstat(mapped(file), ...args);
        if (mapped(file) !== file) { info.uid = 0; identities.add(`${info.dev}:${info.ino}`); } return info;
    });
    t.mock.method(fs, 'fstatSync', (...args) => { const info = native.fstat(...args); if (identities.has(`${info.dev}:${info.ino}`)) info.uid = 0; return info; });
    t.mock.method(fs, 'openSync', (file, ...args) => native.open(mapped(file), ...args));
    t.mock.method(fs, 'realpathSync', (file, ...args) => mapped(file) === file ? native.realpath(file, ...args)
        : native.realpath(mapped(file), ...args) === mapped(file) ? file : native.realpath(mapped(file), ...args));
}


test('actual writer crash after host rename keeps all authority consumers closed without rewriting prepared bytes', { concurrency: false }, async t => {
    const f = await fixture(t), original = fs.renameSync, order = [];
    fs.renameSync = function(from, to) {
        const result = original(from, to);
        if ([f.map('/etc/nassaj/startup-admission-client.json'), f.map('/etc/nassaj/release-runtime-host.json')].includes(to)) order.push(to);
        if (to === f.map('/etc/nassaj/release-runtime-host.json')) throw Error('fixture crash after host rename');
        return result;
    };
    syncBuiltinESMExports();
    try { assert.throws(f.install, /crash after host rename/); }
    finally { fs.renameSync = original; syncBuiltinESMExports(); }
    assert.deepEqual(order, [f.map('/etc/nassaj/startup-admission-client.json'), f.map('/etc/nassaj/release-runtime-host.json')]);
    const attestation = JSON.parse(fs.readFileSync(f.map('/etc/nassaj/release-host-support-attestation.json')));
    assert.equal(attestation.phase, 'configuring'); assert.equal(attestation.configHandoff.ready, false);
    assert.deepEqual(fs.readFileSync(f.map('/etc/nassaj/release-runtime-host.json')), fs.readFileSync(f.request.preparedConfig.path));
    assert.throws(f.install, /config_partial/);
    consumeCrashState(t, f);
    const request = { schema: 'nassaj-forward-activation-operation/v1', operationId: 'fixture-operation-0001' };
    try {
        for (const consumer of [() => readRootConfig(), () => runPreparedForwardMigrationOperator(request),
            () => runResumedForwardOperator(request), () => runReconciledForwardOperator(request),
            () => readForwardChildMaterial(), () => withVerifiedCutoverStateMutex('/fixture/control', () => assert.fail('state callback ran'))]) {
            await assert.rejects(async () => consumer(), /installed_config_not_configured/);
        }
    } finally { t.mock.restoreAll(); }
});


test('a runtime responder copy must match the independently sealed installer while absence remains allowed', { concurrency: false }, async t => {
    const f = await fixture(t, { responder: true });
    assert.equal(f.install().state, 'configured');
});

test('writer rejects every changed or missing shared witness without installing configuration', { concurrency: false }, async t => {
    const f = await fixture(t, { responder: true });
    const generation = f.runtime.generation;
    const mutate = async (name, file, action) => {
        await t.test(name, () => {
            const original = fs.readFileSync(file), mode = fs.statSync(file).mode & 0o777;
            try {
                action(file);
                assert.throws(f.install);
                assert.equal(JSON.parse(fs.readFileSync(f.map('/etc/nassaj/release-host-support-attestation.json'))).phase, 'support_installed');
                assert.equal(fs.existsSync(f.map('/etc/nassaj/release-runtime-host.json')), false);
                assert.equal(fs.existsSync(f.map('/etc/nassaj/startup-admission-client.json')), false);
            } finally {
                try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
                write(file, original, mode);
            }
        });
    };
    const responder = path.join(generation, 'dist-server/scripts/nassaj-maintenance-responder.mjs');
    await mutate('present responder tamper', responder, file => fs.appendFileSync(file, '\n// tamper'));
    await mutate('present responder dangling link', responder, file => { fs.unlinkSync(file); fs.symlinkSync(file + '.missing', file); });
    await mutate('present responder wrong mode', responder, file => fs.chmodSync(file, 0o600));
    const shared = 'scripts/lib/release-runtime-startup-admission.mjs';
    assert.ok(fs.existsSync(path.join(generation, shared)));
    assert.ok(fs.existsSync(path.join(generation, 'dist-server/UPDATE_RUNTIME_BUNDLE', shared)));
    await mutate('one changed duplicate cannot use the intact witness', path.join(generation, shared), file => fs.appendFileSync(file, '\n// tamper'));
    await mutate('missing bundle-only shared dependency', path.join(generation, 'dist-server/UPDATE_RUNTIME_BUNDLE/scripts/lib/release-database-backup.mjs'), file => fs.unlinkSync(file));
    await t.test('unlisted duplicate is not ignored', () => {
        const file = path.join(generation, 'scripts/lib/release-database-backup.mjs');
        assert.equal(fs.existsSync(file), false);
        write(file, fs.readFileSync(path.join(generation, 'dist-server/UPDATE_RUNTIME_BUNDLE/scripts/lib/release-database-backup.mjs')));
        try { assert.throws(f.install); } finally { fs.unlinkSync(file); }
        assert.equal(fs.existsSync(f.map('/etc/nassaj/release-runtime-host.json')), false);
    });
});

test('writer requires exact reviewed requests and rejects independently repinned inconsistent input bytes', { concurrency: false }, async t => {
    const f = await fixture(t), original = structuredClone(f.request);
    for (const name of ['unknown', 'wrongHash', 'descriptor', 'wrongGeneration']) await t.test(name, () => {
        const privateBytes = fs.readFileSync(original.preparedConfig.path), publicBytes = fs.readFileSync(original.publicDescriptor.path);
        try {
            if (name === 'unknown') f.request.extraAuthority = true;
            if (name === 'wrongHash') f.request.preparedConfig.sha256 = H('0');
            if (name === 'descriptor') {
                const value = JSON.parse(publicBytes); value.nodeInstanceId = 'other-node'; write(original.publicDescriptor.path, JSON.stringify(value));
                f.request.publicDescriptor = { ...pin(original.publicDescriptor.path), size: fs.statSync(original.publicDescriptor.path).size };
            }
            if (name === 'wrongGeneration') {
                const value = JSON.parse(privateBytes); value.forwardMigration.wrapper.path = path.join(f.root, 'wrong-wrapper.mjs');
                write(original.preparedConfig.path, JSON.stringify(value), 0o600);
                f.request.preparedConfig = { ...pin(original.preparedConfig.path), size: fs.statSync(original.preparedConfig.path).size };
            }
            assert.throws(f.install);
            assert.equal(fs.existsSync(f.map('/etc/nassaj/release-runtime-host.json')), false);
        } finally {
            for (const key of Object.keys(f.request)) delete f.request[key]; Object.assign(f.request, structuredClone(original));
            write(original.preparedConfig.path, privateBytes, 0o600); write(original.publicDescriptor.path, publicBytes);
        }
    });
});

test('private request contract and executable closure are mandatory measured inputs with unchanged config pins', { concurrency: false }, async t => {
    const f = await fixture(t), configBytes = fs.readFileSync(f.request.preparedConfig.path), config = JSON.parse(configBytes);
    const originalPin = structuredClone(f.request.preparedConfig);
    for (const field of ['request', 'contract', 'closure']) for (const action of ['missing', 'tampered', 'wrongMode']) await t.test(`${field} ${action}`, () => {
        const file = config.forwardMigration[field].path, original = fs.readFileSync(file);
        try {
            if (action === 'missing') fs.unlinkSync(file);
            if (action === 'tampered') fs.appendFileSync(file, ' ');
            if (action === 'wrongMode') fs.chmodSync(file, 0o644);
            assert.throws(f.install);
            assert.deepEqual(f.request.preparedConfig, originalPin);
            assert.deepEqual(fs.readFileSync(f.request.preparedConfig.path), configBytes);
            assert.equal(fs.existsSync(f.map('/etc/nassaj/release-runtime-host.json')), false);
            assert.equal(JSON.parse(fs.readFileSync(f.map('/etc/nassaj/release-host-support-attestation.json'))).phase, 'support_installed');
        } finally { write(file, original, 0o600); }
    });
    for (const change of ['phase', 'database', 'closure-extra', 'contract']) await t.test(`independently repinned invalid ${change}`, () => {
        const field = change.startsWith('closure') ? 'closure' : change === 'contract' ? 'contract' : 'request';
        const file = config.forwardMigration[field].path, original = fs.readFileSync(file), value = JSON.parse(original);
        const altered = structuredClone(config);
        try {
            if (change === 'phase') value.expectedPhase = 'activation';
            if (change === 'database') value.database.inode = '999999999';
            if (change === 'closure-extra') value.files.push(value.files[0]);
            if (change === 'contract') value.extraAuthority = true;
            write(file, JSON.stringify(value), 0o600); altered.forwardMigration[field] = pin(file);
            if (field === 'closure') altered.expected.forwardExecutableClosureSha256 = pin(file).sha256;
            write(f.request.preparedConfig.path, JSON.stringify(altered), 0o600);
            f.request.preparedConfig = { ...pin(f.request.preparedConfig.path), size: fs.statSync(f.request.preparedConfig.path).size };
            assert.throws(f.install, /config_private_/);
            assert.equal(fs.existsSync(f.map('/etc/nassaj/release-runtime-host.json')), false);
        } finally {
            write(file, original, 0o600); write(originalPin.path, configBytes, 0o600); f.request.preparedConfig = structuredClone(originalPin);
        }
    });
});


test('forward configuration CLI rejects malformed input without echoing private request content', { concurrency: false }, () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/install-release-host-support.mjs'), '--forward-config'],
        { input: 'SECRET_FIXTURE_PRIVATE_INPUT', encoding: 'utf8', timeout: 6000 });
    assert.equal(result.status, 78); assert.equal(result.stdout, '');
    assert.match(result.stderr, /release_host_support_forward_validation_failed/);
    assert.doesNotMatch(result.stderr, /SECRET_FIXTURE_PRIVATE_INPUT/);
});


test('writer verifies every host identity row and coverage before configuration authority', { concurrency: false }, async t => {
    const f = await fixture(t), originalPin = structuredClone(f.request.preparedConfig), originalBytes = fs.readFileSync(originalPin.path);
    const original = JSON.parse(originalBytes), dump = original.forwardActivation.hostIdentity.files[0].path;
    assert.equal(fs.statSync(dump).uid, original.forwardMigration.serviceIdentity.uid);
    assert.notEqual(original.forwardMigration.serviceIdentity.uid, 0);
    for (const kind of ['missing-support','duplicate','wrong-size','too-large','reorder','application-uid','other-uid','prepared-cycle','public-cycle','attestation-cycle','hardlink','symlink']) {
        await t.test(kind, () => {
            const value = structuredClone(original), rows = value.forwardActivation.hostIdentity.files;
            const alias = path.join(f.root, 'identity-alias'); let cleanup = () => {};
            try {
                if (kind === 'missing-support') rows.splice(rows.findIndex(row => row.path.includes('/node_modules/semver/')), 1);
                if (kind === 'duplicate') rows.push(rows[0]);
                if (kind === 'wrong-size') rows[0].size++;
                if (kind === 'too-large') rows[0].size = 384 * 1024 * 1024 + 1;
                if (kind === 'reorder') rows.reverse();
                if (kind === 'application-uid') value.bootstrapClaim.applicationUid++;
                if (kind === 'prepared-cycle') rows.push({ ...pin(originalPin.path), size: originalBytes.length });
                if (kind === 'public-cycle') rows.push({ ...pin(f.request.publicDescriptor.path), size: f.request.publicDescriptor.size });
                if (kind === 'attestation-cycle') rows.push({ ...pin(f.map('/etc/nassaj/release-host-support-attestation.json')),
                    size: fs.statSync(f.map('/etc/nassaj/release-host-support-attestation.json')).size });
                if (kind === 'hardlink') { fs.linkSync(dump, alias); cleanup = () => fs.unlinkSync(alias); rows.push({ path: alias, sha256: rows[0].sha256, size: rows[0].size }); }
                if (kind === 'symlink') { fs.symlinkSync(dump, alias); cleanup = () => fs.unlinkSync(alias); rows.push({ path: alias, sha256: rows[0].sha256, size: rows[0].size }); }
                if (kind === 'other-uid') {
                    const native = fs.lstatSync;
                    t.mock.method(fs, 'lstatSync', (file,...args) => { const info = native(file,...args); if (file === dump) info.uid = original.forwardMigration.serviceIdentity.uid + 1; return info; });
                    syncBuiltinESMExports();
                }
                if (kind !== 'reorder') value.expected.hostIdentitySha256 = sha(JSON.stringify(rows));
                write(originalPin.path, JSON.stringify(value), 0o600);
                f.request.preparedConfig = { ...pin(originalPin.path), size: fs.statSync(originalPin.path).size };
                assert.throws(f.install, /host_identity_/);
                assert.equal(JSON.parse(fs.readFileSync(f.map('/etc/nassaj/release-host-support-attestation.json'))).phase, 'support_installed');
                assert.equal(fs.existsSync(f.map('/etc/nassaj/release-runtime-host.json')), false);
            } finally { t.mock.restoreAll(); syncBuiltinESMExports(); cleanup(); write(originalPin.path, originalBytes, 0o600); f.request.preparedConfig = structuredClone(originalPin); }
        });
    }
});


test('private material rejects above256KiB before opening the file or configuring', { concurrency: false }, async t => {
    const f = await fixture(t), config = JSON.parse(fs.readFileSync(f.request.preparedConfig.path));
    for (const field of ['request', 'contract', 'closure']) await t.test(field, () => {
        const file = config.forwardMigration[field].path, original = fs.readFileSync(file), native = fs.openSync; let opened = false;
        write(file, Buffer.alloc(256 * 1024 + 1, 32), 0o600);
        fs.openSync = function(target, ...args) { if (target === file) opened = true; return native(target, ...args); };
        syncBuiltinESMExports();
        try {
            assert.throws(f.install, /file_unsafe/); assert.equal(opened, false);
            assert.equal(JSON.parse(fs.readFileSync(f.map('/etc/nassaj/release-host-support-attestation.json'))).phase, 'support_installed');
            assert.equal(fs.existsSync(f.map('/etc/nassaj/release-runtime-host.json')), false);
        } finally { fs.openSync = native; syncBuiltinESMExports(); write(file, original, 0o600); }
    });
});
