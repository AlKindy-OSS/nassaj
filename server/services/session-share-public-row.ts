/**
 * The one allow-list deciding which normalized history rows a public share
 * may show (ADR-196, reused by ADR-205 live links). Provider-neutral: it reads
 * only normalized `kind`, `role` and machine-routing markers.
 */
import type { NormalizedMessage } from '@/shared/types.js';

/** Any truthy marker makes a row machine routing (subagent, replay, local command), never shared prose. */
export const SUBAGENT_MARKERS = [
  'originKind', 'parentToolUseId', 'parent_tool_use_id', 'isSidechain', 'agentId', 'subagentId',
  'isSubagent', 'isMeta', 'isSynthetic', 'isReplay', 'isCompactSummary', 'isLocalCommand',
  'isLocalCommandStdout', 'isTaskNotification', 'isSkillLoad',
  // ADR-199: any row carrying subagent lifecycle is machine routing, never shared prose.
  'subagent',
] as const;

/** True for a human/assistant text row with no machine-routing marker. */
export function isPublicRow(message: NormalizedMessage): boolean {
  if (message.kind !== 'text' || (message.role !== 'user' && message.role !== 'assistant')) return false;
  return SUBAGENT_MARKERS.every((key) => !message[key]);
}
