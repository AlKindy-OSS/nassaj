import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { attestPreparedMaintenance } from './lib/release-runtime-host-operations.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const project = path.resolve(import.meta.dirname, '..');
test('B943 attestation accepts actual unpadded kernel startTime with real executable pin', t => {
    const root = fs.mkdtempSync(path.join(project, '.artifacts', 'maintenance-start-ticks-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    const startTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ')[19];
    const unit = 'fixture-cloudflared.service';
    const executable = fs.realpathSync('/proc/self/exe');
    const configFile = path.join(root, 'ingress.yml');
    fs.writeFileSync(configFile, 'service: http://127.0.0.1:3100\n', { mode: 0o600 });
    const config = { maintenance: { nonce: 'nassaj-maintenance-v1', retryAfterSeconds: 30,
        responderUnit: 'nassaj-maintenance.service', responderPort: 3311,
        cloudflared: { pid: process.pid, uid: process.getuid(), startTime, executable,
            executableSha256: sha(fs.readFileSync(executable)), configFile, configSha256: sha(fs.readFileSync(configFile)),
            unit, originHost: '127.0.0.1', originPort: 3100 },
        nft: { binary: '/usr/sbin/nft', sha256: 'a'.repeat(64) },
        conntrack: { binary: '/usr/sbin/conntrack', sha256: 'b'.repeat(64) } } };
    // Unit-file and cgroup provenance are outside this field regression. Process
    // identity, credentials, executable pin and config bytes use the real readers.
    let units = 0;
    const deps = {
        systemdUnitAttestation: observed => { units++; return { unit: observed, fixture: true }; },
        // The agent may run in a session scope rather than a service. Keep only the
        // cgroup/unit boundary injected while exercising the real PID, start ticks,
        // credentials and executable identity readers.
        readIngressProc: file => file.endsWith('/cgroup') ? `0::/system.slice/${unit}\n` : fs.readFileSync(file, 'utf8'),
    };
    const actual = attestPreparedMaintenance(config, deps);
    assert.equal(actual.pid, process.pid); assert.equal(actual.startTime, startTime); assert.equal(units, 2);
    const cloudflared = config.maintenance.cloudflared;
    for (const invalid of ['', 123456, null, undefined, {}, [], '1234567a', 'start_123', '-1', '+1',
        '1.0', '1e6', ' 123456', '123456 ', '01', '00', '0'.repeat(8), '1'.repeat(25)]) {
        cloudflared.startTime = invalid;
        assert.throws(() => attestPreparedMaintenance(config, deps), /host_ingress_cloudflared_contract_invalid/);
    }
    // Canonical field boundaries reach exact kernel comparison, never a fabricated identity.
    for (const valid of ['0', '1', '123456', '9'.repeat(24)]) {
        if (valid === startTime) continue;
        cloudflared.startTime = valid;
        assert.throws(() => attestPreparedMaintenance(config, deps), /host_cloudflared_identity_mismatch/);
    }
    cloudflared.startTime = startTime;
    for (const pid of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
        cloudflared.pid = pid;
        assert.throws(() => attestPreparedMaintenance(config, deps), /host_ingress_cloudflared_contract_invalid/);
    }
    assert.equal(units, 2);
    fs.writeFileSync(path.join(project, '.artifacts', 'maintenance-start-ticks.log'), JSON.stringify({
        actualStartTime: startTime, digits: startTime.length, unpadded: true, actualIdentityReader: true,
        actualExecutablePin: true, noCommandsOrChildProcesses: true,
        limit: 'unit-file attestation seam only; not production ingress or complete producer bridge'
    }) + '\n');
});
