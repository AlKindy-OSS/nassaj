/**
 * T-1904 (ADR-190) — the running status bar for a viewer who is NOT this
 * run's starter: the starter's name replaces the "CLAUDE" label, the Steer
 * pill shows only when steerable, and STOP never renders for a viewer.
 */

import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSessionSteer } from '../../../session-steer/useSessionSteer';

const TRANSLATIONS: Record<string, string> = { 'messageTypes.claude': 'CLAUDE' };

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; name?: string }) => {
      const dv = TRANSLATIONS[key] ?? options?.defaultValue ?? key;
      return options?.name ? dv.replace('{{name}}', options.name) : dv;
    },
    i18n: { language: 'en' },
  }),
}));

import ClaudeStatus from './ClaudeStatus';

afterEach(cleanup);

describe('ClaudeStatus — starter vs viewer', () => {
  it("the starter's own bar is unchanged: CLAUDE label + STOP button", () => {
    const onAbort = vi.fn();
    render(
      <ClaudeStatus
        status={{ text: 'Thinking', can_interrupt: true }}
        isLoading
        provider="claude"
        onAbort={onAbort}
      />,
    );
    expect(screen.getByText('CLAUDE')).toBeTruthy();
    expect(screen.getByRole('button', { name: /STOP/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Steer/i })).toBeNull();
  });

  it('a viewer sees the starter name instead of CLAUDE, and never a STOP button', () => {
    const onAbort = vi.fn();
    render(
      <ClaudeStatus
        status={{ text: 'Thinking', can_interrupt: true }}
        isLoading
        provider="claude"
        onAbort={onAbort}
        viewerStarterName="سارة"
        isConfirmedStarter={false}
        steerable={false}
      />,
    );
    expect(screen.getByText('سارة')).toBeTruthy();
    expect(screen.queryByText('CLAUDE')).toBeNull();
    expect(screen.queryByRole('button', { name: /STOP/i })).toBeNull();
  });

  it('the Steer button shows only when steerable, and calls onSteerClick', () => {
    const onSteerClick = vi.fn();
    const { rerender } = render(
      <ClaudeStatus
        status={{ text: 'Thinking', can_interrupt: true }}
        isLoading
        provider="claude"
        viewerStarterName="سارة"
        isConfirmedStarter={false}
        steerable={false}
        onSteerClick={onSteerClick}
      />,
    );
    expect(screen.queryByRole('button', { name: /Steer/i })).toBeNull();

    rerender(
      <ClaudeStatus
        status={{ text: 'Thinking', can_interrupt: true }}
        isLoading
        provider="claude"
        viewerStarterName="سارة"
        isConfirmedStarter={false}
        steerable
        onSteerClick={onSteerClick}
      />,
    );
    const steerButton = screen.getByRole('button', { name: /Steer/i });
    steerButton.click();
    expect(onSteerClick).toHaveBeenCalledTimes(1);
  });

  /**
   * T-1904 e2e (BLOCKER, bug 1) — a viewer who was already on the page before
   * the turn started never gets `isLoading:true` locally, but the arrival of
   * `steer-turn-state` (now delivered reliably, see useSessionSteer) is
   * itself proof a run is active: `runActiveOverride` must still surface the
   * bar (name + Steer button) instead of rendering nothing at all.
   */
  it('renders the bar via runActiveOverride even when isLoading is false', () => {
    const onSteerClick = vi.fn();
    const { container } = render(
      <ClaudeStatus
        status={null}
        isLoading={false}
        provider="claude"
        viewerStarterName="سارة"
        isConfirmedStarter={false}
        steerable
        onSteerClick={onSteerClick}
        runActiveOverride
      />,
    );
    expect(container.innerHTML).not.toBe('');
    expect(screen.getByText('سارة')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Steer/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /STOP/i })).toBeNull();
  });

  it('renders nothing when isLoading is false and there is no override (unchanged baseline)', () => {
    const { container } = render(
      <ClaudeStatus status={null} isLoading={false} provider="claude" />,
    );
    expect(container.innerHTML).toBe('');
  });

  /**
   * B-1449 — end-to-end across the real boundary: `useSessionSteer`'s
   * `turnState` feeds `ChatInterface.tsx`'s `isRunActiveForViewer` formula
   * (`Boolean(steerTurnState) || isLoading`, `runActiveOverride =
   * isRunActiveForViewer && !isLoading`), reproduced here verbatim, which in
   * turn drives `ClaudeStatus`'s `runActiveOverride` prop. Before the fix,
   * `turnState` never cleared once a turn's `steer-turn-state` arrived (no
   * signal did), so a viewer's strip rendered forever even long after the
   * run ended. This test fails on the old `useSessionSteer` (no
   * `controlFrames` clearing path): `runActiveOverride` stays `true` and the
   * bar keeps rendering after the session-status idle frame.
   */
  it('the viewer strip disappears once session-status reports the turn ended (B-1449)', () => {
    const SESSION_ID = 's1';
    const steerTurnStateFrame = {
      type: 'steer-turn-state',
      sessionId: SESSION_ID,
      turnId: 't1',
      starterUserId: 1,
      steerable: true,
      starterSteerable: true,
      capability: { midTurnInjection: true },
    };
    const logOf = (...frames: unknown[]): { events: { seq: number; frame: unknown }[]; droppedBeforeSeq: number } => ({
      events: frames.map((frame, i) => ({ seq: i + 1, frame })),
      droppedBeforeSeq: 0,
    });

    const hook = renderHook(
      ({ controlEvents, controlFrames }) =>
        useSessionSteer({
          sessionId: SESSION_ID,
          currentUserId: 2, // viewer, not the starter (starterUserId: 1)
          latestMessage: null,
          controlEvents,
          controlFrames,
          sendMessage: vi.fn(),
        }),
      { initialProps: { controlEvents: logOf(), controlFrames: new Map() as any } },
    );

    hook.rerender({ controlEvents: logOf(steerTurnStateFrame), controlFrames: new Map() as any });

    // ChatInterface.tsx's exact derivation (isLoading is false: this viewer
    // never locally started the run).
    const isLoading = false;
    let isRunActiveForViewer = Boolean(hook.result.current.turnState) || isLoading;
    let runActiveOverride = isRunActiveForViewer && !isLoading;
    expect(runActiveOverride).toBe(true);

    const { container, rerender } = render(
      <ClaudeStatus
        status={null}
        isLoading={isLoading}
        provider="claude"
        viewerStarterName="سارة"
        isConfirmedStarter={false}
        steerable={hook.result.current.canSteer}
        runActiveOverride={runActiveOverride}
      />,
    );
    expect(container.innerHTML).not.toBe('');
    expect(screen.getByText('سارة')).toBeTruthy();

    // The server declares the run over for this session (seq 2: one shared
    // counter with the control log, so it follows the turn start at seq 1).
    hook.rerender({
      controlEvents: logOf(steerTurnStateFrame),
      controlFrames: new Map([
        [SESSION_ID, { seq: 2, frame: { type: 'session-status', sessionId: SESSION_ID, isProcessing: false } }],
      ]) as any,
    });
    expect(hook.result.current.turnState).toBeNull();

    isRunActiveForViewer = Boolean(hook.result.current.turnState) || isLoading;
    runActiveOverride = isRunActiveForViewer && !isLoading;
    expect(runActiveOverride).toBe(false);

    rerender(
      <ClaudeStatus
        status={null}
        isLoading={isLoading}
        provider="claude"
        viewerStarterName="سارة"
        isConfirmedStarter={false}
        steerable={hook.result.current.canSteer}
        runActiveOverride={runActiveOverride}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('STOP is never shown for a viewer even when can_interrupt is true', () => {
    render(
      <ClaudeStatus
        status={{ text: 'Thinking', can_interrupt: true }}
        isLoading
        provider="claude"
        onAbort={vi.fn()}
        viewerStarterName="محمد"
        isConfirmedStarter={false}
        steerable
        onSteerClick={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /STOP/i })).toBeNull();
  });
});

