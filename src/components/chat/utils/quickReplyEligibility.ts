import type { ChatMessage } from '../types/types';

/**
 * T-2027 (ADR-209) — which visible message (if any) may show INTERACTIVE
 * quick replies. Everything else with a valid fence renders the static list.
 */
export type QuickReplyGate = {
  /** A reply is streaming for this session (`isLoading`). */
  isStreaming: boolean;
  /** A run is active, including another member's run seen as a viewer. */
  isRunActive: boolean;
  /** A permission request or AskUserQuestion panel is waiting for an answer. */
  hasPendingPrompt: boolean;
  /** The current user's Send would be enabled given text (connected, no command running). */
  composerCanSend: boolean;
  /** History is (re)loading, so the tail is not yet authoritative. */
  isLoadingHistory?: boolean;
};

/** Raw composer/run state from ChatInterface, before it becomes a gate. */
export type QuickReplyGateInput = {
  isRunActiveForViewer: boolean;
  isLoading: boolean;
  pendingPermissionCount: number;
  isConnected: boolean;
  executingCommand: unknown;
  isImageCropping: boolean;
};

/**
 * Pure mapping from composer/run state to the pane's gate. `composerCanSend`
 * mirrors the Send button's disabled condition minus the empty-text check.
 */
export function buildQuickReplyGate(input: QuickReplyGateInput): Omit<QuickReplyGate, 'isStreaming' | 'isLoadingHistory'> {
  return {
    isRunActive: input.isRunActiveForViewer || input.isLoading,
    hasPendingPrompt: input.pendingPermissionCount > 0,
    composerCanSend: input.isConnected && !input.executingCommand && !input.isImageCropping,
  };
}

/**
 * Trailing rows that carry no conversational content and therefore do not
 * make the reply above them "old". Explicit and short on purpose: any other
 * later row (user, tool use, error, prompt, task notice) disqualifies it.
 *   - thinking rows (reasoning that may trail a final text block)
 *   - compaction boundary markers
 */
const TRAILING_NON_CONTENT: ReadonlyArray<(message: ChatMessage) => boolean> = [
  (message) => message.type === 'assistant' && message.isThinking === true,
  (message) => message.isCompactionBoundary === true,
];

const isTrailingNonContent = (message: ChatMessage) =>
  TRAILING_NON_CONTENT.some((matches) => matches(message));

/** Index in `messages` of the eligible message, or -1 when none is. */
export function findQuickReplyEligibleIndex(messages: ChatMessage[], gate: QuickReplyGate): number {
  if (gate.isStreaming || gate.isRunActive || gate.hasPendingPrompt || !gate.composerCanSend) return -1;
  if (gate.isLoadingHistory) return -1;
  let index = messages.length - 1;
  while (index >= 0 && isTrailingNonContent(messages[index])) index -= 1;
  if (index < 0) return -1;
  const candidate = messages[index];
  const isPrimaryAssistantText = candidate.type === 'assistant'
    && !candidate.isStreaming
    && !candidate.isToolUse
    && !candidate.isThinking
    && !candidate.isInteractivePrompt
    && !candidate.isTaskNotification;
  return isPrimaryAssistantText ? index : -1;
}
