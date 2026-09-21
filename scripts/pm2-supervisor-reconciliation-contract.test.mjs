import assert from 'node:assert/strict';
import test from 'node:test';
import {
    RECONCILIATION_SERVICES, RECONCILIATION_STATES,
    createReconciliation, advanceReconciliation, inspectReconciliation,
} from './lib/pm2-supervisor-reconciliation-contract.mjs';

const hash = letter => letter.repeat(64);
const copy = value => structuredClone(value);
const id = pid => ({ pid, startTicks: String(pid * 100) });
const EXPECTED_SERVICES = ['managed-service-a', 'managed-service-b', 'managed-service-c',
    'managed-service-d', 'managed-service-e', 'nassaj-dev'];
const EXPECTED_STATES = ['PRECHECK', 'DRAIN', 'DUPLICATE_STOP_INTENT', 'DUPLICATE_STOPPED',
    'ORIGINAL_STOP_INTENT', 'ALL_STOPPED', 'START_INTENT', 'VERIFYING', 'VERIFIED', 'UNKNOWN'];
function plan() {
    return {
        schema: 'nassaj-pm2-reconciliation-plan/v1',
        bootId: '00000000-0000-0000-0000-000000000001',
        attemptId: '00000000-0000-0000-0000-000000000002', snapshotSha256: hash('a'),
        original: id(100), duplicate: id(200), executor: id(300),
        services: EXPECTED_SERVICES.map(name => ({ name, generationSha256: hash('b'), admissionGuardSha256: hash('c') })),
    };
}
function event(to, input = plan()) {
    const { bootId, attemptId, snapshotSha256, original, duplicate, executor } = input;
    const gates = input.services.map(service => ({ name: service.name,
        guardSha256: service.admissionGuardSha256, closed: true, activeWork: 0 }));
    const fenced = { gates, launchersInhibited: true };
    const proofs = {
        DRAIN: fenced, DUPLICATE_STOP_INTENT: fenced,
        DUPLICATE_STOPPED: { duplicateStopped: true, duplicateDescendantsStopped: true, originalHealthy: true },
        ORIGINAL_STOP_INTENT: { ...fenced, duplicateStopped: true },
        ALL_STOPPED: { originalStopped: true, duplicateStopped: true, descendantsStopped: true,
            listenersStopped: true, writersStopped: true, noReplacement: true },
        START_INTENT: { ...fenced, allStopped: true, snapshotRestoredSha256: input.snapshotSha256 },
        VERIFYING: { attemptObserved: true },
        VERIFIED: { supervisor: id(400), rpcPeer: id(400), pubPeer: id(400), pidfile: id(400),
            singleSupervisor: true, moduleInventoryVerified: true, definitionsPersisted: true, launchersRestored: true,
            services: input.services.map((service, index) => ({ name: service.name, generationSha256: service.generationSha256,
                child: id(500 + index), parentPid: 400, listenerOwned: true, writerExclusive: true, functionalHealthy: true })) },
        UNKNOWN: { reason: 'effect_outcome_unknown' },
    };
    return copy({ to, binding: { bootId, attemptId, snapshotSha256, original, duplicate, executor }, evidence: proofs[to] });
}
function at(state) {
    let record = createReconciliation(plan());
    for (const next of EXPECTED_STATES.slice(1, EXPECTED_STATES.indexOf(state) + 1)) {
        record = advanceReconciliation(record, event(next));
    }
    return record;
}
function rejectsChange(base, mutate, operation, code) {
    const changed = copy(base); mutate(changed);
    assert.throws(() => operation(changed), new RegExp(`pm2_reconciliation_${code}`));
}

test('service names and state ordering match the independently fixed contract', () => {
    assert.deepEqual(RECONCILIATION_SERVICES, EXPECTED_SERVICES);
    assert.deepEqual(RECONCILIATION_STATES, EXPECTED_STATES);
});

test('complete ordered metadata path is immutable, serializable and has one start attempt', () => {
    const original = plan(); const record = createReconciliation(original);
    original.original.pid = 999;
    assert.equal(record.plan.original.pid, 100);
    assert.throws(() => { record.plan.services[0].name = 'other'; }, TypeError);
    const completed = at('VERIFIED');
    assert.equal(completed.events.length, 8);
    assert.deepEqual(inspectReconciliation(JSON.parse(JSON.stringify(completed))), {
        state: 'VERIFIED', startAttempts: 1, lastEffect: event('START_INTENT'),
    });
    assert.throws(() => advanceReconciliation(completed, event('START_INTENT')), /terminal_state/);
});

