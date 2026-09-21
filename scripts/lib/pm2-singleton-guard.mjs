/** Fail-closed, effect-free PM2 singleton admission for an externally held lease. */
import path from 'node:path';
import { isProxy } from 'node:util/types';

const REQUEST_SCHEMA = 'nassaj-pm2-singleton-guard-request/v1';
const OBSERVATION_SCHEMA = 'nassaj-pm2-singleton-observation/v1';
const DECISION_SCHEMA = 'nassaj-pm2-singleton-decision/v1';
const LEASE_SCHEMA = 'nassaj-pm2-singleton-lease/v1';
const ATTEMPT_SCHEMA = 'nassaj-pm2-singleton-attempt/v1';
const EVENT_SCHEMA = 'nassaj-pm2-singleton-attempt-event/v1';
const MODES = Object.freeze(['require-existing', 'allow-create']);
const ATTEMPT_STATES = Object.freeze(['PRECHECKED', 'EFFECT_INTENT', 'EFFECT_SENT', 'POSTCHECKED', 'UNKNOWN']);
const SOCKET_NAMES = Object.freeze(['rpc', 'pub']);
// In-process capabilities only: they are intentionally neither serializable nor recoverable after module/process reload.
// A future resume protocol needs an independently authenticated durable binding outside this module.
const ISSUED_DECISIONS = new WeakSet();
const UNUSED_DECISIONS = new WeakSet();
const ATTEMPT_DECISIONS = new WeakMap();
const fail = code => { throw new Error(`pm2_singleton_guard_${code}`); };
const requireValue = (condition, code) => { if (!condition) fail(code); };

function plain(value, keys) {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value)
        && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype, 'object_invalid');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const own = Reflect.ownKeys(descriptors);
    requireValue(own.length === keys.length && own.every(key => typeof key === 'string'
        && keys.includes(key) && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable), 'keys_invalid');
}

function integer(value, code, minimum = 0) {
    requireValue(Number.isSafeInteger(value) && value >= minimum, code);
}

function permissionBits(value, code) {
    integer(value, code);
    requireValue(value <= 0o7777, code);
}

function identity(value) {
    plain(value, ['pid', 'startTicks', 'uid', 'exe', 'bootId']);
    integer(value.pid, 'pid_invalid', 2); integer(value.uid, 'uid_invalid');
    requireValue(typeof value.startTicks === 'string' && /^[1-9][0-9]{0,19}$/.test(value.startTicks), 'start_ticks_invalid');
    requireValue(typeof value.exe === 'string' && path.isAbsolute(value.exe), 'exe_invalid');
    requireValue(typeof value.bootId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.bootId), 'boot_id_invalid');
}

function sameIdentity(left, right) {
    return ['pid', 'startTicks', 'uid', 'exe', 'bootId'].every(key => left[key] === right[key]);
}

function home(value) {
    plain(value, ['path', 'canonicalPath', 'uid', 'gid', 'mode', 'dev', 'ino']);
    requireValue(typeof value.path === 'string' && path.isAbsolute(value.path)
        && value.path === path.normalize(value.path), 'home_path_invalid');
    requireValue(value.canonicalPath === value.path, 'home_not_canonical');
    integer(value.uid, 'uid_invalid'); integer(value.gid, 'gid_invalid'); permissionBits(value.mode, 'home_mode_invalid');
    integer(value.dev, 'home_identity_invalid', 1); integer(value.ino, 'home_identity_invalid', 1);
    requireValue(value.mode === 0o700, 'home_mode_invalid');
}

function lease(value, expectedHome, request) {
    plain(value, ['schema', 'held', 'exclusive', 'verified', 'homeDev', 'homeIno', 'owner']);
    requireValue(value.schema === LEASE_SCHEMA, 'lease_schema_invalid');
    requireValue(value.held === true && value.exclusive === true && value.verified === true, 'lease_unverified');
    requireValue(value.homeDev === expectedHome.dev && value.homeIno === expectedHome.ino, 'lease_home_changed');
    identity(value.owner);
    requireValue(value.owner.uid === request.ownerUid && value.owner.bootId === request.bootId, 'lease_owner_invalid');
}

function manager(value, expectedHome, bootId) {
    plain(value, ['readable', 'homePath', 'identity']);
    requireValue(value.readable === true, 'candidate_unreadable');
    requireValue(value.homePath === expectedHome.path, 'manager_home_changed');
    identity(value.identity);
    requireValue(value.identity.uid === expectedHome.uid && value.identity.bootId === bootId, 'manager_identity_invalid');
}

