/** Root-only managed-restart evidence primitives. These functions do not grant startup or stop a process. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { withCutoverStateLock } from './release-runtime-cutover.mjs';
import * as admission from './release-runtime-startup-admission.mjs';
import { observePinnedPm2Runtime, observePinnedPm2PrivateRuntime, readPinnedPm2RuntimeMetadata } from './pm2-readonly-observer.mjs';
import { verifyPm2LegacySnapshot, verifyPm2UnrelatedEntries } from './pm2-typed-mutation.mjs';
import { observeBoundTargetHealth } from './release-runtime-forward-receipts.mjs';
import { readManagedRootFile, readVerifiedManagedRestart, readVerifiedManagedTerminal, verifyManagedRestartApproval, verifyManagedRestartExecutable } from './release-runtime-managed-admission.mjs';
import { createHash } from 'node:crypto';
import { inspectForwardChildIdentity, assertForwardServiceIdentity, readForwardPermitFrame, assertForwardFrameKeys } from './release-runtime-forward-child-protocol.mjs';

const ACTIONS = Object.freeze(['inspectManagedRestart', 'claimManagedRestartExecution',
    'verifyManagedRestartPrivateReady', 'restartCommittedGeneration']);
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const sha = value => createHash('sha256').update(value).digest('hex');
function deny(reason) { throw Error(`managed_restart_${reason}`); }
function exact(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== keys.split(',').sort().join(',')) deny('fields_invalid');
}
/** Validate the fixed locator-only request before reading private state or running any command. */
export function validateManagedRestartRequest(action, request) {
    exact(request, 'schema,operationId');
    if (!ACTIONS.includes(action) || request.schema !== 'nassaj-managed-restart-request/v1'
        || !ID.test(request.operationId || '')) deny('request_invalid');
    return request.operationId;
}
export { verifyManagedRestartApproval } from './release-runtime-managed-admission.mjs';
/** Require one exact PM2 slot and bind its actual kernel process; PM2 command PID is never the server identity. */
export function observeManagedRestartSlot(settings, entries, inspect = inspectForwardChildIdentity) {
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry !== 'object' || !entry.pm2_env)) deny('pm2_inventory_invalid');
    const named = entries.filter(entry => entry.name === settings.processName);
    const numbered = entries.filter(entry => entry.pm_id === settings.pm2Id);
    if (named.length !== 1 || numbered.length !== 1 || named[0] !== numbered[0]) deny('pm2_slot_ambiguous');
    const slot = named[0]; const env = slot.pm2_env;
    if (env.namespace !== settings.pm2Namespace || env.status !== 'online' || env.pm_cwd !== settings.expectedPm2Cwd
        || env.exec_interpreter !== settings.nodeExecutable || !Number.isSafeInteger(slot.pid) || slot.pid <= 0) deny('pm2_slot_drift');
    const process = inspect(slot.pid);
    if (process.pid !== slot.pid || !/^[0-9]+$/.test(process.startTicks || '') || !process.bootId
        || process.state === 'Z' || process.state === 'X') deny('pm2_process_invalid');
    return Object.freeze({ pm2Id: settings.pm2Id, pm2Namespace: settings.pm2Namespace, processName: settings.processName, process });
}

function observedProcess(pid) {
    const first = inspectForwardChildIdentity(pid);
    const executable = fs.realpathSync(`/proc/${pid}/exe`);
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0');
    if (argv.at(-1) === '') argv.pop();
    if (canonical(first) !== canonical(inspectForwardChildIdentity(pid))) deny('ancestry_raced');
    return { ...first, executable, argv };
}
function sameProcess(left, right) {
    return left.pid === right.pid && left.startTicks === right.startTicks && left.bootId === right.bootId;
}
/** Bind the dispatcher sudo ancestry to the root-recorded launch and held operator lock; never accept a request PID. */
export function observeManagedRestartCaller(config, operationId, launch, operator, lock, deps = {}) {
    const settings = config.managedRestart; const inspect = deps.inspect || observedProcess;
    const walk = () => {
        let record = inspect(deps.parentPid ?? process.ppid); const records = [];
        for (let count = 0; count < 3 && record.executable === config.bootstrapClaim.sudoExecutable; count++) {
            if (record.uids[1] !== 0) deny('sudo_ancestry_invalid');
            records.push(record); record = inspect(record.parentPid);
        }
        if (!records.length) deny('sudo_ancestry_missing');
        const caller = record;
        for (let count = 0; count < 4; count++) {
            if (!record.uids.every(uid => uid === config.bootstrapClaim.applicationUid)) deny('script_uid_invalid');
            const executableScript = record.executable === settings.nodeExecutable ? (record.argv[1] === settings.wrapper.path ? settings.wrapper.path : settings.managedClientPath)
                : record.executable === settings.bashPath ? settings.safeRestartPath : null;
            if (!executableScript || record.argv[1] !== executableScript
                || (executableScript === settings.wrapper.path ? (record.argv.length !== 2 || !sameProcess(record, launch)) : !record.argv.includes(operationId))) deny('script_ancestry_invalid');
            records.push(record);
            if (sameProcess(record, launch)) break;
            record = inspect(record.parentPid);
        }
        if (!sameProcess(records.at(-1), launch)) deny('launch_ancestry_missing');
        const parent = inspect(records.at(-1).parentPid);
        if (!sameProcess(parent, operator) || !parent.uids.every(uid => uid === 0)
            || lock.pid !== parent.pid || lock.startTime !== parent.startTicks) deny('operator_lock_mismatch');
        records.push(parent); return { records, caller };
    };
    const first = walk(); if (canonical(first) !== canonical(walk())) deny('ancestry_raced');
    return Object.freeze(first.caller);
}
/** Derive the initiating service helper from the actual pinned dispatcher and sudo ancestry. */
export function observeManagedInitiatingHelper(config,dispatcherPid,deps={}) {
    if(dispatcherPid!==(deps.parentPid??process.ppid))deny('initiating_parent_invalid');
    const inspect=deps.inspect||observedProcess;const settings=config.managedRestart;
    const capture=()=>{
        const dispatcher=inspect(dispatcherPid);
        if(!dispatcher.uids.every(uid=>uid===0)||dispatcher.executable!==settings.nodeExecutable
            ||dispatcher.argv[1]!==settings.dispatcher.path)deny('initiating_dispatcher_invalid');
        let caller=inspect(dispatcher.parentPid);let count=0;const rows=[dispatcher];
        while(caller.executable===config.bootstrapClaim.sudoExecutable&&count<3){
            if(caller.uids[1]!==0)deny('initiating_sudo_invalid');
            rows.push(caller);caller=inspect(caller.parentPid);count++;
        }
        if(!count||caller.executable!==settings.nodeExecutable||caller.argv[1]!==settings.managedClientPath)deny('initiating_helper_invalid');
        assertForwardServiceIdentity(caller,settings.serviceIdentity);rows.push(caller);
        return {rows,helper:asService(caller,config)};
    };
    const first=capture();if(canonical(first)!==canonical(capture()))deny('initiating_ancestry_raced');
    return first.helper;
}
export { verifyManagedRestartExecutable } from './release-runtime-managed-admission.mjs';

