import {installFixedStateMutexAuthority} from './fixtures/fixed-state-mutex-authority.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDeferredStopFixture } from './fixtures/forward-stop-result-fixture.mjs';
import { recordForwardSupervisorDeferral, inspectForwardResumeEligibility } from './lib/release-runtime-forward-supervisor.mjs';

test('eligibility reads a production-recorded deferral and preserves the original acceptance', async t => {
    const f = await setupDeferredStopFixture(t);
    installFixedStateMutexAuthority(t,f.root,f.config);
    const deferred = await recordForwardSupervisorDeferral(f.config, f.intent, f.permit, f.result, f.deps);
    const eligibility = await inspectForwardResumeEligibility(f.config, f.intent.transactionId, f.deps);
    assert.equal(eligibility.phase, 'supervisor_stop_deferred'); assert.match(eligibility.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(f.read('first-cutover.json'), deferred);
});
for (const variant of ['wrong-transaction', 'hidden-migration', 'expired-window', 'old-intent', 'budget']) {
    test(`resume eligibility rejects ${variant} without changing any record`, async t => {
        const f = await setupDeferredStopFixture(t);
    installFixedStateMutexAuthority(t,f.root,f.config);
        await recordForwardSupervisorDeferral(f.config, f.intent, f.permit, f.result, f.deps);
        const journal = f.read('first-cutover.json');
        if (variant === 'hidden-migration') journal.forwardMigrationIntent = { uncertain: true };
        if (variant === 'expired-window') journal.initialStartWindow = { expiresAtBootMs: 1 };
        if (variant === 'old-intent') journal.forwardSupervisorAttempts.unshift({ ...journal.forwardSupervisorAttempts[0], steps: [{ state: 'possibly_sent' }] });
        if (variant === 'budget') journal.forwardSupervisorAttempts = Array.from({ length: 8 }, () => journal.forwardSupervisorAttempts[0]);
        f.write('first-cutover.json', journal);
        await assert.rejects(inspectForwardResumeEligibility(f.config, variant === 'wrong-transaction' ? 'another-transaction' : f.intent.transactionId, f.deps));
        assert.deepEqual(f.read('first-cutover.json'), journal);
    });
}
