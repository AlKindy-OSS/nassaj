import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { internalSessionChatSocketUrl, useInternalSessionChatRealtime } from './useInternalSessionChatRealtime';

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  close() { this.closed = true; }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });

const mount = (enabled: boolean) => renderHook(() => useInternalSessionChatRealtime({
  sessionId: 's1', enabled, onFrame: () => {}, onSnapshot: () => {},
}));

describe('internal session chat transport', () => {
  it('uses its own room endpoint with the stored token, never the provider socket', () => {
    const url = internalSessionChatSocketUrl('جلسة/a', 'jwt');
    expect(url).toContain('/internal-session-chat?sessionId=%D8%AC%D9%84%D8%B3%D8%A9%2Fa&token=jwt');
    expect(url).not.toContain('/ws');
  });

  it('connects without a token param in cookie mode (no stored token)', () => {
    expect(internalSessionChatSocketUrl('s1', null)).toMatch(/\/internal-session-chat\?sessionId=s1$/);
  });

  it('reads the freshest stored token on every connect', () => {
    localStorage.setItem('auth-token', 'rotated');
    expect(internalSessionChatSocketUrl('s1')).toContain('&token=rotated');
  });

  it('opens no socket while the caller holds no room', () => {
    mount(false);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('stops reconnecting after a terminal 4404 close', () => {
    mount(true);
    expect(FakeSocket.instances).toHaveLength(1);
    FakeSocket.instances[0].onclose?.({ code: 4404 });
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('reconnects with backoff after a transient drop', () => {
    mount(true);
    FakeSocket.instances[0].onclose?.({ code: 1006 });
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('closes the socket and cancels retries on unmount', () => {
    const hook = mount(true);
    hook.unmount();
    expect(FakeSocket.instances[0].closed).toBe(true);
  });
});
