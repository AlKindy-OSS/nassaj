import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

/**
 * B-332 regression: the presence strip vanished after visiting the Terminals
 * section and coming back.
 *
 * Cause: the panel is unmounted by the section switch, and the server sends a
 * `presence` snapshot only when presence CHANGES — never on a timer. So the
 * remounted hook started from an empty list and stayed empty until some brother
 * happened to connect or disconnect. The fix seeds the state from the last
 * snapshot any consumer observed.
 *
 * The test mounts, feeds one snapshot, unmounts, then remounts with the
 * websocket sitting on an unrelated later message — the representative shape
 * seen when the user switches back.
 */

const latestMessage = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({ latestMessage: latestMessage.current }),
}));

const { usePresence } = await import('./usePresence');

const SNAPSHOT = {
  type: 'presence',
  users: [
    {
      userId: '1',
      username: 'ibrahim',
      active: true,
      activeSessionId: 'abc',
      activeProjectPath: '/workspace/sample-project',
      provider: 'claude',
      since: 1,
    },
  ],
  activeConversations: { total: 2, byProject: [], hiddenCount: 2 },
};

describe('usePresence across a remount (B-332)', () => {
  it('keeps the last snapshot when the consumer remounts with no new presence message', () => {
    latestMessage.current = SNAPSHOT;
    const first = renderHook(() => usePresence());
    expect(first.result.current.users).toHaveLength(1);
    first.unmount();

    // The stream moved on to something else entirely while the user was in the
    // Terminals section; no further presence frame is coming.
    latestMessage.current = { type: 'process_state', sessionId: 'abc' };

    const second = renderHook(() => usePresence());
    expect(second.result.current.users).toHaveLength(1);
    expect(second.result.current.users[0].username).toBe('ibrahim');
    expect(second.result.current.activeConversations?.total).toBe(2);
    second.unmount();
  });
});
