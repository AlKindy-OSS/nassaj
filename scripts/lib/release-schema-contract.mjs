/** Core-only validation and canonical hashing for composite release schema artifacts. */
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

export const RELEASE_SCHEMA_PLAN = 'nassaj-release-schema-plan/v2';
export const RELEASE_SCHEMA_TRANSITIONS = 'nassaj-release-schema-transitions/v1';
export const RELEASE_SCHEMA_TRANSITION = 'nassaj-release-schema-transition/v1';
export const MAX_RELEASE_SCHEMA_CANONICAL_BYTES = 256 * 1024;
export const COMPOSITE_DATABASE_MIGRATION_ID = 'release-schema-forward/v2';
export const COMPOSITE_DATABASE_OBSERVATION_POLICY = 'release-schema-metadata/v2';

const HEX = /^[a-f0-9]{64}$/;
const COMPONENT_ID = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+)*$/;
const PLAN_KEYS = ['components', 'schema'];
const COMPONENT_KEYS = ['componentId', 'ddlManifestSha256', 'dependencies', 'implementationSha256', 'order',
    'sourceStateDigests', 'targetStateDigest', 'version'];
const TRANSITIONS_KEYS = ['pairs', 'schema'];
const PAIR_KEYS = ['source', 'target', 'transitionId'];
const OBSERVATION_KEYS = ['compatibilityShapeDigest', 'migrationStateDigest', 'schemaDigest'];
const DATABASE_CONTRACT_KEYS = ['activationPolicy', 'databasePolicy', 'failurePolicy', 'migrationClosure',
    'migrationClosureSha256', 'migrationEntrySha256', 'migrationId', 'observationPolicy', 'releaseIdentitySha256',
    'schema', 'schemaPlan', 'schemaPlanSha256', 'schemaTransitions', 'schemaTransitionsSha256', 'startup'];

const fail = reason => { throw Error(`release_schema_${reason}`); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameKeys = (value, expected) => Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');

function assertJsonValue(value, state = { seen: new Set(), nodes: 0 }, depth = 0) {
    state.nodes += 1;
    if (state.nodes > 8_192 || depth > 16) fail('json_bounds_exceeded');
    if (value === null || value === undefined) fail('json_value_invalid');
    if (typeof value === 'string') {
        if (Buffer.byteLength(value) > MAX_RELEASE_SCHEMA_CANONICAL_BYTES) fail('canonical_too_large');
        return;
    }
    if (typeof value === 'boolean') return;
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail('json_number_invalid');
        return;
    }
    if (typeof value !== 'object') fail('json_value_invalid');
    if (state.seen.has(value)) fail('json_cycle');
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
        if (prototype !== Array.prototype || Object.keys(value).length !== value.length) fail('json_array_invalid');
    } else if (prototype !== Object.prototype && prototype !== null) fail('json_object_invalid');
    const names = Object.keys(value);
    if (names.some(name => Buffer.byteLength(name) > MAX_RELEASE_SCHEMA_CANONICAL_BYTES)) fail('canonical_too_large');
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(key => typeof key !== 'string')
        || ownKeys.length !== names.length + (Array.isArray(value) ? 1 : 0)
        || ownKeys.some(key => key !== 'length' && !names.includes(key))) fail('json_property_invalid');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (names.some(name => !descriptors[name]?.enumerable || !Object.hasOwn(descriptors[name], 'value'))) fail('json_property_invalid');
    state.seen.add(value);
    for (const name of names) assertJsonValue(descriptors[name].value, state, depth + 1);
    state.seen.delete(value);
}

function canonicalUnchecked(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalUnchecked).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalUnchecked(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function canonicalBounded(value) {
    assertJsonValue(value);
    const canonicalJson = canonicalUnchecked(value);
    if (Buffer.byteLength(canonicalJson) > MAX_RELEASE_SCHEMA_CANONICAL_BYTES) fail('canonical_too_large');
    return canonicalJson;
}

function assertRecord(value, keys, reason) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !sameKeys(value, keys)) fail(reason);
}

function assertDigest(value, reason = 'digest_invalid') {
    if (typeof value !== 'string' || !HEX.test(value)) fail(reason);
}

function assertSortedUnique(values, validate, reason) {
    if (!Array.isArray(values)) fail(reason);
    let previous;
    for (let index = 0; index < values.length; index += 1) {
        validate(values[index]);
        if (index > 0 && values[index] <= previous) fail(reason);
        previous = values[index];
    }
}

