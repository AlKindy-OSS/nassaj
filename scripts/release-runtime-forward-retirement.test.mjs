import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { forwardRuntimeEntries, observeForwardSavedDefinition, verifyForwardRetirement } from './lib/release-runtime-forward-retirement.mjs';

function definition(t, name, value) {
    const root = fs.mkdtempSync(path.join(path.resolve(import.meta.dirname, '../.artifacts'), 'forward-retirement-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, name); fs.writeFileSync(file, JSON.stringify(value)); return file;
}
test('backup-only old target and ecosystem fallback reject even when primary would be empty', async t => {
    for (const [name, format, value] of [['dump.pm2.bak', 'pm2-dump-json', [{ name: 'nassaj-dev' }]],
        ['ecosystem.json', 'pm2-ecosystem-json', { apps: [{ name: 'nassaj-dev' }] }]]) await t.test(name, t => {
        assert.throws(() => observeForwardSavedDefinition(definition(t, name, value), format, { name: 'nassaj-dev' }), /old_target_present/);
    });
});
test('supported saved definitions preserve unrelated entries in the observation digest', t => {
    const file = definition(t, 'dump.pm2', [{ name: 'other', pm_exec_path: '/other/app.js' }]);
    const first = observeForwardSavedDefinition(file, 'pm2-dump-json', { name: 'nassaj-dev' });
    assert.equal(first.oldTargetAbsent, true);
    fs.writeFileSync(file, JSON.stringify([{ name: 'other', pm_exec_path: '/other/changed.js' }]));
    const changed = observeForwardSavedDefinition(file, 'pm2-dump-json', { name: 'nassaj-dev' });
    assert.notEqual(first.sha256, changed.sha256); assert.notEqual(first.unaffectedEntriesSha256, changed.unaffectedEntriesSha256);
});
test('opaque ecosystem code, unknown entry shapes and symlinks are not an absence proof', t => {
    const file = definition(t, 'ecosystem.cjs', [{ name: 'other' }]);
    assert.throws(() => observeForwardSavedDefinition(file, 'ecosystem-js', { name: 'nassaj-dev' }), /format_unknown/);
    fs.writeFileSync(file, JSON.stringify([{}]));
    assert.throws(() => observeForwardSavedDefinition(file, 'pm2-dump-json', { name: 'nassaj-dev' }), /entry_unknown/);
    const link = `${file}.link`; fs.symlinkSync(file, link);
    assert.throws(() => observeForwardSavedDefinition(link, 'pm2-dump-json', { name: 'nassaj-dev' }), /source_unsafe/);
});
test('runtime projection binds slot identity while excluding changing uptime counters', () => {
    const entry = { pm_id: 4, name: 'other', pid: 222, pm2_env: { namespace: 'default', pm_exec_path: '/other.js', pm_cwd: '/other',
        exec_interpreter: '/usr/bin/node', status: 'online', pm_uptime: 100 } };
    const before = forwardRuntimeEntries([entry]); entry.pm2_env.pm_uptime = 200;
    assert.deepEqual(forwardRuntimeEntries([entry]), before); entry.pm_id = 5;
    assert.notDeepEqual(forwardRuntimeEntries([entry]), before);
});

test('retirement plans must be bound to signed expected identity before any runtime observation', async () => {
    const config = { expected: {}, forwardActivation: { supervisorPlan: {}, mutatorPlan: {} } };
    const journal = { transactionId: 'fixture-operation', forwardRetirement: { schema: 'nassaj-forward-retirement/v1', transactionId: 'fixture-operation' } };
    await assert.rejects(verifyForwardRetirement(config, journal, { effectiveUid: () => 0,
        execFile: () => assert.fail('No command before plan binding') }), /plan_mismatch/);
});
