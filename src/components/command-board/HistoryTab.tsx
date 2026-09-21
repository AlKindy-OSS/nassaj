/**
 * HistoryTab — T-1684 · «العمليات السابقة»
 *
 * كل أمر انتهى — نجح أو فشل أو تعذّر التعرّف على نتيجته — يخرج من الطابور ويهبط
 * هنا، ويُحذف بعد ساعة من تنفيذه. الطابور صار يعني «ما ينتظر قراراً» وحده، ولذلك
 * وحده يُضيء الزرّ الأصفر.
 *
 * القراءة فقط هي الأصل هنا:
 * - «إعادة المحاولة» تظهر للأوامر المعلنة القابلة لإعادة التنفيذ فقط، وتمرّ بنفس
 *   مسار execute وبنفس تهدئة T-1296 — لا مسار ثانٍ.
 * - الأوامر الحرّة (raw) لا تُعاد من هنا إطلاقاً (ADR-070 §16): بوابة التنفيذ
 *   الوحيدة هي ExecReviewDialog على صفٍّ في الطابور، لا سجلّ في التاريخ.
 * - صفّ نتيجته «غير مؤكد» لا يُزال يدوياً: إزالته تمحو الدليل الوحيد على أن
 *   محاولةً جرت، والمهلة الساعية تكفي.
 *
 * النصّ ثنائي الاتجاه: العنوان محتوى (dir="auto")، والأمر ومخرجاته ASCII/كود
 * تُعرض dir="ltr" مع عزل bidi حتى لا تُعاد ترتيب سطورها داخل صفحة عربية.
 */
import { useState } from 'react';
import type { TFunction } from 'i18next';
import { CheckCircle, ChevronDown, ChevronUp, Clock, History, XCircle } from 'lucide-react';

import { Button } from '../../shared/view/ui';
import type { HistoryEntry } from '../../hooks/useServerActions';
import { formatAge } from '../../utils/relativeAge';

import { resolveOutcomeMessageKey } from './actionErrorKey';

export type HistoryTabProps = {
  entries: readonly HistoryEntry[];
  isOwner: boolean;
  /** Shared clock, so every row's countdown moves in one step. */
  now: number;
  /** T-1296 — a restart was just requested; no retry may re-arm inside it. */
  cooldownActive: boolean;
  cooldownSeconds: number;
  /** Row currently awaiting a retry or a removal round-trip. */
  busyId: string | null;
  onRetry: (entry: HistoryEntry) => void;
  onRemove: (entry: HistoryEntry) => void;
  t: TFunction;
};

const OUTCOME_BADGE: Record<HistoryEntry['outcome'], { className: string; icon: typeof CheckCircle; key: string }> = {
  success: {
    className: 'bg-success/10 text-success',
    icon: CheckCircle,
    key: 'pendingActions.historyOutcomeSuccess',
  },
  failure: {
    className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    icon: XCircle,
    key: 'pendingActions.historyOutcomeFailure',
  },
  unknown: {
    className: 'bg-muted text-muted-foreground',
    icon: Clock,
    key: 'pendingActions.historyOutcomeUnknown',
  },
};

