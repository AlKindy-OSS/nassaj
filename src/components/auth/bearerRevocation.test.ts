// T-2035: a 4401 to a bearer socket goes to login when the token is dead and
// redials at most once per cooldown otherwise — never a reconnect loop.
import { beforeEach, describe, expect, it } from 'vitest';

import {
  BEARER_REVOCATION_RECONNECT_COOLDOWN_MS,
  resetBearerRevocationState,
  resolveBearerRevocation,
} from './bearerRevocation';

const answer = (status: number) => async () => ({ status, ok: status >= 200 && status < 300 });

beforeEach(() => resetBearerRevocationState());

describe('resolveBearerRevocation', () => {
  it('a dead token (401) is signed out and never redials', async () => {
    expect(await resolveBearerRevocation({ probe: answer(401), now: () => 0 })).toBe('signed_out');
  });

  it('a live token redials once per cooldown', async () => {
    let now = 1_000;
    expect(await resolveBearerRevocation({ probe: answer(200), now: () => now })).toBe('reconnect');
    now += 1;
    expect(await resolveBearerRevocation({ probe: answer(200), now: () => now })).toBe('stay_disconnected');
    now += BEARER_REVOCATION_RECONNECT_COOLDOWN_MS;
    expect(await resolveBearerRevocation({ probe: answer(200), now: () => now })).toBe('reconnect');
  });

  it('a failed probe or other status stays disconnected', async () => {
    expect(await resolveBearerRevocation({ probe: async () => { throw new Error('offline'); } }))
      .toBe('stay_disconnected');
    expect(await resolveBearerRevocation({ probe: answer(503) })).toBe('stay_disconnected');
  });
});
