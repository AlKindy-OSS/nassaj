import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildReleaseInstaller } from './build-release-installer.mjs';
import { localBuildIdentitySha256 } from './lib/local-reviewed-build-identity.mjs';
import { verifyForwardInstallerArchive, installReleaseHostSupport } from './install-release-host-support.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function runtimeIdentity() {
    const kind = 'owner-reviewed-local-build/v1';
    const build = { kind, projectId: 'fixture', commit: 'a'.repeat(40), sourceTreeSha256: 'b'.repeat(64),
        inputManifestSha256: 'c'.repeat(64), profileId: 'local-forward-349/v1', version: '1.46.0.7',
        serverBuildId: 'd'.repeat(64), clientBuildId: 'e'.repeat(64), bundleBuildId: 'f'.repeat(64) };
    return { kind, build, artifact: { kind, buildIdentitySha256: localBuildIdentitySha256(build),
        archiveName: `nassaj-local-forward-${build.commit}.tar.gz`, archiveSha256: '1'.repeat(64), archiveSize: 123,
        manifestName: 'LOCAL_BUILD_MANIFEST.json', manifestSha256: '2'.repeat(64), manifestSize: 456,
        startupClosureSha256: '3'.repeat(64), databaseContractSha256: '4'.repeat(64) } };
}
async function forwardFixture(t) {
    const root = mkdtempSync(path.join(ROOT, '.artifacts/b951-installer-'));
    t.after(() => { execFileSync('/usr/bin/chmod', ['-R', 'u+w', root]); rmSync(root, { recursive: true, force: true }); });
    const runtime = runtimeIdentity();
    const output = path.join(root, 'output'); mkdirSync(output, { mode: 0o755 }); chmodSync(output, 0o755);
    const built = buildReleaseInstaller({ profile: 'forward', version: runtime.build.version, commit: runtime.build.commit,
        runtime, temporaryRoot: root, outputDirectory: output });
    chmodSync(built.asset, 0o644); chmodSync(built.checksum, 0o644);
    const extracted = path.join(root, 'extracted'); mkdirSync(extracted, { mode: 0o700 });
    execFileSync('/usr/bin/tar', ['-xzf', built.asset, '-C', extracted]);
    const fake = path.join(root, 'host'); mkdirSync(path.join(fake, 'etc/nassaj'), { recursive: true, mode: 0o755 });
    const installed = await import(pathToFileURL(path.join(extracted, 'scripts/install-release-host-support.mjs')).href);
    const calls = [], unit = readFileSync(path.join(extracted, 'ops/nassaj-maintenance.service'), 'utf8');
    const injected = { allowUnprivileged: true, fixtureRoot: root, sourceRoot: extracted, mapTarget: target => path.join(fake, target),
        exec(file, args) { calls.push([file, args]); return file === '/usr/bin/systemctl' && args[0] === 'cat'
            ? `# /etc/systemd/system/nassaj-maintenance.service\n${unit}` : ''; } };
    const request = { schema: 'nassaj-release-host-support-install-request/v1',
        installerArchive: { path: built.asset, size: built.size, sha256: built.assetSha256 },
        flockSha256: sha(readFileSync('/usr/bin/flock')) };
    return { root, output, built, extracted, fake, injected, request, calls, installed,
        install: () => installed.installForwardReleaseHostSupport(request, injected) };
}