function freezeJson(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freezeJson(child);
        Object.freeze(value);
    }
    return value;
}

function canonicalClone(value) {
    return freezeJson(JSON.parse(canonicalUnchecked(value)));
}

function validateObservation(value) {
    assertRecord(value, OBSERVATION_KEYS, 'observation_invalid');
    for (const key of OBSERVATION_KEYS) assertDigest(value[key], 'observation_invalid');
    return canonicalClone(value);
}

function decodeCanonicalInput(input) {
    let text;
    if (typeof input === 'string') text = input;
    else if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
        if (input.byteLength > MAX_RELEASE_SCHEMA_CANONICAL_BYTES) fail('canonical_too_large');
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(input); }
        catch { fail('canonical_encoding_invalid'); }
    } else fail('canonical_input_invalid');
    if (Buffer.byteLength(text) > MAX_RELEASE_SCHEMA_CANONICAL_BYTES) fail('canonical_too_large');
    let value;
    try { value = JSON.parse(text); } catch { fail('canonical_json_invalid'); }
    return { text, value };
}

/** Canonicalize a bounded strict JSON-domain value. */
export function canonicalReleaseSchemaJson(value) {
    return canonicalBounded(value);
}

/** Validate a composite schema plan and return its immutable canonical value and sibling hash. */
export function validateReleaseSchemaPlan(value) {
    assertJsonValue(value);
    assertRecord(value, PLAN_KEYS, 'plan_invalid');
    if (value.schema !== RELEASE_SCHEMA_PLAN || !Array.isArray(value.components)
        || value.components.length < 1 || value.components.length > 64) fail('plan_invalid');
    const priorIds = new Set();
    for (let index = 0; index < value.components.length; index += 1) {
        const component = value.components[index];
        assertRecord(component, COMPONENT_KEYS, 'component_invalid');
        if (typeof component.componentId !== 'string' || component.componentId.length > 128
            || !COMPONENT_ID.test(component.componentId) || priorIds.has(component.componentId)
            || !Number.isSafeInteger(component.version) || component.version <= 0
            || !Number.isSafeInteger(component.order) || component.order !== index) fail('component_invalid');
        assertDigest(component.implementationSha256, 'component_invalid');
        assertDigest(component.ddlManifestSha256, 'component_invalid');
        assertDigest(component.targetStateDigest, 'component_invalid');
        if (component.dependencies.length > 64) fail('dependency_invalid');
        assertSortedUnique(component.dependencies, dependency => {
            if (typeof dependency !== 'string' || !priorIds.has(dependency)) fail('dependency_invalid');
        }, 'dependency_invalid');
        if (component.sourceStateDigests.length < 1 || component.sourceStateDigests.length > 16) fail('source_digest_invalid');
        assertSortedUnique(component.sourceStateDigests, digest => assertDigest(digest, 'source_digest_invalid'), 'source_digest_invalid');
        if (component.sourceStateDigests.includes(component.targetStateDigest)) fail('source_target_overlap');
        priorIds.add(component.componentId);
    }
    const canonicalJson = canonicalBounded(value);
    const plan = canonicalClone(value);
    return Object.freeze({ plan, canonicalJson, schemaPlanSha256: hash(canonicalJson) });
}

/** Parse an exact canonical plan representation, rejecting duplicate keys and trailing material. */
export function parseCanonicalReleaseSchemaPlan(input) {
    const { text, value } = decodeCanonicalInput(input);
    const validated = validateReleaseSchemaPlan(value);
    if (text !== validated.canonicalJson) fail('canonical_representation_invalid');
    return validated;
}

/** Compute the transition identity from the plan hash and full source/target observations only. */
export function computeReleaseSchemaTransitionId(schemaPlanSha256, source, target) {
    assertDigest(schemaPlanSha256, 'plan_hash_invalid');
    const validSource = validateObservation(source);
    const validTarget = validateObservation(target);
    const material = { schema: RELEASE_SCHEMA_TRANSITION, schemaPlanSha256, source: validSource, target: validTarget };
    return hash(canonicalBounded(material));
}

