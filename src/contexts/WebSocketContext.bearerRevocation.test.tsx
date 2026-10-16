// T-2035: a 4401 close of a BEARER socket (sign-out on another device bumped
// the token epoch) must reach the login screen — not the wallet reconcile
// path, which a bearer tab cannot complete — and must never loop redials.
import type { ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const outcome = vi.hoisted(() => ({ next: 'signed_out' as 'signed_out' | 'reconnect' | 'stay_disconnected', calls: 0 }));
vi.mock('../components/auth/bearerRevocation', () => ({
  resolveBearerRevocation: async () => { outcome.calls += 1; return outcome.next; },
}));
const barrier = vi.hoisted(() => ({ reconciled: 0 }));
vi.mock('../components/auth/accountIdentityBarrier', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../components/auth/accountIdentityBarrier')>()),
  reconcileRevokedIdentity: () => { barrier.reconciled += 1; },
}));
const token = `h.${btoa(JSON.stringify({ userId: 7, pwd_iat: 1 })).replace(/=+$/, '')}.s`;
vi.mock('../components/auth/context/AuthContext', () => ({
  useAuth: () => ({ token, user: { id: 7, username: 'member' } }),
}));

import { WebSocketProvider } from './WebSocketContext';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send() {}
  close() {}
}

const Wrapper = ({ children }: { children?: ReactNode }) => <WebSocketProvider>{children}</WebSocketProvider>;

async function closeWith4401() {
  const socket = FakeSocket.instances.at(-1)!;
  await act(async () => { socket.onopen?.(); });
  await act(async () => {
    socket.onclose?.({ code: 4401, reason: 'identity_revoked', wasClean: true });
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  FakeSocket.instances = [];
  outcome.calls = 0;
  barrier.reconciled = 0;
  localStorage.setItem('auth-token', token);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WebSocketProvider bearer 4401 (T-2035)', () => {
  it('a dead token goes to sign-in: no redial and no wallet reconcile', async () => {
    outcome.next = 'signed_out';
    render(<Wrapper />);
    expect(FakeSocket.instances).toHaveLength(1);
    await closeWith4401();
    expect(outcome.calls).toBe(1);
    expect(barrier.reconciled).toBe(0);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('a still-valid token redials exactly once', async () => {
    outcome.next = 'reconnect';
    render(<Wrapper />);
    await closeWith4401();
    expect(FakeSocket.instances).toHaveLength(2);
  });
});
