/**
 * The single shape of `activation-action.json` (B-1583). The writer
 * (server/services/source-updater.js) builds it here, and every strict reader
 * validates it here, so an optional field added on one side can no longer be
 * rejected by the other. Path binding (manifestPath, transactionId vs. the
 * candidate directory) stays with each reader: only it knows the context.
 */

export const SOURCE_UPDATE_ACTION_SCHEMA = 'nassaj-source-update-activation/v1';
const TX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** A string matching `pattern`; a number or other value never coerces into a match. */
function matches(value, pattern) {
    return typeof value === 'string' && pattern.test(value);
}

export const SOURCE_UPDATE_ACTION_REQUIRED_KEYS = Object.freeze([
    'expectedServerBuildId', 'manifestPath', 'manifestSha256', 'originalHead',
    'schema', 'targetCommit', 'transactionId', 'version',
]);
/** B-1264: the commit of the runtime loaded before the update, when known. */
export const SOURCE_UPDATE_ACTION_OPTIONAL_KEYS = Object.freeze(['previousRuntimeOid']);

/**
 * Build the action exactly as the updater persists it. `previousRuntimeOid` is
 * kept only when it is a full lowercase commit id; anything else is dropped.
 */
export function buildSourceUpdateAction({
    transactionId, originalHead, targetCommit, version, manifestPath, manifestSha256,
    expectedServerBuildId, previousRuntimeOid = null,
}) {
    return {
        schema: SOURCE_UPDATE_ACTION_SCHEMA, transactionId,
        originalHead, targetCommit, version,
        manifestPath, manifestSha256,
        expectedServerBuildId,
        ...(matches(previousRuntimeOid, SHA40) ? { previousRuntimeOid } : {}),
    };
}

/**
 * Whether `action` has exactly the persisted shape: every required key, no key
 * outside required + optional, and each field in its format.
 */
export function isSourceUpdateActionShape(action) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
    const allowed = new Set([...SOURCE_UPDATE_ACTION_REQUIRED_KEYS, ...SOURCE_UPDATE_ACTION_OPTIONAL_KEYS]);
    const keys = Object.keys(action);
    if (keys.some((key) => !allowed.has(key))
        || SOURCE_UPDATE_ACTION_REQUIRED_KEYS.some((key) => !Object.hasOwn(action, key))) return false;
    return action.schema === SOURCE_UPDATE_ACTION_SCHEMA
        && matches(action.transactionId, TX)
        && matches(action.originalHead, SHA40)
        && matches(action.targetCommit, SHA40)
        && typeof action.version === 'string'
        && typeof action.manifestPath === 'string'
        && matches(action.manifestSha256, SHA256)
        && matches(action.expectedServerBuildId, SHA256)
        && (!Object.hasOwn(action, 'previousRuntimeOid') || matches(action.previousRuntimeOid, SHA40));
}
