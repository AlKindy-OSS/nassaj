/**
 * useProjectPushReminder.test.tsx — the sidebar's "commits ready to push"
 * reminder must not freeze after its first fetch.
 *
 * Before this fix, the hook fetched `/api/git/remote-status` exactly once,
 * the moment its row scrolled into view (IntersectionObserver), and never
 * again. A commit made later in the same session (e.g. by the coordinator)
 * never moved the badge — only a full page reload re-mounted the hook and
 * fetched fresh. Two behaviours are pinned here: a periodic re-fetch, and a
 * refetch on tab focus; both must pick up a changed `ahead` count without a
 * remount.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

import { useProjectPushReminder } from './useProjectPushReminder';

type PushReminderState = { visibilityRef: React.MutableRefObject<HTMLDivElement | null>; ahead: number | null };

/** Mounts the hook behind a real DOM node so the IntersectionObserver gate
 * has something to attach to, exactly like SidebarProjectItem does. */
function Harness({ projectId, onState }: { projectId: string; onState: (s: PushReminderState) => void }) {
  const state = useProjectPushReminder(projectId);
  onState(state);
  return <div ref={state.visibilityRef} />;
}

function respondWith(ahead: number) {
  authenticatedFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ isRepositoryRoot: true, hasUpstream: true, ahead }),
  });
}

/** Fakes the IntersectionObserver used to gate the first fetch — fires
 * immediately as intersecting, mirroring a row already on screen. Tests that
 * need to move the row off-screen keep a handle on the instance so they can
 * re-fire the callback with `isIntersecting: false`. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  disconnected = false;
  target: Element | null = null;
  constructor(private callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element) {
    this.target = target;
    this.fire(true);
  }
  fire(isIntersecting: boolean) {
    if (!this.target) return;
    this.callback([{ isIntersecting, target: this.target } as IntersectionObserverEntry], this as any);
  }
  disconnect() { this.disconnected = true; }
  unobserve() {}
  takeRecords() { return []; }
}

describe('useProjectPushReminder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    authenticatedFetch.mockReset();
    FakeIntersectionObserver.instances = [];
    (globalThis as any).IntersectionObserver = FakeIntersectionObserver;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  afterEach(() => {
    // Each `it` mounts its own <Harness>; without an explicit unmount its
    // window/document listeners outlive the test and answer the next test's
    // focus/visibilitychange dispatches too, inflating call counts.
    cleanup();
    vi.useRealTimers();
  });

  it('re-fetches on a timer instead of freezing after the first result', async () => {
    respondWith(3);
    const box: { current: PushReminderState | null } = { current: null };
    await act(async () => {
      render(<Harness projectId="proj-1" onState={(s) => { box.current = s; }} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(box.current?.ahead).toBe(3);

    // A commit lands remotely; the next poll should pick it up.
    respondWith(5);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(box.current?.ahead).toBe(5);
    expect(authenticatedFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('re-fetches immediately when the tab regains focus', async () => {
    respondWith(1);
    const box: { current: PushReminderState | null } = { current: null };
    await act(async () => {
      render(<Harness projectId="proj-1" onState={(s) => { box.current = s; }} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(box.current?.ahead).toBe(1);

    respondWith(0);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(box.current?.ahead).toBeNull();
  });

  it('does not double-fetch when focus and visibilitychange fire together', async () => {
    respondWith(2);
    const box: { current: PushReminderState | null } = { current: null };
    await act(async () => {
      render(<Harness projectId="proj-1" onState={(s) => { box.current = s; }} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);

    respondWith(4);
    await act(async () => {
      // A real tab return fires both events in the same task.
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Only one of the two triggers should have made it through the
    // in-flight guard.
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(box.current?.ahead).toBe(4);
  });

  it('pauses polling once the row scrolls out of view', async () => {
    respondWith(1);
    const box: { current: PushReminderState | null } = { current: null };
    await act(async () => {
      render(<Harness projectId="proj-1" onState={(s) => { box.current = s; }} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);

    // The row scrolls off-screen.
    FakeIntersectionObserver.instances[0]?.fire(false);

    respondWith(9);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    // No poll fired for an off-screen row — the ahead count from before
    // stays put and no extra `git` process was spawned.
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
    expect(box.current?.ahead).toBe(1);

    // Scrolling back into view resumes polling.
    FakeIntersectionObserver.instances[0]?.fire(true);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(box.current?.ahead).toBe(9);
  });

  it('tears down its listeners and timer on unmount', async () => {
    respondWith(1);
    const box: { current: PushReminderState | null } = { current: null };
    let unmount!: () => void;
    await act(async () => {
      ({ unmount } = render(<Harness projectId="proj-1" onState={(s) => { box.current = s; }} />));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);

    unmount();

    respondWith(7);
    authenticatedFetch.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(120_000);
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      await Promise.resolve();
    });
    // An unmounted hook fires no further fetches.
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });
});
