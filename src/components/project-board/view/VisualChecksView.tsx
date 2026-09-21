import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Bug,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  XCircle,
} from 'lucide-react';

import { cn } from '../../../lib/utils';
import type {
  BoardVisualCheck,
  ProjectBoardState,
  VisualCheckStatus,
} from '../types';

type VisualChecksViewProps = {
  state: ProjectBoardState;
};

const STATUS_STYLES: Record<VisualCheckStatus, string> = {
  pending: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  verified: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30',
  failed: 'bg-destructive/10 text-destructive border-destructive/30',
};

/** Small status pill (icon + localized label). */
function StatusBadge({ status }: { status: VisualCheckStatus }) {
  const { t } = useTranslation('projectBoard');
  return (
    <span
      className={cn(
        'inline-flex flex-shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
        STATUS_STYLES[status] ?? STATUS_STYLES.pending,
      )}
    >
      {status === 'verified' && <CheckCircle2 className="h-3 w-3" />}
      {status === 'pending' && <Clock className="h-3 w-3" />}
      {status === 'failed' && <XCircle className="h-3 w-3" />}
      {t(`visualChecks.status.${status}`, { defaultValue: status })}
    </span>
  );
}

/** Monospace link chip for an originating task / sprint / issue id. */
function LinkChip({
  id,
  variant,
}: {
  id: string;
  variant: 'task' | 'sprint' | 'issue';
}) {
  const isIssue = variant === 'issue';
  return (
    <span
      dir="ltr"
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-mono text-[10px] font-medium',
        isIssue
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-border bg-muted text-muted-foreground',
      )}
    >
      {isIssue && <Bug className="h-2.5 w-2.5" />}
      {id}
    </span>
  );
}

function VisualCheckCard({ check }: { check: BoardVisualCheck }) {
  const { t } = useTranslation('projectBoard');

  return (
    <div className="rounded-lg border border-border/60 bg-card p-3">
      <div className="flex flex-wrap items-start gap-2">
        <StatusBadge status={check.status} />
        <span className="font-mono text-[10px] text-muted-foreground" dir="ltr">
          {check.id}
        </span>
        {/* Origin chips — the heart of this view: where each check came from. */}
        <span className="ms-auto flex flex-wrap items-center gap-1.5">
          {check.task && <LinkChip id={check.task} variant="task" />}
          {check.sprint && <LinkChip id={check.sprint} variant="sprint" />}
          {check.issue && <LinkChip id={check.issue} variant="issue" />}
        </span>
      </div>

      <dl className="mt-2 space-y-1.5 text-xs">
        <div className="flex gap-1.5">
          <dt className="flex-shrink-0 font-medium text-muted-foreground">
            {t('visualChecks.step')}:
          </dt>
          <dd className="text-foreground">{check.step}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="flex-shrink-0 font-medium text-muted-foreground">
            {t('visualChecks.expect')}:
          </dt>
          <dd className="text-foreground">{check.expect}</dd>
        </div>
      </dl>

      {check.warning && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-600/90 dark:text-amber-400/90">
          <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span>{check.warning}</span>
        </p>
      )}

      {check.result && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          <span className="font-medium">{t('visualChecks.result')}:</span> {check.result}
        </p>
      )}
    </div>
  );
}

type PhaseGroup = { key: string; title: string | null; checks: BoardVisualCheck[] };

/** Groups checks by phase, ordered like `state.phases`; unknown phases trail. */
function groupByPhase(state: ProjectBoardState, checks: BoardVisualCheck[]): PhaseGroup[] {
  const groups = new Map<string, BoardVisualCheck[]>();
  for (const check of checks) {
    const key = check.phase ?? '';
    groups.set(key, [...(groups.get(key) ?? []), check]);
  }
  const ordered: PhaseGroup[] = [];
  for (const phase of state.phases ?? []) {
    const own = groups.get(phase.id);
    if (own) {
      ordered.push({ key: phase.id, title: phase.title, checks: own });
      groups.delete(phase.id);
    }
  }
  for (const [key, rest] of groups) {
    ordered.push({ key, title: null, checks: rest });
  }
  return ordered;
}

function PhaseSection({ group }: { group: PhaseGroup }) {
  const { t } = useTranslation('projectBoard');
  const verified = group.checks.filter((check) => check.status === 'verified').length;
  const total = group.checks.length;

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {group.key && (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {group.key}
          </span>
        )}
        {group.title && (
          <h3 className="text-sm font-semibold text-foreground">{group.title}</h3>
        )}
        <span className="ms-auto rounded-full bg-muted px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {t('visualChecks.counter', { verified, total })}
        </span>
      </div>
      <div className="space-y-2">
        {group.checks.map((check) => (
          <VisualCheckCard key={check.id} check={check} />
        ))}
      </div>
    </section>
  );
}

/**
 * Read-only "Visual Checks" tab: the owner's visual checklist grouped by phase,
 * every item linked back to the task/sprint/issue that created it. No write
 * actions — the board only renders state.visual_checks (schema 1.3).
 */
export default function VisualChecksView({ state }: VisualChecksViewProps) {
  const { t } = useTranslation('projectBoard');
  const checks = useMemo(() => state.visual_checks ?? [], [state.visual_checks]);
  const groups = useMemo(() => groupByPhase(state, checks), [state, checks]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-8 px-4 py-5 sm:px-6">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold text-foreground">
            {t('visualChecks.title')}
          </h2>
        </div>

        {groups.length ? (
          groups.map((group) => <PhaseSection key={group.key || '__none__'} group={group} />)
        ) : (
          <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-[11px] text-muted-foreground">
            {t('visualChecks.empty')}
          </p>
        )}
      </div>
    </div>
  );
}
