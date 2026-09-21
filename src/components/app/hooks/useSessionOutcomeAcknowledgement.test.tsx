import { StrictMode, type ReactNode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  acknowledgeOutcomeWhenActive,
  getOutcomeAcknowledgementToken,
  refreshOutcomes,
  releaseManualUnread,
  pageIsActive,
} = vi.hoisted(() => ({
  acknowledgeOutcomeWhenActive: vi.fn(),
  getOutcomeAcknowledgementToken: vi.fn(),
  refreshOutcomes: vi.fn(),
  releaseManualUnread: vi.fn(),
  pageIsActive: vi.fn(),
}));

vi.mock('../../../stores/sessionCompletionStore', () => ({
  acknowledgeOutcomeWhenActive,
  getOutcomeAcknowledgementToken,
  refreshOutcomes,
  releaseManualUnread,
}));
vi.mock('../../../utils/pageActivity', () => ({ pageIsActive }));

import {
  readDocumentNavigationType,
  useSessionOutcomeAcknowledgement,
  type DocumentNavigationType,
} from './useSessionOutcomeAcknowledgement';

type Props = {
  routeSessionId: string | null;
  routeLocationKey: string;
  selectedSessionId: string | null;
  isConnected: boolean;
  initialNavigationType: DocumentNavigationType;
};

const initialProps = (overrides: Partial<Props> = {}): Props => ({
  routeSessionId: 'session-a',
  routeLocationKey: 'initial',
  selectedSessionId: 'session-a',
  isConnected: true,
  initialNavigationType: 'reload',
  ...overrides,
});

const renderPolicy = (props: Props) => renderHook(
  (current: Props) => useSessionOutcomeAcknowledgement(current),
  { initialProps: props },
);

beforeEach(() => {
  acknowledgeOutcomeWhenActive.mockReset();
  getOutcomeAcknowledgementToken.mockReset().mockReturnValue('outcome-at-a');
  refreshOutcomes.mockReset().mockResolvedValue(true);
  releaseManualUnread.mockReset();
  pageIsActive.mockReset().mockReturnValue(true);
});

afterEach(() => cleanup());

