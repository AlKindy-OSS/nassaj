import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fixture } from './fixtures/startup-admission-fixture.mjs';
import { handleBootstrapStartupAdmission, finalizeCommittedStartupAdmission } from './lib/release-runtime-startup-admission.mjs';
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
        : JSON.stringify(value);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hash = 'a'.repeat(64);

test('signed persistent authority allows fresh same-generation claim only after old process exits', t => {
    const f = fixture(t); const precedingClaim = f.read('startup-admission.json').lastClaim; const first = f.call(f.request());
    assert.deepEqual(f.read('startup-admission.json').lastClaim, precedingClaim, 'offer is not a claim');
    const claimed = f.call(f.consume(first)); assert.equal(claimed.databaseIno, '9007199254740993');
    assert.throws(() => f.call(f.consume(first)), /offer_stale/);
    f.caller.pid += 1; f.deps.processGone = () => false;
    assert.throws(() => f.call(f.request()), /previous_process_present/);
    f.deps.processGone = () => true;
    const second = f.call(f.consume(f.call(f.request())));
    assert.notEqual(second.claimId, claimed.claimId);
});

test('first cutover is consumed in both records and cannot be rearmed after response loss', t => {
    const f = fixture(t, 'cutover'); const offer = f.call(f.request()); f.call(f.consume(offer));
    assert.equal(f.read('first-cutover.json').phase, 'startup_claimed');
    f.caller.pid += 1; f.deps.processGone = () => true;
    assert.throws(() => f.call(f.request()), /transition_unresolved/);
});

test('owner policy tampering, missing persistent scope, and wrong manifest deny', async t => {
    for (const variant of ['tamper', 'missing-policy', 'manifest']) await t.test(variant, child => {
        const f = fixture(child);
        if (variant === 'manifest') f.write('manifest.json', { changed: true });
        else { const approval = f.read('approval.json');
            if (variant === 'tamper') approval.startupAdmission.generationId = 'other-generation';
            else delete approval.startupAdmission.startupAdmissionPolicy;
            f.write('approval.json', approval);
        }
        assert.throws(() => f.call(f.request()), /owner_authority_invalid|manifest_changed|installed_config_runtime_binding/);
    });
});

test('approval expiry after an explicitly approved terminal installation does not revoke persistent grant', t => {
    const f = fixture(t); f.deps.now = () => Date.now() + 1_000_000;
    assert.equal(f.call(f.consume(f.call(f.request()))).decision, 'claimed');
});

test('revocation, replaced journal, transition intent, and offer expiration reject consume', async t => {
    for (const variant of ['revocation', 'journal', 'intent', 'expiry']) await t.test(variant, child => {
        const f = fixture(child); const offer = f.call(f.request());
        if (variant === 'revocation') { const state = f.read('startup-admission.json'); state.state = 'revoked'; state.generationEpoch += 1; f.write('startup-admission.json', state); }
        if (variant === 'journal') { const journal = f.read('first-cutover.json'); journal.state = 'manual_recovery'; f.write('first-cutover.json', journal); }
        if (variant === 'intent') { const host = f.read('host-dispatch-state.json'); host.migrationIntent = { schema: 'nassaj-host-migration-intent/v1' }; f.write('host-dispatch-state.json', host); }
        if (variant === 'expiry') f.deps.bootMs = () => 40_000;
        assert.throws(() => f.call(f.consume(offer)), /transition_unresolved|offer_stale|legacy_intent_unsupported/);
        assert.equal(f.read('startup-admission.json').lastClaim.mode, 'cutover');
    });
});

test('request extra authority keys and PID mismatch cannot select a generation or caller', t => {
    const f = fixture(t);
    assert.throws(() => f.call({ ...f.request(), mode: 'steady' }), /fields_invalid/);
    assert.throws(() => f.call({ ...f.request(), pid: 123 }), /caller_mismatch/);
});

test('same process cannot extend an offer and unknown preceding process blocks admission', t => {
    const f = fixture(t); f.call(f.request());
    assert.throws(() => f.call(f.request()), /offer_already_issued/);
    f.caller.pid += 1; f.deps.processGone = () => { throw Error('EACCES'); };
    assert.throws(() => f.call(f.request()), /EACCES/);
});

test('production root guard rejects the unprivileged fixture without injected filesystem or UID', t => {
    const f = fixture(t); f.authority.restoreEffectiveUid();
    assert.throws(() => handleBootstrapStartupAdmission(f.config, f.request(), () => f.caller), /root_required/);
});

test('boot change never clears a nonterminal journal', t => {
    const f = fixture(t, 'cutover'); const offer = f.call(f.request()); f.call(f.consume(offer));
    f.caller.bootId = '22345678-1234-1234-1234-123456789012'; f.deps.processGone = () => true;
    assert.throws(() => f.call(f.request()), /transition_unresolved/);
});

