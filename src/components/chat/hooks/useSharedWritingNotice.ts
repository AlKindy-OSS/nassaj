import { useCallback, useEffect, useMemo, useState } from 'react';

import type { SessionOwner } from '../../../types/app';
import { getProviderCapabilities, getSharedWritingSupport } from '../constants/providerCapabilities';
import type { SharedWritingNotice } from '../utils/sharedWriting';

interface UseSharedWritingNoticeArgs {
  sessionId: string | null;
  /** Provider of the conversation on screen (displayProvider). */
  provider: string | null;
  owner: SessionOwner | null | undefined;
  currentUserId: number | null;
}

/**
 * ADR-173 P6 — the shared-writing notice above the composer. A notice the
 * server raised for this session (busy, refused stop, unsupported) comes
 * first; otherwise, before any send, a member viewing a conversation another
 * member started on a creator-only provider sees the fork banner up front.
 * Display only: the server refuses or admits the send on its own.
 */
export function useSharedWritingNotice({ sessionId, provider, owner, currentUserId }: UseSharedWritingNoticeArgs) {
  const [serverNotice, setNotice] = useState<SharedWritingNotice | null>(null);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  useEffect(() => { setNotice(null); }, [sessionId]);

  const upFront = useMemo<SharedWritingNotice | null>(() => {
    if (!sessionId || !owner || currentUserId === null || owner.userId === currentUserId) return null;
    if (getSharedWritingSupport(provider) !== 'creator_only') return null;
    return {
      kind: 'unsupported',
      sessionId,
      provider,
      creatorName: owner.username || null,
      canFork: getProviderCapabilities(provider).messageFork?.supported === true,
    };
  }, [sessionId, provider, owner, currentUserId]);

  const dismiss = useCallback(() => {
    setNotice(null);
    setDismissedFor(sessionId);
  }, [sessionId]);

  const notice = serverNotice && serverNotice.sessionId === sessionId
    ? serverNotice
    : (upFront && dismissedFor !== sessionId ? upFront : null);

  return { notice, setNotice, dismiss };
}
