/**
 * ADR-216 §3.4 — owner-only "repair release-branch link" in the update dialog.
 *
 * Shown when /health offers the repair (`sourceAttachOffered`) or reports a
 * repaired link still awaiting its safe restart (`restartPending`). Every
 * server code maps to plain wording; the raw code appears only in a muted
 * details line. A success names the next step: confirm the queued safe
 * restart on the command board.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, GitBranch, Loader2 } from 'lucide-react';

import { useOptionalAuth } from '../../auth/context/AuthContext';
import type { OpenTerminals } from '../updateJobClient';
import { useSourceAttach, type SourceAttachOperation, type SourceAttachState } from '../useSourceAttach';

const BASE = 'versionUpdate.sourceAttach';
const STEPS = new Set(['inspect', 'quiescence', 'prove', 'lease', 'recheck', 'apply']);
const RESTART_CODES = new Set(['restart_row_job_bound', 'server_build_id_unavailable', 'restart_queue_failed']);
const ERROR_BOX = 'flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 '
  + 'dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200';
const OK_BOX = 'space-y-1 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 '
  + 'dark:border-green-800/50 dark:bg-green-950/30 dark:text-green-200';
const BUTTON = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium '
  + 'text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 '
  + 'focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

const SECONDARY = 'inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-card px-4 py-2 text-sm '
  + 'font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 '
  + 'focus-visible:ring-ring focus-visible:ring-offset-2';

type Translate = ReturnType<typeof useTranslation>['t'];

/** Plain message for a code; `fallback` is the state's generic sentence. */
function codeMessage(t: Translate, code: string | null, fallback: string): string {
  if (!code) return fallback;
  return t(`${BASE}.codes.${code}`, { defaultValue: fallback });
}

function Details({ code }: { code: string | null }) {
  const { t } = useTranslation('common');
  if (!code) return null;
  return (
    <p className="text-[11px] opacity-80">
      {t(`${BASE}.detailsLabel`)} <bdi dir="ltr" className="font-mono [overflow-wrap:anywhere]">{code}</bdi>
    </p>
  );
}

function Terminals({ terminals }: { terminals: OpenTerminals | null }) {
  const { t, i18n } = useTranslation('common');
  const count = terminals?.count ?? 0;
  const detached = terminals?.detached && terminals.detachedClosesAt !== null
    ? t('versionUpdate.autoActivate.detachedTerminals', {
      count: terminals.detached,
      time: new Date(terminals.detachedClosesAt).toLocaleTimeString(i18n.language, { hour: 'numeric', minute: '2-digit' }),
    })
    : null;
  return (
    <div className="space-y-1">
      <p>{t(`${BASE}.writersActive`, { count })}</p>
      {terminals?.usernames.length ? (
        <div>
          <p className="font-medium">{t(`${BASE}.writersActiveUsers`)}</p>
          <ul className="mt-0.5 list-disc space-y-0.5 ps-5">
            {terminals.usernames.map((name, index) => <li key={`${index}:${name}`}><bdi>{name}</bdi></li>)}
          </ul>
        </div>
      ) : null}
      {detached && <p>{detached}</p>}
    </div>
  );
}

function Succeeded({ operation }: { operation: SourceAttachOperation }) {
  const { t } = useTranslation('common');
  const restartCode = operation.restartCode && RESTART_CODES.has(operation.restartCode) ? operation.restartCode : 'unknown';
  const next = operation.restartActionId
    ? t(`${BASE}.${operation.restartReused ? 'restartReused' : 'restartQueued'}`)
    : t(`${BASE}.restartNotQueued.${restartCode}`);
  return (
    <div role="status" className={OK_BOX}>
      <p className="flex items-start gap-2 font-medium">
        <CheckCircle2 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{t(`${BASE}.succeeded`)}</span>
      </p>
      <p>{next}</p>
      {!operation.restartActionId && <Details code={operation.restartCode} />}
    </div>
  );
}