function absentArtifact(value) {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value) && !isProxy(value), 'object_invalid');
    const state = Object.getOwnPropertyDescriptor(value, 'state');
    requireValue(state && Object.hasOwn(state, 'value') && state.enumerable, 'keys_invalid');
    requireValue(state.value === 'absent', 'stale_artifact');
    plain(value, ['state']);
}

function presentArtifactShape(value, socket) {
    const keys = socket
        ? ['state', 'dev', 'ino', 'uid', 'mode', 'peer', 'netns']
        : ['state', 'dev', 'ino', 'uid', 'mode', 'pid', 'fdDev', 'fdIno'];
    plain(value, keys);
    requireValue(value.state === 'present', 'artifact_invalid');
    integer(value.dev, 'artifact_identity_invalid', 1); integer(value.ino, 'artifact_identity_invalid', 1);
    integer(value.uid, 'artifact_owner_invalid'); permissionBits(value.mode, 'artifact_mode_invalid');
    const groupWritable = Math.floor(value.mode / 0o20) % 2 === 1;
    const worldWritable = Math.floor(value.mode / 0o2) % 2 === 1;
    requireValue(!groupWritable && !worldWritable, 'artifact_permissions_invalid');
    if (socket) {
        identity(value.peer);
        requireValue(typeof value.netns === 'string' && /^net:\[[1-9][0-9]*\]$/.test(value.netns), 'socket_netns_invalid');
    } else {
        integer(value.pid, 'pidfile_pid_invalid', 2);
        integer(value.fdDev, 'pidfile_fd_invalid', 1); integer(value.fdIno, 'pidfile_fd_invalid', 1);
    }
}

function presentArtifact(value, expectedHome, expectedManager, socket) {
    presentArtifactShape(value, socket);
    requireValue(value.uid === expectedHome.uid, 'artifact_owner_invalid');
    if (socket) requireValue(sameIdentity(value.peer, expectedManager), 'socket_peer_mismatch');
    else {
        requireValue(value.pid === expectedManager.pid && value.dev === value.fdDev && value.ino === value.fdIno,
            'pidfile_identity_mismatch');
    }
}

function validateObservation(value, request) {
    plain(value, ['schema', 'home', 'bootId', 'scanComplete', 'candidates', 'pidfile', 'rpc', 'pub']);
    requireValue(value.schema === OBSERVATION_SCHEMA, 'observation_schema_invalid');
    home(value.home); requireValue(value.home.path === request.homePath && value.home.uid === request.ownerUid
        && value.home.gid === request.ownerGid, 'home_changed');
    requireValue(value.bootId === request.bootId, 'boot_changed');
    requireValue(value.scanComplete === true, 'process_scan_incomplete');
    requireValue(Array.isArray(value.candidates) && !isProxy(value.candidates)
        && Object.getPrototypeOf(value.candidates) === Array.prototype, 'candidates_invalid');
    const entries = Object.getOwnPropertyDescriptors(value.candidates);
    const keys = Reflect.ownKeys(entries); const length = entries.length?.value;
    requireValue(Number.isSafeInteger(length) && keys.length === length + 1 && keys.every(key => key === 'length'
        || (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < length
            && Object.hasOwn(entries[key], 'value') && entries[key].enumerable)), 'candidates_invalid');
    requireValue(value.candidates.length <= 2, 'manager_count_invalid');
    for (const candidate of value.candidates) manager(candidate, value.home, value.bootId);
    requireValue(new Set(value.candidates.map(candidate => candidate.identity.pid)).size === value.candidates.length,
        'manager_duplicate_invalid');
    for (const name of ['pidfile', ...SOCKET_NAMES]) {
        if (request.mode === 'allow-create') absentArtifact(value[name]);
        else presentArtifactShape(value[name], name !== 'pidfile');
    }
    return value;
}

function sameHome(left, right) {
    return ['path', 'canonicalPath', 'uid', 'gid', 'mode', 'dev', 'ino'].every(key => left[key] === right[key]);
}

function sameArtifact(left, right, socket) {
    if (left.state !== right.state) return false;
    if (left.state === 'absent') return true;
    const fields = socket ? ['dev', 'ino', 'uid', 'mode', 'netns']
        : ['dev', 'ino', 'uid', 'mode', 'pid', 'fdDev', 'fdIno'];
    return fields.every(key => left[key] === right[key]) && (!socket || sameIdentity(left.peer, right.peer));
}

