/**
 * B-1448 slice 2: state for the owner's "close N terminals and update".
 *
 * idle → confirming (the owner sees the exact set he is about to close)
 *      → closing (request in flight) → done
 * A 409 `terminals_changed` returns to `confirming` with the FRESH set and
 * `changed: true`: nothing was closed and the owner must confirm again (an
 * unreadable fresh set returns to `idle` with an error instead). Any other
 * refusal stays in `confirming`, with an error, so he can retry or cancel.
 * `done` lasts only while the poll shows the set that was current at the close:
 * a new snapshot (terminals opened again) returns to `idle` and the button.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../utils/api';

import { closeTerminals, type OpenTerminals } from './updateJobClient';

export type CloseTerminalsPhase = 'idle' | 'confirming' | 'closing' | 'done';

export interface CloseTerminalsError {
  code: string;
  status: number;
  /** Why `update_not_overridable` refused, when the server says (B-1448). */
  reason?: string | null;
}

/** `update_not_overridable` reasons with their own message (B-1448). */
export const NOT_OVERRIDABLE_REASONS = Object.freeze([
  'sessions_active', 'scheduled_wait', 'not_waiting_terminals', 'activator_failed', 'local_main',
]);

/** i18n key (under `versionUpdate.closeTerminals.errors`) for a refusal. */
export function closeTerminalsErrorKey(error: CloseTerminalsError): string {
  if (error.status === 429) return 'rateLimited';
  switch (error.code) {
    case 'update_not_overridable':
      return error.reason && NOT_OVERRIDABLE_REASONS.includes(error.reason)
        ? `notOverridableReasons.${error.reason}`
        : 'notOverridable';
    case 'update_job_not_found': return 'jobNotFound';
    case 'terminal_snapshot_invalid':
    case 'snapshot_unavailable': return 'snapshotInvalid';
    case 'owner_identity_unavailable': return 'ownerIdentity';
    case 'network': return 'network';
    default: break;
  }
  if (error.status === 401 || error.status === 403) return 'forbidden';
  return 'unknown';
}

/**
 * Drive the close-terminals confirmation for one job. `current` is the set the
 * status poll shows now; it seeds the confirmation when the owner opens it.
 */
export function useCloseTerminals(jobId: string | null, current: OpenTerminals | null) {
  const [phase, setPhase] = useState<CloseTerminalsPhase>('idle');
  const [confirmSet, setConfirmSet] = useState<OpenTerminals | null>(null);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<CloseTerminalsError | null>(null);
  const [closedCount, setClosedCount] = useState(0);
  const [remainingCount, setRemainingCount] = useState(0);
  // The snapshot the successful close was confirmed against; once the poll
  // shows any other set, the button comes back (the last result stays shown).
  const doneSnapshot = useRef<string | null>(null);
  const inFlight = useRef(false);
  const currentSnapshot = current?.snapshot ?? null;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (phase === 'done' && currentSnapshot !== doneSnapshot.current) {
      setError(null);
      setPhase('idle');
    }
  }, [currentSnapshot, phase]);

  const open = useCallback(() => {
    setClosedCount(0);
    setRemainingCount(0);
    setConfirmSet(current);
    setChanged(false);
    setError(null);
    setPhase('confirming');
  }, [current]);

  const cancel = useCallback(() => {
    if (inFlight.current) return;
    setConfirmSet(null);
    setChanged(false);
    setError(null);
    setPhase('idle');
  }, []);

  const confirm = useCallback(async () => {
    if (!jobId || inFlight.current) return;
    if (!confirmSet?.snapshot) {
      setError({ code: 'snapshot_unavailable', status: 0 });
      return;
    }
    inFlight.current = true;
    setPhase('closing');
    setError(null);
    const result = await closeTerminals(authenticatedFetch, jobId, confirmSet.snapshot);
    inFlight.current = false;
    if (!mounted.current) return;
    if (result.kind === 'closed') {
      doneSnapshot.current = confirmSet.snapshot;
      setClosedCount(result.closed);
      setRemainingCount(result.remaining);
      setPhase('done');
      return;
    }
    if (result.kind === 'changed' && result.openTerminals) {
      setConfirmSet(result.openTerminals);
      setChanged(true);
      setPhase('confirming');
      return;
    }
    setChanged(false);
    if (result.kind === 'error') {
      setError(result);
      setPhase('confirming');
      return;
    }
    // The set changed but the fresh one is unreadable: never re-send the stale
    // snapshot; start over from the next status poll.
    setConfirmSet(null);
    setError({ code: 'snapshot_unavailable', status: 409 });
    setPhase('idle');
  }, [confirmSet, jobId]);

  return { phase, confirmSet, changed, error, closedCount, remainingCount, open, cancel, confirm };
}
