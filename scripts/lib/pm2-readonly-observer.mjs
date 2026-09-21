import { runExistingPm2Observation, sendPinnedPm2TypedFrame as mutationReply, pinPm2RuntimeFile as pinFile, validatedPm2FrameLength,
    verifyPm2ConnectedPeer, verifyPinnedPm2PeerCredentials, capturePm2PeerCredentialReader } from './pm2-existing-transport.mjs';
export { validatedPm2FrameLength, verifyPm2ConnectedPeer, verifyPinnedPm2PeerCredentials, capturePm2PeerCredentialReader };
/** Fixed existing-socket PM2 observation. No PM2 lifecycle API, shell, reconnect or raw environment result. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { inspectForwardChildIdentity, canonicalForwardValue } from './release-runtime-forward-child-protocol.mjs';
import { samplePm2Clock, preparePm2TypedStep, acknowledgePm2ExecutionIntent, verifyPm2PrivateDescriptor, verifyPm2LegacySnapshot, verifyPm2UnrelatedEntries } from './pm2-typed-mutation.mjs';
const CAP = 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const CODEC_FILES = ['amp-message/Readme.md', 'amp-message/index.js', 'amp-message/package.json', 'amp/Readme.md',
    'amp/index.js', 'amp/lib/decode.js', 'amp/lib/encode.js', 'amp/lib/stream.js', 'amp/package.json'].sort();
const loaded = new Map();
const require = createRequire(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
function unknown(reason) { return Error(`pm2_observation_unknown:${reason}`); }
function check(ok, reason) { if (!ok) throw unknown(reason); }
function remaining(deadline) { const value = Math.floor(deadline - performance.now()); check(value > 0, 'deadline'); return value; }
function loadCodec(settings, ownerUid, deadline) {
    const codec = settings.codec;
    check(codec && codec.root === path.resolve(fileURLToPath(new URL('../../node_modules/', import.meta.url)))
        && fs.realpathSync(codec.root) === codec.root && Array.isArray(codec.files)
        && canonicalForwardValue(codec.files.map(file => file.path)) === canonicalForwardValue(CODEC_FILES)
        && hash(canonicalForwardValue(codec.files)) === settings.codecClosureSha256, 'codec_closure');
    const contents = new Map(codec.files.map(file => [file.path, pinFile(path.join(codec.root, file.path), file.sha256, ownerUid, deadline)]));
    const message = JSON.parse(contents.get('amp-message/package.json')); const amp = JSON.parse(contents.get('amp/package.json'));
    check(message.name === 'amp-message' && message.version === '0.1.2' && message.license === 'MIT'
        && canonicalForwardValue(message.dependencies) === '{"amp":"0.3.1"}' && !message.main
        && amp.name === 'amp' && amp.version === '0.3.1' && amp.license === 'MIT' && !amp.main
        && canonicalForwardValue(amp.dependencies) === '{}', 'codec_manifest');
    const entry = path.join(codec.root, 'amp-message/index.js'); const codecRequire = createRequire(entry);
    check(codecRequire.resolve('amp') === path.join(codec.root, 'amp/index.js'), 'codec_resolution');
    for (const file of ['decode', 'encode', 'stream']) check(createRequire(path.join(codec.root, 'amp/index.js')).resolve(`./lib/${file}`)
        === path.join(codec.root, `amp/lib/${file}.js`), 'codec_resolution');
    const previous = loaded.get(entry);
    check(!previous || previous.sha256 === settings.codecClosureSha256, 'codec_cache_changed');
    if (!previous) {
        check(CODEC_FILES.filter(file => file.endsWith('.js')).every(file => !codecRequire.cache[path.join(codec.root, file)]), 'codec_preloaded');
        const Message = require('../../node_modules/amp-message/index.js'); check(typeof Message === 'function', 'codec_export');
        loaded.set(entry, { sha256: settings.codecClosureSha256, Message });
    }
    remaining(deadline); return loaded.get(entry).Message;
}
async function observeSession(settings, deps = {}, mutation = null) {
    const deadline = performance.now() + 5000;
    try {
        const Message = loadCodec(settings, deps.ownerUid ?? 0, deadline);
        return await runExistingPm2Observation(settings, { ...deps, deadline, Message }, mutation);
    } catch (error) {
        if (/^pm2_observation_unknown:[a-z_]+$/.test(error?.message || '')) throw error;
        throw unknown('unavailable');
    }
}
/** One bounded read-only query; it cannot issue a lifecycle RPC. */
export async function observePinnedPm2Runtime(settings, deps = {}) {
    return observeSession(settings, deps);
}
/** Fixed typed worker transport. No method/payload can be supplied by the public request. */
export async function executePinnedPm2Step(request, context, deps = {}) {
    let plan; let callback; let afterRaw; let clockBefore;
    try {
        await observeSession(context.observer, deps, async session => {
            plan = preparePm2TypedStep(request, context, session.raw, session.observed.daemon);
            if (['stop-old', 'restart-same'].includes(request.step)) {
                const entry = session.raw.find(value => value.pm_id === context.slot.pmId);
                check(entry.pid === context.slot.process.pid, 'old_process_pid');
                const old = inspectForwardChildIdentity(entry.pid);
                check(old.startTicks === context.slot.process.startTicks && old.bootId === context.slot.process.bootId
                    && old.uids.every(uid => uid === context.slot.process.uid), 'old_kernel_identity');
            }
            await session.peer(context.observer, session.socket, session.deadline);
            const before = session.inspect(context.observer, session.deadline);
            check(canonicalForwardValue(before.daemon) === canonicalForwardValue(session.observed.daemon), 'kernel_changed');
            await acknowledgePm2ExecutionIntent(context, plan.intent, remaining(session.deadline));
            // Recheck the still-open peer after the durable root ACK and before any mutation byte.
            await session.peer(context.observer, session.socket, session.deadline);
            check(canonicalForwardValue(session.inspect(context.observer, session.deadline)) === canonicalForwardValue(before), 'kernel_changed');
            clockBefore = samplePm2Clock();
            remaining(session.deadline);
            check(!session.socket.destroyed, 'connection_closed');
            session.socket.off('data', session.unexpectedData);
            callback = await mutationReply(session.socket, session.Message, plan, session.deadline);
            return true;
        });
        const after = await observeSession(context.observer, deps, async session => {
            afterRaw = session.raw; return session.observed;
        });
        verifyPm2UnrelatedEntries(plan.before, afterRaw, plan.descriptor);
        const matching = afterRaw.filter(entry => entry.pm2_env?.name === plan.descriptor.name && entry.pm2_env?.namespace === plan.descriptor.namespace);
        let binding = null; let slotDigest = null;
        if (request.step === 'delete-old') check(matching.length === 0, 'delete_unproven');
        else {
            check(matching.length === 1, 'result_slot'); const entry = matching[0];
            const stopped = ['stop-old', 'configure-target-stopped'].includes(request.step);
            const clockAfter = samplePm2Clock();
            const window = { wallBefore: clockBefore.wall, wallAfter: clockAfter.wall, monotonicBefore: clockBefore.monotonic,
                monotonicAfter: clockAfter.monotonic, bootBefore: clockBefore.boot, bootAfter: clockAfter.boot };
            if (['stop-old', 'restart-same'].includes(request.step)) verifyPm2LegacySnapshot(entry.pm2_env, context.slot.baseline,
                { pid: entry.pid, priorPid: context.slot.process.pid, status: stopped ? 'stopped' : 'online', step: request.step,
                    window, version: context.metadata?.version, nodeVersion: context.metadata?.nodeVersion });
            else verifyPm2PrivateDescriptor(entry.pm2_env, plan.descriptor, stopped ? 'stopped' : 'online', {
                uuid: request.step === 'configure-target-stopped' ? undefined : context.slot?.baseline?.env?.unique_id, version: context.metadata?.version, nodeVersion: context.metadata?.nodeVersion, pid: entry.pid, pmId: context.slot?.pmId, window });
            if (!stopped) {
                const actual = inspectForwardChildIdentity(entry.pid);
                check(actual.bootId === clockBefore.boot && actual.uids.every(uid => uid === plan.descriptor.uid), 'target_kernel');
            }
            if (['stop-old', 'restart-same'].includes(request.step)) {
                try { const old = inspectForwardChildIdentity(context.slot.process.pid);
                    check(old.startTicks !== context.slot.process.startTicks || old.bootId !== context.slot.process.bootId, 'old_process_alive'); }
                catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
            }
            check(stopped ? entry.pid === 0 : Number.isSafeInteger(entry.pid) && entry.pid > 0, 'result_pid');
            slotDigest = hash(canonicalForwardValue(entry.pm2_env));
            if (request.step === 'configure-target-stopped') {
                const reply = Array.isArray(callback) ? callback : [callback];
                check(reply.length === 1 && (reply[0].pm_id ?? reply[0].pm2_env?.pm_id) === entry.pm_id, 'prepare_reply');
                binding = { schema: 'nassaj-prepared-pm2-slot/v1', operationId: request.operationId, attemptId: request.attemptId,
                    prepareIntentSha256: hash(canonicalForwardValue(plan.intent)), daemonIdentitySha256: hash(canonicalForwardValue(after.daemon)),
                    namespaceSha256: hash(canonicalForwardValue(plan.descriptor.namespace)), targetDescriptorSha256: hash(canonicalForwardValue(plan.descriptor)),
                    allocatedPmId: entry.pm_id, preparedEntrySha256: slotDigest, observationSha256: after.observationSha256 };
            } else check(entry.pm_id === context.slot.pmId, 'result_slot');
        }
        if (request.step === 'configure-target-stopped') {
            context.slot = { pmId: binding.allocatedPmId, baseline: structuredClone(afterRaw.find(entry => entry.pm_id === binding.allocatedPmId).pm2_env),
                descriptor: context.targetDescriptor, entrySha256: binding.preparedEntrySha256 };
            context.targetSlotBinding = binding;
        }
        return Object.freeze({ schema: 'nassaj-pm2-step-result/v1', operationId: request.operationId, attemptId: request.attemptId,
            attemptNonce: context.attemptNonce, step: request.step, requestId: plan.intent.requestId, dispatchState: 'observed',
            observationSha256: after.observationSha256, slotDigest, targetSlotBinding: binding });
    } catch { throw Error('pm2_mutation_unknown:effect_unproven'); }
}

