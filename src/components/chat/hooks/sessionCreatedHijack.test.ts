/**
 * B-1666 #1 — a `session_created` for a brand-new conversation must never
 * hijack the existing session the user switched to while it was starting.
 *
 * Send-then-switch: the user sends from the new-chat screen (pending view ref
 * carries the send's clientMsgId), then opens existing session B before the
 * provider announces the new id. Each provider's real payload shape is
 * delivered through the real realtime handler wired to the real session store:
 * B keeps its rows, gets no alias onto the new id, and the view stays on B.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../contexts/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ refreshProjects: () => Promise.resolve() }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { CONTROL_EVENT_KINDS, type ControlEventLog } from '../../../contexts/WebSocketContext';
import { useSessionStore, type NormalizedMessage } from '../../../stores/useSessionStore';

import { resetSessionActivityEpochs } from './sessionActivity';
import { useChatRealtimeHandlers, type StreamBuffer } from './useChatRealtimeHandlers';

const VIEWED = 'sess-B';
const NEW_ID = 'sess-new';
const CMID = 'cmid-send-then-switch';
const EMPTY_LOG: ControlEventLog = { events: [], droppedBeforeSeq: 0 };

type PendingRef = {
  current: { sessionId: string | null; clientMsgId?: string | null; originSessionId?: string | null } | null;
};

function rowOfB(): NormalizedMessage {
  return {
    id: 'b-row-1',
    sessionId: VIEWED,
    timestamp: '2026-10-17T10:00:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: 'رسالة في B',
  } as NormalizedMessage;
}

function harness(currentSessionId: string | null, pendingViewSessionRef: PendingRef) {
  const navigated: string[] = [];
  const setCurrent: (string | null)[] = [];
  const props = {
    controlFrames: new Map() as any,
    provider: 'claude' as const,
    selectedSession: currentSessionId ? ({ id: currentSessionId } as any) : null,
    currentSessionId,
    setCurrentSessionId: (id: string | null) => setCurrent.push(id),
    setIsLoading: () => {},
    setCanAbortSession: () => {},
    setClaudeStatus: () => {},
    setTokenBudget: () => {},
    setPendingPermissionRequests: () => {},
    pendingViewSessionRef: pendingViewSessionRef as any,
    streamTimerRef: { current: null } as any,
    accumulatedStreamRef: { current: new Map<string, StreamBuffer>() } as any,
    onNavigateToSession: (id: string) => navigated.push(id),
  };

  const { result, rerender } = renderHook(
    (delivered: any) => {
      const sessionStore = useSessionStore();
      useChatRealtimeHandlers({ ...props, ...delivered, sessionStore });
      return sessionStore;
    },
    { initialProps: { latestMessage: null, controlEvents: EMPTY_LOG } as any },
  );

  act(() => {
    result.current.setActiveSession(currentSessionId);
    result.current.appendRealtime(VIEWED, rowOfB());
  });

  let seq = 0;
  let events: { seq: number; frame: any }[] = [];
  const send = (frame: any) => {
    if (CONTROL_EVENT_KINDS.has(frame.kind)) {
      seq += 1;
      events = [...events, { seq, frame }];
    }
    act(() => rerender({ latestMessage: frame, controlEvents: { events, droppedBeforeSeq: 0 } }));
  };

  return { store: () => result.current, navigated, setCurrent, send };
}

beforeEach(() => {
  resetSessionActivityEpochs();
});

const created = { kind: 'session_created', newSessionId: NEW_ID, sessionId: NEW_ID };

const freshShapes: [string, Record<string, unknown>][] = [
  ['claude', { ...created, provider: 'claude', parentSessionId: null, clientMsgId: CMID }],
  ['codex', { ...created, provider: 'codex', parentSessionId: null, forked: false, clientMsgId: CMID }],
  ['opencode', { ...created, provider: 'opencode', parentSessionId: null, clientMsgId: CMID }],
  ['opencode (legacy, no parent)', { ...created, provider: 'opencode' }],
  ['antigravity first chunk', { ...created, parentSessionId: null, clientMsgId: CMID }],
  ['antigravity first chunk (legacy, no parent)', { ...created }],
];

describe('B-1666 — send from new chat, switch to B, session_created arrives', () => {
  it.each(freshShapes)('%s: B is not hijacked', (_name, frame) => {
    const pending: PendingRef = { current: { sessionId: null, clientMsgId: CMID } };
    const h = harness(VIEWED, pending);

    h.send(frame);

    const store = h.store();
    // No alias B→new: the new id owns no slot, B still holds its own row.
    expect(store.getSessionSlot(NEW_ID)).toBeUndefined();
    expect(store.getMessages(VIEWED).map((m) => m.id)).toEqual(['b-row-1']);
    expect(store.getMessages(VIEWED).every((m) => m.sessionId === VIEWED)).toBe(true);
    expect(h.navigated).toEqual([]);
    expect(h.setCurrent).toEqual([]);
  });
});

describe('B-1666 — real lineage still migrates (positive controls)', () => {
  it('agy handover (parentSessionId = viewed) migrates the view', () => {
    const h = harness(VIEWED, { current: null });

    h.send({ ...created, provider: 'antigravity', parentSessionId: VIEWED });

    expect(h.store().getMessages(NEW_ID).map((m) => m.id)).toEqual(['b-row-1']);
    expect(h.navigated).toEqual([NEW_ID]);
    expect(h.setCurrent).toEqual([NEW_ID]);
  });

  it('codex fork (forked, parent = viewed) branches onto the new id', () => {
    const h = harness(VIEWED, { current: null });

    h.send({ ...created, provider: 'codex', parentSessionId: VIEWED, forked: true, clientMsgId: CMID });

    expect(h.navigated).toEqual([NEW_ID]);
    expect(h.setCurrent).toEqual([NEW_ID]);
    expect(h.store().getMessages(VIEWED).map((m) => m.id)).toEqual(['b-row-1']);
  });

  it('new-chat screen with a matching clientMsgId still navigates', () => {
    const pending: PendingRef = { current: { sessionId: null, clientMsgId: CMID } };
    const h = harness(null, pending);

    h.send({ ...created, provider: 'opencode', parentSessionId: null, clientMsgId: CMID });

    expect(h.setCurrent).toEqual([NEW_ID]);
    expect(h.navigated).toEqual([NEW_ID]);
    expect(pending.current?.sessionId).toBe(NEW_ID);
  });
});

/**
 * Review round 2 — the view shows a dead (conversation_not_found) or fenced
 * session and the user starts a new conversation from it ("start new
 * session", outbox retry). The send's clientMsgId plus the session it left
 * from prove the event is this view's own: the view moves to the new session
 * with only the send's row, and the old session keeps its history unaliased.
 */
