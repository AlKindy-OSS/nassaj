// B-1043 / T-1699: a 401 that carries a provider/domain error code must not be
// mistaken for a nassaj session rejection (which signs the member out).
import { describe, expect, it } from 'vitest';
import { isSessionRejection } from './api.js';

const res = (body?: unknown, init: ResponseInit = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status: 401, ...init });

describe('isSessionRejection', () => {
  it('treats the auth middleware shape ({ error } without code) as a rejection', async () => {
    expect(await isSessionRejection(res({ error: 'Invalid or expired token' }))).toBe(true);
  });

  it('treats an unreadable / empty body as a rejection (fail-safe)', async () => {
    expect(await isSessionRejection(res(undefined))).toBe(true);
    expect(await isSessionRejection(new Response('not json', { status: 401 }))).toBe(true);
  });

  it.each(['AUTH_REQUIRED', 'AUTHENTICATION_REQUIRED', 'UNAUTHENTICATED', 'UNAUTHORIZED'])(
    'treats route guard code %s as a rejection',
    async (code) => {
      expect(await isSessionRejection(res({ error: 'x', code }))).toBe(true);
    },
  );

  it('keeps the session for a provider credential code (the Jazari/Razi case)', async () => {
    expect(await isSessionRejection(res({ error: 'Claude is not authenticated.', code: 'CLAUDE_USAGE_UNAVAILABLE' }))).toBe(false);
  });

  it('leaves the body readable for the caller', async () => {
    const r = res({ error: 'x', code: 'CLAUDE_USAGE_UNAVAILABLE' });
    await isSessionRejection(r);
    expect((await r.json()).code).toBe('CLAUDE_USAGE_UNAVAILABLE');
  });
});
