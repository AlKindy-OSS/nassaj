// ADR-H20 N6: after a sign-out, a socket that closes must never start a
// token-less reconnect loop (every such dial was refused at the upgrade).
import type { ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../components/auth/bearerRevocation', () => ({ resolveBearerRevocation: async () => 'signed_out' }));
const token = `h.${btoa(JSON.stringify({ userId: 7, pwd_iat: 1 })).replace(/=+$/, '')}.s`;
const authState = vi.hoisted(() => ({ token: null as string | null, user: null as { id: number; username: string } | null }));
vi.mock('../components/auth/context/AuthContext', () => ({ useAuth: () => authState }));

import { WebSocketProvider } from './WebSocketContext';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send() {}
  close() {}
}

const Wrapper = ({ children }: { children?: ReactNode }) => <WebSocketProvider>{children}</WebSocketProvider>;

beforeEach(() => {
  FakeSocket.instances = [];
  authState.token = token;
  authState.user = { id: 7, username: 'member' };
  localStorage.setItem('auth-token', token);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WebSocketProvider after sign-out (ADR-H20 N6)', () => {
  it('a close after the sign-out schedules no token-less redial', async () => {
    const view = render(<Wrapper />);
    expect(FakeSocket.instances).toHaveLength(1);
    const socket = FakeSocket.instances[0];
    await act(async () => { socket.onopen?.(); });
    authState.token = null;
    authState.user = null;
    localStorage.removeItem('auth-token');
    view.rerender(<Wrapper />);
    await act(async () => {
      socket.onclose?.({ code: 1006, reason: '', wasClean: false });
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('while signed in, an abnormal close still redials with the token', async () => {
    render(<Wrapper />);
    const socket = FakeSocket.instances[0];
    await act(async () => { socket.onopen?.(); });
    await act(async () => {
      socket.onclose?.({ code: 1006, reason: '', wasClean: false });
      vi.advanceTimersByTime(60_000);
    });
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
    expect(FakeSocket.instances.at(-1)!.url).toContain('token=');
  });

  it('N2 withdrawn: a legacy owner_step_up_required frame opens no prompt', async () => {
    render(<Wrapper />);
    const socket = FakeSocket.instances[0];
    const onStepUp = vi.fn();
    window.addEventListener('auth:owner-step-up-required', onStepUp);
    try {
      await act(async () => {
        socket.onopen?.();
        socket.onmessage?.({ data: JSON.stringify({ kind: 'complete', code: 'owner_step_up_required', sessionId: '' }) });
      });
    } finally {
      window.removeEventListener('auth:owner-step-up-required', onStepUp);
    }
    expect(onStepUp).not.toHaveBeenCalled();
  });
});
