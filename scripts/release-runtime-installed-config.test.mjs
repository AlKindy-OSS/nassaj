import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readInstalledHostConfiguration, INSTALLED_HOST_CONFIG_PATH as CONFIG } from './lib/release-runtime-installed-config.mjs';
import { readRootConfig } from './release-runtime-host-dispatcher.mjs';
import { readForwardRootRecord } from './lib/release-runtime-forward-retirement.mjs';
import { readForwardChildMaterial } from './release-runtime-forward-child.mjs';
import { readManagedChildMaterial } from './release-runtime-managed-child.mjs';
import { runPreparedForwardMigrationOperator, runResumedForwardOperator, runReconciledForwardOperator, runManagedOperator } from './release-runtime-forward-parent.mjs';
import { runForwardSupervisorChild } from './lib/release-runtime-forward-supervisor.mjs';
import { withVerifiedCutoverStateMutex } from './lib/release-runtime-state-mutex.mjs';
import { generateStartupPublicDescriptor } from './lib/release-runtime-public-descriptor.mjs';

const PUBLIC = '/etc/nassaj/startup-admission-client.json';
const ATTESTATION = '/etc/nassaj/release-host-support-attestation.json';
const OPERATOR = '/usr/local/lib/nassaj-release-operator';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = { sha256: 'a'.repeat(64), size: 1 };
const legacy = { schema: 'nassaj-release-runtime-host-config/v1', controlRoot: '/fixture/control', expected: {} };

// Every fixed root path maps to this private fixture before any consumer call; no Git or service writer runs.
function fixture(t) {
    const root = fs.mkdtempSync(path.resolve('.artifacts/b951-installed-'));
    const native = { lstat: fs.lstatSync, fstat: fs.fstatSync, open: fs.openSync, realpath: fs.realpathSync };
    const map = file => typeof file === 'string' && (file === '/etc/nassaj' || file.startsWith('/etc/nassaj/')
        || file === OPERATOR || file.startsWith(`${OPERATOR}/`)) ? path.join(root, file) : file;
    const write = (file, value, mode = 0o600) => {
        // Mapped host directories model root-owned 0755 ancestors, independent of the runner umask.
        const target = map(file); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
        fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value)); fs.chmodSync(target, mode);
        return fs.readFileSync(target);
    };
    const identities = new Set();
    t.mock.method(process, 'geteuid', () => 0);
    t.mock.method(fs, 'lstatSync', (file, ...args) => {
        const info = native.lstat(map(file), ...args);
        if (map(file) !== file) { info.uid = 0; identities.add(`${info.dev}:${info.ino}`); }
        return info;
    });
    t.mock.method(fs, 'fstatSync', (...args) => {
        const info = native.fstat(...args); if (identities.has(`${info.dev}:${info.ino}`)) info.uid = 0; return info;
    });
    t.mock.method(fs, 'openSync', (file, ...args) => {
        const fd = native.open(map(file), ...args);
        if (map(file) !== file) { const info = native.fstat(fd); identities.add(`${info.dev}:${info.ino}`); }
        return fd;
    });
    t.mock.method(fs, 'realpathSync', (file, ...args) => map(file) === file ? native.realpath(file, ...args)
        : native.realpath(map(file), ...args) === map(file) ? file : native.realpath(map(file), ...args));
    const argv = process.argv; process.argv = [process.execPath, 'fixture'];
    t.after(() => { process.argv = argv; t.mock.restoreAll(); fs.rmSync(root, { recursive: true, force: true }); });
    const records = ['scripts/nassaj-maintenance-responder.mjs', 'scripts/release-runtime-host-dispatcher.mjs'].map(relative => {
        const file = `${OPERATOR}/${relative}`, bytes = write(file, 'export const fixture = true;', 0o555);
        return { relative, path: file, mode: 0o555, size: bytes.length, sha256: sha(bytes) };
    });
    const dispatcher = records[1];
    const manifestFile = '/etc/nassaj/fixture-release-manifest.json';
    const manifestBytes = write(manifestFile, { fixture: true });
    const runtimePin = { sha256: sha(manifestBytes), size: manifestBytes.length };
    const config = { ...legacy, forwardActivation: { dispatcher: { path: dispatcher.path, sha256: dispatcher.sha256 } },
        bootstrapClaim: { releaseManifestFile: manifestFile, releaseManifestSha256: runtimePin.sha256, dispatcherExecutable: dispatcher.path, dispatcherSha256: dispatcher.sha256 },
        expected: { localArtifact: { manifestSha256: runtimePin.sha256, manifestSize: runtimePin.size } } };
    const descriptor = { dispatcher: { path: dispatcher.path, sha256: dispatcher.sha256 } };
    const record = { schema: 'nassaj-release-host-support-attestation/v2', profile: 'forward', phase: 'configuration_attested',
        installerArchive: pin, installerManifest: pin, runtimeManifest: runtimePin, files: records,
        sourceSetSha256: sha(records.map(file => `${file.relative}\0${file.mode}\0${file.size}\0${file.sha256}\n`).join('')),
        effectiveUnitSha256: pin.sha256, effectiveUnitSize: 1, configHandoff: { ready: true, files: [] } };
    const seal = () => {
        const configBytes = write(CONFIG, config), descriptorBytes = write(PUBLIC, descriptor, 0o644);
        record.configHandoff.files = [{ path: CONFIG, mode: 0o600, size: configBytes.length, sha256: sha(configBytes) },
            { path: PUBLIC, mode: 0o644, size: descriptorBytes.length, sha256: sha(descriptorBytes) }];
        write(ATTESTATION, record);
    };
    seal(); return { root, map, write, seal, config, descriptor, record, native };
}

