import { useSyncExternalStore } from 'react';

/** Personal mention state only.  It intentionally carries no message content. */
const mentionCounts = new Map<string, number>();
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());

export function setInternalMentionCount(sessionId: string, unreadMentionCount: number): void {
  if (!sessionId) return;
  if (unreadMentionCount > 0) mentionCounts.set(sessionId, unreadMentionCount);
  else mentionCounts.delete(sessionId);
  emit();
}

export function clearInternalSessionChatState(sessionId: string): void {
  if (mentionCounts.delete(sessionId)) emit();
}

export function useInternalMentionCount(sessionId: string | null | undefined): number {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => (sessionId ? mentionCounts.get(sessionId) ?? 0 : 0),
    () => 0,
  );
}
