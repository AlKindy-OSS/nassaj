import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSessionSteer, type ControlEventLogLike } from './useSessionSteer';

const SESSION_ID = 's1';

function turnState(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: 'steer-turn-state',
    sessionId: SESSION_ID,
    turnId: 't1',
    starterUserId: 1,
    steerable: true,
    capability: { midTurnInjection: true },
    ...overrides,
  };
}

const EMPTY_LOG: ControlEventLogLike = { events: [], droppedBeforeSeq: 0 };

/** Builds a control-events log the way WebSocketContext's appendControlEvent does. */
function logOf(...frames: unknown[]): ControlEventLogLike {
  return { events: frames.map((frame, i) => ({ seq: i + 1, frame })), droppedBeforeSeq: 0 };
}

describe('useSessionSteer', () => {
  afterEach(() => vi.useRealTimers());

  it('canSteer is false for the starter and true for any other member once steerable', () => {
    const starter = renderHook(({ controlEvents }) =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 1, latestMessage: null, controlEvents, sendMessage: vi.fn() }),
      { initialProps: { controlEvents: EMPTY_LOG } },
    );
    starter.rerender({ controlEvents: logOf(turnState()) });
    expect(starter.result.current.canSteer).toBe(false);
    expect(starter.result.current.isStarter).toBe(true);

    const viewer = renderHook(({ controlEvents }) =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 2, latestMessage: null, controlEvents, sendMessage: vi.fn() }),
      { initialProps: { controlEvents: EMPTY_LOG } },
    );
    viewer.rerender({ controlEvents: logOf(turnState()) });
    expect(viewer.result.current.canSteer).toBe(true);
    expect(viewer.result.current.isStarter).toBe(false);
  });

  it('canSteer is false when steer-turn-state is absent (no capability signal)', () => {
    const view = renderHook(() =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 2, latestMessage: null, controlEvents: EMPTY_LOG, sendMessage: vi.fn() }),
    );
    expect(view.result.current.canSteer).toBe(false);
  });

  /**
   * T-1903/1904 e2e (BLOCKER) — regression: `steer-turn-state` arriving in the
   * SAME batch as an unrelated control event (the exact real-world race: it
   * fires at run start alongside other traffic) must still be observed. This
   * is precisely what broke on the old `latestMessage`-single-slot path — a
   * later write in the same render batch silently discarded an earlier one.
   * The append-only `controlEvents` log never does that; this test would have
   * caught the regression before it reached two-user e2e testing.
   */
  it('does not drop steer-turn-state when another control event lands in the same batch', () => {
    const view = renderHook(({ controlEvents }) =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 2, latestMessage: null, controlEvents, sendMessage: vi.fn() }),
      { initialProps: { controlEvents: EMPTY_LOG } },
    );
    // One re-render carries BOTH events at once — exactly what a same-tick
    // WS burst produces once React batches the state update.
    act(() => {
      view.rerender({
        controlEvents: logOf(
          { type: 'complete', sessionId: SESSION_ID, kind: 'complete' },
          turnState(),
        ),
      });
    });
    expect(view.result.current.canSteer).toBe(true);
    expect(view.result.current.turnState?.turnId).toBe('t1');
  });

  it('only processes each control-log entry once across re-renders (no duplicate events)', () => {
    const view = renderHook(({ controlEvents }) =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 2, latestMessage: null, controlEvents, sendMessage: vi.fn() }),
      { initialProps: { controlEvents: EMPTY_LOG } },
    );
    const queued = {
      type: 'steer-queued',
      sessionId: SESSION_ID,
      turnId: 't1',
      clientMsgId: 'c1',
      sender: { userId: 2, displayName: 'Sara' },
      starterUserId: 1,
      deliveryStatus: 'queued',
      text: 'hi',
    };
    const log = logOf(queued);
    act(() => view.rerender({ controlEvents: log }));
    expect(view.result.current.events).toEqual([queued]);

    // Same log object re-delivered (e.g. an unrelated parent re-render) must
    // not append the same entry twice.
    act(() => view.rerender({ controlEvents: log }));
    expect(view.result.current.events).toEqual([queued]);
  });

  it('collects steer-queued/delivered/rejected events scoped to this session', () => {
    const event = {
      type: 'steer-queued',
      sessionId: SESSION_ID,
      turnId: 't1',
      clientMsgId: 'c1',
      sender: { userId: 2, displayName: 'Sara' },
      starterUserId: 1,
      deliveryStatus: 'queued',
      text: 'hi',
    };
    const view = renderHook(({ controlEvents }) =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 2, latestMessage: null, controlEvents, sendMessage: vi.fn() }),
      { initialProps: { controlEvents: EMPTY_LOG } },
    );
    act(() => view.rerender({ controlEvents: logOf(event) }));
    expect(view.result.current.events).toEqual([event]);

    // An event for a DIFFERENT session must not leak in.
    act(() => view.rerender({ controlEvents: logOf(event, { ...event, sessionId: 'other', clientMsgId: 'c2' }) }));
    expect(view.result.current.events).toEqual([event]);
  });

  it('sendSteer resolves with the matched session-steer-result (accept)', async () => {
    const sendMessage = vi.fn((_msg: unknown) => ({ ok: true }));
    const view = renderHook(({ latestMessage }) =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 2, latestMessage, controlEvents: logOf(turnState()), sendMessage }),
      { initialProps: { latestMessage: null as any } },
    );

    let outcomePromise: ReturnType<typeof view.result.current.sendSteer>;
    act(() => {
      outcomePromise = view.result.current.sendSteer('focus here');
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session-steer', sessionId: SESSION_ID, turnId: 't1', text: 'focus here' }),
    );
    const sentClientMsgId = (sendMessage.mock.calls[0]![0] as { clientMsgId: string }).clientMsgId;

    act(() => {
      view.rerender({
        latestMessage: {
          type: 'session-steer-result',
          sessionId: SESSION_ID,
          turnId: 't1',
          clientMsgId: sentClientMsgId,
          ok: true,
          status: 202,
          deliveryStatus: 'queued',
        } as any,
      });
    });

    await expect(outcomePromise!).resolves.toEqual({ ok: true, deliveryStatus: 'queued' });
  });

  it('sendSteer resolves with a reject code (409 turn_not_active)', async () => {
    const sendMessage = vi.fn((_msg: unknown) => ({ ok: true }));
    const view = renderHook(({ latestMessage }) =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 2, latestMessage, controlEvents: logOf(turnState()), sendMessage }),
      { initialProps: { latestMessage: null as any } },
    );

    let outcomePromise: ReturnType<typeof view.result.current.sendSteer>;
    act(() => {
      outcomePromise = view.result.current.sendSteer('focus here');
    });
    const sentClientMsgId = (sendMessage.mock.calls[0]![0] as { clientMsgId: string }).clientMsgId;

    act(() => {
      view.rerender({
        latestMessage: {
          type: 'session-steer-result',
          sessionId: SESSION_ID,
          turnId: 't1',
          clientMsgId: sentClientMsgId,
          ok: false,
          status: 409,
          code: 'turn_not_active',
        } as any,
      });
    });

    await expect(outcomePromise!).resolves.toEqual({ ok: false, code: 'turn_not_active', status: 409 });
  });

  it('rejects immediately with "disconnected" when the socket send fails synchronously', async () => {
    const sendMessage = vi.fn(() => ({ ok: false, reason: 'closed' }));
    const view = renderHook(() =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 2, latestMessage: null, controlEvents: logOf(turnState()), sendMessage }),
    );
    const outcome = await view.result.current.sendSteer('hi');
    expect(outcome).toEqual({ ok: false, code: 'disconnected' });
  });

  it('rejects with text_empty for blank text without hitting the network', async () => {
    const sendMessage = vi.fn();
    const view = renderHook(() =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 2, latestMessage: null, controlEvents: logOf(turnState()), sendMessage }),
    );
    const outcome = await view.result.current.sendSteer('   ');
    expect(outcome).toEqual({ ok: false, code: 'text_empty' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  /**
   * Backend fix 44e8ccc4e — turnId is now nullable (a non-steerable run still
   * reports the starter, but has no turn to send text against).
   */
  it('rejects with turn_not_active when steer-turn-state has a null turnId', async () => {
    const sendMessage = vi.fn();
    const view = renderHook(() =>
      useSessionSteer({
        sessionId: SESSION_ID,
        currentUserId: 2,
        latestMessage: null,
        controlEvents: logOf(turnState({ turnId: null, steerable: false })),
        sendMessage,
      }),
    );
    const outcome = await view.result.current.sendSteer('hi');
    expect(outcome).toEqual({ ok: false, code: 'turn_not_active' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('ignores a steer-turn-state frame targeted at a different viewer (forViewerUserId)', () => {
    const view = renderHook(({ controlEvents }) =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 2, latestMessage: null, controlEvents, sendMessage: vi.fn() }),
      { initialProps: { controlEvents: EMPTY_LOG } },
    );
    act(() => view.rerender({ controlEvents: logOf(turnState({ forViewerUserId: 999 })) }));
    expect(view.result.current.turnState).toBeNull();
    expect(view.result.current.canSteer).toBe(false);
  });

  it('applies a broadcast steer-turn-state (forViewerUserId: null) to every viewer', () => {
    const view = renderHook(({ controlEvents }) =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 2, latestMessage: null, controlEvents, sendMessage: vi.fn() }),
      { initialProps: { controlEvents: EMPTY_LOG } },
    );
    act(() => view.rerender({ controlEvents: logOf(turnState({ forViewerUserId: null })) }));
    expect(view.result.current.canSteer).toBe(true);
  });

  /**
   * T-1904 e2e (bug 3) — a rejection that means "the feature was turned off"
   * (policy off mid-run, or consent revoked) must hide the Steer button for
   * the rest of THIS turn immediately, without waiting for a fresh
   * steer-turn-state that may never arrive before the turn ends.
   */
  it('hides canSteer for the rest of the turn after a steer_disabled rejection', async () => {
    const sendMessage = vi.fn((_msg: unknown) => ({ ok: true }));
    const view = renderHook(({ latestMessage }) =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 2, latestMessage, controlEvents: logOf(turnState()), sendMessage }),
      { initialProps: { latestMessage: null as any } },
    );
    expect(view.result.current.canSteer).toBe(true);

    let outcomePromise: ReturnType<typeof view.result.current.sendSteer>;
    act(() => {
      outcomePromise = view.result.current.sendSteer('focus here');
    });
    const sentClientMsgId = (sendMessage.mock.calls[0]![0] as { clientMsgId: string }).clientMsgId;

    act(() => {
      view.rerender({
        latestMessage: {
          type: 'session-steer-result',
          sessionId: SESSION_ID,
          turnId: 't1',
          clientMsgId: sentClientMsgId,
          ok: false,
          status: 403,
          code: 'steer_disabled',
        } as any,
      });
    });
    await outcomePromise!;

    expect(view.result.current.canSteer).toBe(false);
  });
});
