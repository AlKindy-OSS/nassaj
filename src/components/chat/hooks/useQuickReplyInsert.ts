import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

/**
 * T-2027 (ADR-209) — compute the composer text after a quick-reply click.
 *
 * - Empty composer → the option itself.
 * - Composer still starts with the option inserted last (alone, or followed by
 *   a newline and the user's own text) → swap just that prefix.
 * - Anything else → prepend `option + "\n"`, keeping what the user typed.
 */
export function applyQuickReply(current: string, option: string, lastInserted: string | null): string {
  if (!current.trim()) return option;
  if (lastInserted && (current === lastInserted || current.startsWith(`${lastInserted}\n`))) {
    return option + current.slice(lastInserted.length);
  }
  return `${option}\n${current}`;
}

/**
 * Returns the `onQuickReply` callback: fills the composer and focuses it with
 * the caret at the end. It never sends — the user presses Send themself.
 * State is local to this viewer; nothing is broadcast. The remembered prefix
 * is per conversation: switching `sessionId` forgets it.
 */
export function useQuickReplyInsert(
  setInput: Dispatch<SetStateAction<string>>,
  textareaRef: RefObject<HTMLTextAreaElement>,
  sessionId: string | null = null,
): (option: string) => void {
  const lastInsertedRef = useRef<string | null>(null);
  useEffect(() => {
    lastInsertedRef.current = null;
  }, [sessionId]);
  return useCallback((option: string) => {
    // Captured outside the updater so it stays pure (StrictMode may replay it).
    const previous = lastInsertedRef.current;
    lastInsertedRef.current = option;
    setInput((current) => applyQuickReply(current, option, previous));
    textareaRef.current?.focus();
    // Same focus-to-end pattern as the steer button: wait for the new value.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [setInput, textareaRef]);
}