function sameObservation(left, right) {
    if (left.schema !== right.schema || left.bootId !== right.bootId || left.scanComplete !== right.scanComplete
        || !sameHome(left.home, right.home) || left.candidates.length !== right.candidates.length) return false;
    const managersMatch = left.candidates.every((candidate, index) => candidate.readable === right.candidates[index].readable
        && candidate.homePath === right.candidates[index].homePath
        && sameIdentity(candidate.identity, right.candidates[index].identity));
    return managersMatch && sameArtifact(left.pidfile, right.pidfile, false)
        && sameArtifact(left.rpc, right.rpc, true) && sameArtifact(left.pub, right.pub, true);
}

function validateRequest(request) {
    plain(request, ['schema', 'mode', 'homePath', 'ownerUid', 'ownerGid', 'bootId', 'expectedExecutable']);
    requireValue(request.schema === REQUEST_SCHEMA, 'request_schema_invalid');
    requireValue(MODES.includes(request.mode), 'mode_invalid');
    requireValue(typeof request.homePath === 'string' && path.isAbsolute(request.homePath)
        && request.homePath === path.normalize(request.homePath), 'home_path_invalid');
    integer(request.ownerUid, 'uid_invalid'); integer(request.ownerGid, 'gid_invalid');
    requireValue(typeof request.bootId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.bootId),
        'boot_id_invalid');
    requireValue(typeof request.expectedExecutable === 'string' && path.isAbsolute(request.expectedExecutable),
        'exe_invalid');
}

function decideExisting(request, observation) {
    requireValue(observation.candidates.length === 1, observation.candidates.length ? 'multiple_managers' : 'manager_missing');
    const found = observation.candidates[0].identity;
    requireValue(found.exe === request.expectedExecutable, 'manager_executable_changed');
    presentArtifact(observation.pidfile, observation.home, found, false);
    for (const name of SOCKET_NAMES) presentArtifact(observation[name], observation.home, found, true);
    requireValue(observation.rpc.netns === observation.pub.netns, 'socket_netns_mismatch');
    requireValue(observation.rpc.dev !== observation.pub.dev || observation.rpc.ino !== observation.pub.ino,
        'socket_identity_collision');
    return { action: 'use-existing', supervisor: found };
}

function decideCreate(observation) {
    requireValue(observation.candidates.length === 0, 'manager_already_exists');
    absentArtifact(observation.pidfile);
    for (const name of SOCKET_NAMES) absentArtifact(observation[name]);
    return { action: 'create-once', supervisor: null };
}

function frozen(value) {
    if (value === null || typeof value !== 'object') return value;
    const output = Array.isArray(value) ? [] : {};
    for (const key of Object.keys(value)) output[key] = frozen(value[key]);
    return Object.freeze(output);
}

/**
 * Admit one caller-owned PM2 effect after two identical observations under a verified exclusive lease.
 * This function performs no I/O and grants no authority to signal, delete, connect, or create sockets.
 */
export function decidePm2SingletonGuard(request, initial, rescan, heldLease) {
    validateRequest(request);
    const before = validateObservation(initial, request);
    const after = validateObservation(rescan, request);
    home(before.home); lease(heldLease, before.home, request);
    requireValue(sameObservation(before, after), 'observation_drift');
    const initialResult = request.mode === 'require-existing' ? decideExisting(request, before) : decideCreate(before);
    const result = request.mode === 'require-existing' ? decideExisting(request, after) : decideCreate(after);
    requireValue(initialResult.action === result.action, 'observation_drift');
    const decision = frozen({ schema: DECISION_SCHEMA, mode: request.mode, action: result.action,
        home: { path: after.home.path, canonicalPath: after.home.canonicalPath, uid: after.home.uid,
            gid: after.home.gid, mode: after.home.mode, dev: after.home.dev, ino: after.home.ino },
        leaseOwner: heldLease.owner, supervisor: result.supervisor,
        effect: { maximumAttempts: 1, retryOnUnknown: false, requiresLeaseHeldThroughEffect: true } });
    ISSUED_DECISIONS.add(decision);
    UNUSED_DECISIONS.add(decision);
    return decision;
}

function uuid(value) {
    requireValue(typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value),
        'attempt_id_invalid');
}

