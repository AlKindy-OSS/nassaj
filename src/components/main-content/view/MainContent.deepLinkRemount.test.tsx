/**
 * B-1469 round 4 — the FIRST bubble of a brand-new conversation vanished for
 * good, in the real browser, with the store already holding the row and
 * rounds 1-3's guards all satisfied. Browser instrumentation (console +
 * network capture against a live dev server, both Claude haiku and Codex
 * GPT-6-Luna) traced it to a layer none of the first three rounds touched:
 * `MainContent`'s own `deepLinkResolution.status !== 'idle'` branch.
 *
 * Real sequence observed (ids/order exactly as traced):
 *  1. User sends with no session yet — `pendingUserMessage` renders the
 *     optimistic bubble (round 1 path).
 *  2. `session_created` arrives for `newSessionId`; `useChatRealtimeHandlers`
 *     calls `onSessionProcessing(newSessionId)` (stamping `processingSessions`)
 *     and THEN `onNavigateToSession(newSessionId, {replace:true})` in the same
 *     tick — both batch into one React commit.
 *  3. The router updates the URL to `/session/<newSessionId>`.
 *     `useProjectsState`'s deep-link effect sees a `sessionId` param that is
 *     not YET in any project's session list (the sidebar hasn't refreshed)
 *     and sets `deepLinkResolution = { status: 'loading', sessionId }` —
 *     exactly the shape a genuine, externally-opened deep link produces.
 *  4. `MainContent` swapped in `<MainContentStateView mode="deep-link">` for
 *     its ENTIRE chat subtree while that status was non-idle, unmounting
 *     `ChatInterface` — and with it its own `useSessionStore()` instance and
 *     `pendingViewSessionRef` — a few dozen ms after the flush effect had
 *     already written the optimistic row into the (about to be discarded)
 *     store. Remounting fresh afterwards means a brand-new, EMPTY store: the
 *     row is gone, permanently, with no response or retry able to restore it
 *     (confirmed: it reappears only once the session is reopened, which reads
 *     the persisted server copy from scratch).
 *
 * `processingSessions` already carries the exact fact the deep-link guard is
 * missing — "this session is actively running in THIS tab, stamped before
 * the navigate that triggered the resolver" — with no server round-trip
 * needed. `shouldShowDeepLinkPlaceholder` (MainContent.tsx) is the fix: skip
 * the placeholder for a session `processingSessions` already vouches for.
 *
 * This test reproduces the unmount/remount at the exact boundary the bug
 * lived in — a child holding `useSessionStore()` state, swapped for a
 * placeholder by the same predicate MainContent uses — without needing the
 * full router/provider tree. It fails on the pre-fix predicate
 * (`deepLinkResolution.status !== 'idle'` alone) and passes on the real one.
 *
 * RUNNER: vitest.
 */

import { useRef } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { SessionDeepLinkResolution } from '../../../hooks/useProjectsState';
import { useSessionStore, type NormalizedMessage } from '../../../stores/useSessionStore';

import { shouldShowDeepLinkPlaceholder } from './MainContent';

const SID = 'sess-b1469-r4';
const USER_ROW: NormalizedMessage = {
  id: 'cmid_fixed_r4_1',
  sessionId: SID,
  timestamp: '2026-10-02T00:00:00.000Z',
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content: 'diag r4: reply with just OK',
};

/**
 * Stand-in for `ChatInterface`: owns the real session store, like the real
 * component. `seedState` is a plain object living OUTSIDE React (in the test,
 * like the composer's own flush effect firing exactly once at send time) —
 * unmounting and remounting this component creates a brand-new
 * `useSessionStore()` instance either way, but it must NOT silently reseed
 * the row on remount, or the test would no longer tell "the row survived"
 * apart from "the row was sent twice".
 */
function FakeChatInterface({
  seedState,
  onMountedStoreRef,
}: {
  seedState: { sent: boolean };
  onMountedStoreRef?: (ids: string[]) => void;
}) {
  const sessionStore = useSessionStore();
  const mountedOnce = useRef(false);
  if (!mountedOnce.current) {
    mountedOnce.current = true;
    sessionStore.setActiveSession(SID);
    if (!seedState.sent) {
      seedState.sent = true;
      sessionStore.appendRealtime(SID, USER_ROW);
    }
  }
  const userRows = sessionStore.getMessages(SID).filter((m) => m.role === 'user');
  onMountedStoreRef?.(userRows.map((m) => m.id));
  return (
    <div data-testid="chat-pane">
      {userRows.map((m) => <div key={m.id} role="listitem">{m.content}</div>)}
    </div>
  );
}

/** Mirrors MainContent's own branch: placeholder OR the chat subtree, nothing else. */
function Harness({
  deepLinkResolution,
  processingSessions,
  seedState,
  onMountedStoreRef,
}: {
  deepLinkResolution: SessionDeepLinkResolution;
  processingSessions: Set<string>;
  seedState: { sent: boolean };
  onMountedStoreRef?: (ids: string[]) => void;
}) {
  if (shouldShowDeepLinkPlaceholder(deepLinkResolution, processingSessions)) {
    return <div data-testid="deep-link-placeholder">resolving…</div>;
  }
  return <FakeChatInterface seedState={seedState} onMountedStoreRef={onMountedStoreRef} />;
}

