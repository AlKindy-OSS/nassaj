import type { TFunction } from 'i18next';

/**
 * B-1665: one localized title for a sub-agent card. A missing type or
 * description is simply left out; nothing invents an English placeholder such
 * as "Agent: Running task" that later changes once the full payload arrives.
 */
export function formatSubagentTitle(t: TFunction, type?: string | null, description?: string | null): string {
  const cleanType = typeof type === 'string' ? type.trim() : '';
  const cleanDescription = typeof description === 'string' ? description.trim() : '';
  const prefix = cleanType ? t('subagent.titleWithType', { type: cleanType }) : t('subagent.title');
  return cleanDescription ? t('subagent.titleWithTask', { prefix, description: cleanDescription }) : prefix;
}
