/**
 * Sign-out epoch check shared by every session-JWT verifier (T-2035, ADR-212).
 *
 * Pure (no imports, no I/O) so verifiers outside the auth middleware — share
 * links, the C4 review surface — can apply the same rule without loading the
 * middleware module and its boot side effects. Verifiers call it through
 * `tokenSessionCurrent` (token-session.ts), which adds the per-device
 * revocation; the guard test beside this file enforces that pairing.
 */

type EpochCarrier = { token_epoch?: unknown } | null | undefined;

/**
 * The user's current bearer epoch. A row without the column (a mocked or
 * pre-migration identity) reads 0, the epoch of every legacy token.
 */
export function currentTokenEpoch(user: EpochCarrier): number {
  const epoch = user?.token_epoch;
  return typeof epoch === 'number' && Number.isSafeInteger(epoch) ? epoch : 0;
}

/**
 * True when the verified token's `tok_ep` claim matches the user's epoch. A
 * token minted before T-2035 has no claim and counts as epoch 0, so the deploy
 * signs nobody out; any sign-out bumps the epoch past it.
 */
export function tokenEpochCurrent(decoded: unknown, user: EpochCarrier): boolean {
  if (!decoded || typeof decoded !== 'object') return false;
  const claim = Object.hasOwn(decoded, 'tok_ep') ? (decoded as { tok_ep?: unknown }).tok_ep : 0;
  return Number.isSafeInteger(claim) && claim === currentTokenEpoch(user);
}
