/**
 * B-1448 slice 2: when the owner closes every terminal to install an update,
 * the server sends `{type:'error', code:'update_terminals_closed'}` and then a
 * final close 4404 with reason `update_terminals_closed`. Both terminal clients
 * must (1) tell their user why, with `terminals.errors.closedForUpdate`, and
 * (2) not auto-reconnect: a re-attach would open a fresh PTY that holds the
 * update back again.
 *
 * Run: NODE_ENV=test npx vitest run src/components/shell/hooks/updateTerminalsClosed.test.tsx
 */
import { useRef } from 'react';
import type { MutableRefObject } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    write() {}
    clear() {}
    focus() {}
    dispose() {}
    open() {}
    loadAddon() {}
    getSelection() { return ''; }
    hasSelection() { return false; }
    attachCustomKeyEventHandler() {}
    registerCharacterJoiner() { return 1; }
    deregisterCharacterJoiner() {}
    onRender() { return { dispose() {} }; }
    onData() { return { dispose() {} }; }
  }
  return { Terminal };
});
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));

import { useTerminalConnection } from '../../terminals/hooks/useTerminalConnection';
import { classifyTerminalClose } from '../../terminals/utils/reconnect';

import { useShellConnection } from './useShellConnection';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const UPDATE_FRAME = {
  type: 'error',
  code: 'update_terminals_closed',
  message: 'The owner closed this terminal to install an update.',
};
const UPDATE_CLOSE = { code: 4404, reason: 'update_terminals_closed' };
const BEYOND_ANY_BACKOFF_MS = 60_000;

function ShellHarness({ sink }: { sink: { closedForUpdate: boolean } }) {
  const wsRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef({ write: () => {} }) as unknown as MutableRefObject<never>;
  const connection = useShellConnection({
    wsRef,
    terminalRef,
    fitAddonRef: useRef({ fit: () => {} }) as unknown as MutableRefObject<never>,
    selectedProjectRef: useRef({ name: 'p', path: '/p', fullPath: '/p' }) as never,
    selectedSessionRef: useRef(null) as never,
    initialCommandRef: useRef<string | null>(null),
    isPlainShellRef: useRef(false),
    onProcessCompleteRef: useRef(null),
    onShellErrorRef: useRef(() => {}),
    isInitialized: true,
    autoConnect: true,
    closeSocket: () => {},
    clearTerminalScreen: () => {},
    setAuthUrl: () => {},
  });
  sink.closedForUpdate = connection.closedForUpdate;
  return null;
}

function TerminalHarness({ sink }: { sink: { state: string } }) {
  const { terminalContainerRef, state } = useTerminalConnection({
    terminalId: 't-1',
    initialStatus: 'running',
    isActive: true,
    onRequestListRefresh: () => {},
  });
  sink.state = state;
  return <div ref={terminalContainerRef} />;
}

/** Deliver the server's sequence, then wait past every backoff. */
function closeForUpdate(socket: FakeWebSocket, { withFrame = true, withReason = true } = {}) {
  act(() => {
    if (withFrame) socket.emit(UPDATE_FRAME);
  });
  act(() => {
    socket.onclose?.(withReason ? UPDATE_CLOSE : { code: 4404 });
  });
  act(() => {
    vi.advanceTimersByTime(BEYOND_ANY_BACKOFF_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  window.localStorage.setItem('auth-token', 'test-token');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('standalone terminal closed for an update', () => {
  it('classifies 4404 + update_terminals_closed apart from an unknown terminal', () => {
    expect(classifyTerminalClose(4404, 'update_terminals_closed')).toBe('closedForUpdate');
    expect(classifyTerminalClose(4404)).toBe('notFound');
    expect(classifyTerminalClose(4404, 'something_else')).toBe('notFound');
    expect(classifyTerminalClose(1006, 'update_terminals_closed')).toBe('reconnect');
  });

  it.each([
    ['frame and close reason', { withFrame: true, withReason: true }],
    ['close reason alone', { withFrame: false, withReason: true }],
    ['frame alone (reason lost in transit)', { withFrame: true, withReason: false }],
  ])('ends in closedForUpdate and never re-attaches: %s', (_label, options) => {
    const sink = { state: '' };
    render(<TerminalHarness sink={sink} />);
    const socket = FakeWebSocket.instances.at(-1)!;
    const before = FakeWebSocket.instances.length;
    closeForUpdate(socket, options);
    expect(sink.state).toBe('closedForUpdate');
    expect(FakeWebSocket.instances.length).toBe(before);
  });

});

describe('Shell tab closed for an update', () => {
  it.each([
    ['frame and close reason', { withFrame: true, withReason: true }],
    ['close reason alone', { withFrame: false, withReason: true }],
  ])('raises closedForUpdate and never re-attaches: %s', (_label, options) => {
    const sink = { closedForUpdate: false };
    render(<ShellHarness sink={sink} />);
    const socket = FakeWebSocket.instances.at(-1)!;
    act(() => {
      socket.onopen?.();
    });
    const before = FakeWebSocket.instances.length;
    closeForUpdate(socket, options);
    expect(sink.closedForUpdate).toBe(true);
    expect(FakeWebSocket.instances.length).toBe(before);
  });

  it('an ordinary 4404 refusal is not reported as an update close', () => {
    const sink = { closedForUpdate: false };
    render(<ShellHarness sink={sink} />);
    const socket = FakeWebSocket.instances.at(-1)!;
    act(() => {
      socket.emit({ type: 'error', code: 'project_not_visible', message: 'no' });
      socket.onclose?.({ code: 4404, reason: 'project_not_visible' });
    });
    expect(sink.closedForUpdate).toBe(false);
  });
});
