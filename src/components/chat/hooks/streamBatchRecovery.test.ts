import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../contexts/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ refreshProjects: async () => {} }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const authenticatedFetch = vi.fn(async (..._args: unknown[]) => ({ ok: false, status: 503 }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args) }));

import { applyStreamFrame, MAX_STREAM_FRAMES, type StreamFrameMap } from '../../../contexts/streamFrameLog';
import { useSessionStore } from '../../../stores/useSessionStore';

import { clearOutbox, getOutboxSnapshot, recordOutboxEntry, setOutboxUser } from '../utils/messageOutbox';

import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';

const sessionId = 'batched-session';
const base = {
  latestMessage: null, controlFrames: new Map(), provider: 'claude' as const,
  selectedSession: { id: sessionId } as any, currentSessionId: sessionId,
  setCurrentSessionId: () => {}, setIsLoading: () => {}, setCanAbortSession: () => {},
  setClaudeStatus: () => {}, setTokenBudget: () => {}, setPendingPermissionRequests: () => {},
  pendingViewSessionRef: { current: null } as any,
  streamTimerRef: { current: null } as any, accumulatedStreamRef: { current: new Map() } as any,
};

function batch(frames: any[]): StreamFrameMap {
  return frames.reduce((map, frame, index) => applyStreamFrame(map, { sessionId, ...frame }, index + 1), new Map());
}

function mount(frames: StreamFrameMap) {
  return renderHook(({ streamFrames }) => {
    const sessionStore = useSessionStore();
    useChatRealtimeHandlers({ ...base, streamFrames, sessionStore });
    return sessionStore;
  }, { initialProps: { streamFrames: frames } });
}

const final = (id: string, content: string, run = id) => ({
  kind: 'text', role: 'assistant', id, content, responseToMessageId: run, provider: 'codex',
  timestamp: '2026-09-05T00:00:00.000Z',
});

describe('batched stream snapshots through the real consumer and session store', () => {
  it('retains two canonical finals for the same session in one render', () => {
    const frames = batch([final('one', 'الأول'), final('two', 'الثاني')]);
    const view = mount(frames);
    expect(view.result.current.getMessages(sessionId).map(row => row.content)).toEqual(['الأول', 'الثاني']);
    view.rerender({ streamFrames: new Map(frames) });
    expect(view.result.current.getSlot(sessionId).realtimeMessages).toHaveLength(2);
  });

  it('retains two delta/end runs and does not deduplicate identical replies from distinct runs', () => {
    const frames = batch([
      { kind: 'stream_delta', content: 'تم', responseToMessageId: 'one', sequence: 1 },
      { kind: 'stream_end', sequence: 2 },
      { kind: 'stream_delta', content: 'تم', responseToMessageId: 'two', sequence: 3 },
      { kind: 'stream_end', sequence: 4 },
    ]);
    const view = mount(frames);
    expect(view.result.current.getMessages(sessionId).map(row => row.responseToMessageId)).toEqual(['one', 'two']);
    expect(view.result.current.getLastSeq(sessionId)).toBe(4);
  });

  it('ignores a repeated server sequence before accumulating a delta', () => {
    const frames = batch([
      { kind: 'stream_delta', content: 'نص', sequence: 4 },
      { kind: 'stream_delta', content: 'نص', sequence: 4 },
      { kind: 'stream_end', sequence: 5 },
    ]);
    const view = mount(frames);
    expect(view.result.current.getMessages(sessionId).map(row => row.content)).toEqual(['نص']);
  });

  it('re-mounting the consumer against the same store does not duplicate completed rows', () => {
    const store = renderHook(() => useSessionStore());
    const frames = batch([final('one', 'الأول'), final('two', 'الثاني')]);
    const first = renderHook(() => useChatRealtimeHandlers({ ...base, streamFrames: frames, sessionStore: store.result.current }));
    first.unmount();
    renderHook(() => useChatRealtimeHandlers({ ...base, streamFrames: frames, sessionStore: store.result.current }));
    expect(store.result.current.getSlot(sessionId).realtimeMessages).toHaveLength(2);
  });

  it('keeps canonical/end replay idempotent even when merged rendering hides an echo', () => {
    const store = renderHook(() => useSessionStore());
    const frames = batch([
      { kind: 'stream_delta', content: 'الجواب', clientMsgId: 'run' },
      { kind: 'stream_end' }, final('canonical', 'الجواب', 'run'),
    ]);
    const first = renderHook(() => useChatRealtimeHandlers({ ...base, streamFrames: frames, sessionStore: store.result.current }));
    const before = store.result.current.getSlot(sessionId).realtimeMessages.length;
    first.unmount();
    renderHook(() => useChatRealtimeHandlers({ ...base, streamFrames: frames, sessionStore: store.result.current }));
    expect(store.result.current.getSlot(sessionId).realtimeMessages).toHaveLength(before);
    expect(store.result.current.getMessages(sessionId)).toHaveLength(1);
  });

  it('replaces an already rendered partial stream when its canonical final arrives without an end marker', () => {
    const partial = batch([{ kind: 'stream_delta', content: 'الجزء', clientMsgId: 'run' }]);
    const view = mount(partial);
    const complete = applyStreamFrame(partial, { sessionId, ...final('canonical', 'الجزء والنهاية', 'run') }, 2);
    view.rerender({ streamFrames: complete });
    expect(view.result.current.getMessages(sessionId).map(row => row.content)).toEqual(['الجزء والنهاية']);
  });

  it('accepts legacy frames with no run identity and preserves their final content', () => {
    const view = mount(batch([
      { kind: 'stream_delta', content: 'قديم' }, { kind: 'stream_end' },
      { kind: 'text', role: 'assistant', id: 'legacy-final', content: 'نهائي' },
    ]));
    expect(view.result.current.getMessages(sessionId).map(row => row.content)).toEqual(['قديم', 'نهائي']);
  });

  it('bounds completed snapshots globally and starts one reconciliation for a missed window', () => {
    authenticatedFetch.mockClear();
    const frames = batch(Array.from({ length: MAX_STREAM_FRAMES + 5 }, (_, i) => final(`reply-${i}`, `نص ${i}`)));
    expect([...frames.values()].reduce((sum, entry) => sum + (entry.completed?.length ?? 0), 0)).toBe(MAX_STREAM_FRAMES);
    expect(frames.get(sessionId)?.droppedBeforeSeq).toBeGreaterThan(0);
    const view = mount(frames);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(view.result.current.getMessages(sessionId).some(row => row.kind === 'error')).toBe(true);
    view.rerender({ streamFrames: new Map(frames) });
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });
});