test('root transition invalidates an offer while retaining an already claimed process', async t => {
    const { invalidateCutoverStartupAdmission } = await import('./lib/release-runtime-cutover.mjs');
    const f = fixture(t); const offer = f.call(f.request());
    invalidateCutoverStartupAdmission(f.root, 'root_transition');
    assert.throws(() => f.call(f.consume(offer)), /transition_unresolved/);
    const g = fixture(t); const claim = g.call(g.consume(g.call(g.request())));
    invalidateCutoverStartupAdmission(g.root, 'root_transition');
    assert.equal(g.read('startup-admission.json').potentiallyRunningClaim.claimId, claim.claimId);
});


test('active state requires its consumed activation anchor and an existing last claim', async t => {
    for (const variant of ['null-last', 'missing-last', 'pending-initial', 'missing-initial', 'wrong-initial-process']) {
        await t.test(variant, child => {
            const f = fixture(child); const state = f.read('startup-admission.json'); const journal = f.read('first-cutover.json');
            if (variant === 'null-last') state.lastClaim = null;
            if (variant === 'missing-last') delete state.lastClaim;
            if (variant === 'pending-initial') journal.startupClaim.state = 'pending';
            if (variant === 'missing-initial') delete journal.startupClaim;
            if (variant === 'wrong-initial-process') journal.startupClaim.pid += 100;
            // Even a coherent digest over corrupt terminal state is not consumed process evidence.
            state.commitReceiptSha256 = sha(canonical(journal));
            if (journal.startupClaim) state.activationClaimSha256 = sha(canonical(journal.startupClaim));
            f.write('first-cutover.json', journal); f.write('startup-admission.json', state);
            assert.throws(() => f.call(f.request()), /committed_claim_missing|committed_claim_mismatch/);
        });
    }
});

test('actual legacy intent and rollback names deny even alongside committed forward proofs', async t => {
    for (const key of ['migrationIntent', 'oldDeleteIntent', 'oldKilledForRollback', 'oldRestartedFresh', 'newUnknownIntent']) {
        await t.test(key, child => {
            const f = fixture(child); const host = f.read('host-dispatch-state.json'); host[key] = true; f.write('host-dispatch-state.json', host);
            assert.throws(() => f.call(f.request()), /legacy_intent_unsupported|unknown_host_state/);
        });
    }
});

test('historical gate intent must match transaction, identity and both public boundary receipts', async t => {
    for (const variant of ['transaction', 'seal', 'nonce', 'ready', 'opened']) await t.test(variant, child => {
        const f = fixture(child); const host = f.read('host-dispatch-state.json');
        if (variant === 'transaction') host.gateInstallIntent.transactionId = 'another';
        if (variant === 'seal') host.gateInstallIntent.identitySeal = 'b'.repeat(64);
        if (variant === 'nonce') host.gateInstallIntent.nonce = 'other';
        if (variant === 'ready') delete host.publicBoundaryReady;
        if (variant === 'opened') host.publicBoundaryOpened.nonce = 'other';
        f.write('host-dispatch-state.json', host);
        assert.throws(() => f.call(f.request()), /gate_intent_unresolved/);
    });
});

test('real finalizer refuses missing or mismatched typed proof and never creates active grant', async t => {
    for (const variant of ['missing', 'process', 'build', 'transaction']) await t.test(variant, child => {
        const f = fixture(child, 'cutover'); f.call(f.consume(f.call(f.request()))); f.prepareCommit();
        const journal = f.read('first-cutover.json');
        if (variant === 'missing') delete journal.forwardReceipts.private;
        if (variant === 'process') journal.forwardReceipts.public.process.pid += 10;
        if (variant === 'build') journal.forwardReceipts.public.serverBuildId = 'b'.repeat(64);
        if (variant === 'transaction') journal.forwardReceipts.private.transactionId = 'other';
        f.write('first-cutover.json', journal);
        assert.throws(() => finalizeCommittedStartupAdmission(f.config, f.deps), /terminal_receipt_invalid/);
        assert.equal(f.read('first-cutover.json').state, 'running');
        assert.equal(f.read('startup-admission.json').state, 'switching');
    });
});

test('root handler rejects a validly signed and digest-pinned contract with mismatched startup closure', t => {
    const f = fixture(t, 'cutover', { startup: { policyId: 'existing-security-state/v1', closureSha256: 'b'.repeat(64) } });
    assert.throws(() => f.call(f.request()), /database_release_contract_invalid/);
});

