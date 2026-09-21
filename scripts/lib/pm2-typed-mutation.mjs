/** Fixed typed PM2 worker protocol; authority arrives only through inherited root pipes. */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalForwardValue as canonical, forwardValueSha256 as sha, assertForwardFrameKeys } from './release-runtime-forward-child-protocol.mjs';
import { executePinnedPm2Step } from './pm2-readonly-observer.mjs';
const HEX = /^[a-f0-9]{64}$/;
const STEPS = ['stop-old', 'delete-old', 'configure-target-stopped', 'start-target', 'restart-same'];
const DESCRIPTOR_KEYS = 'name,namespace,pm_exec_path,pm_cwd,exec_interpreter,exec_mode,uid,gid,pm_out_log_path,pm_err_log_path,pm_pid_path,status,autostart,autorestart,watch,pmx,vizion,wait_ready,restart_time,unstable_restarts,prev_restart_delay,env';
const channels = new WeakMap();
function check(value, reason) { if (!value) throw Error(`pm2_mutation_unknown:${reason}`); }
function exact(value, keys) { try { assertForwardFrameKeys(value, keys); } catch { check(false, 'schema'); } }
/** Capture paired clocks within one millisecond bucket; retry reads only, never effects. */
export function samplePm2Clock({ wall = Date.now, monotonic = () => process.hrtime.bigint(),
    boot = () => fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() } = {}) {
    const baseline = boot(); let previousWall; let previousMonotonic;
    check(typeof baseline === 'string' && baseline.length > 0, 'clock_sample_boot');
    for (let attempt = 0; attempt < 8; attempt++) {
        const m0 = monotonic(); const w0 = wall(); const m = monotonic(); const w1 = wall(); const m1 = monotonic();
        check(Number.isSafeInteger(w0) && w0 >= 0 && Number.isSafeInteger(w1) && w1 >= 0, 'clock_sample_wall');
        check([m0, m, m1].every(value => typeof value === 'bigint' && value >= 0n)
            && m0 <= m && m <= m1 && (previousMonotonic === undefined || m0 >= previousMonotonic), 'clock_sample_monotonic');
        check(w1 >= w0 && (previousWall === undefined || w0 >= previousWall), 'clock_sample_regression');
        previousWall = w1; previousMonotonic = m1;
        if (w0 !== w1 || m1 - m0 >= 1000000n) continue;
        check(boot() === baseline, 'clock_sample_boot');
        return { wall: w0, monotonic: String(m), boot: baseline };
    }
    check(false, 'clock_sample_unstable');
}
/** The complete approved stopped descriptor, including its private service environment. */
export function validatePm2TargetDescriptor(value) {
    exact(value, DESCRIPTOR_KEYS);
    check(value.status === 'stopped' && value.autostart === true && value.watch === false
        && value.pmx === false && value.vizion === false && value.wait_ready === false
        && typeof value.autorestart === 'boolean' && value.exec_mode === 'fork_mode', 'descriptor_controls');
    for (const key of ['name', 'namespace']) check(typeof value[key] === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(value[key]), 'descriptor_name');
    for (const key of ['pm_exec_path', 'pm_cwd', 'exec_interpreter', 'pm_out_log_path', 'pm_err_log_path', 'pm_pid_path'])
        check(typeof value[key] === 'string' && path.isAbsolute(value[key]) && !/[\x00-\x1f]/.test(value[key]), 'descriptor_path');
    check(Number.isSafeInteger(value.uid) && value.uid > 0 && Number.isSafeInteger(value.gid) && value.gid > 0, 'descriptor_identity');
    check(value.env && Object.getPrototypeOf(value.env) === Object.prototype, 'descriptor_environment');
    check(['restart_time', 'unstable_restarts', 'prev_restart_delay'].every(key => value[key] === 0), 'descriptor_counters');
    const controls = new Set([...DESCRIPTOR_KEYS.split(','), 'instances', 'cron_restart', 'pm_id', 'unique_id', 'vizion_running', '__proto__', 'constructor', 'prototype']);
    for (const [key, entry] of Object.entries(value.env)) check(/^[A-Z][A-Z0-9_]*$/.test(key)
        && !/^(NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|LD_.*|DYLD_.*|PM2_.*)$/.test(key) && !controls.has(key) && typeof entry === 'string' && entry.length <= 16384 && !entry.includes('\0'), 'environment_shadow');
    check(Buffer.byteLength(canonical(value)) <= 65536, 'descriptor_size'); return value;
}
/** Bound legacy instrumentation data without discarding it from the private entry hash. */
export function validatePm2AxmMetadata(value, pid, instrumented = false) {
    const forbidden = new Set([...DESCRIPTOR_KEYS.split(','), '__proto__', 'prototype', 'constructor', 'pm_id', 'cron_restart', 'instances']);
    const visit = (item, depth) => {
        check(depth <= 8, 'axm_depth');
        if (item === null || typeof item === 'boolean') return;
        if (typeof item === 'number') { check(Number.isFinite(item), 'axm_number'); return; }
        if (typeof item === 'string') { check(item.length <= 4096, 'axm_string'); return; }
        check(item && typeof item === 'object', 'axm_type');
        if (Array.isArray(item)) { check(item.length <= 128, 'axm_array'); item.forEach(entry => visit(entry, depth + 1)); return; }
        check(Object.getPrototypeOf(item) === Object.prototype && Object.keys(item).length <= 128, 'axm_object');
        for (const [key, entry] of Object.entries(item)) { check(!forbidden.has(key) && key.length <= 128, 'axm_key'); visit(entry, depth + 1); }
    };
    const metadata = Object.fromEntries(['axm_actions', 'axm_monitor', 'axm_options', 'axm_dynamic'].map(key => [key, value[key]]));
    check(Array.isArray(metadata.axm_actions) && ['axm_monitor', 'axm_options', 'axm_dynamic'].every(key => metadata[key]
        && Object.getPrototypeOf(metadata[key]) === Object.prototype), 'axm_shape');
    check(Buffer.byteLength(canonical(metadata)) <= 65536, 'axm_size'); visit(metadata, 0);
    check(metadata.axm_options.pid === undefined || metadata.axm_options.pid === pid, 'axm_pid');
    if (!instrumented) check(metadata.axm_actions.length === 0 && ['axm_monitor', 'axm_options', 'axm_dynamic']
        .every(key => Object.keys(metadata[key]).length === 0), 'axm_disabled');
}
/** Reject boot changes and wall-clock skew; no implicit tolerance is an authority input. */
export function verifyPm2LaunchWindow(window, values) {
    check(window && window.bootBefore === window.bootAfter && typeof window.bootBefore === 'string'
        && Number.isSafeInteger(window.wallBefore) && Number.isSafeInteger(window.wallAfter)
        && /^(0|[1-9][0-9]*)$/.test(window.monotonicBefore) && /^(0|[1-9][0-9]*)$/.test(window.monotonicAfter)
        && window.wallAfter >= window.wallBefore && BigInt(window.monotonicAfter) >= BigInt(window.monotonicBefore), 'clock_window');
    const wallElapsed = window.wallAfter - window.wallBefore;
    const nanos = BigInt(window.monotonicAfter) - BigInt(window.monotonicBefore);
    const floorMilliseconds = Number(nanos / 1000000n);
    const ceilMilliseconds = Number((nanos + 999999n) / 1000000n);
    // Date.now has millisecond resolution; compare integer clock ticks, not an arbitrary skew allowance.
    check(wallElapsed === floorMilliseconds || wallElapsed === ceilMilliseconds, 'clock_skew');
    check(values.every(value => Number.isSafeInteger(value) && value > 0 && value >= window.wallBefore && value <= window.wallAfter), 'timestamp_drift');
}
/** Accept only the reviewed lifecycle metadata differences from an approved private legacy baseline. */
export function verifyPm2LegacySnapshot(actual, baseline, options) {
    check(actual && baseline && options && Number.isSafeInteger(options.pid) && options.pid >= 0, 'legacy_material');
    const normalized = structuredClone(actual); const prior = structuredClone(baseline);
    validatePm2AxmMetadata(normalized, options.step === 'stop-old' ? options.priorPid : options.pid, true); validatePm2AxmMetadata(prior, options.priorPid ?? options.pid, true);
    for (const key of ['axm_actions', 'axm_monitor', 'axm_options', 'axm_dynamic']) { delete normalized[key]; delete prior[key]; }
    check(normalized.status === options.status, 'legacy_status'); normalized.status = prior.status;
    if (options.step === 'stop-old') check(actual.axm_actions.length === 0 && Object.keys(actual.axm_monitor).length === 0, 'stop_metadata');
    if (options.step === 'restart-same') {
        verifyPm2LaunchWindow(options.window, [normalized.created_at, normalized.pm_uptime]);
        check(Number.isSafeInteger(prior.restart_time) && prior.restart_time >= 0 && normalized.restart_time === prior.restart_time + 1
            && normalized.unstable_restarts === 0 && normalized.prev_restart_delay === 0, 'restart_counters');
        for (const key of ['created_at', 'pm_uptime', 'restart_time', 'unstable_restarts', 'prev_restart_delay']) { delete normalized[key]; delete prior[key]; }
        if (normalized.node_version !== undefined) check(normalized.node_version === options.nodeVersion, 'version_drift');
        check(normalized.version === options.version, 'version_drift');
        delete normalized.node_version; delete prior.node_version;
    }
    check(canonical(normalized) === canonical(prior), 'legacy_control_drift');
    return sha(actual);
}

