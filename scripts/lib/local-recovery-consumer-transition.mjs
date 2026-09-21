/** Offline configuration of the existing consumer; no stop/kill and no implicit retry of an unknown start. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withPreviewEventMutationLock } from '../preview-oid-consumer.mjs';
import { inspectOfflineConsumerInputs, observeConsumer, verifyConsumerReadiness, verifyConsumerConfiguration } from './local-recovery-consumer-verification.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(`local_consumer_transition_${code}`); };
const UNIT = 'nassaj-preview-oid-consumer.service';
const intentSchema = plan => plan.profile === 'bootstrap-offline-v2' ? 'nassaj-local-consumer-transition/v2' : 'nassaj-local-consumer-transition/v1';

function regular(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o022
        || fs.realpathSync(file) !== file) fail('unsafe_file');
    return { bytes: fs.readFileSync(file).toString('base64'), mode: stat.mode & 0o777 };
}
function unitState(file, original) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() && stat.uid === process.getuid() && fs.readlinkSync(file) === '/dev/null') return 'masked';
    const current = regular(file);
    if (current.bytes !== original.bytes || current.mode !== original.mode) fail('unit_changed');
    return 'original';
}
function configState(file, original, proposed) {
    const current = regular(file);
    if (current.bytes === original.bytes && current.mode === original.mode) return 'original';
    if (current.bytes === Buffer.from(proposed).toString('base64') && current.mode === 0o600) return 'target';
    fail('configuration_changed');
}
function syncDirectory(file) {
    const fd = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function replace(file, bytes, mode) {
    const temporary = `${file}.recovery-${randomUUID()}`;
    const fd = fs.openSync(temporary, 'wx', mode);
    try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file); syncDirectory(file);
}
function mask(file) {
    const temporary = `${file}.recovery-mask-${randomUUID()}`;
    fs.symlinkSync('/dev/null', temporary); fs.renameSync(temporary, file); syncDirectory(file);
}
function persist(file, record) { replace(file, `${JSON.stringify(record)}\n`, 0o600); }
function loadIntent(file) {
    if (!fs.existsSync(file)) return null;
    const stat = fs.lstatSync(file);
    if ((stat.mode & 0o777) !== 0o600) fail('intent_permissions');
    return JSON.parse(Buffer.from(regular(file).bytes, 'base64').toString());
}
function offline(observation, masked = false) {
    if (observation.ActiveState !== 'inactive' || observation.SubState !== 'dead' || observation.MainPID !== '0'
        || observation.jobs.length || observation.pids.length || (masked && observation.LoadState !== 'masked')) fail('not_offline');
}
function unchanged(plan, record) {
    return { unit: unitState(plan.unit, record.originalUnit), config: configState(plan.dropIn, record.originalConfig, plan.proposed) };
}
function sameIncarnation(left, right) {
    return ['InvocationID','NRestarts','MainPID','startTicks','ControlGroup','retainedBuildId','childPid','childStartTicks']
        .every(key => left[key] === right[key]);
}

/** Inspect without changing systemd or files; the execution path revalidates under the existing event lock. */
export async function inspectOfflineConsumerTransition(options) {
    const inspect = inspectOfflineConsumerInputs;
    const plan = await inspect(options);
    const observe = () => observeConsumer(plan);
    offline(await observe());
    return plan;
}

async function restoreBeforeStart(plan, record, operations) {
    if (['start_attempt','started'].includes(record.stage)) fail('start_outcome_not_rollbackable');
    const current = unchanged(plan, record); offline(await operations.observe(), current.unit === 'masked');
    if (current.unit !== 'masked') {
        unchanged(plan, record); mask(plan.unit); await operations.run(['daemon-reload']); offline(await operations.observe(), true);
    }
    await operations.revalidate(); unchanged(plan, record); offline(await operations.observe(), true);
    unchanged(plan, record); replace(plan.dropIn, Buffer.from(record.originalConfig.bytes, 'base64'), record.originalConfig.mode);
    offline(await operations.observe(), true);
    if (unitState(plan.unit, record.originalUnit) !== 'masked') fail('mask_changed');
    replace(plan.unit, Buffer.from(record.originalUnit.bytes, 'base64'), record.originalUnit.mode);
    await operations.run(['daemon-reload']); offline(await operations.observe());
    const result = { ...record, stage: 'rolled_back' }; persist(plan.intent, result); return result;
}

