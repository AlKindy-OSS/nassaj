// T-1939 slice 3: SSO restart with a one-shot notice and a redirect-loop guard.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  consumeSsoReauthNotice,
  hasSsoReauthNotice,
  isSsoRedirectInFlight,
  REDIRECT_COOLDOWN_MS,
  requestSsoReauth,
  resetSsoRedirectInFlight,
} from './ssoReauth';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

describe('requestSsoReauth', () => {
  beforeEach(() => resetSsoRedirectInFlight());

  it('redirects to SSO and leaves a notice for the login page', () => {
    const storage = memoryStorage();
    const redirect = vi.fn();
    expect(requestSsoReauth({ storage, now: () => 1_000_000, redirect })).toBe('redirected');
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(hasSsoReauthNotice(storage)).toBe(true);
  });

  it('ignores later requests while the redirect is in flight', () => {
    const storage = memoryStorage();
    const redirect = vi.fn();
    expect(requestSsoReauth({ storage, redirect })).toBe('redirected');
    expect(isSsoRedirectInFlight()).toBe(true);
    expect(requestSsoReauth({ storage, redirect })).toBe('in_flight');
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight flag when the redirect throws', () => {
    const redirect = vi.fn(() => { throw new Error('blocked'); });
    expect(() => requestSsoReauth({ storage: memoryStorage(), redirect })).toThrow('blocked');
    expect(isSsoRedirectInFlight()).toBe(false);
  });

  it('does not redirect again within the cooldown (IdP bounce → no loop)', () => {
    const storage = memoryStorage();
    const redirect = vi.fn();
    let now = 1_000_000;
    requestSsoReauth({ storage, now: () => now, redirect });
    resetSsoRedirectInFlight(); // page reloaded after the IdP bounce
    now += REDIRECT_COOLDOWN_MS - 1;
    expect(requestSsoReauth({ storage, now: () => now, redirect })).toBe('cooling');
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(hasSsoReauthNotice(storage)).toBe(true);
    now += 2;
    expect(requestSsoReauth({ storage, now: () => now, redirect })).toBe('redirected');
    expect(redirect).toHaveBeenCalledTimes(2);
  });

  it('still redirects once when storage throws', () => {
    const redirect = vi.fn();
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(requestSsoReauth({ storage: broken, redirect })).toBe('redirected');
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(consumeSsoReauthNotice(broken)).toBe(false);
  });
});

describe('consumeSsoReauthNotice', () => {
  beforeEach(() => resetSsoRedirectInFlight());

  it('returns the notice once', () => {
    const storage = memoryStorage();
    requestSsoReauth({ storage, redirect: () => {} });
    expect(consumeSsoReauthNotice(storage)).toBe(true);
    expect(consumeSsoReauthNotice(storage)).toBe(false);
  });
});
