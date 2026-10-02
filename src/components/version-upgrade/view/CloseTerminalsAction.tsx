/**
 * B-1448 slice 2 — the owner's "close N terminals and update".
 *
 * Shown under the terminal-wait message while `autoActivation.state` is
 * `waiting_terminals`, and only to the owner (the endpoint is owner-only; a
 * member sees the wait message alone). The click never closes anything by
 * itself: it opens a confirmation that names the count and the holders and
 * warns that unsaved terminal work is lost. The confirm echoes the snapshot of
 * exactly that set; a changed set comes back for a fresh confirmation.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, SquareTerminal } from 'lucide-react';

import { useOptionalAuth } from '../../auth/context/AuthContext';
import type { OpenTerminals } from '../updateJobClient';
import { closeTerminalsErrorKey, useCloseTerminals, type CloseTerminalsError } from '../useCloseTerminals';

interface CloseTerminalsActionProps {
  /** Extracted from statusUrl; the action is hidden without it. */
  jobId: string | null;
  /** The set the status poll shows now. */
  openTerminals: OpenTerminals | null;
}

const BASE = 'versionUpdate.closeTerminals';
/** The modal's own error-notice style: token contrast >= 4.5:1 in light and dark. */
const NOTICE = 'flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 '
  + 'dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200';

function ErrorNotice({ error }: { error: CloseTerminalsError }) {
  const { t } = useTranslation('common');
  const key = closeTerminalsErrorKey(error);
  return (
    <div role="alert" className={NOTICE}>
      <AlertCircle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{t(`${BASE}.errors.${key}`, { code: error.code || String(error.status) })}</span>
    </div>
  );
}

interface ConfirmationProps {
  terminals: OpenTerminals | null;
  changed: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function Confirmation({ terminals, changed, busy, onConfirm, onCancel }: ConfirmationProps) {
  const { t } = useTranslation('common');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const count = terminals?.count ?? 0;

  // Move focus to the confirmation on open and again when the set changed, so
  // a screen reader reads the fresh list before the owner confirms again.
  useEffect(() => { headingRef.current?.focus(); }, [changed, terminals?.snapshot]);

  return (
    <div role="group" aria-labelledby="close-terminals-title" className="space-y-2 rounded-md border border-border bg-card p-3">
      <h4 id="close-terminals-title" ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-foreground focus:outline-none">
        {t(`${BASE}.confirmTitle`)}
      </h4>
      {changed && <p role="alert" className="text-xs font-medium text-foreground">{t(`${BASE}.changed`)}</p>}
      <p className="text-xs text-muted-foreground">{t(`${BASE}.confirmMessage`, { count })}</p>
      {terminals?.usernames.length ? (
        <div className="text-xs text-foreground">
          <p className="font-medium">{t(`${BASE}.usersLabel`)}</p>
          <ul className="mt-1 list-disc space-y-0.5 ps-5">
            {terminals.usernames.map((name, index) => <li key={`${index}:${name}`}><bdi>{name}</bdi></li>)}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t(`${BASE}.noUsers`)}</p>
      )}
      <p className={NOTICE}>
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{t(`${BASE}.warning`)}</span>
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          aria-busy={busy || undefined}
          className="flex items-center gap-2 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-red-700 dark:hover:bg-red-800"
        >
          {busy && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
          <span>{busy ? t(`${BASE}.closing`) : t(`${BASE}.confirm`, { count })}</span>
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md bg-muted px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t(`${BASE}.cancel`)}
        </button>
      </div>
    </div>
  );
}

export function CloseTerminalsAction({ jobId, openTerminals }: CloseTerminalsActionProps) {
  const { t } = useTranslation('common');
  const auth = useOptionalAuth();
  const state = useCloseTerminals(jobId, openTerminals);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  // Cancelling returns focus to the button that opened the confirmation.
  useEffect(() => {
    if (wasConfirming.current && state.phase === 'idle') triggerRef.current?.focus();
    wasConfirming.current = state.phase === 'confirming' || state.phase === 'closing';
  }, [state.phase]);

  if (auth?.user?.role !== 'owner' || !jobId) return null;

  const result = (
    <p role="status" className="flex items-center gap-2 text-xs font-medium text-foreground">
      <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span>
        {state.remainingCount > 0
          ? t(`${BASE}.doneRemaining`, {
            count: state.remainingCount,
            closedLabel: t(`${BASE}.terminalsUnit`, { count: state.closedCount }),
          })
          : t(`${BASE}.done`, { count: state.closedCount })}
      </span>
    </p>
  );

  if (state.phase === 'done') return result;

  if (state.phase === 'confirming' || state.phase === 'closing') {
    return (
      <div className="space-y-2">
        <Confirmation
          terminals={state.confirmSet}
          changed={state.changed}
          busy={state.phase === 'closing'}
          onConfirm={() => void state.confirm()}
          onCancel={state.cancel}
        />
        {state.error && <ErrorNotice error={state.error} />}
      </div>
    );
  }

  if (!openTerminals) return null;
  return (
    <div className="space-y-2">
      {/* Terminals still (or again) open after a close: keep its outcome in view. */}
      {state.remainingCount > 0 && result}
      {state.error && <ErrorNotice error={state.error} />}
      <button
        ref={triggerRef}
        type="button"
        onClick={state.open}
        className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
      >
        <SquareTerminal aria-hidden="true" className="h-3.5 w-3.5" />
        <span>{t(`${BASE}.button`, { count: openTerminals.count })}</span>
      </button>
    </div>
  );
}
