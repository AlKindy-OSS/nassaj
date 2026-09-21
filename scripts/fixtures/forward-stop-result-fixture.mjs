import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { sign } from 'node:crypto';
import { setupInitialArmFixture } from './initial-arm-fixture.mjs';
import { inspectForwardChildIdentity, canonicalForwardValue as canonical, forwardValueSha256 as sha } from '../lib/release-runtime-forward-child-protocol.mjs';
// Signed stopped-supervisor result boundary only. PM2/systemd facts are explicit fixture seams.
export async function setupDeferredStopFixture(t, alive = false) {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'], { stdio: ['pipe', 'ignore', 'ignore'] });
    await once(child, 'spawn');
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.stdin.end(); await closed; } });
    const f = await setupInitialArmFixture(t, { workerChild: child });
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