function readJson(config, name, deps) { return JSON.parse((deps.readRootFile || readManagedRootFile)(path.join(config.controlRoot, name), deps.ownerUid ?? 0)); }
function atomicJournal(config, value) {
    const file = path.join(config.controlRoot, 'managed-restart.json'); const temporary = `${file}.partial-${randomBytes(12).toString('hex')}`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file); const dir = fs.openSync(config.controlRoot, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function change(config, operationId, revision, update, deps) {
    return withCutoverStateLock(config.controlRoot, () => {
        const current = readVerifiedManagedRestart(config, operationId, deps);
        if (current.revision !== revision || current.revision >= Number.MAX_SAFE_INTEGER) deny('journal_cas_lost');
        const next = { ...current, ...update(current), revision: current.revision + 1 };
        (deps.writeJournal || atomicJournal)(config, next); return next;
    });
}
function current(config, operationId, deps) { return readVerifiedManagedRestart(config, operationId, deps); }
function lockOwner(config, deps) {
    const operator = (deps.inspect || inspectForwardChildIdentity)(deps.pid ?? process.pid);
    const lock = readJson(config, 'first-cutover.lock', deps);
    if (!operator.uids.every(uid => uid === 0) || lock.pid !== operator.pid || lock.startTime !== operator.startTicks) deny('operator_lock_missing');
    return { pid: operator.pid, startTicks: operator.startTicks, bootId: operator.bootId };
}
function durableExclusive(file, bytes) {
    const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
}
function observedDeath(identity,inspect) {
    const once=()=>{try{return sameProcess(inspect(identity.pid),identity)?'alive':'gone';}
        catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return 'gone';return 'unknown';}};
    const first=once();return once()===first?first:'unknown';
}
/** Explicit abandoned-owner reconciliation preserves a tombstone and blocks all uncertain worker effects. */
export function reconcileManagedOperatorLock(config,operationId,deps={}) {
    if((deps.effectiveUid?.()??process.geteuid?.())!==(deps.ownerUid??0))deny('root_required');
    return withCutoverStateLock(config.controlRoot,()=>{
        const inspect=deps.inspect||inspectForwardChildIdentity;const operator=inspect(deps.pid??process.pid);
        if(!operator.uids.every(uid=>uid===0))deny('operator_identity_invalid');
        const journal=current(config,operationId,deps);const file=path.join(config.controlRoot,'first-cutover.lock');
        const bytes=(deps.readRootFile||readManagedRootFile)(file,deps.ownerUid??0);const lock=JSON.parse(bytes);
        const pending=journal.lockReconciliation?.phase==='intent'?journal.lockReconciliation.operator:null;
        const priorOwner=pending&&lock.pid===pending.pid&&lock.startTime===pending.startTicks?pending:journal.operator;
        if(lock.pid!==priorOwner.pid||lock.startTime!==priorOwner.startTicks
            ||observedDeath(priorOwner,inspect)!=='gone')deny('abandoned_owner_unproven');
        const attempts=journal.attempts||[];
        const uncertain=attempts.some(attempt=>!attempt.worker||observedDeath(attempt.worker,inspect)!=='gone'
            ||!['resolved_no_effect','observed'].includes(attempt.state)||attempt.steps.some(step=>step.dispatchState!=='observed'));
        const digest=sha(bytes);const tombstone=path.join(config.controlRoot,`managed-lock-tombstone-${operationId}-${digest}.json`);
        try{durableExclusive(tombstone,bytes);}catch(error){if(error.code!=='EEXIST'||!(deps.readRootFile||readManagedRootFile)(tombstone,deps.ownerUid??0).equals(bytes))throw error;}
        if(!(deps.readRootFile||readManagedRootFile)(file,deps.ownerUid??0).equals(bytes))deny('abandoned_lock_raced');
        const owner={pid:operator.pid,startTicks:operator.startTicks,bootId:operator.bootId};
        const replacement=Buffer.from(JSON.stringify({schema:'nassaj-cutover-lock/v1',pid:owner.pid,startTime:owner.startTicks,bootId:owner.bootId})+'\n');
        const reconciliation={phase:'intent',priorLockSha256:digest,tombstone:path.basename(tombstone),operator:owner,decision:uncertain?'diagnosis_only':'reconciled'};
        (deps.writeJournal||atomicJournal)(config,{...journal,revision:journal.revision+1,lockReconciliation:reconciliation});
        const temporary=file+'.replacement-'+randomBytes(12).toString('hex');durableExclusive(temporary,replacement);
        fs.renameSync(temporary,file);const dir=fs.openSync(config.controlRoot,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
        (deps.writeJournal||atomicJournal)(config,{...journal,operator:owner,revision:journal.revision+2,
            phase:uncertain?'manual_recovery':journal.phase,
            lockReconciliation:{...reconciliation,phase:'observed'}});
        return {schema:'nassaj-managed-lock-reconciliation/v1',operationId,decision:uncertain?'diagnosis_only':'reconciled',priorLockSha256:digest};
    });
}
function pins(config, deps) {
    const value = config.managedRestart; const verify = deps.verifyExecutable || verifyManagedRestartExecutable;
    for (const [file, digest] of [[value.nodeExecutable,value.nodeSha256],[value.pm2Executable,value.pm2Sha256],
        [value.safeRestartPath,value.safeRestartSha256],[value.managedClientPath,value.managedClientSha256],
        [value.bashPath,value.bashSha256],[value.wrapper.path,value.wrapper.sha256],[value.closure.path,value.closure.sha256]]) verify(file,digest);
    if (canonical(value.serviceIdentity) !== canonical(config.forwardMigration.serviceIdentity)
        || value.serviceIdentity.uid !== config.bootstrapClaim.applicationUid) deny('service_policy_mismatch');
    return value;
}
async function slot(config, deps) {
    const p = pins(config, deps);
    const observation = await (deps.observePm2 || observePinnedPm2Runtime)(p.pm2Observer, deps.pm2);
    if(observation.state!=='observed')deny('pm2_observation_unknown');
    const entries = observation.entries.map(entry=>({name:entry.name,pm_id:entry.pmId,pid:entry.pid,
        pm2_env:{namespace:entry.namespace,status:entry.status,pm_cwd:entry.cwd,exec_interpreter:entry.interpreter}}));
    return observeManagedRestartSlot(p, entries, deps.inspect || inspectForwardChildIdentity);
}
function asService(process, config) {
    assertForwardServiceIdentity(process, config.managedRestart.serviceIdentity);
    return { uid: config.bootstrapClaim.applicationUid, pid: process.pid, startTicks: process.startTicks, bootId: process.bootId };
}
function preparation(config, journal) {
    const result = { schema:'nassaj-managed-restart-preparation/v1',operationId:journal.operationId,
        generationId:config.expected.generationId,releaseIdentitySha256:config.expected.releaseIdentitySha256,
        commitReceiptSha256:journal.originalGrant.commitReceiptSha256,phase:'prepared',attemptId:journal.attempts.at(-1).attemptId,serverPid:journal.oldProcess.pid };
    for (const key of ['processName','pm2Home','workflowBase','nodeExecutable','nodeAbi','safeRestartSha256','expectedPm2Cwd',
        'generationRoot','home','pm2Executable','pm2Sha256','privateHealthUrl','managedClientSha256','pm2Id','pm2Namespace']) result[key]=config.managedRestart[key];
    return result;
}
function authorizeCaller(config, journal, deps) {
    if (!journal.launch) deny('launch_not_durable');
    return observeManagedRestartCaller(config, journal.operationId, journal.launch, journal.operator,
        readJson(config,'first-cutover.lock',deps),deps);
}
const MANAGED_STEPS = Object.freeze(['stop-old', 'delete-old', 'configure-target-stopped', 'start-target', 'restart-same']);
/** Append one bounded worker attempt; unresolved work cannot acquire another worker. */
export function appendManagedAttempt(journal, intent) {
    const attempts = journal.attempts || [];
    if (!Array.isArray(attempts) || attempts.length >= 8) deny('attempt_budget_exhausted');
    if (attempts.some((item, index) => item.sequence !== index + 1 || !['resolved_no_effect', 'observed'].includes(item.state))) deny('attempt_unresolved');
    const attempt = { attemptId: intent.nonce, attemptNonce: intent.nonce, sequence: attempts.length + 1,
        worker: null, state: 'launch_intent', launchIntent: intent, steps: [] };
    return [...attempts, attempt];
}
/** Append an independent typed step intent, bound to the current worker and nonce. */
export function appendManagedStepIntent(journal, request, intent) {
    exact(request, 'operationId,attemptId,attemptNonce,step');
    const attempts = journal.attempts; const active = attempts?.at(-1);
    if (request.operationId !== journal.operationId || !active || active.attemptId !== request.attemptId
        || active.attemptNonce !== request.attemptNonce || !active.worker || active.state !== 'running'
        || !MANAGED_STEPS.includes(request.step)) deny('step_attempt_mismatch');
    if (active.steps.length >= MANAGED_STEPS.length || active.steps.some(item => item.step === request.step)
        || active.steps.some(item => item.dispatchState !== 'observed')) deny('step_unresolved');
    const step = { step: request.step, sequence: active.steps.length + 1, intent,
        executionIntentDigest: sha(canonical(intent)), dispatchState: 'authorized_not_sent' };
    return [...attempts.slice(0, -1), { ...active, steps: [...active.steps, step] }];
}
/** Resolve only the exact current step; old callbacks never authorize another worker. */
export function recordManagedStepReceipt(journal, request, receipt) {
    exact(request, 'operationId,attemptId,attemptNonce,step,executionIntentDigest');
    const attempts = journal.attempts; const active = attempts?.at(-1); const step = active?.steps.at(-1);
    if (request.operationId !== journal.operationId || !active || active.attemptId !== request.attemptId
        || active.attemptNonce !== request.attemptNonce || active.state !== 'running' || !step
        || step.step !== request.step || step.executionIntentDigest !== request.executionIntentDigest
        || step.receipt || !['authorized_not_sent', 'possibly_sent'].includes(step.dispatchState)) deny('step_callback_stale');
    if (!receipt || !['observed', 'possibly_sent', 'not_sent'].includes(receipt.dispatchState)
        || !HEX.test(receipt.proofSha256 || '')) deny('step_receipt_invalid');
    const updated = { ...step, dispatchState: receipt.dispatchState, receipt };
    return [...attempts.slice(0, -1), { ...active, state:receipt.dispatchState==='observed'?'observed':active.state, steps: [...active.steps.slice(0, -1), updated] }];
}
function diagnostics(child) {
    let bytes=0;
    for(const stream of [child.stdout,child.stderr]) stream?.on('data',chunk=>{
        bytes+=chunk.length; if(bytes>65536) stream.destroy(Error('managed_diagnostics_limit'));
    });
}
async function rootManagedPrivateSlot(config,deps) {
    const p=config.managedRestart;
    const snapshot=await (deps.observePrivate||observePinnedPm2PrivateRuntime)(p.pm2Observer,deps.pm2);
    const entries=snapshot.privateEntries;
    if(!Array.isArray(entries))deny('private_inventory_invalid');
    const named=entries.filter(entry=>entry.pm2_env?.name===p.processName);const numbered=entries.filter(entry=>entry.pm_id===p.pm2Id);
    if(named.length!==1||numbered.length!==1||named[0]!==numbered[0]||named[0].pm2_env.namespace!==p.pm2Namespace)deny('private_slot_ambiguous');
    const actual=(deps.inspect||inspectForwardChildIdentity)(named[0].pid);assertForwardServiceIdentity(actual,p.serviceIdentity);
    return {entry:named[0],privateEntries:entries,process:asService(actual,config),observation:snapshot.observation};
}
function saveManagedPrivateInventory(config,operationId,attemptId,entries) {
    const file=`managed-private-before-${operationId}-${attemptId}.json`;
    const bytes=Buffer.from(canonical({schema:'nassaj-managed-private-inventory/v1',operationId,attemptId,entries})+'\n');
    if(bytes.length>1048576)deny('private_inventory_size');
    durableExclusive(path.join(config.controlRoot,file),bytes);
    return {file,sha256:sha(bytes)};
}
function loadManagedPrivateInventory(config,journal,deps) {
    const record=journal.executionIntent?.rootBeforeInventory;const attemptId=journal.attempts.at(-1).attemptId;
    const expected=`managed-private-before-${journal.operationId}-${attemptId}.json`;
    if(record?.file!==expected||!HEX.test(record.sha256||''))deny('private_inventory_pin_invalid');
    const file=path.join(config.controlRoot,expected);const info=fs.lstatSync(file);
    if(fs.realpathSync(file)!==file||!info.isFile()||info.isSymbolicLink()||info.uid!==(deps.ownerUid??0)
        ||(info.mode&0o777)!==0o600||info.size<1||info.size>1048576)deny('private_inventory_file_invalid');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let bytes;
    try{const opened=fs.fstatSync(fd);if(['dev','ino','size','mode','uid'].some(key=>opened[key]!==info[key]))deny('private_inventory_raced');bytes=fs.readFileSync(fd);}finally{fs.closeSync(fd);}
    if(sha(bytes)!==record.sha256)deny('private_inventory_changed');
    const value=JSON.parse(bytes);exact(value,'schema,operationId,attemptId,entries');
    if(value.schema!=='nassaj-managed-private-inventory/v1'||value.operationId!==journal.operationId||value.attemptId!==attemptId||!Array.isArray(value.entries))deny('private_inventory_invalid');
    return value.entries;
}
/** Authorize one fixed same-generation mutation only after its worker-bound intent is durable. */
export async function acknowledgeManagedMutation(config, operationId, workerPid, intent, deps = {}) {
    exact(intent,'schema,operationId,attemptId,attemptNonce,step,expectedSlotDigest,daemonIdentitySha256,slotDigest,payloadDigest,requestId');
    if(intent.schema!=='nassaj-pm2-execution-intent/v1'||intent.operationId!==operationId||intent.step!=='restart-same')deny('mutation_intent_invalid');
    const journal=current(config,operationId,deps); const attempt=journal.attempts?.at(-1);
    if(!sameProcess(lockOwner(config,deps),journal.operator||{}))deny('mutation_operator_invalid');
    const observed=(deps.inspect||inspectForwardChildIdentity)(workerPid);assertForwardServiceIdentity(observed,config.managedRestart.serviceIdentity);
    if(!attempt?.worker||!sameProcess(observed,attempt.worker)||observed.parentPid!==(deps.pid??process.pid)
        ||journal.launchIntent?.kind!=='execute'||journal.phase!=='ingress_closed'||journal.executionIntent)deny('mutation_worker_invalid');
    const state=readJson(config,'startup-admission.json',deps);const gate=readJson(config,'host-dispatch-state.json',deps).managedIngress;
    if(state.managedOperationId!==operationId||state.state!=='switching'||gate?.operationId!==operationId
        ||gate.generationEpoch!==state.generationEpoch||gate.phase!=='closed')deny('mutation_gate_invalid');
    const expected=config.managedRestart.mutation.slot.entrySha256;
    if(!HEX.test(expected||'')||expected!==sha(canonical(config.managedRestart.mutation.slot.baseline))
        ||intent.expectedSlotDigest!==expected||!HEX.test(intent.slotDigest||'')
        ||intent.daemonIdentitySha256!==sha(canonical(config.managedRestart.pm2Observer.daemon))
        ||intent.payloadDigest!==sha(canonical({id:config.managedRestart.pm2Id}))||!/^[a-f0-9]{32}$/.test(intent.requestId||''))deny('mutation_descriptor_invalid');
    const privateBefore=await rootManagedPrivateSlot(config,deps);
    if(!sameProcess(privateBefore.process,journal.oldProcess))deny('mutation_old_process_changed');
    const beforeDigest=verifyPm2LegacySnapshot(privateBefore.entry.pm2_env,config.managedRestart.mutation.slot.baseline,
        {pid:privateBefore.entry.pid,priorPid:journal.oldProcess.pid,status:'online',step:'inspect'});
    if(!sameProcess((deps.inspect||inspectForwardChildIdentity)(workerPid),attempt.worker)
        ||!sameProcess(lockOwner(config,deps),journal.operator)||canonical(assertManagedClosedGate(config,operationId,deps))!==canonical(state))deny('mutation_authority_changed');
    const changed=change(config,operationId,journal.revision,value=>{
        const lockedState=readJson(config,'startup-admission.json',deps);
        const lockedGate=readJson(config,'host-dispatch-state.json',deps).managedIngress;
        if(canonical(lockedState)!==canonical(state)||canonical(lockedGate)!==canonical(gate)
            ||lockedState.revocation||lockedState.transitionReason||lockedState.potentiallyRunningClaim)deny('mutation_locked_authority_changed');
        return {attempts:appendManagedStepIntent(value,{operationId,attemptId:intent.attemptId,attemptNonce:intent.attemptNonce,step:intent.step},intent),
        phase:'restart_execution_intent',executionIntent:{launchAttemptNonce:attempt.attemptNonce,
            pm2Id:config.managedRestart.pm2Id,pm2Namespace:config.managedRestart.pm2Namespace,
            launchSha256:sha(canonical(journal.launch)),stepIntentSha256:sha(canonical(intent)),
            rootBeforeInventory:saveManagedPrivateInventory(config,operationId,attempt.attemptId,privateBefore.privateEntries),
            rootBeforePrivateSha256:beforeDigest,rootClockBefore:{wallMs:deps.now?.()??Date.now(),monotonicNs:(deps.monotonicNow?.()??process.hrtime.bigint()).toString(),bootId:observed.bootId},at:deps.now?.()??Date.now()}};},deps);
    return {...intent,schema:'nassaj-pm2-execution-ack/v1',decision:'authorized',revision:changed.revision};
}
function serveManagedMutationPipe(config,operationId,child,deps) {
    const input=child.stdio[5],output=child.stdio[6];if(!input||!output)deny('mutation_pipe_missing');
    let bytes=Buffer.alloc(0),handled=false;
    input.on('data',async chunk=>{
        try {
            if(handled)deny('mutation_frame_repeated');bytes=Buffer.concat([bytes,chunk]);if(bytes.length>16384)deny('mutation_frame_size');
            const end=bytes.indexOf(10);if(end<0)return;if(end!==bytes.length-1)deny('mutation_frame_trailing');
            handled=true;const ack=await acknowledgeManagedMutation(config,operationId,child.pid,JSON.parse(bytes.toString('utf8')),deps);
            output.write(`${JSON.stringify(ack)}\n`);
        } catch { output.destroy();input.destroy(); }
    });
}
/** Spawn outside the state lock, verify kernel-ready, durably bind the launch, then send exactly one permit. */
export async function runManagedRestartLaunch(config, operationId, kind, deps = {}) {
    let journal=current(config,operationId,deps);
    if (!['check','execute'].includes(kind) || journal.launchIntent || journal.launch) deny('launch_already_attempted');
    const intent={kind,nonce:randomBytes(32).toString('hex'),at:deps.now?.()??Date.now()};
    journal=change(config,operationId,journal.revision,value=>({launchIntent:intent,attempts:appendManagedAttempt(value,intent)}),deps);
    const p=pins(config,deps);
    const child=(deps.spawn || spawn)(p.nodeExecutable,[p.wrapper.path],{cwd:p.generationRoot,
        env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'},stdio:['ignore','pipe','pipe','pipe','pipe','pipe','pipe']});
    if(child.stdio[5]&&child.stdio[6])serveManagedMutationPipe(config,operationId,child,deps);
    diagnostics(child); const resultChunks=[]; let resultSize=0;
    child.stdout?.on('data',chunk=>{resultSize+=chunk.length;if(resultSize<=16384)resultChunks.push(chunk);});
    const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,output:resultSize<=16384?Buffer.concat(resultChunks).toString('utf8'):''}));});
    // Attach a rejection observer immediately; a spawn error must not become an unhandled rejection during handshake.
    exited.catch(()=>{});
    try {
        const ready=await readForwardPermitFrame(child.stdio[4]);
        assertForwardFrameKeys(ready,'schema,operationId,nonce,challenge,launchIntentSha256,pid,startTicks,bootId');
        const observed=(deps.inspect || inspectForwardChildIdentity)(child.pid); assertForwardServiceIdentity(observed,p.serviceIdentity);
        if(ready.schema!=='nassaj-managed-child-ready/v1' || ready.operationId!==operationId || ready.nonce!==intent.nonce
            || ready.launchIntentSha256!==sha(canonical(intent)) || !HEX.test(ready.challenge || '') || !sameProcess(ready,observed)
            || observed.parentPid!==(deps.pid??process.pid)) deny('launch_ready_mismatch');
        journal=change(config,operationId,journal.revision,value=>({attempts:[...value.attempts.slice(0,-1),{...value.attempts.at(-1),worker:asService(observed,config),state:'running'}],launch:{...asService(observed,config),challenge:ready.challenge,
            launchIntentSha256:ready.launchIntentSha256},permitIntent:{nonce:intent.nonce,at:deps.now?.()??Date.now()}}),deps);
        const permit={...ready,schema:'nassaj-managed-child-permit/v1',decision:'authorized'};
        await new Promise((resolve,reject)=>{child.stdio[3].once('error',reject);child.stdio[3].end(`${JSON.stringify(permit)}\n`,resolve);});
        return { child, exited, journal };
    } catch(error) {
        child.stdio[3].destroy(); child.stdio[4].destroy();
        // Never retry a possibly delivered permit. Durable intent and the long lock remain the recovery authority.
        throw error;
    }
}

