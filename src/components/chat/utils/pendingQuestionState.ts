import type { ChatMessage, PendingPermissionRequest } from '../types/types';

/**
 * Display state of a pending permission prompt.
 *  - `active`     — the one prompt the user may answer.
 *  - `resolved`   — the transcript already holds a tool_result for its tool_use.
 *  - `superseded` — an older AskUserQuestion replaced by a newer one in the same session.
 */
export type PendingQuestionState = 'active' | 'resolved' | 'superseded';

const QUESTION_TOOL = 'AskUserQuestion';

/** Key-order independent serialisation, so equal inputs compare equal. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * True when the transcript shows this question's tool_use already settled:
 * at least one AskUserQuestion tool_use with the same input exists and every
 * such tool_use carries a tool_result. A matching tool_use still without a
 * result (a fresh re-ask of the same text) keeps the prompt answerable.
 */
function hasSettledToolUse(request: PendingPermissionRequest, messages: readonly ChatMessage[]): boolean {
  const key = stableStringify(request.input);
  let matches = 0;
  for (const message of messages) {
    if (!message.isToolUse || message.toolName !== QUESTION_TOOL) continue;
    if (stableStringify(message.toolInput) !== key) continue;
    if (!message.toolResult) return false;
    matches += 1;
  }
  return matches > 0;
}

/**
 * Classifies pending prompts so at most ONE AskUserQuestion per session is
 * answerable. The server can leave a stale question in the client list (a
 * missed `permission_cancelled`, a prompt settled from another viewer, a
 * re-ask after a cancelled tool call); answering it would target a dead
 * tool_use. Non-question prompts are always `active`.
 *
 * @param requests pending prompts in arrival order.
 * @param messages the session transcript (used for tool_result evidence).
 * @returns state per requestId.
 */
export function classifyPendingQuestions(
  requests: readonly PendingPermissionRequest[],
  messages: readonly ChatMessage[] = [],
): Map<string, PendingQuestionState> {
  const states = new Map<string, PendingQuestionState>();
  const newestOpenBySession = new Map<string, string>();

  for (const request of requests) {
    if (request.toolName !== QUESTION_TOOL) {
      states.set(request.requestId, 'active');
      continue;
    }
    if (hasSettledToolUse(request, messages)) {
      states.set(request.requestId, 'resolved');
      continue;
    }
    const sessionKey = request.sessionId ?? '';
    const previous = newestOpenBySession.get(sessionKey);
    if (previous) states.set(previous, 'superseded');
    newestOpenBySession.set(sessionKey, request.requestId);
    states.set(request.requestId, 'active');
  }
  return states;
}
