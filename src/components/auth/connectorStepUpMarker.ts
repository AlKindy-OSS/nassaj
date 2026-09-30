/**
 * The connector step-up round-trip markers (T-1939 slice 6C).
 *
 * Kept in the auth module, dependency-free, so sign-out and the ordinary
 * sign-in return can forget them without importing the connectors UI. A stale
 * pending marker would make the next plain IdP `error` look like a step-up
 * refusal; a stale outcome would show one member's result to the next.
 */

export const CONNECTOR_STEP_UP_PENDING_KEY = 'nassaj:connector-step-up-pending';
export const CONNECTOR_STEP_UP_OUTCOME_KEY = 'nassaj:connector-step-up-outcome';

const store = (storage?: Storage | null): Storage | null =>
  (storage === undefined ? window.sessionStorage : storage);

/** Forgets a pending connector step-up. Never throws. */
export function clearPendingConnectorStepUp(storage?: Storage | null): void {
  try {
    store(storage)?.removeItem(CONNECTOR_STEP_UP_PENDING_KEY);
  } catch { /* Storage blocked: nothing was stored either. */ }
}

/** Sign-out: forgets both the pending marker and an unread outcome. Never throws. */
export function clearConnectorStepUpState(storage?: Storage | null): void {
  try {
    const target = store(storage);
    target?.removeItem(CONNECTOR_STEP_UP_PENDING_KEY);
    target?.removeItem(CONNECTOR_STEP_UP_OUTCOME_KEY);
  } catch { /* Storage blocked: nothing was stored either. */ }
}