async function advanceOffline(plan, record, operations) {
    let current = unchanged(plan, record);
    if (record.stage === 'prepared' || record.stage === 'masked') {
        offline(await operations.observe(), current.unit === 'masked'); await operations.revalidate();
        current = unchanged(plan, record);
        if (current.unit !== 'masked') mask(plan.unit);
        await operations.run(['daemon-reload']); offline(await operations.observe(), true);
        record = { ...record, stage: 'masked' }; persist(plan.intent, record); operations.checkpoint('masked');
        current = unchanged(plan, record); await operations.revalidate(); offline(await operations.observe(), true);
        current = unchanged(plan, record);
        if (current.config !== 'target') replace(plan.dropIn, plan.proposed, 0o600);
        record = { ...record, stage: 'configured' }; persist(plan.intent, record); operations.checkpoint('configured');
    }
    if (record.stage === 'configured') {
        current = unchanged(plan, record); await operations.revalidate();
        offline(await operations.observe(), current.unit === 'masked');
        current = unchanged(plan, record);
        if (current.config !== 'target') fail('target_configuration_missing');
        if (current.unit === 'masked') replace(plan.unit, Buffer.from(record.originalUnit.bytes, 'base64'), record.originalUnit.mode);
        await operations.run(['daemon-reload']); offline(await operations.observe());
        record = { ...record, stage: 'unmasked' }; persist(plan.intent, record); operations.checkpoint('unmasked');
    }
    return record;
}

/** Execute only an explicitly approved existing-unit transition, keeping event EX through process/bundle readiness. */
export async function executeOfflineConsumerTransition(options) {
    if (options.execute !== true) return { state: 'dry_run', plan: await inspectOfflineConsumerTransition(options) };
    const lock = withPreviewEventMutationLock;
    return lock(options.root, async () => {
        const inspect = inspectOfflineConsumerInputs, plan = await inspect(options);
        const operations = { run: plan.run, observe: () => observeConsumer(plan),
            revalidate: async () => { const latest = await inspect(options); if (latest.packetSha256 !== plan.packetSha256) fail('packet_changed'); },
            readiness: () => verifyConsumerReadiness(plan), checkpoint: () => {} };
        let record = loadIntent(plan.intent);
        if (!record) {
            const baseline = await operations.observe(); offline(baseline);
            if (baseline.UnitFileState !== 'disabled') fail('disabled_baseline_required');
            record = { schema: intentSchema(plan), packetSha256: plan.packetSha256,
                transactionId: plan.transactionId, jobId: plan.jobId, actionId: plan.actionId, approvalReference: plan.approvalReference,
                ...(plan.profile === 'bootstrap-offline-v2' ? { profile: plan.profile, bootstrap: plan.bootstrap } : {}),
                originalUnit: regular(plan.unit), originalConfig: regular(plan.dropIn), proposedSha256: sha(plan.proposed), stage: 'prepared' };
            if (sha(Buffer.from(record.originalUnit.bytes, 'base64')) !== plan.unitSha256
                || sha(Buffer.from(record.originalConfig.bytes, 'base64')) !== plan.originalDropInSha256
                || record.originalConfig.mode !== 0o600) fail('original_configuration_changed');
            persist(plan.intent, record); operations.checkpoint('prepared');
        }
        if (record.schema !== intentSchema(plan) || record.packetSha256 !== plan.packetSha256
            || (plan.profile === 'bootstrap-offline-v2' && (record.profile !== plan.profile || JSON.stringify(record.bootstrap) !== JSON.stringify(plan.bootstrap)))
            || record.proposedSha256 !== sha(plan.proposed)
            || sha(Buffer.from(record.originalUnit.bytes, 'base64')) !== plan.unitSha256
            || sha(Buffer.from(record.originalConfig.bytes, 'base64')) !== plan.originalDropInSha256
            || !['prepared','masked','configured','unmasked','start_attempt','started','rolled_back'].includes(record.stage)) fail('intent_changed');
        unchanged(plan, record);
        if (record.stage === 'start_attempt') return { ...record, state: 'manual', reason: 'start_outcome_unknown_may_be_enabled_systemd_may_restart' };
        if (options.rollback === true) return restoreBeforeStart(plan, record, operations);
        if (record.stage === 'rolled_back') fail('rolled_back_operation');
        if (record.stage === 'started') {
            const readiness = await operations.readiness();
            if (!sameIncarnation(record.readiness, readiness)) fail('consumer_incarnation_changed');
            return { ...record, reused: true };
        }
        record = await advanceOffline(plan, record, operations);
        await operations.revalidate(); offline(await operations.observe());
        const state = unchanged(plan, record);
        if (state.config !== 'target' || state.unit !== 'original') fail('target_configuration_missing');
        verifyConsumerConfiguration(plan);
        record = { ...record, stage: 'start_attempt' }; persist(plan.intent, record); operations.checkpoint('start_attempt');
        await operations.run(['enable', UNIT]);
        await operations.revalidate(); unchanged(plan, record); offline(await operations.observe());
        verifyConsumerConfiguration(plan);
        await operations.run(['start', UNIT]);
        const readiness = await operations.readiness(); await operations.revalidate(); unchanged(plan, record);
        if (!sameIncarnation(readiness, await operations.readiness())) fail('consumer_incarnation_changed');
        record = { ...record, stage: 'started', readiness }; persist(plan.intent, record); operations.checkpoint('started');
        return record;
    });
}
