import {installFixedStateMutexAuthority} from './fixtures/fixed-state-mutex-authority.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupDeferredStopFixture } from './fixtures/forward-stop-result-fixture.mjs';
import { recordForwardSupervisorDeferral } from './lib/release-runtime-forward-supervisor.mjs';
import { runReconciledForwardOperator } from './release-runtime-forward-parent.mjs';
import { inspectForwardChildIdentity } from './lib/release-runtime-forward-child-protocol.mjs';

async function setup(t) {
    const f = await setupDeferredStopFixture(t);
    installFixedStateMutexAuthority(t,f.root,f.config);
    await recordForwardSupervisorDeferral(f.config, f.intent, f.permit, f.result, f.deps);
    const journal = f.read('first-cutover.json');
    journal.operator = { pid: f.result.pid, startTicks: f.result.startTicks, bootId: f.result.bootId };
    f.write('first-cutover.json', journal);
    f.write('first-cutover.lock', { schema: 'nassaj-cutover-lock/v1', pid: journal.operator.pid, startTime: journal.operator.startTicks });
    f.write('host.json', f.config);
    const fixed = '/etc/nassaj/release-runtime-host.json', local = path.join(f.root, 'host.json');
    const lstat = fs.lstatSync, open = fs.openSync, realpath = fs.realpathSync;
    t.mock.method(fs, 'lstatSync', (file, ...args) => lstat(file === fixed ? local : file, ...args));
    t.mock.method(fs, 'openSync', (file, ...args) => open(file === fixed ? local : file, ...args));
    t.mock.method(fs, 'realpathSync', (file, ...args) => file === fixed ? fixed : realpath(file, ...args));
    t.mock.method(process, 'geteuid', () => 0);
    return { ...f, request: { schema: 'nassaj-forward-activation-operation/v1', operationId: f.intent.transactionId } };
}
test('explicit facade reconciliation preserves tombstone/history and releases only its uneffected replacement lock', async t => {
    const f = await setup(t); const before = f.read('first-cutover.json'); const lock = fs.readFileSync(path.join(f.root, 'first-cutover.lock'));
    const result = await runReconciledForwardOperator(f.request, { runtime: f.deps });
    assert.equal(result.decision, 'reconciled'); const after = f.read('first-cutover.json');
    assert.equal(after.approvalAcceptedAt, before.approvalAcceptedAt);
    assert.deepEqual(after.forwardSupervisorAttempts, before.forwardSupervisorAttempts);
    assert.deepEqual(fs.readFileSync(path.join(f.root, after.forwardLockReconciliation.tombstone)), lock);
    assert.equal(fs.existsSync(path.join(f.root, 'first-cutover.lock')), false);
    assert.equal(f.read('host-dispatch-state.json').gateActive, true);
});
test('live abandoned-owner claim refuses any lock transfer', async t => {
    const f = await setup(t); const j = f.read('first-cutover.json'); const live = inspectForwardChildIdentity(process.pid);
    j.operator = { pid: live.pid, startTicks: live.startTicks, bootId: live.bootId }; f.write('first-cutover.json', j);
    f.write('first-cutover.lock', { schema: 'nassaj-cutover-lock/v1', pid: live.pid, startTime: live.startTicks });
    const lock = fs.readFileSync(path.join(f.root, 'first-cutover.lock'));
    await assert.rejects(runReconciledForwardOperator(f.request, { runtime: f.deps }), /owner_unproven/);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'first-cutover.lock')), lock);
});
test('unknown older mutation is diagnosis-only and never replaces the original owner', async t => {
    const f = await setup(t); const j = f.read('first-cutover.json');
    j.forwardSupervisorAttempts[0].steps.push({ state: 'possibly_sent' }); f.write('first-cutover.json', j);
    const lock = fs.readFileSync(path.join(f.root, 'first-cutover.lock'));
    const result = await runReconciledForwardOperator(f.request, { runtime: f.deps });
    assert.equal(result.decision, 'diagnosis_only'); assert.deepEqual(f.read('first-cutover.json'), j);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'first-cutover.lock')), lock);
});
test('interruption before owner rename retains exact intent/tombstone for explicit re-entry', async t => {
    const f = await setup(t); const rename = fs.renameSync; let failed = false;
    t.mock.method(fs, 'renameSync', (from, to) => {
        if (to === path.join(f.root, 'first-cutover.lock') && !failed) { failed = true; throw Error('fixture before owner rename'); }
        return rename(from, to);
    });
    await assert.rejects(runReconciledForwardOperator(f.request, { runtime: f.deps }), /before owner rename/);
    assert.equal(f.read('first-cutover.json').forwardLockReconciliation.phase, 'intent');
    const result = await runReconciledForwardOperator(f.request, { runtime: f.deps });
    assert.equal(result.decision, 'reconciled');
});
test('interruption after owner rename never transfers a still-live replacement owner again', async t => {
    const f = await setup(t); const rename = fs.renameSync; let failed = false;
    t.mock.method(fs, 'renameSync', (from, to) => {
        const value = rename(from, to);
        if (to === path.join(f.root, 'first-cutover.lock') && !failed) { failed = true; throw Error('fixture after owner rename'); }
        return value;
    });
    await assert.rejects(runReconciledForwardOperator(f.request, { runtime: f.deps }), /after owner rename/);
    const bytes = fs.readFileSync(path.join(f.root, 'first-cutover.lock'));
    await assert.rejects(runReconciledForwardOperator(f.request, { runtime: f.deps }), /owner_unproven/);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'first-cutover.lock')), bytes);
    assert.equal(f.read('first-cutover.json').forwardLockReconciliation.phase, 'intent');
});
