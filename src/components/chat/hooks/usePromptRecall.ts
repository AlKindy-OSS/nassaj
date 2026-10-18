import { useCallback, useRef } from 'react';
import type { KeyboardEvent } from 'react';

import { decidePromptRecall } from '../utils/promptHistory';

/**
 * Arrow-key recall of the session's sent prompts (see `decidePromptRecall`).
 *
 * Returns a keydown handler that reports whether it consumed the event; the
 * caller runs it after its suggestion menus and only while none is open.
 * `applyValue` replaces the draft (state, refs and caret) in the caller.
 */
export function usePromptRecall(
  prompts: readonly string[],
  applyValue: (value: string) => void,
): (event: KeyboardEvent<HTMLTextAreaElement>) => boolean {
  const indexRef = useRef(-1);

  return useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const textarea = event.currentTarget;
      const decision = decidePromptRecall(
        {
          key: event.key,
          value: textarea.value,
          selectionStart: textarea.selectionStart,
          selectionEnd: textarea.selectionEnd,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          // keyCode 229 = Safari's composition keydown, which lacks isComposing.
          isComposing: event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229,
        },
        prompts,
        indexRef.current,
      );
      if (decision.kind === 'none') return false;
      event.preventDefault();
      indexRef.current = decision.index;
      applyValue(decision.value);
      return true;
    },
    [prompts, applyValue],
  );
}
