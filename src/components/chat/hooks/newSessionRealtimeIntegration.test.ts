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
    provider: 'claude',
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
