/**
 * T-2093 (ADR-TURN-SCOPED-CONTROL) — the `control-command-receipt` frame goes
 * to its own slice (`controlReceipts`, keyed by commandId), never through the
 * single-slot `latestMessage`: a receipt arriving right after the stopped
 * turn's `complete` must not clobber it. Receipts acknowledge the control
 * outbox; a reconnect resends what is still pending.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

vi.mock('../components/auth/context/AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

import {
  resetControlCommandState,
  resolveStopTarget,
  submitControlCommand,
} from '../components/chat/utils/controlCommandOutbox';

import { useWebSocket, WebSocketProvider, type ControlFrameMap } from './WebSocketContext';

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void { this.sent.push(data); }
  close(): void { /* no-op */ }
}

function deliver(socket: FakeWebSocket, payload: unknown): void {
  socket.onmessage?.({ data: JSON.stringify(payload) });
}

let seen: { latestMessage: any; controlReceipts: ControlFrameMap } = {
  latestMessage: null,
  controlReceipts: new Map(),
};

function Probe() {
  const { latestMessage, controlReceipts } = useWebSocket();
  seen = { latestMessage, controlReceipts };
  return null;
}

function mountProvider(): FakeWebSocket {
  render(<WebSocketProvider><Probe /></WebSocketProvider>);
  const socket = FakeWebSocket.instances.at(-1)!;
  act(() => { socket.onopen?.(); });
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  resetControlCommandState();
  (globalThis as any).WebSocket = FakeWebSocket;
  localStorage.setItem('auth-token', 'test-token');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const RECEIPT = {
  type: 'control-command-receipt', commandId: 'stop-1', kind: 'abort', status: 'stopped', duplicate: false,
  result: { sessionId: 's1', provider: 'claude' },
};

describe('control-command-receipt routing', () => {
  it('a receipt in the same batch as `complete` does not clobber latestMessage', () => {
    const socket = mountProvider();
    act(() => {
      deliver(socket, { kind: 'complete', aborted: true, success: true, sessionId: 's1', provider: 'claude' });
      deliver(socket, RECEIPT);
    });
    assert.equal(seen.latestMessage?.kind, 'complete');
    assert.equal(seen.controlReceipts.get('stop-1')?.frame.status, 'stopped');
  });

  it('two receipts in one batch are both kept (keyed by commandId)', () => {
    const socket = mountProvider();
    act(() => {
      deliver(socket, RECEIPT);
      deliver(socket, { ...RECEIPT, commandId: 'ap-1', kind: 'approval', status: 'applied', result: { requestId: 'r' } });
    });
    assert.deepEqual([...seen.controlReceipts.keys()].sort(), ['ap-1', 'stop-1']);
  });

  it('run frames teach the client the turnKey of each session', () => {
    const socket = mountProvider();
    act(() => { deliver(socket, { kind: 'text', role: 'assistant', sessionId: 's7', turnKey: 'turn-7', content: 'x' }); });
    assert.equal(resolveStopTarget('s7'), 'turn-7');
  });

  it('a reconnect resends a pending command with the same commandId; its receipt clears it', () => {
    const first = mountProvider();
    const payload = { type: 'abort-session', sessionId: 's1', provider: 'claude', commandId: 'stop-1', targetTurnKey: 'k' };
    submitControlCommand(payload, () => ({ ok: false, reason: 'disconnected' }));
    act(() => { first.onclose?.({ code: 1006, reason: '', wasClean: false }); });
    act(() => { vi.advanceTimersByTime(5_000); });
    const second = FakeWebSocket.instances.at(-1)!;
    assert.notEqual(second, first);
    act(() => { second.onopen?.(); });
    assert.deepEqual(second.sent.map((raw) => JSON.parse(raw)), [payload]);
    act(() => { deliver(second, { ...RECEIPT, duplicate: true }); });
    act(() => { second.onclose?.({ code: 1006, reason: '', wasClean: false }); });
    act(() => { vi.advanceTimersByTime(5_000); });
    const third = FakeWebSocket.instances.at(-1)!;
    act(() => { third.onopen?.(); });
    assert.deepEqual(third.sent, [], 'an acknowledged command is never resent');
  });
});
