/**
 * ADR-173 rev.3 P6 (client half) — how the realtime handler reacts to the
 * shared-writing frames: a busy refusal names who holds the session and keeps
 * the colleague's prompts on screen; a refused stop leaves the live turn alone;
 * a provider refusal returns the text and offers a fork; a colleague's prompt
 * appears live with its author, the viewer's own echo never twice.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../contexts/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ refreshProjects: () => Promise.resolve() }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./sessionActivity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessionActivity')>();
  return { ...actual, runSessionActivityProbe: async () => 'idle' as const };
});

import type { ControlEventLog } from '../../../contexts/WebSocketContext';
import type { SharedWritingNotice } from '../utils/sharedWriting';
import { clearOutbox, recordOutboxEntry, setOutboxUser } from '../utils/messageOutbox';

import { resetSessionActivityEpochs } from './sessionActivity';
import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';

const SESSION = 'sess-shared';
const EMPTY_LOG: ControlEventLog = { events: [], droppedBeforeSeq: 0 };

function log(...frames: unknown[]): ControlEventLog {
  return { events: frames.map((frame, index) => ({ seq: index + 1, frame: frame as any })), droppedBeforeSeq: 0 };
}

function harness(options: {
  currentUserId?: number;
  ownIds?: string[];
  withdrawnText?: string | null;
  /** P8 B2: sends this tab holds an optimistic bubble for. */
  ownSends?: string[];
  /** P8 B4: rows on screen (the newest user row names the turn's starter). */
  messages?: any[];
} = {}) {
  const calls = {
    isLoading: [] as boolean[],
    permissions: [] as unknown[],
    appended: [] as any[],
    serverErrors: [] as string[],
    restored: [] as string[],
    withdrawn: [] as string[],
    finalized: 0,
    notices: [] as (SharedWritingNotice | null)[],
  };
  let notice: SharedWritingNotice | null = null;
  const sessionStore = {
    recordSeq: () => {},
    appendRealtime: (_sid: string, msg: any) => calls.appended.push(msg),
    updateStreaming: () => {},
    finalizeStreaming: () => { calls.finalized += 1; },
    replaceSessionId: () => {},
    hasMessageId: (_sid: string, id: string) => (options.ownIds ?? []).includes(id),
    hasOptimisticUserRow: (_sid: string, id: string) => (options.ownSends ?? ['cmid_1', 'cmid_2']).includes(id),
    getMessages: () => options.messages ?? [],
    withdrawOptimisticUserRow: (_sid: string, clientMsgId: string) => {
      calls.withdrawn.push(clientMsgId);
      return options.withdrawnText ?? null;
    },
  } as any;
  const props = {
    latestMessage: null as any,
    controlFrames: new Map(),
    controlEvents: EMPTY_LOG,
    provider: 'claude' as const,
    selectedSession: { id: SESSION } as any,
    currentSessionId: SESSION,
    currentUserId: options.currentUserId ?? 2,
    setCurrentSessionId: () => {},
    setIsLoading: (v: boolean) => calls.isLoading.push(v),
    setCanAbortSession: () => {},
    setClaudeStatus: () => {},
    setTokenBudget: () => {},
    setPendingPermissionRequests: (v: unknown) => calls.permissions.push(v),
    pendingViewSessionRef: { current: null } as any,
    streamTimerRef: { current: null } as any,
    accumulatedStreamRef: { current: new Map([[SESSION, { text: 'live colleague reply' }]]) } as any,
    onServerError: (m: string) => calls.serverErrors.push(m),
    onRejectedSendRestore: (text: string) => calls.restored.push(text),
    onSharedWritingNotice: (next: any) => {
      notice = typeof next === 'function' ? next(notice) : next;
      calls.notices.push(notice);
    },
    sessionStore,
  };
  const { rerender } = renderHook(
    (delivered: Record<string, unknown>) => useChatRealtimeHandlers({ ...props, ...delivered } as any),
    { initialProps: {} as Record<string, unknown> },
  );
  return { calls, rerender, notice: () => notice };
}

beforeEach(() => {
  resetSessionActivityEpochs();
  clearOutbox();
  setOutboxUser('shared-writing-test');
});

describe('session_busy with occupancy', () => {
  it('raises a busy notice naming the holder, returns the text, keeps the approvals on screen', () => {
    const h = harness({ withdrawnText: 'my message' });
    h.rerender({ controlEvents: log({
      kind: 'error', sessionId: SESSION, code: 'session_busy', clientMsgId: 'cmid_1',
      busyBy: 1, phase: 'post_result', stuck: false, canStop: false,
    }) });
    expect(h.notice()).toEqual({
      kind: 'busy', sessionId: SESSION, busyBy: 1, phase: 'post_result', stuck: false, canStop: false,
    });
    expect(h.calls.restored).toEqual(['my message']);
    // the colleague's turn is still live: its approval prompts must stay
    expect(h.calls.permissions).toEqual([]);
    // the notice replaces the generic error banner
    expect(h.calls.serverErrors).toEqual([]);
  });
});