const invalidPlans = [
    ['schema', p => { p.schema = 'v2'; }, 'plan_schema_invalid'],
    ['extra field', p => { p.environment = { SECRET: 'never-allowed' }; }, 'keys_invalid'],
    ['missing service', p => { p.services.pop(); }, 'services_invalid'],
    ['extra service', p => { p.services.push(copy(p.services[0])); }, 'services_invalid'],
    ['unknown service', p => { p.services[0].name = 'other'; }, 'service_name_invalid'],
    ['duplicate service', p => { p.services[0].name = p.services[1].name; }, 'service_name_invalid'],
    ['missing guard', p => { delete p.services[0].admissionGuardSha256; }, 'keys_invalid'],
    ['invalid guard', p => { p.services[0].admissionGuardSha256 = ''; }, 'digest_invalid'],
    ['extra service metadata', p => { p.services[0].env = {}; }, 'keys_invalid'],
    ['invalid boot', p => { p.bootId = 'boot'; }, 'id_invalid'],
    ['invalid snapshot', p => { p.snapshotSha256 = 'path/to/dump'; }, 'digest_invalid'],
    ['invalid pid', p => { p.original.pid = 1; }, 'pid_invalid'],
    ['unsafe integer pid', p => { p.original.pid = Number.MAX_SAFE_INTEGER + 1; }, 'pid_invalid'],
    ['numeric ticks', p => { p.original.startTicks = 123; }, 'start_ticks_invalid'],
    ['zero ticks', p => { p.original.startTicks = '0'; }, 'start_ticks_invalid'],
    ['identity collision', p => { p.duplicate.pid = p.original.pid; }, 'identity_collision'],
];
for (const [name, mutate, code] of invalidPlans) {
    test(`plan rejects ${name}`, () => rejectsChange(plan(), mutate, createReconciliation, code));
}
test('non-plain objects, symbols and accessors are rejected without invoking accessors', () => {
    for (const value of [null, [], 'bad', Object.create(null)]) assert.throws(() => createReconciliation(value), /object_invalid/);
    const symbolic = plan(); symbolic[Symbol('hidden')] = true;
    assert.throws(() => createReconciliation(symbolic), /keys_invalid/);
    const accessor = plan(); let invoked = false;
    Object.defineProperty(accessor, 'schema', { get() { invoked = true; return 'bad'; } });
    assert.throws(() => createReconciliation(accessor), /accessor_invalid/);
    assert.equal(invoked, false);
});

test('services.toJSON and lastEffect.toJSON refuse without calling either callback', () => {
    let calls = 0;
    const candidate = plan(); candidate.services.toJSON = () => { calls++; return []; };
    assert.throws(() => createReconciliation(candidate), /array_invalid/);
    const record = copy(at('START_INTENT'));
    record.lastEffect.toJSON = () => { calls++; return event('START_INTENT'); };
    assert.throws(() => inspectReconciliation(record), /keys_invalid/);
    assert.throws(() => advanceReconciliation(record, event('VERIFYING')), /keys_invalid/);
    assert.equal(calls, 0);
});

test('all input arrays reject sparse entries, extra keys, symbols, accessors and custom prototypes', () => {
    let calls = 0;
    const changes = [
        array => { delete array[0]; },
        array => { array.extra = true; },
        array => { array[Symbol('extra')] = true; },
        array => { Object.defineProperty(array, '0', { get() { calls++; return {}; } }); },
        array => { Object.setPrototypeOf(array, Object.create(Array.prototype)); },
        array => { Object.defineProperty(array, 'toJSON', { get() { calls++; return () => []; } }); },
    ];
    for (const change of changes) {
        const candidate = plan(); change(candidate.services);
        assert.throws(() => createReconciliation(candidate), /array_invalid|accessor_invalid|object_invalid/);
        const record = copy(at('DRAIN')); change(record.events);
        assert.throws(() => inspectReconciliation(record), /array_invalid|accessor_invalid|object_invalid/);
        const next = event('DRAIN'); change(next.evidence.gates);
        assert.throws(() => advanceReconciliation(at('PRECHECK'), next), /array_invalid|accessor_invalid|object_invalid/);
    }
    assert.equal(calls, 0);
});

