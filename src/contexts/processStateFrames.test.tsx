/** Regression coverage for synchronous WS → process-state-store delivery. */

import assert from 'node:assert/strict';

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import {
  getSessionProcessState,
  isSessionProcessStateAuthoritative,
  resetSessionProcessStates,
} from '../stores/sessionProcessStateStore';
import { applyOutcomeSnapshot, useSessionOutcome } from '../stores/sessionCompletionStore';

import { useWebSocket, WebSocketProvider } from './WebSocketContext';

let authToken = 'test-token';
vi.mock('../components/auth/context/AuthContext', () => ({
  useAuth: () => ({ token: authToken }),
}));

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  readyState = FakeWebSocket.OPEN;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(): void { /* no-op */ }
  close(): void { /* no-op */ }
}

function deliver(socket: FakeWebSocket, payload: unknown): void {
  socket.onmessage?.({ data: JSON.stringify(payload) });
}

let latestMessage: any = null;
let outcome: string | null = null;

function Probe() {
  latestMessage = useWebSocket().latestMessage;
  outcome = useSessionOutcome('unopened-session');
  return null;
}

function mountProvider(): { socket: FakeWebSocket; rerender: (ui: React.ReactNode) => void } {
  const mounted = render(
    <WebSocketProvider>
      <Probe />
    </WebSocketProvider>,
  );
  const socket = FakeWebSocket.instances.at(-1)!;
  act(() => { socket.onopen?.(); });
  return { socket, rerender: mounted.rerender };
}

afterEach(cleanup);

beforeEach(() => {
  FakeWebSocket.instances = [];
  authToken = 'test-token';
  latestMessage = null;
  outcome = null;
  resetSessionProcessStates();
  applyOutcomeSnapshot([]);
  (globalThis as any).WebSocket = FakeWebSocket;
  localStorage.setItem('auth-token', 'test-token');
});

