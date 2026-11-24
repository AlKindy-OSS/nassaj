import { useEffect, useState } from 'react';

import { subscribeTurnChanges, takeTurnChangesTarget } from '../../../utils/turnChangesNavigation';

export type TurnChangesFocus = { sessionId: string; turnSeq: number; nonce: number };

/**
 * T-2095: applies a chat chip's "open this turn" request: switches to the git
 * tab and hands the panel one focus target. A focus for another conversation
 * is dropped as soon as the open conversation changes.
 */
export function useTurnChangesFocus(selectedSessionId: string | null, showGitTab: () => void): TurnChangesFocus | null {
  const [focus, setFocus] = useState<TurnChangesFocus | null>(null);

  useEffect(() => subscribeTurnChanges(() => {
    const target = takeTurnChangesTarget();
    if (!target) return;
    setFocus({ ...target, nonce: Date.now() });
    showGitTab();
  }), [showGitTab]);

  useEffect(() => {
    setFocus((current) => (current && current.sessionId !== selectedSessionId ? null : current));
  }, [selectedSessionId]);

  return focus;
}
