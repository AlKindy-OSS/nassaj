/**
 * T-2037 [qa critical-1] — a composer one-shot must never be re-executed
 * without a fresh, confirmed submit. Every init of a one-shot shell carries the
 * SAME runId and never forceRestart, across: first connect, abnormal-drop
 * reconnect (1006), remount, and an explicit connect/restart request. After a
 * finished frame or any refusal code the hook does not reconnect at all.
 *
 * Run: NODE_ENV=test npx vitest run src/components/shell/hooks/useShellConnection.oneShot.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

import type { OneShotFrame } from '../types/types';
import { TERMINAL_INIT_DELAY_MS } from '../constants/constants';
import { ONESHOT_REFUSAL_CODES } from '../utils/reconnect';

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
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

type Api = { connectToShell: (options?: { forceRestart?: boolean }) => void };

function Harness({
  runId,
  frames,
  api,
  claim,
}: {
  runId: string;
  frames: OneShotFrame[];
  api: { current: Api | null };
  claim: (runId: string) => boolean;
}) {
  const wsRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef({ write: () => {}, cols: 80, rows: 24 }) as unknown as MutableRefObject<never>;
  const fitAddonRef = useRef({ fit: () => {} }) as unknown as MutableRefObject<never>;
  const selectedProjectRef = useRef({ name: 'p', path: '/p', fullPath: '/p' }) as never;
  const selectedSessionRef = useRef(null) as never;
  const initialCommandRef = useRef<string | null>('ls -la');
  const isPlainShellRef = useRef(true);
  const onProcessCompleteRef = useRef(null);
  const oneShotRunIdRef = useRef<string | null>(runId);
  const onOneShotFrameRef = useRef((frame: OneShotFrame) => {
    frames.push(frame);
  });
  const claimOneShotLaunchRef = useRef(claim);

  const connection = useShellConnection({
    wsRef,
    terminalRef,
    fitAddonRef,
    selectedProjectRef,
    selectedSessionRef,
    initialCommandRef,
    isPlainShellRef,
    onProcessCompleteRef,
    oneShotRunIdRef,
    onOneShotFrameRef,
    claimOneShotLaunchRef,
    isInitialized: true,
    autoConnect: true,
    closeSocket: () => {
      const socket = wsRef.current;
      wsRef.current = null;
      socket?.close();
    },
    clearTerminalScreen: () => {},
    setAuthUrl: () => {},
  });

  useEffect(() => {
    api.current = connection;
  });

  return null;
}

type InitFrame = {
  type: 'init';
  runId?: string;
  forceRestart?: boolean;
  isPlainShell?: boolean;
  initialCommand?: string;
  attachOnly?: boolean;
};

/** A launch grant like the store's: true once per runId, per test. */
let granted = new Set<string>();
const claimOnce = (runId: string) => {
  if (granted.has(runId)) return false;
  granted.add(runId);
  return true;
};

/** Every init frame sent on every socket, in order. */
function initFrames(): InitFrame[] {
  return FakeWebSocket.instances
    .flatMap((socket) => socket.sent)
    .map((payload) => JSON.parse(payload) as InitFrame)
    .filter((frame) => frame.type === 'init');
}

function open(socket: FakeWebSocket) {
  act(() => {
    socket.onopen?.();
  });
  act(() => {
    vi.advanceTimersByTime(TERMINAL_INIT_DELAY_MS + 1);
  });
}

function mount(runId = 'run-1', claim: (runId: string) => boolean = claimOnce) {
  const frames: OneShotFrame[] = [];
  const api: { current: Api | null } = { current: null };
  const view = render(<Harness runId={runId} frames={frames} api={api} claim={claim} />);
  const socket = FakeWebSocket.instances.at(-1)!;
  open(socket);
  return { frames, api, socket, view };
}