describe('ClaudeStatus — /steer hint indicator (T-1956)', () => {
  const HINT = /Type \/steer followed by your message/;

  it("shows a focusable hint indicator on the starter's own steerable turn", () => {
    render(
      <ClaudeStatus
        status={{ text: 'Thinking', can_interrupt: true }}
        isLoading
        provider="claude"
        onAbort={vi.fn()}
        showSteerHint
      />,
    );
    const indicator = screen.getByRole('img', { name: 'Steering hint' });
    expect(indicator.getAttribute('aria-label')).not.toMatch(HINT);
    expect(screen.queryByRole('tooltip')).toBeNull();
    const trigger = indicator.parentElement as HTMLElement;
    expect(trigger.tabIndex).toBe(0);
    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip').textContent).toMatch(HINT);
    expect(trigger.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);
  });

  it('renders no hint indicator when showSteerHint is not set (viewer or not steerable)', () => {
    render(
      <ClaudeStatus
        status={{ text: 'Thinking', can_interrupt: true }}
        isLoading
        provider="claude"
        viewerStarterName="سارة"
        isConfirmedStarter={false}
        steerable
        onSteerClick={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('run-status-steer-hint')).toBeNull();
  });
});

describe('ClaudeStatus — /steer hint on a second turn (T-1956 + B-1470)', () => {
  it("shows the hint for the starter when a new turn starts after a finished one", () => {
    const SESSION_ID = 's1';
    const turn = (turnId: string) => ({
      type: 'steer-turn-state',
      sessionId: SESSION_ID,
      turnId,
      starterUserId: 1,
      steerable: false,
      starterSteerable: true,
      capability: { midTurnInjection: true },
    });
    const idle = (seq: number) =>
      new Map([[SESSION_ID, { seq, frame: { type: 'session-status', sessionId: SESSION_ID, isProcessing: false } }]]);
    const hook = renderHook(
      ({ controlEvents, controlFrames }) =>
        useSessionSteer({
          sessionId: SESSION_ID,
          currentUserId: 1, // the starter
          latestMessage: null,
          controlEvents,
          controlFrames,
          sendMessage: vi.fn(),
        }),
      {
        initialProps: {
          controlEvents: { events: [] as { seq: number; frame: unknown }[], droppedBeforeSeq: 0 },
          controlFrames: new Map() as any,
        },
      },
    );
    // Turn 1 ends (seq 7), then turn 2 starts (seq 11) with the stale idle frame still stored.
    hook.rerender({
      controlEvents: { events: [{ seq: 6, frame: turn('t1') }], droppedBeforeSeq: 0 },
      controlFrames: idle(7) as any,
    });
    hook.rerender({
      controlEvents: { events: [{ seq: 6, frame: turn('t1') }, { seq: 11, frame: turn('t2') }], droppedBeforeSeq: 0 },
      controlFrames: idle(7) as any,
    });

    // ChatInterface: showSteerHint = canSteer && starterName known && isKnownStarter.
    const showSteerHint = hook.result.current.canSteer && hook.result.current.isStarter;
    render(
      <ClaudeStatus
        status={{ text: 'Thinking', can_interrupt: true }}
        isLoading
        provider="claude"
        onAbort={vi.fn()}
        showSteerHint={showSteerHint}
      />,
    );
    expect(screen.getByTestId('run-status-steer-hint')).toBeTruthy();
  });
});
