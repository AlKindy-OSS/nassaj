/**
 * ScheduledWaitPanel — T-1912 «ما يراه المالك» — autoActivation.state === 'waiting_scheduled'.
 *
 * Shown while the auto-activator holds a `restart_queued` job's safe restart
 * because a scheduled message is due within the configured window. Displays:
 *  - How many messages are due, and when the earliest one is due (local time)
 *  - A note that the hold is capped at one hour
 *  - "Update now" — skip ONLY this job's scheduled-message hold; live sessions
 *    and every other restart gate still apply
 *  - The confirmation text once the owner has skipped the wait
 *
 * Contract (server/, already implemented for T-1912):
 *   POST /api/system/update/jobs/:id/skip-scheduled-wait
 *     → 200 { jobId, state, scheduledOverride: true }
 *     → 404 update_job_not_found, 403 owner_identity_unavailable
 *     → 409 { code: 'update_not_overridable' } once the job leaves
 *       restart_queued/auto-activation or is not the owner's own job
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clock, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

import { authenticatedFetch } from "../../../utils/api";
import type { ScheduledDueSoon } from "../updateJobClient";

interface ScheduledWaitPanelProps {
  dueSoon: ScheduledDueSoon;
  /** Extracted from statusUrl: `/api/system/update/jobs/<id>` last segment. */
  jobId: string | null;
  /** True once the owner has already skipped this job's scheduled wait. */
  overridden: boolean;
  /** Called after a successful skip so the parent can mark the job overridden. */
  onOverridden: () => void;
}

function formatTime(earliestAt: string | null, locale: string): string {
  if (!earliestAt) return '';
  const parsed = Date.parse(earliestAt);
  if (Number.isNaN(parsed)) return '';
  try {
    return new Date(parsed).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(parsed).toLocaleTimeString();
  }
}

/**
 * Minutes from now until `earliestAt`, unclamped: <= 0 means the message is
 * already due (or due this instant), which the caller renders as "due now"
 * instead of a misleading "in 1 minute".
 */
function minutesUntil(earliestAt: string | null): number | null {
  if (!earliestAt) return null;
  const parsed = Date.parse(earliestAt);
  if (Number.isNaN(parsed)) return null;
  return Math.ceil((parsed - Date.now()) / 60_000);
}

export function ScheduledWaitPanel({
  dueSoon,
  jobId,
  overridden,
  onOverridden,
}: ScheduledWaitPanelProps) {
  const { t, i18n } = useTranslation('common');
  const [skipping, setSkipping] = useState(false);
  const [skipError, setSkipError] = useState<string | null>(null);

  const handleSkip = useCallback(async () => {
    if (!jobId || skipping) return;
    setSkipping(true);
    setSkipError(null);
    try {
      const response = await authenticatedFetch(
        `/api/system/update/jobs/${jobId}/skip-scheduled-wait`,
        { method: 'POST' },
      );
      if (response.ok) {
        onOverridden();
        return;
      }
      let code = 'unknown';
      try {
        const data = await response.json() as Record<string, unknown>;
        if (typeof data.code === 'string') code = data.code;
      } catch { /* ignore */ }
      if (response.status === 409 && code === 'update_not_overridable') {
        setSkipError(t('versionUpdate.errors.overrideNotAllowed'));
      } else if (response.status === 401 || response.status === 403) {
        setSkipError(t('versionUpdate.errors.authorization'));
      } else {
        setSkipError(t('versionUpdate.errors.connection'));
      }
    } catch {
      setSkipError(t('versionUpdate.errors.connection'));
    } finally {
      setSkipping(false);
    }
  }, [jobId, onOverridden, skipping, t]);

  const time = formatTime(dueSoon.earliestAt, i18n.language);
  const minutes = minutesUntil(dueSoon.earliestAt);
  const dueNow = minutes !== null && minutes <= 0;

  // `minutesLabel` is pre-pluralized on its own count (t() picks the right
  // Arabic CLDR form: zero/one/two/few/many/other) so the outer `message`
  // key only ever pluralizes on `count` (scheduled-message count), never on
  // two independent counts at once.
  const message = dueNow
    ? t('versionUpdate.scheduledWait.messageDueNow', { count: dueSoon.count, time })
    : minutes !== null && time
      ? t('versionUpdate.scheduledWait.message', {
        count: dueSoon.count,
        minutesLabel: t('versionUpdate.scheduledWait.minutesUnit', { count: minutes }),
        time,
      })
      : t('versionUpdate.scheduledWait.messageNoTime', { count: dueSoon.count });

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t('versionUpdate.scheduledWait.panelAriaLabel')}
      className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700/60 dark:bg-amber-950/25"
    >
      {/* Title */}
      <div className="flex items-center gap-2">
        <Clock
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
          {t('versionUpdate.scheduledWait.title')}
        </p>
      </div>

      {/* Message: count + earliest due time */}
      <p className="text-xs text-amber-800 dark:text-amber-300">{message}</p>

      {/* Cap note */}
      <p className="text-xs text-amber-700/70 dark:text-amber-400/70">
        {t('versionUpdate.scheduledWait.capNote')}
      </p>

      {overridden ? (
        /* Already skipped: confirmation text, no button */
        <div className="flex items-center gap-2 text-xs font-medium text-amber-900 dark:text-amber-200">
          <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span>{t('versionUpdate.scheduledWait.overridden')}</span>
        </div>
      ) : (
        <>
          {/* Skip error */}
          {skipError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200"
            >
              <AlertCircle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{skipError}</span>
            </div>
          )}

          {/* Update now — skip the wait */}
          {jobId && (
            <div className="space-y-1.5">
              <button
                type="button"
                onClick={() => void handleSkip()}
                disabled={skipping}
                aria-busy={skipping || undefined}
                className="flex items-center gap-2 rounded-md border border-amber-400 bg-amber-100 px-3 py-1.5 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-600/50 dark:bg-amber-900/30 dark:text-amber-200 dark:hover:bg-amber-900/50"
              >
                {skipping ? (
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Clock aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                <span>{t('versionUpdate.buttons.updateNow')}</span>
              </button>
              <p className="text-xs text-amber-700/70 dark:text-amber-400/70">
                {t('versionUpdate.scheduledWait.overrideHint')}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
