/** Fixed safe-restart child stages. Root pins and records authority before service-UID supervisor effects. */
import fs from 'node:fs';
import { installForwardSavedDefinition } from './release-runtime-forward-saved-definitions.mjs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readPinnedForwardBytes } from '../release-runtime-forward-child.mjs';
import { withCutoverStateLock } from './release-runtime-cutover.mjs';
import { verifyForwardOwner } from './release-runtime-forward-parent.mjs';
import { readForwardRootRecord, verifyForwardRetirement } from './release-runtime-forward-retirement.mjs';
import { observePinnedPm2Runtime, observePinnedPm2PrivateRuntime, readPinnedPm2RuntimeMetadata } from './pm2-readonly-observer.mjs';
import { samplePm2Clock, applyPinnedPm2Operation, acknowledgePm2StepResult, closePm2PermitChannel, preparePm2TypedStep, verifyPm2OperationCompletion, verifyPm2PrivateDescriptor } from './pm2-typed-mutation.mjs';
import { observeForwardInhibitors } from './release-runtime-forward-retirement.mjs';
import { assertForwardFrameKeys, dropForwardChildPrivileges, inspectForwardChildIdentity, resolveForwardBashPath,
    assertForwardServiceIdentity, readForwardPermitFrame, forwardValueSha256 } from './release-runtime-forward-child-protocol.mjs';
