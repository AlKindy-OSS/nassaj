import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';

import type { InternalMember } from './internalSessionChatApi';

type Options = {
  draft: string;
  setDraft: (value: string) => void;
  members: InternalMember[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
};

const MAX_SUGGESTIONS = 6;

/**
 * Team-mode `@` completion: it offers ROOM members only, never files or
 * provider context. Arrow keys move, Enter/Tab pick, Esc closes the list.
 */
export function useInternalMentionSuggestions({ draft, setDraft, members, inputRef }: Options) {
  const [highlighted, setHighlighted] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const suggestions = useMemo(() => {
    if (dismissedFor === draft) return [];
    const beforeCursor = draft.slice(0, inputRef.current?.selectionStart ?? draft.length);
    const query = beforeCursor.match(/@([^\s@]*)$/)?.[1]?.toLocaleLowerCase() ?? null;
    if (query === null) return [];
    return members.filter((member) => member.username.toLocaleLowerCase().includes(query)).slice(0, MAX_SUGGESTIONS);
  }, [dismissedFor, draft, members, inputRef]);
  useEffect(() => { setHighlighted(0); }, [suggestions.length]);

  const select = useCallback((member: InternalMember) => {
    const cursor = inputRef.current?.selectionStart ?? draft.length;
    setDraft(`${draft.slice(0, cursor).replace(/@[^\s@]*$/, `@${member.username} `)}${draft.slice(cursor)}`);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [draft, inputRef, setDraft]);

  /** Handles the key when the list is open; returns true if it consumed it. */
  const handleKey = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (suggestions.length === 0) return false;
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step !== 0) {
      event.preventDefault();
      setHighlighted((index) => (index + step + suggestions.length) % suggestions.length);
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      select(suggestions[Math.min(highlighted, suggestions.length - 1)]);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setDismissedFor(draft);
      return true;
    }
    return false;
  }, [draft, highlighted, select, suggestions]);

  return { suggestions, highlighted, select, handleKey };
}
