/** B-1585: the equal-target guard shared by the update worker and the updater. */
const SHA40 = /^[0-9a-f]{40}$/;

export const TARGET_ALREADY_LOADED = 'source_update_target_already_loaded';
/** The target is a strict ancestor of the running runtime: installing it would downgrade. */
export const TARGET_NOT_NEWER = 'source_update_target_not_newer';
/** Codes whose job is moot rather than failed: the worker settles them `superseded`. */
export const SUPERSEDING_TARGET_CODES = Object.freeze({
    [TARGET_ALREADY_LOADED]: 'The requested release is already the running version.',
    [TARGET_NOT_NEWER]: 'The requested release is older than the running version.',
});

/**
 * Whether `target` is exactly the commit the running server was built from.
 * An unreadable or malformed runtime commit is never "equal": the guard only
 * settles on positive evidence.
 */
export function isTargetAlreadyLoaded(target, loadedRuntimeCommit) {
    const loaded = readLoadedRuntimeCommit(loadedRuntimeCommit);
    return loaded !== null && loaded === target;
}

/** The running runtime commit when it is a full SHA-1 object id, else null. */
export function readLoadedRuntimeCommit(loadedRuntimeCommit) {
    let loaded = null;
    try { loaded = typeof loadedRuntimeCommit === 'function' ? loadedRuntimeCommit() : null; } catch { loaded = null; }
    return SHA40.test(loaded || '') ? loaded : null;
}
