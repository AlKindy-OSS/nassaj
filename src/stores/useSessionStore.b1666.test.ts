/**
 * B-1666 — session store: bounded memory (#7), echo-only dedupe (#11) and the
 * light400 rebase that replaced the revision-pinned expansion (#2).
 *
 * RUNNER: vitest.
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../utils/api', () => ({ authenticatedFetch }));

import { computeMerged, MAX_SESSION_SLOTS, useSessionStore, type NormalizedMessage } from './useSessionStore';

const at = (second: number) => `2026-10-17T10:00:${String(second).padStart(2, '0')}.000Z`;

function row(id: string, sessionId: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { id, sessionId, kind: 'text', role: 'assistant', provider: 'claude', timestamp: at(1), content: id, ...overrides };
}

function snapshot(messages: NormalizedMessage[], extra: Record<string, unknown> = {}) {
  return { messages, total: messages.length, hasMore: false, nextCursor: null, tokenUsage: null,
    responseTurnDurationTotalMs: null, historySchema: 1, payloadMode: 'light' as const, revision: 'rev-1', ...extra };
}

function mountStore() {
  return renderHook(() => useSessionStore()).result;
}

/** Fill the store with idle slots s0..s(count-1), oldest first. */
function fill(store: ReturnType<typeof mountStore>, count: number) {
  act(() => {
    for (let i = 0; i < count; i += 1) store.current.appendRealtime(`s${i}`, row(`r${i}`, `s${i}`));
  });
}

beforeEach(() => { authenticatedFetch.mockReset(); });

describe('B-1666 #7 — bounded session slots', () => {
  it('evicts the least recently used idle slots beyond the cap', () => {
    const store = mountStore();
    fill(store, MAX_SESSION_SLOTS + 5);
    expect(store.current.has('s0')).toBe(false);
    expect(store.current.has('s4')).toBe(false);
    expect(store.current.has('s5')).toBe(true);
    expect(store.current.has(`s${MAX_SESSION_SLOTS + 4}`)).toBe(true);
  });

  it('a read refreshes recency', () => {
    const store = mountStore();
    fill(store, MAX_SESSION_SLOTS);
    act(() => {
      store.current.getSessionSlot('s0');
      store.current.appendRealtime('newest', row('n', 'newest'));
    });
    expect(store.current.has('s0')).toBe(true);
    expect(store.current.has('s1')).toBe(false);
  });

  it('never evicts the active, retained, streaming or unsent-prompt slots, even when oldest', () => {
    const store = mountStore();
    act(() => {
      store.current.setActiveSession('active');
      store.current.appendRealtime('active', row('a', 'active'));
      store.current.setRetainedSessions(['running']);
      store.current.appendRealtime('running', row('b', 'running'));
      store.current.updateStreaming('streaming', 'partial', 'claude');
      store.current.appendRealtime('unsent', row('cmid_1', 'unsent', { role: 'user', content: 'hi' }));
    });
    fill(store, MAX_SESSION_SLOTS + 10);
    for (const id of ['active', 'running', 'streaming', 'unsent']) expect(store.current.has(id)).toBe(true);
  });

  it('forgets the lastSeq of an evicted id, so a reopened slot replays from 0', () => {
    const store = mountStore();
    act(() => {
      store.current.appendRealtime('old', row('o', 'old'));
      store.current.recordSeq('old', 42);
    });
    fill(store, MAX_SESSION_SLOTS + 1);
    expect(store.current.has('old')).toBe(false);
    expect(store.current.getLastSeq('old')).toBe(0);
    expect(store.current.getMessages('old')).toEqual([]);
  });

  it('drops aliases that point at an evicted id', () => {
    const store = mountStore();
    act(() => {
      store.current.appendRealtime('before', row('x', 'before'));
      store.current.replaceSessionId('before', 'after');
    });
    expect(store.current.getMessages('before').map((m) => m.id)).toEqual(['x']);
    fill(store, MAX_SESSION_SLOTS + 1);
    act(() => { store.current.appendRealtime('before', row('fresh', 'before')); });
    expect(store.current.getMessages('before').map((m) => m.id)).toEqual(['fresh']);
    expect(store.current.has('after')).toBe(false);
  });

  it('a late history response of an evicted slot never applies to its reopened slot', () => {
    const store = mountStore();
    let lateGeneration = 0;
    act(() => { lateGeneration = store.current.beginHistoryRequest('victim'); });
    fill(store, MAX_SESSION_SLOTS + 1);
    expect(store.current.has('victim')).toBe(false);

    act(() => { store.current.appendRealtime('victim', row('v', 'victim')); });
    expect(store.current.isHistoryRequestCurrent('victim', lateGeneration)).toBe(false);
    expect(store.current.getSlot('victim').historyGeneration).not.toBe(lateGeneration);
  });

  it('checking an evicted request does not resurrect its slot', () => {
    const store = mountStore();
    let generation = 0;
    act(() => { generation = store.current.beginHistoryRequest('gone'); });
    fill(store, MAX_SESSION_SLOTS + 1);
    expect(store.current.isHistoryRequestCurrent('gone', generation)).toBe(false);
    expect(store.current.has('gone')).toBe(false);
  });
});

