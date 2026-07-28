import type { ChatMessage } from '../../types/types';

/**
 * runningActivityGap — detects the "silent running" state behind T-836: the
 * current reply is still in flight (`isLoading`) but every event emitted so
 * far this turn is a tool_use row (Bash/Read/Edit/Task/...), with NO assistant
 * text yet. When `hideToolCalls` (default ON, see useUiPreferences) is active
 * those tool cards are not even rendered, so the message list can look
 * completely empty/stalled even though the agent is actively working.
 *
 * `getRunningActivityGap` is a pure function over the FULL transcript (same
 * array useRunProgress consumes, never the windowed `visibleMessages`) so a
 * long tool-only reply is still detected even once its early events have
 * scrolled out of the visible window.
 */

/** Read a timestamp (string | number | Date) as epoch ms; invalid → -Infinity. */
function tsMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const ms = new Date(value as string | number).getTime();
  return Number.isFinite(ms) ? ms : -Infinity;
}

export interface RunningActivityGap {
  /** Whether the "agent is working — last activity Y ago" card should show. */
  visible: boolean;
  /** Epoch ms of the most recent tool_use event this reply, or null when hidden. */
  lastActivityAt: number | null;
}

const HIDDEN: RunningActivityGap = { visible: false, lastActivityAt: null };

/**
 * @param chatMessages full transcript (NOT the windowed visibleMessages) —
 *   same contract as useRunProgress.
 * @param isLoading whether a run is currently in flight; the card never shows
 *   once the run ends (matches "4. لا يكسر العرض العادي … غير الجارية").
 */
export function getRunningActivityGap(
  chatMessages: ChatMessage[],
  isLoading: boolean,
): RunningActivityGap {
  if (!isLoading || chatMessages.length === 0) {
    return HIDDEN;
  }

  // Current-reply boundary: index of the last GENUINE human user prompt (same
  // discriminator as useRunProgress's T-170 boundary) — a written prompt is
  // `type:'user'` with no `isToolUse` and no `originKind`. Coordinator→sub-agent
  // prompts and tool_results never match, so the scan is bounded to this reply.
  let boundaryIndex = -1;
  for (let i = chatMessages.length - 1; i >= 0; i--) {
    const m = chatMessages[i];
    if (m.type === 'user' && !m.isToolUse && !m.originKind) {
      boundaryIndex = i;
      break;
    }
  }

  let lastToolActivityAt = -Infinity;

  // Tail→head pass over the current reply only. Stops the instant real
  // assistant text is found scanning backward — "3. يختفي فور ظهور نص
  // assistant" means ANY text row anywhere in this reply hides the card, even
  // if more tool_use rows followed it with no further text.
  for (let i = chatMessages.length - 1; i > boundaryIndex; i--) {
    const msg = chatMessages[i];

    const isRealAssistantText =
      msg.type === 'assistant' &&
      !msg.isToolUse &&
      !msg.isThinking &&
      String(msg.content ?? '').trim().length > 0;
    if (isRealAssistantText) {
      return HIDDEN;
    }

    if (!msg.isToolUse) continue;

    const at = tsMs(msg.timestamp);
    if (at > lastToolActivityAt) lastToolActivityAt = at;

    // Sub-agent container rows (Task/Agent): their child tool calls are real
    // tool_use activity too, so a still-working sub-agent keeps the "last
    // activity" fresh even if the coordinator's own row hasn't changed.
    const childTools = msg.subagentState?.childTools;
    if (childTools && childTools.length > 0) {
      for (const child of childTools) {
        const childAt = tsMs(child.timestamp);
        if (childAt > lastToolActivityAt) lastToolActivityAt = childAt;
      }
    }
  }

  if (lastToolActivityAt === -Infinity) {
    return HIDDEN;
  }

  return { visible: true, lastActivityAt: lastToolActivityAt };
}
