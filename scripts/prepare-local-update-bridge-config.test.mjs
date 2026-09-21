import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareBridgeConfig, checkBridgeConfig, applyBridgeConfig, restoreBridgeConfig } from './prepare-local-update-bridge-config.mjs';

function fixture(t, text = 'EXAMPLE_SECRET=private-value\n') {
    const root = fs.mkdtempSync(path.join(process.env.NASSAJ_TEST_TEMP_ROOT || '/var/tmp', 'bridge-config-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, '.env'), text, { mode: 0o600 });
    const input = { schema: 'nassaj-local-bridge-config-request/v1', id: 'bridge-1', nodeIdentity: 'lab',
        approvalReference: 'test-owner-reference', reservationReference: 'test-reservation', sourceOid: 'a'.repeat(40),
        actionId: 'action-1', expectedServerBuildId: 'b'.repeat(64) };
    for (const key of ['oldLoadedBuildId', 'oldCapsuleSha256', 'oldSafeRestartSha256', 'serverBuildId',
        'clientBuildId', 'controlManifestSha256', 'rehearsalReportSha256']) input[key] = 'b'.repeat(64);
    return { root, input, text, env: path.join(root, '.env'), work: path.join(root, '.nassaj-local-preview/bridge-config/bridge-1') };
}
function observation(report, value, operation = 'apply') {
    return { schema: 'nassaj-local-bridge-config-observation/v1', root: value.root, id: value.input.id,
        bindingSha256: report.bindingSha256, observedAt: Date.now(), reservationReference: value.input.reservationReference,
        configWritersReserved: true, publishersQuiescent: true, noCompetingActivation: true,
        ...(operation === 'apply' ? { oldEffectiveModeAbsent: true, pm2SavedModeAbsent: true } : { noPendingRuntimeStart: true }) };
}

test('preparation preserves live bytes; apply/restore exchange exact identities and emit no secrets', t => {
    const v = fixture(t), old = fs.statSync(v.env), prepared = prepareBridgeConfig(v.root, v.input);
    assert.equal(fs.readFileSync(v.env, 'utf8'), v.text);
    assert.equal(fs.statSync(path.join(v.work, 'original.env')).mode & 0o777, 0o600);
    const applied = applyBridgeConfig(v.root, v.input.id, observation(prepared, v));
    assert.equal(applied.physicalState, 'configured');
    assert.equal(fs.readFileSync(v.env, 'utf8'), v.text + 'NASSAJ_UPDATE_MODE=local-main\n');
    assert.doesNotMatch(JSON.stringify(applied), /private-value|EXAMPLE_SECRET/);
    assert.equal(applyBridgeConfig(v.root, v.input.id, observation(prepared, v)).state, 'configured');
    assert.equal(restoreBridgeConfig(v.root, v.input.id, observation(prepared, v, 'restore')).state, 'restored');
    assert.equal(fs.readFileSync(v.env, 'utf8'), v.text); assert.equal(fs.statSync(v.env).ino, old.ino);
});

for (const mode of ['NASSAJ_UPDATE_MODE=release', 'export NASSAJ_UPDATE_MODE = local-main', 'NASSAJ_UPDATE_MODE', 'NASSAJ_UPDATE_MODE=release\nNASSAJ_UPDATE_MODE=local-main']) {
    test(`existing or malformed MODE is refused: ${mode.split('\n')[0]}`, t => {
        const v = fixture(t, mode + '\n'); assert.throws(() => prepareBridgeConfig(v.root, v.input), /mode_already_present/);
        assert.equal(fs.readFileSync(v.env, 'utf8'), v.text);
    });
}
for (const kind of ['symlink', 'hardlink']) {
    test(`unsafe ${kind} cannot become the config target`, t => {
        const v = fixture(t), original = path.join(v.root, 'original'); fs.renameSync(v.env, original);
        if (kind === 'symlink') fs.symlinkSync(original, v.env); else fs.linkSync(original, v.env);
        assert.throws(() => prepareBridgeConfig(v.root, v.input));
        assert.equal(fs.readFileSync(original, 'utf8'), v.text);
    });
}

test('config drift before apply and after apply preserves the competing writer bytes', t => {
    const v = fixture(t), report = prepareBridgeConfig(v.root, v.input), before = 'OTHER_WRITER=before\n';
    fs.writeFileSync(v.env, before);
    assert.throws(() => applyBridgeConfig(v.root, v.input.id, observation(report, v)), /manual_recovery_conflict/);
    assert.equal(fs.readFileSync(v.env, 'utf8'), before);
    fs.writeFileSync(v.env, v.text); applyBridgeConfig(v.root, v.input.id, observation(report, v));
    fs.writeFileSync(v.env, 'OTHER_WRITER=after\n');
    assert.throws(() => restoreBridgeConfig(v.root, v.input.id, observation(report, v, 'restore')), /manual_recovery_conflict/);
    assert.equal(fs.readFileSync(v.env, 'utf8'), 'OTHER_WRITER=after\n');
});

for (const direction of ['apply', 'restore']) {
    test(`lost ${direction} completion receipt reconciles from both pinned inodes`, t => {
        const v = fixture(t), report = prepareBridgeConfig(v.root, v.input);
        if (direction === 'restore') applyBridgeConfig(v.root, v.input.id, observation(report, v));
        const change = direction === 'apply' ? applyBridgeConfig : restoreBridgeConfig;
        assert.throws(() => change(v.root, v.input.id, observation(report, v, direction), { afterExchange() { throw new Error('process-died'); } }), /process-died/);
        const inspected = checkBridgeConfig(v.root, v.input.id);
        assert.equal(inspected.state, direction + '_intent');
        assert.equal(inspected.physicalState, direction === 'apply' ? 'configured' : 'original');
        assert.equal(change(v.root, v.input.id, observation(report, v, direction)).state, direction === 'apply' ? 'configured' : 'restored');
    });
}

test('stale observation, PM2 conflict, unknown fields and unreserved writers fail before exchange', t => {
    const v = fixture(t), report = prepareBridgeConfig(v.root, v.input);
    for (const patch of [{ observedAt: 1 }, { pm2SavedModeAbsent: false }, { configWritersReserved: false },
        { noCompetingActivation: false }, { token: 'do-not-log' }]) {
        assert.throws(() => applyBridgeConfig(v.root, v.input.id, { ...observation(report, v), ...patch }));
        assert.equal(fs.readFileSync(v.env, 'utf8'), v.text);
    }
});

test('parent identity changes and backup tampering refuse configuration', t => {
    const v = fixture(t), report = prepareBridgeConfig(v.root, v.input);
    fs.chmodSync(v.root, 0o750);
    assert.throws(() => applyBridgeConfig(v.root, v.input.id, observation(report, v)), /receipt_identity/);
    fs.chmodSync(v.root, 0o700); fs.writeFileSync(path.join(v.work, 'original.env'), 'tampered');
    assert.throws(() => applyBridgeConfig(v.root, v.input.id, observation(report, v)), /backup_changed/);
});

test('cooperative config flock is held by the parent throughout the exchange callback', t => {
    const v = fixture(t), report = prepareBridgeConfig(v.root, v.input);
    applyBridgeConfig(v.root, v.input.id, observation(report, v), { afterExchange() {
        const lock = path.join(path.dirname(v.work), 'config.lock');
        assert.notEqual(spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', lock, '/usr/bin/true']).status, 0);
    } });
});

test('check never recreates a missing configuration lock', t => {
    const v = fixture(t); prepareBridgeConfig(v.root, v.input);
    const lock = path.join(path.dirname(v.work), 'config.lock'); fs.unlinkSync(lock);
    assert.throws(() => checkBridgeConfig(v.root, v.input.id), /ENOENT/);
    assert.equal(fs.existsSync(lock), false);
});
test('group-writable config directories are rejected without touching live bytes', t => {
    const v = fixture(t), report = prepareBridgeConfig(v.root, v.input);
    fs.chmodSync(v.work, 0o770);
    assert.throws(() => applyBridgeConfig(v.root, v.input.id, observation(report, v)), /directory_unsafe/);
    assert.equal(fs.readFileSync(v.env, 'utf8'), v.text);
});
