import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { buildReleaseInstaller } from './build-release-installer.mjs';
import { installReleaseHostSupport } from './install-release-host-support.mjs';

const TEMP = process.env.NASSAJ_TEST_TMP || process.env.TMPDIR || '/var/tmp';
const sourceRoot = path.resolve(new URL('..', import.meta.url).pathname);
const OPERATOR_ROOT_TEST = '/usr/local/lib/nassaj-release-operator';
function sealFixtureDirectories(directory) {
    chmodSync(directory, 0o755);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) sealFixtureDirectories(path.join(directory, entry.name));
    }
}
function fixture(t) {
    const root = mkdtempSync(path.join(TEMP, 'nassaj-host-support-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, 'etc/nassaj'), { recursive: true, mode: 0o755 });
    let effective = `# /etc/systemd/system/nassaj-maintenance.service\n${readFileSync(
        path.join(sourceRoot, 'ops/nassaj-maintenance.service'), 'utf8')}`;
    const calls = [];
    const injected = { allowUnprivileged: true, fixtureRoot: root, mapTarget: (target) => path.join(root, target),
        exec(file, args) { calls.push([file, args]); return file.endsWith('systemctl') && args[0] === 'cat' ? effective : ''; } };
    return { root, calls, injected, setEffective: (value) => { effective = value; },
        attestationFile: path.join(root, 'etc/nassaj/release-host-support-attestation.json') };
}

test('root support installer is idempotent and attests every byte and effective unit', (t) => {
    const value = fixture(t); const options = { sourceRoot, attestationFile: value.attestationFile };
    const installed = installReleaseHostSupport(options, value.injected);
    assert.equal(installed.state, 'installed'); assert.equal(installed.files.length, 16);
    assert.equal(installed.configHandoff.ready, false);
    assert.match(installed.effectiveUnitSha256, /^[a-f0-9]{64}$/);
    assert.ok(value.calls.some(([file, args]) => file === '/usr/bin/systemd-analyze' && args[0] === 'verify'));
    assert.ok(value.calls.some(([file, args]) => file === '/usr/bin/systemctl' && args[0] === 'daemon-reload'));
    const repeated = installReleaseHostSupport(options, value.injected);
    assert.equal(repeated.state, 'already_installed');
    const record = JSON.parse(readFileSync(value.attestationFile, 'utf8'));
    assert.equal(record.effectiveUnitSha256, installed.effectiveUnitSha256);
});

test('same-generation reinstall fails closed on file or effective-unit tampering', (t) => {
    const value = fixture(t); const options = { sourceRoot, attestationFile: value.attestationFile };
    const installed = installReleaseHostSupport(options, value.injected);
    chmodSync(installed.files[0].path, 0o755);
    writeFileSync(installed.files[0].path, 'tampered', { mode: installed.files[0].mode });
    chmodSync(installed.files[0].path, installed.files[0].mode);
    assert.throws(() => installReleaseHostSupport(options, value.injected), /digest_mismatch/);
    chmodSync(installed.files[0].path, 0o755);
    writeFileSync(installed.files[0].path, readFileSync(path.join(sourceRoot, 'scripts/nassaj-maintenance-responder.mjs')),
        { mode: installed.files[0].mode });
    chmodSync(installed.files[0].path, installed.files[0].mode);
    value.setEffective(`${readFileSync(path.join(sourceRoot, 'ops/nassaj-maintenance.service'), 'utf8')}\n# injected drop-in\n`);
    assert.throws(() => installReleaseHostSupport(options, value.injected), /effective_unit_invalid/);
});

test('fixed config handoff pins the installed dispatcher and then fails closed on drift', (t) => {
    const value = fixture(t); const options = { sourceRoot, attestationFile: value.attestationFile };
    const installed = installReleaseHostSupport(options, value.injected);
    const dispatcher = installed.files.find((file) => file.path.endsWith('/scripts/release-runtime-host-dispatcher.mjs'));
    const hostConfig = path.join(value.root, 'etc/nassaj/release-runtime-host.json');
    const cutoverConfig = path.join(value.root, 'etc/nassaj/release-runtime-first-cutover.json');
    writeFileSync(hostConfig, `${JSON.stringify({ schema: 'nassaj-release-runtime-host-config/v1' })}\n`, { mode: 0o600 });
    writeFileSync(cutoverConfig, `${JSON.stringify({ schema: 'nassaj-release-runtime-first-cutover-config/v1',
        dispatcher: dispatcher.path, dispatcherSha256: dispatcher.sha256 })}\n`, { mode: 0o600 });
    const attested = installReleaseHostSupport(options, value.injected);
    assert.equal(attested.state, 'config_attested'); assert.equal(attested.configHandoff.ready, true);
    writeFileSync(hostConfig, `${JSON.stringify({ schema: 'nassaj-release-runtime-host-config/v1', drift: true })}\n`, { mode: 0o600 });
    assert.throws(() => installReleaseHostSupport(options, value.injected), /config_handoff_tampered/);
});

test('maintenance systemd unit passes systemd-analyze and carries recovery ordering/hardening', () => {
    const unitFile = path.join(sourceRoot, 'ops/nassaj-maintenance.service');
    const unit = readFileSync(unitFile, 'utf8');
    assert.match(unit, /^Before=nassaj-cutover-gate-restore\.service$/m);
    for (const hardening of ['NoNewPrivileges=yes', 'ProtectSystem=strict', 'RestrictAddressFamilies=AF_INET',
        'IPAddressDeny=any', 'CapabilityBoundingSet=']) assert.match(unit, new RegExp(`^${hardening}$`, 'm'));
    execFileSync('/usr/bin/systemd-analyze', ['verify', unitFile], { stdio: 'pipe' });
});

test('reboot ordering restores the offline gate before cloudflared and resumes only afterward', () => {
    const gate = readFileSync(path.join(sourceRoot, 'ops/nassaj-cutover-gate-restore.service'), 'utf8');
    const recovery = readFileSync(path.join(sourceRoot, 'ops/nassaj-first-cutover-recovery.service'), 'utf8');
    const cloudflared = readFileSync(path.join(sourceRoot,
        'ops/systemd/cloudflared.service.d/20-nassaj-maintenance-order.conf'), 'utf8');
    const pm2 = readFileSync(path.join(sourceRoot,
        'ops/systemd/pm2-nassaj.service.d/20-nassaj-maintenance-order.conf'), 'utf8');
    assert.match(gate, /^Before=cloudflared\.service$/m);
    assert.match(gate, /^Requires=nassaj-maintenance\.service$/m);
    assert.match(cloudflared, /^Requires=nassaj-cutover-gate-restore\.service$/m);
    assert.doesNotMatch(cloudflared, /first-cutover-recovery/);
    assert.match(recovery, /^After=.*gate-restore\.service cloudflared\.service$/m);
    assert.match(recovery, /^Before=pm2-nassaj\.service pm2-nassaj-dev\.service$/m);
    assert.match(pm2, /^Requires=nassaj-first-cutover-recovery\.service$/m);
    execFileSync('/usr/bin/systemd-analyze', ['verify',
        path.join(sourceRoot, 'ops/nassaj-maintenance.service'),
        path.join(sourceRoot, 'ops/nassaj-cutover-gate-restore.service'),
        path.join(sourceRoot, 'ops/nassaj-first-cutover-recovery.service')], { stdio: 'pipe' });
});

test('extracted no-git bundle installs the full operator closure and every ExecStart target', async (t) => {
    const root = mkdtempSync(path.join(TEMP, 'nassaj-host-support-bundle-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const output = path.join(root, 'output'); const extracted = path.join(root, 'extracted'); const fake = path.join(root, 'fake-root');
    mkdirSync(extracted, { recursive: true, mode: 0o755 });
    mkdirSync(path.join(fake, 'etc/nassaj'), { recursive: true, mode: 0o755 });
    const built = buildReleaseInstaller({ version: '1.46.0.0', commit: 'a'.repeat(40), outputDirectory: output,
        temporaryRoot: root });
    execFileSync('/usr/bin/tar', ['-xzf', built.asset, '-C', extracted]);
    // The bundled entry verifies its own source ancestors.  Make the fixture's
    // extraction root explicit rather than inheriting a group-writable umask.
    sealFixtureDirectories(extracted);
    const bundled = await import(`${pathToFileURL(path.join(extracted, 'scripts/install-release-host-support.mjs')).href}?bundle=${Date.now()}`);
    const unitSource = readFileSync(path.join(extracted, 'ops/nassaj-maintenance.service'), 'utf8');
    const mapTarget = (target) => path.join(fake, target);
    const installed = bundled.installReleaseHostSupport({ sourceRoot: extracted,
        attestationFile: path.join(fake, 'etc/nassaj/release-host-support-attestation.json') }, {
        allowUnprivileged: true, fixtureRoot: root, mapTarget,
        exec(file, args) { return file === '/usr/bin/systemctl' && args[0] === 'cat'
            ? `# /etc/systemd/system/nassaj-maintenance.service\n${unitSource}` : ''; },
    });
    assert.equal(installed.files.length, 16);
    for (const unit of ['nassaj-maintenance.service', 'nassaj-cutover-gate-restore.service',
        'nassaj-first-cutover-recovery.service']) {
        const installedUnit = mapTarget(`/etc/systemd/system/${unit}`);
        const contents = unit === 'nassaj-maintenance.service' ? readFileSync(installedUnit, 'utf8')
            : readFileSync(path.join(extracted, 'ops', unit), 'utf8');
        for (const match of contents.matchAll(/^ExecStart=(\/[^\s]+)(?:\s+(\/[^\s]+))?/gm)) {
            const target = match[2] || match[1];
            if (target.startsWith('/usr/local/lib/nassaj-release-operator/')) {
                assert.doesNotThrow(() => readFileSync(mapTarget(target)), `${unit}: ${target}`);
            }
        }
    }
    const dispatcher = installed.files.find((file) => file.path.endsWith('/scripts/release-runtime-host-dispatcher.mjs'));
    assert.ok(dispatcher); assert.match(dispatcher.sha256, /^[a-f0-9]{64}$/);
    assert.doesNotThrow(() => readFileSync(mapTarget(`${OPERATOR_ROOT_TEST}/package.json`)));
    const recoveryRun = spawnSync(process.execPath,
        [mapTarget(`${OPERATOR_ROOT_TEST}/scripts/release-runtime-cutover-recovery.mjs`)], { encoding: 'utf8' });
    assert.equal(recoveryRun.status, 78); assert.match(recoveryRun.stderr, /cutover recovery blocked/);
    assert.doesNotMatch(recoveryRun.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/);
});