describe('turn_stop_forbidden', () => {
  it('leaves the live turn alone and explains the refusal', () => {
    const h = harness();
    h.rerender({ controlEvents: log({
      kind: 'complete', code: 'turn_stop_forbidden', aborted: true, success: false, abortFailed: true,
      notStarted: true, sessionId: SESSION, provider: 'claude', busyBy: 1, stuck: false, canStop: false,
    }) });
    expect(h.notice()).toEqual({ kind: 'stop_forbidden', sessionId: SESSION, busyBy: 1, stuck: false });
    expect(h.calls.isLoading).toEqual([]);
    expect(h.calls.permissions).toEqual([]);
    expect(h.calls.finalized).toBe(0);
    expect(h.calls.serverErrors).toEqual([]);
  });
});

describe('shared_writing_unsupported', () => {
  it('returns the unsent text and raises the fork banner without touching the live stream', () => {
    const h = harness({ withdrawnText: 'continue please' });
    h.rerender({ controlEvents: log({
      kind: 'complete', code: 'shared_writing_unsupported', success: false, exitCode: 1, notStarted: true,
      provider: 'codex', creatorName: 'ibrahim', canFork: true, sessionId: SESSION, clientMsgId: 'cmid_2',
    }) });
    expect(h.calls.withdrawn).toEqual(['cmid_2']);
    expect(h.calls.restored).toEqual(['continue please']);
    expect(h.notice()).toEqual({
      kind: 'unsupported', sessionId: SESSION, provider: 'codex', creatorName: 'ibrahim', canFork: true,
    });
    expect(h.calls.finalized).toBe(0);
  });
});

describe('a completed run clears the busy notice but not the fork banner', () => {
  it('clears busy on the session complete', () => {
    const h = harness();
    h.rerender({ controlEvents: log(
      { kind: 'error', sessionId: SESSION, code: 'session_busy', busyBy: 1, phase: 'running' },
      { kind: 'complete', sessionId: SESSION, success: true, exitCode: 0 },
    ) });
    expect(h.notice()).toBeNull();
  });
});

describe('user_turn', () => {
  const frame = {
    kind: 'user_turn', provider: 'claude', sessionId: SESSION, role: 'user', content: 'from sara',
    authorUserId: 3, authorName: 'sara', clientMsgId: 'cmid_sara', id: 'srv-u1',
    timestamp: '2026-11-15T00:00:00.000Z',
  };

  it('adds a colleague prompt as an authored user row', () => {
    const h = harness({ currentUserId: 1 });
    h.rerender({ latestMessage: frame });
    expect(h.calls.appended).toHaveLength(1);
    expect(h.calls.appended[0]).toMatchObject({
      kind: 'text', role: 'user', userId: 3, authorName: 'sara', id: 'srv-u1', content: 'from sara',
      sharedTurn: true, sharedClientMsgId: 'cmid_sara',
    });
  });

  it('shows the creator own prompt to another viewer, and drops it on the creator socket (P8 B3)', () => {
    const creatorTurn = { ...frame, authorUserId: 1, authorName: 'ibrahim', clientMsgId: 'cmid_creator', id: 'srv-c1' };
    const member = harness({ currentUserId: 3 });
    member.rerender({ latestMessage: creatorTurn });
    expect(member.calls.appended[0]).toMatchObject({ userId: 1, authorName: 'ibrahim', sharedTurn: true });
    const creator = harness({ currentUserId: 1 });
    creator.rerender({ latestMessage: creatorTurn });
    expect(creator.calls.appended).toEqual([]);
  });

  it('drops the echo of the viewer own prompt', () => {
    const own = harness({ currentUserId: 3 });
    own.rerender({ latestMessage: frame });
    expect(own.calls.appended).toEqual([]);
    const ownTab = harness({ currentUserId: 1, ownIds: ['cmid_sara'] });
    ownTab.rerender({ latestMessage: frame });
    expect(ownTab.calls.appended).toEqual([]);
  });
});

describe('busy on the viewer own turn', () => {
  it('keeps the generic banner (no shared notice) when the holder is the viewer', () => {
    const h = harness({ currentUserId: 1 });
    h.rerender({ controlEvents: log({ kind: 'error', sessionId: SESSION, code: 'session_busy', busyBy: 1, phase: 'running' }) });
    expect(h.notice()).toBeNull();
    expect(h.calls.serverErrors).toHaveLength(1);
  });
});

