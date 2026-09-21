/** Pure metadata contract only: no host observation, durable claim, or execution authority. */
import { isProxy } from 'node:util/types';

export const RECONCILIATION_SERVICES = Object.freeze([
    'managed-service-a', 'managed-service-b', 'managed-service-c', 'managed-service-d', 'managed-service-e', 'nassaj-dev',
]);
export const RECONCILIATION_STATES = Object.freeze([
    'PRECHECK', 'DRAIN', 'DUPLICATE_STOP_INTENT', 'DUPLICATE_STOPPED',
    'ORIGINAL_STOP_INTENT', 'ALL_STOPPED', 'START_INTENT', 'VERIFYING', 'VERIFIED', 'UNKNOWN',
]);
const PLAN_SCHEMA = 'nassaj-pm2-reconciliation-plan/v1';
const RECORD_SCHEMA = 'nassaj-pm2-reconciliation-record/v1';
const INTENTS = ['DUPLICATE_STOP_INTENT', 'ORIGINAL_STOP_INTENT', 'START_INTENT'];
const fail = code => { throw new Error(`pm2_reconciliation_${code}`); };
const requireValue = (condition, code) => { if (!condition) fail(code); };

function validateData(value, ancestors = new Set()) {
    if (value === null || ['string', 'boolean'].includes(typeof value)) return;
    if (typeof value === 'number') { requireValue(Number.isFinite(value), 'data_invalid'); return; }
    requireValue(typeof value === 'object' && !isProxy(value), 'data_invalid');
    requireValue(!ancestors.has(value), 'data_cycle');
    const array = Array.isArray(value);
    requireValue(Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype), 'object_invalid');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (array) {
        const length = descriptors.length.value;
        requireValue(keys.length === length + 1 && keys.every(key => key === 'length'
            || (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < length)), 'array_invalid');
    }
    ancestors.add(value);
    for (const key of keys) {
        if (array && key === 'length') continue;
        requireValue(typeof key === 'string' && key !== 'toJSON', 'keys_invalid');
        const descriptor = descriptors[key];
        requireValue(Object.hasOwn(descriptor, 'value'), 'accessor_invalid');
        requireValue(descriptor.enumerable, 'data_invalid');
        validateData(descriptor.value, ancestors);
    }
    ancestors.delete(value);
}
function sameData(left, right) {
    if (left === right) return true;
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
    const keys = Object.keys(left);
    return Array.isArray(left) === Array.isArray(right) && keys.length === Object.keys(right).length
        && keys.every(key => Object.hasOwn(right, key) && sameData(left[key], right[key]));
}
function exact(value, keys) {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype, 'object_invalid');
    const own = Reflect.ownKeys(value);
    requireValue(own.length === keys.length && own.every(key => keys.includes(key)), 'keys_invalid');
    requireValue(own.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')), 'accessor_invalid');
}
function digest(value) { requireValue(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'digest_invalid'); }
function uuid(value) { requireValue(typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value), 'id_invalid'); }
function identity(value) {
    exact(value, ['pid', 'startTicks']);
    requireValue(Number.isSafeInteger(value.pid) && value.pid > 1, 'pid_invalid');
    requireValue(typeof value.startTicks === 'string' && /^[1-9][0-9]{0,19}$/.test(value.startTicks), 'start_ticks_invalid');
}
function sameIdentity(left, right) { return left.pid === right.pid && left.startTicks === right.startTicks; }
function services(values, keys, validate) {
    requireValue(Array.isArray(values) && values.length === RECONCILIATION_SERVICES.length, 'services_invalid');
    const names = [];
    for (const value of values) {
        exact(value, keys);
        requireValue(RECONCILIATION_SERVICES.includes(value.name) && !names.includes(value.name), 'service_name_invalid');
        names.push(value.name);
        validate(value);
    }
}
function validatePlan(plan) {
    exact(plan, ['schema', 'bootId', 'attemptId', 'snapshotSha256', 'original', 'duplicate', 'executor', 'services']);
    requireValue(plan.schema === PLAN_SCHEMA, 'plan_schema_invalid');
    uuid(plan.bootId); uuid(plan.attemptId); digest(plan.snapshotSha256);
    for (const role of ['original', 'duplicate', 'executor']) identity(plan[role]);
    requireValue(new Set([plan.original.pid, plan.duplicate.pid, plan.executor.pid]).size === 3, 'identity_collision');
    services(plan.services, ['name', 'generationSha256', 'admissionGuardSha256'], service => {
        digest(service.generationSha256); digest(service.admissionGuardSha256);
    });
}
function validateBinding(binding, plan) {
    exact(binding, ['bootId', 'attemptId', 'snapshotSha256', 'original', 'duplicate', 'executor']);
    for (const key of ['bootId', 'attemptId', 'snapshotSha256']) {
        requireValue(binding[key] === plan[key], `${key}_changed`);
    }
    for (const role of ['original', 'duplicate', 'executor']) {
        identity(binding[role]);
        requireValue(sameIdentity(binding[role], plan[role]), `${role}_changed`);
    }
}
function trueFields(value, keys) {
    exact(value, keys);
    requireValue(keys.every(key => value[key] === true), 'proof_missing');
}
function gates(values, plan) {
    services(values, ['name', 'guardSha256', 'closed', 'activeWork'], gate => {
        const expected = plan.services.find(service => service.name === gate.name);
        requireValue(gate.guardSha256 === expected.admissionGuardSha256, 'guard_changed');
        requireValue(gate.closed === true && gate.activeWork === 0, 'not_quiescent');
    });
}
function fencedEvidence(evidence, plan, extra = []) {
    exact(evidence, ['gates', 'launchersInhibited', ...extra]);
    gates(evidence.gates, plan);
    requireValue(evidence.launchersInhibited === true, 'launcher_not_inhibited');
}
function verifiedEvidence(evidence, plan) {
    exact(evidence, ['supervisor', 'rpcPeer', 'pubPeer', 'pidfile', 'services',
        'singleSupervisor', 'moduleInventoryVerified', 'definitionsPersisted', 'launchersRestored']);
    identity(evidence.supervisor);
    requireValue(![plan.original.pid, plan.duplicate.pid, plan.executor.pid].includes(evidence.supervisor.pid), 'supervisor_identity_invalid');
    for (const peer of ['rpcPeer', 'pubPeer', 'pidfile']) {
        identity(evidence[peer]);
        requireValue(sameIdentity(evidence[peer], evidence.supervisor), 'supervisor_peer_mismatch');
    }
    const childPids = new Set([evidence.supervisor.pid, plan.executor.pid]);
    services(evidence.services, ['name', 'generationSha256', 'child', 'parentPid',
        'listenerOwned', 'writerExclusive', 'functionalHealthy'], service => {
        identity(service.child);
        requireValue(!childPids.has(service.child.pid), 'child_identity_collision');
        childPids.add(service.child.pid);
        requireValue(service.parentPid === evidence.supervisor.pid, 'child_parent_mismatch');
        requireValue(service.generationSha256 === plan.services.find(entry => entry.name === service.name).generationSha256, 'generation_changed');
        requireValue(service.listenerOwned === true && service.writerExclusive === true
            && service.functionalHealthy === true, 'service_verification_failed');
    });
    requireValue(['singleSupervisor', 'moduleInventoryVerified', 'definitionsPersisted', 'launchersRestored']
        .every(key => evidence[key] === true), 'verification_incomplete');
}
function validateEvidence(event, plan) {
    const proof = event.evidence;
    switch (event.to) {
    case 'DRAIN':
    case 'DUPLICATE_STOP_INTENT': fencedEvidence(proof, plan); break;
    case 'DUPLICATE_STOPPED':
        trueFields(proof, ['duplicateStopped', 'duplicateDescendantsStopped', 'originalHealthy']); break;
    case 'ORIGINAL_STOP_INTENT':
        fencedEvidence(proof, plan, ['duplicateStopped']);
        requireValue(proof.duplicateStopped === true, 'duplicate_not_stopped'); break;
    case 'ALL_STOPPED':
        trueFields(proof, ['originalStopped', 'duplicateStopped', 'descendantsStopped',
            'listenersStopped', 'writersStopped', 'noReplacement']); break;
    case 'START_INTENT':
        fencedEvidence(proof, plan, ['allStopped', 'snapshotRestoredSha256']);
        requireValue(proof.allStopped === true, 'not_all_stopped');
        requireValue(proof.snapshotRestoredSha256 === plan.snapshotSha256, 'snapshot_changed'); break;
    case 'VERIFYING': trueFields(proof, ['attemptObserved']); break;
    case 'VERIFIED': verifiedEvidence(proof, plan); break;
    case 'UNKNOWN':
        exact(proof, ['reason']);
        requireValue(['effect_outcome_unknown', 'observation_drift', 'interrupted'].includes(proof.reason), 'unknown_reason_invalid'); break;
    default: fail('state_invalid');
    }
}
function applyEvent(current, event, plan) {
    exact(event, ['to', 'binding', 'evidence']);
    requireValue(!['UNKNOWN', 'VERIFIED'].includes(current.state), 'terminal_state');
    const next = RECONCILIATION_STATES[RECONCILIATION_STATES.indexOf(current.state) + 1];
    requireValue(event.to === 'UNKNOWN' || event.to === next, 'transition_invalid');
    validateBinding(event.binding, plan); validateEvidence(event, plan);
    const lastEffect = INTENTS.includes(event.to) ? event : current.lastEffect;
    const startAttempts = current.startAttempts + Number(event.to === 'START_INTENT');
    requireValue(startAttempts <= 1, 'start_already_attempted');
    return { state: event.to, lastEffect, startAttempts };
}
function replay(record) {
    exact(record, ['schema', 'plan', 'events', 'state', 'lastEffect', 'startAttempts']);
    requireValue(record.schema === RECORD_SCHEMA, 'record_schema_invalid');
    validatePlan(record.plan);
    if (record.lastEffect !== null) {
        exact(record.lastEffect, ['to', 'binding', 'evidence']);
        requireValue(INTENTS.includes(record.lastEffect.to), 'last_effect_invalid');
        validateBinding(record.lastEffect.binding, record.plan);
        validateEvidence(record.lastEffect, record.plan);
    }
    requireValue(Array.isArray(record.events) && record.events.length <= 9, 'events_invalid');
    let current = { state: 'PRECHECK', lastEffect: null, startAttempts: 0 };
    for (const event of record.events) current = applyEvent(current, event, record.plan);
    requireValue(record.state === current.state && record.startAttempts === current.startAttempts
        && sameData(record.lastEffect, current.lastEffect), 'record_projection_invalid');
    return current;
}
function frozenCopy(value) {
    if (value === null || typeof value !== 'object') return value;
    const copy = Array.isArray(value) ? [] : {};
    for (const key of Object.keys(value)) {
        Object.defineProperty(copy, key, { value: frozenCopy(value[key]), enumerable: true });
    }
    return Object.freeze(copy);
}

/** Validate fixed six-service metadata and return an immutable PRECHECK journal; performs no I/O. */
export function createReconciliation(plan) {
    validateData(plan);
    validatePlan(plan);
    return frozenCopy({ schema: RECORD_SCHEMA, plan, events: [], state: 'PRECHECK', lastEffect: null, startAttempts: 0 });
}

/** Validate the full history, then append one transition; intents still require external durable claims. */
export function advanceReconciliation(record, event) {
    validateData(record); validateData(event);
    const current = replay(record);
    const next = applyEvent(current, event, record.plan);
    return frozenCopy({ ...record, ...next, events: [...record.events, event] });
}

/** Replay metadata to inspect its internally consistent state; never certifies actual host evidence. */
export function inspectReconciliation(record) {
    validateData(record);
    return frozenCopy(replay(record));
}
