/**
 * The websocket must survive a routine token rotation.
 *
 * It used to be keyed on the raw JWT string, so every mid-session rotation
 * (`X-Refreshed-Token`, fired once the token passes half-life — i.e. while the
 * user is actively working) tore the connection down and dialled a new one. The
 * owner saw the "Reconnecting…" badge flash on ordinary messages. Nothing
 * required it: connect() always reads the freshest token from localStorage, so a
 * socket that outlives a rotation is not stale.
 *
 * These lock the distinction the key encodes: same identity ⇒ same key (no
 * reconnect); different account or a password change ⇒ different key (reconnect).
 */

import { describe, expect, it } from 'vitest';

import { identityKeyFromToken } from './WebSocketContext';

/** Builds an unsigned JWT with the given payload (signature is never read). */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

describe('identityKeyFromToken', () => {
  it('is STABLE across a routine rotation (same user, later exp/iat)', () => {
    const before = jwt({ sub: 7, pwd_iat: 1000, iat: 100, exp: 200 });
    const after = jwt({ sub: 7, pwd_iat: 1000, iat: 150, exp: 250 });

    expect(identityKeyFromToken(after)).toBe(identityKeyFromToken(before));
    expect(after).not.toBe(before); // the token itself did change — that is the point
  });

  it('CHANGES when the account changes', () => {
    const owner = jwt({ sub: 1, pwd_iat: 1000 });
    const other = jwt({ sub: 2, pwd_iat: 1000 });

    expect(identityKeyFromToken(other)).not.toBe(identityKeyFromToken(owner));
  });

  it('CHANGES on a password change (server rejects the old credential)', () => {
    const before = jwt({ sub: 7, pwd_iat: 1000 });
    const after = jwt({ sub: 7, pwd_iat: 2000 });

    expect(identityKeyFromToken(after)).not.toBe(identityKeyFromToken(before));
  });

  it('accepts userId / id as the subject claim', () => {
    expect(identityKeyFromToken(jwt({ userId: 7, pwd_iat: 1 })))
      .toBe(identityKeyFromToken(jwt({ sub: 7, pwd_iat: 1 })));
    expect(identityKeyFromToken(jwt({ id: 7, pwd_iat: 1 })))
      .toBe(identityKeyFromToken(jwt({ sub: 7, pwd_iat: 1 })));
  });

  it('returns null with no token, so logout still tears the socket down', () => {
    expect(identityKeyFromToken(null)).toBeNull();
    expect(identityKeyFromToken(undefined)).toBeNull();
    expect(identityKeyFromToken('')).toBeNull();
  });

  it('falls back to the raw token when the payload is unreadable', () => {
    // Safer to over-reconnect than to keep a socket authenticated as the wrong
    // identity, so an unparsable token keeps the previous behaviour.
    for (const bad of ['not-a-jwt', 'a.b', `header.${btoa('{not json')}.sig`]) {
      expect(identityKeyFromToken(bad)).toBe(bad);
    }
  });

  it('falls back to the raw token when no subject claim is present', () => {
    const anonymous = jwt({ iat: 1, exp: 2 });
    expect(identityKeyFromToken(anonymous)).toBe(anonymous);
  });
});