/** Accept the fresh signature exactly once under CAS before any stop/start or ingress effect. */
export async function acceptManagedRestartOperation(config, operationId, initiatingHelper, deps = {}) {
    const operator=lockOwner(config,deps);const observed=await slot(config,deps);const oldProcess=asService(observed.process,config);
    return withCutoverStateLock(config.controlRoot,()=>{
        let prior;try{prior=readJson(config,'managed-restart.json',deps);}catch(error){if(error.code!=='ENOENT')throw error;}
        if(prior?.operationId===operationId)return current(config,operationId,deps);
        if(prior && prior.phase!=='committed')deny('previous_operation_unresolved');
        const originalGrant=readJson(config,'startup-admission.json',deps);
        if(originalGrant.state!=='active' || originalGrant.offer || originalGrant.managedOperationId
            || !sameProcess(originalGrant.lastClaim || {},oldProcess))deny('active_process_mismatch');
        if(originalGrant.managedCommittedOperationId) readVerifiedManagedTerminal(config,originalGrant.managedCommittedOperationId,deps);
        else if(prior)deny('previous_terminal_locator_missing');
        const approval=readJson(config,'managed-restart-approval.json',deps);
        const acceptedAt=deps.now?.()??Date.now();
        const verified=verifyManagedRestartApproval(config,approval,operationId,originalGrant.managedCommitSha256 || originalGrant.commitReceiptSha256,
            (deps.readRootFile||readManagedRootFile)(config.bootstrapClaim.ownerApprovalPublicKeyFile,deps.ownerUid??0),acceptedAt);
        const journal={schema:'nassaj-managed-restart/v1',operationId,phase:'prepared',revision:1,approvalAcceptedAt:acceptedAt,
            approvalNonce:approval.nonce,approvalSha256:verified.approvalSha256,originalGrant,
            originalGrantSha256:sha(canonical(originalGrant)),approval,operator,initiatingHelper,oldProcess};
        (deps.writeJournal||atomicJournal)(config,journal);
        return current(config,operationId,deps);
    });
}
function healthReceipt(config,journal,visibility,observed) {
    return {schema:'nassaj-managed-health-receipt/v1',operationId:journal.operationId,visibility,
        claimId:journal.replacementClaim.claimId,generationEpoch:journal.replacementClaim.generationEpoch,
        process:{uid:journal.replacementClaim.uid,pid:journal.replacementClaim.pid,startTicks:journal.replacementClaim.startTicks,bootId:journal.replacementClaim.bootId},
        securityStartupSha256:sha(canonical(journal.securityStartup)),releaseIdentitySha256:config.expected.releaseIdentitySha256,
        serverBuildId:config.expected.serverBuildId,clientBuildId:config.expected.clientBuildId,
        databaseContractSha256:config.expected.databaseContractSha256,observedAt:observed.observedAt,bodySha256:sha(canonical(observed.body))};
}
async function privateReady(config,operationId,deps) {
    let journal=current(config,operationId,deps);authorizeCaller(config,journal,deps);
    const response={schema:'nassaj-managed-restart-private-ready/v1',operationId};
    if(journal.phase!=='private_verified') {
        if(!['restart_execution_intent','replacement_claim_pending','replacement_claimed','security_startup_authorized'].includes(journal.phase))deny('readiness_phase_invalid');
        return {...response,decision:'pending'};
    }
    const currentSlot=await slot(config,deps);if(!sameProcess(currentSlot.process,journal.replacementClaim))deny('replacement_slot_changed');
    const observed=await (deps.observeHealth||observeBoundTargetHealth)(config,journal.replacementClaim,'private',deps.health);
    if (!observed || journal.privateReceipt?.claimId !== journal.replacementClaim.claimId) deny('private_receipt_missing');
    const claim=journal.replacementClaim;
    return {...response,decision:'ready',claimId:claim.claimId,generationEpoch:claim.generationEpoch,pid:claim.pid,startTicks:claim.startTicks,bootId:claim.bootId};
}
/** Fixed root dispatcher entry. Execution stays blocked until the approved fixed PM2 observer is integrated. */
export async function dispatchManagedRestartOperation(config,action,request,deps={}) {
    const operationId=validateManagedRestartRequest(action,request);
    if((deps.effectiveUid?.()??process.geteuid?.())!==(deps.ownerUid??0))deny('root_required');
    if(action==='restartCommittedGeneration')return restartCommitted(config,operationId,deps);
    let journal=current(config,operationId,deps);pins(config,deps);authorizeCaller(config,journal,deps);
    if(action==='inspectManagedRestart') {
        if(!['prepared','ingress_closed','restart_execution_intent'].includes(journal.phase))deny('inspection_phase_invalid');
        const observed=await slot(config,deps);if(!sameProcess(observed.process,journal.oldProcess))deny('old_slot_changed');
        return preparation(config,journal);
    }
    if(action==='verifyManagedRestartPrivateReady')return privateReady(config,operationId,deps);
    deny('legacy_execution_claim_disabled');
}
function assertManagedClosedGate(config,operationId,deps) {
    const state=readJson(config,'startup-admission.json',deps);const gate=readJson(config,'host-dispatch-state.json',deps).managedIngress;
    if(state.managedOperationId!==operationId||state.state!=='switching'||gate?.operationId!==operationId
        ||gate.generationEpoch!==state.generationEpoch||gate.phase!=='closed')deny('deferred_gate_changed');
    return state;
}
/** Resolve a post-begin busy worker only when it terminated normally before any execution intent. */
export async function resolveManagedPostBeginDeferral(config,operationId,completed,deps={}) {
    let journal=current(config,operationId,deps);const attempt=journal.attempts.at(-1);
    if(completed.code!==75||completed.signal||journal.executionIntent||attempt.steps.length||journal.phase!=='ingress_closed')deny('deferral_effect_unknown');
    const terminal=JSON.parse(completed.output);exact(terminal,'schema,operationId,attemptId,outcome,reason,effects');
    if(terminal.schema!=='nassaj-safe-operation-result/v1'||terminal.operationId!==operationId||terminal.attemptId!==attempt.attemptId
        ||terminal.outcome!=='deferred'||terminal.reason!=='live_work'||terminal.effects!=='none')deny('deferral_receipt_invalid');
    const state=assertManagedClosedGate(config,operationId,deps);const observed=await slot(config,deps);
    if(!sameProcess(observed.process,journal.oldProcess)||canonical(assertManagedClosedGate(config,operationId,deps))!==canonical(state))deny('deferral_state_changed');
    journal=change(config,operationId,journal.revision,value=>({phase:'deferred_after_begin',
        attempts:[...value.attempts.slice(0,-1),{...attempt,state:'resolved_no_effect',terminalReceipt:terminal,resultCode:75}],
        launch:null,launchIntent:null,permitIntent:null}),deps);
    return {schema:'nassaj-managed-restart-result/v1',operationId,decision:'deferred',reason:'live_work'};
}
/** Retain the exact worker terminal receipt against its independent fsynced step intent. */
export function retainManagedWorkerResult(config, operationId, completed, deps = {}) {
    if(completed.code!==0||completed.signal)deny('worker_terminal_unknown');
    const result=JSON.parse(completed.output);exact(result,'schema,operationId,attemptId,attemptNonce,drain,mutation');
    let journal=current(config,operationId,deps);const active=journal.attempts?.at(-1);const step=active?.steps.at(-1);
    if(result.schema!=='nassaj-managed-worker-result/v1'||result.operationId!==operationId||!step
        ||result.attemptId!==active.attemptId||result.attemptNonce!==active.attemptNonce)deny('worker_terminal_stale');
    exact(result.drain,'schema,operationId,attemptId,outcome,reason,effects');
    if(result.drain.schema!=='nassaj-safe-operation-result/v1'||result.drain.operationId!==operationId
        ||result.drain.attemptId!==active.attemptId||result.drain.outcome!=='ready'||result.drain.reason!=='drained'||result.drain.effects!=='none')deny('worker_drain_invalid');
    const receipt=result.mutation;exact(receipt,'schema,operationId,attemptId,attemptNonce,step,requestId,dispatchState,observationSha256,slotDigest,targetSlotBinding');
    if(receipt.schema!=='nassaj-pm2-step-result/v1'||receipt.operationId!==operationId||receipt.attemptId!==active.attemptId
        ||receipt.attemptNonce!==active.attemptNonce||receipt.step!=='restart-same'||receipt.requestId!==step.intent.requestId
        ||receipt.dispatchState!=='observed'||receipt.targetSlotBinding!==null
        ||![receipt.observationSha256,receipt.slotDigest].every(value=>HEX.test(value||'')))deny('worker_mutation_invalid');
    if(journal.provisionalWorkerResult)deny('worker_terminal_replayed');
    journal=change(config,operationId,journal.revision,()=>({provisionalWorkerResult:result,
        provisionalWorkerResultSha256:sha(canonical(result))}),deps);
    return journal;
}
/** Confirm provisional worker output with a new root-private peer and kernel observation. */
export async function verifyManagedWorkerCompletion(config,operationId,deps={}) {
    const journal=current(config,operationId,deps);const before=journal.executionIntent?.rootClockBefore;
    if(!journal.provisionalWorkerResult||!before||journal.rootVerifiedMutation)deny('root_completion_invalid');
    const snapshot=await rootManagedPrivateSlot(config,deps);
    const after={wallMs:deps.now?.()??Date.now(),monotonicNs:(deps.monotonicNow?.()??process.hrtime.bigint()).toString(),bootId:snapshot.process.bootId};
    const metadata=(deps.readMetadata||readPinnedPm2RuntimeMetadata)(config.managedRestart.mutation.metadata);
    const window={wallBefore:before.wallMs,wallAfter:after.wallMs,monotonicBefore:before.monotonicNs,monotonicAfter:after.monotonicNs,
        bootBefore:before.bootId,bootAfter:after.bootId};
    if(sameProcess(snapshot.process,journal.oldProcess)||observedDeath(journal.oldProcess,deps.inspect||inspectForwardChildIdentity)!=='gone')deny('root_old_process_unresolved');
    const unrelated=verifyPm2UnrelatedEntries(loadManagedPrivateInventory(config,journal,deps),snapshot.privateEntries,
        {name:config.managedRestart.processName,namespace:config.managedRestart.pm2Namespace});
    const digest=verifyPm2LegacySnapshot(snapshot.entry.pm2_env,config.managedRestart.mutation.slot.baseline,
        {pid:snapshot.entry.pid,priorPid:journal.oldProcess.pid,status:'online',step:'restart-same',window,...metadata});
    const active=journal.attempts.at(-1);const step=active.steps.at(-1);
    const receipt={schema:'nassaj-managed-root-mutation-receipt/v1',operationId,attemptId:active.attemptId,attemptNonce:active.attemptNonce,
        step:step.step,executionIntentDigest:step.executionIntentDigest,provisionalResultSha256:journal.provisionalWorkerResultSha256,
        rootClockBefore:before,rootClockAfter:after,slotDigest:digest,unrelated,process:snapshot.process,
        observationSha256:snapshot.observation.observationSha256};
    return change(config,operationId,journal.revision,value=>({rootVerifiedMutation:receipt,attempts:recordManagedStepReceipt(value,
        {operationId,attemptId:active.attemptId,attemptNonce:active.attemptNonce,step:step.step,executionIntentDigest:step.executionIntentDigest},
        {dispatchState:'observed',proofSha256:sha(canonical(receipt)),receipt})}),deps);
}
async function restartCommitted(config,operationId,deps) {
    if(!deps.initiatingHelper)deny('verified_operator_envelope_required');
    let journal=await acceptManagedRestartOperation(config,operationId,deps.initiatingHelper,deps);
    if(journal.phase==='committed')return {schema:'nassaj-managed-restart-result/v1',operationId,decision:'committed'};
    const resumed=journal.phase==='deferred_after_begin';
    if(journal.launchIntent || (!resumed&&journal.phase!=='prepared'))deny('operation_recovery_required');
    if(resumed)journal=change(config,operationId,journal.revision,()=>({phase:'ingress_closed'}),deps);
    const check=await runManagedRestartLaunch(config,operationId,'check',deps);const result=await check.exited;
    journal=current(config,operationId,deps);
    if(result.signal || ![0,75].includes(result.code))deny('preflight_unresolved');
    const terminal=JSON.parse(result.output);exact(terminal,'schema,operationId,attemptId,outcome,reason,effects');
    if(terminal.schema!=='nassaj-safe-operation-result/v1'||terminal.operationId!==operationId
        ||terminal.attemptId!==journal.attempts.at(-1).attemptId||terminal.effects!=='none'
        ||(result.code===75?(terminal.outcome!=='deferred'||terminal.reason!=='live_work'):(terminal.outcome!=='ready'||terminal.reason!=='drained')))deny('preflight_receipt_invalid');
    const unchanged=await slot(config,deps);
    if(!sameProcess(unchanged.process,journal.oldProcess)||journal.executionIntent||journal.attempts.at(-1).steps.length
        ||(!resumed&&canonical(readJson(config,'startup-admission.json',deps))!==canonical(journal.originalGrant)))deny('preflight_state_changed');
    if(resumed)assertManagedClosedGate(config,operationId,deps);
    journal=change(config,operationId,journal.revision,()=>({checkLaunch:journal.launch,checkLaunchIntent:journal.launchIntent,
        phase:resumed&&result.code===75?'deferred_after_begin':journal.phase,checkReceipt:{code:result.code,at:deps.now?.()??Date.now()},attempts:[...journal.attempts.slice(0,-1),{...journal.attempts.at(-1),state:'resolved_no_effect',resultCode:result.code,terminalReceipt:terminal}],launch:null,launchIntent:null,permitIntent:null}),deps);
    if(result.code===75)return {schema:'nassaj-managed-restart-result/v1',operationId,decision:'deferred',reason:'live_work'};
    if(!resumed){
    admission.beginManagedRestartAdmission(config,operationId,deps);
    const closed=await callManagedGate(config,operationId,'closeCurrentOperationGate',deps);
    journal=current(config,operationId,deps);
    journal=change(config,operationId,journal.revision,()=>({phase:'ingress_closed',gateCloseReceipt:closed}),deps);
    }
    const execution=await runManagedRestartLaunch(config,operationId,'execute',deps);
    let completed;let exitError;let retained=false;execution.exited.then(value=>{completed=value;},error=>{exitError=error;});
    const deadline=process.hrtime.bigint()+90_000_000_000n;
    while(true) {
        if(exitError)throw exitError;
        if(completed?.code===75)return resolveManagedPostBeginDeferral(config,operationId,completed,deps);
        if(completed&&!retained){retainManagedWorkerResult(config,operationId,completed,deps);retained=true;}
        if(process.hrtime.bigint()>=deadline)deny('execution_timeout');
        journal=current(config,operationId,deps);
        if(journal.phase==='restart_execution_intent'&&!journal.replacementProcess) {
            let observed;
            try{observed=await slot(config,deps);}catch(error){
                if(!['ENOENT','ESRCH'].includes(error.code)||observedDeath(journal.oldProcess,deps.inspect||inspectForwardChildIdentity)!=='gone')throw error;
                await new Promise(resolve=>setTimeout(resolve,100));continue;
            }
            if(!sameProcess(observed.process,journal.oldProcess)) {
                journal=change(config,operationId,journal.revision,()=>({replacementProcess:{...asService(observed.process,config),
                    pm2Id:config.managedRestart.pm2Id,pm2Namespace:config.managedRestart.pm2Namespace,launchAttemptNonce:journal.executionIntent.launchAttemptNonce}}),deps);
                admission.armManagedReplacementAdmission(config,operationId,deps);
            }
        }
        if(journal.phase==='security_startup_authorized') {
            let observed;
            try { observed=await (deps.observeHealth||observeBoundTargetHealth)(config,journal.replacementClaim,'private',deps.health); }
            catch(error) { if(error.message!=='forward_receipt_listener_missing'&&error.cause?.code!=='ECONNREFUSED'&&error.code!=='ECONNREFUSED')throw error; }
            if(observed)journal=change(config,operationId,journal.revision,()=>({phase:'private_verified',privateReceipt:healthReceipt(config,journal,'private',observed)}),deps);
        }
        if(retained&&journal.phase==='private_verified'){journal=await verifyManagedWorkerCompletion(config,operationId,deps);break;}
        await new Promise(resolve=>setTimeout(resolve,100));
    }
    journal=current(config,operationId,deps);
    if(completed.code!==0||journal.phase!=='private_verified'||!journal.rootVerifiedMutation)deny('execution_unresolved');
    const opened=await callManagedGate(config,operationId,'openCurrentOperationGate',deps);
    journal=current(config,operationId,deps);
    journal=change(config,operationId,journal.revision,()=>({phase:'ingress_opened',gateOpenReceipt:opened}),deps);
    const publicHealth=await (deps.observeHealth||observeBoundTargetHealth)(config,journal.replacementClaim,'public',deps.health);
    journal=change(config,operationId,journal.revision,()=>({phase:'public_verified',publicReceipt:healthReceipt(config,journal,'public',publicHealth)}),deps);
    admission.completeManagedRestartAdmission(config,operationId,deps);
    return {schema:'nassaj-managed-restart-result/v1',operationId,decision:'committed'};
}

