import { describe, expect, it } from 'vitest';

import { contextUsagePresentation, newestContextUsage } from './contextUsagePresentation';
import { nativeSnapshot } from './contextUsagePresentation.fixtures';

const read = (snapshot: unknown, provider = 'codex') => contextUsagePresentation({ contextSnapshot: snapshot }, provider, 's1', 'm1');

describe('context usage presentation provenance', () => {
  it('preserves real occupancy and the original threshold separately', () => {
    expect(read(nativeSnapshot())).toMatchObject({ used: 120_000, window: 240_000, native: 200_000, proposed: 120_000 });
  });
  it('does not treat last-request input as current occupancy', () => {
    expect(read(nativeSnapshot({ usageKind: 'last_request_input' }))).toMatchObject({ used: null, lastInput: 120_000 });
  });
  it('surfaces transcript input tokens as a ring estimate when observedAt is absent', () => {
    // server/index.js sets observedAt=null for Claude sessions restored from transcript
    // (commit 7855652d5). The ring must show a percentage rather than '?' for past sessions.
    const transcript = nativeSnapshot({ usageKind: 'last_request_input', observedAt: null });
    expect(read(transcript)).toMatchObject({ used: 120_000, window: 240_000 });
    // A null observedAt on a live kind (native_reported_context) stays fully invalid.
    expect(read(nativeSnapshot({ observedAt: null }))).toMatchObject({ used: null, window: null });
  });
  it('never trusts a legacy or cumulative-only counter', () => {
    expect(contextUsagePresentation({ used: 160_000, total: 258_400, cumulativeUsed: 20_000_000 }, 'codex', 's1', 'm1')).toMatchObject({ used: null, window: null, cumulative: 20_000_000 });
  });
  it.each([{ provider: 'claude' }, { sessionId: 'old' }, { modelId: 'old' }, { modelId: null }, { source: '' }, { observedAt: null }, { observedAt: 'bad' }, { version: 2 }])('invalidates mismatched or incomplete native identity %j', (patch) => {
    expect(read(nativeSnapshot(patch))).toMatchObject({ used: null, window: null, proposed: null });
  });
  it.each([null, undefined, -1, NaN, Infinity, '200', 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects non-numeric, missing or invalid counts %s', (value) => {
    expect(read(nativeSnapshot({ usedTokens: value, windowTokens: value }))).toMatchObject({ used: null, window: null });
  });
  it('accepts a proven zero without inventing a positive window', () => {
    expect(read(nativeSnapshot({ usedTokens: 0, windowTokens: 0 }))).toMatchObject({ used: 0, window: null });
  });
  it('does not repeatedly multiply a policy-adjusted threshold', () => {
    expect(read(nativeSnapshot({ proposedCompactTokens: 72_000 })).proposed).toBeNull();
    expect(read(nativeSnapshot({ nativeCompactTokens: null })).proposed).toBeNull();
  });
  it('applies the fixed exception to the carrier even with another model', () => {
    expect(read(nativeSnapshot({ provider: 'claude', nativeCompactTokens: null, proposedCompactTokens: null }), 'claude')).toMatchObject({ proposed: 150_000, newSession: 250_000 });
  });
});


describe('picker alias identity (B-1295)', () => {
  it('accepts a picker alias when snapshot carries the same alias', () => {
    const snapshot = nativeSnapshot({ modelId: 'opus[1m]', windowTokens: 1_048_576 });
    expect(contextUsagePresentation({ contextSnapshot: snapshot }, 'codex', 's1', 'opus[1m]'))
      .toMatchObject({ window: 1_048_576, used: 120_000 });
  });
  it('still rejects when alias does not match native id', () => {
    // snapshot carries 'opus[1m]' but prop carries 'claude-opus-5' → mismatch
    const snapshot = nativeSnapshot({ modelId: 'opus[1m]', windowTokens: 1_048_576 });
    expect(contextUsagePresentation({ contextSnapshot: snapshot }, 'codex', 's1', 'claude-opus-5'))
      .toMatchObject({ window: null, used: null });
  });
});

describe('native snapshot ordering', () => {
  const current = { contextSnapshot: nativeSnapshot() };
  it('ignores an older event for the same identity after compaction', () => {
    const older = { contextSnapshot: nativeSnapshot({ observedAt: '2026-09-13T11:00:00Z', usedTokens: 220_000 }) };
    expect(newestContextUsage(current, older)).toBe(current);
  });
  it('preserves live context when a delayed REST hydration arrives without native timing', () => {
    const history = { contextSnapshot: nativeSnapshot({ usageKind: 'last_request_input', observedAt: null }) };
    expect(newestContextUsage(current, history, 'hydration')).toBe(current);
    expect(newestContextUsage(current, history, 'event')).toBe(history);
    expect(newestContextUsage(current, null, 'hydration')).toBeNull();
    expect(newestContextUsage(current, { unavailable: true }, 'hydration')).toEqual({ unavailable: true });
  });
  it('keeps a compaction invalidation newer than delayed pre-compaction events', () => {
    const boundary = { contextSnapshot: nativeSnapshot({ modelId: null, usageKind: 'unknown', usedTokens: null, windowTokens: null, observedAt: '2026-09-13T13:00:00Z' }) };
    expect(newestContextUsage(current, boundary)).toBe(boundary);
    expect(newestContextUsage(boundary, current)).toBe(boundary);
    expect(newestContextUsage(boundary, { contextSnapshot: nativeSnapshot({ observedAt: null }) }, 'hydration')).toBe(boundary);
    const fresh = { contextSnapshot: nativeSnapshot({ observedAt: '2026-09-13T14:00:00Z', usedTokens: 10_000 }) };
    expect(newestContextUsage(boundary, fresh)).toBe(fresh);
  });
  it('accepts newer readings, identity changes and explicit clearing', () => {
    const newer = { contextSnapshot: nativeSnapshot({ observedAt: '2026-09-13T13:00:00Z', usedTokens: 20_000 }) };
    expect(newestContextUsage(current, newer)).toBe(newer);
    const changed = { contextSnapshot: nativeSnapshot({ modelId: 'm2' }) };
    expect(newestContextUsage(current, changed)).toBe(changed);
    expect(newestContextUsage(current, null)).toBeNull();
    expect(newestContextUsage(null, newer)).toBe(newer);
    expect(newestContextUsage(current, { unavailable: true })).toEqual({ unavailable: true });
  });
});