describe('synchronous process-state WebSocket delivery', () => {
  it('applies process_state before a same-batch stream_delta can replace latestMessage', () => {
    const { socket } = mountProvider();

    act(() => {
      deliver(socket, {
        kind: 'status', text: 'process_state', sessionId: 'A', processState: 'running',
      });
      deliver(socket, { kind: 'stream_delta', sessionId: 'A', content: 'مرحبا' });
    });

    assert.equal(latestMessage?.kind, 'stream_delta', 'latestMessage compatibility changed');
    assert.equal(getSessionProcessState('A'), 'running');
  });

  it('applies presence.runningSessions before a same-batch stream_delta', () => {
    const { socket } = mountProvider();

    act(() => {
      deliver(socket, {
        type: 'presence',
        runningSessions: [{ sessionId: 'B', state: 'frozen' }],
      });
      deliver(socket, { kind: 'stream_delta', sessionId: 'B', content: 'لاحق' });
    });

    assert.equal(getSessionProcessState('B'), 'frozen');
  });

  it('keeps an unopened conversation outcome when a following stream frame replaces latestMessage', () => {
    const { socket } = mountProvider();

    act(() => {
      deliver(socket, {
        type: 'session_outcome',
        sessionId: 'unopened-session',
        outcome: 'done',
        outcomeAt: '2026-09-03T12:00:00.000Z',
        outcomeState: 'visible',
      });
      deliver(socket, { kind: 'stream_delta', sessionId: 'another-session', content: 'لاحق' });
    });

    assert.equal(latestMessage?.kind, 'stream_delta', 'compatibility slot was overwritten');
    assert.equal(outcome, 'done', 'sidebar state did not require opening the conversation');
  });

  it('complete/error clear state even when stream_delta follows immediately', () => {
    const { socket } = mountProvider();
    act(() => {
      deliver(socket, {
        kind: 'status', text: 'process_state', sessionId: 'A', processState: 'running',
      });
      deliver(socket, { kind: 'complete', sessionId: 'A' });
      deliver(socket, { kind: 'stream_delta', sessionId: 'A', content: 'متأخر' });
    });

    assert.equal(getSessionProcessState('A'), null);
    assert.equal(latestMessage?.kind, 'stream_delta');
  });

  it('ignores malformed presence entries without poisoning valid ones', () => {
    const { socket } = mountProvider();
    act(() => {
      deliver(socket, {
        type: 'presence',
        runningSessions: [
          null,
          { sessionId: '', state: 'running' },
          { sessionId: 'bad-state', state: 'idle' },
          { sessionId: 'valid', state: 'running' },
        ],
      });
    });

    assert.equal(getSessionProcessState('valid'), 'running');
    assert.equal(getSessionProcessState('bad-state'), null);
  });

  it('preserves state across reconnect traffic and clears it on identity change', () => {
    const { socket, rerender } = mountProvider();
    act(() => {
      deliver(socket, {
        kind: 'status', text: 'process_state', sessionId: 'A', processState: 'running',
      });
      deliver(socket, { type: 'websocket-reconnected' });
    });
    assert.equal(getSessionProcessState('A'), 'running', 'reconnect cleared live state');

    authToken = 'different-identity-token';
    act(() => {
      rerender(
        <WebSocketProvider>
          <Probe />
        </WebSocketProvider>,
      );
    });

    assert.equal(getSessionProcessState('A'), null, 'identity switch leaked prior state');
  });

  it('preserves a running state across an actual close/backoff reconnect', () => {
    vi.useFakeTimers();
    const { socket } = mountProvider();
    act(() => {
      deliver(socket, {
        kind: 'status', text: 'process_state', sessionId: 'A', processState: 'running',
      });
      socket.onclose?.({ code: 1006, reason: '', wasClean: false });
    });
    assert.equal(getSessionProcessState('A'), 'running', 'network close was mistaken for idle');
    assert.equal(isSessionProcessStateAuthoritative('A'), false, 'closed epoch stayed authoritative');

    act(() => { vi.runOnlyPendingTimers(); });
    const reconnected = FakeWebSocket.instances.at(-1)!;
    assert.notEqual(reconnected, socket, 'backoff did not create a replacement socket');
    act(() => { reconnected.onopen?.(); });

    assert.equal(getSessionProcessState('A'), 'running', 'same-identity reconnect cleared live state');
    assert.equal(
      isSessionProcessStateAuthoritative('A'),
      false,
      'onopen granted authority before a per-session status',
    );
    vi.useRealTimers();
  });

  it('session-status active/idle grants per-session authority in the current epoch', () => {
    const { socket } = mountProvider();
    act(() => deliver(socket, {
      type: 'session-status', sessionId: 'A', isProcessing: true,
    }));
    assert.equal(getSessionProcessState('A'), 'running');
    assert.equal(isSessionProcessStateAuthoritative('A'), true);
    assert.equal(isSessionProcessStateAuthoritative('B'), false, 'A granted authority to B');

    act(() => deliver(socket, {
      type: 'session-status', sessionId: 'A', isProcessing: false,
    }));
    assert.equal(getSessionProcessState('A'), null);
    assert.equal(isSessionProcessStateAuthoritative('A'), true, 'idle lost its verdict authority');
  });

  it('offline run end clears a preserved running hint after reconnect status', () => {
    vi.useFakeTimers();
    const { socket } = mountProvider();
    act(() => {
      deliver(socket, {
        kind: 'status', text: 'process_state', sessionId: 'A', processState: 'running',
      });
      socket.onclose?.({ code: 1006, reason: '', wasClean: false });
      vi.runOnlyPendingTimers();
    });
    const reopened = FakeWebSocket.instances.at(-1)!;
    act(() => {
      reopened.onopen?.();
      deliver(reopened, { type: 'session-status', sessionId: 'A', isProcessing: false });
    });
    assert.equal(getSessionProcessState('A'), null, 'offline completion left stale running');
    assert.equal(isSessionProcessStateAuthoritative('A'), true);
    vi.useRealTimers();
  });

  it('reload starts unknown until the reloaded socket receives status', () => {
    const first = mountProvider().socket;
    act(() => deliver(first, {
      kind: 'status', text: 'process_state', sessionId: 'A', processState: 'running',
    }));
    cleanup();
    assert.equal(getSessionProcessState('A'), 'running');

    const second = mountProvider().socket;
    assert.equal(getSessionProcessState('A'), null, 'identity remount leaked the old live hint');
    assert.equal(isSessionProcessStateAuthoritative('A'), false);
    act(() => deliver(second, {
      type: 'session-status', sessionId: 'A', isProcessing: true,
    }));
    assert.equal(getSessionProcessState('A'), 'running');
    assert.equal(isSessionProcessStateAuthoritative('A'), true);
  });

  it('rapid reconnect rejects a status from an older socket epoch', () => {
    vi.useFakeTimers();
    const { socket: first } = mountProvider();
    act(() => {
      first.onclose?.({ code: 1006, reason: '', wasClean: false });
      vi.runOnlyPendingTimers();
    });
    const second = FakeWebSocket.instances.at(-1)!;
    act(() => {
      second.onclose?.({ code: 1006, reason: '', wasClean: false });
      vi.runOnlyPendingTimers();
    });
    const third = FakeWebSocket.instances.at(-1)!;
    act(() => third.onopen?.());

    act(() => deliver(second, {
      type: 'session-status', sessionId: 'A', isProcessing: false,
    }));
    assert.equal(isSessionProcessStateAuthoritative('A'), false, 'old epoch granted authority');

    act(() => deliver(third, {
      type: 'session-status', sessionId: 'A', isProcessing: true,
    }));
    assert.equal(getSessionProcessState('A'), 'running');
    assert.equal(isSessionProcessStateAuthoritative('A'), true);
    vi.useRealTimers();
  });
});