test('B951 installed gate consumes exact attested bytes and detects every independently drifting binding', async t => {
    for (const kind of ['valid', 'config', 'descriptor', 'source', 'sourceSet', 'runtimePin', 'runtimeBytes', 'runtimeMode', 'dispatcher', 'mode', 'symlink', 'attestationMode']) await t.test(kind, child => {
        const f = fixture(child);
        if (kind === 'config') fs.appendFileSync(f.map(CONFIG), ' ');
        if (kind === 'descriptor') fs.appendFileSync(f.map(PUBLIC), ' ');
        if (kind === 'source') { const file = f.map(f.record.files[0].path); fs.chmodSync(file, 0o755); fs.appendFileSync(file, ' '); fs.chmodSync(file, 0o555); }
        if (kind === 'sourceSet') { f.record.sourceSetSha256 = 'b'.repeat(64); f.seal(); }
        if (kind === 'runtimePin') { f.config.expected.localArtifact.manifestSize++; f.seal(); }
        if (kind === 'runtimeBytes') fs.appendFileSync(f.map(f.config.bootstrapClaim.releaseManifestFile), ' ');
        if (kind === 'runtimeMode') fs.chmodSync(f.map(f.config.bootstrapClaim.releaseManifestFile), 0o644);
        if (kind === 'dispatcher') { f.descriptor.dispatcher.sha256 = 'b'.repeat(64); f.seal(); }
        if (kind === 'mode') fs.chmodSync(f.map(CONFIG), 0o644);
        if (kind === 'attestationMode') fs.chmodSync(f.map(ATTESTATION), 0o644);
        if (kind === 'symlink') { fs.renameSync(f.map(CONFIG), f.map(`${CONFIG}.other`)); fs.symlinkSync(f.map(`${CONFIG}.other`), f.map(CONFIG)); }
        if (kind !== 'valid') return assert.throws(readInstalledHostConfiguration, /installed_config_/);
        const actual = readInstalledHostConfiguration(); assert.deepEqual(actual.value, f.config);
        assert.deepEqual(actual.bytes, fs.readFileSync(f.map(CONFIG))); assert.deepEqual(readRootConfig(), f.config);
        assert.deepEqual(readForwardRootRecord(CONFIG), f.config);
    });
});