test('lastEffect is validated structurally and input hooks are never invoked', () => {
    for (const effect of [[], {}, { to: 'START_INTENT' }]) {
        const record = copy(at('START_INTENT')); record.lastEffect = effect;
        assert.throws(() => inspectReconciliation(record), /object_invalid|keys_invalid/);
    }
    const record = copy(at('START_INTENT')); record.lastEffect = event('VERIFYING');
    assert.throws(() => inspectReconciliation(record), /last_effect_invalid/);
    let calls = 0;
    const candidate = plan();
    candidate.services[0] = new Proxy(candidate.services[0], { ownKeys() { calls++; return []; } });
    assert.throws(() => createReconciliation(candidate), /data_invalid/);
    const accessor = copy(at('START_INTENT'));
    Object.defineProperty(accessor.lastEffect, 'evidence', { get() { calls++; return {}; } });
    assert.throws(() => inspectReconciliation(accessor), /accessor_invalid/);
    assert.equal(calls, 0);
});

for (const key of ['bootId', 'attemptId', 'snapshotSha256']) {
    test(`all intent boundaries reject ${key} drift`, () => {
        for (const [from, to] of [['DRAIN', 'DUPLICATE_STOP_INTENT'], ['DUPLICATE_STOPPED', 'ORIGINAL_STOP_INTENT'], ['ALL_STOPPED', 'START_INTENT']]) {
            rejectsChange(event(to), value => { value.binding[key] = 'changed'; }, value => advanceReconciliation(at(from), value), `${key}_changed`);
        }
    });
}
for (const role of ['original', 'duplicate', 'executor']) {
    for (const field of ['pid', 'startTicks']) {
        test(`refuses ${role} ${field} drift including same-PID reuse`, () => {
            rejectsChange(event('DUPLICATE_STOP_INTENT'), value => { value.binding[role][field] = field === 'pid' ? 900 : '99999'; },
                value => advanceReconciliation(at('DRAIN'), value), `${role}_changed`);
        });
    }
}
test('closed event and binding schema reject additional fields', () => {
    rejectsChange(event('DRAIN'), value => { value.command = 'start'; }, value => advanceReconciliation(at('PRECHECK'), value), 'keys_invalid');
    rejectsChange(event('DRAIN'), value => { value.binding.uid = 1000; }, value => advanceReconciliation(at('PRECHECK'), value), 'keys_invalid');
});