function Problem({ state }: { state: SourceAttachState }) {
  const { t } = useTranslation('common');
  const operation = state.operation;
  const code = state.phase === 'ineligible' ? state.info?.reason ?? null
    : state.phase === 'error' ? state.error : operation?.code ?? null;
  const fallback = state.phase === 'failed' ? t(`${BASE}.failedGeneric`)
    : state.phase === 'error' ? t(`${BASE}.codes.unknown`) : t(`${BASE}.refusedGeneric`);
  const writers = operation?.code === 'source_attach_writers_active';
  return (
    <div role="alert" className={ERROR_BOX}>
      <AlertCircle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="min-w-0 space-y-1">
        {writers ? <Terminals terminals={operation?.openTerminals ?? null} /> : <p>{codeMessage(t, code, fallback)}</p>}
        <Details code={code} />
      </div>
    </div>
  );
}

function Running({ state }: { state: SourceAttachState }) {
  const { t } = useTranslation('common');
  const raw = state.operation?.step;
  const step = t(`${BASE}.steps.${raw && STEPS.has(raw) ? raw : 'unknown'}`);
  return (
    <div role="status" aria-live="polite" className="space-y-1 text-xs text-muted-foreground">
      <p className="flex items-center gap-2 text-foreground">
        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        {state.phase === 'submitting' ? t(`${BASE}.starting`) : t(`${BASE}.running`, { step })}
      </p>
      <p>{t(`${BASE}.runningHint`)}</p>
    </div>
  );
}

interface SourceAttachActionProps {
  /** `/health.sourceAttachOffered`. */
  offered: boolean;
  /** `/health.restartPending`. */
  restartPending: boolean;
}

/** The repair card; renders nothing for a member or when /health offers nothing. */
export function SourceAttachAction({ offered, restartPending }: SourceAttachActionProps) {
  const { t } = useTranslation('common');
  const isOwner = useOptionalAuth()?.user?.role === 'owner';
  const enabled = isOwner && (offered || restartPending);
  const { state, start, reload } = useSourceAttach(enabled, restartPending);
  const resultRef = useRef<HTMLDivElement>(null);
  const terminal = state.phase === 'succeeded' || state.phase === 'refused' || state.phase === 'failed';

  // Move focus to the outcome so keyboard and screen-reader users land on it.
  useEffect(() => { if (terminal) resultRef.current?.focus(); }, [terminal]);

  if (!enabled) return null;
  const busy = state.phase === 'submitting' || state.phase === 'running';
  const canRetry = state.phase === 'refused' || state.phase === 'failed' || state.phase === 'error'
    || state.phase === 'ineligible';

  return (
    <section aria-labelledby="source-attach-title" className="space-y-3 rounded-md border border-border bg-muted/40 p-3"
      data-testid="source-attach">
      <h3 id="source-attach-title" className="flex items-center gap-2 text-sm font-medium text-foreground">
        <GitBranch aria-hidden="true" className="h-4 w-4 shrink-0" />
        {t(`${BASE}.title`)}
      </h3>
      {state.phase === 'restartPending' ? (
        <p role="status" className="text-xs text-foreground">{t(`${BASE}.restartPending`)}</p>
      ) : (
        <>
          {!terminal && <p className="text-xs text-muted-foreground">{t(`${BASE}.intro`)}</p>}
          {state.phase === 'loading' && <p role="status" className="text-xs text-muted-foreground">{t(`${BASE}.checking`)}</p>}
          {busy && <Running state={state} />}
          <div ref={resultRef} tabIndex={-1} className="focus:outline-none">
            {state.phase === 'succeeded' && state.operation && <Succeeded operation={state.operation} />}
            {canRetry && <Problem state={state} />}
          </div>
          {(state.phase === 'ready' || busy) && (
            <button type="button" className={BUTTON} onClick={() => void start()} disabled={busy} aria-busy={busy}>
              {busy && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
              {t(`${BASE}.button`)}
            </button>
          )}
          {canRetry && (
            <button type="button" className={SECONDARY} onClick={() => void reload()}>{t(`${BASE}.retry`)}</button>
          )}
        </>
      )}
    </section>
  );
}