describe('B-753 — document and route opening intent', () => {
  it('reads PerformanceNavigationTiming and fails closed when unavailable', () => {
    expect(readDocumentNavigationType({
      getEntriesByType: vi.fn().mockReturnValue([{ type: 'reload' }]),
    })).toBe('reload');
    expect(readDocumentNavigationType({
      getEntriesByType: vi.fn().mockReturnValue([]),
    })).toBe('unknown');
    expect(readDocumentNavigationType(null)).toBe('unknown');
    expect(readDocumentNavigationType({
      getEntriesByType: vi.fn(() => { throw new Error('blocked'); }),
    })).toBe('unknown');
  });

  it('refreshes outcomes without acknowledging an initial document reload', async () => {
    renderPolicy(initialProps());

    await vi.waitFor(() => expect(refreshOutcomes).toHaveBeenCalledTimes(1));
    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();
  });

  it('does not reinterpret the replayed initial reload effect as an opening in StrictMode', async () => {
    renderHook(
      () => useSessionOutcomeAcknowledgement(initialProps()),
      { wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> },
    );

    await vi.waitFor(() => expect(refreshOutcomes).toHaveBeenCalled());
    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();
  });

  it.each(['navigate', 'back_forward'] as const)(
    'treats initial %s navigation as an opening',
    async (initialNavigationType) => {
      renderPolicy(initialProps({ initialNavigationType }));

      await vi.waitFor(() => {
        expect(acknowledgeOutcomeWhenActive).toHaveBeenCalledWith('session-a', true);
      });
    },
  );

  it('fails closed when the initial navigation type is unknown', async () => {
    renderPolicy(initialProps({ initialNavigationType: 'unknown' }));
    await vi.waitFor(() => expect(refreshOutcomes).toHaveBeenCalledTimes(1));
    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();
  });

  it('treats every post-mount route change as an opening after a reload', async () => {
    const { rerender } = renderPolicy(initialProps());
    await vi.waitFor(() => expect(refreshOutcomes).toHaveBeenCalledTimes(1));

    rerender(initialProps({
      routeSessionId: 'session-b',
      routeLocationKey: 'spa-navigation',
      selectedSessionId: 'session-b',
    }));

    expect(acknowledgeOutcomeWhenActive).toHaveBeenCalledWith('session-b', true);
  });

  it('waits for the reconnect snapshot before acknowledging a route opened while disconnected', async () => {
    let resolveReconnect!: (applied: boolean) => void;
    refreshOutcomes
      .mockResolvedValueOnce(true)
      .mockReturnValueOnce(new Promise<boolean>((resolve) => {
        resolveReconnect = resolve;
      }));
    const { rerender } = renderPolicy(initialProps());
    await vi.waitFor(() => expect(refreshOutcomes).toHaveBeenCalledTimes(1));

    rerender(initialProps({
      routeSessionId: 'session-b',
      routeLocationKey: 'disconnected-route-b',
      selectedSessionId: 'session-b',
      isConnected: false,
    }));
    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();

    rerender(initialProps({
      routeSessionId: 'session-b',
      routeLocationKey: 'disconnected-route-b',
      selectedSessionId: 'session-b',
      isConnected: true,
    }));
    await vi.waitFor(() => expect(refreshOutcomes).toHaveBeenCalledTimes(2));
    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();

    await act(async () => resolveReconnect(true));
    expect(acknowledgeOutcomeWhenActive).toHaveBeenCalledWith('session-b', true);
  });

  it('does not keep a consumed opening eligible across connection epochs', async () => {
    let resolveReconnect!: (applied: boolean) => void;
    refreshOutcomes
      .mockResolvedValueOnce(true)
      .mockReturnValueOnce(new Promise<boolean>((resolve) => {
        resolveReconnect = resolve;
      }));
    const props = initialProps({ initialNavigationType: 'navigate' });
    const { rerender } = renderPolicy(props);
    await vi.waitFor(() => expect(acknowledgeOutcomeWhenActive).toHaveBeenCalledWith('session-a', true));
    acknowledgeOutcomeWhenActive.mockClear();

    rerender({ ...props, isConnected: false });
    rerender({ ...props, isConnected: true });
    await vi.waitFor(() => expect(refreshOutcomes).toHaveBeenCalledTimes(2));
    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();

    await act(async () => resolveReconnect(true));
    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();
  });

  it('does not create persistent reconnect eligibility for an initial reload', async () => {
    refreshOutcomes.mockResolvedValue(true);
    const props = initialProps();
    const { rerender } = renderPolicy(props);
    await vi.waitFor(() => expect(refreshOutcomes).toHaveBeenCalledTimes(1));

    rerender({ ...props, isConnected: false });
    rerender({ ...props, isConnected: true });
    await vi.waitFor(() => expect(refreshOutcomes).toHaveBeenCalledTimes(2));

    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();
  });

  it('does not consume a later reconnect outcome on focus without a new opening', async () => {
    let resolveReconnect!: (applied: boolean) => void;
    refreshOutcomes
      .mockResolvedValueOnce(true)
      .mockReturnValueOnce(new Promise<boolean>((resolve) => {
        resolveReconnect = resolve;
      }));
    const props = initialProps({ initialNavigationType: 'navigate' });
    const { rerender } = renderPolicy(props);
    await vi.waitFor(() => expect(acknowledgeOutcomeWhenActive).toHaveBeenCalledTimes(1));
    acknowledgeOutcomeWhenActive.mockClear();

    rerender({ ...props, isConnected: false });
    pageIsActive.mockReturnValue(false);
    rerender({ ...props, isConnected: true });
    await act(async () => resolveReconnect(true));
    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();

    pageIsActive.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();
  });

  it('retries a failed snapshot with bounded delay and preserves pending openings', async () => {
    refreshOutcomes
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    renderPolicy(initialProps({ initialNavigationType: 'navigate' }));

    await vi.waitFor(() => expect(refreshOutcomes).toHaveBeenCalledTimes(1));
    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(refreshOutcomes).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(refreshOutcomes).toHaveBeenCalledTimes(2));
    expect(acknowledgeOutcomeWhenActive).toHaveBeenCalledWith('session-a', true);
  });

  it('does not acknowledge a direct route until its session hydration matches', async () => {
    const props = initialProps({
      selectedSessionId: null,
      initialNavigationType: 'navigate',
    });
    const { rerender } = renderPolicy(props);
    await vi.waitFor(() => expect(refreshOutcomes).toHaveBeenCalledTimes(1));
    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();

    rerender({ ...props, selectedSessionId: 'session-a' });
    expect(acknowledgeOutcomeWhenActive).toHaveBeenCalledWith('session-a', true);
  });

  it('cancels an unhydrated deep link when navigation leaves it', async () => {
    const props = initialProps({
      selectedSessionId: null,
      initialNavigationType: 'navigate',
    });
    const { rerender } = renderPolicy(props);
    await vi.waitFor(() => expect(refreshOutcomes).toHaveBeenCalledTimes(1));

    rerender({
      ...props,
      routeSessionId: 'session-b',
      routeLocationKey: 'route-b',
      selectedSessionId: 'session-b',
    });
    expect(acknowledgeOutcomeWhenActive.mock.calls).toEqual([['session-b', true]]);

    rerender({
      ...props,
      routeSessionId: 'session-b',
      routeLocationKey: 'route-b',
      selectedSessionId: 'session-a',
    });
    expect(acknowledgeOutcomeWhenActive.mock.calls).toEqual([['session-b', true]]);
  });

  it('does not acknowledge a failed deep link before unmount', async () => {
    const { unmount } = renderPolicy(initialProps({
      selectedSessionId: null,
      initialNavigationType: 'navigate',
    }));
    await vi.waitFor(() => expect(refreshOutcomes).toHaveBeenCalledTimes(1));
    unmount();

    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();
  });

  it('cancels an unhydrated deep link when navigation returns to the root route', async () => {
    const props = initialProps({
      selectedSessionId: null,
      initialNavigationType: 'navigate',
    });
    const { rerender } = renderPolicy(props);
    await vi.waitFor(() => expect(refreshOutcomes).toHaveBeenCalledTimes(1));

    rerender({
      ...props,
      routeSessionId: null,
      routeLocationKey: 'root',
    });
    rerender({
      ...props,
      routeSessionId: null,
      routeLocationKey: 'root',
      selectedSessionId: 'session-a',
    });

    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();
  });

  it('retains B and C when both routes open before the outcome snapshot resolves', async () => {
    let resolveSnapshot!: (applied: boolean) => void;
    refreshOutcomes.mockReturnValue(new Promise<boolean>((resolve) => {
      resolveSnapshot = resolve;
    }));
    const { rerender } = renderPolicy(initialProps({
      routeSessionId: 'session-b',
      selectedSessionId: 'session-b',
      initialNavigationType: 'navigate',
    }));
    rerender(initialProps({
      routeSessionId: 'session-c',
      routeLocationKey: 'route-c',
      selectedSessionId: 'session-c',
      initialNavigationType: 'navigate',
    }));
    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();

    await act(async () => resolveSnapshot(true));

    expect(acknowledgeOutcomeWhenActive.mock.calls).toEqual([
      ['session-b', true],
      ['session-c', true],
    ]);
  });

  it('recognizes a new location key as opening the same session again', async () => {
    const props = initialProps({ initialNavigationType: 'navigate' });
    const { rerender } = renderPolicy(props);
    await vi.waitFor(() => expect(acknowledgeOutcomeWhenActive).toHaveBeenCalledTimes(1));

    rerender({ ...props, routeLocationKey: 'same-session-new-location' });

    expect(acknowledgeOutcomeWhenActive).toHaveBeenCalledTimes(2);
    expect(acknowledgeOutcomeWhenActive).toHaveBeenLastCalledWith('session-a', true);
  });
});