test('forward standalone profile preserves native bytes and installs only closed host roots idempotently', async t => {
    const f = await forwardFixture(t);
    const manifest = f.built.manifest;
    assert.equal(manifest.schema, 'nassaj-installer-bundle/v2');
    assert.equal(manifest.profile, 'forward');
    assert.match(f.built.assetName, /^nassaj-installer-forward-v/);
    assert.deepEqual(readFileSync(path.join(f.extracted, 'scripts/lib/update-release-asset.mjs')),
        readFileSync(path.join(ROOT, 'scripts/lib/update-release-asset.mjs')));
    assert.equal(existsSync(path.join(f.extracted, 'node_modules/semver/index.js')), true);
    assert.equal(existsSync(path.join(f.extracted, 'node_modules/typescript')), false);
    assert.equal(existsSync(path.join(f.extracted, 'node_modules/vite')), false);
    const result = f.install(); assert.equal(result.phase, 'support_installed'); assert.equal(result.state, 'installed');
    assert.equal(result.configHandoff.ready, false); assert.deepEqual(result.configHandoff.files, []);
    assert.ok(result.files.some(x => x.relative === 'scripts/lib/release-runtime-state-mutex.mjs'));
    assert.ok(result.files.some(x => x.relative === 'scripts/lib/release-runtime-startup-admission.mjs'));
    assert.ok(!result.files.some(x => x.relative === 'scripts/release-runtime-forward-child.mjs'));
    assert.equal(f.install().state, 'already_installed');
    const loader = path.join(f.root, 'standalone-loader.mjs');
    const allowed = [pathToFileURL(f.extracted + '/').href,
        pathToFileURL(path.join(f.fake, 'usr/local/lib/nassaj-release-operator') + '/').href];
    writeFileSync(loader, `import {registerHooks} from 'node:module';
        const allowed = ${JSON.stringify(allowed)};
        registerHooks({resolve(specifier, context, nextResolve) {
            const resolved = nextResolve(specifier, context);
            if (resolved.url.startsWith('file:') && !allowed.some(root => resolved.url.startsWith(root))) throw Error('standalone dependency escaped bundle');
            return resolved;
        }});`);
    for (const entry of ['bootstrap-release-runtime.mjs', 'generate-first-cutover-config.mjs', 'mint-cutover-approval.mjs']) {
        const imported = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e',
            `await import(${JSON.stringify(pathToFileURL(path.join(f.extracted, 'scripts', entry)).href)})`], {
            encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: f.root } });
        assert.equal(imported.status, 0, `${entry}: ${imported.stderr}`);
    }
    const dispatcher = path.join(f.fake, 'usr/local/lib/nassaj-release-operator/scripts/release-runtime-host-dispatcher.mjs');
    const probe = spawnSync(process.execPath, ['--import', loader, dispatcher, 'not-an-action'], { encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: f.root } });
    assert.notEqual(probe.status, 0);
    assert.doesNotMatch(probe.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module|standalone dependency escaped/);
});

test('forward installer refuses wrong runtime OID before creating outputs', () => {
    const runtime = runtimeIdentity();
    assert.throws(() => buildReleaseInstaller({ profile: 'forward', version: runtime.build.version,
        commit: '9'.repeat(40), runtime, outputDirectory: '/must-not-be-created' }), /release mismatch/);
});

test('forward external archive digest and partial installation fail closed', async t => {
    const f = await forwardFixture(t);
    assert.throws(() => verifyForwardInstallerArchive(readFileSync(f.built.asset), { ...f.request.installerArchive,
        sha256: '0'.repeat(64) }), /archive_digest/);
    const attestation = path.join(f.fake, 'etc/nassaj/release-host-support-attestation.json');
    writeFileSync(attestation, JSON.stringify({ schema: 'nassaj-release-host-support-attestation/v2', profile: 'forward', phase: 'installing' }), { mode: 0o600 });
    assert.throws(f.install, /partial_or_other_installation/);
    assert.equal(f.calls.length, 0);
});

test('forward installed tamper is not overwritten or automatically upgraded', async t => {
    const f = await forwardFixture(t), result = f.install();
    const file = result.files.find(x => x.relative === 'scripts/lib/release-runtime-state-mutex.mjs');
    chmodSync(file.path, 0o644); writeFileSync(file.path, 'tampered'); chmodSync(file.path, 0o444);
    assert.throws(f.install, /installed_digest/);
    assert.equal(readFileSync(file.path, 'utf8'), 'tampered');
});