function check(ok, reason) { if (!ok) throw Error(`forward_supervisor_${reason}`); }
function pinnedConfig(phase, operationId) {
    check(process.geteuid?.() === 0 && ['stop', 'start'].includes(phase)
        && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(operationId || ''), 'request_invalid');
    const config = readForwardRootRecord('/etc/nassaj/release-runtime-host.json');
    const journal = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.json'));
    verifyForwardOwner(config, journal);
    const settings = config.forwardActivation; const intent = journal.forwardSupervisorIntent;
    check(journal.state === 'running' && journal.phase === `supervisor_${phase}_intent` && journal.transactionId === operationId
        && intent?.schema === 'nassaj-forward-supervisor-intent/v1' && intent.phase === phase && intent.transactionId === operationId && /^[a-f0-9]{64}$/.test(intent.attemptNonce || '')
        && forwardValueSha256(journal.expected) === forwardValueSha256(config.expected)
        && forwardValueSha256(settings.supervisorPlan) === config.expected.supervisorPlanSha256
        && forwardValueSha256(settings.mutatorPlan) === config.expected.mutatorPlanSha256, 'intent_invalid');
    const parent = inspectForwardChildIdentity(process.ppid); const lock = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.lock'));
    check(lock.pid === parent.pid && lock.startTime === parent.startTicks && parent.uids.every(uid => uid === 0)
        && intent.operator.pid === parent.pid && intent.operator.startTicks === parent.startTicks && intent.operator.bootId === parent.bootId, 'operator_changed');
    for (const pin of [config.forwardMigration.node, config.forwardMigration.parent, settings.safeRestart]) readPinnedForwardBytes(pin);
    check(fs.realpathSync(process.execPath) === config.forwardMigration.node.path
        && process.argv[1] === config.forwardMigration.parent.path
        && fs.realpathSync(`/proc/${parent.pid}/exe`) === config.forwardMigration.node.path
        && fs.readFileSync(`/proc/${parent.pid}/cmdline`).toString().split('\0')[1] === config.forwardMigration.parent.path, 'executable_changed');
    const host = readForwardRootRecord(path.join(config.controlRoot, 'host-dispatch-state.json'));
    check(host.gateActive === true && !journal.forwardSupervisorAuthorization, 'gate_or_authorization_invalid');
    return { config, intent, parent, phase, operationId, metadata: readPinnedPm2RuntimeMetadata(settings.supervisorPlan.mutation.metadata) };
}
/** Read bounded live-work counters through the existing independently pinned read-only probe. */
export function inspectForwardLiveWork(config, deps = {}) {
    const probe = config.zeroWorkProbe;
    (deps.readPin || readPinnedForwardBytes)({ path: probe.file, sha256: probe.sha256 });
    check(Array.isArray(probe.args) && probe.args.every(arg => typeof arg === 'string')
        && Number.isSafeInteger(probe.timeoutMs) && probe.timeoutMs > 0 && probe.timeoutMs <= 30000, 'probe_config');
    let result;
    try { result = JSON.parse((deps.exec || execFileSync)(probe.file, probe.args, { encoding: 'utf8', timeout: probe.timeoutMs,
        maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C' } })); }
    catch { throw Error('forward_supervisor_probe_unknown'); }
    check(result && ['liveSessions', 'workflows', 'admittedTurns'].every(key => Number.isSafeInteger(result[key]) && result[key] >= 0), 'probe_counters_invalid');
    const counters = Object.fromEntries(['liveSessions', 'workflows', 'admittedTurns'].map(key => [key, result[key]]));
    return { busy: Object.values(counters).some(value => value !== 0), counters };
}

async function executePhase(material) {
    const plan = material.config.forwardActivation.supervisorPlan;
    const runtime = await observePinnedPm2Runtime(plan.pm2.observer);
    if (material.phase === 'stop') {
        const work = inspectForwardLiveWork(material.config);
        if (work.busy) return { schema: 'nassaj-forward-supervisor-deferred/v1', reason: 'live_work',
            counters: work.counters, observationSha256: runtime.observationSha256 };
    }
    const context = { attemptNonce: material.intent.attemptNonce, observer: plan.pm2.observer,
        slot: structuredClone(plan.mutation.oldSlot), targetDescriptor: plan.mutation.targetDescriptor,
        metadata: material.metadata, permitChannel: { requestFd: 5, responseFd: 6 } };
    const results = [];
    try {
        for (const step of (material.phase === 'stop' ? ['stop-old', 'delete-old'] : ['configure-target-stopped', 'start-target'])) {
            const expectedSlotDigest = step === 'configure-target-stopped'
                ? forwardValueSha256({ absent: true, name: context.targetDescriptor.name, namespace: context.targetDescriptor.namespace })
                : forwardValueSha256(context.slot.baseline);
            const result = await applyPinnedPm2Operation({ operationId: material.operationId, attemptId: material.intent.attemptId, step, expectedSlotDigest }, context);
            await acknowledgePm2StepResult(context, result); results.push(result);
        }
        const observed = await observePinnedPm2Runtime(plan.pm2.observer);
        check(material.phase !== 'stop' || observed.entries.every(entry => entry.name !== plan.slot.name || entry.namespace !== plan.slot.namespace), 'old_slot_present');
        return { observationSha256: observed.observationSha256, entries: observed.entries, steps: results,
            preflightObservationSha256: runtime.observationSha256 };
    } finally { closePm2PermitChannel(context); }
}
/** Enter only through the fixed safe-restart branch as root; no supervisor effect precedes the parent permit. */
export async function runForwardSupervisorChild(phase, operationId) {
    const material = pinnedConfig(phase, operationId);
    const identity = dropForwardChildPrivileges(material.config.forwardMigration.serviceIdentity);
    const ready = { schema: 'nassaj-forward-supervisor-ready/v1', transactionId: operationId, phase,
        attemptNonce: material.intent.attemptNonce, challenge: randomBytes(32).toString('hex'),
        pid: identity.pid, startTicks: identity.startTicks, bootId: identity.bootId,
        uid: material.config.forwardMigration.serviceIdentity.uid, gid: material.config.forwardMigration.serviceIdentity.gid,
        supplementaryGids: identity.supplementaryGids };
    const input = fs.createReadStream('', { fd: 3, autoClose: false }); const output = fs.createWriteStream('', { fd: 4, autoClose: false });
    try {
        output.write(`${JSON.stringify(ready)}\n`); const permit = await readForwardPermitFrame(input);
        assertForwardFrameKeys(permit, 'schema,transactionId,phase,attemptNonce,challenge,pid,startTicks,bootId,uid,gid,supplementaryGids,revision,decision');
        check(permit.schema === 'nassaj-forward-supervisor-permit/v1' && permit.decision === 'authorized'
            && Number.isSafeInteger(permit.revision) && permit.revision > 0
            && Object.keys(ready).filter(key => key !== 'schema').every(key => forwardValueSha256(ready[key]) === forwardValueSha256(permit[key]))
            && process.ppid === material.parent.pid, 'permit_invalid');
        assertForwardServiceIdentity(inspectForwardChildIdentity(process.pid), material.config.forwardMigration.serviceIdentity);
        const result = await executePhase(material);
        const frame = { schema: 'nassaj-forward-supervisor-result/v1', transactionId: operationId, phase,
            attemptNonce: ready.attemptNonce, challenge: ready.challenge, pid: ready.pid, startTicks: ready.startTicks, bootId: ready.bootId, result };
        const bytes = `${JSON.stringify(frame)}\n`; check(Buffer.byteLength(bytes) <= 16384, 'result_large');
        await new Promise((resolve, reject) => { output.once('error', reject); output.end(bytes, resolve); });
    } finally { input.destroy(); output.destroy(); }
}

/** Prepare one fixed supervisor attempt under the existing operator and state locks. */
export function prepareForwardSupervisorIntent(config, phase) {
    check(process.geteuid?.() === 0 && ['stop', 'start'].includes(phase), 'root_phase_required');
    return withCutoverStateLock(config.controlRoot, () => {
        const journal = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.json'));
        verifyForwardOwner(config, journal); const operator = inspectForwardChildIdentity(process.pid);
        const lock = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.lock'));
        check(lock.pid === operator.pid && lock.startTime === operator.startTicks, 'operator_lock_missing');
        const resumedStop = phase === 'stop' && journal.phase === 'supervisor_stop_deferred'
            && journal.forwardResumeAuthorization?.operator.pid === operator.pid
            && journal.forwardResumeAuthorization.operator.startTicks === operator.startTicks
            && journal.forwardResumeAuthorization.operator.bootId === operator.bootId;
        if (resumedStop) assertDeferredStopHistory(journal.forwardSupervisorAttempts);
        check(journal.state === 'running' && (resumedStop || journal.phase === (phase === 'stop' ? 'retirement_prepared' : 'migration_observed'))
            && !journal.forwardSupervisorIntent && !journal.forwardSupervisorAuthorization
            && Number.isSafeInteger(journal.revision) && journal.revision >= 0 && journal.revision < Number.MAX_SAFE_INTEGER, 'phase_already_used');
        const intent = { schema: 'nassaj-forward-supervisor-intent/v1', transactionId: journal.transactionId, phase,
            attemptId: randomBytes(16).toString('hex'), attemptNonce: randomBytes(32).toString('hex'), operator: { pid: operator.pid, startTicks: operator.startTicks, bootId: operator.bootId } };
        const attempts = journal.forwardSupervisorAttempts || []; check(attempts.length < 8, 'attempt_budget');
        persistSupervisor(config, { ...journal, phase: `supervisor_${phase}_intent`, revision: journal.revision + 1, forwardSupervisorIntent: intent,
            forwardSupervisorAttempts: [...attempts, { attemptId: intent.attemptId, attemptNonce: intent.attemptNonce, sequence: attempts.length + 1,
                worker: null, state: 'launch_intent', steps: [] }] });
        return intent;
    });
}
function persistSupervisor(config, value) {
    const file = path.join(config.controlRoot, 'first-cutover.json'); const temporary = `${file}.partial-${randomBytes(12).toString('hex')}`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file); const dir = fs.openSync(config.controlRoot, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function authorizeSupervisor(config, intent, child, ready) {
    assertForwardFrameKeys(ready, 'schema,transactionId,phase,attemptNonce,challenge,pid,startTicks,bootId,uid,gid,supplementaryGids');
    return withCutoverStateLock(config.controlRoot, () => {
        const journal = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.json')); verifyForwardOwner(config, journal);
        const actual = inspectForwardChildIdentity(child.pid); assertForwardServiceIdentity(actual, config.forwardMigration.serviceIdentity);
        check(ready.schema === 'nassaj-forward-supervisor-ready/v1' && /^[a-f0-9]{64}$/.test(ready.challenge || '')
            && ready.transactionId === intent.transactionId && ready.phase === intent.phase && ready.attemptNonce === intent.attemptNonce
            && actual.parentPid === process.pid && actual.pid === ready.pid && actual.startTicks === ready.startTicks && actual.bootId === ready.bootId
            && ready.uid === config.forwardMigration.serviceIdentity.uid && ready.gid === config.forwardMigration.serviceIdentity.gid
            && forwardValueSha256(ready.supplementaryGids) === forwardValueSha256(actual.supplementaryGids)
            && journal.phase === `supervisor_${intent.phase}_intent` && !journal.forwardSupervisorAuthorization
            && forwardValueSha256(journal.forwardSupervisorIntent) === forwardValueSha256(intent), 'ready_changed');
        const permit = { ...ready, schema: 'nassaj-forward-supervisor-permit/v1', decision: 'authorized', revision: journal.revision + 1 };
        check(Number.isSafeInteger(permit.revision), 'revision_invalid');
        let next = { ...journal, forwardSupervisorAttempts: journal.forwardSupervisorAttempts.map((value, index, array) => index === array.length - 1
            ? { ...value, worker: { pid: actual.pid, startTicks: actual.startTicks, bootId: actual.bootId }, state: 'running' } : value), revision: permit.revision, phase: `supervisor_${intent.phase}_authorized`, forwardSupervisorAuthorization: permit };
        if (intent.phase === 'start') {
            const actual = journal.forwardMigrationResult?.result; const identity = config.bootstrapClaim.identity;
            check(actual?.outcome === 'applied' && actual.databaseContractSha256 === identity.databaseContractSha256
                && actual.observedAfter?.schemaDigest === config.expected.targetSchemaDigest, 'target_schema_missing');
            next = { ...next, phase: 'supervisor_start_authorized',
                forwardReceipts: { ...journal.forwardReceipts, schema: { schema: 'nassaj-compatible-forward-schema/v1',
                    transactionId: journal.transactionId, targetSchemaDigest: actual.observedAfter.schemaDigest,
                    releaseIdentitySha256: identity.releaseIdentitySha256, databaseContractSha256: identity.databaseContractSha256,
                    databaseDev: identity.databaseDev, databaseIno: identity.databaseIno, observedAt: Date.now() } } };
        }
        persistSupervisor(config, next); return permit;
    });
}
function mutationSnapshot(config, intent, child) {
    const journal = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.json')); verifyForwardOwner(config, journal);
    const state = readForwardRootRecord(path.join(config.controlRoot, 'startup-admission.json'));
    const host = readForwardRootRecord(path.join(config.controlRoot, 'host-dispatch-state.json'));
    const lock = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.lock'));
    const actual = inspectForwardChildIdentity(child.pid); assertForwardServiceIdentity(actual, config.forwardMigration.serviceIdentity);
    const attempt = journal.forwardSupervisorAttempts?.at(-1);
    check(actual.parentPid === process.pid && attempt?.attemptId === intent.attemptId && attempt.attemptNonce === intent.attemptNonce
        && attempt.worker.pid === actual.pid && attempt.worker.startTicks === actual.startTicks && attempt.worker.bootId === actual.bootId
        && lock.pid === process.pid && lock.startTime === inspectForwardChildIdentity(process.pid).startTicks
        && state.state === 'switching' && !state.revocation && !state.transitionReason && !state.potentiallyRunningClaim
        && state.generationEpoch === journal.forwardAdmission.generationEpoch && host.gateActive === true,
    'mutation_authority_changed');
    return { journal, state, host, attempt, digest: forwardValueSha256({ journal, state, host }) };
}
function mutationCompareWrite(config, intent, child, before, change, allowClaimProgress = false) {
    return withCutoverStateLock(config.controlRoot, () => {
        const current = mutationSnapshot(config, intent, child);
        if (current.digest !== before.digest) {
            const stable = ['expected', 'approvalSha256', 'forwardAdmission', 'forwardSupervisorIntent', 'forwardSupervisorAuthorization',
                'forwardSupervisorAttempts', 'targetSlotBinding', 'initialStartWindow', 'initialTargetProcess'];
            const phases = ['startup_claim_pending', 'startup_claimed', 'startup_security_authorized', 'target_verified'];
            check(allowClaimProgress && stable.every(key => forwardValueSha256(current.journal[key]) === forwardValueSha256(before.journal[key]))
                && phases.includes(before.journal.phase) && phases.indexOf(current.journal.phase) >= phases.indexOf(before.journal.phase)
                && current.state.generationEpoch === before.state.generationEpoch, 'mutation_cas');
        }
        const next = change(current.journal); next.revision = current.journal.revision + 1;
        check(Number.isSafeInteger(next.revision), 'revision_invalid'); persistSupervisor(config, next); return next;
    });
}
function replaceAttempt(journal, patch) {
    return { ...journal, forwardSupervisorAttempts: journal.forwardSupervisorAttempts.map((value, index, array) => index === array.length - 1 ? { ...value, ...patch } : value) };
}
function rootClock() { return samplePm2Clock(); }
function bootClock() {
    const value = Number(fs.readFileSync('/proc/uptime', 'utf8').trim().split(/\s+/)[0]);
    check(Number.isFinite(value) && value >= 0, 'boot_clock_invalid');
    return { bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), nowMs: Math.floor(value * 1000) };
}
/** Root-owned fixed window is durable before the start permit; polling cannot renew it. */
export function makeInitialStartWindow(journal, intent, frame) {
    const clock = bootClock();
    return { transactionId: journal.transactionId, attemptId: intent.attemptId, attemptNonce: intent.attemptNonce,
        startRequestId: frame.requestId, startIntentSha256: forwardValueSha256(frame),
        targetSlotBindingSha256: forwardValueSha256(journal.targetSlotBinding), generationEpoch: journal.forwardAdmission.generationEpoch,
        bootId: clock.bootId, issuedAtBootMs: clock.nowMs, expiresAtBootMs: clock.nowMs + 30000 };
}
function assertInitialWindow(current, window) {
    const clock = bootClock();
    check(clock.bootId === window.bootId && clock.nowMs >= window.issuedAtBootMs && clock.nowMs < window.expiresAtBootMs
        && window.expiresAtBootMs === window.issuedAtBootMs + 30000
        && forwardValueSha256(current.journal.initialStartWindow) === forwardValueSha256(window)
        && current.journal.targetSlotBinding && forwardValueSha256(current.journal.targetSlotBinding) === window.targetSlotBindingSha256
        && current.state.generationEpoch === window.generationEpoch, 'initial_window_expired_or_changed');
}
/** Observe the actual allocated process independently of the PM2 callback, then CAS/fsync its admission binding. */
export async function armInitialProcess(config, intent, child, context, window, startClock, deps = {}) {
    for (;;) {
        const before = mutationSnapshot(config, intent, child); assertInitialWindow(before, window);
        check(before.journal.phase === 'target_start_intent' && before.journal.startupClaim?.state === 'awaiting_process'
            && !before.journal.initialTargetProcess && !before.state.initialTargetProcessSha256, 'initial_arm_phase');
        const observed = await (deps.observePrivateRuntime || observePinnedPm2PrivateRuntime)(context.observer);
        const binding = before.journal.targetSlotBinding;
        check(forwardValueSha256(context.targetDescriptor) === binding.targetDescriptorSha256, 'initial_descriptor_binding');
        const entries = observed.privateEntries.filter(entry => entry.pm_id === binding.allocatedPmId);
        check(entries.length === 1 && entries[0].pm2_env?.pm_id === binding.allocatedPmId, 'initial_arm_slot');
        const entry = entries[0]; const env = entry.pm2_env;
        check(env.name === context.targetDescriptor.name && env.namespace === context.targetDescriptor.namespace
            && forwardValueSha256(observed.observation.daemon) === binding.daemonIdentitySha256, 'initial_arm_identity');
        if (entry.pid === 0 && env.status === 'stopped') {
            check(forwardValueSha256(env) === binding.preparedEntrySha256, 'initial_prepared_drift');
            await new Promise(resolve => setTimeout(resolve, 100)); continue;
        }
        check(Number.isSafeInteger(entry.pid) && entry.pid > 0 && env.status === 'online', 'initial_process_unproven');
        const actual = inspectForwardChildIdentity(entry.pid); assertForwardServiceIdentity(actual, config.forwardMigration.serviceIdentity);
        check(actual.pid === entry.pid && actual.bootId === window.bootId
            && !(actual.pid === config.oldProcess.pid && actual.startTicks === (config.oldProcess.startTime ?? config.oldProcess.startTicks)), 'initial_old_process');
        const clock = rootClock();
        assertInitialWindow(mutationSnapshot(config, intent, child), window);
        verifyPm2PrivateDescriptor(env, context.targetDescriptor, 'online', { pmId: binding.allocatedPmId, uuid: context.slot.baseline.env.unique_id,
            pid: entry.pid, ...context.metadata, window: { wallBefore: startClock.wall, wallAfter: clock.wall,
                monotonicBefore: startClock.monotonic, monotonicAfter: clock.monotonic, bootBefore: startClock.boot, bootAfter: clock.boot } });
        const second = await (deps.observePrivateRuntime || observePinnedPm2PrivateRuntime)(context.observer);
        const secondEntry = second.privateEntries.find(value => value.pm_id === binding.allocatedPmId);
        check(secondEntry && secondEntry.pid === entry.pid && forwardValueSha256(secondEntry.pm2_env) === forwardValueSha256(env)
            && forwardValueSha256(second.observation.daemon) === binding.daemonIdentitySha256, 'initial_observation_changed');
        const again = inspectForwardChildIdentity(entry.pid); assertForwardServiceIdentity(again, config.forwardMigration.serviceIdentity);
        check(again.startTicks === actual.startTicks && again.bootId === actual.bootId, 'initial_process_changed');
        const receipt = { schema: 'nassaj-forward-initial-process/v1', ...Object.fromEntries(['transactionId', 'attemptId', 'attemptNonce',
            'startRequestId', 'startIntentSha256', 'targetSlotBindingSha256', 'generationEpoch', 'expiresAtBootMs'].map(key => [key, window[key]])),
            daemonIdentitySha256: binding.daemonIdentitySha256, namespaceSha256: binding.namespaceSha256, allocatedPmId: binding.allocatedPmId,
            targetDescriptorSha256: binding.targetDescriptorSha256, observationSha256: second.observation.observationSha256,
            process: { pid: actual.pid, startTicks: actual.startTicks, bootId: actual.bootId,
                uid: config.forwardMigration.serviceIdentity.uid, gid: config.forwardMigration.serviceIdentity.gid } };
        return withCutoverStateLock(config.controlRoot, () => {
            const current = mutationSnapshot(config, intent, child); assertInitialWindow(current, window);
            check(current.digest === before.digest, 'initial_arm_cas');
            const process = inspectForwardChildIdentity(entry.pid); assertForwardServiceIdentity(process, config.forwardMigration.serviceIdentity);
            check(process.startTicks === actual.startTicks && process.bootId === actual.bootId, 'initial_process_changed');
            const digest = forwardValueSha256(receipt);
            const next = { ...current.journal, phase: 'startup_claim_pending', initialTargetProcess: receipt,
                startupClaim: { state: 'pending', initialTargetProcessSha256: digest, startIntentSha256: window.startIntentSha256 }, revision: current.journal.revision + 1 };
            persistSupervisor(config, next);
            persistAdmission(config, { ...current.state, initialTargetProcessSha256: digest, revision: current.state.revision + 1 });
            return receipt;
        });
    }
}
function persistAdmission(config, state) {
    const file = path.join(config.controlRoot, 'startup-admission.json'); const temporary = `${file}.partial-${randomBytes(12).toString('hex')}`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file); const dir = fs.openSync(config.controlRoot, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
/** Root verifies private runtime and appends an independent durable record for each worker step. */
export function createSupervisorMutationHandler(config, intent, child, deps = {}) {
    const observePrivate = deps.observePrivateRuntime || observePinnedPm2PrivateRuntime;
    const observeInhibitors = deps.observeInhibitors || observeForwardInhibitors;
    const plan = config.forwardActivation.supervisorPlan; const pending = new Map(); let armPromise; let armFailure;
    const context = { attemptNonce: intent.attemptNonce, observer: plan.pm2.observer, slot: structuredClone(plan.mutation.oldSlot),
        targetDescriptor: plan.mutation.targetDescriptor, metadata: (deps.readMetadata || readPinnedPm2RuntimeMetadata)(plan.mutation.metadata) };
    const allowed = intent.phase === 'stop' ? ['stop-old', 'delete-old'] : ['configure-target-stopped', 'start-target'];
    const handler = async frame => {
        let current = mutationSnapshot(config, intent, child);
        if (frame.schema === 'nassaj-pm2-execution-intent/v1') {
            assertForwardFrameKeys(frame, 'schema,operationId,attemptId,attemptNonce,step,expectedSlotDigest,daemonIdentitySha256,slotDigest,payloadDigest,requestId');
            const steps = current.attempt.steps; const step = allowed[steps.length];
            check(frame.operationId === intent.transactionId && frame.attemptId === intent.attemptId && frame.attemptNonce === intent.attemptNonce
                && frame.step === step && /^[a-f0-9]{32}$/.test(frame.requestId) && steps.every(value => value.state === 'observed'), 'mutation_step_invalid');
            const before = await observePrivate(plan.pm2.observer);
            observeInhibitors(config.forwardActivation.mutatorPlan);
            const request = { operationId: frame.operationId, attemptId: frame.attemptId, step, expectedSlotDigest: frame.expectedSlotDigest };
            const derived = preparePm2TypedStep(request, context, before.privateEntries, before.observation.daemon);
            check(['slotDigest', 'payloadDigest', 'daemonIdentitySha256'].every(key => frame[key] === derived.intent[key]), 'mutation_private_digest');
            const clock = rootClock();
            deps.checkDeadline?.();
            const next = mutationCompareWrite(config, intent, child, current, journal => {
                let value = replaceAttempt(journal, { steps: [...steps, { step, state: 'possibly_sent', intent: frame, beforeClock: clock }] });
                if (step === 'start-target') {
                    check(journal.targetSlotBinding?.allocatedPmId === context.slot.pmId
                        && journal.targetSlotBinding.preparedEntrySha256 === forwardValueSha256(context.slot.baseline), 'derived_slot_missing');
                    value = { ...value, phase: 'target_start_intent', startupClaim: { state: 'awaiting_process' },
                        initialStartWindow: makeInitialStartWindow(journal, intent, frame) };
                }
                return value;
            });
            deps.checkDeadline?.();
            pending.set(step, { before, request, clock, intent: frame });
            return { ...frame, schema: 'nassaj-pm2-execution-ack/v1', decision: 'authorized', revision: next.revision };
        }
        assertForwardFrameKeys(frame, 'schema,operationId,attemptId,attemptNonce,step,requestId,dispatchState,observationSha256,slotDigest,targetSlotBinding');
        if (frame.step === 'start-target') { check(armPromise, 'initial_arm_not_started'); await armPromise; if (armFailure) throw armFailure; current = mutationSnapshot(config, intent, child); }
        const original = pending.get(frame.step); const recorded = current.attempt.steps.at(-1);
        check(frame.schema === 'nassaj-pm2-step-result/v1' && original && frame.operationId === intent.transactionId
            && frame.attemptId === intent.attemptId && frame.attemptNonce === intent.attemptNonce && frame.requestId === original.intent.requestId
            && frame.dispatchState === 'observed' && recorded?.state === 'possibly_sent', 'mutation_result_invalid');
        const after = await observePrivate(plan.pm2.observer); const clock = rootClock();
        const descriptor = ['stop-old', 'delete-old'].includes(frame.step) ? context.slot.baseline : context.targetDescriptor;
        const entry = after.privateEntries.find(value => value.pm2_env?.name === descriptor.name && value.pm2_env?.namespace === descriptor.namespace);
        let observedProcess;
        if (entry?.pid) { observedProcess = inspectForwardChildIdentity(entry.pid);
            check(observedProcess.pid === entry.pid && observedProcess.uids.every(uid => uid === config.forwardMigration.serviceIdentity.uid), 'result_kernel'); }
        if (['stop-old', 'delete-old'].includes(frame.step)) {
            try { const old = inspectForwardChildIdentity(context.slot.process.pid);
                check(old.startTicks !== context.slot.process.startTicks || old.bootId !== context.slot.process.bootId, 'old_still_alive'); }
            catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
        }
        observeInhibitors(config.forwardActivation.mutatorPlan);
        const window = { wallBefore: original.clock.wall, wallAfter: clock.wall, monotonicBefore: original.clock.monotonic,
            monotonicAfter: clock.monotonic, bootBefore: original.clock.boot, bootAfter: clock.boot };
        if (frame.step === 'start-target') check(current.journal.initialTargetProcess?.process.pid === entry?.pid
            && current.journal.initialTargetProcess.process.startTicks === observedProcess?.startTicks
            && current.journal.initialTargetProcess.process.bootId === observedProcess?.bootId, 'initial_result_process_changed');
        const verified = verifyPm2OperationCompletion(original.request, { ...context, executionIntent: original.intent, provisionalResult: frame, observedProcess }, original.before, after, window);
        check(verified.slotDigest === frame.slotDigest && forwardValueSha256(verified.targetSlotBinding) === forwardValueSha256(frame.targetSlotBinding), 'result_projection');
        deps.checkDeadline?.();
        const next = mutationCompareWrite(config, intent, child, current, journal => {
            let value = replaceAttempt(journal, { steps: [...current.attempt.steps.slice(0, -1), { ...recorded, state: 'observed', result: frame, rootWindow: window }] });
            if (verified.targetSlotBinding) value = { ...value, targetSlotBinding: verified.targetSlotBinding };
            return value;
        }, frame.step === 'start-target');
        deps.checkDeadline?.();
        if (verified.targetSlotBinding) {
            context.slot = { pmId: entry.pm_id, baseline: structuredClone(entry.pm2_env), descriptor: context.targetDescriptor, entrySha256: verified.slotDigest };
            context.targetSlotBinding = verified.targetSlotBinding;
        }
        pending.delete(frame.step);
        return { schema: 'nassaj-pm2-step-ack/v1', operationId: frame.operationId, attemptId: frame.attemptId, attemptNonce: frame.attemptNonce,
            step: frame.step, requestId: frame.requestId, resultSha256: forwardValueSha256(frame), decision: 'recorded', revision: next.revision };
    };
    handler.afterAcknowledgement = frame => {
        if (frame.schema !== 'nassaj-pm2-execution-intent/v1' || frame.step !== 'start-target') return;
        check(!armPromise, 'initial_arm_duplicate');
        const current = mutationSnapshot(config, intent, child);
        armPromise = armInitialProcess(config, intent, child, context, current.journal.initialStartWindow, pending.get(frame.step).clock, { observePrivateRuntime: observePrivate })
            .catch(error => { armFailure = error; });
    };
    return handler;
}
/** Bind the existing FD5/6 channel to the durable root handler, rejecting overlap and trailing frames. */
export function attachSupervisorMutationChannel(child, handler, onFailure, isStopped = () => false) {
    let busy = false; let buffer = ''; let failed = false;
    const fail = error => { if (!failed) { failed = true; onFailure(error); } };
    const read = async chunk => {
        if (failed || isStopped()) return;
        try {
            check(!busy, 'concurrent_mutation_frame'); buffer += chunk.toString();
            check(Buffer.byteLength(buffer) <= 16384, 'mutation_frame_large');
            if (!buffer.includes('\n')) return;
            check(buffer.indexOf('\n') === buffer.length - 1, 'mutation_frame_trailing');
            const frame = JSON.parse(buffer.slice(0, -1)); buffer = ''; busy = true;
            const ack = await handler(frame); check(!failed && !isStopped(), 'mutation_after_failure');
            child.stdio[6].write(`${JSON.stringify(ack)}\n`);
            handler.afterAcknowledgement(frame); busy = false;
        } catch (error) { fail(error); }
    };
    child.stdio[5].on('data', read); child.stdio[5].on('error', fail); child.stdio[6].on('error', fail);
    return () => { failed = true; child.stdio[5].off('data', read); child.stdio[5].off('error', fail); child.stdio[6].off('error', fail); };
}
/** Launch the approved safe-restart entry once, hold the operator boundary until the direct child exits. */
export async function runForwardSupervisorPhase(config, phase) {
    const bash = resolveForwardBashPath();
    check(config.forwardActivation.bash.path === bash, 'bash_pin_invalid');
    readPinnedForwardBytes(config.forwardActivation.bash);
    const script = config.forwardActivation.safeRestart; readPinnedForwardBytes(script);
    const intent = prepareForwardSupervisorIntent(config, phase);
    const child = spawn(bash, [script.path, '--first-forward-phase', phase, '--operation', intent.transactionId], {
        cwd: '/', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
    let ready; let result; let permit; let buffer = ''; let bytes = 0; let failure; let stopTimer;
    const deadline = performance.now() + 90000;
    const checkDeadline = () => check(!failure && performance.now() < deadline, 'deadline');
    const handleMutation = createSupervisorMutationHandler(config, intent, child, { checkDeadline });
    const timer = setTimeout(() => stop(Error('forward_supervisor_deadline')), Math.max(0, deadline - performance.now()));
    function stop(error) { if (failure) return; failure = error; child.kill('SIGTERM'); stopTimer = setTimeout(() => child.kill('SIGKILL'), 5000); }
    const detachMutation = attachSupervisorMutationChannel(child, handleMutation, stop, () => Boolean(failure));
    try {
        await new Promise((resolve, reject) => {
            child.on('error', error => child.pid ? stop(error) : reject(error));
            for (const output of [child.stdout, child.stderr]) output.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) stop(Error('forward_supervisor_output_limit')); });
            child.stdio[4].on('data', chunk => {
                if (failure) return;
                try {
                    buffer += chunk.toString(); check(Buffer.byteLength(buffer) <= 16384, 'frame_large');
                    if (!buffer.includes('\n')) return; check(buffer.indexOf('\n') === buffer.length - 1, 'frame_trailing');
                    const frame = JSON.parse(buffer.slice(0, -1)); buffer = '';
                    if (!ready) { permit = authorizeSupervisor(config, intent, child, frame); ready = frame; child.stdio[3].end(`${JSON.stringify(permit)}\n`); }
                    else { check(!result && frame.schema === 'nassaj-forward-supervisor-result/v1'
                        && ['transactionId', 'phase', 'attemptNonce', 'challenge', 'pid', 'startTicks', 'bootId'].every(key => frame[key] === ready[key]), 'result_changed'); result = frame; }
                } catch (error) { stop(error); }
            });
            child.on('close', (code, signal) => failure ? reject(failure) : code === 0 && !signal && result && !buffer ? resolve() : reject(Error('forward_supervisor_exit_uncertain')));
        });
        if (result.result?.schema === 'nassaj-forward-supervisor-deferred/v1')
            return recordForwardSupervisorDeferral(config, intent, permit, result);
        const observed = await observePinnedPm2Runtime(config.forwardActivation.supervisorPlan.pm2.observer);
        check(observed.observationSha256 === result.result?.observationSha256, 'completion_drift');
        return withCutoverStateLock(config.controlRoot, () => {
            const journal = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.json')); verifyForwardOwner(config, journal);
            check((phase === 'stop' ? journal.phase === 'supervisor_stop_authorized' && journal.revision >= permit.revision
                : ['startup_claim_pending', 'startup_claimed', 'startup_security_authorized', 'target_verified'].includes(journal.phase) && journal.revision >= permit.revision)
                && forwardValueSha256(journal.forwardSupervisorAuthorization) === forwardValueSha256(permit)
                && journal.forwardSupervisorAttempts.at(-1).steps.length === 2
                && journal.forwardSupervisorAttempts.at(-1).steps.every(step => step.state === 'observed'), 'completion_changed');
            const completed = { ...replaceAttempt(journal, { state: 'observed' }), phase: phase === 'stop' ? 'supervisor_stopped' : journal.phase, revision: journal.revision + 1,
                forwardSupervisorIntent: phase === 'stop' ? null : journal.forwardSupervisorIntent,
                forwardSupervisorAuthorization: phase === 'stop' ? null : journal.forwardSupervisorAuthorization,
                forwardSupervisorHistory: [...(journal.forwardSupervisorHistory || []), { intent, permit, result }] };
            persistSupervisor(config, completed); return completed;
        });
    } finally { detachMutation(); clearTimeout(timer); clearTimeout(stopTimer); for (const output of [child.stdout, child.stderr, child.stdio[3], child.stdio[4], child.stdio[5], child.stdio[6]]) output.destroy(); }
}

function targetDefinitionSnapshot(config) {
    const journal = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.json')); verifyForwardOwner(config, journal);
    const state = readForwardRootRecord(path.join(config.controlRoot, 'startup-admission.json'));
    const host = readForwardRootRecord(path.join(config.controlRoot, 'host-dispatch-state.json'));
    const lock = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.lock'));
    const operator = inspectForwardChildIdentity(process.pid);
    check(journal.phase === 'target_verified' && state.state === 'switching' && host.gateActive === true
        && !['revocation', 'transitionReason', 'potentiallyRunningClaim'].some(key => Object.hasOwn(state, key))
        && state.generationEpoch === journal.forwardAdmission.generationEpoch && lock.pid === process.pid && lock.startTime === operator.startTicks
        && journal.startupClaim?.claimId === state.lastClaim?.claimId && state.securityStartup?.claimId === state.lastClaim?.claimId
        && journal.forwardReceipts?.private?.claimId === state.lastClaim?.claimId, 'target_definition_authority');
    const actual = inspectForwardChildIdentity(state.lastClaim.pid); assertForwardServiceIdentity(actual, config.forwardMigration.serviceIdentity);
    check(actual.startTicks === state.lastClaim.startTicks && actual.bootId === state.lastClaim.bootId, 'target_definition_process');
    return { journal, state, host, actual, digest: forwardValueSha256({ journal, state, host }) };
}
/** Install the verified new target into every independently retired restore source before public ingress. */
export async function persistVerifiedForwardTargetDefinitions(config, deps = {}) {
    check((deps.effectiveUid?.() ?? process.geteuid()) === 0, 'target_definition_root');
    const before = targetDefinitionSnapshot(config); const plan = config.forwardActivation.supervisorPlan;
    check(forwardValueSha256(plan) === config.expected.supervisorPlanSha256
        && forwardValueSha256(config.forwardActivation.mutatorPlan) === config.expected.mutatorPlanSha256, 'target_definition_plan');
    const observed = await (deps.observePrivateRuntime || observePinnedPm2PrivateRuntime)(plan.pm2.observer);
    const binding = before.journal.targetSlotBinding;
    const entries = observed.privateEntries.filter(entry => entry.pm_id === binding?.allocatedPmId);
    check(entries.length === 1 && entries[0].pm2_env.pm_id === binding.allocatedPmId && entries[0].pid === before.actual.pid
        && forwardValueSha256(observed.observation.daemon) === binding.daemonIdentitySha256, 'target_definition_slot');
    const target = entries[0].pm2_env; const attempt = before.journal.forwardSupervisorAttempts.at(-1);
    const prepare = attempt.steps.find(step => step.step === 'configure-target-stopped');
    const start = attempt.steps.find(step => step.step === 'start-target');
    check(prepare?.state === 'observed' && start?.state === 'observed'
        && forwardValueSha256(prepare.result.targetSlotBinding) === forwardValueSha256(binding), 'target_definition_steps');
    const metadata = (deps.readMetadata || readPinnedPm2RuntimeMetadata)(plan.mutation.metadata);
    verifyPm2PrivateDescriptor(target, plan.mutation.targetDescriptor, 'online', { pmId: binding.allocatedPmId,
        uuid: target.env.unique_id, pid: before.actual.pid, ...metadata, window: start.rootWindow });
    check(forwardValueSha256(target) === start.result.slotDigest, 'target_definition_private_changed');
    (deps.observeInhibitors || observeForwardInhibitors)(config.forwardActivation.mutatorPlan);
    return withCutoverStateLock(config.controlRoot, () => {
        let current = targetDefinitionSnapshot(config);
        check(current.digest === before.digest && !current.journal.forwardTargetDefinitions, 'target_definition_cas');
        let journal = { ...current.journal, revision: current.journal.revision + 1,
            forwardTargetDefinitions: { state: 'writing', sourceReceipts: [], targetSnapshotSha256: forwardValueSha256(target) } };
        persistSupervisor(config, journal);
        for (const source of plan.sources) {
            const retired = journal.forwardRetirement.sources.find(record => record.sourceId === source.sourceId);
            check(retired?.durable === true && retired.oldTargetAbsent === true && retired.path === source.path && retired.format === source.format, 'target_definition_retirement');
            journal = { ...journal, revision: journal.revision + 1, forwardTargetDefinitions: { ...journal.forwardTargetDefinitions,
                currentIntent: { sourceId: source.sourceId, beforeSha256: retired.afterSha256 } } };
            persistSupervisor(config, journal);
            const receipt = installForwardSavedDefinition({ ...source, beforeSha256: retired.afterSha256 }, plan.slot, target);
            journal = { ...journal, revision: journal.revision + 1, forwardTargetDefinitions: { ...journal.forwardTargetDefinitions,
                currentIntent: null, sourceReceipts: [...journal.forwardTargetDefinitions.sourceReceipts, receipt] } };
            persistSupervisor(config, journal);
        }
        journal = { ...journal, revision: journal.revision + 1, forwardTargetDefinitions: { ...journal.forwardTargetDefinitions, state: 'durable' } };
        persistSupervisor(config, journal); return journal.forwardTargetDefinitions;
    });
}

function assertProcessGone(identity, inspect = inspectForwardChildIdentity) {
    check(identity && Number.isSafeInteger(identity.pid) && identity.pid > 0 && typeof identity.startTicks === 'string' && typeof identity.bootId === 'string', 'death_identity_missing');
    try { const current = inspect(identity.pid);
        check(current.bootId === identity.bootId && current.startTicks !== identity.startTicks, 'process_not_proven_dead'); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
}
/** Check the complete retained stop history; a fresh last attempt cannot erase older effects. */
function assertDeferredStopHistory(attempts, inspectProcess, requireAllDeferred = false) {
    check(Array.isArray(attempts) && attempts.length > 0 && attempts.length <= 8, 'deferred_history');
    const ids = new Set(); const nonces = new Set();
    for (const [index, attempt] of attempts.entries()) {
        check(typeof attempt.attemptId === 'string' && !ids.has(attempt.attemptId)
            && typeof attempt.attemptNonce === 'string' && !nonces.has(attempt.attemptNonce)
            && Array.isArray(attempt.steps) && attempt.steps.length === 0, 'deferred_history');
        ids.add(attempt.attemptId); nonces.add(attempt.attemptNonce);
        if (requireAllDeferred || index !== attempts.length - 1) {
            const previous = attempt.deferredResult;
            check(attempt.state === 'deferred' && previous?.schema === 'nassaj-forward-supervisor-result/v1'
                && previous.phase === 'stop' && previous.attemptNonce === attempt.attemptNonce
                && previous.pid === attempt.worker?.pid && previous.startTicks === attempt.worker.startTicks
                && previous.bootId === attempt.worker.bootId
                && previous.result?.schema === 'nassaj-forward-supervisor-deferred/v1'
                && previous.result.reason === 'live_work', 'deferred_history');
            assertDeferredResult(previous);
        }
        assertProcessGone(attempt.worker, inspectProcess);
    }
}
function assertDeferredResult(result) {
    assertForwardFrameKeys(result.result, 'schema,reason,counters,observationSha256');
    assertForwardFrameKeys(result.result.counters, 'liveSessions,workflows,admittedTurns');
    const counters = Object.values(result.result.counters);
    check(result.result.schema === 'nassaj-forward-supervisor-deferred/v1' && result.result.reason === 'live_work'
        && counters.every(value => Number.isSafeInteger(value) && value >= 0) && counters.some(value => value > 0)
        && /^[a-f0-9]{64}$/.test(result.result.observationSha256 || ''), 'deferred_result');
}
/** Persist a late busy result only after the normal supervisor channel has closed and kernel death is proven. */
export async function recordForwardSupervisorDeferral(config, intent, permit, result, deps = {}) {
    check(intent.phase === 'stop', 'deferred_phase');
    assertDeferredResult(result);
    const read = () => {
        const journal = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.json')); verifyForwardOwner(config, journal);
        const state = readForwardRootRecord(path.join(config.controlRoot, 'startup-admission.json'));
        const host = readForwardRootRecord(path.join(config.controlRoot, 'host-dispatch-state.json'));
        const lock = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.lock'));
        const operator = inspectForwardChildIdentity(process.pid); const attempt = journal.forwardSupervisorAttempts?.at(-1);
        check(lock.pid === operator.pid && lock.startTime === operator.startTicks && journal.phase === 'supervisor_stop_authorized'
            && forwardValueSha256(journal.expected) === forwardValueSha256(config.expected)
            && forwardValueSha256(journal.forwardSupervisorIntent) === forwardValueSha256(intent)
            && forwardValueSha256(journal.forwardSupervisorAuthorization) === forwardValueSha256(permit)
            && attempt?.attemptId === intent.attemptId && attempt.attemptNonce === intent.attemptNonce && attempt.steps.length === 0
            && ['transactionId', 'phase', 'attemptNonce', 'challenge', 'pid', 'startTicks', 'bootId'].every(key => result[key] === permit[key])
            && attempt.worker.pid === result.pid && attempt.worker.startTicks === result.startTicks && attempt.worker.bootId === result.bootId
            && state.state === 'switching' && state.generationEpoch === journal.forwardAdmission.generationEpoch && host.gateActive === true
            && state.revision === journal.forwardAdmission.revision && forwardValueSha256(state) === journal.forwardAdmission.sha256
            && !['initialStartWindow', 'initialTargetProcess', 'targetSlotBinding', 'forwardMigrationIntent', 'forwardChildAuthorization'].some(key => journal[key])
            && !state.lastClaim && !state.managedOperationId
            && !['revocation', 'transitionReason', 'potentiallyRunningClaim'].some(key => Object.hasOwn(state, key)), 'deferred_authority');
        check(!journal.forwardSupervisorHistory || (Array.isArray(journal.forwardSupervisorHistory) && journal.forwardSupervisorHistory.length === 0), 'deferred_history');
        assertDeferredStopHistory(journal.forwardSupervisorAttempts, deps.inspectProcess); return { journal, state, host, digest: forwardValueSha256({ journal, state, host }) };
    };
    const before = read();
    const plan = config.forwardActivation.supervisorPlan;
    const runtime = await (deps.observePrivateRuntime || observePinnedPm2PrivateRuntime)(plan.pm2.observer);
    preparePm2TypedStep({ operationId: intent.transactionId, attemptId: intent.attemptId, step: 'stop-old', expectedSlotDigest: plan.mutation.oldSlot.entrySha256 },
        { attemptNonce: intent.attemptNonce, slot: plan.mutation.oldSlot }, runtime.privateEntries, runtime.observation.daemon);
    const old = plan.mutation.oldSlot;
    const actual = inspectForwardChildIdentity(old.process.pid);
    assertForwardServiceIdentity(actual, config.forwardMigration.serviceIdentity);
    check(actual.startTicks === old.process.startTicks && actual.bootId === old.process.bootId
        && runtime.privateEntries.find(entry => entry.pm_id === old.pmId)?.pid === actual.pid, 'deferred_old_process');
    (deps.observeInhibitors || observeForwardInhibitors)(config.forwardActivation.mutatorPlan);
    return withCutoverStateLock(config.controlRoot, () => {
        const current = read(); check(current.digest === before.digest, 'deferred_cas');
        const again = inspectForwardChildIdentity(actual.pid);
        assertForwardServiceIdentity(again, config.forwardMigration.serviceIdentity);
        check(again.startTicks === actual.startTicks && again.bootId === actual.bootId, 'deferred_old_process');
        const next = { ...replaceAttempt(current.journal, { state: 'deferred', deferredResult: result }), phase: 'supervisor_stop_deferred',
            disposition: 'deferred-with-maintenance', revision: current.journal.revision + 1,
            forwardSupervisorIntent: null, forwardSupervisorAuthorization: null,
            forwardSupervisorDeferral: { attemptId: intent.attemptId, attemptNonce: intent.attemptNonce,
                resultSha256: forwardValueSha256(result), maintenance: true } };
        persistSupervisor(config, next); return next;
    });
}

function assertObservedStopHistory(journal, attempt) {
    check(attempt.steps.length === 2 && attempt.steps[0].step === 'stop-old' && attempt.steps[1].step === 'delete-old', 'resume_stop_history');
    for (const step of attempt.steps) {
        const intent = step.intent; const result = step.result;
        check(intent?.schema === 'nassaj-pm2-execution-intent/v1' && result?.schema === 'nassaj-pm2-step-result/v1'
            && intent.operationId === journal.transactionId && intent.attemptId === attempt.attemptId && intent.attemptNonce === attempt.attemptNonce
            && ['operationId', 'attemptId', 'attemptNonce', 'step', 'requestId'].every(key => intent[key] === result[key])
            && result.step === step.step && result.dispatchState === 'observed' && step.rootWindow
            && step.rootWindow.bootBefore === attempt.worker.bootId && step.rootWindow.bootAfter === attempt.worker.bootId,
        'resume_stop_receipt');
    }
    const history = (journal.forwardSupervisorHistory || []).filter(item => item.intent?.attemptId === attempt.attemptId);
    check(history.length === 1 && history[0].intent.phase === 'stop' && history[0].intent.attemptNonce === attempt.attemptNonce
        && history[0].permit.pid === attempt.worker.pid && history[0].permit.startTicks === attempt.worker.startTicks
        && history[0].permit.bootId === attempt.worker.bootId
        && forwardValueSha256(history[0].result.result.steps) === forwardValueSha256(attempt.steps.map(step => step.result)), 'resume_stop_history');
}
/** Require complete resolved supervisor history before any resume or diagnostic lease. */
export function assertForwardResolvedSupervisorHistory(journal, inspectProcess) {
    check(!journal.forwardSupervisorIntent && !journal.forwardSupervisorAuthorization, 'resume_unresolved_intent');
    const attempts = journal.forwardSupervisorAttempts;
    check(Array.isArray(attempts) && attempts.length > 0 && attempts.length < 8, 'attempt_budget');
    const ids = new Set(); const nonces = new Set();
    for (const attempt of attempts) {
        check(typeof attempt.attemptId === 'string' && !ids.has(attempt.attemptId)
            && typeof attempt.attemptNonce === 'string' && !nonces.has(attempt.attemptNonce), 'resume_duplicate_attempt');
        ids.add(attempt.attemptId); nonces.add(attempt.attemptNonce);
        check(Array.isArray(attempt.steps) && attempt.steps.every(step => step.state === 'observed')
            && ['observed', 'deferred'].includes(attempt.state), 'resume_unresolved_attempt');
        assertProcessGone(attempt.worker, inspectProcess);
        if (attempt.state === 'observed') assertObservedStopHistory(journal, attempt);
        else assertDeferredStopHistory([attempt], inspectProcess, true);
    }
    check((journal.forwardSupervisorHistory || []).length === attempts.filter(attempt => attempt.state === 'observed').length, 'resume_extra_history');
}
/** Classify only the three explicitly resumable first-forward phases using current root evidence. */
export async function inspectForwardResumeEligibility(config, operationId, deps = {}) {
    const read = () => {
        const journal = readForwardRootRecord(path.join(config.controlRoot, 'first-cutover.json')); verifyForwardOwner(config, journal);
        const state = readForwardRootRecord(path.join(config.controlRoot, 'startup-admission.json'));
        const host = readForwardRootRecord(path.join(config.controlRoot, 'host-dispatch-state.json'));
        check(journal.transactionId === operationId && journal.state === 'running'
            && forwardValueSha256(journal.expected) === forwardValueSha256(config.expected)
            && ['supervisor_stop_deferred', 'retirement_verified', 'migration_observed'].includes(journal.phase)
            && state.state === 'switching' && state.generationEpoch === journal.forwardAdmission?.generationEpoch
            && state.revision === journal.forwardAdmission.revision && forwardValueSha256(state) === journal.forwardAdmission.sha256
            && host.gateActive === true && !state.lastClaim && !state.managedOperationId
            && !['revocation', 'transitionReason', 'potentiallyRunningClaim'].some(key => Object.hasOwn(state, key))
            && !journal.initialStartWindow && !journal.initialTargetProcess && !journal.targetSlotBinding
            && !journal.forwardSupervisorIntent && !journal.forwardSupervisorAuthorization
            && !journal.forwardObservationIntent && !journal.forwardObservationAuthorization && !journal.forwardTargetObservation,
        'resume_diagnosis_only');
        assertForwardResolvedSupervisorHistory(journal, deps.inspectProcess);
        const attempts = journal.forwardSupervisorAttempts;
        if (journal.phase !== 'migration_observed') check(!journal.forwardMigrationIntent && !journal.forwardChildAuthorization
            && !journal.forwardMigrationResult, 'resume_hidden_migration');
        if (journal.phase === 'supervisor_stop_deferred') {
            assertDeferredStopHistory(attempts, deps.inspectProcess);
            const last = attempts.at(-1);
            check(!journal.forwardSupervisorHistory?.length && last.state === 'deferred'
                && journal.forwardSupervisorDeferral?.attemptId === last.attemptId
                && journal.forwardSupervisorDeferral.resultSha256 === forwardValueSha256(last.deferredResult), 'resume_deferred_proof');
        } else check(journal.forwardRetirement && !journal.forwardTargetDefinitions, 'resume_retirement_missing');
        return { journal, state, host, sha256: forwardValueSha256({ journal, state, host }) };
    };
    const before = read();
    if (before.journal.phase === 'supervisor_stop_deferred') {
        const plan = config.forwardActivation.supervisorPlan; const old = plan.mutation.oldSlot;
        const runtime = await (deps.observePrivateRuntime || observePinnedPm2PrivateRuntime)(plan.pm2.observer);
        preparePm2TypedStep({ operationId, attemptId: before.journal.forwardSupervisorAttempts.at(-1).attemptId,
            step: 'stop-old', expectedSlotDigest: old.entrySha256 }, { attemptNonce: before.journal.forwardSupervisorAttempts.at(-1).attemptNonce,
            slot: old }, runtime.privateEntries, runtime.observation.daemon);
        const actual = inspectForwardChildIdentity(old.process.pid); assertForwardServiceIdentity(actual, config.forwardMigration.serviceIdentity);
        check(actual.startTicks === old.process.startTicks && actual.bootId === old.process.bootId
            && runtime.privateEntries.find(entry => entry.pm_id === old.pmId)?.pid === actual.pid, 'resume_old_process');
        (deps.observeInhibitors || observeForwardInhibitors)(config.forwardActivation.mutatorPlan);
    } else await verifyForwardRetirement(config, before.journal, deps.retirement);
    return withCutoverStateLock(config.controlRoot, () => {
        const after = read(); check(after.sha256 === before.sha256, 'resume_cas');
        return { phase: after.journal.phase, sha256: after.sha256 };
    });
}
