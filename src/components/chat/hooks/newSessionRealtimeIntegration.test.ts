/**
 * B-1386 (qa-critic round 2, requirement 5) - integration coverage for the
 * useChatRealtimeHandlers + useChatSessionState wiring ChatInterface.tsx does
 * in production, driven by a REAL session_created control event (not a
 * hand-set pendingViewSessionRef).
 *
 * RUNNER: vitest.
 */

import { useRef, useState } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch }));
vi.mock('../../../contexts/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ refreshProjects: () => Promise.resolve() }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import type { ControlEventLog } from '../../../contexts/WebSocketContext';
import { useSessionStore } from '../../../stores/useSessionStore';
import { publishServerCapabilities } from '../../../stores/serverCapabilitiesStore';

import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';
import { useChatSessionState } from './useChatSessionState';

const PROJECT = { projectId: 'proj-int', path: '/synthetic', fullPath: '/synthetic' } as any;
const noOp = () => {};

function log(...frames: any[]): ControlEventLog {
  return { events: frames.map((frame, index) => ({ seq: index + 1, frame })), droppedBeforeSeq: 0 };
}

let harnessProvider = 'claude';

function useIntegrationHarness(controlEvents: ControlEventLog) {
  const [selectedSession, setSelectedSession] = useState<{ id: string; __provider: string } | null>(null);
  const navigateCalls = useRef<{ id: string; replace?: boolean }[]>([]);
  const pendingViewSessionRef = useRef<{ sessionId: string | null; startedAt: number; projectId?: string | null } | null>(null);
  const sessionStore = useSessionStore();

  const chatState = useChatSessionState({
    selectedSession: selectedSession as any,
    selectedProject: PROJECT,
    ws: null,
    sendMessage: noOp,
    resetStreamingState: noOp,
    pendingViewSessionRef,
    sessionStore,
  });

  useChatRealtimeHandlers({
    latestMessage: null,
    controlFrames: new Map(),
    controlEvents,
    provider: harnessProvider,
    selectedSession: selectedSession as any,
    currentSessionId: chatState.currentSessionId,
    setCurrentSessionId: chatState.setCurrentSessionId,
    setIsLoading: chatState.setIsLoading,
    setCanAbortSession: chatState.setCanAbortSession,
    setClaudeStatus: chatState.setClaudeStatus,
    setTokenBudget: chatState.setTokenBudget,
    setPendingPermissionRequests: noOp,
    pendingViewSessionRef,
    streamTimerRef: useRef(null),
    accumulatedStreamRef: useRef(new Map()),
    onNavigateToSession: (id: string, options?: { replace?: boolean }) => {
      navigateCalls.current.push({ id, replace: options?.replace });
    },
    onServerError: noOp,
    sessionStore,
  } as any);

  return {
    chatState,
    selectedSession,
    setSelectedSession,
    advanceRouter: () => setSelectedSession({ id: pendingViewSessionRef.current?.sessionId as string, __provider: 'claude' }),
    navigateCalls,
    pendingViewSessionRef,
  };
}

function mount(initialEvents: ControlEventLog) {
  return renderHook(({ controlEvents }: { controlEvents: ControlEventLog }) => useIntegrationHarness(controlEvents),
    { initialProps: { controlEvents: initialEvents } });
}

beforeEach(() => {
  harnessProvider = 'claude';
  sessionStorage.clear();
  localStorage.clear();
  publishServerCapabilities({ capabilities: { lightHistory: { supported: false, enabled: false, schema: 1 } } });
  authenticatedFetch.mockReset().mockImplementation(async () => ({
    ok: true, json: async () => ({ messages: [], total: 0, hasMore: false, nextCursor: null }),
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('B-1386 - real session_created through both hooks together', () => {
  it('keeps currentSessionId and the optimistic message through the router-lag window', async () => {
    const { result, rerender } = mount(log());

    act(() => {
      result.current.chatState.addMessage({ type: 'user', content: 'first message', timestamp: new Date() } as any);
    });
    expect(result.current.chatState.chatMessages).toHaveLength(1);

    rerender({ controlEvents: log({ kind: 'session_created', newSessionId: 'sess-integration-1' }) });

    await waitFor(() => expect(result.current.chatState.currentSessionId).toBe('sess-integration-1'));
    expect(result.current.navigateCalls.current).toEqual([{ id: 'sess-integration-1', replace: true }]);
    expect(result.current.pendingViewSessionRef.current?.sessionId).toBe('sess-integration-1');

    rerender({ controlEvents: log({ kind: 'session_created', newSessionId: 'sess-integration-1' }) });
    expect(result.current.chatState.currentSessionId).toBe('sess-integration-1');
    expect(result.current.chatState.chatMessages).toHaveLength(1);

    act(() => { result.current.advanceRouter(); });
    rerender({ controlEvents: log({ kind: 'session_created', newSessionId: 'sess-integration-1' }) });

    await waitFor(() => expect(result.current.pendingViewSessionRef.current).toBe(null));
    expect(result.current.chatState.currentSessionId).toBe('sess-integration-1');
    expect(result.current.chatState.chatMessages.length).toBeGreaterThanOrEqual(1);
  });
});

describe('B-472 - session_created applies the Codex permission stamp only for its own send', () => {
  const stamp = (mode: string, clientMsgId: string) =>
    sessionStorage.setItem('__nassaj_pending_codex_permission_stamp', JSON.stringify({ mode, clientMsgId, at: Date.now() }));

  const pend = (result: { current: { pendingViewSessionRef: { current: unknown } } }, clientMsgId: string) => {
    result.current.pendingViewSessionRef.current = { sessionId: null, startedAt: Date.now(), clientMsgId };
  };

  it('writes permissionMode-<id> when clientMsgId matches', async () => {
    harnessProvider = 'codex';
    stamp('default', 'cmid-1');
    const { result, rerender } = mount(log());
    pend(result, 'cmid-1');
    rerender({ controlEvents: log({ kind: 'session_created', newSessionId: 'cx-1', clientMsgId: 'cmid-1' }) });
    await waitFor(() => expect(result.current.chatState.currentSessionId).toBe('cx-1'));
    expect(localStorage.getItem('permissionMode-cx-1')).toBe('default');
    expect(sessionStorage.getItem('__nassaj_pending_codex_permission_stamp')).toBeNull();
  });

  it('does not apply a stamp bound to another clientMsgId', async () => {
    harnessProvider = 'codex';
    stamp('default', 'cmid-1');
    const { result, rerender } = mount(log());
    pend(result, 'cmid-9');
    rerender({ controlEvents: log({ kind: 'session_created', newSessionId: 'cx-2', clientMsgId: 'cmid-9' }) });
    await waitFor(() => expect(result.current.chatState.currentSessionId).toBe('cx-2'));
    expect(localStorage.getItem('permissionMode-cx-2')).toBeNull();
  });

  it('clears the stamp on session_created with an empty id', async () => {
    harnessProvider = 'codex';
    stamp('default', 'cmid-1');
    const { rerender } = mount(log());
    rerender({ controlEvents: log({ kind: 'session_created', newSessionId: null, clientMsgId: 'cmid-1' }) });
    await waitFor(() => expect(sessionStorage.getItem('__nassaj_pending_codex_permission_stamp')).toBeNull());
  });

  it('applies the stamp when session_created arrives while the view is on another session', async () => {
    harnessProvider = 'codex';
    stamp('default', 'cmid-1');
    const { result, rerender } = mount(log());
    // the user navigated to an old session before the new chat's session_created arrived
    act(() => result.current.setSelectedSession({ id: 'other-old', __provider: 'codex' }));
    await waitFor(() => expect(result.current.chatState.currentSessionId).toBe('other-old'));
    rerender({ controlEvents: log({
      kind: 'session_created', newSessionId: 'cx-3', clientMsgId: 'cmid-1', parentSessionId: null, provider: 'codex',
    }) });
    await waitFor(() => expect(localStorage.getItem('permissionMode-cx-3')).toBe('default'));
    expect(result.current.chatState.currentSessionId).toBe('other-old');
  });

  it('a forked session inherits the parent mode', async () => {
    harnessProvider = 'codex';
    localStorage.setItem('permissionMode-parent-1', 'acceptEdits');
    const { result, rerender } = mount(log());
    act(() => result.current.setSelectedSession({ id: 'parent-1', __provider: 'codex' }));
    await waitFor(() => expect(result.current.chatState.currentSessionId).toBe('parent-1'));
    rerender({ controlEvents: log({
      kind: 'session_created', newSessionId: 'fork-1', forked: true, parentSessionId: 'parent-1', provider: 'codex',
    }) });
    await waitFor(() => expect(result.current.chatState.currentSessionId).toBe('fork-1'));
    expect(localStorage.getItem('permissionMode-fork-1')).toBe('acceptEdits');
  });

  it('a stale-resume replacement inherits the old session mode', async () => {
    harnessProvider = 'codex';
    localStorage.setItem('permissionMode-dead-1', 'bypassPermissions');
    const { result, rerender } = mount(log());
    act(() => result.current.setSelectedSession({ id: 'dead-1', __provider: 'codex' }));
    await waitFor(() => expect(result.current.chatState.currentSessionId).toBe('dead-1'));
    rerender({ controlEvents: log({
      kind: 'session_created', newSessionId: 'fresh-1', parentSessionId: 'dead-1', provider: 'codex',
    }) });
    await waitFor(() => expect(result.current.chatState.currentSessionId).toBe('fresh-1'));
    expect(localStorage.getItem('permissionMode-fresh-1')).toBe('bypassPermissions');
  });
});