test('first-install retained OFD stays locked after acquisition helper exits and interrupted install never resumes', async t => {
    const f = await forwardFixture(t);
    const original = f.injected.exec;
    f.injected.exec = (file, args) => {
        if (args[0] === 'daemon-reload') {
            const probe = spawnSync('/usr/bin/flock', ['-n', '-E', '75', path.join(f.fake, 'etc/nassaj/.release-host-support-install.flock'), '/usr/bin/true']);
            assert.equal(probe.status, 75, 'parent must retain the same locked open-file-description');
            throw new Error('fixture interrupted before final attestation');
        }
        return original(file, args);
    };
    assert.throws(f.install, /fixture interrupted/);
    f.injected.exec = original;
    assert.throws(f.install, /partial_or_other_installation/);
    assert.equal(existsSync(path.join(f.fake, 'etc/nassaj/.release-host-support-install.flock')), true);
});

test('forward installer rejects source bytes or executable pin drift before installed writes', async t => {
    const f = await forwardFixture(t);
    f.request.flockSha256 = '0'.repeat(64);
    assert.throws(f.install, /flock_pin/); assert.equal(f.calls.length, 0);
    f.request.flockSha256 = sha(readFileSync('/usr/bin/flock'));
    writeFileSync(path.join(f.extracted, 'scripts/nassaj-maintenance-responder.mjs'), '// tampered');
    assert.throws(f.install, /source_bytes/); assert.equal(f.calls.length, 0);
    assert.equal(existsSync(path.join(f.fake, 'etc/nassaj/release-host-support-attestation.json')), false);
});

function repackHostManifest(f, mutate) {
    const hostFile = path.join(f.extracted, 'HOST_SUPPORT_MANIFEST.json');
    const host = JSON.parse(readFileSync(hostFile)); mutate(host); writeFileSync(hostFile, JSON.stringify(host));
    const bundleFile = path.join(f.extracted, 'INSTALLER_BUNDLE_MANIFEST.json');
    const bundle = JSON.parse(readFileSync(bundleFile));
    const record = bundle.files.find(x => x.path === 'HOST_SUPPORT_MANIFEST.json'), bytes = readFileSync(hostFile);
    record.size = bytes.length; record.sha256 = sha(bytes); writeFileSync(bundleFile, JSON.stringify(bundle));
    const top = [...new Set([...bundle.files.map(x => x.path.split('/')[0]), 'INSTALLER_BUNDLE_MANIFEST.json'])].sort();
    execFileSync('/usr/bin/tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--format=ustar',
        '-czf', f.built.asset, '-C', f.extracted, ...top]);
    const archive = readFileSync(f.built.asset);
    Object.assign(f.request.installerArchive, { size: archive.length, sha256: sha(archive) });
}

for (const kind of ['target-class', 'missing-module', 'missing-unit', 'source-mode']) {
    test(`reviewed forward archive still rejects invalid closed host policy: ${kind}`, async t => {
        const f = await forwardFixture(t);
        repackHostManifest(f, host => {
            if (kind === 'target-class') host.files[0].targetClass = 'arbitrary-root-file';
            if (kind === 'missing-module') host.files = host.files.filter(x => x.path !== 'scripts/lib/release-runtime-state-mutex.mjs');
            if (kind === 'missing-unit') host.files = host.files.filter(x => x.targetClass !== 'maintenance-unit');
            if (kind === 'source-mode') host.files[0].sourceMode = 0o444;
        });
        assert.throws(f.install, /target|host_closure|host_record|host_dependencies/);
        assert.equal(f.calls.length, 0);
        assert.equal(existsSync(path.join(f.fake, 'etc/nassaj/release-host-support-attestation.json')), false);
    });
}

test('forward source inventory refuses an unlisted file before installation intent', async t => {
    const f = await forwardFixture(t);
    writeFileSync(path.join(f.extracted, 'unlisted'), 'extra', { mode: 0o644 });
    assert.throws(f.install, /source_inventory/); assert.equal(f.calls.length, 0);
});

