/**
 * Owner-only "stop stuck update". Shown under the update progress only when the
 * server says `abandonable === true`. The click opens the shared confirm dialog
 * (plain words, no restart); confirming POSTs `/abandon`, then the parent
 * refreshes the job and a self-clearing status line confirms the result. When the
 * job is not abandonable the server's reason is shown as a muted hint instead.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, OctagonX } from 'lucide-react';

import { authenticatedFetch } from '../../../utils/api';
import { useOptionalAuth } from '../../auth/context/AuthContext';
import SettingsConfirmDialog from '../../settings/view/SettingsConfirmDialog';
import { abandonUpdateJob, type AbandonBlockedReason, type UpdateJobSnapshot } from '../updateJobClient';

interface AbandonUpdateActionProps {
  job: UpdateJobSnapshot;
  /** Extracted from statusUrl; the action is hidden without it. */
  jobId: string | null;
  /** Called after the server settled the attempt; the parent refreshes the job. */
  onAbandoned: (job: unknown) => void;
}

const BASE = 'versionUpdate.abandon';
const SUCCESS_AUTO_CLEAR_MS = 6 * 1000;
/** Reasons worth explaining on a live job; `terminal` needs no hint. */
const HINT_REASONS: ReadonlyArray<AbandonBlockedReason> = [
  'in_flight_restart', 'gate_closed', 'head_moved_unverified',
];
const NOTICE = 'flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 '
  + 'dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200';

/** i18n key (under `versionUpdate.abandon.errors`) for a refusal. */
export function abandonErrorKey(code: string, status: number, reason: AbandonBlockedReason | null): string {
  if (code === 'update_not_abandonable') return reason ? `notAbandonable.${reason}` : 'notAbandonable.unknown';
  if (code === 'update_job_not_found') return 'jobNotFound';
  if (code === 'network') return 'network';
  if (status === 429) return 'rateLimited';
  if (status === 401 || status === 403) return 'forbidden';
  return 'unknown';
}

export function AbandonUpdateAction({ job, jobId, onAbandoned }: AbandonUpdateActionProps) {
  const { t } = useTranslation('common');
  const role = useOptionalAuth()?.user?.role;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!done) return undefined;
    const id = setTimeout(() => setDone(false), SUCCESS_AUTO_CLEAR_MS);
    return () => clearTimeout(id);
  }, [done]);

  const confirm = useCallback(async () => {
    if (!jobId || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setErrorKey(null);
    const result = await abandonUpdateJob(authenticatedFetch, jobId);
    inFlight.current = false;
    if (!mounted.current) return;
    setBusy(false);
    setConfirming(false);
    if (result.kind === 'abandoned') {
      setDone(true);
      onAbandoned(result.job);
      return;
    }
    setErrorKey(abandonErrorKey(result.code, result.status, result.reason));
  }, [jobId, onAbandoned]);

  if (role !== 'owner' || !jobId) return null;

  const status = done && (
    <p role="status" className="flex items-center gap-2 text-xs font-medium text-foreground">
      <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span>{t(`${BASE}.done`)}</span>
    </p>
  );
  const error = errorKey && (
    <div role="alert" className={NOTICE}>
      <AlertCircle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{t(`${BASE}.errors.${errorKey}`)}</span>
    </div>
  );

  if (!job.abandonable) {
    const reason = job.abandonBlockedReason;
    const hint = reason && HINT_REASONS.includes(reason) ? reason : null;
    if (!hint && !status && !error) return null;
    return (
      <div className="space-y-2">
        {status}
        {error}
        {hint && <p className="text-xs text-muted-foreground">{t(`${BASE}.blocked.${hint}`)}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {status}
      {error}
      <button
        type="button"
        onClick={() => { setErrorKey(null); setConfirming(true); }}
        className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
      >
        <OctagonX aria-hidden="true" className="h-3.5 w-3.5" />
        <span>{t(`${BASE}.button`)}</span>
      </button>
      {confirming && (
        <SettingsConfirmDialog
          title={t(`${BASE}.confirmTitle`)}
          confirmLabel={t(`${BASE}.confirm`)}
          cancelLabel={t(`${BASE}.cancel`)}
          destructive
          busy={busy}
          onConfirm={() => void confirm()}
          onCancel={() => { if (!busy) setConfirming(false); }}
        >
          <p>{t(`${BASE}.confirmMessage`)}</p>
        </SettingsConfirmDialog>
      )}
    </div>
  );
}
