import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { attestRecoveryBootUnits, installReleaseRuntimeRecovery } from './lib/release-runtime-recovery-installer.mjs';

const TEMP = process.env.NASSAJ_TEST_TMP || process.env.TMPDIR || '/var/tmp';
const H = 'a'.repeat(64);

test('generated boot recovery graph restores the gate before ingress and resumes before PM2', (t) => {
    const root = mkdtempSync(path.join(TEMP, 'recovery-graph-')); t.after(() => rmSync(root, { recursive: true, force: true }));
    const verified = [];
    const config = { systemd: { pm2Unit: 'pm2-node.service', ingressUnits: ['cloudflared-node.service'],
        recoveryReadWritePaths: ['/srv/nassaj/control', '/srv/nassaj/pm2'],
        unitSha256: { 'pm2-node.service': H, 'cloudflared-node.service': H } } };
    const result = installReleaseRuntimeRecovery(config, { systemdRoot: root, attestUnits: () => [{ unit: 'pinned' }],
        verify: (files) => verified.push(...files), skipDaemonReload: true });
    const gate = readFileSync(result.gateRestore, 'utf8'); const recovery = readFileSync(result.recovery, 'utf8');
    assert.match(gate, /^Before=cloudflared-node\.service$/m);
    assert.match(gate, /release-runtime-gate-restore\.mjs/);
    assert.match(recovery, /^After=.*nassaj-cutover-gate-restore\.service cloudflared-node\.service$/m);
    assert.match(recovery, /^Before=pm2-node\.service$/m);
    assert.doesNotMatch(recovery, /^Before=.*cloudflared/m);
    assert.match(readFileSync(result.dropIns.find((file) => file.includes('cloudflared-node')), 'utf8'),
        /Requires=nassaj-cutover-gate-restore\.service/);
    assert.match(readFileSync(result.dropIns.find((file) => file.includes('pm2-node')), 'utf8'),
        /Requires=nassaj-first-cutover-recovery\.service/);
    assert.deepEqual(verified, [result.gateRestore, result.recovery, ...result.dropIns]);
});

const ROOT_OWNED_FRAGMENT = '/etc/hostname';
const fragmentSha = () => createHash('sha256').update(readFileSync(ROOT_OWNED_FRAGMENT)).digest('hex');
function systemctlStub(states, options = {}) {
    return (file, argv) => {
        assert.equal(file, '/usr/bin/systemctl');
        if (argv[0] === '--user') {
            if (options.userProbeFails) throw new Error('systemctl --user unavailable');
            return `ActiveState=${states[argv[2]]?.user || 'inactive'}\n`;
        }
        const unit = argv[1]; const state = states[unit] || {};
        return `FragmentPath=${state.fragment ?? ROOT_OWNED_FRAGMENT}\nLoadState=${state.load || 'loaded'}\n`
            + `ActiveState=${state.active || 'active'}\nSubState=${state.sub || 'running'}\n`;
    };
}
function bootConfig() {
    const digest = fragmentSha();
    return { systemd: { pm2Unit: 'pm2-node.service', ingressUnits: ['cloudflared-node.service'],
        recoveryReadWritePaths: ['/srv/nassaj/control'],
        unitSha256: { 'pm2-node.service': digest, 'cloudflared-node.service': digest } } };
}

test('attestation accepts ingress units the system manager actually runs', () => {
    const evidence = attestRecoveryBootUnits(bootConfig(), { exec: systemctlStub({}) });
    assert.deepEqual(evidence.map((item) => item.unit), ['pm2-node.service', 'cloudflared-node.service']);
    assert.equal(evidence[1].fragment, ROOT_OWNED_FRAGMENT);
    assert.equal(evidence[1].activeState, 'active');
});

test('attestation refuses an inactive system ingress unit shadowed by a live user unit', () => {
    const stub = systemctlStub({ 'cloudflared-node.service': { active: 'inactive', sub: 'dead', user: 'active' } });
    assert.throws(() => attestRecoveryBootUnits(bootConfig(), { exec: stub }), (error) => {
        assert.equal(error.message, 'recovery_ingress_unit_not_system_managed');
        assert.match(error.detail, /systemd --user/);
        return true;
    });
});

test('attestation fails closed when the user manager cannot be probed', () => {
    const stub = systemctlStub({ 'cloudflared-node.service': { active: 'inactive', sub: 'dead' } }, { userProbeFails: true });
    assert.throws(() => attestRecoveryBootUnits(bootConfig(), { exec: stub }),
        /recovery_ingress_user_manager_probe_unavailable/);
});
