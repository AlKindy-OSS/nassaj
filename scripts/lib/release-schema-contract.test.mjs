import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { TextDecoder } from 'node:util';
import {
    RELEASE_SCHEMA_PLAN, RELEASE_SCHEMA_TRANSITIONS, RELEASE_SCHEMA_TRANSITION,
    MAX_RELEASE_SCHEMA_CANONICAL_BYTES,
    canonicalReleaseSchemaJson, computeReleaseSchemaTransitionId, parseCanonicalReleaseSchemaPlan,
    parseCanonicalReleaseSchemaTransitions, validateReleaseSchemaPlan, validateReleaseSchemaTransitions,
} from './release-schema-contract.mjs';

const digest = character => character.repeat(64);
const observation = (schema, shape, migration) => ({
    schemaDigest: digest(schema), compatibilityShapeDigest: digest(shape), migrationStateDigest: digest(migration),
});
const clone = value => structuredClone(value);
const planFixture = () => ({
    schema: RELEASE_SCHEMA_PLAN,
    components: [
        { componentId: 'core', version: 1, order: 0, dependencies: [], implementationSha256: digest('1'),
            ddlManifestSha256: digest('2'), sourceStateDigests: [digest('3'), digest('4')], targetStateDigest: digest('5') },
        { componentId: 'wallet/credentials', version: 2, order: 1, dependencies: ['core'], implementationSha256: digest('6'),
            ddlManifestSha256: digest('7'), sourceStateDigests: [digest('8')], targetStateDigest: digest('9') },
    ],
});

function transitionsFixture(schemaPlanSha256) {
    const observations = [
        [observation('a', 'b', 'c'), observation('d', 'e', 'f')],
        [observation('0', '1', '2'), observation('3', '4', '5')],
    ];
    const pairs = observations.map(([source, target]) => ({
        transitionId: computeReleaseSchemaTransitionId(schemaPlanSha256, source, target), source, target,
    })).sort((left, right) => left.transitionId.localeCompare(right.transitionId));
    return { schema: RELEASE_SCHEMA_TRANSITIONS, pairs };
}

const rejects = (call, pattern = /release_schema_/) => assert.throws(call, pattern);

test('plan validator creates a bounded canonical sibling hash without self-reference', () => {
    const fixture = planFixture();
    const result = validateReleaseSchemaPlan(fixture);
    assert.equal(result.canonicalJson, canonicalReleaseSchemaJson(fixture));
    assert.equal(result.schemaPlanSha256, createHash('sha256').update(result.canonicalJson).digest('hex'));
    assert.deepEqual(Object.keys(result.plan).sort(), ['components', 'schema']);
    assert.equal(Object.isFrozen(result.plan.components[0].dependencies), true);
    assert.notEqual(result.plan, fixture);
    rejects(() => validateReleaseSchemaPlan({ ...fixture, schemaPlanSha256: result.schemaPlanSha256 }));
});

test('plan validator rejects unknown, null, non-JSON, unsafe and malformed values', () => {
    const unknown = planFixture(); unknown.extra = true; rejects(() => validateReleaseSchemaPlan(unknown));
    const nil = planFixture(); nil.components[0].dependencies = null; rejects(() => validateReleaseSchemaPlan(nil));
    const missing = planFixture(); missing.components[0].version = undefined; rejects(() => validateReleaseSchemaPlan(missing));
    const nan = planFixture(); nan.components[0].version = Number.NaN; rejects(() => validateReleaseSchemaPlan(nan));
    const unsafe = planFixture(); unsafe.components[0].version = Number.MAX_SAFE_INTEGER + 1; rejects(() => validateReleaseSchemaPlan(unsafe));
    const nonJson = planFixture(); nonJson.components[0].dependencies = new Set(); rejects(() => validateReleaseSchemaPlan(nonJson));
    const symbol = planFixture(); symbol[Symbol('hidden')] = true; rejects(() => validateReleaseSchemaPlan(symbol));
    const sparse = planFixture(); sparse.components.length = 3; rejects(() => validateReleaseSchemaPlan(sparse));
});

