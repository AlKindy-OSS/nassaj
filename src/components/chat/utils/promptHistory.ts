/**
 * Up/Down-arrow recall of the prompts already sent in this session.
 *
 * The history is the session's own message list — nothing is persisted. The
 * decision is a pure function so the whole key matrix is testable without
 * mounting the composer; the hook only applies it.
 */
import type { ChatMessage } from '../types/types';

/**
 * Human prompts of the session, newest first, with consecutive duplicates
 * collapsed. Machine-authored rows (`originKind`), steer injections, and
 * messages of another known participant are skipped.
 */
export function collectUserPrompts(
  messages: readonly ChatMessage[],
  viewerUserId: number | null,
): string[] {
  const prompts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.type !== 'user' || message.originKind || message.injected) continue;
    if (viewerUserId != null && typeof message.userId === 'number' && message.userId !== viewerUserId) continue;
    const text = typeof message.content === 'string' ? message.content : '';
    if (!text.trim() || prompts[prompts.length - 1] === text) continue;
    prompts.push(text);
  }
  return prompts;
}

export type RecallKeyInput = {
  key: string;
  value: string;
  selectionStart: number;
  selectionEnd: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
};

/** `index` -1 = the empty draft below the newest prompt. */
export type RecallDecision = { kind: 'none' } | { kind: 'set'; index: number; value: string };

const NONE: RecallDecision = { kind: 'none' };

function isPlainCollapsedKey(input: RecallKeyInput): boolean {
  if (input.isComposing || input.shiftKey || input.altKey || input.ctrlKey || input.metaKey) return false;
  return input.selectionStart === input.selectionEnd;
}

/**
 * Decides what an arrow key does to the draft.
 *
 * - ArrowUp recalls the next older prompt when the draft is empty, or when it
 *   still equals the recalled prompt and the caret is on its first line.
 * - ArrowDown moves to the next newer prompt (then back to an empty draft)
 *   when the draft equals the recalled prompt and the caret is on its last line.
 * - Anything else — modifiers, IME composition, a selection, an edited draft,
 *   the caret mid-text — is left to the textarea.
 */
export function decidePromptRecall(
  input: RecallKeyInput,
  prompts: readonly string[],
  currentIndex: number,
): RecallDecision {
  if ((input.key !== 'ArrowUp' && input.key !== 'ArrowDown') || !isPlainCollapsedKey(input)) return NONE;
  const recalling = currentIndex >= 0 && currentIndex < prompts.length && input.value === prompts[currentIndex];
  const caret = input.selectionStart;

  if (input.key === 'ArrowUp') {
    const onFirstLine = !input.value.slice(0, caret).includes('\n');
    if (input.value === '') return prompts.length > 0 ? { kind: 'set', index: 0, value: prompts[0] } : NONE;
    if (!recalling || !onFirstLine || currentIndex + 1 >= prompts.length) return NONE;
    return { kind: 'set', index: currentIndex + 1, value: prompts[currentIndex + 1] };
  }

  const onLastLine = !input.value.slice(caret).includes('\n');
  if (!recalling || !onLastLine) return NONE;
  const next = currentIndex - 1;
  return { kind: 'set', index: next, value: next >= 0 ? prompts[next] : '' };
}
