import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BoundedJcsError,
  canonicalizeBoundedJcs,
  issueTrustedSourceEventIdCapability,
  SHADOW_CONTENT_LIMITS,
  ShadowContentIntegrityAccumulator,
  ShadowLightweightLegacyObserver,
} from './shadow-content-integrity.js';

const KEY = Buffer.from('phase-0-content-integrity-key-0123456789abcdef', 'utf8');

function accumulator(
  generation = 1,
  trustedSourceSequence = false,
  trustedSourceEventIds = false,
): ShadowContentIntegrityAccumulator {
  return new ShadowContentIntegrityAccumulator({
    runId: 'run-content-integrity',
    dispatchGeneration: generation,
    referenceKeyVersion: 1,
    referenceKey: KEY,
    trustedSourceSequence,
    trustedSourceEventIdCapability: trustedSourceEventIds
      ? issueTrustedSourceEventIdCapability()
      : undefined,
  });
}

function terminal(instance: ShadowContentIntegrityAccumulator, outcome = 'success') {
  instance.observe({ kind: 'complete', success: outcome === 'success', exitCode: 0 });
  return instance.finalize(outcome);
}

describe('bounded local JCS subset', () => {
  it('matches representative RFC 8785 serialization vectors', () => {
    assert.equal(
      canonicalizeBoundedJcs({ z: -0, a: ['line\n', { '€': 1e+30, a: 0.000001 }] }),
      '{"a":["line\\n",{"a":0.000001,"€":1e+30}],"z":0}',
    );
    assert.equal(
      canonicalizeBoundedJcs({ '😀': 1, '�': 2, a: '"\\\b\f\n\r\t' }),
      '{"a":"\\"\\\\\\b\\f\\n\\r\\t","😀":1,"�":2}',
      'keys use deterministic UTF-16 code-unit order and strings use JSON escaping',
    );
    assert.equal(canonicalizeBoundedJcs([null, true, false, [1, 2, 3]]), '[null,true,false,[1,2,3]]');
  });

  it('rejects values outside the bounded JSON subset', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined, 1n, () => 1]) {
      assert.throws(() => canonicalizeBoundedJcs(value), BoundedJcsError);
    }
    assert.throws(() => canonicalizeBoundedJcs('\ud800'), /JCS_LONE_SURROGATE/);
    assert.throws(() => canonicalizeBoundedJcs(new Date()), /JCS_TO_JSON_HOOK/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => canonicalizeBoundedJcs(cyclic), /JCS_CYCLE/);
    assert.throws(
      () => canonicalizeBoundedJcs({ a: { b: 1 } }, { maxDepth: 1 }),
      /JCS_DEPTH_EXCEEDED/,
    );
  });

  it('rejects own or inherited toJSON hooks without invoking accessors', () => {
    const ownHook = { safe: true };
    Object.defineProperty(ownHook, 'toJSON', {
      value: () => 'DANGER_ON_WIRE',
    });
    assert.throws(() => canonicalizeBoundedJcs(ownHook), /JCS_TO_JSON_HOOK/);

    const inheritedHook = Object.create({
      toJSON() {
        return 'INHERITED_DANGER';
      },
    }) as Record<string, unknown>;
    inheritedHook.safe = true;
    assert.throws(() => canonicalizeBoundedJcs(inheritedHook), /JCS_TO_JSON_HOOK/);

    let accessorReads = 0;
    const accessorHook = { safe: true };
    Object.defineProperty(accessorHook, 'toJSON', {
      get() {
        accessorReads += 1;
        return () => 'ACCESSOR_DANGER';
      },
    });
    assert.throws(
      () => canonicalizeBoundedJcs({ nested: accessorHook }),
      /JCS_TO_JSON_HOOK/,
    );
    assert.equal(accessorReads, 0);
  });

  it('allows JCS limit overrides to tighten but never expand or disable hard bounds', () => {
    assert.equal(canonicalizeBoundedJcs({ a: 1 }, { maxBytes: 16 }), '{"a":1}');
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, 300_000]) {
      assert.throws(
        () => canonicalizeBoundedJcs({ a: 1 }, { maxBytes: invalid }),
        /JCS_INVALID_LIMITS/,
      );
    }
    assert.throws(
      () => canonicalizeBoundedJcs({ a: 1 }, { maxNodes: 4_097 }),
      /JCS_INVALID_LIMITS/,
    );
    assert.throws(
      () => canonicalizeBoundedJcs({ a: 1 }, { maxDepth: 17 }),
      /JCS_INVALID_LIMITS/,
    );
  });

  it('rejects huge strings, arrays, and objects before unbounded canonicalization work', () => {
    assert.throws(
      () => canonicalizeBoundedJcs('x'.repeat(300_000)),
      /JCS_BYTES_EXCEEDED/,
    );
    assert.throws(
      () => canonicalizeBoundedJcs(new Array(5_000).fill(null)),
      /JCS_NODES_EXCEEDED/,
    );
    const wideObject: Record<string, null> = {};
    for (let index = 0; index < 5_000; index += 1) wideObject[`key-${index}`] = null;
    assert.throws(() => canonicalizeBoundedJcs(wideObject), /JCS_NODES_EXCEEDED/);

    const manyLongKeys: Record<string, null> = {};
    for (let index = 0; index < 4_095; index += 1) {
      manyLongKeys[`${String(index).padStart(4, '0')}-${'k'.repeat(80)}`] = null;
    }
    assert.throws(() => canonicalizeBoundedJcs(manyLongKeys), /JCS_BYTES_EXCEEDED/);

    Object.defineProperty(Object.prototype, 'shadowPollutedEnumerable', {
      value: null,
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(Object.prototype, 'shadowPollutedEnumerableTwo', {
      value: null,
      enumerable: true,
      configurable: true,
    });
    try {
      assert.equal(canonicalizeBoundedJcs({ safe: true }), '{"safe":true}');
      assert.throws(
        () => canonicalizeBoundedJcs({ safe: true }, { maxNodes: 2 }),
        /JCS_NODES_EXCEEDED/,
      );
    } finally {
      delete (Object.prototype as { shadowPollutedEnumerable?: unknown }).shadowPollutedEnumerable;
      delete (Object.prototype as { shadowPollutedEnumerableTwo?: unknown })
        .shadowPollutedEnumerableTwo;
    }
  });

  it('ignores JSON-invisible symbol keys without materializing a symbol-key array', () => {
    const symbolHeavy: Record<PropertyKey, unknown> = { visible: true };
    for (let index = 0; index < 10_000; index += 1) {
      symbolHeavy[Symbol(`hidden-${index}`)] = index;
    }
    const original = Object.getOwnPropertySymbols;
    Object.getOwnPropertySymbols = () => {
      throw new Error('unbounded symbol materialization must not be called');
    };
    try {
      assert.equal(canonicalizeBoundedJcs(symbolHeavy), '{"visible":true}');
      assert.equal(canonicalizeBoundedJcs(Object.assign([], {
        [Symbol('array-hidden')]: true,
      })), '[]');
    } finally {
      Object.getOwnPropertySymbols = original;
    }
  });
});

