import type { TFunction } from 'i18next';

/**
 * T-2071: the display label of a sub-agent type. Types are identifiers shown as
 * they are, except the built-in `fork` (CLI 2.1.302 turns fork subagents on in
 * -p/SDK), which gets a translated label. Empty when there is no type.
 */
export function subagentTypeLabel(t: TFunction, type?: string | null): string {
  const cleanType = typeof type === 'string' ? type.trim() : '';
  return cleanType === 'fork' ? t('subagent.forkType') : cleanType;
}

/**
 * B-1665: one localized title for a sub-agent card. A missing type or
 * description is simply left out; nothing invents an English placeholder such
 * as "Agent: Running task" that later changes once the full payload arrives.
 */
export function formatSubagentTitle(t: TFunction, type?: string | null, description?: string | null): string {
  const label = subagentTypeLabel(t, type);
  const cleanDescription = typeof description === 'string' ? description.trim() : '';
  const prefix = label ? t('subagent.titleWithType', { type: label }) : t('subagent.title');
  return cleanDescription ? t('subagent.titleWithTask', { prefix, description: cleanDescription }) : prefix;
}
