import {installFixedStateMutexAuthority} from './fixtures/fixed-state-mutex-authority.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { sign } from 'node:crypto';
import { setupInitialArmFixture } from './fixtures/initial-arm-fixture.mjs';
import { recordForwardSupervisorDeferral } from './lib/release-runtime-forward-supervisor.mjs';
import { inspectForwardChildIdentity, canonicalForwardValue as canonical, forwardValueSha256 as sha } from './lib/release-runtime-forward-child-protocol.mjs';

// Signed result-boundary fixture: real children and kernel death, real durable CAS;
// PM2 and systemd observations are declared seams, not evidence of an actual host stop.
async function setup(t, alive = false) {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'], { stdio: ['pipe', 'ignore', 'ignore'] });
    await once(child, 'spawn');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.stdin.end(); await closed; } });
    const f = await setupInitialArmFixture(t, { workerChild: child });
    installFixedStateMutexAuthority(t,f.root,f.config);
    const intent = { ...f.intent, phase: 'stop' };
    const worker = inspectForwardChildIdentity(f.worker.pid);
    const oldSlot = { pmId: 44, baseline: f.response.privateEntries[0].pm2_env,
        entrySha256: sha(f.response.privateEntries[0].pm2_env), process: inspectForwardChildIdentity(f.target.pid) };
    f.config.forwardActivation = { supervisorPlan: { mutation: { oldSlot }, pm2: { observer: {} } }, mutatorPlan: { sources: [] } };
    f.config.expected.supervisorPlanSha256 = sha(f.config.forwardActivation.supervisorPlan);
    f.config.expected.mutatorPlanSha256 = sha(f.config.forwardActivation.mutatorPlan);
    const { signature: _signature, ...payload } = f.read('approval.json');
    payload.expectedSha256 = sha(f.config.expected);
    const approval = { ...payload, signature: sign(null, Buffer.from(canonical(payload)), f.keys.privateKey).toString('base64url') };
    f.write('approval.json', approval);
    const permit = { transactionId: intent.transactionId, phase: 'stop', attemptNonce: intent.attemptNonce,
        challenge: 'b'.repeat(64), pid: worker.pid, startTicks: worker.startTicks, bootId: worker.bootId };
    const journal = { ...f.read('first-cutover.json'), expected: f.config.expected, approvalSha256: sha(approval),
        phase: 'supervisor_stop_authorized', forwardSupervisorIntent: intent, forwardSupervisorAuthorization: permit,
        forwardSupervisorAttempts: [{ attemptId: intent.attemptId, attemptNonce: intent.attemptNonce, worker, steps: [] }] };
    delete journal.initialStartWindow; delete journal.targetSlotBinding;
    journal.forwardAdmission = { generationEpoch: f.read('startup-admission.json').generationEpoch, revision: f.read('startup-admission.json').revision, sha256: sha(f.read('startup-admission.json')) };
    f.write('first-cutover.json', journal);
    const result = { ...permit, schema: 'nassaj-forward-supervisor-result/v1', result: {
        schema: 'nassaj-forward-supervisor-deferred/v1', reason: 'live_work',
        counters: { liveSessions: 1, workflows: 0, admittedTurns: 0 }, observationSha256: 'd'.repeat(64) } };
    if (!alive) { const closed = once(f.worker, 'close'); f.worker.stdin.end(); await closed; }
    return { ...f, intent, permit, result, deps: { observePrivateRuntime: async () => f.response, observeInhibitors: () => {} } };
}
test('late busy preserves maintenance, epoch and acceptance after actual worker death', async t => {
    const f = await setup(t); const before = f.read('first-cutover.json');
    const state = f.read('startup-admission.json'), host = f.read('host-dispatch-state.json');
    const next = await recordForwardSupervisorDeferral(f.config, f.intent, f.permit, f.result, f.deps);
    assert.equal(next.phase, 'supervisor_stop_deferred'); assert.equal(next.forwardSupervisorDeferral.maintenance, true);
    assert.equal(next.approvalAcceptedAt, before.approvalAcceptedAt);
    assert.deepEqual(f.read('startup-admission.json'), state); assert.deepEqual(f.read('host-dispatch-state.json'), host);
    assert.equal(next.forwardSupervisorAttempts.length, 1); assert.equal(next.forwardSupervisorAttempts[0].steps.length, 0);
});
test('a live worker cannot qualify for late deferral', async t => {
    const f = await setup(t, true);
    await assert.rejects(recordForwardSupervisorDeferral(f.config, f.intent, f.permit, f.result, f.deps), /process_not_proven_dead/);
});
for (const variant of ['nested-intent', 'lost-result', 'pid-swap', 'revoke-during-observation', 'hidden-start-window', 'hidden-migration']) {
    test(`late deferral rejects ${variant} without changing maintenance`, async t => {
        const f = await setup(t); const host = f.read('host-dispatch-state.json');
        if (variant === 'nested-intent') { const j = f.read('first-cutover.json'); j.forwardSupervisorAttempts[0].steps.push({ state: 'possibly_sent' }); f.write('first-cutover.json', j); }
        if (variant === 'hidden-start-window' || variant === 'hidden-migration') { const j = f.read('first-cutover.json'); j[variant === 'hidden-start-window' ? 'initialStartWindow' : 'forwardMigrationIntent'] = { uncertain: true }; f.write('first-cutover.json', j); }
        if (variant === 'lost-result') f.result.result.reason = 'unknown';
        if (variant === 'pid-swap') f.response.privateEntries[0].pid = process.pid;
        if (variant === 'revoke-during-observation') f.deps.observePrivateRuntime = async () => {
            const state = f.read('startup-admission.json'); f.write('startup-admission.json', { ...state, transitionReason: 'fixture revoke', generationEpoch: state.generationEpoch + 1 }); return f.response;
        };
        await assert.rejects(recordForwardSupervisorDeferral(f.config, f.intent, f.permit, f.result, f.deps));
        assert.equal(f.read('first-cutover.json').phase, 'supervisor_stop_authorized'); assert.deepEqual(f.read('host-dispatch-state.json'), host);
    });
}