test('plan validator rejects bad order, dependency cycles, duplicates and source-target overlap', () => {
    const order = planFixture(); order.components[1].order = 0; rejects(() => validateReleaseSchemaPlan(order));
    const forwardDependency = planFixture(); forwardDependency.components[0].dependencies = ['wallet/credentials'];
    rejects(() => validateReleaseSchemaPlan(forwardDependency), /dependency_invalid/);
    const duplicateDependency = planFixture(); duplicateDependency.components[1].dependencies = ['core', 'core'];
    rejects(() => validateReleaseSchemaPlan(duplicateDependency), /dependency_invalid/);
    const duplicateId = planFixture(); duplicateId.components[1].componentId = 'core'; rejects(() => validateReleaseSchemaPlan(duplicateId));
    const unsortedSources = planFixture(); unsortedSources.components[0].sourceStateDigests.reverse();
    rejects(() => validateReleaseSchemaPlan(unsortedSources), /source_digest_invalid/);
    const overlap = planFixture(); overlap.components[0].targetStateDigest = overlap.components[0].sourceStateDigests[0];
    rejects(() => validateReleaseSchemaPlan(overlap), /source_target_overlap/);
});

test('canonical plan parser rejects mutation, duplicate keys, trailing bytes and invalid UTF-8', () => {
    const result = validateReleaseSchemaPlan(planFixture());
    assert.equal(parseCanonicalReleaseSchemaPlan(Buffer.from(result.canonicalJson)).schemaPlanSha256, result.schemaPlanSha256);
    rejects(() => parseCanonicalReleaseSchemaPlan(` ${result.canonicalJson}`), /canonical_representation_invalid/);
    const duplicated = result.canonicalJson.replace('{', `{"schema":${JSON.stringify(RELEASE_SCHEMA_PLAN)},`);
    rejects(() => parseCanonicalReleaseSchemaPlan(duplicated), /canonical_representation_invalid/);
    rejects(() => parseCanonicalReleaseSchemaPlan(`${result.canonicalJson}\n`), /canonical_representation_invalid/);
    rejects(() => parseCanonicalReleaseSchemaPlan(Buffer.from([0xff])), /canonical_encoding_invalid/);
});

test('canonical parser rejects oversized binary input before UTF-8 decoding', t => {
    t.mock.method(TextDecoder.prototype, 'decode', () => assert.fail('oversized input must not be decoded'));
    rejects(() => parseCanonicalReleaseSchemaPlan(Buffer.alloc(MAX_RELEASE_SCHEMA_CANONICAL_BYTES + 1)), /canonical_too_large/);
});

test('transition identity binds plan hash and exactly three full observation digests', () => {
    const firstPlan = validateReleaseSchemaPlan(planFixture()).schemaPlanSha256;
    const secondPlan = digest('f');
    const source = observation('a', 'b', 'c'); const target = observation('d', 'e', 'f');
    const first = computeReleaseSchemaTransitionId(firstPlan, source, target);
    assert.notEqual(first, computeReleaseSchemaTransitionId(secondPlan, source, target));
    const material = { schema: RELEASE_SCHEMA_TRANSITION, schemaPlanSha256: firstPlan, source, target };
    assert.equal(first, createHash('sha256').update(canonicalReleaseSchemaJson(material)).digest('hex'));
    const extra = { ...source, unexpectedDigest: digest('0') };
    rejects(() => computeReleaseSchemaTransitionId(firstPlan, extra, target), /observation_invalid/);
    const nil = { ...source, schemaDigest: null };
    rejects(() => computeReleaseSchemaTransitionId(firstPlan, nil, target));
});

