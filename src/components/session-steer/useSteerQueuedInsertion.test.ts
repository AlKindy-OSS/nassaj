import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SteerEvent } from '../../../shared/session-steer.contract';

import type { TrackedSteerInjection } from './steerDuplicateDetection';
import { useSessionSteer, type ControlEventLogLike } from './useSessionSteer';
import {
  claimSteerInsertion,
  resetSteerInsertionsForTests,
  useSteerQueuedInsertion,
} from './useSteerQueuedInsertion';

const SESSION_ID = 's1';

const queued: SteerEvent = {
  type: 'steer-queued',
  sessionId: SESSION_ID,
  turnId: 't1',
  clientMsgId: 'steer-a',
  sender: { userId: 1, displayName: 'Nawras' },
  starterUserId: 1,
  deliveryStatus: 'queued',
  text: 'خليه مباشرة، بلاش 12 ساعه',
};

/**
 * The incident's control log: the steered run is still live (background agents
 * pending, so no `complete`), and the log keeps its `steer-queued` entry.
 */
const LIVE_RUN_LOG: ControlEventLogLike = {
  events: [
    {
      seq: 1,
      frame: {
        type: 'steer-turn-state', sessionId: SESSION_ID, turnId: 't1', starterUserId: 1,
        steerable: true, starterSteerable: true, capability: { midTurnInjection: true },
      },
    },
    { seq: 2, frame: queued },
    { seq: 3, frame: { ...queued, type: 'steer-delivered', deliveryStatus: 'delivered', text: undefined } },
  ],
  droppedBeforeSeq: 0,
};

/** ChatInterface's composition: useSessionSteer feeds the insertion hook. */
function useChatSteerBubbles(addMessage: (m: unknown) => void, tracked: Map<string, TrackedSteerInjection>) {
  const { events } = useSessionSteer({
    sessionId: SESSION_ID,
    currentUserId: 1,
    latestMessage: null,
    controlEvents: LIVE_RUN_LOG,
    sendMessage: () => ({ ok: true }),
  });
  useSteerQueuedInsertion({ events, sessionId: SESSION_ID, addMessage, trackedInjections: tracked });
}

describe('useSteerQueuedInsertion', () => {
  afterEach(() => resetSteerInsertionsForTests());

  it('inserts a queued steer once', () => {
    const addMessage = vi.fn();
    renderHook(() => useChatSteerBubbles(addMessage, new Map()));
    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(addMessage.mock.calls[0][0]).toMatchObject({
      injected: true, deliveryStatus: 'queued', steerClientMsgId: 'steer-a',
    });
  });

  it('does not re-insert the steer when the chat remounts and replays the log', () => {
    const addMessage = vi.fn();
    const first = renderHook(() => useChatSteerBubbles(addMessage, new Map()));
    first.unmount();
    // A remount: fresh component state, same app-lifetime control log.
    renderHook(() => useChatSteerBubbles(addMessage, new Map()));
    expect(addMessage).toHaveBeenCalledTimes(1);
  });

  it('skips events that are not a queued steer with text', () => {
    const addMessage = vi.fn();
    const events: SteerEvent[] = [
      { ...queued, type: 'steer-delivered', clientMsgId: 'steer-b' },
      { ...queued, clientMsgId: 'steer-c', text: undefined },
    ];
    renderHook(() => useSteerQueuedInsertion({
      events, sessionId: SESSION_ID, addMessage, trackedInjections: new Map(),
    }));
    expect(addMessage).not.toHaveBeenCalled();
  });

  it('records the inserted steer for live-echo duplicate detection', () => {
    const tracked = new Map<string, TrackedSteerInjection>();
    renderHook(() => useSteerQueuedInsertion({
      events: [queued], sessionId: SESSION_ID, addMessage: vi.fn(), trackedInjections: tracked,
    }));
    expect(tracked.get('steer-a')).toMatchObject({ text: queued.text, sessionId: SESSION_ID });
  });

  it('keeps the registry bounded, forgetting the oldest id first', () => {
    for (let i = 0; i <= 512; i += 1) claimSteerInsertion(`id-${i}`);
    expect(claimSteerInsertion('id-0')).toBe(true);
    expect(claimSteerInsertion('id-512')).toBe(false);
  });
});