for (const state of ['possibly_sent', 'observed']) {
    test(`older attempt with ${state} PM2 step prevents fresh no-dispatch deferral`, async t => {
        const f = await setup(t); const journal = f.read('first-cutover.json');
        journal.forwardSupervisorAttempts.unshift({ ...journal.forwardSupervisorAttempts[0],
            attemptId: 'older-attempt', attemptNonce: 'e'.repeat(64), state: 'deferred',
            steps: [{ step: 'stop-old', state, intent: { schema: 'nassaj-pm2-execution-intent/v1' } }] });
        f.write('first-cutover.json', journal); const host = f.read('host-dispatch-state.json');
        await assert.rejects(recordForwardSupervisorDeferral(f.config, f.intent, f.permit, f.result, f.deps), /deferred_history/);
        assert.deepEqual(f.read('first-cutover.json'), journal); assert.deepEqual(f.read('host-dispatch-state.json'), host);
    });
}
test('retained proven busy attempt remains present and does not reset the attempt count', async t => {
    const f = await setup(t); const journal = f.read('first-cutover.json');
    const previousNonce = 'e'.repeat(64);
    journal.forwardSupervisorAttempts.unshift({ ...journal.forwardSupervisorAttempts[0],
        attemptId: 'older-attempt', attemptNonce: previousNonce, state: 'deferred',
        deferredResult: { ...f.result, attemptNonce: previousNonce } });
    f.write('first-cutover.json', journal);
    const next = await recordForwardSupervisorDeferral(f.config, f.intent, f.permit, f.result, f.deps);
    assert.equal(next.forwardSupervisorAttempts.length, 2);
    assert.deepEqual(next.forwardSupervisorAttempts[0], journal.forwardSupervisorAttempts[0]);
});

test('separate completed supervisor history cannot be hidden by an empty current attempt', async t => {
    const f = await setup(t); const journal = f.read('first-cutover.json');
    journal.forwardSupervisorHistory = [{ intent: { phase: 'stop' }, result: { steps: [{ step: 'stop-old' }] } }];
    f.write('first-cutover.json', journal);
    await assert.rejects(recordForwardSupervisorDeferral(f.config, f.intent, f.permit, f.result, f.deps), /deferred_history/);
    assert.deepEqual(f.read('first-cutover.json'), journal);
});
