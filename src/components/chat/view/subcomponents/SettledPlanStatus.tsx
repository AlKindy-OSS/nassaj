/**
 * SettledPlanStatus — the status bar's finished state for a provider that
 * reports its plan once per turn (ADR-199 capability `plan: 'turn'`). The plan
 * arrives as the run ends, so it stays in the bar's place after the run stops
 * until the next human prompt. Static: no pulse, timer, estimate or STOP.
 * Same pill and tokens as ClaudeStatus; logical layout only, so it mirrors
 * under RTL by itself.
 */

import { ListChecks } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { resolveOverallPercent } from '../../hooks/declaredProgress';
import type { RunProgress } from '../../hooks/useRunProgress';

import PercentMeter from './PercentMeter';

interface SettledPlanStatusProps {
  /** A `settled` snapshot with at least one counted item. */
  progress: RunProgress;
  provider: string;
  /** Localized provider name, as ClaudeStatus shows it. */
  providerLabel: string;
}

export default function SettledPlanStatus({ progress, provider, providerLabel }: SettledPlanStatusProps) {
  const { t, i18n } = useTranslation('chat');
  const localeNum = (n: number) => n.toLocaleString(i18n.language);
  const { done, total, agentsDone, agentsTotal } = progress;
  const overall = resolveOverallPercent(progress);
  const heading = t('runProgress.settledLabel', { defaultValue: 'Plan at turn end' });
  const tasksText = t('runProgress.tasksTooltip', {
    done: localeNum(done),
    total: localeNum(total),
    defaultValue: 'Tasks: {{done}} of {{total}} done',
  });
  const agentsText = agentsTotal > 0
    ? t('runProgress.agentsTooltip', {
        done: localeNum(agentsDone),
        total: localeNum(agentsTotal),
        defaultValue: 'Sub-agents: {{done}}/{{total}}',
      })
    : null;
  const detail = [tasksText, agentsText].filter(Boolean).join(' · ');

  return (
    <div className="mb-3 w-full" data-testid="settled-plan-status">
      <section
        aria-label={`${heading}: ${detail}`}
        title={detail}
        className="mx-auto flex max-w-4xl items-center justify-between gap-3 overflow-hidden rounded-full border border-border/50 bg-muted px-3 py-1.5 shadow-sm"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/10">
            <SessionProviderLogo provider={provider} className="h-3.5 w-3.5" />
          </div>
          <div className="flex min-w-0 flex-col sm:flex-row sm:items-center sm:gap-2">
            <span className="truncate text-xs font-semibold text-foreground">{providerLabel}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <ListChecks className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{heading}</span>
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-md bg-background/60 px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {t('runProgress.tasksLabel', { defaultValue: 'Tasks' })} {localeNum(done)}/{localeNum(total)}
          </span>
          {overall && (
            <PercentMeter
              testId="settled-plan-percent"
              percent={overall.percent}
              declared={overall.source !== 'tasks'}
              label={t('runProgress.overallAria', { defaultValue: 'Overall progress' })}
              className="bg-background/60"
            />
          )}
        </div>
      </section>
    </div>
  );
}