const RESTART_CMID = 'cmid_restart-from-dead';

function optimisticRow(): NormalizedMessage {
  return {
    id: RESTART_CMID,
    sessionId: VIEWED,
    timestamp: '2026-10-17T10:05:00.000Z',
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: 'أعد المحاولة في جلسة جديدة',
  } as NormalizedMessage;
}

const restartShapes: [string, Record<string, unknown>][] = [
  ['antigravity', { ...created, parentSessionId: null, clientMsgId: RESTART_CMID }],
  ['claude', { ...created, provider: 'claude', parentSessionId: null, clientMsgId: RESTART_CMID }],
  ['codex', { ...created, provider: 'codex', parentSessionId: null, forked: false, clientMsgId: RESTART_CMID }],
  ['opencode', { ...created, provider: 'opencode', parentSessionId: null, clientMsgId: RESTART_CMID }],
];

describe('B-1666 — new conversation started from the viewed dead session', () => {
  it.each(restartShapes)('%s: the view moves to the new session', (_name, frame) => {
    const pending: PendingRef = {
      current: { sessionId: null, clientMsgId: RESTART_CMID, originSessionId: VIEWED },
    };
    const h = harness(VIEWED, pending);
    act(() => h.store().appendRealtime(VIEWED, optimisticRow()));

    h.send(frame);

    const store = h.store();
    expect(h.setCurrent).toEqual([NEW_ID]);
    expect(h.navigated).toEqual([NEW_ID]);
    expect(pending.current?.sessionId).toBe(NEW_ID);
    expect(store.getMessages(NEW_ID).map((m) => m.id)).toEqual([RESTART_CMID]);
    expect(store.getMessages(NEW_ID)[0].sessionId).toBe(NEW_ID);
    // The dead session keeps its own history and is not aliased onto the new id.
    expect(store.getMessages(VIEWED).map((m) => m.id)).toEqual(['b-row-1']);
    expect(store.getMessages(VIEWED).every((m) => m.sessionId === VIEWED)).toBe(true);
  });

  it('a send that left from another session does not move this view', () => {
    const pending: PendingRef = {
      current: { sessionId: null, clientMsgId: RESTART_CMID, originSessionId: 'sess-A' },
    };
    const h = harness(VIEWED, pending);

    h.send({ ...created, parentSessionId: null, clientMsgId: RESTART_CMID });

    expect(h.setCurrent).toEqual([]);
    expect(h.navigated).toEqual([]);
    expect(h.store().getSessionSlot(NEW_ID)).toBeUndefined();
  });

  it('a different clientMsgId does not move this view', () => {
    const pending: PendingRef = {
      current: { sessionId: null, clientMsgId: RESTART_CMID, originSessionId: VIEWED },
    };
    const h = harness(VIEWED, pending);

    h.send({ ...created, parentSessionId: null, clientMsgId: 'cmid_someone-else' });

    expect(h.setCurrent).toEqual([]);
    expect(h.navigated).toEqual([]);
    expect(pending.current?.sessionId).toBeNull();
  });
});
