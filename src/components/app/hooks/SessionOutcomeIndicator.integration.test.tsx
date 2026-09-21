import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();

vi.mock('../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));
vi.mock('../../../utils/pageActivity', () => ({ pageIsActive: () => true }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import SessionRowStatusIndicator from '../../sidebar/view/subcomponents/SessionRowStatusIndicator';
import { deriveSessionRowIndicatorState } from '../../sidebar/view/subcomponents/sessionRowIndicatorState';
import {
  applyOutcomeDelta,
  applyOutcomeSnapshot,
  useSessionOutcome,
} from '../../../stores/sessionCompletionStore';

import { useSessionOutcomeAcknowledgement } from './useSessionOutcomeAcknowledgement';

type HarnessProps = {
  routeSessionId: string | null;
  routeLocationKey: string;
  selectedSessionId: string | null;
  isConnected?: boolean;
};

function Harness({
  routeSessionId,
  routeLocationKey,
  selectedSessionId,
  isConnected = true,
}: HarnessProps) {
  useSessionOutcomeAcknowledgement({
    routeSessionId,
    routeLocationKey,
    selectedSessionId,
    isConnected,
    initialNavigationType: 'reload',
  });
  const outcome = useSessionOutcome('session-a');
  const state = deriveSessionRowIndicatorState('running', outcome, true);

  return <SessionRowStatusIndicator state={state} />;
}

beforeEach(() => {
  authenticatedFetch.mockReset().mockImplementation(async (url: string) => {
    if (url === '/api/providers/sessions/outcomes/unseen') {
      return { ok: true, json: async () => ({ outcomes: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  applyOutcomeSnapshot([]);
});

afterEach(() => {
  cleanup();
  applyOutcomeSnapshot([]);
});

describe('terminal indicator read-intent integration', () => {
  it('keeps a live done result through focus and reconnect without POST', async () => {
    const props = {
      routeSessionId: 'session-a',
      routeLocationKey: 'reload-location',
      selectedSessionId: 'session-a',
    };
    const { rerender } = render(<Harness {...props} />);
    await vi.waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith(
      '/api/providers/sessions/outcomes/unseen',
    ));
    authenticatedFetch.mockClear();

    act(() => applyOutcomeDelta(
      'session-a',
      'done',
      '2026-08-26T10:00:00.000Z',
      'visible',
    ));
    expect(screen.getByLabelText('sessionProcessState.doneHint')).not.toBeNull();

    act(() => window.dispatchEvent(new Event('focus')));
    expect(authenticatedFetch).not.toHaveBeenCalled();

    authenticatedFetch.mockImplementation(async (url: string) => {
      if (url === '/api/providers/sessions/outcomes/unseen') {
        return {
          ok: true,
          json: async () => ({
            outcomes: [{
              sessionId: 'session-a',
              outcome: 'done',
              outcomeAt: '2026-08-26T10:00:00.000Z',
            }],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    rerender(<Harness {...props} isConnected={false} />);
    rerender(<Harness {...props} isConnected />);
    await vi.waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith(
      '/api/providers/sessions/outcomes/unseen',
    ));
    act(() => window.dispatchEvent(new Event('focus')));

    expect(authenticatedFetch.mock.calls.some(([, options]) => (
      (options as RequestInit | undefined)?.method === 'POST'
    ))).toBe(false);
    expect(screen.getByLabelText('sessionProcessState.doneHint')).not.toBeNull();
  });

  it('keeps live done visible over stale running until a later explicit route opening', async () => {
    const { rerender } = render(
      <Harness
        routeSessionId="session-a"
        routeLocationKey="reload-location"
        selectedSessionId="session-a"
      />,
    );
    await vi.waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith(
      '/api/providers/sessions/outcomes/unseen',
    ));
    authenticatedFetch.mockClear();

    act(() => applyOutcomeDelta(
      'session-a',
      'done',
      '2026-08-26T10:00:00.000Z',
      'visible',
    ));

    const done = screen.getByLabelText('sessionProcessState.doneHint');
    expect(done.getAttribute('title')).toBe('sessionProcessState.doneHint');
    expect(done.getAttribute('data-session-row-status')).toBe('done');
    expect(authenticatedFetch).not.toHaveBeenCalled();

    rerender(
      <Harness
        routeSessionId="session-b"
        routeLocationKey="open-b"
        selectedSessionId="session-b"
      />,
    );
    expect(authenticatedFetch).not.toHaveBeenCalled();

    rerender(
      <Harness
        routeSessionId="session-a"
        routeLocationKey="open-a-again"
        selectedSessionId="session-a"
      />,
    );
    await vi.waitFor(() => expect(authenticatedFetch).toHaveBeenCalledWith(
      '/api/providers/sessions/session-a/outcome-seen',
      expect.objectContaining({ method: 'POST' }),
    ));

    act(() => applyOutcomeDelta(
      'session-a',
      null,
      '2026-08-26T10:00:00.000Z',
      'seen',
    ));
    expect(screen.queryByLabelText('sessionProcessState.doneHint')).toBeNull();
    expect(screen.getByLabelText('sessionProcessState.runningHint')).not.toBeNull();
  });
});
