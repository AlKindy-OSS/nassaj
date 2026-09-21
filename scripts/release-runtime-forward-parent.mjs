#!/usr/bin/env node
/** Fixed root operator entry: this process owns the long lock; its A child uses direct async pipes. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runForwardMigrationChild, prepareForwardMigrationIntent, observeForwardTargetForResume, verifyForwardOwner, prepareForwardObservationReconciliation, assertForwardAbandonedObservationLock } from './lib/release-runtime-forward-parent.mjs';
import { assertForwardFrameKeys, inspectForwardChildIdentity, readForwardPermitFrame, forwardValueSha256 } from './lib/release-runtime-forward-child-protocol.mjs';
import { runForwardSupervisorChild, runForwardSupervisorPhase, persistVerifiedForwardTargetDefinitions, inspectForwardLiveWork, inspectForwardResumeEligibility } from './lib/release-runtime-forward-supervisor.mjs';
import { initializeFirstForwardOperation, completeFirstForwardRetirement } from './lib/release-runtime-forward-initialization.mjs';
import { recordForwardTargetHealth } from './lib/release-runtime-forward-receipts.mjs';
import { finalizeCommittedStartupAdmission } from './lib/release-runtime-startup-admission.mjs';
import { readPinnedForwardBytes, readPinnedForwardRecord } from './release-runtime-forward-child.mjs';
import { dispatchManagedRestartOperation, observeManagedInitiatingHelper, reconcileManagedOperatorLock } from './lib/release-runtime-managed-restart.mjs';
import { execFile } from 'node:child_process';
import { withCutoverStateLock } from './lib/release-runtime-cutover.mjs';
import { randomBytes } from 'node:crypto';
import { readForwardRootRecord } from './lib/release-runtime-forward-retirement.mjs';

function syncDirectory(directory) { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function takeOperatorLock(config) {
    const control = fs.lstatSync(config.controlRoot);
    if (!control.isDirectory() || control.isSymbolicLink() || control.uid !== 0 || (control.mode & 0o777) !== 0o700
        || fs.realpathSync(config.controlRoot) !== config.controlRoot) throw Error('forward_operator_control_unsafe');
    // No automatic stale-lock deletion: an orphaned authorized migration can still be running.
    const identity = inspectForwardChildIdentity(process.pid); const file = path.join(config.controlRoot, 'first-cutover.lock');
    const value = { schema: 'nassaj-cutover-lock/v1', pid: identity.pid, startTime: identity.startTicks };
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(config.controlRoot);
    return () => {
        const current = readForwardRootRecord(file);
        if (current.pid !== value.pid || current.startTime !== value.startTime) throw Error('forward_operator_lock_replaced');
        fs.unlinkSync(file); syncDirectory(config.controlRoot);
    };
}
function assertLocator(input, schema) {
    assertForwardFrameKeys(input, 'schema,operationId');
    if (input.schema !== schema || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(input.operationId || '')) throw Error('forward_operator_request_invalid');
}
async function waitForPrivateReceipt(config) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const state = readForwardRootRecord(path.join(config.controlRoot, 'startup-admission.json'));
        if (state.revocation || state.transitionReason || state.state !== 'switching') throw Error('forward_private_authority_lost');
        try { return await recordForwardTargetHealth(config, 'private'); } catch {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    throw Error('forward_private_health_deadline');
}
function openForwardGate(config, operationId) {
    const dispatcher = config.forwardActivation.dispatcher; readPinnedForwardBytes(dispatcher); readPinnedForwardBytes(config.forwardMigration.node);
    const state = readForwardRootRecord(path.join(config.controlRoot, 'startup-admission.json'));
    return new Promise((resolve, reject) => {
        const child = execFile(config.forwardMigration.node.path, [dispatcher.path, 'openFirstForwardGate'], { encoding: 'utf8', timeout: 30000,
            maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C' } }, (error, stdout) => {
            if (error) return reject(Error('forward_gate_open_unknown'));
            try { const result = JSON.parse(stdout); if (result.schema !== 'nassaj-first-forward-ingress-receipt/v1'
                || result.operationId !== operationId || result.phase !== 'opened') throw Error('forward_gate_receipt_invalid'); resolve(result); } catch (error) { reject(error); }
        });
        child.stdin.end(`${JSON.stringify({ schema: 'nassaj-first-forward-gate-request/v1', operationId, generationEpoch: state.generationEpoch })}\n`);
    });
}
function controlEntryExists(config, name) {
    try { fs.lstatSync(path.join(config.controlRoot, name)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
/** Compose only fresh approved activation; uncertain or interrupted stages require explicit reconciliation. */
export async function runPreparedForwardMigrationOperator(input) {
    if (process.geteuid?.() !== 0 || process.argv.length !== 2) throw Error('forward_operator_root_required');
    assertLocator(input, 'nassaj-forward-activation-operation/v1');
    const config = readForwardRootRecord('/etc/nassaj/release-runtime-host.json');
    if (['first-cutover.json', 'first-cutover.lock'].some(file => controlEntryExists(config, file))) throw Error('forward_explicit_reconciliation_required');
    // The fresh initializer produces its first admission/host records only after its journal.
    // Without that journal, ANY surviving record is partial/prior authority, not a pristine start.
    if (['startup-admission.json', 'host-dispatch-state.json'].some(file => controlEntryExists(config, file)))
        throw Error('forward_existing_control_requires_reconciliation');
    const approval = readForwardRootRecord(config.bootstrapClaim.approvalFile);
    verifyForwardOwner(config, { approvalSha256: forwardValueSha256(approval), approvalAcceptedAt: Date.now() });
    if (inspectForwardLiveWork(config).busy) return { schema: 'nassaj-forward-migration-operation-result/v1',
        operationId: input.operationId, phase: 'deferred', reason: 'live_work', maintenance: false };
    const release = takeOperatorLock(config); let completed = false;
    try {
        // No phase-jumping from fabricated retirement or an unresolved prior execution intent.
        const initial = await initializeFirstForwardOperation(config);
        if (initial.transactionId !== input.operationId) throw Error('forward_operator_locator_mismatch');
        const outcome = await finishForwardActivation(config, input.operationId, 'retirement_prepared');
        if (outcome.phase === 'deferred') { completed = true; return outcome; }
        const terminal = outcome;
        completed = true;
        return { schema: 'nassaj-forward-migration-operation-result/v1', operationId: input.operationId,
            phase: terminal.phase, revision: terminal.revision };
    } finally {
        // Preserve the actual lock as evidence whenever any effect/child state may be unresolved.
        if (completed) release();
    }
}
async function finishForwardActivation(config, operationId, entryPhase) {
    if (['retirement_prepared', 'supervisor_stop_deferred'].includes(entryPhase)) {
        const stopped = await runForwardSupervisorPhase(config, 'stop');
        if (stopped.phase === 'supervisor_stop_deferred') {
            return { schema: 'nassaj-forward-migration-operation-result/v1', operationId: operationId,
                phase: 'deferred', reason: 'live_work', maintenance: true };
        }
        await completeFirstForwardRetirement(config);
    }
    if (entryPhase === 'migration_observed') await observeForwardTargetForResume(config);
    else { await prepareForwardMigrationIntent(config); await runForwardMigrationChild(config); }
        await runForwardSupervisorPhase(config, 'start');
        await waitForPrivateReceipt(config);
        await persistVerifiedForwardTargetDefinitions(config);
        await openForwardGate(config, operationId);
        await recordForwardTargetHealth(config, 'public');
        finalizeCommittedStartupAdmission(config);
        const terminal = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.json'));
        if (terminal.state !== 'committed' || terminal.phase !== 'committed') throw Error('forward_terminal_missing');
    return terminal;
}

