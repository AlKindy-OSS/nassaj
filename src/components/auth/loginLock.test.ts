// T-2035: lock parsing, minute rounding and the one-shot sign-out notice.
import { describe, expect, it } from 'vitest';

import {
  consumeSignedOutEverywhereNotice,
  hasSignedOutEverywhereNotice,
  loginLockedMessage,
  loginLockMinutes,
  readLoginLock,
  recordSignedOutEverywhereNotice,
} from './loginLock';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

const response = (status: number, retryAfter?: string) =>
  ({ status, headers: new Headers(retryAfter ? { 'Retry-After': retryAfter } : {}) });

describe('loginLock', () => {
  it('rounds the wait up to whole minutes, never below one', () => {
    expect(loginLockMinutes(1)).toBe(1);
    expect(loginLockMinutes(60)).toBe(1);
    expect(loginLockMinutes(61)).toBe(2);
    expect(loginLockMinutes(1800)).toBe(30);
    expect(loginLockMinutes(undefined)).toBe(1);
  });

  it('recognizes only a 429 with the lock code; body wait wins over the header', () => {
    expect(readLoginLock(response(429, '120'), { code: 'login_temporarily_locked', retryAfterSeconds: 90 })).toBe(90);
    expect(readLoginLock(response(429, '120'), { code: 'login_temporarily_locked' })).toBe(120);
    expect(readLoginLock(response(429), { error: 'Too many attempts' })).toBeNull();
    expect(readLoginLock(response(401), { code: 'login_temporarily_locked' })).toBeNull();
  });

  it('builds the auth:loginLocked message with minutes', () => {
    const t = (key: string, options: { minutes: number; ns?: string }) => `${options.ns}:${key}:${options.minutes}`;
    expect(loginLockedMessage(t, 61)).toBe('auth:loginLocked:2');
  });

  it('the signed-out-everywhere notice is one-shot', () => {
    const storage = memoryStorage();
    expect(hasSignedOutEverywhereNotice(storage)).toBe(false);
    recordSignedOutEverywhereNotice(storage);
    expect(hasSignedOutEverywhereNotice(storage)).toBe(true);
    expect(consumeSignedOutEverywhereNotice(storage)).toBe(true);
    expect(consumeSignedOutEverywhereNotice(storage)).toBe(false);
  });
});