test('forward archive grow-after-stat is read with a fixed bound and final FD metadata before refusal', async t => {
    const f = await forwardFixture(t), original = fs.readSync;
    let intercepted = false, requested = 0;
    fs.readSync = function(fd, buffer, offset, length, position) {
        if (!intercepted && fs.readlinkSync(`/proc/self/fd/${fd}`) === f.built.asset) {
            intercepted = true; requested = buffer.length;
            fs.appendFileSync(f.built.asset, Buffer.alloc(65536));
        }
        return original(fd, buffer, offset, length, position);
    };
    syncBuiltinESMExports();
    try {
        assert.throws(f.install, /file_drift/);
        assert.equal(intercepted, true);
        assert.equal(requested, f.built.size + 1);
        assert.equal(f.calls.length, 0);
    } finally { fs.readSync = original; syncBuiltinESMExports(); }
});

test('fresh fixed namespace and created operator directories normalize umask077 without repairing existing paths', async t => {
    const f = await forwardFixture(t), directory = path.join(f.fake, 'etc/nassaj');
    rmSync(directory, { recursive: true });
    const previous = process.umask(0o077);
    try { assert.equal(f.install().state, 'installed'); }
    finally { process.umask(previous); }
    assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(f.fake, 'usr/local/lib/nassaj-release-operator/scripts')).mode & 0o777, 0o755);
});

for (const kind of ['wrong-mode', 'symlink']) {
    test(`fixed namespace rejects existing ${kind} without repair`, async t => {
        const f = await forwardFixture(t), directory = path.join(f.fake, 'etc/nassaj');
        if (kind === 'wrong-mode') chmodSync(directory, 0o700);
        else { rmSync(directory, { recursive: true }); fs.symlinkSync(f.extracted, directory); }
        assert.throws(f.install, /namespace|ELOOP|ENOTDIR/);
        assert.equal(f.calls.length, 0);
        if (kind === 'wrong-mode') assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
        else assert.equal(fs.lstatSync(directory).isSymbolicLink(), true);
    });
}

test('fixed namespace rejects parent inode replacement before permanent lock', async t => {
    const f = await forwardFixture(t), directory = path.join(f.fake, 'etc/nassaj');
    rmSync(directory, { recursive: true });
    const original = fs.mkdirSync; let changed = false;
    fs.mkdirSync = function(file, options) {
        if (!changed && /^\/proc\/self\/fd\/\d+\/nassaj$/.test(file)) {
            changed = true; fs.renameSync(path.join(f.fake, 'etc'), path.join(f.fake, 'etc-before'));
            original(path.join(f.fake, 'etc'), { mode: 0o755 });
        }
        return original(file, options);
    };
    syncBuiltinESMExports();
    try { assert.throws(f.install, /namespace|ENOENT/); assert.equal(changed, true); assert.equal(f.calls.length, 0); }
    finally { fs.mkdirSync = original; syncBuiltinESMExports(); }
});

test('fixed namespace fsync failure leaves no installation authority or support files', async t => {
    const f = await forwardFixture(t), directory = path.join(f.fake, 'etc/nassaj');
    rmSync(directory, { recursive: true });
    const original = fs.fsyncSync;
    fs.fsyncSync = function(fd) {
        if (fs.readlinkSync(`/proc/self/fd/${fd}`) === directory) throw new Error('fixture namespace fsync failure');
        return original(fd);
    };
    syncBuiltinESMExports();
    try { assert.throws(f.install, /namespace fsync failure/); assert.equal(f.calls.length, 0); }
    finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
    assert.equal(existsSync(path.join(directory, 'release-host-support-attestation.json')), false);
    assert.equal(existsSync(path.join(directory, '.release-host-support-install.flock')), false);
});

test('a concurrent fixed namespace creator is revalidated through EEXIST without repair', async t => {
    const f = await forwardFixture(t), directory = path.join(f.fake, 'etc/nassaj');
    rmSync(directory, { recursive: true });
    const original = fs.mkdirSync; let concurrent = false;
    fs.mkdirSync = function(file, options) {
        if (!concurrent && /^\/proc\/self\/fd\/\d+\/nassaj$/.test(file)) {
            concurrent = true;
            execFileSync(process.execPath, ['-e', 'require("node:fs").mkdirSync(process.argv[1],{mode:0o755})', directory],
                { env: { PATH: '/usr/bin:/bin', HOME: f.root } });
        }
        return original(file, options);
    };
    syncBuiltinESMExports();
    try { assert.equal(f.install().state, 'installed'); assert.equal(concurrent, true); }
    finally { fs.mkdirSync = original; syncBuiltinESMExports(); }
});

