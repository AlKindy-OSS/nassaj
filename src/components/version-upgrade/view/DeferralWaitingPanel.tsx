/**
 * DeferralWaitingPanel — T-1730 §3.3 «ما يراه المشغّل» — awaiting_sessions state.
 *
 * Shown while the job is in `awaiting_sessions`. Displays:
 *  - Live session count + gate reason
 *  - Absolute deadline (local time)
 *  - Rearm count if > 0
 *  - Immutable guarantee: no session will be stopped
 *  - Cancel button → POST /api/system/update/jobs/:id/cancel
 *    409 update_not_cancellable if the job moved past awaiting_sessions.
 *
 * Contract assumption for backend-dev (server/):
 *   POST /api/system/update/jobs/:id/cancel
 *     → 200/204 on success
 *     → 409 { code: 'update_not_cancellable' } if state ≠ awaiting_sessions
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clock, Users, XCircle, AlertCircle, Loader2 } from "lucide-react";

import { authenticatedFetch } from "../../../utils/api";
import type { DeferralStatus } from "../updateJobClient";

interface DeferralWaitingPanelProps {
  deferral: DeferralStatus;
  /** Extracted from statusUrl: `/api/system/update/jobs/<id>` last segment. */
  jobId: string | null;
  /** Called after successful cancel so the parent can reset its state. */
  onCancelled: () => void;
}

function formatDeadline(deadlineAt: number | null, locale: string): string {
  if (!deadlineAt) return '';
  try {
    return new Date(deadlineAt).toLocaleString(locale, {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return new Date(deadlineAt).toLocaleString();
  }
}

export function DeferralWaitingPanel({
  deferral,
  jobId,
  onCancelled,
}: DeferralWaitingPanelProps) {
  const { t, i18n } = useTranslation('common');
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const handleCancel = useCallback(async () => {
    if (!jobId || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const response = await authenticatedFetch(
        `/api/system/update/jobs/${jobId}/cancel`,
        { method: 'POST' },
      );
      if (response.ok) {
        onCancelled();
        return;
      }
      let code = 'unknown';
      try {
        const data = await response.json() as Record<string, unknown>;
        if (typeof data.code === 'string') code = data.code;
      } catch { /* ignore */ }
      if (response.status === 409 && code === 'update_not_cancellable') {
        setCancelError(t('versionUpdate.errors.cancelNotAllowed'));
      } else if (response.status === 401 || response.status === 403) {
        setCancelError(t('versionUpdate.errors.authorization'));
      } else {
        setCancelError(t('versionUpdate.errors.connection'));
      }
    } catch {
      setCancelError(t('versionUpdate.errors.connection'));
    } finally {
      setCancelling(false);
    }
  }, [cancelling, jobId, onCancelled, t]);

  const deadline = formatDeadline(deferral.deadlineAt, i18n.language);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t('versionUpdate.deferral.panelAriaLabel')}
      className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700/60 dark:bg-amber-950/25"
    >
      {/* Title */}
      <div className="flex items-center gap-2">
        <Clock
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
          {t('versionUpdate.deferral.waitingTitle')}
        </p>
      </div>

      {/* Session count */}
      {deferral.sessionCount !== null && (
        <div className="flex items-center gap-2 text-xs text-amber-800 dark:text-amber-300">
          <Users aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span>
            {t('versionUpdate.deferral.sessionCount', {
              count: deferral.sessionCount,
            })}
          </span>
        </div>
      )}

      {/* Gate reason */}
      {deferral.gateReason && (
        <p className="text-xs text-amber-800/80 dark:text-amber-300/80">
          {t('versionUpdate.deferral.gateReason', {
            reason: t(
              `versionUpdate.deferral.gateReasonLabels.${deferral.gateReason}`,
              t('versionUpdate.deferral.gateReasonLabels.unknown'),
            ),
          })}
        </p>
      )}

      {/* Deadline */}
      {deadline && (
        <p className="text-xs text-amber-700/70 dark:text-amber-400/70">
          {t('versionUpdate.deferral.deadline', { time: deadline })}
        </p>
      )}

      {/* Rearm count — shown only if rearmed at least once */}
      {deferral.rearmCount > 0 && (
        <p className="text-xs text-amber-700/70 dark:text-amber-400/70">
          {t('versionUpdate.deferral.rearmCount', { count: deferral.rearmCount })}
        </p>
      )}

      {/* Immutable guarantee */}
      <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
        {t('versionUpdate.deferral.noSessionsKilled')}
      </p>

      {/* Cancel error */}
      {cancelError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200"
        >
          <AlertCircle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{cancelError}</span>
        </div>
      )}

      {/* Cancel button */}
      {jobId && (
        <button
          type="button"
          onClick={() => void handleCancel()}
          disabled={cancelling}
          aria-busy={cancelling || undefined}
          className="flex items-center gap-2 rounded-md border border-amber-400 bg-amber-100 px-3 py-1.5 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-600/50 dark:bg-amber-900/30 dark:text-amber-200 dark:hover:bg-amber-900/50"
        >
          {cancelling ? (
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <XCircle aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          <span>{t('versionUpdate.buttons.cancelDeferred')}</span>
        </button>
      )}
    </div>
  );
}