describe('B-753 — explicit opening is the only acknowledgement intent', () => {
  it('does not turn focus of the already-selected reload route into a new opening', async () => {
    pageIsActive.mockReturnValue(false);
    renderPolicy(initialProps());
    await vi.waitFor(() => expect(refreshOutcomes).toHaveBeenCalledTimes(1));

    pageIsActive.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();
  });

  it('flushes pending route openings on visibility return after the snapshot', async () => {
    pageIsActive.mockReturnValue(false);
    renderPolicy(initialProps({ initialNavigationType: 'navigate' }));
    await vi.waitFor(() => expect(refreshOutcomes).toHaveBeenCalledTimes(1));
    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();

    pageIsActive.mockReturnValue(true);
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    expect(acknowledgeOutcomeWhenActive).toHaveBeenCalledWith(
      'session-a',
      true,
      'outcome-at-a',
    );
  });

  it('removes focus and visibility listeners on cleanup', () => {
    pageIsActive.mockReturnValue(false);
    const { unmount } = renderPolicy(initialProps({ isConnected: false }));
    acknowledgeOutcomeWhenActive.mockClear();
    unmount();

    pageIsActive.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();
  });

  it('ignores a pending snapshot that resolves after cleanup', async () => {
    let resolveSnapshot!: (applied: boolean) => void;
    refreshOutcomes.mockReturnValue(new Promise<boolean>((resolve) => {
      resolveSnapshot = resolve;
    }));
    const { unmount } = renderPolicy(initialProps({ initialNavigationType: 'navigate' }));
    unmount();

    await act(async () => resolveSnapshot(true));

    expect(acknowledgeOutcomeWhenActive).not.toHaveBeenCalled();
  });
});
