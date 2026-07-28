import { Bot, Wrench } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../lib/utils';
import { Tooltip } from '../../shared/view/ui';

import type { SessionAgent } from './types';
import { shortAgentName } from './utils';

type AgentChipProps = {
  agent: SessionAgent;
  t: TFunction;
};

/**
 * Shortens a model identifier for inline display inside a chip.
 * Drops common prefixes (claude-, claude-sonnet-, etc.) to keep it compact.
 * Examples:
 *   'claude-fable-5'       → 'fable-5'
 *   'claude-sonnet-4-6'    → 'sonnet-4-6'
 *   'claude-opus-4-7'      → 'opus-4-7'
 *   'claude-haiku-4-5'     → 'haiku-4-5'
 *   'gpt-4o'               → 'gpt-4o'
 */
function shortModelName(model: string): string {
  return model
    .replace(/^claude-/, '')
    .slice(0, 14);
}

export default function AgentChip({ agent, t }: AgentChipProps) {
  const isModel = agent.agent_kind === 'model';
  const Icon = isModel ? Bot : Wrench;
  const kindLabel = t(`participants.agentKinds.${agent.agent_kind}`, {
    defaultValue: agent.agent_kind,
  });

  // For subagents show the resolved model in the tooltip; for the coordinator
  // the agent_name IS the model so we only show it in the header line.
  const resolvedModel = agent.agent_model ?? null;
  // Show model inline only for subagents (where agent_name ≠ model).
  const showModelInline = !isModel && resolvedModel !== null;

  const tooltipContent = (
    <span className="flex flex-col gap-0.5 text-start">
      <span className="font-semibold">{agent.agent_name}</span>
      {resolvedModel && !isModel && (
        <span className="font-mono opacity-75">{resolvedModel}</span>
      )}
      <span className="opacity-80">{kindLabel}</span>
      <span className="opacity-70">
        {t('participants.invocations', {
          count: agent.invocation_count,
          defaultValue: '{{count}} invocations',
        })}
      </span>
    </span>
  );

  return (
    <Tooltip content={tooltipContent}>
      <span
        className={cn(
          'inline-flex max-w-[10rem] items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] leading-none',
          isModel
            ? 'border-primary/30 bg-primary/10 text-primary'
            : 'border-border bg-muted/60 text-muted-foreground',
        )}
        aria-label={
          resolvedModel && !isModel
            ? `${agent.agent_name} (${resolvedModel}) — ${kindLabel}`
            : `${agent.agent_name} — ${kindLabel}`
        }
      >
        <Icon className="h-3 w-3 flex-shrink-0" aria-hidden />
        <span className="truncate">{shortAgentName(agent.agent_name)}</span>
        {showModelInline && (
          <>
            <span aria-hidden className="opacity-40">·</span>
            <span className="truncate font-mono opacity-70">{shortModelName(resolvedModel)}</span>
          </>
        )}
        {!isModel && agent.invocation_count > 0 && (
          <span className="flex-shrink-0 opacity-70">×{agent.invocation_count}</span>
        )}
      </span>
    </Tooltip>
  );
}