test('B951 actual authority consumers all reject the crash window before callbacks or effects', async t => {
    const request = { schema: 'nassaj-forward-activation-operation/v1', operationId: 'fixture-operation' };
    const consumers = {
        dispatcher: () => readRootConfig(), fresh: () => runPreparedForwardMigrationOperator(request),
        resume: () => runResumedForwardOperator(request), reconcile: () => runReconciledForwardOperator(request),
        managedParent: () => runManagedOperator('restartCommittedGeneration', { ...request, schema: 'nassaj-managed-restart-request/v1' }),
        migrationChild: () => readForwardChildMaterial(), observationChild: () => readForwardChildMaterial('observe-target'),
        managedChild: () => readManagedChildMaterial(), supervisorStop: () => runForwardSupervisorChild('stop', request.operationId),
        supervisorStart: () => runForwardSupervisorChild('start', request.operationId),
        stateMutex: () => withVerifiedCutoverStateMutex('/fixture/control', () => assert.fail('callback ran')),
        publicDescriptor: () => generateStartupPublicDescriptor(),
    };
    for (const phase of ['installing', 'support_installed', 'configuring']) await t.test(phase, async phaseTest => {
        const f = fixture(phaseTest); f.record.phase = phase; f.seal();
        for (const [name, consume] of Object.entries(consumers)) await phaseTest.test(name, async () => {
            await assert.rejects(async () => consume(), /installed_config_not_configured/);
        });
        f.write(CONFIG, legacy);
        await assert.rejects(async () => consumers.dispatcher(), /installed_config_not_configured/);
    });
});

test('B951 missing and v1 attestations permit only proven legacy configs without forward paths', async t => {
    for (const kind of ['missing', 'v1']) await t.test(kind, async child => {
        const f = fixture(child); fs.unlinkSync(f.map(PUBLIC)); f.write(CONFIG, legacy);
        if (kind === 'missing') fs.unlinkSync(f.map(ATTESTATION)); else f.write(ATTESTATION, { schema: 'nassaj-release-host-support-attestation/v1' });
        assert.deepEqual(readInstalledHostConfiguration().value, legacy);
        for (const extra of [{ forwardMigration: null }, { managedRestart: {} }, { bootstrapClaim: {} },
            { expected: { localArtifact: {} } }, { wrapper: '/generation/scripts/release-runtime-forward-child.mjs' },
            { profile: 'local-forward-349/v1' }]) {
            f.write(CONFIG, { ...legacy, ...extra }); assert.throws(readInstalledHostConfiguration, /attestation_required/);
        }
    });
});

test('B951 rejects attestation replacement during config observation without parsing replacement authority', t => {
    const f = fixture(t), original = fs.readSync; let changed = false;
    t.mock.method(fs, 'readSync', (...args) => {
        const count = original(...args);
        if (!changed && f.native.fstat(args[0]).ino === f.native.lstat(f.map(CONFIG)).ino) {
            changed = true; f.record.phase = 'configuring'; f.write(ATTESTATION, f.record);
        }
        return count;
    });
    assert.throws(readInstalledHostConfiguration, /installed_config_changed/); assert.ok(changed);
});

test('B951 opened config and descriptor changes cannot replace the bytes actually consumed', async t => {
    for (const file of [CONFIG, PUBLIC]) await t.test(path.basename(file), child => {
        const f = fixture(child), original = fs.readSync; let changed = false;
        child.mock.method(fs, 'readSync', (...args) => {
            const count = original(...args);
            if (!changed && f.native.fstat(args[0]).ino === f.native.lstat(f.map(file)).ino) {
                changed = true;
                const bytes = fs.readFileSync(f.map(file)); bytes[1] = bytes[1] === 32 ? 33 : 32;
                fs.writeFileSync(f.map(file), bytes);
            }
            return count;
        });
        assert.throws(readInstalledHostConfiguration, /installed_config_changed/); assert.ok(changed);
    });
});

test('B951 actual dispatcher rejects present falsy attestation JSON instead of treating it as absent', async t => {
    for (const value of [null, false, 0, '']) await t.test(JSON.stringify(value), child => {
        const f = fixture(child); f.write(CONFIG, legacy); fs.unlinkSync(f.map(PUBLIC));
        f.write(ATTESTATION, JSON.stringify(value));
        assert.throws(readRootConfig, /installed_config_attestation_schema/);
    });
});

test('B951 attested non-local manifest binding works while a present invalid local binding refuses', async t => {
    for (const kind of ['absent', 'null', 'mismatch']) await t.test(kind, child => {
        const f = fixture(child);
        if (kind === 'absent') delete f.config.expected.localArtifact;
        if (kind === 'null') f.config.expected.localArtifact = null;
        if (kind === 'mismatch') f.config.expected.localArtifact.manifestSha256 = 'b'.repeat(64);
        f.seal();
        if (kind === 'absent') assert.deepEqual(readRootConfig(), f.config);
        else assert.throws(readRootConfig, /installed_config_runtime_binding/);
    });
});
