import { useCallback, useId, type FormEvent, type KeyboardEvent, type RefObject } from 'react';

import type { InternalMember } from './internalSessionChatApi';
import { useInternalMentionSuggestions } from './useInternalMentionSuggestions';
import type { InternalSessionChatController } from './useInternalSessionChat';

type Options = {
  chat: InternalSessionChatController | null | undefined;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  sendByCtrlEnter: boolean;
};

const NO_MEMBERS: InternalMember[] = [];
const noop = () => undefined;

/**
 * Team mode of the main composer. While active the textarea edits the TEAM
 * draft (kept apart from the model draft, so leaving the mode never turns a
 * team note into a prompt), Enter sends to the room endpoint only, and Esc
 * leaves the mode.
 */
export function useComposerTeamMode({ chat, textareaRef, sendByCtrlEnter }: Options) {
  const active = chat?.active === true;
  const listId = useId();
  const mentions = useInternalMentionSuggestions({
    draft: chat?.draft ?? '',
    setDraft: chat?.setDraft ?? noop,
    members: active && chat ? chat.members : NO_MEMBERS,
    inputRef: textareaRef,
  });

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!chat || event.nativeEvent.isComposing) return;
    if (mentions.handleKey(event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      chat.exit();
      return;
    }
    if (event.key !== 'Enter') return;
    const wantsSend = sendByCtrlEnter ? event.ctrlKey || event.metaKey : !event.shiftKey;
    if (!wantsSend) return;
    event.preventDefault();
    void chat.send();
  }, [chat, mentions, sendByCtrlEnter]);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void chat?.send();
  }, [chat]);

  const focusSoon = useCallback(() => requestAnimationFrame(() => textareaRef.current?.focus()), [textareaRef]);

  return {
    active,
    canSend: Boolean(chat && chat.room && chat.isWriter && !chat.sending && chat.draft.trim()),
    listId,
    mentions,
    handleKeyDown,
    handleSubmit,
    focusSoon,
  };
}
