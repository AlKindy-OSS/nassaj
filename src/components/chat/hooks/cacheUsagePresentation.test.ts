import { describe, expect, it } from 'vitest';
import { cacheUsagePresentation, newestContextUsage } from './contextUsagePresentation';
import { nativeSnapshot } from './contextUsagePresentation.fixtures';
const snapshot = (extra = {}) => ({ version: 1, provider: 'codex', sessionId: 's1', modelId: 'm1', source: 'native', scope: 'last_request', inputTokens: 1000, cacheReadTokens: 600, observedAt: null, receivedAt: '2026-09-13T12:00:00Z', sequence: 2, transport: 'live', ...extra });
const display = (extra = {}) => cacheUsagePresentation({ cacheSnapshot: snapshot(extra) }, 'codex', 's1', 'm1');
describe('independent cache presentation', () => {
  it('uses inclusive input for both providers and does not invent observation time', () => {
    expect(display().ratio).toBe(.6);
    expect(cacheUsagePresentation({ cacheSnapshot: snapshot({ provider: 'claude' }) }, 'claude', 's1', 'm1').ratio).toBe(.6);
    expect(display().observedAt).toBeNull();
  });
  it('distinguishes measured zero, missing, and empty input', () => {
    expect(display({ cacheReadTokens: 0 }).ratio).toBe(0);
    expect(display({ cacheReadTokens: null }).state).toBe('unknown');
    expect(display({ inputTokens: 0, cacheReadTokens: 0 }).state).toBe('empty');
    expect(display({ inputTokens: 0 }).ratio).toBeNull();
  });
  it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1, 1001])('rejects invalid reads %s', value => expect(display({ cacheReadTokens: value }).ratio).toBeNull());
  it.each([{ sessionId: 's2' }, { modelId: 'm2' }, { provider: 'claude' }, { source: '' }, { scope: 'madeup' }, { version: 2 }])('rejects incompatible observation %j', extra => expect(display(extra).ratio).toBeNull());
  it('retains scope and original time', () => {
    expect(display({ scope: 'turn', observedAt: '2026-09-13T10:00:00Z', transport: 'history' })).toMatchObject({ scope: 'turn', historical: true, observedAt: '2026-09-13T10:00:00Z' });
  });
  it('keeps cache across context-only events and late hydration without timestamps', () => {
    const current = { contextSnapshot: nativeSnapshot(), cacheSnapshot: snapshot() };
    const contextOnly = { contextSnapshot: nativeSnapshot({ observedAt: '2026-09-13T15:00:00Z' }) };
    expect(newestContextUsage(current, contextOnly)?.cacheSnapshot).toBe(current.cacheSnapshot);
    expect(newestContextUsage(current, { ...contextOnly, cacheSnapshot: snapshot({ transport: 'history', sequence: 9 }) }, 'hydration')?.cacheSnapshot).toBe(current.cacheSnapshot);
  });
  it.each([[3, '2026-09-13T09:00:00Z', true], [1, '2026-09-13T13:00:00Z', false]] as const)('prioritizes source sequence %s over conflicting time', (sequence, observedAt, accept) => {
    const current = { cacheSnapshot: snapshot({ sequence: 2, observedAt: '2026-09-13T12:00:00Z' }) };
    const incoming = { cacheSnapshot: snapshot({ sequence, observedAt }) };
    expect(newestContextUsage(current, incoming)?.cacheSnapshot).toBe(accept ? incoming.cacheSnapshot : current.cacheSnapshot);
  });
  it('keeps source sequence precedence and preserves a compact tombstone', () => {
    const current = { contextSnapshot: nativeSnapshot(), cacheSnapshot: snapshot() };
    expect(newestContextUsage(current, { ...current, cacheSnapshot: snapshot({ sequence: 1 }) })?.cacheSnapshot).toBe(current.cacheSnapshot);
    const cleared = newestContextUsage(current, { ...current, cacheSnapshot: null });
    expect(cleared?.cacheSnapshot).toBeNull();
    expect(newestContextUsage(cleared, { ...current, cacheSnapshot: snapshot({ transport: 'history' }) }, 'hydration')?.cacheSnapshot).toBeNull();
  });
});