/** Compare full private PM2 material; projection hashes alone never authorize a mutation. */
export function verifyPm2PrivateDescriptor(actual, expected, status, policy = {}) {
    validatePm2TargetDescriptor(expected); check(actual && typeof actual === 'object', 'descriptor_missing');
    const normalized = structuredClone(actual);
    check(Number.isSafeInteger(normalized.pm_id) && normalized.pm_id >= 0 && normalized.vizion_running === false, 'generated_fields');
    check(typeof normalized.env?.unique_id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(normalized.env.unique_id), 'generated_uuid');
    const generatedUuid = normalized.env.unique_id;
    if (policy.uuid !== undefined) check(generatedUuid === policy.uuid, 'uuid_changed');
    if (status === 'online') {
        check(Number.isSafeInteger(policy.pmId) && policy.pmId >= 0 && normalized.pm_id === policy.pmId, 'allocated_slot');
        check(policy.uuid === generatedUuid && typeof policy.version === 'string' && typeof policy.nodeVersion === 'string', 'online_pins');
        validatePm2AxmMetadata(normalized, policy.pid, false);
        for (const key of ['axm_actions', 'axm_monitor', 'axm_options', 'axm_dynamic']) delete normalized[key];
        verifyPm2LaunchWindow(policy.window, [normalized.created_at, normalized.pm_uptime]);
        delete normalized.created_at; delete normalized.pm_uptime;
        check(normalized.version === policy.version && (normalized.node_version === undefined || normalized.node_version === policy.nodeVersion), 'version_drift');
        delete normalized.version; delete normalized.node_version;
        for (const [key, value] of Object.entries(expected.env)) { check(normalized[key] === value, 'effective_environment'); delete normalized[key]; }
        check(normalized.unique_id === generatedUuid, 'uuid_mirror'); delete normalized.unique_id;
    }
    delete normalized.pm_id; delete normalized.vizion_running; delete normalized.env.unique_id;
    check(normalized.status === status, 'slot_status'); normalized.status = 'stopped';
    check(canonical(normalized) === canonical(expected), 'private_descriptor_drift');
}
/** Derive the only permitted method and argument from root-bound worker material. */
export function preparePm2TypedStep(request, context, entries, daemon) {
    exact(request, 'operationId,attemptId,step,expectedSlotDigest');
    check(STEPS.includes(request.step) && typeof request.operationId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId)
        && typeof request.attemptId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(request.attemptId)
        && HEX.test(request.expectedSlotDigest) && HEX.test(context.attemptNonce), 'request');
    const legacy = ['stop-old', 'delete-old', 'restart-same'].includes(request.step);
    const descriptor = legacy ? context.slot?.baseline : validatePm2TargetDescriptor(request.step === 'configure-target-stopped' ? context.targetDescriptor : context.slot?.descriptor);
    check(descriptor && typeof descriptor.name === 'string' && typeof descriptor.namespace === 'string', 'baseline_missing');
    for (const entry of entries) check(entry.pm_id === entry.pm2_env?.pm_id, 'entry_id_mismatch');
    const target = entries.filter(entry => entry.pm2_env?.name === descriptor.name && entry.pm2_env?.namespace === descriptor.namespace);
    let pmId = context.slot?.pmId; let slotDigest;
    if (request.step === 'configure-target-stopped') {
        check(target.length === 0, 'target_exists'); slotDigest = sha({ absent: true, name: descriptor.name, namespace: descriptor.namespace });
    } else {
        check(Number.isSafeInteger(pmId) && pmId >= 0 && target.length === 1 && target[0].pm_id === pmId, 'slot_binding');
        const status = ['delete-old', 'start-target'].includes(request.step) ? 'stopped' : 'online';
        check(!legacy || (context.slot.entrySha256 === sha(context.slot.baseline) && request.expectedSlotDigest === context.slot.entrySha256), 'legacy_baseline_binding');
        if (legacy) verifyPm2LegacySnapshot(target[0].pm2_env, descriptor, { pid: target[0].pid,
            priorPid: context.slot.process?.pid, status, step: request.step === 'delete-old' ? 'stop-old' : 'inspect' });
        else { check(target[0].pm2_env.pm_id === context.slot.pmId, 'allocated_slot');
            verifyPm2PrivateDescriptor(target[0].pm2_env, descriptor, status, { uuid: context.slot.baseline?.env?.unique_id }); }
        check(status !== 'stopped' || target[0].pid === 0, 'stopped_pid'); slotDigest = sha(target[0].pm2_env);
    }
    check((legacy ? sha(context.slot.baseline) : slotDigest) === request.expectedSlotDigest, 'slot_digest');
    if (request.step === 'start-target') {
        const binding = context.targetSlotBinding;
        check(binding?.schema === 'nassaj-prepared-pm2-slot/v1' && binding.operationId === request.operationId
            && binding.allocatedPmId === pmId && binding.daemonIdentitySha256 === sha(daemon)
            && binding.targetDescriptorSha256 === sha(descriptor) && binding.preparedEntrySha256 === slotDigest, 'allocated_slot');
    }
    const methods = { 'stop-old': 'stopProcessId', 'delete-old': 'deleteProcessId', 'configure-target-stopped': 'prepare',
        'start-target': 'startProcessId', 'restart-same': 'restartProcessId' };
    const payload = request.step === 'configure-target-stopped' ? structuredClone(descriptor)
        : request.step === 'restart-same' ? { id: pmId } : pmId;
    const requestId = randomBytes(16).toString('hex');
    const intent = { schema: 'nassaj-pm2-execution-intent/v1', ...request, attemptNonce: context.attemptNonce,
        daemonIdentitySha256: sha(daemon), slotDigest, payloadDigest: sha(payload), requestId };
    return { method: methods[request.step], payload, intent, descriptor, before: entries };
}
function rootChannel(context) {
    check(context.permitChannel?.requestFd === 5 && context.permitChannel?.responseFd === 6, 'permit_channel');
    let channel = channels.get(context);
    if (!channel) { channel = { input: new net.Socket({ fd: 6, readable: true, writable: false }), seen: new Set(), results: new Set(), busy: false }; channels.set(context, channel); }
    return channel;
}
function exchangeRootFrame(context, frame, timeoutMs) {
    const channel = rootChannel(context); check(!channel.busy, 'concurrent_root_frame'); channel.busy = true;
    return new Promise((resolve, reject) => {
        let bytes = Buffer.alloc(0); let done = false;
        const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); channel.input.off('data', read);
            channel.input.off('error', fail); channel.input.off('end', fail); channel.input.pause(); channel.busy = false;
            error ? reject(error) : resolve(value); };
        const fail = () => finish(Error('pm2_mutation_unknown:root_ack'));
        const timer = setTimeout(fail, timeoutMs);
        const read = chunk => { bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 16384) return fail();
            const newline = bytes.indexOf(10); if (newline < 0) return; if (newline !== bytes.length - 1) return fail();
            try { finish(null, JSON.parse(bytes.subarray(0, newline).toString('utf8'))); } catch { fail(); } };
        channel.input.on('data', read); channel.input.once('error', fail); channel.input.once('end', fail); channel.input.resume();
        try { const bytes = Buffer.from(`${JSON.stringify(frame)}\n`); check(bytes.length <= 16384 && fs.writeSync(5, bytes) === bytes.length, 'root_frame_write'); } catch { fail(); }
    });
}
/** One persistent bounded ACK channel per worker; never accept a stale or duplicate root response. */
export async function acknowledgePm2ExecutionIntent(context, intent, timeoutMs) {
    const channel = rootChannel(context); check(!channel.seen.has(intent.step) && channel.seen.size < 5, 'duplicate_step'); channel.seen.add(intent.step);
    const response = await exchangeRootFrame(context, intent, timeoutMs); const { revision, decision, ...received } = response || {};
    check(Number.isSafeInteger(revision) && revision > 0 && decision === 'authorized'
        && canonical(received) === canonical({ ...intent, schema: 'nassaj-pm2-execution-ack/v1' }), 'root_ack_binding');
    return response;
}
/** Root must independently verify and durably retain each result before the same worker advances. */
export async function acknowledgePm2StepResult(context, result) {
    const channel = rootChannel(context); check(channel.seen.has(result.step) && !channel.results.has(result.step), 'result_step');
    channel.results.add(result.step);
    const response = await exchangeRootFrame(context, result, 10000); const { revision, ...received } = response || {};
    const expected = { schema: 'nassaj-pm2-step-ack/v1', operationId: result.operationId, attemptId: result.attemptId,
        attemptNonce: result.attemptNonce, step: result.step, requestId: result.requestId, resultSha256: sha(result), decision: 'recorded' };
    check(Number.isSafeInteger(revision) && revision > 0 && canonical(received) === canonical(expected), 'result_ack_binding');
    return response;
}
/** Release only this worker's inherited ACK socket after its bounded protocol completes. */
export function closePm2PermitChannel(context) { channels.get(context)?.input.destroy(); channels.delete(context); }
/** Execute exactly one allowlisted operation using inherited root authorization, never CLI or reconnect. */
export async function applyPinnedPm2Operation(request, trustedContext) {
    return executePinnedPm2Step(request, trustedContext);
}