describe('permission_request from a shared turn', () => {
  it('keeps the external-identity flag and the starter id on the pending request', () => {
    const h = harness();
    h.rerender({ controlEvents: log({
      kind: 'permission_request', sessionId: SESSION, requestId: 'r9', toolName: 'mcp__gh__x',
      externalIdentity: true, starterUserId: 1,
    }) });
    const update = h.calls.permissions.at(-1) as (prev: unknown[]) => unknown[];
    expect(update([])).toMatchObject([{ requestId: 'r9', externalIdentity: true, starterUserId: 1 }]);
  });
});

describe('a send refusal reaches only its sender (P8 B2)', () => {
  it('ignores a busy refusal for a send this tab does not hold — no banner, no code, live turn untouched', () => {
    const h = harness({ currentUserId: 1, ownSends: [] });
    h.rerender({ controlEvents: log({
      kind: 'error', sessionId: SESSION, code: 'session_busy', clientMsgId: 'cmid_member',
      busyBy: 1, phase: 'running', stuck: false, canStop: false, notStarted: true,
    }) });
    expect(h.calls.serverErrors).toEqual([]);
    expect(h.calls.isLoading).toEqual([]);
    expect(h.calls.withdrawn).toEqual([]);
    expect(h.notice()).toBeNull();
  });

  it('ignores a pre-start refusal for another member send', () => {
    const h = harness({ currentUserId: 1, ownSends: [] });
    h.rerender({ controlEvents: log({
      kind: 'complete', exitCode: 1, success: false, notStarted: true, code: 'shared_writing_forbidden',
      sessionId: SESSION, provider: 'claude', clientMsgId: 'cmid_member',
    }) });
    expect(h.calls.isLoading).toEqual([]);
    expect(h.calls.permissions).toEqual([]);
    expect(h.calls.finalized).toBe(0);
    expect(h.calls.serverErrors).toEqual([]);
  });

  it('still handles the viewer own refusal', () => {
    const h = harness({ currentUserId: 1, ownSends: ['cmid_mine'], withdrawnText: 'mine' });
    h.rerender({ controlEvents: log({
      kind: 'error', sessionId: SESSION, code: 'session_busy', clientMsgId: 'cmid_mine',
      busyBy: 3, phase: 'running', stuck: false, canStop: false,
    }) });
    expect(h.calls.restored).toEqual(['mine']);
    expect(h.notice()).toMatchObject({ kind: 'busy', busyBy: 3 });
  });
});

describe('who stopped the reply (P8 B4)', () => {
  const stopped = (stoppedBy: unknown) => ({
    kind: 'complete', exitCode: 0, aborted: true, success: true, sessionId: SESSION, provider: 'claude', stoppedBy,
  });
  const starterRow = { kind: 'text', role: 'user', userId: 1, id: 'u1', content: 'x' };

  it('tells the starter that another member stopped the reply', () => {
    const h = harness({ currentUserId: 1, messages: [starterRow] });
    h.rerender({ controlEvents: log(stopped({ userId: 3, name: 'sara' })) });
    expect(h.notice()).toEqual({ kind: 'stopped_by', sessionId: SESSION, stoppedBy: 3, stoppedByName: 'sara' });
  });

  it('tells another viewer too', () => {
    const h = harness({ currentUserId: 4, messages: [starterRow] });
    h.rerender({ controlEvents: log(stopped({ userId: 3, name: 'sara' })) });
    expect(h.notice()).toMatchObject({ kind: 'stopped_by', stoppedBy: 3 });
  });

  it('says nothing when the starter stopped it, or to the member who stopped it', () => {
    const own = harness({ currentUserId: 4, messages: [starterRow] });
    own.rerender({ controlEvents: log(stopped({ userId: 1, name: 'ibrahim' })) });
    expect(own.notice()).toBeNull();
    const stopper = harness({ currentUserId: 3, messages: [starterRow] });
    stopper.rerender({ controlEvents: log(stopped({ userId: 3, name: 'sara' })) });
    expect(stopper.notice()).toBeNull();
  });
});

describe('an own send refused before it ran (P8 cosmetic)', () => {
  it('leaves only its outbox card: the bubble that would look sent is withdrawn', () => {
    recordOutboxEntry({ id: 'cmid_card', projectId: 'p1', sessionId: SESSION, text: 'kept on the card' });
    const h = harness({ currentUserId: 3, ownSends: ['cmid_card'] });
    h.rerender({ controlEvents: log({
      kind: 'complete', exitCode: 1, success: false, notStarted: true, code: 'shared_writing_forbidden',
      sessionId: SESSION, provider: 'claude', clientMsgId: 'cmid_card',
    }) });
    expect(h.calls.withdrawn).toEqual(['cmid_card']);
    expect(h.calls.restored).toEqual([]);
  });
});
