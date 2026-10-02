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
    // a19af3a88: always sent by this server; a realistic default frame armed
    // for the starter too, distinct from `steerable` (non-starter eligibility).
    starterSteerable: true,
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

  it('canSteer is true for both the starter and any other member once steerable', () => {
    // ADR-190 (تحديث): البادئ نفسه مؤهَّل لتوجيه دوره الجاري — الخادم يقبل
    // sender === starter مباشرةً بلا موافقة وبلا موجّه أدوات.
    const starter = renderHook(({ controlEvents }) =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 1, latestMessage: null, controlEvents, sendMessage: vi.fn() }),
      { initialProps: { controlEvents: EMPTY_LOG } },
    );
    starter.rerender({ controlEvents: logOf(turnState()) });
    expect(starter.result.current.canSteer).toBe(true);
    expect(starter.result.current.isStarter).toBe(true);

    const viewer = renderHook(({ controlEvents }) =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 2, latestMessage: null, controlEvents, sendMessage: vi.fn() }),
      { initialProps: { controlEvents: EMPTY_LOG } },
    );
    viewer.rerender({ controlEvents: logOf(turnState()) });
    expect(viewer.result.current.canSteer).toBe(true);
    expect(viewer.result.current.isStarter).toBe(false);
  });

  it('starter reads starterSteerable, not the broadcast steerable (df0898ce0)', () => {
    // ADR-190 (تحديث df0898ce0) — الإطار العام (forViewerUserId: null) يجعل
    // steerable تعني «غيري قد يوجّه» فقط؛ starterSteerable هي مصدر أهلية
    // البادئ نفسه، حتى حين steerable=false (لا موافقة على عضوٍ آخر).
    const starter = renderHook(({ controlEvents }) =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 1, latestMessage: null, controlEvents, sendMessage: vi.fn() }),
      { initialProps: { controlEvents: EMPTY_LOG } },
    );
    starter.rerender({
      controlEvents: logOf(turnState({ steerable: false, starterSteerable: true, forViewerUserId: null })),
    });
    expect(starter.result.current.isStarter).toBe(true);
    expect(starter.result.current.canSteer).toBe(true);

    const viewer = renderHook(({ controlEvents }) =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 2, latestMessage: null, controlEvents, sendMessage: vi.fn() }),
      { initialProps: { controlEvents: EMPTY_LOG } },
    );
    viewer.rerender({
      controlEvents: logOf(turnState({ steerable: false, starterSteerable: true, forViewerUserId: null })),
    });
    expect(viewer.result.current.isStarter).toBe(false);
    expect(viewer.result.current.canSteer).toBe(false);
  });

  it('canSteer is false for the starter when starterSteerable is absent (no fallback to steerable)', () => {
    // a19af3a88: an absent `starterSteerable` (older/malformed frame) must
    // NOT fall back to `steerable` — that field now means something else
    // entirely for a viewer who is the starter (another member's eligibility).
    const { starterSteerable: _omit, ...frameWithoutStarterSteerable } = turnState({ steerable: true });
    const starter = renderHook(({ controlEvents }) =>
      useSessionSteer({ sessionId: SESSION_ID, currentUserId: 1, latestMessage: null, controlEvents, sendMessage: vi.fn() }),
      { initialProps: { controlEvents: EMPTY_LOG } },
    );
    starter.rerender({ controlEvents: logOf(frameWithoutStarterSteerable) });
    expect(starter.result.current.isStarter).toBe(true);
    expect(starter.result.current.canSteer).toBe(false);
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

  /**
   * B-1449 — بعد `steer-turn-state`، الشريط/زرّ التوجيه كانا يبقيان ظاهرَين
   * إلى الأبد (`turnState` لا يُمسح إلا بتبديل الجلسة) حتى بعد انتهاء الدور
   * فعلياً على الخادم. `session-status{isProcessing:false}` هو الإعلان
   * الوحيد المتاح للعميل على انتهاء الدور — امسح `turnState`/`events` عليه.
   * هذا الاختبار يفشل على الكود القديم (لا وجود لـ`controlFrames` في
   * التوقيع، ولا لأثرٍ يمسح `turnState` غير تبديل الجلسة): `turnState` يبقى
   * غير-فارغ و`canSteer` صحيحاً إلى ما لا نهاية.
   */
  it('clears turnState/canSteer once session-status reports the turn ended (B-1449)', () => {
    const view = renderHook(
      ({ controlEvents, controlFrames }) =>
        useSessionSteer({
          sessionId: SESSION_ID,
          currentUserId: 2,
          latestMessage: null,
          controlEvents,
          controlFrames,
          sendMessage: vi.fn(),
        }),
      { initialProps: { controlEvents: EMPTY_LOG, controlFrames: new Map() as any } },
    );
    act(() => view.rerender({ controlEvents: logOf(turnState()), controlFrames: new Map() as any }));
    expect(view.result.current.turnState?.turnId).toBe('t1');
    expect(view.result.current.canSteer).toBe(true);

    // The server declares the run over for this session. seq 2: the control log and
    // controlFrames share one counter, so the end frame follows the start (seq 1).
    act(() => {
      view.rerender({
        controlEvents: logOf(turnState()),
        controlFrames: new Map([
          [SESSION_ID, { seq: 2, frame: { type: 'session-status', sessionId: SESSION_ID, isProcessing: false } }],
        ]) as any,
      });
    });

    expect(view.result.current.turnState).toBeNull();
    expect(view.result.current.canSteer).toBe(false);
    expect(view.result.current.events).toEqual([]);
  });

  /**
   * B-1449 (b) — a viewer of ANOTHER member's still-live run must keep seeing
   * the strip and keep being able to steer: `session-status{isProcessing:true}`
   * must NOT clear `turnState`. Guards against a naive "any session-status
   * clears it" implementation.
   */
  it('keeps turnState/canSteer while session-status still reports the run active (B-1449)', () => {
    const view = renderHook(
      ({ controlEvents, controlFrames }) =>
        useSessionSteer({
          sessionId: SESSION_ID,
          currentUserId: 2,
          latestMessage: null,
          controlEvents,
          controlFrames,
          sendMessage: vi.fn(),
        }),
      { initialProps: { controlEvents: EMPTY_LOG, controlFrames: new Map() as any } },
    );
    act(() => view.rerender({ controlEvents: logOf(turnState()), controlFrames: new Map() as any }));

    act(() => {
      view.rerender({
        controlEvents: logOf(turnState()),
        controlFrames: new Map([
          [SESSION_ID, { seq: 1, frame: { type: 'session-status', sessionId: SESSION_ID, isProcessing: true } }],
        ]) as any,
      });
    });

    expect(view.result.current.turnState?.turnId).toBe('t1');
    expect(view.result.current.canSteer).toBe(true);
  });

  /**
   * B-1449 — a session-status frame for a DIFFERENT session must not clear
   * this session's turnState (controlFrames is a global, per-session map).
   */
  it('ignores a session-status idle frame scoped to a different session (B-1449)', () => {
    const view = renderHook(
      ({ controlEvents, controlFrames }) =>
        useSessionSteer({
          sessionId: SESSION_ID,
          currentUserId: 2,
          latestMessage: null,
          controlEvents,
          controlFrames,
          sendMessage: vi.fn(),
        }),
      { initialProps: { controlEvents: EMPTY_LOG, controlFrames: new Map() as any } },
    );
    act(() => view.rerender({ controlEvents: logOf(turnState()), controlFrames: new Map() as any }));

    act(() => {
      view.rerender({
        controlEvents: logOf(turnState()),
        controlFrames: new Map([
          ['other-session', { seq: 1, frame: { type: 'session-status', sessionId: 'other-session', isProcessing: false } }],
        ]) as any,
      });
    });

    expect(view.result.current.turnState?.turnId).toBe('t1');
    expect(view.result.current.canSteer).toBe(true);
  });

  /**
   * B-1449 — switching sessions must still reset turnState (pre-existing
   * behaviour, re-asserted here alongside the new controlFrames signal so a
   * future change to the clearing effect cannot silently regress it).
   */
  it('still resets turnState on session switch (B-1449 regression guard)', () => {
    const view = renderHook(
      ({ sessionId, controlEvents }) =>
        useSessionSteer({ sessionId, currentUserId: 2, latestMessage: null, controlEvents, sendMessage: vi.fn() }),
      { initialProps: { sessionId: SESSION_ID, controlEvents: logOf(turnState()) } },
    );
    expect(view.result.current.turnState?.turnId).toBe('t1');

    act(() => view.rerender({ sessionId: 's2', controlEvents: EMPTY_LOG }));
    expect(view.result.current.turnState).toBeNull();
  });

  /**
   * B-1470 — `controlFrames` keeps the LATEST session-status per session, so
   * when a second turn starts it still holds the previous turn's
   * `isProcessing:false`. That stale frame must not clear the new turn state.
   * Real sequence captured live: [steer-turn-state t1 @6] [status false @7]
   * [steer-turn-state t2 @11] with no isProcessing:true in between.
   */
  function renderStarter(initialFrames: Map<string, { seq: number; frame: unknown }>) {
    return renderHook(
      ({ controlEvents, controlFrames }) =>
        useSessionSteer({
          sessionId: SESSION_ID,
          currentUserId: 1, // the starter (turnState().starterUserId === 1)
          latestMessage: null,
          controlEvents,
          controlFrames,
          sendMessage: vi.fn(),
        }),
      { initialProps: { controlEvents: EMPTY_LOG, controlFrames: initialFrames as any } },
    );
  }
  const idleAt = (seq: number) =>
    new Map([[SESSION_ID, { seq, frame: { type: 'session-status', sessionId: SESSION_ID, isProcessing: false } }]]);
  const logAt = (...entries: [number, unknown][]): ControlEventLogLike => ({
    events: entries.map(([seq, frame]) => ({ seq, frame })),
    droppedBeforeSeq: 0,
  });

  it('a stale run-over status from the previous turn does not clear a new turn (B-1470)', () => {
    const view = renderStarter(new Map());
    // Turn 1 starts, then ends.
    act(() => view.rerender({ controlEvents: logAt([6, turnState()]), controlFrames: new Map() as any }));
    act(() => view.rerender({ controlEvents: logAt([6, turnState()]), controlFrames: idleAt(7) as any }));
    expect(view.result.current.turnState).toBeNull();

    // Turn 2 starts; controlFrames still holds turn 1's run-over (seq 7).
    act(() =>
      view.rerender({
        controlEvents: logAt([6, turnState()], [11, turnState({ turnId: 't2' })]),
        controlFrames: idleAt(7) as any,
      }),
    );
    expect(view.result.current.turnState?.turnId).toBe('t2');
    expect(view.result.current.isStarter).toBe(true);
    // The starter can steer (this is what drives the T-1956 hint icon).
    expect(view.result.current.canSteer).toBe(true);
  });

  it('a run-over status that arrives after the new turn start clears it (B-1470)', () => {
    const view = renderStarter(idleAt(7));
    act(() =>
      view.rerender({ controlEvents: logAt([11, turnState({ turnId: 't2' })]), controlFrames: idleAt(7) as any }),
    );
    expect(view.result.current.canSteer).toBe(true);

    act(() =>
      view.rerender({ controlEvents: logAt([11, turnState({ turnId: 't2' })]), controlFrames: idleAt(12) as any }),
    );
    expect(view.result.current.turnState).toBeNull();
    expect(view.result.current.canSteer).toBe(false);
  });

  it('a reconnect re-announcing the run as over (new seq) still clears the turn (B-1449/B-1470)', () => {
    const view = renderStarter(new Map());
    act(() =>
      view.rerender({
        controlEvents: logAt([3, turnState()]),
        controlFrames: new Map([
          [SESSION_ID, { seq: 4, frame: { type: 'session-status', sessionId: SESSION_ID, isProcessing: true } }],
        ]) as any,
      }),
    );
    expect(view.result.current.canSteer).toBe(true);
    // Socket drops and reconnects; check-session-status yields a fresh frame.
    act(() => view.rerender({ controlEvents: logAt([3, turnState()]), controlFrames: idleAt(9) as any }));
    expect(view.result.current.turnState).toBeNull();
  });

  /**
   * B-1470 — live capture: after a normal turn end the client got the run's
   * `kind:'complete'` event but no session-status{isProcessing:false}, so the
   * strip and steer UI stayed up. The terminal event must end the turn.
   */
  const completeFor = (sessionId: string) => ({ kind: 'complete', sessionId, provider: 'claude' });

  it('the run\'s complete event after the turn start clears the turn (B-1470)', () => {
    const view = renderStarter(new Map());
    act(() => view.rerender({ controlEvents: logAt([11, turnState()]), controlFrames: idleAt(7) as any }));
    expect(view.result.current.canSteer).toBe(true);
    act(() =>
      view.rerender({ controlEvents: logAt([11, turnState()], [20, completeFor(SESSION_ID)]), controlFrames: idleAt(7) as any }),
    );
    expect(view.result.current.turnState).toBeNull();
    expect(view.result.current.canSteer).toBe(false);
  });

  it('a previous turn\'s complete event does not clear the next turn (B-1470)', () => {
    const view = renderStarter(new Map());
    act(() =>
      view.rerender({
        controlEvents: logAt([6, turnState()], [8, completeFor(SESSION_ID)], [11, turnState({ turnId: 't2' })]),
        controlFrames: new Map() as any,
      }),
    );
    expect(view.result.current.turnState?.turnId).toBe('t2');
    expect(view.result.current.canSteer).toBe(true);
  });

  it('a complete event for another session does not clear this turn (B-1470)', () => {
    const view = renderStarter(new Map());
    act(() =>
      view.rerender({ controlEvents: logAt([11, turnState()], [12, completeFor('other')]), controlFrames: new Map() as any }),
    );
    expect(view.result.current.turnState?.turnId).toBe('t1');
  });

  /**
   * B-1470 review (veto) — a rejected SEND attempt arrives as `kind:'error'`
   * for the same session while the turn keeps running; it must not end it.
   */
  const errorFor = (extra: Record<string, unknown>) => ({ kind: 'error', sessionId: SESSION_ID, provider: 'claude', ...extra });
  const liveTurnThen = (frame: unknown) => {
    const view = renderStarter(new Map());
    act(() => view.rerender({ controlEvents: logAt([5, turnState()]), controlFrames: new Map() as any }));
    act(() => view.rerender({ controlEvents: logAt([5, turnState()], [6, frame]), controlFrames: new Map() as any }));
    return view;
  };

  it('a session_busy error mid-turn does not clear the turn (B-1470 review)', () => {
    const view = liveTurnThen(errorFor({ code: 'session_busy' }));
    expect(view.result.current.turnState?.turnId).toBe('t1');
    expect(view.result.current.canSteer).toBe(true);
  });

  it('a notStarted error does not clear the turn, whatever its code', () => {
    const view = liveTurnThen(errorFor({ code: 'harness_update_pending', notStarted: true }));
    expect(view.result.current.turnState?.turnId).toBe('t1');
  });

  it('a steer_requires_session_steer error does not clear the turn', () => {
    const view = liveTurnThen(errorFor({ code: 'steer_requires_session_steer' }));
    expect(view.result.current.turnState?.turnId).toBe('t1');
  });

  it('a message_dispatch_unconfirmed error for the resumed session does not clear the turn', () => {
    const view = liveTurnThen({
      type: 'error', kind: 'error', code: 'message_dispatch_unconfirmed', error: 'The request could not be completed.',
      clientMsgId: 'c1', provider: 'claude', sessionId: SESSION_ID, deliveryDisposition: 'unknown',
      sameClientMsgIdRetryable: false,
    });
    expect(view.result.current.turnState?.turnId).toBe('t1');
  });

  it('a real terminal error after the turn start clears the turn', () => {
    const view = liveTurnThen(errorFor({ code: 'provider_failed', content: 'boom' }));
    expect(view.result.current.turnState).toBeNull();
    expect(view.result.current.canSteer).toBe(false);
  });

  it('a viewer (non-starter) who receives complete is cleared too', () => {
    const view = renderHook(
      ({ controlEvents }) =>
        useSessionSteer({ sessionId: SESSION_ID, currentUserId: 2, latestMessage: null, controlEvents, sendMessage: vi.fn() }),
      { initialProps: { controlEvents: logAt([5, turnState()]) } },
    );
    expect(view.result.current.isStarter).toBe(false);
    expect(view.result.current.canSteer).toBe(true);
    act(() => view.rerender({ controlEvents: logAt([5, turnState()], [9, completeFor(SESSION_ID)]) }));
    expect(view.result.current.turnState).toBeNull();
    expect(view.result.current.canSteer).toBe(false);
  });
});