/** Root operator only: retain full monitor material in memory for private post-effect verification. */
export async function observePinnedPm2PrivateRuntime(settings, deps = {}) {
    check((deps.effectiveUid?.() ?? process.geteuid?.()) === 0, 'private_root_required');
    return observeSession(settings, deps, async session => ({ observation: session.observed, privateEntries: session.raw }));
}
/** Verify actual interpreter and the independently pinned nearest package used by PM2's version lookup. */
export function readPinnedPm2RuntimeMetadata(settings, deps = {}) {
    check((deps.effectiveUid?.() ?? process.geteuid?.()) === 0, 'private_root_required');
    const deadline = performance.now() + 5000; const owner = deps.ownerUid ?? 0;
    check(settings.node?.path === fs.realpathSync(process.execPath), 'metadata_interpreter');
    pinFile(settings.node.path, settings.node.sha256, owner, deadline, 256 * CAP);
    check(path.isAbsolute(settings.entryPath) && fs.realpathSync(settings.entryPath) === settings.entryPath, 'metadata_entry');
    let directory = settings.entryPath;
    while (directory !== path.dirname(directory)) {
        remaining(deadline); const candidate = path.join(directory, 'package.json');
        if (fs.existsSync(candidate)) {
            check(candidate === settings.packageJson?.path, 'metadata_package_lookup');
            const bytes = pinFile(candidate, settings.packageJson.sha256, owner, deadline);
            const parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
            check(typeof parsed.version === 'string' && parsed.version.length > 0 && parsed.version.length <= 128, 'metadata_version');
            return Object.freeze({ version: parsed.version, nodeVersion: process.versions.node });
        }
        directory = path.dirname(directory);
    }
    throw unknown('metadata_package_missing');
}
