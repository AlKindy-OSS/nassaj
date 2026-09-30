/**
 * useUpdateCompletionNotice — announce a finished update after reconnect (T-1730/owner defect 2026-09).
 *
 * The VersionUpgradeModal only polls the job while it is open; an owner who
 * closes it (or navigates away) while the node restarts on the new version
 * never sees a success signal. `storeUpdateAttempt` already records the
 * target version and its statusUrl in localStorage for the whole attempt
 * lifetime and survives a full page reload / reconnect. This hook is mounted
 * at the app shell (always alive, unlike the modal) and, once the version
 * the client now sees — refreshed by `useVersionCheck`'s own /health polling
 * — matches that stored target, reads the job's own status to confirm it
 * actually reached `activated` before announcing anything.
 *
 * A version match alone is not proof of success (qa-critic round 1, M1):
 * `runtime_verifying` can still roll back to `rolled_back`, and the source
 * version already moves at the staging checkout, well before activation.
 *
 * A single read is not enough either (qa-critic round 2, M-a): the effect
 * only re-runs when `currentVersion` itself changes, which can stay put for
 * minutes while the job is still `runtime_verifying`, or a request can fail
 * transiently (network hiccup, bad JSON, a non-404 error status). Both cases
 * get a bounded, backed-off retry (`pollingDelay`, up to `MAX_ATTEMPTS`)
 * inside this same effect run, independent of the next /health tick.
 */

import { useCallback, useEffect, useState } from 'react';
import { authenticatedFetch } from '../../utils/api';
import {
  clearStoredUpdateAttempt,
  isTerminalUpdateState,
  normalizeUpdateJob,
  pollingDelay,
  readStoredUpdateAttempt,
  safeStatusPath,
  type StoredUpdateAttempt,
  type UpdateJobState,
} from './updateJobClient';

/** Stale attempts (older than the server's 24h consent timeout) never surface a notice. */
const MAX_ATTEMPT_AGE_MS = 24 * 60 * 60 * 1000;

/** Bounded re-check budget for a 'pending' state or a transient read error. */
const MAX_ATTEMPTS = 5;

export interface UpdateCompletionNotice {
  targetVersion: string;
}

/**
 * Pure decision: does this stored attempt, read at a moment the client now
 * reports `currentVersion`, describe an attempt worth checking further? Only
 * a version match and freshness — never proof of success on its own (the
 * caller must still read the job's real state). Exported separately so the
 * decision is unit-testable without mounting React or touching localStorage.
 */
export function isCandidateForCompletionCheck(
  stored: StoredUpdateAttempt | null,
  currentVersion: string | null,
  now: number = Date.now(),
): boolean {
  if (!stored || !currentVersion) return false;
  if (stored.targetVersion !== currentVersion) return false;
  if (now - stored.createdAt > MAX_ATTEMPT_AGE_MS) return false;
  return true;
}

/** What a confirmed read of the job's own status means for the stored attempt. */
export type CompletionVerdict = 'success' | 'clear-silent' | 'pending';

/**
 * Only `activated` is a success. Any other terminal state (rolled_back,
 * failed, manual_recovery_required, superseded, cancelled) settles the
 * attempt without a success notice — it did not reach the target. A
 * non-terminal state (still restarting/verifying) means check again later;
 * the attempt is left in place.
 */
export function classifyCompletionVerdict(state: UpdateJobState): CompletionVerdict {
  if (state === 'activated') return 'success';
  if (isTerminalUpdateState(state)) return 'clear-silent';
  return 'pending';
}

/**
 * Fires (once) when `currentVersion` catches up to a stored update attempt's
 * target AND that attempt's own job status confirms `activated`, re-checking
 * with a bounded backoff while the job is still finishing or a read fails
 * transiently. `dismiss` also clears any notice already shown so a later,
 * unrelated version bump does not resurrect it.
 */
export function useUpdateCompletionNotice(currentVersion: string | null): {
  notice: UpdateCompletionNotice | null;
  dismiss: () => void;
} {
  const [notice, setNotice] = useState<UpdateCompletionNotice | null>(null);

  useEffect(() => {
    const stored = readStoredUpdateAttempt();
    if (!isCandidateForCompletionCheck(stored, currentVersion)) return;
    const statusPath = safeStatusPath(stored!.statusUrl);
    if (!statusPath) return;

    const attemptKey = stored!.idempotencyKey;
    const targetVersion = stored!.targetVersion;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** True only while the localStorage attempt is still the one this effect started checking (T-b). */
    const attemptStillCurrent = () => readStoredUpdateAttempt()?.idempotencyKey === attemptKey;

    const settle = (announceSuccess: boolean) => {
      if (cancelled || !attemptStillCurrent()) return;
      if (announceSuccess) setNotice({ targetVersion });
      clearStoredUpdateAttempt();
    };

    const scheduleRetry = (attemptNumber: number) => {
      if (cancelled || attemptNumber >= MAX_ATTEMPTS - 1) return;
      timer = setTimeout(() => check(attemptNumber + 1), pollingDelay(attemptNumber));
    };

    const check = (attemptNumber: number) => {
      if (cancelled || !attemptStillCurrent()) return;
      void authenticatedFetch(statusPath)
        .then(async (response: Response) => {
          if (cancelled) return;
          if (response.status === 404) {
            // The job record is gone; nothing left to confirm against.
            settle(false);
            return;
          }
          if (!response.ok) {
            scheduleRetry(attemptNumber); // transient — bounded retry.
            return;
          }
          const data = await response.json().catch(() => null);
          if (!data || typeof data !== 'object') {
            scheduleRetry(attemptNumber); // bad JSON — bounded retry.
            return;
          }
          const snapshot = normalizeUpdateJob(data, statusPath);
          const verdict = classifyCompletionVerdict(snapshot.state);
          if (verdict === 'success') settle(true);
          else if (verdict === 'clear-silent') settle(false);
          else scheduleRetry(attemptNumber); // 'pending' — bounded retry.
        })
        .catch(() => scheduleRetry(attemptNumber)); // fetch rejected — bounded retry.
    };

    check(0);

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [currentVersion]);

  const dismiss = useCallback(() => setNotice(null), []);

  return { notice, dismiss };
}