beforeEach(() => {
  granted = new Set();
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  window.localStorage.setItem('auth-token', 'test-token');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('useShellConnection — one-shot runs (T-2037)', () => {
  it('sends the runId as a plain-shell init without forceRestart', () => {
    mount();
    expect(initFrames()).toEqual([
      expect.objectContaining({
        type: 'init',
        runId: 'run-1',
        origin: 'composer_shell',
        isPlainShell: true,
        provider: 'plain-shell',
        hasSession: false,
      }),
    ]);
    expect(initFrames()[0]).not.toHaveProperty('forceRestart');
    expect(initFrames()[0]).toEqual(expect.objectContaining({ initialCommand: 'ls -la' }));
    expect(initFrames()[0]).not.toHaveProperty('attachOnly');
  });

  it('[qa critical-1] a restored run (no launch grant) sends attach-only, never the command', () => {
    mount('run-restored', () => false);
    expect(initFrames()).toHaveLength(1);
    expect(initFrames()[0]).toEqual(expect.objectContaining({ runId: 'run-restored', attachOnly: true }));
    expect(initFrames()[0]).not.toHaveProperty('initialCommand');
  });

  it('a 1006 drop re-attaches with the SAME runId, never a new one', () => {
    const { socket } = mount();
    act(() => {
      socket.onclose?.({ code: 1006 });
    });
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    const second = FakeWebSocket.instances.at(-1)!;
    expect(second).not.toBe(socket);
    open(second);
    const inits = initFrames();
    expect(inits).toHaveLength(2);
    expect(inits.every((frame) => frame.runId === 'run-1' && !frame.forceRestart)).toBe(true);
    // [qa critical-1] the reconnect is attach-only and carries no command.
    expect(inits[1].attachOnly).toBe(true);
    expect(inits[1]).not.toHaveProperty('initialCommand');
  });

  it('a remount re-sends the same runId (re-attach), not a new run', () => {
    const { view } = mount();
    view.unmount();
    mount('run-1');
    const inits = initFrames();
    expect(inits).toHaveLength(2);
    expect(new Set(inits.map((frame) => frame.runId))).toEqual(new Set(['run-1']));
    expect(inits[1]).toEqual(expect.objectContaining({ attachOnly: true }));
    expect(inits[1]).not.toHaveProperty('initialCommand');
  });

  it('an explicit connect asking for forceRestart still only re-attaches', () => {
    const { socket, api } = mount();
    act(() => {
      socket.onclose?.({ code: 1006 });
    });
    // The user presses Connect before the backoff fires.
    act(() => {
      api.current?.connectToShell({ forceRestart: true });
    });
    open(FakeWebSocket.instances.at(-1)!);
    const inits = initFrames();
    expect(inits.at(-1)).toEqual(expect.objectContaining({ runId: 'run-1' }));
    expect(inits.some((frame) => frame.forceRestart)).toBe(false);
    expect(inits.filter((frame) => 'initialCommand' in frame)).toHaveLength(1);
  });

  it('forwards oneshot_finished and never reconnects after it', () => {
    const { socket, frames, api } = mount();
    act(() => {
      socket.emit({ type: 'oneshot_finished', runId: 'run-1', exitCode: 0 });
    });
    expect(frames).toEqual([{ type: 'oneshot_finished', runId: 'run-1', exitCode: 0 }]);
    act(() => {
      socket.onclose?.({ code: 1006 });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    act(() => {
      api.current?.connectToShell();
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(initFrames()).toHaveLength(1);
  });

  it('an interrupted/unknown finish (exitCode null) is final too', () => {
    const { socket, frames } = mount();
    act(() => {
      socket.emit({ type: 'oneshot_finished', runId: 'run-1', exitCode: null, interrupted: true });
    });
    expect(frames).toEqual([{ type: 'oneshot_finished', runId: 'run-1', exitCode: null, interrupted: true }]);
    act(() => {
      socket.onclose?.({ code: 1001 });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('ignores one-shot frames that belong to another run', () => {
    const { socket, frames } = mount();
    act(() => {
      socket.emit({ type: 'oneshot_finished', runId: 'other', exitCode: 0 });
    });
    expect(frames).toEqual([]);
  });

  it('forwards a capture frame for its run', () => {
    const { socket, frames } = mount();
    act(() => {
      socket.emit({ type: 'oneshot_capture', runId: 'run-1', text: 'a\n', truncated: true, exitCode: 2 });
    });
    expect(frames).toEqual([
      { type: 'oneshot_capture', runId: 'run-1', text: 'a\n', truncated: true, exitCode: 2 },
    ]);
  });

  it('matches the runId case-insensitively (the server lowercases it)', () => {
    const { socket, frames } = mount('ABC-run');
    act(() => {
      socket.emit({ type: 'oneshot_finished', runId: 'abc-run', exitCode: null });
    });
    expect(frames).toEqual([{ type: 'oneshot_finished', runId: 'ABC-run', exitCode: null }]);
  });

  it('oneshot_capture_unavailable is not a refusal: socket stays, a 1006 still re-attaches', () => {
    const { socket, frames } = mount();
    act(() => {
      socket.emit({ type: 'error', code: 'oneshot_capture_unavailable', runId: 'run-1' });
    });
    expect(frames).toEqual([{ type: 'oneshot_capture_unavailable', runId: 'run-1' }]);
    act(() => {
      socket.onclose?.({ code: 1006 });
    });
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it.each([...ONESHOT_REFUSAL_CODES, 'denied_command:pm2_lifecycle', 'some_future_brake', ''])(
    'refusal %s is final: no reconnect on 4403 or even on 1006',
    (code) => {
      const { socket } = mount();
      act(() => {
        socket.emit({ type: 'error', message: 'refused', code });
      });
      act(() => {
        socket.onclose?.({ code: 1006 });
      });
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(initFrames()).toHaveLength(1);
    },
  );
});