function persistResumeJournal(config, value) {
    const file = path.join(config.controlRoot, 'first-cutover.json'); const temporary = `${file}.partial-${randomBytes(12).toString('hex')}`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file); syncDirectory(config.controlRoot);
}
/** Explicit locator-only resume; existing locks always require separate governed reconciliation. */
export async function runResumedForwardOperator(input) {
    if (process.geteuid?.() !== 0) throw Error('forward_operator_root_required');
    assertLocator(input, 'nassaj-forward-activation-operation/v1');
    const config = readForwardRootRecord('/etc/nassaj/release-runtime-host.json');
    const eligibility = await inspectForwardResumeEligibility(config, input.operationId);
    const release = takeOperatorLock(config); let terminal = false;
    try {
        const after = await inspectForwardResumeEligibility(config, input.operationId);
        if (after.sha256 !== eligibility.sha256) throw Error('forward_resume_state_changed');
        withCutoverStateLock(config.controlRoot, () => {
            const journal = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.json'));
            const state = readForwardRootRecord(path.join(config.controlRoot, 'startup-admission.json'));
            const host = readForwardRootRecord(path.join(config.controlRoot, 'host-dispatch-state.json'));
            if (forwardValueSha256({ journal, state, host }) !== after.sha256) throw Error('forward_resume_cas');
            const actual = inspectForwardChildIdentity(process.pid);
            const operator = { pid: actual.pid, startTicks: actual.startTicks, bootId: actual.bootId };
            persistResumeJournal(config, { ...journal, revision: journal.revision + 1, operator,
                forwardResumeAuthorization: { phase: after.phase, operator, evidenceSha256: after.sha256 } });
        });
        const result = await finishForwardActivation(config, input.operationId, after.phase);
        terminal = result.phase === 'committed' || result.phase === 'deferred';
        return result.phase === 'deferred' ? result : { schema: 'nassaj-forward-migration-operation-result/v1',
            operationId: input.operationId, phase: result.phase, revision: result.revision };
    } finally { if (terminal) release(); }
}
function proveAbandonedForwardOwner(identity) {
    if (!identity || !Number.isSafeInteger(identity.pid) || typeof identity.startTicks !== 'string' || typeof identity.bootId !== 'string')
        throw Error('forward_abandoned_identity_missing');
    const observe = () => {
        try { const actual = inspectForwardChildIdentity(identity.pid);
            if (actual.bootId !== identity.bootId || actual.startTicks === identity.startTicks) throw Error('forward_abandoned_owner_unproven');
        } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    };
    observe(); observe();
}
function exclusiveDurable(file, bytes) {
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(path.dirname(file));
}
function assertTransferableObservation(config, journal, prepared, observedSha256) {
    const lease = journal.forwardObservationReconciliation;
    const actual = inspectForwardChildIdentity(process.pid);
    const now = Math.floor(Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000);
    if (forwardValueSha256(journal) !== observedSha256 || lease?.state !== 'observed'
        || lease.nonce !== prepared.nonce || lease.expiresAtBootMs !== prepared.expiresAtBootMs
        || !Number.isSafeInteger(lease.expiresAtBootMs) || now >= lease.expiresAtBootMs
        || lease.owner.pid !== actual.pid || lease.owner.startTicks !== actual.startTicks
        || lease.owner.bootId !== actual.bootId || !actual.uids.every(uid => uid === 0)
        || lease.hostStateSha256 !== forwardValueSha256(readForwardRootRecord(path.join(config.controlRoot, 'host-dispatch-state.json')))
        || lease.abandonedLockSha256 !== forwardValueSha256(fs.readFileSync(path.join(config.controlRoot, 'first-cutover.lock')).toString('base64'))
        || lease.originalOperatorSha256 !== forwardValueSha256(journal.operator)
        || lease.originalIntentSha256 !== forwardValueSha256(journal.forwardMigrationIntent)
        || lease.migrationResultSha256 !== forwardValueSha256(journal.forwardMigrationResult)
        || lease.resultSha256 !== forwardValueSha256(lease.result)) throw Error('forward_reconcile_observation_changed');
    proveAbandonedForwardOwner(lease.child);
    const request = readPinnedForwardRecord(config.forwardMigration.request);
    const info = fs.lstatSync(request.database.realpath, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || fs.realpathSync(request.database.realpath) !== request.database.realpath
        || String(info.dev) !== request.database.device || String(info.ino) !== request.database.inode
        || info.uid !== BigInt(config.forwardMigration.serviceIdentity.uid)
        || info.gid !== BigInt(config.forwardMigration.serviceIdentity.gid)) throw Error('forward_reconcile_database_changed');
}
/** Explicit reconciliation can observe the target read-only; it never executes A or a supervisor action. */
export async function runReconciledForwardOperator(input, deps = {}) {
    if (process.geteuid?.() !== 0) throw Error('forward_operator_root_required');
    assertLocator(input, 'nassaj-forward-activation-operation/v1');
    const config = readForwardRootRecord('/etc/nassaj/release-runtime-host.json');
    const file = path.join(config.controlRoot, 'first-cutover.lock');
    const originalJournal = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.json'));
    verifyForwardOwner(config, originalJournal);
    if (originalJournal.transactionId !== input.operationId) throw Error('forward_operator_locator_mismatch');
    let eligibility; let observation;
    try { eligibility = await inspectForwardResumeEligibility(config, input.operationId, deps.runtime); }
    catch { return { schema: 'nassaj-forward-lock-reconciliation/v1', operationId: input.operationId, decision: 'diagnosis_only' }; }
    if (eligibility.phase === 'migration_observed') {
        try {
            const childDeps = { retirement: deps.runtime?.retirement };
            const prepared = await prepareForwardObservationReconciliation(config, input.operationId, childDeps);
            const observed = await runForwardMigrationChild(config, 'observe-target', childDeps);
            if (observed.approvalAcceptedAt !== originalJournal.approvalAcceptedAt
                || observed.approvalSha256 !== originalJournal.approvalSha256) throw Error('forward_reconcile_approval_changed');
            observation = { prepared, sha256: forwardValueSha256(observed) };
            eligibility = await inspectForwardResumeEligibility(config, input.operationId, deps.runtime);
        } catch { return { schema: 'nassaj-forward-lock-reconciliation/v1', operationId: input.operationId, decision: 'diagnosis_only' }; }
    }
    try { return withCutoverStateLock(config.controlRoot, () => {
        const journal = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.json'));
        const state = readForwardRootRecord(path.join(config.controlRoot, 'startup-admission.json'));
        const host = readForwardRootRecord(path.join(config.controlRoot, 'host-dispatch-state.json'));
        if (forwardValueSha256({ journal, state, host }) !== eligibility.sha256) throw Error('forward_reconcile_cas');
        if (observation) assertTransferableObservation(config, journal, observation.prepared, observation.sha256);
        const lock = readForwardRootRecord(file); const bytes = fs.readFileSync(file);
        const observationOwner = observation ? assertForwardAbandonedObservationLock(config, journal, bytes) : null;
        const pending = journal.forwardLockReconciliation?.phase === 'intent' ? journal.forwardLockReconciliation : null;
        const prior = observationOwner || (pending && lock.pid === pending.operator.pid && lock.startTime === pending.operator.startTicks
            ? pending.operator : journal.operator);
        if (!prior || lock.pid !== prior.pid || lock.startTime !== prior.startTicks) throw Error('forward_reconcile_owner_mismatch');
        proveAbandonedForwardOwner(prior);
        for (const attempt of journal.forwardSupervisorAttempts) proveAbandonedForwardOwner(attempt.worker);
        if (journal.forwardChildAuthorization) proveAbandonedForwardOwner(journal.forwardChildAuthorization);
        const digest = forwardValueSha256(bytes.toString('base64'));
        if (pending) {
            const tombstone = path.join(config.controlRoot, pending.tombstone);
            if (path.basename(pending.tombstone) !== pending.tombstone
                || forwardValueSha256(fs.readFileSync(tombstone).toString('base64')) !== pending.priorLockSha256)
                throw Error('forward_reconcile_tombstone_changed');
        }
        const tombstone = `forward-lock-tombstone-${digest}.json`;
        try { exclusiveDurable(path.join(config.controlRoot, tombstone), bytes); }
        catch (error) { if (error.code !== 'EEXIST' || !fs.readFileSync(path.join(config.controlRoot, tombstone)).equals(bytes)) throw error; }
        const actual = inspectForwardChildIdentity(process.pid);
        const operator = { pid: actual.pid, startTicks: actual.startTicks, bootId: actual.bootId };
        const record = { phase: 'intent', operator, priorLockSha256: digest, tombstone, eligiblePhase: eligibility.phase };
        if (observation) record.observation = { nonce: observation.prepared.nonce,
            receiptSha256: forwardValueSha256(journal.forwardObservationReconciliation) };
        if (observation && pending) record.previousIntent = pending;
        persistResumeJournal(config, { ...journal, revision: journal.revision + 1, forwardLockReconciliation: record });
        if (!fs.readFileSync(file).equals(bytes)) throw Error('forward_reconcile_lock_changed');
        const replacement = `${file}.replacement-${randomBytes(12).toString('hex')}`;
        exclusiveDurable(replacement, JSON.stringify({ schema: 'nassaj-cutover-lock/v1', pid: operator.pid, startTime: operator.startTicks }));
        fs.renameSync(replacement, file); syncDirectory(config.controlRoot);
        persistResumeJournal(config, { ...journal, revision: journal.revision + 2, operator,
            forwardLockReconciliation: { ...record, phase: 'observed' } });
        // No execution effect ran. A later explicit resume obtains its own lock and re-observes before start.
        fs.unlinkSync(file); syncDirectory(config.controlRoot);
        return { schema: 'nassaj-forward-lock-reconciliation/v1', operationId: input.operationId, decision: 'reconciled' };
    }); } catch (error) {
        if (!observation) throw error;
        return { schema: 'nassaj-forward-lock-reconciliation/v1', operationId: input.operationId, decision: 'diagnosis_only' };
    }
}
/** Fixed managed root facade. Read-only helper actions never reacquire the operator's long lock. */
export async function runManagedOperator(action, input) {
    if (process.geteuid?.() !== 0) throw Error('forward_operator_root_required');
    assertLocator(input, 'nassaj-managed-restart-request/v1');
    const config = readForwardRootRecord('/etc/nassaj/release-runtime-host.json');
    if (action === 'reconcile') return reconcileManagedOperatorLock(config, input.operationId);
    if (!['restartCommittedGeneration', 'inspectManagedRestart', 'verifyManagedRestartPrivateReady'].includes(action)) throw Error('managed_operator_action');
    if (action !== 'restartCommittedGeneration') {
        const dispatcher = inspectForwardChildIdentity(process.ppid);
        readPinnedForwardBytes(config.managedRestart.dispatcher);
        if (!dispatcher.uids.every(uid => uid === 0)
            || fs.readFileSync(`/proc/${dispatcher.pid}/cmdline`).toString().split('\0')[1] !== config.managedRestart.dispatcher.path) throw Error('managed_dispatcher_identity');
        return dispatchManagedRestartOperation(config, action, input, { parentPid: dispatcher.parentPid });
    }
    const initiatingHelper = observeManagedInitiatingHelper(config, process.ppid);
    const release = takeOperatorLock(config); let terminal = false;
    try {
        const result = await dispatchManagedRestartOperation(config, action, input, { initiatingHelper });
        const journal = readForwardRootRecord(path.join(config.controlRoot, 'managed-restart.json'));
        terminal = journal.phase === 'committed' || (result.decision === 'deferred'
            && journal.attempts?.at(-1)?.state === 'resolved_no_effect');
        return result;
    } finally { if (terminal) release(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { if (process.argv.length === 5 && process.argv[2] === '--supervisor-child') {
            await runForwardSupervisorChild(process.argv[3], process.argv[4]);
        } else { const input = await readForwardPermitFrame(process.stdin);
        const result = process.argv.length === 4 && process.argv[2] === '--managed-operation' ? await runManagedOperator(process.argv[3], input)
            : process.argv.length === 3 && process.argv[2] === '--managed-reconcile' ? await runManagedOperator('reconcile', input)
            : process.argv.length === 3 && process.argv[2] === '--reconcile-forward' ? await runReconciledForwardOperator(input)
            : process.argv.length === 3 && process.argv[2] === '--resume-forward' ? await runResumedForwardOperator(input)
            : await runPreparedForwardMigrationOperator(input);
        process.stdout.write(`${JSON.stringify(result)}\n`); }
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 78; }
}