/** Validate the finite transition set and return its immutable canonical value and sibling hash. */
export function validateReleaseSchemaTransitions(value, schemaPlanSha256) {
    assertJsonValue(value);
    assertDigest(schemaPlanSha256, 'plan_hash_invalid');
    assertRecord(value, TRANSITIONS_KEYS, 'transitions_invalid');
    if (value.schema !== RELEASE_SCHEMA_TRANSITIONS || !Array.isArray(value.pairs)
        || value.pairs.length < 1 || value.pairs.length > 16) fail('transitions_invalid');
    const sources = new Set();
    const targets = new Set();
    let previousId;
    for (const pair of value.pairs) {
        assertRecord(pair, PAIR_KEYS, 'transition_invalid');
        const source = validateObservation(pair.source);
        const target = validateObservation(pair.target);
        const sourceKey = canonicalUnchecked(source);
        const targetKey = canonicalUnchecked(target);
        if (sourceKey === targetKey || sources.has(sourceKey) || targets.has(targetKey)
            || sources.has(targetKey) || targets.has(sourceKey)) fail('transition_ambiguous');
        const expectedId = computeReleaseSchemaTransitionId(schemaPlanSha256, source, target);
        if (pair.transitionId !== expectedId || (previousId !== undefined && pair.transitionId <= previousId)) fail('transition_invalid');
        sources.add(sourceKey); targets.add(targetKey); previousId = pair.transitionId;
    }
    const canonicalJson = canonicalBounded(value);
    const transitions = canonicalClone(value);
    return Object.freeze({ transitions, canonicalJson, schemaTransitionsSha256: hash(canonicalJson) });
}

/** Parse an exact canonical transition representation against its independently supplied plan hash. */
export function parseCanonicalReleaseSchemaTransitions(input, schemaPlanSha256) {
    const { text, value } = decodeCanonicalInput(input);
    const validated = validateReleaseSchemaTransitions(value, schemaPlanSha256);
    if (text !== validated.canonicalJson) fail('canonical_representation_invalid');
    return validated;
}

/** Validate an immutable composite database contract embedded in a release artifact. */
export function validateCompositeDatabaseReleaseContract(contract, expectedReleaseIdentity, expectedStartupClosureSha256) {
    assertJsonValue(contract);
    assertRecord(contract, DATABASE_CONTRACT_KEYS, 'database_contract_invalid');
    assertDigest(expectedReleaseIdentity, 'database_contract_invalid');
    assertDigest(expectedStartupClosureSha256, 'database_contract_invalid');
    assertDigest(contract.migrationEntrySha256, 'database_contract_invalid');
    assertDigest(contract.migrationClosureSha256, 'database_contract_invalid');
    assertRecord(contract.migrationClosure, ['assetManifestBound', 'schema', 'sha256'], 'database_contract_invalid');
    assertRecord(contract.startup, ['closureSha256', 'policyId'], 'database_contract_invalid');
    if (contract.schema !== 'nassaj-database-release-contract/v2'
        || contract.releaseIdentitySha256 !== expectedReleaseIdentity
        || contract.migrationClosure.schema !== 'nassaj-database-migration-closure/v2'
        || contract.migrationClosure.assetManifestBound !== true
        || contract.migrationClosure.sha256 !== contract.migrationClosureSha256
        || contract.activationPolicy !== 'compatible-forward'
        || contract.failurePolicy !== 'maintenance-preserve-current-db'
        || contract.databasePolicy !== 'existing-inode-no-restore'
        || contract.migrationId !== COMPOSITE_DATABASE_MIGRATION_ID
        || contract.observationPolicy !== COMPOSITE_DATABASE_OBSERVATION_POLICY
        || contract.startup.policyId !== 'existing-security-state/v1'
        || contract.startup.closureSha256 !== expectedStartupClosureSha256) fail('database_contract_invalid');
    const plan = validateReleaseSchemaPlan(contract.schemaPlan);
    if (plan.schemaPlanSha256 !== contract.schemaPlanSha256) fail('database_contract_plan_hash_mismatch');
    const transitions = validateReleaseSchemaTransitions(contract.schemaTransitions, plan.schemaPlanSha256);
    if (transitions.schemaTransitionsSha256 !== contract.schemaTransitionsSha256) fail('database_contract_transitions_hash_mismatch');
    return Object.freeze({ ...contract, migrationClosure: Object.freeze({ ...contract.migrationClosure }),
        schemaPlan: plan.plan, schemaTransitions: transitions.transitions, startup: Object.freeze({ ...contract.startup }) });
}
