/**
 * The single shape of `activation-action.json` (B-1583, T-2004). The writer
 * (server/services/source-updater.js and the local-recovery operator) builds it
 * here, and every reader validates it here. Path binding (manifestPath,
 * transactionId vs. the candidate directory) stays with each reader: only it
 * knows the context.
 *
 * Compatibility contract (open-world reader, docs/RELEASING.md):
 * - The version lives in the `schema` id: `nassaj-source-update-activation/v<major>[.<minor>]`.
 *   A bare `/v1` is v1.0.
 * - A reader accepts every minor of a major it supports whose required keys are
 *   present and well-formed. Keys it does not know are ignored, never a
 *   rejection cause. A known optional key is still validated when present.
 * - Within a major a writer may only ADD optional keys. Removing, renaming or
 *   retyping a key is a new major, which an older reader refuses with
 *   `source_update_action_schema_unsupported` (a clear error, not a stall).
 * - The writer persists the bare `/v1` id and only the eight required keys plus
 *   `previousRuntimeOid`: the 2.3.1.2 and 2.3.1.3 readers compare the id by
 *   equality and reject any other key, and a node on those releases still reads
 *   what a newer release wrote after a downgrade or a failed handoff. Adding a
 *   key or a minor id to the WRITTEN record waits until no supported upgrade
 *   source runs those readers.
 */

export const SOURCE_UPDATE_ACTION_SCHEMA_FAMILY = 'nassaj-source-update-activation';
/** The major this code reads and writes. */
export const SOURCE_UPDATE_ACTION_SCHEMA_MAJOR = 1;
/** The exact id the writer persists (see the contract above for why it stays bare). */
export const SOURCE_UPDATE_ACTION_SCHEMA = `${SOURCE_UPDATE_ACTION_SCHEMA_FAMILY}/v1`;
/** Refusal code for a record of a newer, incompatible major. */
export const SOURCE_UPDATE_ACTION_SCHEMA_UNSUPPORTED = 'source_update_action_schema_unsupported';
/** Refusal code for a record that is not a well-formed action of a supported major. */
export const SOURCE_UPDATE_ACTION_INVALID = 'source_update_action_invalid';

const SCHEMA_ID = /^nassaj-source-update-activation\/v(0|[1-9][0-9]{0,3})(?:\.(0|[1-9][0-9]{0,3}))?$/;
const TX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** A string matching `pattern`; a number or other value never coerces into a match. */
function matches(value, pattern) {
    return typeof value === 'string' && pattern.test(value);
}

/** Every required key with its format check. The key list is derived from here. */
const REQUIRED = Object.freeze({
    expectedServerBuildId: (value) => matches(value, SHA256),
    manifestPath: (value) => typeof value === 'string',
    manifestSha256: (value) => matches(value, SHA256),
    originalHead: (value) => matches(value, SHA40),
    schema: (value) => typeof value === 'string',
    targetCommit: (value) => matches(value, SHA40),
    transactionId: (value) => matches(value, TX),
    version: (value) => typeof value === 'string',
});
/** Known optional keys: validated when present. B-1264: previousRuntimeOid. */
const OPTIONAL = Object.freeze({
    previousRuntimeOid: (value) => matches(value, SHA40),
});

export const SOURCE_UPDATE_ACTION_REQUIRED_KEYS = Object.freeze(Object.keys(REQUIRED));
export const SOURCE_UPDATE_ACTION_OPTIONAL_KEYS = Object.freeze(Object.keys(OPTIONAL));

/**
 * Parse a schema id into its version, or null when it is not of this family.
 * @param {unknown} id
 * @returns {{ major: number, minor: number } | null}
 */
export function parseSourceUpdateActionSchema(id) {
    const match = typeof id === 'string' ? SCHEMA_ID.exec(id) : null;
    return match ? { major: Number(match[1]), minor: Number(match[2] ?? 0) } : null;
}

/**
 * Build the action exactly as the updater persists it. `previousRuntimeOid` is
 * kept only when it is a full lowercase commit id; anything else is dropped.
 * Key order is part of the activation identity hash and must not change.
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
 * Validate an action under the open-world contract.
 * @param {unknown} action the parsed record
 * @returns {{ ok: true, version: { major: number, minor: number }, unknownKeys: string[] }
 *   | { ok: false, code: string }}
 */
export function checkSourceUpdateAction(action) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) return { ok: false, code: SOURCE_UPDATE_ACTION_INVALID };
    const version = parseSourceUpdateActionSchema(action.schema);
    if (!version || version.major < SOURCE_UPDATE_ACTION_SCHEMA_MAJOR) return { ok: false, code: SOURCE_UPDATE_ACTION_INVALID };
    if (version.major > SOURCE_UPDATE_ACTION_SCHEMA_MAJOR) return { ok: false, code: SOURCE_UPDATE_ACTION_SCHEMA_UNSUPPORTED };
    const requiredOk = Object.entries(REQUIRED)
        .every(([key, valid]) => Object.hasOwn(action, key) && valid(action[key]));
    const optionalOk = Object.entries(OPTIONAL)
        .every(([key, valid]) => !Object.hasOwn(action, key) || valid(action[key]));
    if (!requiredOk || !optionalOk) return { ok: false, code: SOURCE_UPDATE_ACTION_INVALID };
    const unknownKeys = Object.keys(action).filter((key) => !Object.hasOwn(REQUIRED, key) && !Object.hasOwn(OPTIONAL, key));
    return { ok: true, version, unknownKeys };
}

/** Whether `action` is a valid action of a supported major (unknown keys ignored). */
export function isSourceUpdateActionShape(action) {
    return checkSourceUpdateAction(action).ok;
}

/**
 * Throw a bounded code unless `action` is valid. A newer major always throws
 * `source_update_action_schema_unsupported`; anything else invalid throws
 * `invalidCode`, so each reader keeps its established refusal code.
 */
export function assertSourceUpdateAction(action, invalidCode = SOURCE_UPDATE_ACTION_INVALID) {
    const result = checkSourceUpdateAction(action);
    if (!result.ok) {
        throw new Error(result.code === SOURCE_UPDATE_ACTION_SCHEMA_UNSUPPORTED ? result.code : invalidCode);
    }
    return result;
}
