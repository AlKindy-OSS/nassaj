import type { TFunction } from 'i18next';

import { cn } from '../../lib/utils';
import { Tooltip } from '../../shared/view/ui';

import AgentChip from './AgentChip';
import type { SessionAgent } from './types';

type AgentChipRowProps = {
  agents: SessionAgent[];
  // Models first, then by invocation count desc; remaining collapse to "+N".
  max?: number;
  t: TFunction;
  className?: string;
};

/** Models (agent_kind='model') first, then by invocation_count descending. */
function orderAgents(agents: SessionAgent[]): SessionAgent[] {
  return [...agents].sort((a, b) => {
    const modelA = a.agent_kind === 'model' ? 1 : 0;
    const modelB = b.agent_kind === 'model' ? 1 : 0;
    if (modelA !== modelB) {
      return modelB - modelA;
    }
    return b.invocation_count - a.invocation_count;
  });
}

/**
 * Compact summary badge showing "N agents · M calls".
 *
 * "agents" = count of distinct subagent types (agent_kind === 'subagent').
 * "calls"  = sum of all invocation_counts across those subagents.
 *
 * The base model row (agent_kind === 'model') is excluded from both numbers
 * because it is not "called" the same way — it is the coordinator model.
 */
function AgentSummaryBadge({
  agents,
  t,
}: {
  agents: SessionAgent[];
  t: TFunction;
}) {
  const subagents = agents.filter((a) => a.agent_kind === 'subagent');
  const distinctCount = subagents.length;
  const totalCalls = subagents.reduce((sum, a) => sum + a.invocation_count, 0);

  // Hide summary if there are no sub-agents at all.
  if (distinctCount === 0) return null;

  const agentsLabel = t('participants.agentSummary', {
    count: distinctCount,
    defaultValue_one: '{{count}} agent',
    defaultValue_other: '{{count}} agents',
  });
  const callsLabel = t('participants.totalInvocations', {
    count: totalCalls,
    defaultValue_one: '{{count}} call',
    defaultValue_other: '{{count}} calls',
  });

  // Build per-agent breakdown for the tooltip.
  // Manual concatenation keeps pluralisation rules from the existing
  // `participants.invocations` key intact (critical for Arabic plurals)
  // while prepending the agent name — avoids duplicating all plural forms.
  const breakdown = [...subagents]
    .sort((a, b) => b.invocation_count - a.invocation_count)
    .map(
      (a) =>
        `${a.agent_name}: ${t('participants.invocations', { count: a.invocation_count })}`,
    );

  const tooltipContent = (
    <span className="flex flex-col gap-0.5 text-start">
      <span className="font-semibold">
        {t('participants.agentSummaryAria', {
          agents: distinctCount,
          calls: totalCalls,
          defaultValue: '{{agents}} distinct agents · {{calls}} total calls',
        })}
      </span>
      {breakdown.map((line, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <span key={i} className="opacity-80">
          {line}
        </span>
      ))}
    </span>
  );

  return (
    <Tooltip content={tooltipContent}>
      <span
        className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px] leading-none text-muted-foreground"
        aria-label={t('participants.agentSummaryAria', {
          agents: distinctCount,
          calls: totalCalls,
          defaultValue: '{{agents}} distinct agents · {{calls}} total calls',
        })}
      >
        <span className="font-medium text-foreground/80">{agentsLabel}</span>
        <span aria-hidden className="opacity-40">·</span>
        <span>{callsLabel}</span>
      </span>
    </Tooltip>
  );
}

export default function AgentChipRow({ agents, max = 3, t, className }: AgentChipRowProps) {
  if (agents.length === 0) {
    return null;
  }

  const ordered = orderAgents(agents);
  const visible = ordered.slice(0, max);
  const overflow = ordered.slice(max);

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {/* Summary badge: distinct agents + total invocations */}
      <AgentSummaryBadge agents={agents} t={t} />

      {/* Individual agent chips */}
      {visible.map((agent) => (
        <AgentChip key={`${agent.agent_kind}:${agent.agent_name}`} agent={agent} t={t} />
      ))}
      {overflow.length > 0 && (
        <Tooltip
          content={
            <span className="flex flex-col gap-0.5 text-start">
              {overflow.map((agent) => (
                <span key={`${agent.agent_kind}:${agent.agent_name}`}>
                  {agent.agent_name} ({agent.invocation_count})
                </span>
              ))}
            </span>
          }
        >
          <span className="inline-flex items-center rounded-full border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
            +{overflow.length}
          </span>
        </Tooltip>
      )}
    </div>
  );
}
