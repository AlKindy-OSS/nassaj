/**
 * B-1469 round 4, qa-critic round 1 — guards the fix in `App.tsx`: "/",
 * "/session/:sessionId" and "/scheduled" used to be three separate <Route>
 * entries all rendering <AppContent/>. React Router remounts the whole
 * subtree whenever the MATCHED route entry changes, even across entries
 * rendering the identical component — the real-browser-confirmed mechanism
 * that wiped `ChatInterface`'s `useSessionStore()` instance a few dozen ms
 * after a brand-new session's optimistic bubble had been written into it.
 *
 * This renders the REAL `AuthenticatedApp` route table (not a reimplemented
 * copy, which could silently drift from production) inside a `MemoryRouter`,
 * navigates "/" -> "/session/x" -> "/scheduled" -> "/", and counts how many
 * times `AppContent` mounts. One `<Route path="/*">` entry for all three
 * means exactly one mount for the whole sequence; the pre-fix three-entry
 * table would mount it four times (once per entry it enters).
 *
 * RUNNER: vitest.
 */

import { useEffect } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const appContentMounts = vi.hoisted(() => ({ count: 0, unmounts: 0 }));

vi.mock('./contexts/WebSocketContext', () => ({
  WebSocketProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./components/auth', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./components/wiki/view/WikiPanel', () => ({ default: () => null }));
function MockAppContent() {
  useEffect(() => {
    appContentMounts.count += 1;
    return () => { appContentMounts.unmounts += 1; };
  }, []);
  return <div data-testid="app-content" />;
}
vi.mock('./components/app/AppContent', () => ({ default: () => <MockAppContent /> }));

import { AuthenticatedApp } from './App';

function Harness({ navigateRef }: { navigateRef: { current: ((to: string) => void) | null } }) {
  const navigate = useNavigate();
  useEffect(() => { navigateRef.current = (to: string) => navigate(to); }, [navigate, navigateRef]);
  return <AuthenticatedApp />;
}

describe('AuthenticatedApp route identity (qa-critic round 1)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    appContentMounts.count = 0;
    appContentMounts.unmounts = 0;
  });

  it('mounts AppContent exactly once across "/" -> "/session/x" -> "/scheduled" -> "/"', () => {
    const navigateRef: { current: ((to: string) => void) | null } = { current: null };
    render(
      <MemoryRouter initialEntries={['/']}>
        <Harness navigateRef={navigateRef} />
      </MemoryRouter>,
    );
    expect(appContentMounts.count).toBe(1);

    act(() => navigateRef.current!('/session/x'));
    expect(appContentMounts.count).toBe(1);

    act(() => navigateRef.current!('/scheduled'));
    expect(appContentMounts.count).toBe(1);

    act(() => navigateRef.current!('/'));
    expect(appContentMounts.count).toBe(1);
    expect(appContentMounts.unmounts).toBe(0);
  });

  it('also stays mounted through a /session/x -> /session/y transition', () => {
    const navigateRef: { current: ((to: string) => void) | null } = { current: null };
    render(
      <MemoryRouter initialEntries={['/session/x']}>
        <Harness navigateRef={navigateRef} />
      </MemoryRouter>,
    );
    expect(appContentMounts.count).toBe(1);

    act(() => navigateRef.current!('/session/y'));
    expect(appContentMounts.count).toBe(1);
    expect(appContentMounts.unmounts).toBe(0);
  });
});
