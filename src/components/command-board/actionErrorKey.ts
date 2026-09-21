/**
 * actionErrorKey — the one mapping from a server reason code to an i18n key.
 *
 * Extracted from PendingActionsPanel (T-1684) so the queue and the history tab
 * name the same failure the same way. A code with no entry falls back to the
 * generic message rather than being rendered raw.
 */

/** Map a server reason code to its `pendingActions.*` message key. */
export function resolveErrorKey(code: string): string {
  switch (code) {
    case 'outcome_unverified': return 'outcomeUnverified';
    case 'satisfied_by_other_execution': return 'satisfiedByOther';
    case 'execution_unresolved': return 'outcomeUnverified';
    case 'action_in_flight': return 'errorInFlight';
    case 'not_claimable': return 'errorNotClaimable';
    case 'unknown_action': return 'errorUnknownAction';
    case 'proc_not_in_pm2': return 'errorProcNotInPM2';
    case 'sensitive_candidate': return 'errorSensitiveCandidate';
    case 'loaded_artifact_unavailable': return 'errorLoadedArtifactUnavailable';
    case 'stale_preview_ledger': return 'errorStalePreviewLedger';
    case 'unknown_candidate': return 'errorUnknownCandidate';
    case 'oid_control_failed': return 'errorOidControlFailed';
    case 'oid_candidate_not_awaiting_owner': return 'errorCandidateNotAwaiting';
    case 'gate_failed': return 'errorGateFailed';
    default: return 'errorGeneric';
  }
}

/** The message a settled row shows for its reason code, superseded included. */
export function resolveOutcomeMessageKey(outcome: string, reasonCode: string | null): string {
  if (outcome === 'failure' && reasonCode === 'superseded') return 'superseded';
  return resolveErrorKey(reasonCode ?? '');
}