test('finalizer persists actual terminal transition and is idempotent without replaying the original claim', t => {
    const f = fixture(t, 'cutover'); const claim = f.call(f.consume(f.call(f.request())));
    const active = f.commit(); const terminal = f.read('first-cutover.json');
    assert.equal(terminal.state, 'committed'); assert.equal(terminal.phase, 'committed');
    assert.equal(active.lastClaim.claimId, claim.claimId); assert.equal(active.activationClaimSha256, sha(canonical(terminal.startupClaim)));
    assert.deepEqual(finalizeCommittedStartupAdmission(f.config, f.deps), active);
    f.caller.pid += 1; f.deps.processGone = () => true;
    f.call(f.consume(f.call(f.request())));
    const current = f.read('startup-admission.json').lastClaim;
    assert.notEqual(current.claimId, claim.claimId);
    assert.equal(finalizeCommittedStartupAdmission(f.config, f.deps).lastClaim.claimId, current.claimId);
});


test('finalization cannot reactivate a grant after maintenance invalidation', async t => {
    const { invalidateCutoverStartupAdmission } = await import('./lib/release-runtime-cutover.mjs');
    const f = fixture(t); invalidateCutoverStartupAdmission(f.root, 'maintenance');
    const before = f.read('startup-admission.json');
    assert.throws(() => finalizeCommittedStartupAdmission(f.config, f.deps), /finalization_invalidated/);
    assert.deepEqual(f.read('startup-admission.json'), before);
    assert.equal(before.state, 'switching');
});

test('missing, corrupt or changed finalization epoch and transition markers deny', async t => {
    for (const variant of ['missing', 'string', 'different', 'reason', 'running', 'revocation', 'revision']) await t.test(variant, child => {
        const f = fixture(child, 'cutover'); f.call(f.consume(f.call(f.request()))); f.prepareCommit();
        const state = f.read('startup-admission.json');
        if (variant === 'missing') delete state.generationEpoch;
        if (variant === 'string') state.generationEpoch = '1';
        if (variant === 'different') state.generationEpoch += 1;
        if (variant === 'reason') state.transitionReason = 'maintenance';
        if (variant === 'running') state.potentiallyRunningClaim = state.lastClaim;
        if (variant === 'revocation') state.revocation = {};
        if (variant === 'revision') state.revision += 1;
        f.write('startup-admission.json', state);
        assert.throws(() => finalizeCommittedStartupAdmission(f.config, f.deps), /finalization_invalidated|finalization_phase_invalid/);
        assert.equal(f.read('startup-admission.json').state, 'switching');
    });
});