function OutcomeBadge({ outcome, t }: { outcome: HistoryEntry['outcome']; t: TFunction }) {
  const { className, icon: Icon, key } = OUTCOME_BADGE[outcome];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${className}`}>
      <Icon className="h-2.5 w-2.5" aria-hidden="true" />
      {t(key)}
    </span>
  );
}

/** «يُحذف بعد N د» — the client's own read of the server's hourly sweep. */
function expiryLabel(entry: HistoryEntry, now: number, t: TFunction): string | null {
  const expiry = Date.parse(entry.expiresAt);
  if (Number.isNaN(expiry)) return null;
  const minutes = Math.ceil((expiry - now) / 60_000);
  return minutes <= 1
    ? t('pendingActions.historyExpiresSoon')
    : t('pendingActions.historyExpiresIn', { minutes });
}

function ageLabel(entry: HistoryEntry, now: number, t: TFunction): string | null {
  const executed = Date.parse(entry.executedAt);
  if (Number.isNaN(executed)) return null;
  const age = formatAge(Math.max(0, (now - executed) / 1000), t as (key: string, opts?: Record<string, unknown>) => string);
  return t('pendingActions.historyExecutedAgo', { age });
}

/** stdout/stderr tails of a raw command, folded away until asked for. */
function OutputBlock({ entry, t }: { entry: HistoryEntry; t: TFunction }) {
  const [open, setOpen] = useState(false);
  const hasOutput = Boolean(entry.stdoutTail || entry.stderrTail);
  if (!hasOutput) return null;
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        <Chevron className="h-3 w-3" aria-hidden="true" />
        {t(open ? 'pendingActions.historyOutputHide' : 'pendingActions.historyOutputShow')}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1.5">
          {entry.stdoutTail && (
            <div>
              <p className="text-[10px] font-medium text-muted-foreground">{t('pendingActions.historyStdout')}</p>
              <pre dir="ltr" style={{ unicodeBidi: 'isolate' }}
                className="mt-0.5 max-h-40 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-[11px] text-foreground">
                {entry.stdoutTail}
              </pre>
            </div>
          )}
          {entry.stderrTail && (
            <div>
              <p className="text-[10px] font-medium text-muted-foreground">{t('pendingActions.historyStderr')}</p>
              <pre dir="ltr" style={{ unicodeBidi: 'isolate' }}
                className="mt-0.5 max-h-40 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-[11px] text-foreground">
                {entry.stderrTail}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Retry is offered only where re-running is defined: a declared action the
 * server itself marked retryable. Never for raw shell text, never for an
 * outcome nobody could confirm.
 */
function canRetry(entry: HistoryEntry, isOwner: boolean): boolean {
  return isOwner && entry.kind === 'action' && entry.retryable && entry.outcome !== 'unknown';
}

/** Removing an unconfirmed attempt would erase the only proof it happened. */
function canRemove(entry: HistoryEntry, isOwner: boolean): boolean {
  return isOwner && !(entry.kind === 'action' && entry.outcome === 'unknown');
}

function HistoryRow({ entry, isOwner, now, cooldownActive, cooldownSeconds, busyId, onRetry, onRemove, t }: HistoryTabProps & { entry: HistoryEntry }) {
  const expiry = expiryLabel(entry, now, t);
  const age = ageLabel(entry, now, t);
  // A plain success needs no sentence; a request fulfilled by another execution does.
  const message = entry.outcome === 'success' && entry.reasonCode !== 'satisfied_by_other_execution'
    ? null
    : t(`pendingActions.${resolveOutcomeMessageKey(entry.outcome, entry.reasonCode)}`);
  const retryBlocked = cooldownActive && entry.actionType === 'safe-restart';

  return (
    <div className="border-b border-border/60 px-5 py-4 last:border-b-0">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <OutcomeBadge outcome={entry.outcome} t={t} />
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          {t(entry.kind === 'raw' ? 'pendingActions.historyKindRaw' : 'pendingActions.historyKindAction')}
        </span>
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground" dir="auto" title={entry.label}>
          {entry.label}
        </p>
      </div>

      {entry.commandPreview && (
        <pre dir="ltr" style={{ unicodeBidi: 'isolate' }}
          className="mb-2 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
          {entry.commandPreview}
        </pre>
      )}

      {message && (
        <p className={`mb-2 text-xs ${entry.outcome === 'failure' ? 'text-destructive' : 'text-muted-foreground'}`}>
          {message}
        </p>
      )}

      {entry.exitCode !== undefined && (
        <p className="mb-1 font-mono text-[11px] text-muted-foreground" dir="ltr">
          {t('pendingActions.historyExitCode', { code: entry.exitCode ?? '?' })}
        </p>
      )}

      <OutputBlock entry={entry} t={t} />

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {age && <span>{age}</span>}
        {expiry && <span>{expiry}</span>}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {canRetry(entry, isOwner) && !retryBlocked && (
          <Button variant="outline" className="h-7 px-3 text-xs"
            disabled={busyId === entry.id}
            onClick={() => onRetry(entry)}>
            {t('restart.retry')}
          </Button>
        )}
        {canRetry(entry, isOwner) && retryBlocked && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground" role="status">
            <Clock className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
            {t('pendingActions.restartCooldown', { seconds: cooldownSeconds })}
          </p>
        )}
        {canRemove(entry, isOwner) && (
          <Button variant="ghost" className="h-7 px-3 text-xs text-muted-foreground hover:text-destructive"
            disabled={busyId === entry.id}
            onClick={() => onRemove(entry)}>
            {t('pendingActions.historyRemove')}
          </Button>
        )}
      </div>
    </div>
  );
}

export function HistoryTab(props: HistoryTabProps) {
  const { entries, t } = props;

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-5 py-10 text-center">
        <History className="h-5 w-5 text-muted-foreground/60" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{t('pendingActions.historyEmpty')}</p>
        <p className="text-xs text-muted-foreground/80">{t('pendingActions.historyRetentionNote')}</p>
      </div>
    );
  }

  return (
    <div>
      <p className="border-b border-border/60 px-5 py-2.5 text-[11px] text-muted-foreground">
        {t('pendingActions.historyRetentionNote')}
      </p>
      {entries.map(entry => <HistoryRow key={`${entry.kind}:${entry.id}`} {...props} entry={entry} />)}
    </div>
  );
}

export default HistoryTab;