test('existing operator ancestor without public traversal is rejected without chmod repair', async t => {
    const f = await forwardFixture(t);
    mkdirSync(path.join(f.fake, 'usr/local/lib'), { recursive: true, mode: 0o755 });
    chmodSync(path.join(f.fake, 'usr/local/lib'), 0o700);
    assert.throws(f.install, /target_parent_unsafe/);
    assert.equal(fs.statSync(path.join(f.fake, 'usr/local/lib')).mode & 0o777, 0o700);
    assert.equal(f.calls.length, 0);
});

test('forward archive fixtures preserve public output modes with a group-permissive umask', t => {
    const root = mkdtempSync(path.join(ROOT, '.artifacts/b951-umask-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const output = path.join(root, 'output'); mkdirSync(output, { mode: 0o755 }); chmodSync(output, 0o755);
    const runtime = runtimeIdentity(), before = process.umask(0o002);
    let built;
    try { built = buildReleaseInstaller({ profile: 'forward', version: runtime.build.version, commit: runtime.build.commit,
        runtime, temporaryRoot: root, outputDirectory: output }); }
    finally { process.umask(before); }
    chmodSync(built.asset, 0o644); chmodSync(built.checksum, 0o644);
    assert.equal(fs.statSync(output).mode & 0o777, 0o755);
    assert.equal(fs.statSync(built.asset).mode & 0o777, 0o644);
    assert.equal(fs.statSync(built.checksum).mode & 0o777, 0o644);
    assert.doesNotThrow(() => verifyForwardInstallerArchive(readFileSync(built.asset), { size: built.size, sha256: built.assetSha256 }));
});

test('dangling attestation is tampering rather than absence and is never replaced', async t => {
    const f = await forwardFixture(t), target = path.join(f.fake, 'etc/nassaj/release-host-support-attestation.json');
    fs.symlinkSync('missing-attestation', target);
    assert.throws(f.install, /file_unsafe/);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
    assert.equal(f.calls.length, 0);
    assert.equal(existsSync(path.join(f.fake, 'usr/local/lib/nassaj-release-operator')), false);
});

test('atomic forward intent write refuses a dangling target introduced before rename', async t => {
    const f = await forwardFixture(t), target = path.join(f.fake, 'etc/nassaj/release-host-support-attestation.json');
    const original = fs.writeFileSync; let injected = false;
    fs.writeFileSync = function(file, ...args) {
        const value = original(file, ...args);
        if (!injected && typeof file === 'string' && file.startsWith(target + '.partial-')) {
            injected = true; fs.symlinkSync('missing-attestation', target);
        }
        return value;
    };
    syncBuiltinESMExports();
    try { assert.throws(f.install, /destination_unsafe/); assert.equal(injected, true); }
    finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
    assert.equal(fs.lstatSync(target).isSymbolicLink(), true); assert.equal(f.calls.length, 0);
    assert.equal(existsSync(path.join(f.fake, 'usr/local/lib/nassaj-release-operator')), false);
});

test('installed-file grow-after-stat is bounded and rejected before reattestation effects', async t => {
    const f = await forwardFixture(t), installed = f.install();
    const target = installed.files.find(x => x.relative === 'scripts/lib/release-runtime-state-mutex.mjs');
    const previousCalls = f.calls.length, original = fs.readSync; let reached = false, capacity = 0;
    fs.readSync = function(fd, buffer, offset, length, position) {
        if (!reached && fs.readlinkSync(`/proc/self/fd/${fd}`) === target.path) {
            reached = true; capacity = buffer.length;
            chmodSync(target.path, 0o644); fs.appendFileSync(target.path, Buffer.alloc(65536)); chmodSync(target.path, 0o444);
        }
        return original(fd, buffer, offset, length, position);
    };
    syncBuiltinESMExports();
    try { assert.throws(f.install, /file_drift/); }
    finally { fs.readSync = original; syncBuiltinESMExports(); }
    assert.equal(reached, true); assert.equal(capacity, target.size + 1); assert.equal(f.calls.length, previousCalls);
});

test('flock executes the bounded measured retained FD without an unbounded second FD read', async t => {
    const f = await forwardFixture(t), original = fs.readFileSync; let forbidden = 0;
    fs.readFileSync = function(file, ...args) {
        if (typeof file === 'number' && fs.readlinkSync(`/proc/self/fd/${file}`) === '/usr/bin/flock') {
            forbidden++; throw new Error('unbounded flock FD read');
        }
        return original(file, ...args);
    };
    syncBuiltinESMExports();
    try { assert.equal(f.install().state, 'installed'); }
    finally { fs.readFileSync = original; syncBuiltinESMExports(); }
    assert.equal(forbidden, 0);
});

test('source change between matched inventory and expected bytes leaves no installation intent or target', async t => {
    const f = await forwardFixture(t), source = path.join(f.extracted, 'scripts/lib/release-runtime-state-mutex.mjs');
    const original = fs.readFileSync; let changed = false;
    fs.readFileSync = function(file, ...args) {
        const bytes = original(file, ...args);
        if (!changed && file === source) {
            changed = true; writeFileSync(source, '// unreviewed bytes after inventory');
        }
        return bytes;
    };
    syncBuiltinESMExports();
    try { assert.throws(f.install, /source_changed_after_measurement/); }
    finally { fs.readFileSync = original; syncBuiltinESMExports(); }
    assert.equal(changed, true); assert.equal(f.calls.length, 0);
    assert.equal(existsSync(path.join(f.fake, 'etc/nassaj/release-host-support-attestation.json')), false);
    assert.equal(existsSync(path.join(f.fake, 'usr/local/lib/nassaj-release-operator')), false);
});

test('legacy support installation must not overwrite a recognized forward installation', async t => {
    const f = await forwardFixture(t), forward = f.install();
    assert.equal(forward.schema, 'nassaj-release-host-support-attestation/v2');
    const attestation = path.join(f.fake, 'etc/nassaj/release-host-support-attestation.json');
    assert.throws(() => installReleaseHostSupport({ sourceRoot: ROOT, attestationFile: attestation }, f.injected),
        /forward_installation/);
    assert.equal(JSON.parse(readFileSync(attestation)).schema, 'nassaj-release-host-support-attestation/v2');
});

test('forward bundle explicitly refuses the legacy noargs entry before writing even on a fresh host', async t => {
    const f = await forwardFixture(t);
    assert.throws(() => f.installed.installReleaseHostSupport({ sourceRoot: ROOT }, f.injected), /forward_installation/);
    assert.equal(f.calls.length, 0);
    assert.equal(existsSync(path.join(f.fake, 'etc/nassaj/.release-host-support-install.flock')), false);
});

test('legacy refuses preexisting lock-only unknown state without claiming it as forward success', async t => {
    const f = await forwardFixture(t), file = path.join(f.fake, 'etc/nassaj/.release-host-support-install.flock');
    writeFileSync(file, '', { mode: 0o600 });
    assert.throws(() => installReleaseHostSupport({ sourceRoot: ROOT,
        attestationFile: path.join(f.fake, 'etc/nassaj/release-host-support-attestation.json') }, f.injected), /forward_installation_or_unknown/);
    assert.equal(f.calls.length, 0);
});

test('forward refuses preexisting lock-only unknown state before any installation intent', async t => {
    const f = await forwardFixture(t), file = path.join(f.fake, 'etc/nassaj/.release-host-support-install.flock');
    writeFileSync(file, '', { mode: 0o600 });
    assert.throws(() => f.install(), /lock_only_unknown/);
    assert.equal(f.calls.length, 0);
    assert.equal(existsSync(path.join(f.fake, 'etc/nassaj/release-host-support-attestation.json')), false);
    assert.equal(existsSync(path.join(f.fake, 'usr/local/lib/nassaj-release-operator')), false);
});

for (const failingTarget of ['lock', 'directory']) {
    test(`permanent lock ${failingTarget} fsync failure prevents installation authority and targets`, async t => {
        const f = await forwardFixture(t), directory = path.join(f.fake, 'etc/nassaj');
        const file = path.join(directory, '.release-host-support-install.flock');
        const original = fs.fsyncSync; let reached = false;
        fs.fsyncSync = function(fd) {
            if (fs.readlinkSync(`/proc/self/fd/${fd}`) === (failingTarget === 'lock' ? file : directory)) {
                reached = true; throw new Error('fixture permanent lock fsync failure');
            }
            return original(fd);
        };
        syncBuiltinESMExports();
        try { assert.throws(f.install, /permanent lock fsync failure/); }
        finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
        assert.equal(reached, true); assert.equal(f.calls.length, 0);
        assert.equal(existsSync(path.join(directory, 'release-host-support-attestation.json')), false);
        assert.equal(existsSync(path.join(f.fake, 'usr/local/lib/nassaj-release-operator')), false);
        assert.equal(existsSync(file), true);
        assert.throws(f.install, /lock_only_unknown/);
    });
}

for (const first of ['legacy', 'forward']) {
    test(`actual ${first}-first concurrent installers serialize then reject the incompatible second path`, async t => {
        const f = await forwardFixture(t), childFile = path.join(f.root, 'competing-installer.mjs');
        const parameters = { root: f.root, source: ROOT, fake: f.fake, extracted: f.extracted, request: f.request, first };
        writeFileSync(childFile, String.raw`import fs from 'node:fs'; import path from 'node:path'; import {spawnSync} from 'node:child_process';
            import {pathToFileURL} from 'node:url'; const p=${JSON.stringify(parameters)};
            const api=await import(pathToFileURL(path.join(p.first==='legacy'?p.source:p.extracted,'scripts/install-release-host-support.mjs')));
            const unit=fs.readFileSync(path.join(p.extracted,'ops/nassaj-maintenance.service'),'utf8');
            const injected={allowUnprivileged:true,fixtureRoot:p.root,sourceRoot:p.extracted,mapTarget:x=>path.join(p.fake,x),
                exec(file,args){if(args[0]==='daemon-reload'){fs.writeSync(1,'held\n');spawnSync('/usr/bin/sleep',['0.4']);}
                return args[0]==='cat'?'# /etc/systemd/system/nassaj-maintenance.service\n'+unit:'';}};
            if(p.first==='legacy')api.installReleaseHostSupport({sourceRoot:p.source,attestationFile:path.join(p.fake,'etc/nassaj/release-host-support-attestation.json')},injected);
            else api.installForwardReleaseHostSupport(p.request,injected);`);
        const child = spawn(process.execPath, [childFile], { stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: '/usr/bin:/bin', HOME: f.root } });
        let stderr = ''; child.stderr.on('data', b => { stderr += b; });
        const closed = new Promise(resolve => child.on('close', resolve));
        t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('race fixture did not acquire lock')), 10000);
            child.stdout.once('data', b => { clearTimeout(timer); assert.match(String(b), /held/); resolve(); });
            child.once('exit', code => { clearTimeout(timer); if (code) reject(new Error(stderr)); });
        });
        const held = spawnSync('/usr/bin/flock', ['-n', '-E', '75', path.join(f.fake,'etc/nassaj/.release-host-support-install.flock'), '/usr/bin/true']);
        assert.equal(held.status, 75);
        if (first === 'legacy') assert.throws(f.install, /partial_or_other_installation/);
        else assert.throws(() => installReleaseHostSupport({sourceRoot: ROOT,
            attestationFile:path.join(f.fake,'etc/nassaj/release-host-support-attestation.json')}, f.injected), /forward_installation/);
        assert.equal(await closed, 0, stderr);
        const record = JSON.parse(readFileSync(path.join(f.fake, 'etc/nassaj/release-host-support-attestation.json')));
        assert.equal(record.schema, first === 'legacy' ? 'nassaj-release-host-support-attestation/v1' : 'nassaj-release-host-support-attestation/v2');
    });
}