describe('B-1666 #11 — dedupe collapses only a live echo of a persisted reply', () => {
  const reply = (id: string, second: number, overrides: Partial<NormalizedMessage> = {}) =>
    row(id, 's', { content: 'same text', timestamp: at(second), ...overrides });

  it('keeps two persisted identical replies (reload view)', () => {
    const server = [reply('p1', 1), reply('p2', 2)];
    expect(computeMerged(server, []).map((m) => m.id)).toEqual(['p1', 'p2']);
    expect(computeMerged(server, [row('u', 's', { role: 'user', timestamp: at(0) })])
      .filter((m) => m.role === 'assistant').map((m) => m.id)).toEqual(['p1', 'p2']);
  });

  it('keeps two finalized live identical replies (live view equals reload)', () => {
    const live = [reply('text_1', 1, { clientStream: true }), reply('text_2', 2, { clientStream: true })];
    expect(computeMerged([], live).map((m) => m.id)).toEqual(['text_1', 'text_2']);
  });

  it('collapses a live echo with its persisted reply, both realtime (B-1024)', () => {
    const merged = computeMerged([], [reply('text_1', 1, { clientStream: true }), reply('p1', 2)]);
    expect(merged).toHaveLength(1);
  });

  it('collapses a live echo against the persisted server row', () => {
    const merged = computeMerged([reply('p1', 2)], [reply('text_1', 1, { clientStream: true })]);
    expect(merged.map((m) => m.id)).toEqual(['text_1']);
  });

  it('collapses a live Codex reply with its history twin', () => {
    const merged = computeMerged([reply('msg_ab12', 2, { provider: 'codex' })],
      [reply('codex-nonce-item_0', 1, { provider: 'codex' })]);
    expect(merged).toHaveLength(1);
  });
});

describe('B-1666 #2 — applyLightHistoryRebase', () => {
  it('adopts the new revision, keeps enriched rows and never shrinks a wider window', () => {
    const store = mountStore();
    const older = Array.from({ length: 5 }, (_, i) => row(`old-${i}`, 's1', { timestamp: at(i) }));
    act(() => {
      store.current.applyHistorySnapshot('s1', snapshot([
        ...older,
        row('m1', 's1', { timestamp: at(10), toolInput: { path: 'README.md' } } as Partial<NormalizedMessage>),
      ], { payloadMode: 'full', hasMore: true }));
      store.current.applyLightHistoryRebase('s1', snapshot([
        row('m1', 's1', { timestamp: at(10), deferredPayload: { fields: ['toolInput'] } } as Partial<NormalizedMessage>),
        row('m2', 's1', { timestamp: at(11), deferredPayload: { fields: ['images'] } } as Partial<NormalizedMessage>),
      ], { revision: 'rev-2', total: 7, hasMore: true }));
    });
    const slot = store.current.getSlot('s1');
    expect(slot.historyRevision).toBe('rev-2');
    expect(slot.historyPayloadMode).toBe('light');
    expect(slot.serverMessages.map((m) => m.id)).toEqual(['old-0', 'old-1', 'old-2', 'old-3', 'old-4', 'm1', 'm2']);
    expect((slot.serverMessages[5] as any).toolInput).toEqual({ path: 'README.md' });
    expect(slot.serverMessages[5].deferredPayload).toBeUndefined();
    expect(slot.serverMessages[6].deferredPayload?.fields).toEqual(['images']);
    expect(slot.offset).toBe(7);
  });

  it('clears a parked revision conflict of any automatic read', () => {
    const store = mountStore();
    act(() => {
      store.current.setHistoryError('s1',
        { ok: false, status: 409, code: 'HISTORY_REVISION_CHANGED', retryAfterMs: null }, 'reconnect');
      store.current.applyLightHistoryRebase('s1', snapshot([row('m1', 's1')], { revision: 'rev-2' }));
    });
    expect(store.current.getSlot('s1').historyError).toBeNull();
  });

  it('keeps a manual-only failure', () => {
    const store = mountStore();
    act(() => {
      store.current.setHistoryError('s1',
        { ok: false, status: 413, code: 'HISTORY_BUDGET_EXCEEDED', retryAfterMs: null }, 'older');
      store.current.applyLightHistoryRebase('s1', snapshot([row('m1', 's1')], { revision: 'rev-2' }));
    });
    expect(store.current.getSlot('s1').historyError?.code).toBe('HISTORY_BUDGET_EXCEEDED');
  });
});
