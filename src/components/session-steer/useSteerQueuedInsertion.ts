import { useEffect } from 'react';

import type { SteerEvent } from '../../../shared/session-steer.contract';
import type { ChatMessage } from '../chat/types/types';

import type { TrackedSteerInjection } from './steerDuplicateDetection';

/**
 * Steer clientMsgIds already turned into a local SteerBubble, app-wide.
 *
 * Why module scope and not a component ref: `useSessionSteer` replays the
 * control-events log from its first entry on every mount, and that log lives in
 * WebSocketContext for the whole page life (up to 256 entries). A steered run
 * that continues through background-task notifications emits no `complete`, so
 * its `steer-queued` event stays in the replayed events. A per-mount ref was
 * empty again after a ChatInterface remount, so the replay re-inserted the
 * steer as a second, "queued" bubble — the "steer re-sends itself" report
 * (one server row, two cards). The set must live as long as the log it guards.
 */
const insertedSteerClientMsgIds = new Set<string>();
const MAX_TRACKED_INSERTIONS = 512;

/** Records `clientMsgId` as inserted; false when it already was. */
export function claimSteerInsertion(clientMsgId: string): boolean {
  if (insertedSteerClientMsgIds.has(clientMsgId)) return false;
  insertedSteerClientMsgIds.add(clientMsgId);
  if (insertedSteerClientMsgIds.size > MAX_TRACKED_INSERTIONS) {
    const oldest = insertedSteerClientMsgIds.values().next().value;
    if (oldest !== undefined) insertedSteerClientMsgIds.delete(oldest);
  }
  return true;
}

/** Test-only: forget every recorded insertion. */
export function resetSteerInsertionsForTests(): void {
  insertedSteerClientMsgIds.clear();
}

export interface UseSteerQueuedInsertionArgs {
  events: readonly SteerEvent[];
  sessionId: string | undefined;
  addMessage: (message: ChatMessage) => void;
  /** Feeds isDuplicateSteerInjectionMatch for the live transcript echo. */
  trackedInjections: Map<string, TrackedSteerInjection>;
}

/**
 * T-1903 (ADR-190): shows a live steer at once as a SteerBubble, before the
 * server's history returns it (`injected:true`). Each steer is inserted at most
 * once per page life, whatever the number of mounts or log replays.
 */
export function useSteerQueuedInsertion({
  events,
  sessionId,
  addMessage,
  trackedInjections,
}: UseSteerQueuedInsertionArgs): void {
  useEffect(() => {
    for (const event of events) {
      if (event.type !== 'steer-queued' || !event.text) continue;
      if (!claimSteerInsertion(event.clientMsgId)) continue;
      trackedInjections.set(event.clientMsgId, {
        text: event.text,
        sessionId: sessionId ?? '',
        at: Date.now(),
      });
      addMessage({
        type: 'user',
        content: event.text,
        userId: event.sender.userId,
        injected: true,
        deliveryStatus: 'queued',
        steerClientMsgId: event.clientMsgId,
        // T-1904 e2e: a direct name, not dependent on the participant roster
        // having loaded (the "?" avatar when the bubble beat the roster).
        steerSenderDisplayName: event.sender.displayName,
        timestamp: Date.now(),
        sessionId,
      });
    }
  }, [events, addMessage, sessionId, trackedInjections]);
}