function finalizerChild(f, failAt) {
    const moduleUrl = new URL('./lib/release-runtime-startup-admission.mjs', import.meta.url).href;
    const authorityUrl = new URL('./fixtures/fixed-state-mutex-authority.mjs', import.meta.url).href;
    const source = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
        import { mock as mutexMock } from 'node:test';
        import { installFixedStateMutexAuthority } from ${JSON.stringify(authorityUrl)};
        import { finalizeCommittedStartupAdmission } from ${JSON.stringify(moduleUrl)};
        const input = JSON.parse(process.argv[1]);
        installFixedStateMutexAuthority({ mock: mutexMock }, input.config.controlRoot,
            JSON.parse(fs.readFileSync(${JSON.stringify(f.authority.file)}, 'utf8')), { file: ${JSON.stringify(f.authority.file)} });
        let calls = 0; const original = fs.fsyncSync;
        fs.fsyncSync = (...args) => { if (++calls === ${failAt}) throw Error('injected_finalizer_fsync'); return original(...args); };
        syncBuiltinESMExports();
        try { const result = finalizeCommittedStartupAdmission(input.config, { ownerUid: process.getuid(),
            effectiveUid: () => process.getuid(),
            now: () => input.now, readRootFile: file => fs.readFileSync(file) });
            process.stdout.write(JSON.stringify(result));
        } catch (error) { process.stderr.write(error.message); process.exitCode = 78; }`;
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify({ config: f.config, now: f.deps.now() })],
            { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
    });
}

test('finalizer fsync failures never respond successfully and unchanged-epoch recovery preserves the claim', async t => {
    // The kernel mutex is never removed, so the old lock-release directory fsync (7) is gone.
    for (const failAt of [1, 2, 3, 4, 5, 6]) await t.test(`fsync ${failAt}`, async child => {
        const f = fixture(child, 'cutover'); const claim = f.call(f.consume(f.call(f.request()))); f.prepareCommit();
        const result = await finalizerChild(f, failAt);
        assert.equal(result.code, 78); assert.equal(result.stdout, ''); assert.match(result.stderr, /injected_finalizer_fsync/);
        const journal = f.read('first-cutover.json'); const state = f.read('startup-admission.json');
        assert.equal(journal.state, failAt >= 4 ? 'committed' : 'running');
        assert.equal(state.state, failAt >= 6 ? 'active' : 'switching');
        const recovered = finalizeCommittedStartupAdmission(f.config, f.deps);
        assert.equal(recovered.state, 'active'); assert.equal(recovered.lastClaim.claimId, claim.claimId);
        assert.equal(recovered.generationEpoch, claim.generationEpoch);
        assert.deepEqual(finalizeCommittedStartupAdmission(f.config, f.deps), recovered);
    });
});

test('maintenance between terminal persistence and active write blocks finalizer recovery', async t => {
    const { invalidateCutoverStartupAdmission } = await import('./lib/release-runtime-cutover.mjs');
    const f = fixture(t, 'cutover'); f.call(f.consume(f.call(f.request()))); f.prepareCommit();
    const failed = await finalizerChild(f, 5); assert.equal(failed.code, 78);
    assert.equal(f.read('first-cutover.json').state, 'committed');
    assert.equal(f.read('startup-admission.json').state, 'switching');
    invalidateCutoverStartupAdmission(f.root, 'maintenance');
    const invalidated = f.read('startup-admission.json');
    assert.throws(() => finalizeCommittedStartupAdmission(f.config, f.deps), /finalization_invalidated/);
    assert.deepEqual(f.read('startup-admission.json'), invalidated);
});


test('cutover security authorization precedes private readiness and serving waits for real finalization', t => {
    const f = fixture(t, 'cutover'); f.call(f.consume(f.call(f.request())));
    assert.throws(() => f.phase('serving'), /security_startup_not_authorized/);
    assert.equal(f.phase('security').decision, 'security_startup_authorized');
    assert.equal(f.phase('serving').decision, 'pending');
    assert.throws(() => f.phase('security'), /security_startup_already_authorized/);
    f.commit(); assert.equal(f.phase('serving').decision, 'serving');
});

test('steady serving requires security authority for its current claim, never the activation claim', t => {
    const f = fixture(t); const claim = f.call(f.consume(f.call(f.request())));
    assert.throws(() => f.phase('serving'), /security_startup_not_authorized/);
    assert.equal(f.phase('security').decision, 'security_startup_authorized');
    assert.equal(f.phase('serving').claimId, claim.claimId);
    const state = f.read('startup-admission.json'); state.securityStartup.claimId = f.read('first-cutover.json').startupClaim.claimId;
    f.write('startup-admission.json', state);
    assert.throws(() => f.phase('serving'), /security_startup_not_authorized/);
});

test('initial security admission needs the exact durable schema proof and closed gate', async t => {
    for (const variant of ['missing', 'schema', 'gate']) await t.test(variant, child => {
        const f = fixture(child, 'cutover'); f.call(f.consume(f.call(f.request())));
        const journal = f.read('first-cutover.json');
        if (variant === 'missing') delete journal.forwardReceipts.schema;
        if (variant === 'schema') journal.forwardReceipts.schema.targetSchemaDigest = 'b'.repeat(64);
        f.write('first-cutover.json', journal);
        if (variant === 'gate') { const host = f.read('host-dispatch-state.json'); host.gateActive = false; f.write('host-dispatch-state.json', host); }
        assert.throws(() => f.phase('security'), /security_startup_preconditions_missing/);
    });
});

// The full facade fixture also exercises the actual closeGate producer through this consumer.
test('first-forward gate evidence binds closure time to its original operation epoch and intent', async t => {
    for (const variant of ['valid', 'time', 'order', 'epoch', 'operation', 'hash', 'unknown']) await t.test(variant, child => {
        const f = fixture(child, 'cutover'); const host = f.read('host-dispatch-state.json'); const journal = f.read('first-cutover.json');
        const now = Date.now(); host.gateInstallIntent = { ...host.gateInstallIntent, transactionId: journal.transactionId, at: now - 1 };
        host.firstForwardGateClosedAt = now; journal.forwardAdmission = { generationEpoch: 1 };
        journal.forwardGateReceipt = { schema: 'nassaj-first-forward-ingress-receipt/v1', operationId: journal.transactionId,
            generationEpoch: 1, phase: 'closed', closedAt: now, hostProofSha256: sha(canonical(host.gateInstallIntent)) };
        if (variant === 'time') host.firstForwardGateClosedAt = -1;
        if (variant === 'order') host.gateInstallIntent.at = now + 1;
        if (variant === 'epoch') journal.forwardGateReceipt.generationEpoch++;
        if (variant === 'operation') journal.forwardGateReceipt.operationId = 'other';
        if (variant === 'hash') journal.forwardGateReceipt.hostProofSha256 = hash;
        if (variant === 'unknown') host.unreviewed = true;
        f.write('host-dispatch-state.json', host); f.write('first-cutover.json', journal);
        if (variant === 'valid') assert.equal(f.call(f.request()).decision, 'offered');
        else assert.throws(() => f.call(f.request()), /first_forward_gate_receipt|unknown_host_state/);
    });
});
