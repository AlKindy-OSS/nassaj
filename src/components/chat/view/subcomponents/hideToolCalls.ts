import type { ChatMessage } from '../../types/types';

// Tool calls that must stay visible even when "hide tool calls" is on, because
// the user has to interact with them — hiding these would soft-lock the run.
// These arrive as ordinary tool-use messages (`isToolUse`) routed by ToolRenderer
// to the interactive panels (PlanDisplay / QuestionAnswerContent), NOT via the
// separate `isInteractivePrompt` branch, so they must be exempted by toolName.
// Names mirror ToolRenderer.getToolCategory: 'AskUserQuestion' → question,
// 'exit_plan_mode'/'ExitPlanMode' → plan.
export const ALWAYS_VISIBLE_TOOL_NAMES = new Set<string>([
  'AskUserQuestion',
  'exit_plan_mode',
  'ExitPlanMode',
]);

type HideToolCallInput = Pick<ChatMessage, 'isToolUse' | 'toolName' | 'toolResult'>;

/**
 * Whether a message's tool card should be suppressed under the "hide tool calls"
 * preference. Suppresses normal tool-use cards (Bash/Read/Grep/Edit/TodoWrite)
 * and sub-agent containers (Task/Agent — they render as tool-use messages too).
 * Keeps visible:
 *   - interactive tools the user must act on (AskUserQuestion / ExitPlanMode),
 *   - any errored tool result, so failures are never hidden silently.
 * Errors arrive on `message.toolResult.isError` (see MessageComponent's red
 * error box). Non-tool messages (user/assistant/error/thinking/interactive
 * prompt) are never affected.
 */
export function shouldHideToolCallMessage(
  message: HideToolCallInput,
  hideToolCalls: boolean | undefined,
): boolean {
  if (!hideToolCalls || !message.isToolUse) return false;
  if (ALWAYS_VISIBLE_TOOL_NAMES.has(String(message.toolName || ''))) return false;
  if (message.toolResult?.isError) return false;
  return true;
}
