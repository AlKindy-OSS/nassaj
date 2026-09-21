/** Typed operations for the existing service-owned capsule; never impersonates the separate root permit protocol. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import Message from '../vendor/pm2-codec/amp-message/index.js';
import { runExistingPm2Observation, sendPinnedPm2TypedFrame, capturePm2PeerCredentialReader } from './pm2-existing-transport.mjs';
import { inspectForwardChildIdentity, canonicalForwardValue as canonical } from './release-runtime-forward-child-protocol.mjs';
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
const fail = reason => { throw new Error(`pm2_service_owner_${reason}`); };
const check = (value, reason) => { if (!value) fail(reason); };
// These fields describe observations, not launch configuration. Unknown fields remain pinned.
const TELEMETRY = new Set(['pm_id', 'status', 'pm_uptime', 'restart_time', 'unstable_restarts',
    'created_at', 'exit_code', 'node_version', 'axm_actions', 'axm_monitor', 'versioning', 'vizion_running']);
const CHANGING_ENV = new Set(['NASSAJ_UPDATE_MODE', 'NASSAJ_PREVIEW_TRANSACTION_NONCE', 'NASSAJ_PREVIEW_BOOT_NONCE']);

/** Pin a pre-existing daemon/socket; inventory preparation cannot start or repair PM2. */
export function captureServiceOwnerObserver(pm2Home, runtime) {
    check(path.isAbsolute(pm2Home) && fs.realpathSync(pm2Home) === pm2Home, 'home');
    const pid = Number(fs.readFileSync(path.join(pm2Home, 'pm2.pid'), 'utf8').trim());
    const daemon = inspectForwardChildIdentity(pid);
    check(daemon.uids.every(uid => uid === process.getuid()) && process.getuid() > 0, 'uid');
    const command = fs.readFileSync(`/proc/${pid}/cmdline`).toString().replaceAll('\0', ' ').trim();
    check(/^PM2 v[0-9.]+: God Daemon /.test(command) && command.endsWith(`(${pm2Home})`), 'daemon');
    if (runtime) {
        const app = inspectForwardChildIdentity(runtime.pid);
        check(app.parentPid === pid && app.startTicks === runtime.startTicks && app.bootId === daemon.bootId, 'parent');
    }
    const socketPath = path.join(pm2Home, 'rpc.sock'), stat = fs.lstatSync(socketPath, { bigint: true });
    check(stat.isSocket() && Number(stat.uid) === process.getuid() && fs.realpathSync(socketPath) === socketPath, 'socket');
    const rows = fs.readFileSync(`/proc/${pid}/net/unix`, 'utf8').split('\n').map(line => line.trim().split(/\s+/))
        .filter(row => row.length === 8 && row[7] === socketPath && row[3] === '00010000' && row[4] === '0001');
    check(rows.length === 1, 'socket_ambiguous');
    return { socketPath, daemon: { pid, startTicks: daemon.startTicks, bootId: daemon.bootId, uid: process.getuid(),
        exeSha256: hash(fs.readFileSync(`/proc/${pid}/exe`)) },
        socketIdentity: { device: String(stat.dev), inode: String(stat.ino), uid: Number(stat.uid), listenerInode: rows[0][6],
            networkNamespace: fs.readlinkSync(`/proc/${pid}/ns/net`) },
        ss: { path: '/usr/bin/ss', sha256: hash(fs.readFileSync('/usr/bin/ss')) }, peerCredentialReader: capturePm2PeerCredentialReader() };
}
/** Private in-memory service metadata; never serialize the returned environment into diagnostics. */
export function observeServiceOwnerPm2(settings) {
    check(settings.daemon.uid === process.getuid() && process.getuid() > 0, 'uid');
    return runExistingPm2Observation(settings, { Message, ownerUid: process.getuid() }, async session => session.raw);
}
/** Pin every non-telemetry field; the three mutable environment keys are checked separately. */
export function serviceOwnerSlotControls(slot) {
    check(Number.isSafeInteger(slot.pm_id) && slot.pm_id >= 0 && slot.pm2_env, 'slot');
    return { pmId: slot.pm_id, values: Object.fromEntries(Object.entries(slot.pm2_env)
        .filter(([key]) => key !== 'env' && !TELEMETRY.has(key) && !CHANGING_ENV.has(key))) };
}
/** PM2 spawns with flattened pm2_env: nested and effective copies must never disagree. */
export function assertServiceOwnerEnvironmentCopies(slot) {
    const effective=slot.pm2_env, nested=effective.env || {};
    for (const key of CHANGING_ENV) check(Object.hasOwn(effective,key) === Object.hasOwn(nested,key), 'environment_shadow');
    for (const [key,value] of Object.entries(nested)) {
        if (Object.hasOwn(effective,key)) check(canonical(effective[key]) === canonical(value), 'environment_shadow');
    }
    return nested;
}
function exactSlot(rows, authority) {
    const matches = rows.filter(row => row.pm_id === authority.pmId || row.pm2_env?.name === authority.name);
    check(matches.length === 1, 'slot_ambiguous');
    const slot = matches[0];
    check(slot.pm_id === authority.pmId && slot.pm2_env?.name === authority.name
        && slot.pm2_env.namespace === authority.namespace && hash(serviceOwnerSlotControls(slot)) === authority.controlsSha256, 'slot_changed');
    check(hash(assertServiceOwnerEnvironmentCopies(slot)) === authority.environmentSha256, 'environment_changed');
    return slot;
}
function validatedEnvironment(before, after) {
    check(before && after && Object.getPrototypeOf(after) === Object.prototype, 'environment');
    check(Object.keys(before).every(key => Object.hasOwn(after, key))
        && Object.keys(after).every(key => Object.hasOwn(before, key) || CHANGING_ENV.has(key)), 'environment_keys');
    for (const key of Object.keys(after)) {
        check(typeof after[key] === 'string' || canonical(after[key]) === canonical(before[key]), 'environment_value');
        if (!CHANGING_ENV.has(key)) check(canonical(before[key]) === canonical(after[key]), 'environment_delta');
    }
    if (Object.hasOwn(after, 'NASSAJ_UPDATE_MODE')) check(['release', 'local-main'].includes(after.NASSAJ_UPDATE_MODE), 'mode');
    for (const key of ['NASSAJ_PREVIEW_TRANSACTION_NONCE', 'NASSAJ_PREVIEW_BOOT_NONCE']) {
        check(/^[a-f0-9]{64}$/.test(after[key] || ''), 'nonce');
    }
    return Object.fromEntries([...CHANGING_ENV].filter(key => Object.hasOwn(after, key)).map(key => [key, after[key]]));
}
function deriveStep(session, authority, step) {
    const slot = exactSlot(session.raw, authority);
    check(['stop-old', 'start-stopped'].includes(step), 'step');
    if (step === 'stop-old') {
        check(slot.pid === authority.previous.pid && slot.pm2_env.status === 'online', 'old_slot');
        const app = inspectForwardChildIdentity(slot.pid);
        check(app.parentPid === authority.observer.daemon.pid && app.startTicks === authority.previous.startTicks
            && app.bootId === authority.observer.daemon.bootId && app.uids.every(uid => uid === process.getuid()), 'old_identity');
        return { method: 'stopProcessId', payload: slot.pm_id };
    }
    check(slot.pid === 0 && slot.pm2_env.status === 'stopped', 'not_stopped');
    try { const prior = inspectForwardChildIdentity(authority.previous.pid);
        check(prior.startTicks !== authority.previous.startTicks || prior.bootId !== authority.observer.daemon.bootId, 'old_alive');
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    return { method: 'restartProcessId', payload: { id: slot.pm_id,
        env: validatedEnvironment(slot.pm2_env.env || {}, authority.nextEnvironment) } };
}
/** One RPC under the capsule's durable lease; callback authority is internal code, never request data. */
export async function executeServiceOwnerPm2Step(authority, step, hooks) {
    check(authority?.schema === 'nassaj-pm2-service-owner/v1' && authority.observer?.daemon.uid === process.getuid()
        && process.getuid() > 0 && typeof hooks?.authorize === 'function' && typeof hooks?.unknown === 'function', 'authority');
    let dispatched = false;
    try {
        return await runExistingPm2Observation(authority.observer, { Message, ownerUid: process.getuid() }, async session => {
            const plan = deriveStep(session, authority, step);
            plan.intent = { requestId: randomBytes(16).toString('hex'), step, payloadSha256: hash(plan.payload),
                daemonSha256: hash(session.observed.daemon), slotSha256: hash(exactSlot(session.raw, authority)) };
            await hooks.authorize(plan.intent);
            await session.peer(authority.observer, session.socket, session.deadline);
            session.inspect(authority.observer, session.deadline);
            deriveStep(session, authority, step);
            session.socket.off('data', session.unexpectedData);
            dispatched = true;
            const reply = await sendPinnedPm2TypedFrame(session.socket, session.Message, plan, session.deadline);
            session.socket.on('data', session.unexpectedData);
            await session.peer(authority.observer, session.socket, session.deadline);
            check(canonical(session.inspect(authority.observer, session.deadline).daemon) === canonical(session.observed.daemon), 'daemon_changed');
            return reply;
        });
    } catch (error) {
        if (dispatched) await hooks.unknown({ step, reason: 'effect_unproven' });
        throw error;
    }
}
