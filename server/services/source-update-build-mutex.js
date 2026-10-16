/**
 * ADR-207 §3.3 (T-2024, qa A2): the in-process build mutex.
 *
 * One candidate build at a time per source tree in this process, whoever
 * builds it: the job's updateSource() today, the prestager (S3) later. It
 * replaces the closure-local `updateRunning` flag, which only serialized calls
 * of one updater instance. It is a single-flight guard, not a queue: a caller
 * that finds it held is refused at once and decides itself (the job reports
 * `update_in_progress`; the prestager skips its cycle). Cross-process ordering
 * is the maintenance-gate locks' job, not this one.
 */
import path from 'node:path';

const holders = new Map();

function keyOf(appRoot) {
    if (typeof appRoot !== 'string' || !appRoot) throw new TypeError('build mutex needs a source root');
    return path.resolve(appRoot);
}

/**
 * Take the build mutex of `appRoot` if it is free.
 * @param {string} appRoot the source tree the build belongs to
 * @param {{kind: string, [key: string]: unknown}} owner who holds it (for status and logs)
 * @returns {{owner: object, release: () => void} | null} null when another caller holds it
 */
export function tryAcquireBuildMutex(appRoot, owner) {
    const key = keyOf(appRoot);
    if (holders.has(key)) return null;
    const token = { owner: Object.freeze({ ...owner, since: Date.now() }) };
    holders.set(key, token);
    return {
        owner: token.owner,
        // Idempotent, and a stale handle never frees a later holder.
        release() { if (holders.get(key) === token) holders.delete(key); },
    };
}

/** The current holder of `appRoot`'s build mutex, or null. */
export function buildMutexHolder(appRoot) {
    return holders.get(keyOf(appRoot))?.owner ?? null;
}
