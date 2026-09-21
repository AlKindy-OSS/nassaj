/** Callback-scoped singleton adapter over the unchanged existing PM2 transport. */
import { randomBytes } from 'node:crypto';
import { assertHeldPm2SingletonLease } from './pm2-singleton-observer.mjs';
import { runExistingPm2Observation, sendPinnedPm2TypedFrame,
    verifyPinnedPm2PeerCredentials } from './pm2-existing-transport.mjs';
import { canonicalForwardValue as canonical } from './release-runtime-forward-child-protocol.mjs';

const RESTARTED_LEASES = new WeakSet();
const DELTA_KEYS = Object.freeze(['NASSAJ_UPDATE_MODE', 'NASSAJ_PREVIEW_TRANSACTION_NONCE', 'NASSAJ_PREVIEW_BOOT_NONCE']);
const unknown = reason => Error(`pm2_observation_unknown:${reason}`);
const check = (value, reason) => { if (!value) throw unknown(reason); };

function dataObject(value, reason) {
    check(value && Object.getPrototypeOf(value) === Object.prototype, reason);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    check(Reflect.ownKeys(descriptors).every(key => typeof key === 'string'
        && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable), reason);
    return value;
}

function text(value, reason) {
    check(typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value), reason);
}

function environmentDelta(before, after) {
    check(Object.keys(before).every(key => Object.hasOwn(after, key))
        && Object.keys(after).every(key => Object.hasOwn(before, key) || DELTA_KEYS.includes(key)), 'restart_environment_keys');
    for (const [key, value] of Object.entries(after)) {
        if (DELTA_KEYS.includes(key)) check(typeof value === 'string', 'restart_environment_value');
        else check(canonical(value) === canonical(before[key]), 'restart_environment_delta');
    }
    if (Object.hasOwn(after, DELTA_KEYS[0])) check(['release', 'local-main'].includes(after[DELTA_KEYS[0]]), 'restart_mode');
    for (const key of DELTA_KEYS.slice(1)) if (Object.hasOwn(after, key)) check(/^[a-f0-9]{64}$/.test(after[key]), 'restart_nonce');
    return Object.fromEntries(DELTA_KEYS.filter(key => Object.hasOwn(after, key)
        && canonical(after[key]) !== canonical(before[key])).map(key => [key, after[key]]));
}

function request(value) {
    const keys = ['schema', 'pmId', 'name', 'namespace', 'expectedEnvironment', 'nextEnvironment'];
    dataObject(value, 'restart_request');
    check(Object.keys(value).sort().join() === keys.sort().join()
        && value.schema === 'nassaj-pm2-restart-existing-request/v1'
        && Number.isSafeInteger(value.pmId) && value.pmId >= 0, 'restart_request');
    text(value.name, 'restart_name'); text(value.namespace, 'restart_namespace');
    dataObject(value.expectedEnvironment, 'restart_environment'); dataObject(value.nextEnvironment, 'restart_environment');
    environmentDelta(value.expectedEnvironment, value.nextEnvironment);
    return value;
}

function exactSlot(rows, authority) {
    check(Array.isArray(rows), 'reply_array');
    const byId = rows.filter(row => row?.pm_id === authority.pmId);
    const byName = rows.filter(row => row?.pm2_env?.name === authority.name
        && row?.pm2_env?.namespace === authority.namespace);
    check(byId.length === 1 && byName.length === 1, 'restart_slot_ambiguous');
    check(byId[0] === byName[0], 'restart_slot_conflict');
    const slot = byId[0], env = dataObject(slot.pm2_env?.env, 'restart_environment');
    for (const key of DELTA_KEYS) check(Object.hasOwn(slot.pm2_env, key) === Object.hasOwn(env, key)
        && (!Object.hasOwn(env, key) || canonical(slot.pm2_env[key]) === canonical(env[key])),
    'restart_environment_shadow');
    for (const [key, value] of Object.entries(env)) check(Object.hasOwn(slot.pm2_env, key)
        && canonical(slot.pm2_env[key]) === canonical(value), 'restart_environment_shadow');
    check(canonical(env) === canonical(authority.expectedEnvironment), 'restart_environment_changed');
    return slot;
}

function leaseDependencies(heldLease, deps) {
    const credentials = deps.peerCredentials || verifyPinnedPm2PeerCredentials;
    return { ...deps, async peerCredentials(...args) {
        await credentials(...args); assertHeldPm2SingletonLease(heldLease);
    } };
}

function acknowledgement(result, authority) {
    const slot = exactSlot(Array.isArray(result) ? result : [result],
        { ...authority, expectedEnvironment: authority.nextEnvironment });
    return Object.freeze({ schema: 'nassaj-pm2-restart-ack/v1', state: 'acknowledged', pmId: slot.pm_id,
        name: authority.name, namespace: authority.namespace });
}

/** Read getMonitorData only while the exact observer lease remains kernel-held. */
export async function observePinnedPm2UnderLease(settings, heldLease, deps = {}) {
    assertHeldPm2SingletonLease(heldLease);
    return runExistingPm2Observation(settings, leaseDependencies(heldLease, deps), session => {
        assertHeldPm2SingletonLease(heldLease); return session.observed;
    });
}

/** Send exactly one restartProcessId; its response is only an acknowledgement, never health. */
export async function restartPinnedPm2UnderLease(settings, heldLease, requestValue, deps = {}) {
    const authority = request(requestValue);
    assertHeldPm2SingletonLease(heldLease); check(!RESTARTED_LEASES.has(heldLease), 'restart_already_attempted');
    let dispatched = false;
    try {
        return await runExistingPm2Observation(settings, leaseDependencies(heldLease, deps), async session => {
            const slot = exactSlot(session.raw, authority);
            const payload = { id: slot.pm_id, env: environmentDelta(authority.expectedEnvironment, authority.nextEnvironment) };
            assertHeldPm2SingletonLease(heldLease); check(!RESTARTED_LEASES.has(heldLease), 'restart_already_attempted');
            RESTARTED_LEASES.add(heldLease); dispatched = true;
            const plan = { method: 'restartProcessId', payload, intent: { requestId: randomBytes(16).toString('hex') } };
            session.socket.off('data', session.unexpectedData);
            const result = await sendPinnedPm2TypedFrame(session.socket, session.Message, plan, session.deadline);
            session.socket.on('data', session.unexpectedData);
            const accepted = acknowledgement(result, authority);
            assertHeldPm2SingletonLease(heldLease);
            return accepted;
        });
    } catch (error) { if (dispatched) throw unknown('restart_effect_unknown'); throw error; }
}