function validateDecision(value) {
    plain(value, ['schema', 'mode', 'action', 'home', 'leaseOwner', 'supervisor', 'effect']);
    requireValue(value.schema === DECISION_SCHEMA && MODES.includes(value.mode), 'decision_invalid');
    plain(value.home, ['path', 'canonicalPath', 'uid', 'gid', 'mode', 'dev', 'ino']);
    requireValue(typeof value.home.path === 'string' && path.isAbsolute(value.home.path)
        && value.home.canonicalPath === value.home.path, 'decision_invalid');
    integer(value.home.uid, 'decision_invalid'); integer(value.home.gid, 'decision_invalid');
    permissionBits(value.home.mode, 'decision_invalid');
    integer(value.home.dev, 'decision_invalid', 1); integer(value.home.ino, 'decision_invalid', 1);
    identity(value.leaseOwner);
    plain(value.effect, ['maximumAttempts', 'retryOnUnknown', 'requiresLeaseHeldThroughEffect']);
    requireValue(value.effect.maximumAttempts === 1 && value.effect.retryOnUnknown === false
        && value.effect.requiresLeaseHeldThroughEffect === true, 'decision_invalid');
    const existing = value.mode === 'require-existing';
    requireValue(value.action === (existing ? 'use-existing' : 'create-once'), 'decision_invalid');
    if (existing) identity(value.supervisor); else requireValue(value.supervisor === null, 'decision_invalid');
}

function bindingFromLease(value) {
    return { homeDev: value.homeDev, homeIno: value.homeIno, owner: value.owner };
}

function validateBinding(value) {
    plain(value, ['homeDev', 'homeIno', 'owner']);
    integer(value.homeDev, 'lease_home_changed', 1); integer(value.homeIno, 'lease_home_changed', 1);
    identity(value.owner);
}

function sameBinding(left, right) {
    return left.homeDev === right.homeDev && left.homeIno === right.homeIno && sameIdentity(left.owner, right.owner);
}

function sameDecisionBinding(record, decision) {
    return record.mode === decision.mode && record.action === decision.action
        && sameHome(record.home, decision.home)
        && record.home.dev === record.leaseIdentity.homeDev && record.home.ino === record.leaseIdentity.homeIno
        && decision.home.dev === record.leaseIdentity.homeDev && decision.home.ino === record.leaseIdentity.homeIno
        && sameIdentity(record.leaseIdentity.owner, decision.leaseOwner);
}

function validateHeldLease(value) {
    plain(value, ['schema', 'held', 'exclusive', 'verified', 'homeDev', 'homeIno', 'owner']);
    requireValue(value.schema === LEASE_SCHEMA && value.held === true && value.exclusive === true && value.verified === true,
        'lease_unverified');
    integer(value.homeDev, 'lease_home_changed', 1); integer(value.homeIno, 'lease_home_changed', 1);
    identity(value.owner);
    return bindingFromLease(value);
}

function validateCurrentLease(value, binding) {
    const current = validateHeldLease(value);
    requireValue(sameBinding(current, binding), 'lease_identity_changed');
}

function exactArray(value) {
    requireValue(Array.isArray(value) && !isProxy(value) && Object.getPrototypeOf(value) === Array.prototype,
        'events_invalid');
    const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
    const length = descriptors.length?.value;
    requireValue(Number.isSafeInteger(length) && keys.length === length + 1 && keys.every(key => key === 'length'
        || (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < length
            && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable)), 'events_invalid');
}

function validateEvent(event, attemptId, binding) {
    plain(event, ['schema', 'attemptId', 'to', 'leaseIdentity', 'evidence']);
    requireValue(event.schema === EVENT_SCHEMA && event.attemptId === attemptId, 'attempt_changed');
    requireValue(ATTEMPT_STATES.includes(event.to) && event.to !== 'PRECHECKED', 'attempt_state_invalid');
    validateBinding(event.leaseIdentity);
    requireValue(sameBinding(event.leaseIdentity, binding), 'lease_identity_changed');
    if (event.to === 'EFFECT_INTENT') plain(event.evidence, ['action']);
    else if (event.to === 'EFFECT_SENT') plain(event.evidence, ['dispatch']);
    else if (event.to === 'POSTCHECKED') plain(event.evidence, ['result']);
    else plain(event.evidence, ['reason']);
}

function applyAttemptEvent(state, event, action) {
    const allowed = state === 'PRECHECKED' ? ['EFFECT_INTENT']
        : state === 'EFFECT_INTENT' ? ['EFFECT_SENT', 'UNKNOWN']
            : state === 'EFFECT_SENT' ? ['POSTCHECKED', 'UNKNOWN'] : [];
    requireValue(allowed.includes(event.to), state === 'UNKNOWN' ? 'unknown_terminal' : 'attempt_transition_invalid');
    if (event.to === 'EFFECT_INTENT') requireValue(event.evidence.action === action, 'attempt_action_changed');
    if (event.to === 'EFFECT_SENT') requireValue(event.evidence.dispatch === 'sent', 'dispatch_invalid');
    if (event.to === 'POSTCHECKED') requireValue(event.evidence.result === 'verified', 'postcheck_invalid');
    if (event.to === 'UNKNOWN') requireValue(['effect_outcome_unknown', 'interrupted', 'postcheck_failed']
        .includes(event.evidence.reason), 'unknown_reason_invalid');
    return event.to;
}

