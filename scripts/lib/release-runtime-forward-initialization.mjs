/** First-forward preparation and retirement. No legacy restart, restore or implicit active grant. */
import fs from 'node:fs';
import { validateFirstForwardPlans } from './release-runtime-forward-plan-validation.mjs';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { withCutoverStateLock } from './release-runtime-cutover.mjs';
import { forwardValueSha256 as digest, inspectForwardChildIdentity } from './release-runtime-forward-child-protocol.mjs';
import { verifyForwardOwner } from './release-runtime-forward-parent.mjs';
import { readForwardRootRecord, verifyForwardRetirement, observeForwardInhibitors, inspectForwardInventory } from './release-runtime-forward-retirement.mjs';
import { planForwardDefinitionRetirement, retireForwardSavedDefinition } from './release-runtime-forward-saved-definitions.mjs';
import { readPinnedForwardBytes, readPinnedForwardRecord } from '../release-runtime-forward-child.mjs';
import { observePinnedPm2Runtime } from './pm2-readonly-observer.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (ok, reason) => { if (!ok) throw Error(`forward_initialization_${reason}`); };
const file = (config, name) => path.join(config.controlRoot, name);
function write(config, name, value) {
    const destination = file(config, name); const temporary = `${destination}.partial-${randomBytes(12).toString('hex')}`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination); const directory = fs.openSync(config.controlRoot, 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function read(config, name, deps) { return (deps.readRoot || readForwardRootRecord)(file(config, name)); }
function increment(value) { check(Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER, 'counter_invalid'); return value + 1; }
function assertOwner(config, journal, deps) {
    check((deps.uid?.() ?? process.geteuid?.()) === 0, 'root_required'); verifyForwardOwner(config, journal);
    check(journal.state === 'running' && !journal.revocation && digest(journal.expected) === digest(config.expected), 'authority_changed');
    const operator = (deps.inspectProcess || inspectForwardChildIdentity)(process.pid);
    const lock = read(config, 'first-cutover.lock', deps);
    check(lock.pid === operator.pid && lock.startTime === operator.startTicks, 'operator_lock_missing');
    return operator;
}
function current(config, deps) {
    const journal = read(config, 'first-cutover.json', deps); assertOwner(config, journal, deps);
    const state = read(config, 'startup-admission.json', deps);
    check(state.schema === 'nassaj-startup-admission/v1' && state.state === 'switching' && !state.revocation && !state.managedOperationId
        && !state.transitionReason && !state.potentiallyRunningClaim && state.offer === null
        && state.generationEpoch === journal.forwardAdmission?.generationEpoch && state.revision === journal.forwardAdmission?.revision
        && digest(state) === journal.forwardAdmission?.sha256
        && state.authorityId === journal.transactionId && state.approvalSha256 === journal.approvalSha256
        && digest(state.identity) === digest(config.bootstrapClaim.identity), 'admission_changed');
    return { journal, state };
}
function transition(config, expected, phase, extra, deps) {
    return withCutoverStateLock(config.controlRoot, () => {
        const { journal } = current(config, deps); check(digest(journal) === digest(expected), 'journal_changed');
        const next = { ...journal, ...extra, phase, revision: increment(journal.revision) };
        write(config, 'first-cutover.json', next); return next;
    });
}

function inspectInventory(config) { inspectForwardInventory(config.forwardActivation.mutatorPlan); }
function sourceBefore(source, slot) {
    try {
        const info = fs.lstatSync(source.path);
        check(info.isFile() && !info.isSymbolicLink() && fs.realpathSync(source.path) === source.path && info.size <= 16777216, 'source_unsafe');
        const bytes = fs.readFileSync(source.path); check(sha(bytes) === source.beforeSha256, 'source_pin_changed');
        return planForwardDefinitionRetirement(bytes, source.format, slot);
    } catch (error) {
        if (error.code !== 'ENOENT' || !source.optional || source.beforeSha256 !== null) throw error;
        check(fs.realpathSync(path.dirname(source.path)) === path.dirname(source.path), 'absent_parent_unsafe'); return null;
    }
}
function unitCommand(config, source, args, deps) {
    const pin = config.forwardActivation.mutatorPlan.systemctl; (deps.pin || readPinnedForwardBytes)(pin);
    const prefix = source.scope === 'user' ? ['--user', `--machine=${source.user}@.host`] : [];
    return (deps.exec || execFileSync)(pin.path, [...prefix, ...args, source.unit], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 262144, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C' } });
}
function unitFacts(config, source, deps, detailed = false) {
    const fields = detailed ? 'Id,LoadState,ActiveState,UnitFileState,ControlGroup,FragmentPath,DropInPaths,ExecStart,ExecStartPre' : 'Id,LoadState,ActiveState,UnitFileState';
    const raw = unitCommand(config, source, ['show', `--property=${fields}`, '--no-pager'], deps);
    return Object.fromEntries(raw.trim().split('\n').map(line => { const at = line.indexOf('='); check(at > 0, 'unit_output'); return [line.slice(0, at), line.slice(at + 1)]; }));
}
function inhibitorProof(config, source, deps) {
    return observeForwardInhibitors(config.forwardActivation.mutatorPlan, deps.inhibitors).find(item => item.sourceId === source.sourceId);
}
function appendEffect(config, journal, kind, source, phase, facts, deps) {
    const effect = { schema: 'nassaj-forward-effect/v1', transactionId: journal.transactionId, attemptNonce: journal.forwardAttemptNonce,
        effectId: `${kind}:${source.sourceId}`, kind, planSha256: kind === 'saved-definition' ? config.expected.supervisorPlanSha256 : config.expected.mutatorPlanSha256,
        expectedIdentitySha256: digest(source), phase, revision: increment(journal.revision), bootId: journal.forwardBootId, facts };
    effect.factsSha256 = digest(effect);
    return transition(config, journal, journal.phase, { forwardEffects: [...journal.forwardEffects, effect] }, deps);
}
async function applyUnitEffect(config, journal, source, action, deps) {
    await observeExpectedRuntime(config, false, deps);
    let next = appendEffect(config, journal, `unit-${action}`, source, 'intent', {}, deps);
    await new Promise((resolve, reject) => {
        withCutoverStateLock(config.controlRoot, () => {
            check(digest(current(config, deps).journal) === digest(next), 'journal_changed');
            const pin = config.forwardActivation.mutatorPlan.systemctl; (deps.pin || readPinnedForwardBytes)(pin);
            const prefix = source.scope === 'user' ? ['--user', `--machine=${source.user}@.host`] : [];
            if (deps.exec && !deps.execUnit) { unitCommand(config, source, [action], deps); resolve(); return; }
            (deps.execUnit || execFile)(pin.path, [...prefix, action, source.unit], { timeout: 10000, maxBuffer: 262144,
                env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C' } }, error => error ? reject(error) : resolve());
        });
    });
    const values = unitFacts(config, source, deps);
    check(action === 'mask' ? values.LoadState === 'masked' && values.UnitFileState === 'masked' : values.ActiveState === 'inactive', 'unit_effect_unverified');
    next = appendEffect(config, next, `unit-${action}`, source, 'observed', { intentSha256: next.forwardEffects.at(-1).factsSha256, values }, deps);
    return next;
}
function oldStart(old) {
    check(!old.startTime || !old.startTicks || old.startTime === old.startTicks, 'old_identity_conflict');
    const ticks = old.startTime ?? old.startTicks;
    check(/^[0-9]+$/.test(ticks || '') && typeof old.bootId === 'string' && old.bootId.length > 0, 'old_identity_invalid'); return ticks;
}
async function observeExpectedRuntime(config, retired, deps) {
    const plan = config.forwardActivation.supervisorPlan;
    const observed = await (deps.observe || observePinnedPm2Runtime)(plan.pm2.observer, deps.observer);
    check(Array.isArray(observed.entries) && /^[a-f0-9]{64}$/.test(observed.observationSha256 || ''), 'runtime_unknown');
    const slots = observed.entries.filter(entry => entry.pmId === plan.slot.pm2Id
        || (entry.name === plan.slot.name && entry.namespace === plan.slot.namespace));
    const old = config.oldProcess; const inspect = deps.inspectProcess || inspectForwardChildIdentity;
    if (retired) {
        check(slots.length === 0, 'old_slot_present');
        try { const actual = inspect(old.pid); check(actual.startTicks !== oldStart(old) || actual.bootId !== old.bootId, 'old_process_alive'); }
        catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    } else {
        check(Number.isSafeInteger(plan.slot.pm2Id) && slots.length === 1 && slots[0].pmId === plan.slot.pm2Id
            && slots[0].name === plan.slot.name && slots[0].namespace === plan.slot.namespace
            && slots[0].pid === old.pid && slots[0].status === 'online', 'old_slot_changed');
        const actual = inspect(old.pid);
        check(actual.startTicks === oldStart(old) && actual.bootId === old.bootId
            && actual.uids.every(uid => uid === config.forwardMigration.serviceIdentity.uid)
            && !['Z', 'X'].includes(actual.state), 'old_process_changed');
    }
    return observed;
}
function readDomainIncarnation(pid) {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')'); const fields = stat.slice(close + 2).trim().split(/\s+/);
    check(stat.startsWith(`${pid} (`) && close > 0 && stat[close + 1] === ' '
        && /^[A-Za-z]$/.test(fields[0]) && /^[0-9]+$/.test(fields[19] || ''), 'domain_stat_invalid');
    return fields[19];
}
function readDomainMembership(pid) {
    const bytes = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
    const lines = bytes.endsWith('\n') ? bytes.slice(0, -1).split('\n') : bytes.split('\n');
    const hierarchies = new Set();
    const paths = lines.map(line => {
        const match = /^([0-9]+):([A-Za-z0-9_=.-]+(?:,[A-Za-z0-9_=.-]+)*)?:(\/[^\x00-\x1f\x7f]*)$/.exec(line);
        check(match && !hierarchies.has(match[1]) && (match[1] === '0' ? !match[2] : Boolean(match[2]))
            && (!match[2] || new Set(match[2].split(',')).size === match[2].split(',').length), 'domain_membership_invalid');
        hierarchies.add(match[1]); return match[3];
    });
    return { bytes, paths };
}
function domainProcessAbsent(pid) {
    try { fs.statSync(`/proc/${pid}`); return false; }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return true; throw error; }
}
function inspectDomainMember(pid, source) {
    const startTicks = readDomainIncarnation(pid); const membership = readDomainMembership(pid);
    const inside = membership.paths.some(value => value === source.cgroupPath || value.startsWith(`${source.cgroupPath}/`));
    if (!inside) {
        const after = readDomainMembership(pid); const afterTicks = readDomainIncarnation(pid);
        check(startTicks === afterTicks && membership.bytes === after.bytes, 'domain_scan_unstable');
        return null;
    }
    const before = inspectForwardChildIdentity(pid); const afterMembership = readDomainMembership(pid);
    const after = inspectForwardChildIdentity(pid);
    check(startTicks === before.startTicks && before.startTicks === after.startTicks && before.bootId === after.bootId
        && membership.bytes === afterMembership.bytes, 'domain_scan_unstable');
    return before;
}
function domainMembers(source, deps) {
    if (deps.domainMembers) return deps.domainMembers(source);
    const members = [];
    for (const pid of fs.readdirSync('/proc').filter(value => /^[0-9]+$/.test(value))) {
        try {
            const member = inspectDomainMember(Number(pid), source);
            if (member) members.push(member);
        } catch (error) {
            if (['ENOENT', 'ESRCH'].includes(error.code) && domainProcessAbsent(Number(pid))) continue;
            throw error;
        }
    }
    return members;
}
function inspectUnitPreflight(config, source, deps) {
    const facts = unitFacts(config, source, deps, true);
    check(facts.Id === source.unit && digest(facts) === source.configurationSha256, 'inhibitor_configuration_changed');
    check(['loaded', 'masked', 'not-found'].includes(facts.LoadState), 'unit_state_unknown');
    if (facts.LoadState === 'not-found') check(source.optional === true && facts.ActiveState === 'inactive'
        && facts.UnitFileState === '' && facts.FragmentPath === '' && facts.DropInPaths === ''
        && facts.ExecStart === '' && facts.ExecStartPre === '' && facts.ControlGroup === '', 'absence_unknown');
    if (!facts.ControlGroup) {
        check(facts.ActiveState === 'inactive' && domainMembers(source, deps).length === 0, 'inactive_domain_unknown');
        return facts;
    }
    check(facts.ControlGroup === source.cgroupPath, 'unit_domain_changed');
    const groups = deps.cgroups || (pid => fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8'));
    const daemonPid = config.forwardActivation.supervisorPlan.pm2.observer.daemon?.pid;
    check(Number.isSafeInteger(daemonPid) && daemonPid > 0, 'daemon_identity_missing');
    for (const pid of [process.pid, daemonPid]) check(!groups(pid).split('\n').some(line => line.endsWith(`:${facts.ControlGroup}`)
        || line.includes(`:${facts.ControlGroup}/`)), 'operator_in_target_domain');
    return facts;
}
/** Validate prepared configuration without effects or journal writes. */
export function preflightFirstForwardConfiguration(config, deps = {}) {
    validateFirstForwardPlans(config); inspectInventory(config);
    const pin = deps.pin || readPinnedForwardBytes; const record = deps.pinnedRecord || readPinnedForwardRecord;
    const settings = config.forwardMigration; const request = record(settings.request); const contract = record(settings.contract);
    check(settings.closure.sha256 === config.expected.forwardExecutableClosureSha256, 'closure_pin_changed');
    const closure = JSON.parse(pin(settings.closure));
    check(closure.schema === 'nassaj-forward-child-closure/v1' && Array.isArray(closure.files) && closure.files.length > 0, 'closure_invalid');
    for (const entry of closure.files) pin(entry);
    for (const entry of [settings.node, settings.parent, settings.wrapper, settings.entry, config.forwardActivation.safeRestart, config.forwardActivation.dispatcher]) pin(entry);
    const identity = config.bootstrapClaim.identity; const db = fs.statSync(config.databaseFile, { bigint: true });
    check(request.schema === 'nassaj-compatible-forward-request/v1' && request.expectedPhase === 'migration'
        && request.releaseIdentitySha256 === identity.releaseIdentitySha256 && request.databaseContractSha256 === digest(contract)
        && digest(contract) === identity.databaseContractSha256 && contract.schema === 'nassaj-database-release-contract/v2'
        && request.database.realpath === config.databaseFile && fs.realpathSync(config.databaseFile) === config.databaseFile
        && String(db.dev) === String(request.database.device) && String(db.ino) === String(request.database.inode)
        && String(db.dev) === String(identity.databaseDev) && String(db.ino) === String(identity.databaseIno), 'material_invalid');
    for (const source of config.forwardActivation.supervisorPlan.sources) sourceBefore(source, config.forwardActivation.supervisorPlan.slot);
    for (const source of config.forwardActivation.mutatorPlan.sources) inspectUnitPreflight(config, source, deps);
    return request;
}
async function closeGate(config, journal, state, deps) {
    const request = { schema: 'nassaj-first-forward-gate-request/v1', operationId: journal.transactionId, generationEpoch: state.generationEpoch };
    const raw = await new Promise((resolve, reject) => {
        const child = (deps.execGate || execFile)(config.forwardMigration.node.path,
            [config.forwardActivation.dispatcher.path, 'closeFirstForwardGate'],
            { encoding: 'utf8', timeout: 30000, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LC_ALL: 'C' } },
            (error, stdout) => error ? reject(error) : resolve(stdout));
        child.stdin.end(`${JSON.stringify(request)}\n`);
    });
    const receipt = JSON.parse(raw);
    check(receipt.schema === 'nassaj-first-forward-ingress-receipt/v1' && receipt.operationId === journal.transactionId
        && receipt.generationEpoch === state.generationEpoch && receipt.phase === 'closed'
        && /^[a-f0-9]{64}$/.test(receipt.hostProofSha256 || ''), 'gate_receipt_invalid');
    return receipt;
}
/** Accept signed initial authority, fence offers, close ingress and inhibit each reviewed source. */
export async function initializeFirstForwardOperation(config, deps = {}) {
    check((deps.uid?.() ?? process.geteuid?.()) === 0, 'root_required');
    const request = preflightFirstForwardConfiguration(config, deps);
    await observeExpectedRuntime(config, false, deps);
    let journal = withCutoverStateLock(config.controlRoot, () => {
        check(!fs.existsSync(file(config, 'first-cutover.json')), 'existing_operation_requires_reconciliation');
        const approval = (deps.readRoot || readForwardRootRecord)(config.bootstrapClaim.approvalFile);
        const operator = (deps.inspectProcess || inspectForwardChildIdentity)(process.pid);
        const initial = { schema: 'nassaj-release-runtime-cutover/v1', transactionId: request.transactionId,
            expected: config.expected, state: 'running', phase: 'forward_prepare_intent', revision: 1,
            approvalSha256: digest(approval), approvalAcceptedAt: Date.now(), forwardEffects: [],
            operator: { pid: operator.pid, startTicks: operator.startTicks, bootId: operator.bootId },
            forwardAttemptNonce: randomBytes(32).toString('hex'), forwardBootId: operator.bootId };
        assertOwner(config, initial, deps);
        const old = fs.existsSync(file(config, 'startup-admission.json')) ? read(config, 'startup-admission.json', deps) : null;
        check(!old || (old.schema === 'nassaj-startup-admission/v1' && !old.revocation && !old.managedOperationId && old.state !== 'active' && !old.transitionReason && !old.lastClaim && !old.potentiallyRunningClaim), 'existing_admission_requires_reconciliation');
        const state = { schema: 'nassaj-startup-admission/v1', identity: config.bootstrapClaim.identity,
            authorityId: initial.transactionId, approvalSha256: initial.approvalSha256, state: 'switching',
            generationEpoch: increment(old?.generationEpoch ?? 0), revision: increment(old?.revision ?? 0), offer: null };
        initial.forwardAdmission = { generationEpoch: state.generationEpoch, revision: state.revision, sha256: digest(state) };
        // Journal first: any crash before the fence is complete blocks this operation rather than reusing authority.
        write(config, 'first-cutover.json', initial); write(config, 'startup-admission.json', state);
        return initial;
    });
    await observeExpectedRuntime(config, false, deps);
    current(config, deps);
    const gate = await closeGate(config, journal, current(config, deps).state, deps);
    journal = transition(config, journal, 'forward_prepare_intent', { forwardGateReceipt: gate }, deps);
    inspectInventory(config);
    for (const source of config.forwardActivation.mutatorPlan.sources.filter(item => !item.optional)) {
        journal = await applyUnitEffect(config, journal, source, 'mask', deps);
        journal = await applyUnitEffect(config, journal, source, 'stop', deps);
    }
    const absentSources = [];
    for (const source of config.forwardActivation.mutatorPlan.sources.filter(item => item.optional)) {
        const facts = inspectUnitPreflight(config, source, deps);
        if (facts.LoadState !== 'not-found') {
            journal = await applyUnitEffect(config, journal, source, 'mask', deps);
            journal = await applyUnitEffect(config, journal, source, 'stop', deps);
        } else absentSources.push(source);
    }
    for (const source of absentSources) {
        check(inspectUnitPreflight(config, source, deps).LoadState === 'not-found', 'absent_unit_appeared');
        journal = appendEffect(config, journal, 'unit-absent', source, 'observed', inhibitorProof(config, source, deps), deps);
    }
    const inhibitors = config.forwardActivation.mutatorPlan.sources.map(source => inhibitorProof(config, source, deps));
    return transition(config, journal, 'retirement_prepared', { forwardInhibitors: inhibitors }, deps);
}
/** Produce complete retirement only after the separate pinned supervisor stop/delete phase finished. */
export async function completeFirstForwardRetirement(config, deps = {}) {
    let { journal } = current(config, deps); check(journal.phase === 'supervisor_stopped', 'supervisor_not_stopped');
    validateFirstForwardPlans(config); inspectInventory(config);
    const settings = config.forwardActivation; const sources = [];
    for (const source of settings.supervisorPlan.sources) {
        await observeExpectedRuntime(config, true, deps);
        current(config, deps);
        settings.mutatorPlan.sources.forEach(item => inhibitorProof(config, item, deps));
        const planned = sourceBefore(source, settings.supervisorPlan.slot);
        journal = appendEffect(config, journal, 'saved-definition', source, 'intent', { beforeSha256: source.beforeSha256 }, deps);
        let receipt;
        withCutoverStateLock(config.controlRoot, () => {
            check(digest(current(config, deps).journal) === digest(journal), 'journal_changed');
            receipt = planned ? retireForwardSavedDefinition(source, settings.supervisorPlan.slot)
                : { sourceId: source.sourceId, path: source.path, format: source.format, beforeSha256: null,
                    afterSha256: null, oldTargetAbsent: true, unaffectedEntriesSha256: digest([]), durable: true };
        });
        journal = appendEffect(config, journal, 'saved-definition', source, 'observed',
            { intentSha256: journal.forwardEffects.at(-1).factsSha256, receipt }, deps); sources.push(receipt);
    }
    const observed = await (deps.observe || observePinnedPm2Runtime)(settings.supervisorPlan.pm2.observer, deps.observer);
    const slot = settings.supervisorPlan.slot;
    check(observed.entries.every(entry => entry.name !== slot.name || entry.namespace !== slot.namespace), 'old_slot_present');
    const old = config.oldProcess;
    try { const actual = (deps.inspectProcess || inspectForwardChildIdentity)(old.pid);
        check(actual.startTicks !== oldStart(old) || actual.bootId !== old.bootId, 'old_process_alive');
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    const receipt = { schema: 'nassaj-forward-retirement/v1', transactionId: journal.transactionId,
        attemptNonce: journal.forwardAttemptNonce, revision: increment(journal.revision), bootId: journal.forwardBootId,
        supervisorPlanSha256: config.expected.supervisorPlanSha256, mutatorPlanSha256: config.expected.mutatorPlanSha256,
        runtime: { namespaceSha256: observed.observationSha256, oldTargetAbsent: true, unaffectedEntriesSha256: digest(observed.entries) }, sources,
        inhibitors: settings.mutatorPlan.sources.map(source => inhibitorProof(config, source, deps)),
        retiredProcess: { pid: old.pid, startTicks: oldStart(old), bootId: old.bootId, exitProven: true } };
    receipt.factsSha256 = digest(receipt);
    await (deps.verifyRetirement || verifyForwardRetirement)(config, { ...journal, forwardRetirement: receipt }, deps.retirement);
    return transition(config, journal, 'retirement_verified', { forwardRetirement: receipt }, deps);
}