async function callManagedGate(config,operationId,action,deps) {
    const p=pins(config,deps); const record=p.dispatcher;
    (deps.verifyExecutable||verifyManagedRestartExecutable)(record.path,record.sha256);
    const state=readJson(config,'startup-admission.json',deps);
    const request={schema:'nassaj-current-operation-gate-request/v1',operationId,generationEpoch:state.generationEpoch};
    const output=await new Promise((resolve,reject)=>{
        const child=(deps.execGate||execFile)(p.nodeExecutable,[record.path,action],{
            encoding:'utf8',timeout:30000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent'}},
        (error,stdout)=>error?reject(error):resolve(stdout));
        child.stdin.end(`${JSON.stringify(request)}\n`);
    });
    const receipt=JSON.parse(output);assertForwardFrameKeys(receipt,'schema,operationId,generationEpoch,phase,observedAt,hostProofSha256,claimId');
    if(receipt.schema!=='nassaj-managed-ingress-receipt/v1'||receipt.operationId!==operationId
        ||receipt.generationEpoch!==state.generationEpoch||receipt.phase!==(action==='closeCurrentOperationGate'?'closed':'opened')
        ||!HEX.test(receipt.hostProofSha256||'')||!Number.isSafeInteger(receipt.observedAt))deny('gate_receipt_invalid');
    return receipt;
}
