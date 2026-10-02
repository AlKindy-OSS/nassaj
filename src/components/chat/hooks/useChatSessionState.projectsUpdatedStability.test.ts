/**
 * B-1469 — a `projects_updated` WS frame rebuilds `selectedProject` with the
 * same identity (same `projectId`, new object reference). Before this fix
 * the main session-loading effect depended on the whole `selectedProject`
 * object AND on a 30s time-only `isStale` check that `appendRealtime` never
 * refreshed, so any reply running past 30s made the load effect re-run on
 * the next such frame: it reset pagination, re-sent `check-session-status`,
 * and re-fetched a 20-row tail that replaced `serverMessages` wholesale,
 * dropping an older confirmed bubble that fell outside that tail.
 *
 * This test drives the real `useChatSessionState` hook (not a mock) through
 * that exact sequence and asserts the effect does not re-run.
 *
 * Run: NODE_ENV=test npx vitest run \
 *   src/components/chat/hooks/useChatSessionState.projectsUpdatedStability.test.ts
 */

import { useRef } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../../../utils/api', () => ({ authenticatedFetch }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { useSessionStore, type NormalizedMessage } from '../../../stores/useSessionStore';
import { publishServerCapabilities } from '../../../stores/serverCapabilitiesStore';

import { useChatSessionState } from './useChatSessionState';

const SESSION = { id: 'sess-b1469', __provider: 'claude' } as any;
const projectV1 = { projectId: 'proj-b1469', path: '/p', fullPath: '/p' } as any;
// Stable across renders on purpose: a fresh `vi.fn()` per render would give
// each render its OWN mock instance, and reading `result.current.sendMessage`
// after a later render would silently inspect the wrong (empty) instance.
const sendMessage = vi.fn();

function row(id: string, timestamp: string): NormalizedMessage {
  return {
    id, sessionId: SESSION.id, timestamp, provider: 'claude',
    kind: 'text', role: 'user', content: `msg ${id}`, userId: 1,
  };
}

function useHarness(selectedProject: typeof projectV1) {
  const sessionStore = useSessionStore();
  const pendingViewSessionRef = useRef<{ sessionId: string | null; startedAt: number; projectId?: string | null } | null>(null);
  const chatState = useChatSessionState({
    selectedSession: SESSION,
    selectedProject,
    ws: {} as any,
    sendMessage,
    resetStreamingState: () => {},
    pendingViewSessionRef,
    sessionStore,
  });
  return { chatState, sendMessage, sessionStore };
}

beforeEach(() => {
  sendMessage.mockReset();
  publishServerCapabilities({ capabilities: { lightHistory: { supported: false, enabled: false, schema: 1 } } });
  authenticatedFetch.mockReset().mockImplementation(async () => ({
    ok: true,
    json: async () => ({
      // The tail the server returns for the initial/re-issued 20-row load —
      // deliberately NOT including the older row appended below at index 0,
      // which is exactly the row a wholesale replace used to drop.
      messages: Array.from({ length: 20 }, (_, i) => row(`tail-${i}`, `2026-09-30T00:${String(i).padStart(2, '0')}:00.000Z`)),
      total: 21,
      hasMore: true,
      nextCursor: null,
    }),
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('B-1469 — projects_updated identity churn does not re-run the load effect', () => {
  it('keeps the older bubble, does not resend check-session-status, and does not reset pagination', async () => {
    const { result, rerender } = renderHook(
      ({ selectedProject }) => useHarness(selectedProject),
      { initialProps: { selectedProject: projectV1 } },
    );

    await waitFor(() => expect(result.current.chatState.isLoadingSessionMessages).toBe(false));
    expect(result.current.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'check-session-status' }),
    );
    // Baseline after the real initial load (history tail + token-usage +
    // activity-probe REST calls the mount also fires). The assertion below is
    // scoped to the history/messages tail endpoint specifically — the one the
    // fixed load effect owns — not to every REST call in the component: a
    // sibling, out-of-scope effect (`fetchInitialTokenUsage`) also keys off
    // the whole `selectedProject` object and legitimately refetches on this
    // same churn, which is not the B-1469 bug (it never touches messages).
    const tailFetchUrl = (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('/messages?');
    const tailFetchCallsAfterInitialLoad = authenticatedFetch.mock.calls.filter(tailFetchUrl).length;
    const sendCallsAfterInitialLoad = result.current.sendMessage.mock.calls.length;

    // An older row the initial 20-row tail does not carry (e.g. it arrived
    // via realtime before the tail request settled, or was merged from a
    // wider window already). This is the bubble the bug drops.
    act(() => {
      result.current.sessionStore.appendRealtime(SESSION.id, row('older-confirmed', '2026-09-29T23:00:00.000Z'));
    });

    const beforeVisibleCount = result.current.chatState.visibleMessageCount;

    // Advance real time past STALE_THRESHOLD_MS (30s) — proves the fix does
    // not depend on timing, only on identity.
    vi.useFakeTimers();
    vi.advanceTimersByTime(31_000);
    vi.useRealTimers();

    // `projects_updated`: same projectId, new object reference.
    const projectV2 = { ...projectV1 };
    expect(projectV2).not.toBe(projectV1);
    rerender({ selectedProject: projectV2 });

    // No new tail fetch or check-session-status from the identity churn alone.
    expect(authenticatedFetch.mock.calls.filter(tailFetchUrl)).toHaveLength(tailFetchCallsAfterInitialLoad);
    expect(result.current.sendMessage.mock.calls.length).toBe(sendCallsAfterInitialLoad);
    expect(result.current.chatState.visibleMessageCount).toBe(beforeVisibleCount);

    const ids = result.current.chatState.chatMessages.map((m: any) => m.id ?? m.timestamp);
    const hasOlder = result.current.sessionStore.getMessages(SESSION.id).some((m) => m.id === 'older-confirmed');
    expect(hasOlder).toBe(true);
    const duplicateUserRows = result.current.sessionStore.getMessages(SESSION.id)
      .filter((m) => m.role === 'user' && m.id === 'older-confirmed');
    expect(duplicateUserRows).toHaveLength(1);
    expect(ids.length).toBeGreaterThan(0);
  });
});