describe('session head eviction recovery', () => {
  function overflow(): StreamFrameMap {
    let frames = applyStreamFrame(new Map(), { sessionId, kind: 'stream_delta', content: 'prefix' }, 1);
    for (let i = 0; i < MAX_STREAM_FRAMES; i++) {
      frames = applyStreamFrame(frames, { sessionId: `other-${i}`, ...final(`reply-${i}`, 'body') }, i + 2);
    }
    return frames;
  }

  it('reports a missed head for the viewed session and attempts recovery only once per render window', () => {
    authenticatedFetch.mockClear();
    const frames = overflow();
    expect(frames.size).toBe(MAX_STREAM_FRAMES);
    expect(frames.has(sessionId)).toBe(false);
    const view = mount(frames);
    expect(view.result.current.getMessages(sessionId).some(row => row.kind === 'error')).toBe(true);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    view.rerender({ streamFrames: frames });
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it('marks a returning evicted session before rendering a suffix as if it were complete', () => {
    authenticatedFetch.mockClear();
    const frames = applyStreamFrame(overflow(), { sessionId, kind: 'stream_delta', content: 'suffix' }, 66);
    expect(frames.get(sessionId)?.droppedBeforeSeq).toBeGreaterThan(0);
    const view = mount(frames);
    expect(view.result.current.getMessages(sessionId).some(row => row.kind === 'error')).toBe(true);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });
});


describe('bounded eviction metadata', () => {
  function many(count: number): StreamFrameMap {
    let frames: StreamFrameMap = new Map();
    for (let i = 0; i < count; i++) frames = applyStreamFrame(frames, {
      sessionId: i === 0 ? sessionId : `s-${i}`, kind: 'stream_delta', content: 'A',
      responseToMessageId: 'run', sequence: i + 1,
    }, i + 1);
    return frames;
  }

  it('retains no text in at most 64 tombstones and drops the oldest exact membership', () => {
    const frames = many(140);
    expect(frames.size).toBe(64);
    expect(frames.evictedHeads?.size).toBe(64);
    expect(frames.evictedHeads?.has(sessionId)).toBe(false);
    expect([...frames.evictedHeads!.values()].every(item => Object.keys(item).every(key => ['seq', 'lastServerSequence'].includes(key)))).toBe(true);
  });

  it('does not warn for never-seen viewed sessions or a new first head', () => {
    authenticatedFetch.mockClear();
    const frames = many(140);
    const view = mount(applyStreamFrame(frames, { sessionId, ...final('new', 'new') }, 141));
    expect(view.result.current.getMessages(sessionId).some(row => row.kind === 'error')).toBe(false);
    expect(authenticatedFetch).not.toHaveBeenCalled();
    mount(new Map(frames));
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('rejects late frames without erasing the eviction evidence', () => {
    const frames = many(65);
    expect(applyStreamFrame(frames, { sessionId, kind: 'stream_delta', content: 'duplicate', sequence: 1 }, 66)).toBe(frames);
  });

  it('preserves consumed prefix on returning suffix and recovers once across a remount', () => {
    authenticatedFetch.mockClear();
    const store = renderHook(() => useSessionStore());
    const firstFrames = many(1);
    const view = renderHook(({ streamFrames }) => useChatRealtimeHandlers({ ...base, streamFrames, sessionStore: store.result.current }),
      { initialProps: { streamFrames: firstFrames } });
    view.rerender({ streamFrames: many(65) });
    expect(authenticatedFetch).not.toHaveBeenCalled();
    const remounted = renderHook(() => useChatRealtimeHandlers({ ...base, streamFrames: many(65), sessionStore: store.result.current }));
    expect(authenticatedFetch).not.toHaveBeenCalled();
    remounted.unmount();
    const replacementStore = mount(many(65));
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    replacementStore.unmount();
    authenticatedFetch.mockClear();
    const returned = applyStreamFrame(many(65), { sessionId, kind: 'stream_delta', content: 'B', responseToMessageId: 'run', sequence: 66 }, 66);
    view.rerender({ streamFrames: returned });
    expect(store.result.current.getMessages(sessionId).filter(row => row.kind !== 'error').map(row => row.content)).toEqual(['A']);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    view.unmount();
    renderHook(() => useChatRealtimeHandlers({ ...base, streamFrames: returned, sessionStore: store.result.current }));
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    const full = applyStreamFrame(returned, { sessionId, ...final('canonical', 'AB', 'run'), sequence: 67 }, 67);
    renderHook(() => useChatRealtimeHandlers({ ...base, streamFrames: full, sessionStore: store.result.current }));
    expect(store.result.current.getMessages(sessionId).filter(row => row.kind !== 'error').map(row => row.content)).toEqual(['AB']);
  });
});


it('recovers an incomplete off-view head when selected without requiring a new frame', () => {
  authenticatedFetch.mockClear();
  let frames: StreamFrameMap = applyStreamFrame(new Map(), { sessionId, kind: 'stream_delta', content: 'A' }, 1);
  for (let i = 0; i < 64; i++) frames = applyStreamFrame(frames, { sessionId: `s-${i}`, ...final(`id-${i}`, 'text') }, i + 2);
  frames = applyStreamFrame(frames, { sessionId, kind: 'stream_delta', content: 'B' }, 66);
  const store = renderHook(() => useSessionStore());
  const view = renderHook(({ viewed }) => useChatRealtimeHandlers({ ...base, selectedSession: { id: viewed } as any,
    currentSessionId: viewed, streamFrames: frames, sessionStore: store.result.current }), { initialProps: { viewed: 'unseen' } });
  expect(authenticatedFetch).not.toHaveBeenCalled();
  view.rerender({ viewed: sessionId });
  expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  expect(store.result.current.getMessages(sessionId).some(row => row.kind === 'error')).toBe(true);
});


it.each([false, true])('does not let a newer canonical acknowledge an old gap (evicted again: %s)', (evictAgain) => {
  authenticatedFetch.mockClear();
  let frames: StreamFrameMap = applyStreamFrame(new Map(), { sessionId, ...final('old', 'old') }, 1);
  for (let i = 0; i < 64; i++) frames = applyStreamFrame(frames, { sessionId: `s-${i}`, ...final(`id-${i}`, 'text') }, i + 2);
  frames = applyStreamFrame(frames, { sessionId, ...final('new', 'new') }, 66);
  const store = renderHook(() => useSessionStore());
  const view = renderHook(({ viewed }) => useChatRealtimeHandlers({ ...base, selectedSession: { id: viewed } as any,
    currentSessionId: viewed, streamFrames: frames, sessionStore: store.result.current }), { initialProps: { viewed: 'unseen' } });
  expect(authenticatedFetch).not.toHaveBeenCalled();
  if (evictAgain) {
    for (let i = 0; i < 64; i++) frames = applyStreamFrame(frames, { sessionId: `later-${i}`, ...final(`later-id-${i}`, 'text') }, i + 67);
    expect(frames.has(sessionId)).toBe(false);
  }
  view.rerender({ viewed: sessionId });
  expect(authenticatedFetch).toHaveBeenCalledTimes(1);
});


describe('C3 stream gaps obey history admission without blocking control recovery', () => {
  function gapFrames(mode: 'evicted' | 'incomplete'): StreamFrameMap {
    if (mode === 'evicted') return Object.assign(new Map(), { evictedHeads: new Map([[sessionId, { seq: 9 }]]) });
    return new Map([[sessionId, { seq: 10, text: 'suffix', ended: false, incomplete: true,
      droppedBeforeSeq: 9, frame: { kind: 'stream_delta', sessionId } }]]);
  }
  for (const mode of ['evicted', 'incomplete'] as const) {
    it.each([[413, 'HISTORY_BUDGET_EXCEEDED'], [409, 'HISTORY_SOURCE_INCOMPLETE'], [503, 'HISTORY_BUSY']])(
      `${mode}: %i %s retains the gap/input and still probes control status`, async (status, code) => {
        authenticatedFetch.mockClear(); clearOutbox(); setOutboxUser('c3-gap-test');
        recordOutboxEntry({ id: 'cmid_pending', sessionId, projectId: 'p1', text: 'unsent text' });
        const heldOutbox = getOutboxSnapshot();
        const store = renderHook(() => useSessionStore());
        act(() => {
          store.result.current.setHistoryError(sessionId, { ok: false, status: Number(status), code: String(code), retryAfterMs: status === 503 ? 5000 : null }, 'initial');
          store.result.current.appendRealtime(sessionId, { id: 'cmid_pending', sessionId, kind: 'text', role: 'user',
            provider: 'claude', content: 'unsent text', timestamp: '2026-09-07T00:00:00Z' });
        });
        const frames = gapFrames(mode);
        const view = renderHook(({ dropped }: { dropped: number }) => useChatRealtimeHandlers({ ...base,
          streamFrames: frames, controlEvents: { events: [], droppedBeforeSeq: dropped }, sessionStore: store.result.current }),
        { initialProps: { dropped: 0 } });
        try {
          expect(authenticatedFetch).not.toHaveBeenCalled();
          expect(store.result.current.getMessages(sessionId).map(row => row.id)).toContain(`stream_gap_${sessionId}`);
          await act(async () => { view.rerender({ dropped: 20 }); });
          expect(authenticatedFetch.mock.calls.some(([url]) => String(url).includes('/activity'))).toBe(true);
          expect(authenticatedFetch.mock.calls.some(([url]) => String(url).includes('/messages'))).toBe(false);
          expect(store.result.current.getMessages(sessionId).map(row => row.content)).toContain('unsent text');
          expect(store.result.current.getSlot(sessionId).historyError?.code).toBe(code);
          expect(getOutboxSnapshot()).toBe(heldOutbox);
        } finally { view.unmount(); store.unmount(); clearOutbox(); }
      });
    it(`${mode}: an expired Retry-After permits one bounded tail recovery`, async () => {
      authenticatedFetch.mockClear();
      const store = renderHook(() => useSessionStore());
      act(() => store.result.current.setHistoryError(sessionId, { ok: false, status: 503, code: 'HISTORY_BUSY', retryAfterMs: 0 }, 'initial'));
      const view = renderHook(() => useChatRealtimeHandlers({ ...base, streamFrames: gapFrames(mode), sessionStore: store.result.current }));
      await act(async () => {});
      expect(authenticatedFetch.mock.calls.filter(([url]) => String(url).includes('/messages'))).toHaveLength(1);
      view.unmount(); store.unmount();
    });
  }
});


describe('durable reconnect recovery consumption', () => {
  it('recovers once despite presence replacing the reconnect frame and callback identity changes', () => {
    const recover = vi.fn();
    const replacement = vi.fn();
    const view = renderHook(({ reconnectEpoch, latestMessage, onWebSocketReconnect }) => {
      const sessionStore = useSessionStore();
      useChatRealtimeHandlers({ ...base, sessionStore, reconnectEpoch, latestMessage, onWebSocketReconnect });
    }, { initialProps: { reconnectEpoch: 0, latestMessage: null as any, onWebSocketReconnect: recover } });
    expect(recover).not.toHaveBeenCalled();
    view.rerender({ reconnectEpoch: 1, latestMessage: { type: 'presence', runningSessions: [] }, onWebSocketReconnect: recover });
    expect(recover).toHaveBeenCalledTimes(1);
    view.rerender({ reconnectEpoch: 1, latestMessage: { type: 'websocket-reconnected' }, onWebSocketReconnect: replacement });
    expect(replacement).not.toHaveBeenCalled();
    view.rerender({ reconnectEpoch: 2, latestMessage: { type: 'presence' }, onWebSocketReconnect: replacement });
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  it('does not replay reconnects predating a newly mounted conversation', () => {
    const recover = vi.fn();
    renderHook(() => {
      const sessionStore = useSessionStore();
      useChatRealtimeHandlers({ ...base, sessionStore, reconnectEpoch: 4, onWebSocketReconnect: recover });
    });
    expect(recover).not.toHaveBeenCalled();
  });
});

describe('C-XM-GAP fetch guard decoupled from the gap error row (qa-critic veto)', () => {
  function overflowedFinals(count: number, offset = 0): any[] {
    return Array.from({ length: count }, (_, i) => final(`reply-${offset + i}`, `نص ${offset + i}`));
  }

  it('two consecutive gaps in the same session fetch twice but keep one error row', () => {
    authenticatedFetch.mockClear();
    let frames = batch(overflowedFinals(MAX_STREAM_FRAMES + 5));
    const view = mount(frames);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    const gap1 = frames.get(sessionId)?.droppedBeforeSeq;
    expect(gap1).toBeGreaterThan(0);

    // Keep advancing the same reducer chain so the session overflows its
    // completed-snapshot budget a second time, raising droppedBeforeSeq past
    // the seq already consumed by the first render (not just past gap1).
    let seq = MAX_STREAM_FRAMES + 5;
    for (let i = 0; i < 100; i++) {
      seq += 1;
      frames = applyStreamFrame(frames, { sessionId, ...final(`later-${i}`, `later ${i}`) }, seq);
    }
    const gap2 = frames.get(sessionId)?.droppedBeforeSeq;
    expect(gap2).toBeGreaterThan(gap1!);

    view.rerender({ streamFrames: frames });
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(view.result.current.getMessages(sessionId).filter(row => row.id === `stream_gap_${sessionId}`)).toHaveLength(1);
  });

  it('removing the gap error row and re-rendering the same streamFrames triggers zero additional fetches', () => {
    authenticatedFetch.mockClear();
    const frames = batch(overflowedFinals(MAX_STREAM_FRAMES + 5));
    const view = mount(frames);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);

    // Simulate the row disappearing (e.g. a UI/store bug) without the
    // underlying gap value changing.
    const slot = view.result.current.getSessionSlot!(sessionId)!;
    slot.realtimeMessages = slot.realtimeMessages.filter(row => row.id !== `stream_gap_${sessionId}`);

    view.rerender({ streamFrames: new Map(frames) });
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it('does not fetch or show an error row for a session that is not the one being viewed', () => {
    authenticatedFetch.mockClear();
    const bystander = 'bystander-session';
    let frames: StreamFrameMap = new Map();
    for (let i = 0; i < MAX_STREAM_FRAMES + 5; i++) {
      frames = applyStreamFrame(frames, { sessionId: bystander, ...final(`b-${i}`, `نص ${i}`) }, i + 1);
    }
    expect(frames.get(bystander)?.droppedBeforeSeq).toBeGreaterThan(0);

    // `base.selectedSession.id` / `base.currentSessionId` are `sessionId`,
    // not `bystander` — the bystander session is never the viewed one.
    const view = mount(frames);
    expect(authenticatedFetch).not.toHaveBeenCalled();
    expect(view.result.current.getMessages(bystander).some(row => row.kind === 'error')).toBe(false);
  });

  it('bounds automatic fetches per flush to the viewed session even when several sessions carry a gap', () => {
    authenticatedFetch.mockClear();
    let frames: StreamFrameMap = new Map();
    let seq = 0;
    for (const sid of [sessionId, 'other-b1', 'other-b2', 'other-b3']) {
      for (let i = 0; i < 30; i++) {
        seq += 1;
        frames = applyStreamFrame(frames, { sessionId: sid, ...final(`${sid}-${i}`, `n${i}`) }, seq);
      }
    }
    // At least one bystander also carries a gap in the same flush — the bound
    // must hold regardless of how many sessions are affected.
    const gapSessions = [...frames.entries()].filter(([, entry]) => Boolean(entry.droppedBeforeSeq));
    expect(gapSessions.length).toBeGreaterThan(1);
    expect(gapSessions.some(([sid]) => sid === sessionId)).toBe(true);

    mount(frames);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });
});