describe('B-1469 round 4 — deep-link placeholder must not unmount an actively-processing session', () => {
  afterEach(() => cleanup());

  it('FAILS the old predicate: a processing session still gets unmounted and loses its optimistic row', () => {
    // The pre-fix condition — no `processingSessions` escape hatch at all.
    const oldPredicate = (dl: SessionDeepLinkResolution) => dl.status !== 'idle';
    const seedState = { sent: false };

    const { rerender } = render(
      <div>
        {oldPredicate({ status: 'idle', sessionId: null })
          ? <div data-testid="deep-link-placeholder" />
          : <FakeChatInterface seedState={seedState} />}
      </div>,
    );
    expect(screen.getByTestId('chat-pane')).toBeTruthy();
    expect(within(screen.getByTestId('chat-pane')).getAllByRole('listitem')).toHaveLength(1);

    // session_created -> router navigates -> deep-link effect sees the new,
    // not-yet-listed session id and flips to 'loading' (real observed shape).
    const loading: SessionDeepLinkResolution = { status: 'loading', sessionId: SID };
    rerender(
      <div>
        {oldPredicate(loading) ? <div data-testid="deep-link-placeholder" /> : <FakeChatInterface seedState={seedState} />}
      </div>,
    );
    // The bug: the chat pane (and its store-backed row) is gone.
    expect(screen.queryByTestId('chat-pane')).toBeNull();
    expect(screen.getByTestId('deep-link-placeholder')).toBeTruthy();

    // Resolution finishes -> back to idle -> ChatInterface mounts FRESH. Nothing
    // re-sends the message (the composer's flush effect already fired once, at
    // step 1) — a fresh `useSessionStore()` instance starts genuinely empty.
    rerender(
      <div>
        {oldPredicate({ status: 'idle', sessionId: null })
          ? <div data-testid="deep-link-placeholder" />
          : <FakeChatInterface seedState={seedState} />}
      </div>,
    );
    expect(within(screen.getByTestId('chat-pane')).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('PASSES the fix: a session processingSessions vouches for is never unmounted, and keeps its row', () => {
    const mountIds: string[][] = [];
    const processingSessions = new Set<string>();
    const seedState = { sent: false };

    const { rerender } = render(
      <Harness
        deepLinkResolution={{ status: 'idle', sessionId: null }}
        processingSessions={processingSessions}
        seedState={seedState}
        onMountedStoreRef={(ids) => mountIds.push(ids)}
      />,
    );
    expect(screen.getByTestId('chat-pane')).toBeTruthy();
    expect(within(screen.getByTestId('chat-pane')).getAllByRole('listitem')).toHaveLength(1);

    // session_created stamps `processingSessions` (onSessionProcessing) in the
    // SAME event as the navigate that will trigger the deep-link effect.
    processingSessions.add(SID);
    const loading: SessionDeepLinkResolution = { status: 'loading', sessionId: SID };
    rerender(
      <Harness
        deepLinkResolution={loading}
        processingSessions={processingSessions}
        seedState={seedState}
        onMountedStoreRef={(ids) => mountIds.push(ids)}
      />,
    );

    // The fix: still the SAME chat pane, never unmounted, row still there.
    expect(screen.queryByTestId('deep-link-placeholder')).toBeNull();
    expect(screen.getByTestId('chat-pane')).toBeTruthy();
    expect(within(screen.getByTestId('chat-pane')).getAllByRole('listitem')).toHaveLength(1);
    expect(within(screen.getByTestId('chat-pane')).getAllByRole('listitem')[0].textContent).toBe(USER_ROW.content);

    // Resolution finishes (session list catches up) -> idle again.
    rerender(
      <Harness
        deepLinkResolution={{ status: 'idle', sessionId: null }}
        processingSessions={processingSessions}
        seedState={seedState}
        onMountedStoreRef={(ids) => mountIds.push(ids)}
      />,
    );
    expect(within(screen.getByTestId('chat-pane')).getAllByRole('listitem')).toHaveLength(1);

    // The instrumentation ref proves it was the SAME store instance throughout
    // (the row's id is identical on every mount callback, never reset to []).
    expect(mountIds.every((ids) => ids.length === 1 && ids[0] === USER_ROW.id)).toBe(true);
  });

  it('still shows the placeholder for a genuine deep link (a session NOT processing in this tab)', () => {
    // A different tab/user opening a shared session link: processingSessions
    // does not name it, so the deep-link resolver keeps full authority.
    const resolution: SessionDeepLinkResolution = { status: 'loading', sessionId: 'someone-elses-session' };
    expect(shouldShowDeepLinkPlaceholder(resolution, new Set())).toBe(true);
    expect(shouldShowDeepLinkPlaceholder(resolution, new Set(['a-different-session']))).toBe(true);
    expect(shouldShowDeepLinkPlaceholder({ status: 'idle', sessionId: null }, new Set())).toBe(false);
    expect(shouldShowDeepLinkPlaceholder(resolution, new Set(['someone-elses-session']))).toBe(false);
  });

  it('forbidden/not_found are definitive verdicts: a stale processingSessions entry cannot override them', () => {
    // qa-critic round 1: `processingSessions` is also filled from
    // session-status frames and can go stale (a tab left open past a
    // session's real lifetime) — it must only skip the transient `loading`
    // window, never a resolved rejection the server already gave.
    const forbidden: SessionDeepLinkResolution = { status: 'forbidden', sessionId: SID };
    const notFound: SessionDeepLinkResolution = { status: 'not_found', sessionId: SID };
    const staleProcessing = new Set([SID]);

    expect(shouldShowDeepLinkPlaceholder(forbidden, staleProcessing)).toBe(true);
    expect(shouldShowDeepLinkPlaceholder(notFound, staleProcessing)).toBe(true);
    expect(shouldShowDeepLinkPlaceholder(forbidden, new Set())).toBe(true);
    expect(shouldShowDeepLinkPlaceholder(notFound, new Set())).toBe(true);
  });
});
