/**
 * Per-identity circuit breaker for the Antigravity catalog readers (B-1284).
 *
 * The catalog used to be read with the operator's identity, so ONE breaker per
 * process was enough. Read per member, a single breaker leaks across people: a
 * member with no agy login fails three times and every other member is served
 * the fallback for five minutes, while a healthy member's success resets the
 * failing member's counter so their breaker never settles.
 *
 * Same shape as the B-342 VendorCatalogClient breaker: one entry per identity,
 * and a success DELETES the entry, so the map only ever holds identities that
 * are currently failing (bounded by the member count, never growing forever).
 * Holds counters and timestamps only — never a token or an env.
 */

type CircuitState = {
  consecutiveFailures: number;
  openUntil: number;
};

export type IdentityCircuit = {
  /** True while this identity's breaker is open (serve the fallback, do not probe). */
  isOpen(identity: string | number | null, now: number): boolean;
  recordSuccess(identity: string | number | null): void;
  recordFailure(identity: string | number | null, now: number): void;
  /** Test-only: forget every identity. */
  reset(): void;
  /** Test-only: number of identities currently tracked. */
  size(): number;
};

/** Stable map key for a caller; `null` is the operator, stated explicitly. */
const identityKey = (identity: string | number | null): string => (
  identity === null || identity === undefined || identity === '' ? 'operator' : `user:${String(identity)}`
);

/**
 * Builds an independent breaker: `threshold` consecutive failures for one
 * identity open that identity's circuit for `cooldownMs`; afterwards a single
 * half-open probe is allowed, and its outcome closes or re-opens it.
 */
export function createIdentityCircuit(threshold: number, cooldownMs: number): IdentityCircuit {
  const circuits = new Map<string, CircuitState>();
  return {
    isOpen(identity, now) {
      return (circuits.get(identityKey(identity))?.openUntil ?? 0) > now;
    },
    recordSuccess(identity) {
      circuits.delete(identityKey(identity));
    },
    recordFailure(identity, now) {
      const key = identityKey(identity);
      const state = circuits.get(key) ?? { consecutiveFailures: 0, openUntil: 0 };
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= threshold) {
        state.openUntil = now + cooldownMs;
      }
      circuits.set(key, state);
    },
    reset() {
      circuits.clear();
    },
    size() {
      return circuits.size;
    },
  };
}
