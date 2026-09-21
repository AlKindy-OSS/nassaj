import { useTranslation } from 'react-i18next';
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';

import { cn } from '../../../lib/utils';
import type {
  BoardKeyResult,
  BoardKpi,
  BoardObjective,
  ObjectiveStatus,
  ProjectBoardState,
} from '../types';

type ObjectivesViewProps = {
  state: ProjectBoardState;
};

/** RAG status palette: on_track green / at_risk amber / off_track red / done gray. */
const OBJECTIVE_STYLES: Record<ObjectiveStatus, string> = {
  on_track: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30',
  at_risk: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  off_track: 'bg-destructive/10 text-destructive border-destructive/30',
  done: 'bg-muted text-muted-foreground border-border',
};

/** KR score per spec: min(current/target, 1), clamped to 0; target ≤ 0 → met-or-not. */
function keyResultScore(kr: BoardKeyResult): number {
  const current = Number(kr.current) || 0;
  const target = Number(kr.target) || 0;
  if (target > 0) {
    return Math.min(Math.max(current / target, 0), 1);
  }
  return current >= target ? 1 : 0;
}

/**
 * Whether a KPI meets its target given its direction: up → current below
 * target is negative; down → current above target is negative.
 */
function kpiOnTarget(kpi: BoardKpi): boolean | null {
  if (typeof kpi.current !== 'number' || typeof kpi.target !== 'number' || !kpi.direction) {
    return null;
  }
  return kpi.direction === 'down' ? kpi.current <= kpi.target : kpi.current >= kpi.target;
}

function formatValue(value: number | undefined, locale: string): string {
  return typeof value === 'number' ? value.toLocaleString(locale) : '—';
}

function KeyResultRow({ kr }: { kr: BoardKeyResult }) {
  const { t, i18n } = useTranslation('projectBoard');
  const score = keyResultScore(kr);
  const percent = Math.round(score * 100);

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-[10px] text-muted-foreground">{kr.id}</span>
        <span className="text-xs text-foreground">{kr.title}</span>
        <span className="ms-auto text-[11px] tabular-nums text-muted-foreground">
          {formatValue(kr.current, i18n.language)} / {formatValue(kr.target, i18n.language)}
          {kr.unit ? ` ${kr.unit}` : ''}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="w-9 text-end text-[11px] tabular-nums text-muted-foreground">
          {percent}%
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] text-muted-foreground">
        {typeof kr.baseline === 'number' && (
          <span>{t('objectives.baseline', { value: formatValue(kr.baseline, i18n.language) })}</span>
        )}
        {kr.updated && <span>{t('updated', { date: kr.updated })}</span>}
      </div>
    </div>
  );
}

function ObjectiveCard({ objective }: { objective: BoardObjective }) {
  const { t } = useTranslation('projectBoard');
  const keyResults = objective.keyResults ?? [];

  return (
    <div className="rounded-xl border border-border/60 bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">{objective.id}</span>
        <span className="text-sm font-medium text-foreground">{objective.title}</span>
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 text-[10px] font-medium',
            OBJECTIVE_STYLES[objective.status] ?? OBJECTIVE_STYLES.done,
          )}
        >
          {t(`objectives.statuses.${objective.status}`, { defaultValue: objective.status })}
        </span>
        <span className="ms-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          {objective.horizon && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              {objective.horizon}
            </span>
          )}
          {objective.owner && <span>{objective.owner}</span>}
        </span>
      </div>
      {keyResults.length > 0 && (
        <div className="mt-3 space-y-3">
          {keyResults.map((kr) => (
            <KeyResultRow key={kr.id} kr={kr} />
          ))}
        </div>
      )}
    </div>
  );
}

function KpiCard({ kpi }: { kpi: BoardKpi }) {
  const { t, i18n } = useTranslation('projectBoard');
  const onTarget = kpiOnTarget(kpi);
  const DirectionIcon = kpi.direction === 'down' ? TrendingDown : kpi.direction === 'up' ? TrendingUp : Minus;

  return (
    <div className="rounded-xl border border-border/60 bg-card p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-foreground" title={kpi.name}>
          {kpi.name}
        </span>
        <DirectionIcon
          aria-hidden
          className={cn(
            'h-3.5 w-3.5 flex-shrink-0',
            onTarget === true && 'text-green-600 dark:text-green-400',
            onTarget === false && 'text-destructive',
            onTarget === null && 'text-muted-foreground',
          )}
        />
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span
          className={cn(
            'text-xl font-semibold tabular-nums',
            onTarget === true && 'text-green-600 dark:text-green-400',
            onTarget === false && 'text-destructive',
            onTarget === null && 'text-foreground',
          )}
        >
          {formatValue(kpi.current, i18n.language)}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {t('kpis.target', { value: formatValue(kpi.target, i18n.language) })}
          {kpi.unit ? ` ${kpi.unit}` : ''}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
        <span className="font-mono">{kpi.id}</span>
        {kpi.linked && <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{kpi.linked}</span>}
        {kpi.updated && <span>{t('updated', { date: kpi.updated })}</span>}
      </div>
    </div>
  );
}

/** Execution-plan tab: OKR objective cards with KR progress bars + KPI grid. */
export default function ObjectivesView({ state }: ObjectivesViewProps) {
  const { t } = useTranslation('projectBoard');
  const objectives = state.objectives ?? [];
  const kpis = state.kpis ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-8 px-4 py-5 sm:px-6">
        {objectives.length > 0 && (
          <section>
            <h3 className="mb-3 text-sm font-semibold text-foreground">{t('objectives.title')}</h3>
            <div className="space-y-3">
              {objectives.map((objective) => (
                <ObjectiveCard key={objective.id} objective={objective} />
              ))}
            </div>
          </section>
        )}

        {kpis.length > 0 && (
          <section>
            <h3 className="mb-3 text-sm font-semibold text-foreground">{t('kpis.title')}</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {kpis.map((kpi) => (
                <KpiCard key={kpi.id} kpi={kpi} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