const gateFailures = [
    [value => { value.evidence.gates.pop(); }, 'services_invalid'],
    [value => { value.evidence.gates[0].closed = false; }, 'not_quiescent'],
    [value => { value.evidence.gates[0].activeWork = 1; }, 'not_quiescent'],
    [value => { value.evidence.gates[0].activeWork = '0'; }, 'not_quiescent'],
    [value => { value.evidence.gates[0].guardSha256 = hash('d'); }, 'guard_changed'],
    [value => { value.evidence.launchersInhibited = false; }, 'launcher_not_inhibited'],
];
for (const to of ['DRAIN', 'DUPLICATE_STOP_INTENT', 'ORIGINAL_STOP_INTENT', 'START_INTENT']) {
    test(`${to} requires every qualified closed gate and zero work`, () => {
        const from = RECONCILIATION_STATES[RECONCILIATION_STATES.indexOf(to) - 1];
        for (const [mutate, code] of gateFailures) rejectsChange(event(to), mutate, value => advanceReconciliation(at(from), value), code);
    });
}
test('stop and start evidence refuse partial or unknown outcomes', () => {
    for (const to of ['DUPLICATE_STOPPED', 'ALL_STOPPED', 'VERIFYING']) {
        const from = RECONCILIATION_STATES[RECONCILIATION_STATES.indexOf(to) - 1];
        for (const key of Object.keys(event(to).evidence)) {
            rejectsChange(event(to), value => { value.evidence[key] = false; }, value => advanceReconciliation(at(from), value), 'proof_missing');
        }
    }
    rejectsChange(event('ORIGINAL_STOP_INTENT'), value => { value.evidence.duplicateStopped = false; }, value => advanceReconciliation(at('DUPLICATE_STOPPED'), value), 'duplicate_not_stopped');
    rejectsChange(event('START_INTENT'), value => { value.evidence.allStopped = false; }, value => advanceReconciliation(at('ALL_STOPPED'), value), 'not_all_stopped');
    rejectsChange(event('START_INTENT'), value => { value.evidence.snapshotRestoredSha256 = hash('d'); }, value => advanceReconciliation(at('ALL_STOPPED'), value), 'snapshot_changed');
});
test('repeated intents, skipped boundaries, backward moves and second start all refuse', () => {
    for (const from of RECONCILIATION_STATES.slice(0, 9)) {
        const record = at(from);
        for (const to of RECONCILIATION_STATES.slice(1, 9)) {
            if (RECONCILIATION_STATES.indexOf(to) === RECONCILIATION_STATES.indexOf(from) + 1) continue;
            assert.throws(() => advanceReconciliation(record, event(to)), /transition_invalid|terminal_state/);
        }
    }
});
test('UNKNOWN freezes the exact last effect and cannot replay or start at any boundary', () => {
    for (const from of RECONCILIATION_STATES.slice(0, 8)) {
        const prior = at(from); const unknown = advanceReconciliation(prior, event('UNKNOWN'));
        assert.deepEqual(unknown.lastEffect, prior.lastEffect);
        assert.equal(unknown.startAttempts, prior.startAttempts);
        for (const to of RECONCILIATION_STATES.slice(1)) assert.throws(() => advanceReconciliation(unknown, event(to)), /terminal_state/);
        assert.equal(inspectReconciliation(unknown).state, 'UNKNOWN');
    }
    rejectsChange(event('UNKNOWN'), value => { value.evidence.reason = 'retry'; }, value => advanceReconciliation(at('START_INTENT'), value), 'unknown_reason_invalid');
});
test('journal history and projections cannot skip an intent or erase an attempted effect', () => {
    const check = inspectReconciliation;
    rejectsChange(at('START_INTENT'), value => { value.startAttempts = 0; }, check, 'record_projection_invalid');
    rejectsChange(at('START_INTENT'), value => { value.lastEffect = null; }, check, 'record_projection_invalid');
    rejectsChange(at('START_INTENT'), value => { value.state = 'PRECHECK'; }, check, 'record_projection_invalid');
    rejectsChange(at('START_INTENT'), value => { value.events.splice(2, 1); }, check, 'transition_invalid');
    rejectsChange(at('START_INTENT'), value => { value.events.push(event('START_INTENT')); }, check, 'transition_invalid');
    rejectsChange(at('START_INTENT'), value => { value.events = Array(10).fill(event('DRAIN')); }, check, 'events_invalid');
    rejectsChange(at('PRECHECK'), value => { value.events = {}; }, check, 'events_invalid');
    rejectsChange(at('PRECHECK'), value => { value.schema = 'old'; }, check, 'record_schema_invalid');
    rejectsChange(at('PRECHECK'), value => { value.secret = 'not-metadata'; }, check, 'keys_invalid');
});

const verificationFailures = [
    [p => { p.supervisor = id(100); }, 'supervisor_identity_invalid'],
    [p => { p.rpcPeer = id(900); }, 'supervisor_peer_mismatch'],
    [p => { p.pubPeer.startTicks = '999'; }, 'supervisor_peer_mismatch'],
    [p => { p.pidfile = id(900); }, 'supervisor_peer_mismatch'],
    [p => { p.services[0].child = id(400); }, 'child_identity_collision'],
    [p => { p.services[0].child = copy(p.services[1].child); }, 'child_identity_collision'],
    [p => { p.services[0].parentPid = 900; }, 'child_parent_mismatch'],
    [p => { p.services[0].generationSha256 = hash('d'); }, 'generation_changed'],
    [p => { p.services[0].listenerOwned = false; }, 'service_verification_failed'],
    [p => { p.services[0].writerExclusive = false; }, 'service_verification_failed'],
    [p => { p.services[0].functionalHealthy = false; }, 'service_verification_failed'],
];
test('verification requires exact generations, six unique children and supervisor ownership', () => {
    for (const [mutate, code] of verificationFailures) {
        rejectsChange(event('VERIFIED'), value => mutate(value.evidence), value => advanceReconciliation(at('VERIFYING'), value), code);
    }
    for (const key of ['singleSupervisor', 'moduleInventoryVerified', 'definitionsPersisted', 'launchersRestored']) {
        rejectsChange(event('VERIFIED'), value => { value.evidence[key] = false; }, value => advanceReconciliation(at('VERIFYING'), value), 'verification_incomplete');
    }
});