describe('shadow content integrity accumulator', () => {
  it('is invariant to transport rechunking but detects loss, reorder, and tool boundaries', () => {
    const oneChunk = accumulator();
    oneChunk.observe({ kind: 'stream_delta', content: 'A\ud83d\ude00B' });
    const oneSummary = terminal(oneChunk);
    const oneDigest = oneSummary.contentDigest;

    const rechunked = accumulator();
    rechunked.observe({ kind: 'stream_delta', content: 'A\ud83d' });
    rechunked.observe({ kind: 'stream_delta', content: '\ude00' });
    rechunked.observe({ kind: 'stream_delta', content: 'B' });
    const rechunkedSummary = terminal(rechunked);
    assert.equal(rechunkedSummary.contentDigest, oneDigest);
    assert.notEqual(
      rechunkedSummary.summaryDigest,
      oneSummary.summaryDigest,
      'transport counts remain protected separately from the fragmentation-invariant content digest',
    );

    const lost = accumulator();
    lost.observe({ kind: 'stream_delta', content: 'A\ud83d\ude00' });
    assert.notEqual(terminal(lost).contentDigest, oneDigest);

    const reordered = accumulator();
    reordered.observe({ kind: 'stream_delta', content: 'B' });
    reordered.observe({ kind: 'stream_delta', content: 'A\ud83d\ude00' });
    assert.notEqual(terminal(reordered).contentDigest, oneDigest);

    const toolBoundary = accumulator();
    toolBoundary.observe({ kind: 'stream_delta', content: 'A\ud83d\ude00' });
    toolBoundary.observe({
      kind: 'tool_use',
      toolId: 'tool-1',
      toolName: 'Read',
      input: { file_path: '/safe/path' },
    });
    toolBoundary.observe({ kind: 'stream_delta', content: 'B' });
    const toolSummary = terminal(toolBoundary);
    assert.notEqual(toolSummary.contentDigest, oneDigest);
    assert.equal(toolSummary.segmentCount, 3);

    const secondGeneration = accumulator(2);
    secondGeneration.observe({ kind: 'stream_delta', content: 'A\ud83d\ude00B' });
    assert.notEqual(terminal(secondGeneration).contentDigest, oneDigest);
  });

  it('dedupes only stable event ids and detects substitutions and trusted sequence anomalies', () => {
    const untrustedIds = accumulator();
    untrustedIds.observe({ kind: 'stream_delta', id: 'untrusted', content: 'same' });
    untrustedIds.observe({ kind: 'stream_delta', id: 'untrusted', content: 'same' });
    assert.equal(terminal(untrustedIds).duplicateEventCount, 0);

    const duplicate = accumulator(1, false, true);
    duplicate.observe({ kind: 'stream_delta', id: 'stable-1', content: 'same' });
    duplicate.observe({ kind: 'stream_delta', id: 'stable-1', content: 'same' });
    const duplicateSummary = terminal(duplicate);
    assert.equal(duplicateSummary.duplicateEventCount, 1);
    assert.equal(duplicateSummary.canonicalBytes, 8);

    const identicalWithoutIds = accumulator();
    identicalWithoutIds.observe({ kind: 'stream_delta', content: 'same' });
    identicalWithoutIds.observe({ kind: 'stream_delta', content: 'same' });
    const noIdSummary = terminal(identicalWithoutIds);
    assert.equal(noIdSummary.duplicateEventCount, 0);
    assert.equal(noIdSummary.canonicalBytes, 16);
    assert.notEqual(noIdSummary.summaryDigest, duplicateSummary.summaryDigest);

    const substitution = accumulator(1, false, true);
    substitution.observe({ kind: 'stream_delta', id: 'stable-1', content: 'first' });
    substitution.observe({ kind: 'stream_delta', id: 'stable-1', content: 'forged' });
    const substitutionSummary = terminal(substitution);
    assert.equal(substitutionSummary.integrityState, 'diverged');
    assert.equal(substitutionSummary.substitutionCount, 1);

    const untrustedSequence = accumulator();
    untrustedSequence.observe({ kind: 'stream_delta', seq: 9, content: 'a' });
    untrustedSequence.observe({ kind: 'stream_delta', seq: 2, content: 'b' });
    assert.equal(terminal(untrustedSequence).sequenceReorderCount, 0);

    const trustedSequence = accumulator(1, true);
    trustedSequence.observe({ kind: 'stream_delta', seq: 1, content: 'a' });
    trustedSequence.observe({ kind: 'stream_delta', seq: 3, content: 'b' });
    trustedSequence.observe({ kind: 'stream_delta', seq: 2, content: 'c' });
    const trustedSummary = terminal(trustedSequence);
    assert.equal(trustedSummary.integrityState, 'diverged');
    assert.equal(trustedSummary.sequenceGapCount, 1);
    assert.equal(trustedSummary.sequenceReorderCount, 1);

    const invalidTrustedSequence = accumulator(1, true);
    invalidTrustedSequence.observe({ kind: 'stream_delta', seq: 'not-an-integer', content: 'a' });
    const invalidSequenceSummary = terminal(invalidTrustedSequence);
    assert.equal(invalidSequenceSummary.integrityState, 'unknown');
    assert.equal(invalidSequenceSummary.schemaGap, true);
  });

  it('marks the summary unknown after the trusted event-ID horizon is exceeded', () => {
    const instance = accumulator(1, false, true);
    for (let index = 0; index <= SHADOW_CONTENT_LIMITS.maxEventIds; index += 1) {
      instance.observe({ kind: 'stream_delta', id: `event-${index}`, content: 'x' });
    }
    instance.observe({ kind: 'stream_delta', id: 'event-0', content: 'x' });
    const summary = terminal(instance);
    assert.equal(summary.integrityState, 'unknown');
    assert.equal(summary.schemaGap, true);
    assert.ok(summary.codes.includes('CONTENT_DEDUPE_HORIZON_EXCEEDED'));
  });

  it('does not let a rejected duplicate tool replay split an active text segment', () => {
    const baseline = accumulator(1, false, true);
    baseline.observe({
      kind: 'tool_use',
      id: 'tool-event',
      toolId: 'tool-1',
      toolName: 'Read',
      input: { file_path: '/safe' },
    });
    baseline.observe({ kind: 'stream_delta', content: 'AB' });
    const baselineSummary = terminal(baseline);

    const replayed = accumulator(1, false, true);
    const toolEvent = {
      kind: 'tool_use',
      id: 'tool-event',
      toolId: 'tool-1',
      toolName: 'Read',
      input: { file_path: '/safe' },
    };
    replayed.observe(toolEvent);
    replayed.observe({ kind: 'stream_delta', content: 'A' });
    replayed.observe(toolEvent);
    replayed.observe({ kind: 'stream_delta', content: 'B' });
    const replayedSummary = terminal(replayed);
    assert.equal(replayedSummary.contentDigest, baselineSummary.contentDigest);
    assert.equal(replayedSummary.segmentCount, baselineSummary.segmentCount);
    assert.equal(replayedSummary.duplicateEventCount, 1);
  });

  it('fails content integrity closed on schema gaps, overflow, and reentrancy', () => {
    const schemaGap = accumulator();
    schemaGap.observe({ kind: 'future_visible_kind', content: 'visible but unsupported' });
    const gapSummary = terminal(schemaGap);
    assert.equal(gapSummary.integrityState, 'unknown');
    assert.equal(gapSummary.schemaGap, true);

    const overflow = accumulator();
    overflow.observe({ kind: 'stream_delta', content: 'x'.repeat(524_289) });
    const overflowSummary = terminal(overflow);
    assert.equal(overflowSummary.integrityState, 'unknown');
    assert.equal(overflowSummary.overflow, true);
    assert.equal(overflowSummary.canonicalBytes, 0);

    const accessor = accumulator();
    let getterCalls = 0;
    const accessorPayload = {
      get kind(): string {
        getterCalls += 1;
        return 'stream_delta';
      },
      content: 'outer',
    };
    accessor.observe(accessorPayload);
    const accessorSummary = terminal(accessor);
    assert.equal(getterCalls, 0);
    assert.equal(accessorSummary.integrityState, 'unknown');
    assert.equal(accessorSummary.schemaGap, true);

    const reentrant = accumulator();
    let nested = false;
    const payload = new Proxy({ kind: 'stream_delta', content: 'outer' }, {
      getOwnPropertyDescriptor(target, property) {
        if (!nested) {
          nested = true;
          reentrant.observe({ kind: 'stream_delta', content: 'nested' });
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    reentrant.observe(payload);
    const reentrantSummary = terminal(reentrant);
    assert.equal(reentrantSummary.integrityState, 'unknown');
    assert.equal(reentrantSummary.reentrant, true);
  });

  it('fails closed on oversized structured and identity claims without retaining raw values', () => {
    const hugeStructured = accumulator();
    hugeStructured.observe({
      kind: 'tool_use',
      toolId: 'bounded-tool',
      toolName: 'Read',
      input: { blob: 'x'.repeat(2 * 1024 * 1024) },
    });
    const structuredSummary = terminal(hugeStructured);
    assert.equal(structuredSummary.integrityState, 'unknown');
    assert.equal(structuredSummary.schemaGap, true);
    assert.equal(structuredSummary.canonicalBytes, 0);

    const hugeIdentity = accumulator();
    const rawClaim = `SECRET_${'y'.repeat(2 * 1024 * 1024)}`;
    const observation = hugeIdentity.observe({
      kind: 'complete',
      provider: rawClaim,
      clientMsgId: rawClaim,
      sessionId: rawClaim,
      success: true,
      exitCode: 0,
    });
    assert.equal(observation.envelope?.provider, null);
    assert.equal(observation.envelope?.clientMsgId, null);
    assert.equal(observation.envelope?.sessionId, null);
    assert.equal(observation.envelope?.invalidProviderClaim, true);
    assert.equal(observation.envelope?.invalidClientMsgIdClaim, true);
    assert.equal(observation.envelope?.invalidSessionRef, true);
    const identitySummary = hugeIdentity.finalize('success');
    assert.equal(identitySummary.integrityState, 'unknown');
    assert.equal(identitySummary.schemaGap, true);
    assert.doesNotMatch(JSON.stringify(identitySummary), /SECRET_/);
  });

  it('does not inspect structured fields after hashing has stopped', () => {
    const instance = accumulator();
    instance.observe({ kind: 'stream_delta', content: 'x'.repeat(524_289) });
    let getterCalls = 0;
    instance.observe({
      kind: 'tool_use',
      toolId: 'must-not-be-read',
      get input(): unknown {
        getterCalls += 1;
        throw new Error('must not execute');
      },
    });
    assert.equal(getterCalls, 0);
    assert.equal(terminal(instance).integrityState, 'unknown');
  });

  it('treats terminal content as bounded control evidence, not visible content', () => {
    const instance = accumulator();
    const observation = instance.observe({
      kind: 'complete',
      content: 'control-only',
      success: true,
      exitCode: 0,
    });
    assert.match(observation.envelope?.terminalControlDigest ?? '', /^[0-9a-f]{64}$/);
    const summary = instance.finalize('success');
    assert.equal(summary.segmentCount, 0);
    assert.equal(summary.sourceChunkCount, 0);
    assert.equal(summary.canonicalBytes, 0);

    const absent = accumulator();
    const firstAbsent = absent.observe({ kind: 'complete', success: true, exitCode: 0 });
    absent.finalize('success');
    const duplicateAbsent = absent.observe({ kind: 'complete', success: true, exitCode: 0 });
    const explicitNull = absent.observe({
      kind: 'complete',
      content: null,
      success: true,
      exitCode: 0,
    });
    assert.match(firstAbsent.envelope?.terminalControlDigest ?? '', /^[0-9a-f]{64}$/);
    assert.equal(duplicateAbsent.terminalControlConflict, false);
    assert.equal(explicitNull.terminalControlConflict, true);
    assert.notEqual(
      firstAbsent.envelope?.terminalControlDigest,
      explicitNull.envelope?.terminalControlDigest,
    );
  });

  it('binds bounded visible verdict controls and fails closed on extras or truncation', () => {
    const instance = accumulator();
    const first = instance.observe({
      kind: 'error',
      error: { code: 'A', detail: 'first' },
      code: 'A',
      reason: 'first',
      aborted: false,
      success: false,
      exitCode: 1,
    });
    instance.finalize('error');
    const exact = instance.observe({
      kind: 'error',
      error: { code: 'A', detail: 'first' },
      code: 'A',
      reason: 'first',
      aborted: false,
      success: false,
      exitCode: 1,
    });
    const changed = instance.observe({
      kind: 'error',
      error: { code: 'B', detail: 'second' },
      code: 'B',
      reason: 'second',
      aborted: true,
      success: false,
      exitCode: 1,
    });
    assert.match(first.envelope?.terminalControlDigest ?? '', /^[0-9a-f]{64}$/);
    assert.equal(exact.terminalControlConflict, false);
    assert.equal(changed.terminalControlConflict, true);

    const hugeKey = `EXTRA_${'k'.repeat(100_000)}`;
    const payload: Record<string, unknown> = {
      kind: 'complete',
      success: true,
      exitCode: 0,
    };
    payload[hugeKey] = 'secret';
    const originalByteLength = Buffer.byteLength;
    Buffer.byteLength = ((value: string | NodeJS.ArrayBufferView, encoding?: BufferEncoding) => {
      if (value === hugeKey) throw new Error('huge key must be rejected before byteLength');
      return originalByteLength(value, encoding);
    }) as typeof Buffer.byteLength;
    try {
      const truncated = accumulator();
      truncated.observe(payload);
      assert.equal(truncated.finalize('success').integrityState, 'unknown');
    } finally {
      Buffer.byteLength = originalByteLength;
    }

    const surrogateExtra = accumulator();
    surrogateExtra.observe({ kind: 'complete', success: true, exitCode: 0, ['\ud800']: true });
    assert.equal(surrogateExtra.finalize('success').integrityState, 'unknown');
  });

  it('distinguishes malformed core verdict claims from absence in heavy and lightweight paths', () => {
    const malformedClaims = [
      { provider: 7 },
      { clientMsgId: {} },
      { sessionId: 42 },
      { newSessionId: false },
      { success: 'yes' },
      { exitCode: '0' },
      { notStarted: 'true' },
    ];
    for (const malformed of malformedClaims) {
      const heavy = accumulator();
      const absent = heavy.observe({ kind: 'complete' });
      heavy.finalize('unknown');
      const malformedObservation = heavy.observe({ kind: 'complete', ...malformed });
      assert.equal(malformedObservation.envelope?.invalidTerminalControlClaim, true);
      assert.equal(malformedObservation.terminalControlConflict, true);
      assert.notEqual(
        malformedObservation.envelope?.terminalControlDigest,
        absent.envelope?.terminalControlDigest,
      );

      const light = new ShadowLightweightLegacyObserver({
        runId: 'run-content-integrity',
        dispatchGeneration: 1,
        referenceKey: KEY,
      });
      light.observe({ kind: 'complete' });
      const lightMalformed = light.observe({ kind: 'complete', ...malformed });
      assert.equal(lightMalformed.envelope?.invalidTerminalControlClaim, true);
      assert.equal(lightMalformed.terminalControlConflict, true);
    }

    let accessorReads = 0;
    const accessorPayload: Record<string, unknown> = { kind: 'complete' };
    for (const field of [
      'provider',
      'clientMsgId',
      'sessionId',
      'success',
      'exitCode',
      'notStarted',
    ]) {
      Object.defineProperty(accessorPayload, field, {
        enumerable: true,
        get() {
          accessorReads += 1;
          return 'hostile';
        },
      });
    }
    const accessorAccumulator = accumulator();
    const accessorObservation = accessorAccumulator.observe(accessorPayload);
    assert.equal(accessorReads, 0);
    assert.equal(accessorObservation.envelope?.invalidTerminalControlClaim, true);
    assert.equal(accessorAccumulator.finalize('unknown').integrityState, 'unknown');
  });

  it('commits normalized harness toolInput and fails closed on conflicts or unsupported UI fields', () => {
    const fixtures = [
      { toolName: 'Read', toolInput: { file_path: '/safe/claude.txt' } },
      { toolName: 'shell', toolInput: JSON.stringify({ command: 'pwd' }) },
      { toolName: 'search', toolInput: { query: 'gemini fixture' } },
    ];
    for (const [index, fixture] of fixtures.entries()) {
      const first = accumulator();
      first.observe({ kind: 'tool_use', toolId: `tool-${index}`, ...fixture });
      const firstSummary = terminal(first);
      assert.equal(firstSummary.integrityState, 'verified');

      const changed = accumulator();
      changed.observe({
        kind: 'tool_use',
        toolId: `tool-${index}`,
        ...fixture,
        toolInput: { changed: index },
      });
      const changedSummary = terminal(changed);
      assert.equal(changedSummary.integrityState, 'verified');
      assert.notEqual(changedSummary.contentDigest, firstSummary.contentDigest);
    }

    const conflicting = accumulator();
    conflicting.observe({
      kind: 'tool_use',
      toolId: 'conflicting-tool-input',
      toolName: 'Read',
      toolInput: { path: '/preferred' },
      input: { path: '/different' },
    });
    assert.equal(terminal(conflicting).integrityState, 'unknown');

    for (const payload of [
      {
        kind: 'tool_use',
        toolId: 'tool-a',
        tool_use_id: 'tool-b',
        toolName: 'Read',
        toolInput: {},
      },
      {
        kind: 'tool_use',
        toolId: 'tool-name',
        toolName: 'Read',
        name: 'Write',
        toolInput: {},
      },
      {
        kind: 'tool_result',
        toolId: 'tool-result',
        content: 'one',
        result: 'two',
      },
      {
        kind: 'tool_result',
        toolId: 'tool-error',
        content: 'failed',
        isError: true,
        is_error: false,
      },
    ]) {
      const aliasConflict = accumulator();
      aliasConflict.observe(payload);
      assert.equal(terminal(aliasConflict).integrityState, 'unknown');
    }

    const aliasedResult = accumulator();
    aliasedResult.observe({
      kind: 'tool_result',
      tool_use_id: 'paired-tool',
      result: { output: 'first' },
      is_error: false,
    });
    const aliasedSummary = terminal(aliasedResult);
    assert.equal(aliasedSummary.integrityState, 'verified');

    const changedAliasedResult = accumulator();
    changedAliasedResult.observe({
      kind: 'tool_result',
      tool_use_id: 'paired-tool',
      result: { output: 'second' },
      is_error: false,
    });
    const changedAliasedSummary = terminal(changedAliasedResult);
    assert.equal(changedAliasedSummary.integrityState, 'verified');
    assert.notEqual(changedAliasedSummary.contentDigest, aliasedSummary.contentDigest);

    const differentPair = accumulator();
    differentPair.observe({
      kind: 'tool_result',
      tool_use_id: 'different-tool',
      result: { output: 'first' },
      is_error: false,
    });
    assert.notEqual(terminal(differentPair).contentDigest, aliasedSummary.contentDigest);

    for (const [field, value] of Object.entries({
      toolResult: { content: 'visible result' },
      toolUseResult: { agentId: 'visible-agent' },
      subagentTools: [{ toolId: 'child' }],
      images: ['visible-image'],
      displayText: 'visible display override',
      parentToolUseId: 'visible-parent',
      futureVisibleField: 'future-visible',
    })) {
      const unsupported = accumulator();
      unsupported.observe({ kind: 'stream_delta', content: 'text', [field]: value });
      assert.equal(terminal(unsupported).integrityState, 'unknown', field);
    }
  });

  it('fails closed when top-level or nested toJSON changes the serialized wire payload', () => {
    const topLevelPayload = { kind: 'stream_delta', content: 'safe' };
    Object.defineProperty(topLevelPayload, 'toJSON', {
      value: () => 'DANGER_ON_WIRE',
    });
    assert.equal(JSON.stringify(topLevelPayload), '"DANGER_ON_WIRE"');
    const topLevel = accumulator();
    topLevel.observe(topLevelPayload);
    const topLevelSummary = terminal(topLevel);
    assert.equal(topLevelSummary.integrityState, 'unknown');
    assert.equal(topLevelSummary.schemaGap, true);

    const nestedInput = { path: '/safe' };
    Object.defineProperty(nestedInput, 'toJSON', {
      value: () => ({ path: '/danger-on-wire' }),
    });
    const nestedPayload = {
      kind: 'tool_use',
      toolId: 'to-json-tool',
      toolName: 'Read',
      toolInput: nestedInput,
    };
    assert.match(JSON.stringify(nestedPayload), /danger-on-wire/);
    const nested = accumulator();
    nested.observe(nestedPayload);
    const nestedSummary = terminal(nested);
    assert.equal(nestedSummary.integrityState, 'unknown');
    assert.equal(nestedSummary.schemaGap, true);
    assert.equal(nestedSummary.segmentCount, 0);
  });

  it('rejects conflicting cached terminal finalization after a transaction retry', () => {
    const instance = accumulator();
    instance.observe({ kind: 'complete', content: 'first', success: true, exitCode: 0 });
    const first = instance.finalize('success');
    assert.equal(instance.finalize('success'), first);
    instance.observe({ kind: 'error', content: 'second', success: false, exitCode: 1 });
    assert.throws(() => instance.finalize('error'), /SHADOW_CONTENT_TERMINAL_CLAIM_CONFLICT/);
    assert.throws(() => instance.finalize('success'), /SHADOW_CONTENT_TERMINAL_CLAIM_CONFLICT/);

    const sameOutcomeDifferentKind = accumulator();
    sameOutcomeDifferentKind.observe({ kind: 'complete', success: false, exitCode: 1 });
    sameOutcomeDifferentKind.finalize('error');
    sameOutcomeDifferentKind.observe({ kind: 'error', success: false, exitCode: 1 });
    assert.throws(
      () => sameOutcomeDifferentKind.finalize('error'),
      /SHADOW_CONTENT_TERMINAL_CLAIM_CONFLICT/,
    );
  });

  it('fails closed for non-allowlisted roles and saturates counters at the schema bound', () => {
    for (const role of ['system', 'operator', '\ud800']) {
      const invalidRole = accumulator();
      invalidRole.observe({ kind: 'stream_delta', role, content: 'x' });
      assert.equal(terminal(invalidRole).integrityState, 'unknown');
    }
    const saturated = accumulator();
    for (let index = 0; index < SHADOW_CONTENT_LIMITS.maxSourceChunks + 10; index += 1) {
      saturated.observe({ kind: 'stream_delta', content: 'x' });
    }
    const summary = terminal(saturated);
    assert.equal(summary.sourceChunkCount, SHADOW_CONTENT_LIMITS.maxSourceChunks + 1);
    assert.equal(summary.overflow, true);
  });

  it('bounds the reference-key version before unsigned framing', () => {
    assert.doesNotThrow(() => new ShadowContentIntegrityAccumulator({
      runId: 'max-key-version',
      dispatchGeneration: 1,
      referenceKeyVersion: 0xffff_ffff,
      referenceKey: KEY,
    }));
    assert.throws(() => new ShadowContentIntegrityAccumulator({
      runId: 'overflow-key-version',
      dispatchGeneration: 1,
      referenceKeyVersion: 0x1_0000_0000,
      referenceKey: KEY,
    }), /INVALID_SHADOW_REFERENCE_KEY_VERSION/);
  });

  it('normalizes invalid and huge direct terminal outcomes before hashing or summary storage', () => {
    const invalid = accumulator();
    const summary = invalid.finalize(`INVALID_${'x'.repeat(2 * 1024 * 1024)}`);
    assert.equal(summary.terminalOutcome, 'unknown');
    assert.equal(summary.integrityState, 'unknown');
    assert.equal(summary.schemaGap, true);
    assert.doesNotMatch(JSON.stringify(summary), /INVALID_/);
  });

  it('keeps 100k small chunks in bounded retained state', () => {
    const instance = accumulator();
    for (let index = 0; index < 100_000; index += 1) {
      instance.observe({ kind: 'stream_delta', content: 'x'.repeat(16) });
    }
    const summary = terminal(instance);
    assert.equal(summary.sourceChunkCount, 100_000);
    assert.equal(summary.canonicalBytes, 3_200_000);
    assert.equal(summary.segmentCount, 1);
    assert.ok(instance.getRetainedEvidenceEstimate() < 1024 * 1024);
  });
});
