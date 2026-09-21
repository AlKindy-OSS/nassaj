import {installFixedStateMutexAuthority} from './fixtures/fixed-state-mutex-authority.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture } from './fixtures/startup-admission-fixture.mjs';
import { invalidateCutoverStartupAdmission } from './lib/release-runtime-cutover.mjs';
import { runPreparedForwardMigrationOperator } from './release-runtime-forward-parent.mjs';

function setup(t, counters) {
    const f = fixture(t, 'cutover'); const initialAdmission = f.read('startup-admission.json');
    // Only root credentials/config path metadata are simulated. The fixed facade,
    // signature verification and bounded probe subprocess execute actual production code.
    const fixed = '/etc/nassaj/release-runtime-host.json', local = path.join(f.root, 'host.json');
    const map = file => file === fixed ? local : file;
    const lstat = fs.lstatSync, fstat = fs.fstatSync, open = fs.openSync, realpath = fs.realpathSync;
    const ids = new Set();
    t.mock.method(fs, 'lstatSync', (file, ...args) => { const stat = lstat(map(file), ...args); stat.uid = 0;
        if (stat.isDirectory()) stat.mode &= ~0o022; ids.add(stat.ino); return stat; });
    t.mock.method(fs, 'fstatSync', (...args) => { const stat = fstat(...args); if (ids.has(stat.ino)) stat.uid = 0; return stat; });
    t.mock.method(fs, 'openSync', (file, ...args) => open(map(file), ...args));
    t.mock.method(fs, 'realpathSync', (file, ...args) => file === fixed ? fixed : realpath(file, ...args));
    t.mock.method(process, 'geteuid', () => 0);
    const probe = path.join(f.root, 'probe');
    fs.writeFileSync(probe, `#!/bin/sh\nprintf '%s' '${JSON.stringify(counters)}'\n`, { mode: 0o755 });
    f.config.zeroWorkProbe = { file: probe, sha256: createHash('sha256').update(fs.readFileSync(probe)).digest('hex'), args: [], timeoutMs: 1000 };
    installFixedStateMutexAuthority(t,f.root,f.config,{file:local});
    f.write('host.json', f.config);
    for (const file of ['first-cutover.json', 'startup-admission.json', 'host-dispatch-state.json', 'first-cutover.lock']) fs.unlinkSync(path.join(f.root, file));
    return { ...f, initialAdmission, request: { schema: 'nassaj-forward-activation-operation/v1', operationId: 'transaction-one' } };
}
test('actual fresh facade busy probe defers without journal, acceptedAt, lock or ingress writes', async t => {
    const f = setup(t, { liveSessions: 1, workflows: 0, admittedTurns: 0 }); const before = fs.readdirSync(f.root).sort();
    const result = await runPreparedForwardMigrationOperator(f.request);
    assert.equal(result.phase, 'deferred'); assert.equal(result.maintenance, false);
    assert.deepEqual(fs.readdirSync(f.root).sort(), before);
});
test('actual facade never reports maintenance false for an existing operation', async t => {
    const f = setup(t, { liveSessions: 1, workflows: 0, admittedTurns: 0 });
    f.write('first-cutover.json', { state: 'running', phase: 'supervisor_stop_deferred' });
    await assert.rejects(runPreparedForwardMigrationOperator(f.request), /explicit_reconciliation_required/);
});
test('actual facade rejects unknown probe counters before creating an operator lock', async t => {
    const f = setup(t, { liveSessions: '1', workflows: 0, admittedTurns: 0 });
    await assert.rejects(runPreparedForwardMigrationOperator(f.request), /counters_invalid/);
    assert.equal(fs.existsSync(path.join(f.root, 'first-cutover.lock')), false);
});

test('producer-created invalidation surviving without its journal rejects before the busy probe', async t => {
    const f = setup(t, { liveSessions: 1, workflows: 0, admittedTurns: 0 });
    f.write('startup-admission.json', f.initialAdmission);
    invalidateCutoverStartupAdmission(f.root, 'maintenance');
    const state = f.read('startup-admission.json');
    assert.equal(state.state, 'switching'); assert.equal(state.transitionReason, 'maintenance');
    // Missing executable proves denial happens before probe execution, not because its output is idle/busy.
    fs.unlinkSync(f.config.zeroWorkProbe.file);
    await assert.rejects(runPreparedForwardMigrationOperator(f.request), /existing_control_requires_reconciliation/);
    assert.deepEqual(f.read('startup-admission.json'), state);
});
for (const state of [{state:'switching'}, {state:'unknown'}, {revocation:{reason:'prior-effect'}}, {}]) {
    test(`any surviving admission record is non-pristine: ${JSON.stringify(state)}`, async t => {
        const f = setup(t, {liveSessions:1,workflows:0,admittedTurns:0}); f.write('startup-admission.json', state);
        await assert.rejects(runPreparedForwardMigrationOperator(f.request), /existing_control_requires_reconciliation/);
    });
}

for (const name of ['startup-admission.json', 'host-dispatch-state.json', 'first-cutover.json', 'first-cutover.lock']) {
    test(`dangling ${name} is residue and rejects before probe`, async t => {
        const f = setup(t, {liveSessions:1,workflows:0,admittedTurns:0});
        fs.symlinkSync(path.join(f.root, 'absent-target'), path.join(f.root, name));
        fs.unlinkSync(f.config.zeroWorkProbe.file);
        await assert.rejects(runPreparedForwardMigrationOperator(f.request), /requires_reconciliation|explicit_reconciliation_required/);
        assert.ok(fs.lstatSync(path.join(f.root, name)).isSymbolicLink());
    });
}