function validateAttempt(record) {
    plain(record, ['schema', 'attemptId', 'mode', 'action', 'home', 'leaseIdentity', 'state', 'events']);
    requireValue(record.schema === ATTEMPT_SCHEMA && MODES.includes(record.mode), 'attempt_invalid');
    uuid(record.attemptId); home(record.home); validateBinding(record.leaseIdentity);
    requireValue(record.home.dev === record.leaseIdentity.homeDev && record.home.ino === record.leaseIdentity.homeIno,
        'attempt_home_lease_mismatch');
    const expectedAction = record.mode === 'require-existing' ? 'use-existing' : 'create-once';
    requireValue(record.action === expectedAction, 'attempt_invalid');
    exactArray(record.events); requireValue(record.events.length <= 3, 'events_invalid');
    let state = 'PRECHECKED';
    for (const event of record.events) {
        validateEvent(event, record.attemptId, record.leaseIdentity);
        state = applyAttemptEvent(state, event, record.action);
    }
    requireValue(record.state === state, 'attempt_projection_invalid');
}

/**
 * Create a pure PRECHECKED attempt bound to this module instance's decision capability.
 * The returned attempt cannot be serialized and resumed as authority; reload requires a future authenticated binding.
 */
export function createPm2SingletonAttempt(decision, attemptId, heldLease) {
    requireValue(decision !== null && typeof decision === 'object' && ISSUED_DECISIONS.has(decision),
        'decision_provenance_invalid');
    requireValue(UNUSED_DECISIONS.has(decision), 'decision_capability_spent');
    validateDecision(decision); uuid(attemptId);
    const binding = validateHeldLease(heldLease);
    validateBinding(binding);
    requireValue(binding.homeDev === decision.home.dev && binding.homeIno === decision.home.ino
        && sameIdentity(binding.owner, decision.leaseOwner), 'lease_identity_changed');
    const record = frozen({ schema: ATTEMPT_SCHEMA, attemptId, mode: decision.mode, action: decision.action,
        home: decision.home, leaseIdentity: binding, state: 'PRECHECKED', events: [] });
    // Synchronous check-and-consume: every validation precedes this point and there is no asynchronous/effect boundary.
    requireValue(UNUSED_DECISIONS.delete(decision), 'decision_capability_spent');
    ATTEMPT_DECISIONS.set(record, decision);
    return record;
}

/** Advance only the original in-process attempt with its exact issuing decision object. */
export function advancePm2SingletonAttempt(record, input, heldLease, trustedDecision) {
    requireValue(trustedDecision !== null && typeof trustedDecision === 'object'
        && ISSUED_DECISIONS.has(trustedDecision), 'decision_provenance_invalid');
    requireValue(record !== null && typeof record === 'object' && ATTEMPT_DECISIONS.has(record),
        'attempt_capability_unavailable');
    requireValue(ATTEMPT_DECISIONS.get(record) === trustedDecision, 'decision_provenance_invalid');
    validateAttempt(record);
    validateDecision(trustedDecision);
    requireValue(sameDecisionBinding(record, trustedDecision), 'attempt_decision_changed');
    plain(input, ['schema', 'attemptId', 'to', 'evidence']);
    requireValue(input.schema === EVENT_SCHEMA && input.attemptId === record.attemptId, 'attempt_changed');
    validateCurrentLease(heldLease, record.leaseIdentity);
    const event = { ...input, leaseIdentity: record.leaseIdentity };
    validateEvent(event, record.attemptId, record.leaseIdentity);
    const state = applyAttemptEvent(record.state, event, record.action);
    const next = frozen({ ...record, state, events: [...record.events, event] });
    // Failed validation above leaves the stage usable; successful transition consumes it in this synchronous turn.
    requireValue(ATTEMPT_DECISIONS.delete(record), 'attempt_capability_unavailable');
    if (!['POSTCHECKED', 'UNKNOWN'].includes(state)) ATTEMPT_DECISIONS.set(next, trustedDecision);
    return next;
}