test('transition validator creates a canonical sibling hash and rejects self-reference', () => {
    const planHash = validateReleaseSchemaPlan(planFixture()).schemaPlanSha256;
    const fixture = transitionsFixture(planHash);
    const result = validateReleaseSchemaTransitions(fixture, planHash);
    assert.equal(result.schemaTransitionsSha256, createHash('sha256').update(result.canonicalJson).digest('hex'));
    assert.deepEqual(Object.keys(result.transitions).sort(), ['pairs', 'schema']);
    rejects(() => validateReleaseSchemaTransitions({ ...fixture, schemaTransitionsSha256: result.schemaTransitionsSha256 }, planHash));
    const wrongId = clone(fixture); wrongId.pairs[0].transitionId = digest('0');
    rejects(() => validateReleaseSchemaTransitions(wrongId, planHash), /transition_invalid/);
    const reverse = clone(fixture); reverse.pairs.reverse();
    rejects(() => validateReleaseSchemaTransitions(reverse, planHash), /transition_invalid/);
});

test('transition validator rejects duplicate or overlapping sources and targets', () => {
    const planHash = validateReleaseSchemaPlan(planFixture()).schemaPlanSha256;
    const fixture = transitionsFixture(planHash);
    const duplicateSource = clone(fixture); duplicateSource.pairs[1].source = clone(duplicateSource.pairs[0].source);
    duplicateSource.pairs[1].transitionId = computeReleaseSchemaTransitionId(planHash, duplicateSource.pairs[1].source, duplicateSource.pairs[1].target);
    duplicateSource.pairs.sort((a, b) => a.transitionId.localeCompare(b.transitionId));
    rejects(() => validateReleaseSchemaTransitions(duplicateSource, planHash), /transition_ambiguous/);
    const overlap = clone(fixture); overlap.pairs[1].source = clone(overlap.pairs[0].target);
    overlap.pairs[1].transitionId = computeReleaseSchemaTransitionId(planHash, overlap.pairs[1].source, overlap.pairs[1].target);
    overlap.pairs.sort((a, b) => a.transitionId.localeCompare(b.transitionId));
    rejects(() => validateReleaseSchemaTransitions(overlap, planHash), /transition_ambiguous/);
    const duplicateTarget = clone(fixture); duplicateTarget.pairs[1].target = clone(duplicateTarget.pairs[0].target);
    duplicateTarget.pairs[1].transitionId = computeReleaseSchemaTransitionId(planHash, duplicateTarget.pairs[1].source,
        duplicateTarget.pairs[1].target);
    duplicateTarget.pairs.sort((a, b) => a.transitionId.localeCompare(b.transitionId));
    rejects(() => validateReleaseSchemaTransitions(duplicateTarget, planHash), /transition_ambiguous/);
    const samePair = clone(fixture); samePair.pairs[0].target = clone(samePair.pairs[0].source);
    samePair.pairs[0].transitionId = computeReleaseSchemaTransitionId(planHash, samePair.pairs[0].source, samePair.pairs[0].target);
    samePair.pairs.sort((a, b) => a.transitionId.localeCompare(b.transitionId));
    rejects(() => validateReleaseSchemaTransitions(samePair, planHash), /transition_ambiguous/);
    const extra = clone(fixture); extra.pairs[0].unexpected = true;
    rejects(() => validateReleaseSchemaTransitions(extra, planHash), /transition_invalid/);
});

test('canonical transition parser rejects noncanonical and duplicate-key representations', () => {
    const planHash = validateReleaseSchemaPlan(planFixture()).schemaPlanSha256;
    const result = validateReleaseSchemaTransitions(transitionsFixture(planHash), planHash);
    assert.equal(parseCanonicalReleaseSchemaTransitions(result.canonicalJson, planHash).schemaTransitionsSha256,
        result.schemaTransitionsSha256);
    rejects(() => parseCanonicalReleaseSchemaTransitions(`\n${result.canonicalJson}`, planHash), /canonical_representation_invalid/);
    const duplicated = result.canonicalJson.replace('{', `{"schema":${JSON.stringify(RELEASE_SCHEMA_TRANSITIONS)},`);
    rejects(() => parseCanonicalReleaseSchemaTransitions(duplicated, planHash), /canonical_representation_invalid/);
});
