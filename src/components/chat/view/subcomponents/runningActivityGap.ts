import type { ChatMessage } from '../../types/types';

export type RunningActivityGap = {
  visible: boolean;
  lastActivityAt: number | null;
};

const HIDDEN: RunningActivityGap = { visible: false, lastActivityAt: null };

function timestampMs(value: unknown): number {
  const parsed = value instanceof Date
    ? value.getTime()
    : new Date(value as string | number).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * Detects a running reply whose only visible transcript events are hidden tool
 * calls. It reads the full transcript so pagination cannot create a false gap.
 */
export function getRunningActivityGap(
  messages: ChatMessage[],
  isStreaming: boolean,
  showToolCalls: boolean,
): RunningActivityGap {
  if (!isStreaming || showToolCalls || messages.length === 0) return HIDDEN;

  let boundaryIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === 'user' && !message.isToolUse && !message.originKind) {
      boundaryIndex = index;
      break;
    }
  }

  let lastActivityAt = Number.NEGATIVE_INFINITY;
  for (let index = messages.length - 1; index > boundaryIndex; index -= 1) {
    const message = messages[index];
    const hasAssistantText = message.type === 'assistant'
      && !message.isToolUse
      && !message.isThinking
      && String(message.content ?? '').trim().length > 0;
    if (hasAssistantText) return HIDDEN;
    if (!message.isToolUse) continue;

    lastActivityAt = Math.max(lastActivityAt, timestampMs(message.timestamp));
    for (const child of message.subagentState?.childTools ?? []) {
      lastActivityAt = Math.max(lastActivityAt, timestampMs(child.timestamp));
    }
  }

  return Number.isFinite(lastActivityAt)
    ? { visible: true, lastActivityAt }
    : HIDDEN;
}
