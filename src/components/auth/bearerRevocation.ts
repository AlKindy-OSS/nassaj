/**
 * T-2035 (ADR-212): what a bearer (JWT) tab does when the server closes its
 * realtime socket with 4401.
 *
 * The cookie wallet path reconciles the device session; a bearer tab has no
 * wallet (the server answers /accounts with 404), so that path would end on
 * the locked screen. A 4401 to a bearer socket means the token may be dead —
 * typically a sign-out on another device bumped the user's epoch. The tab
 * asks the server once:
 *   - 401: the token is dead. The request went through authenticatedFetch,
 *     whose 401 path already tried one refresh and dispatched
 *     `auth:unauthorized`, so AuthContext shows the login screen. No redial.
 *   - 200: the identity is still valid (e.g. a same-rank change only refreshed
 *     connections). Redial once per cooldown, so a server that keeps closing
 *     can never drive a reconnect loop.
 *   - anything else: stay disconnected.
 */

import { api } from '../../utils/api';

import { reconcileRevokedIdentity } from './accountIdentityBarrier';
import { AUTH_TOKEN_STORAGE_KEY } from './constants';

export type BearerRevocationOutcome = 'signed_out' | 'reconnect' | 'stay_disconnected';

export const BEARER_REVOCATION_RECONNECT_COOLDOWN_MS = 60_000;

type Deps = {
  probe?: () => Promise<Pick<Response, 'status' | 'ok'>>;
  now?: () => number;
};

let lastReconnectAt = Number.NEGATIVE_INFINITY;

/** Test seam: module state outlives a test. */
export function resetBearerRevocationState(): void {
  lastReconnectAt = Number.NEGATIVE_INFINITY;
}

/** Decides the tab's next step after a 4401 close of a bearer socket. */
export async function resolveBearerRevocation({
  probe = () => api.auth.userForIdentityReconciliation(),
  now = () => Date.now(),
}: Deps = {}): Promise<BearerRevocationOutcome> {
  let response: Pick<Response, 'status' | 'ok'>;
  try {
    response = await probe();
  } catch {
    return 'stay_disconnected';
  }
  if (response.status === 401) return 'signed_out';
  if (!response.ok) return 'stay_disconnected';
  const at = now();
  if (at - lastReconnectAt < BEARER_REVOCATION_RECONNECT_COOLDOWN_MS) return 'stay_disconnected';
  lastReconnectAt = at;
  return 'reconnect';
}

/**
 * Routes a revocation signal from a secondary channel (shell, terminal, search
 * stream). A device-cookie tab reconciles its wallet; a bearer tab has none, so
 * it only re-proves its token: a dead one lands on login through the 401 path
 * (`auth:unauthorized`), a live one stays signed in. The reconnect cooldown is
 * left to the main socket.
 */
export function handleIdentityRevocation(): void {
  if (localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)) {
    void api.auth.userForIdentityReconciliation().catch(() => {});
    return;
  }
  reconcileRevokedIdentity();
}
