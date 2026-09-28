/**
 * T-1862 round 2 (qa HIGH / qa M-2) — the scroll-to-bottom arrow must react
 * to a REAL scroll (scrollbar drag, keyboard, or wheel/touch — anything that
 * fires a native 'scroll' event on the container), not stay pinned to a
 * stale isUserScrolledUp.
 *
 * qa M-2's concern: a test that only exercises props (isUserScrolledUp passed
 * in directly) would pass on the OLD, buggy code too, because it never
 * proves the actual DOM `onScroll` wiring exists. This harness owns a real
 * `isUserScrolledUp` state and updates it the same way ChatInterface does —
 * via the exact `onScroll` prop ChatMessagesPane exposes — then drives it
 * with `fireEvent.scroll` on the real container node, so the test fails on
 * any regression that drops or breaks that wiring.
 */
import { useCallback, useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => options?.defaultValue ?? key }) }));
vi.mock('../../../participants', () => ({ useSessionParticipants: () => ({ participants: [] }) }));
vi.mock('./MessageComponent', () => ({ default: ({ message }: any) => <p>{message.content}</p> }));
vi.mock('./ProviderSelectionEmptyState', () => ({ default: () => <div>ordinary-empty-state</div> }));

import ChatMessagesPane from './ChatMessagesPane';

const message = { id: 'm1', type: 'assistant', content: 'hi', timestamp: new Date() };

const baseProps = {
  isLoadingSessionMessages: false, chatMessages: [message], visibleMessages: [message],
  selectedSession: { id: 's1' }, currentSessionId: 's1', visibleMessageCount: 100, totalMessages: 1,
  selectedProject: {}, isLoadingMoreMessages: false, isLoadingAllMessages: false, hasMoreMessages: false,
} as any;

/** Sets scrollHeight/clientHeight/scrollTop — jsdom computes none of these. */
function stubMetrics(container: HTMLDivElement, { scrollHeight, clientHeight, scrollTop }: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(container, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(container, 'scrollTop', { value: scrollTop, configurable: true, writable: true });
}

/** Mirrors ChatInterface's real wiring: onScroll recomputes isUserScrolledUp from actual position. */
function ArrowHarness({ showResync = false }: { showResync?: boolean }) {
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setIsUserScrolledUp(!nearBottom);
  }, []);
  return (
    <ChatMessagesPane
      {...baseProps}
      scrollContainerRef={ref}
      onWheel={() => {}}
      onTouchMove={() => {}}
      onScroll={onScroll}
      isUserScrolledUp={isUserScrolledUp}
      hasMessages
      showResync={showResync}
      onScrollToBottom={() => {}}
    />
  );
}

afterEach(() => cleanup());

describe('T-1862 round 2: scroll-to-bottom arrow follows real scroll position', () => {
  it('idle at the true bottom (no history error, not stuck): no arrow', () => {
    render(<ArrowHarness />);
    const container = screen.getByText('hi').closest('[class*="overflow-y-auto"]') as HTMLDivElement;
    stubMetrics(container, { scrollHeight: 1000, clientHeight: 1000, scrollTop: 0 });
    fireEvent.scroll(container);
    expect(screen.queryByRole('button', { name: /scroll to bottom|latest/i })).toBeNull();
  });

  it('fireEvent.scroll away from the bottom makes the arrow appear', () => {
    render(<ArrowHarness />);
    const container = screen.getByText('hi').closest('[class*="overflow-y-auto"]') as HTMLDivElement;
    stubMetrics(container, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    fireEvent.scroll(container);
    expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeTruthy();
  });

  it('scrolling back to the bottom makes the arrow disappear again', () => {
    render(<ArrowHarness />);
    const container = screen.getByText('hi').closest('[class*="overflow-y-auto"]') as HTMLDivElement;
    stubMetrics(container, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
    fireEvent.scroll(container);
    expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeTruthy();

    Object.defineProperty(container, 'scrollTop', { value: 610, configurable: true, writable: true });
    fireEvent.scroll(container);
    expect(screen.queryByRole('button', { name: 'Scroll to bottom' })).toBeNull();
  });

  it('idle at the bottom with showResync=true (history error / stuck) still shows the arrow', () => {
    render(<ArrowHarness showResync />);
    const container = screen.getByText('hi').closest('[class*="overflow-y-auto"]') as HTMLDivElement;
    stubMetrics(container, { scrollHeight: 1000, clientHeight: 1000, scrollTop: 0 });
    fireEvent.scroll(container);
    expect(screen.getByRole('button', { name: 'Go to latest & refresh' })).toBeTruthy();
  });
});