/** Preserve unrelated identities and controls while retaining validated telemetry in private evidence hashes. */
export function verifyPm2UnrelatedEntries(before, after, target) {
    const select = entries => entries.filter(entry => !(entry.pm2_env?.name === target.name && entry.pm2_env?.namespace === target.namespace))
        .sort((left, right) => left.pm_id - right.pm_id);
    const prior = select(before); const current = select(after);
    check(prior.length === current.length && new Set(prior.map(entry => entry.pm_id)).size === prior.length, 'sibling_inventory');
    for (let i = 0; i < prior.length; i++) {
        const old = prior[i]; const fresh = current[i];
        check(old.pm_id === fresh.pm_id && old.pid === fresh.pid && old.pm2_env.pm_id === old.pm_id && fresh.pm2_env.pm_id === fresh.pm_id,
            'sibling_identity');
        verifyPm2LegacySnapshot(fresh.pm2_env, old.pm2_env, { pid: fresh.pid, status: old.pm2_env.status, step: 'inspect' });
    }
    return { beforeSha256: sha(prior), afterSha256: sha(current) };
}
/** Root completion predicate over two private peer-proven reads and root-owned timing observations. */
export function verifyPm2OperationCompletion(request, context, before, after, rootWindow) {
    exact(request, 'operationId,attemptId,step,expectedSlotDigest');
    check(STEPS.includes(request.step) && before?.observation && after?.observation
        && canonical(before.observation.daemon) === canonical(after.observation.daemon), 'completion_daemon');
    const intent = context.executionIntent;
    check(intent?.operationId === request.operationId && intent.attemptId === request.attemptId && intent.step === request.step
        && intent.attemptNonce === context.attemptNonce && intent.expectedSlotDigest === request.expectedSlotDigest
        && intent.daemonIdentitySha256 === sha(after.observation.daemon), 'completion_intent');
    const legacy = ['stop-old', 'delete-old', 'restart-same'].includes(request.step);
    const descriptor = legacy ? context.slot.baseline : context.targetDescriptor;
    const select = entries => entries.filter(entry => entry.pm2_env?.name === descriptor.name && entry.pm2_env?.namespace === descriptor.namespace);
    for (const entry of [...before.privateEntries, ...after.privateEntries]) check(entry.pm_id === entry.pm2_env?.pm_id, 'entry_id_mismatch');
    const prior = select(before.privateEntries); const current = select(after.privateEntries);
    verifyPm2UnrelatedEntries(before.privateEntries, after.privateEntries, descriptor);
    if (request.step === 'delete-old') {
        check(prior.length === 1 && current.length === 0 && prior[0].pid === 0
            && prior[0].pm_id === context.slot.pmId && sha(prior[0].pm2_env) === intent.slotDigest, 'delete_completion');
        return { slotDigest: null, targetSlotBinding: null };
    }
    check(current.length === 1, 'completion_slot'); const entry = current[0];
    if (request.step === 'configure-target-stopped') {
        check(prior.length === 0 && entry.pid === 0 && entry.pm2_env.pm_id === entry.pm_id
            && context.provisionalResult?.targetSlotBinding?.allocatedPmId === entry.pm_id, 'prepare_completion');
        verifyPm2PrivateDescriptor(entry.pm2_env, descriptor, 'stopped');
        const binding = { schema: 'nassaj-prepared-pm2-slot/v1', operationId: request.operationId, attemptId: request.attemptId,
            prepareIntentSha256: sha(intent), daemonIdentitySha256: sha(after.observation.daemon), namespaceSha256: sha(descriptor.namespace),
            targetDescriptorSha256: sha(descriptor), allocatedPmId: entry.pm_id, preparedEntrySha256: sha(entry.pm2_env),
            observationSha256: after.observation.observationSha256 };
        return { slotDigest: sha(entry.pm2_env), targetSlotBinding: binding };
    }
    check(prior.length === 1 && prior[0].pm_id === context.slot.pmId && entry.pm_id === context.slot.pmId
        && sha(prior[0].pm2_env) === intent.slotDigest, 'completion_bound_slot');
    if (legacy) verifyPm2LegacySnapshot(entry.pm2_env, context.slot.baseline, { pid: entry.pid, priorPid: context.slot.process.pid,
        status: request.step === 'stop-old' ? 'stopped' : 'online', step: request.step, window: rootWindow,
        version: context.metadata?.version, nodeVersion: context.metadata?.nodeVersion });
    else {
        check(context.targetSlotBinding?.allocatedPmId === entry.pm_id
            && context.targetSlotBinding?.preparedEntrySha256 === sha(prior[0].pm2_env), 'completion_allocated_slot');
        verifyPm2PrivateDescriptor(entry.pm2_env, descriptor, 'online', { pmId: entry.pm_id, uuid: prior[0].pm2_env.env.unique_id,
            pid: entry.pid, version: context.metadata?.version, nodeVersion: context.metadata?.nodeVersion, window: rootWindow });
    }
    check(request.step === 'stop-old' ? entry.pid === 0 : entry.pid === context.observedProcess?.pid, 'completion_process_pid');
    return { slotDigest: sha(entry.pm2_env), targetSlotBinding: null };
}
