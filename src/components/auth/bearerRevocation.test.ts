// T-2035: a 4401 to a bearer socket goes to login when the token is dead and
// redials at most once per cooldown otherwise — never a reconnect loop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { probeUser, reconcileRevoked } = vi.hoisted(() => ({
  probeUser: vi.fn(async () => ({ status: 200, ok: true })),
  reconcileRevoked: vi.fn(),
}));
vi.mock('../../utils/api', () => ({ api: { auth: { userForIdentityReconciliation: probeUser } } }));
vi.mock('./accountIdentityBarrier', () => ({ reconcileRevokedIdentity: reconcileRevoked }));

import {
  BEARER_REVOCATION_RECONNECT_COOLDOWN_MS,
  handleIdentityRevocation,
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

describe('handleIdentityRevocation', () => {
  afterEach(() => {
    localStorage.clear();
    probeUser.mockClear();
    reconcileRevoked.mockClear();
  });

  it('a bearer tab re-proves its token and never enters the wallet barrier', () => {
    localStorage.setItem('auth-token', 'jwt');
    handleIdentityRevocation();
    expect(probeUser).toHaveBeenCalledTimes(1);
    expect(reconcileRevoked).not.toHaveBeenCalled();
  });

  it('a device-cookie tab reconciles its wallet', () => {
    handleIdentityRevocation();
    expect(reconcileRevoked).toHaveBeenCalledTimes(1);
    expect(probeUser).not.toHaveBeenCalled();
  });
});
