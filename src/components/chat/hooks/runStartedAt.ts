/**
 * T-1862 round 2 (qa M-3): extracted from the `runStartedAt` useMemo body in
 * ChatInterface.tsx so the scan can be unit-tested without mounting the
 * whole component tree.
 *
 * Real start of the current run: the timestamp that seeds ClaudeStatus's
 * elapsed-time anchor. Transcript messages keep their original timestamps,
 * so after a page refresh onto a still-processing session the counter
 * resumes from the true value instead of restarting at 0.
 *
 * Scans tail→head for the first of:
 *   - a compaction-boundary row (`isCompactionBoundary`) — `/compact` starts
 *     a run with no genuine `type:'user'` prompt, only this locally-added
 *     assistant row. Without stopping here the scan falls through to the
 *     PREVIOUS turn's user message and seeds a stale multi-hour anchor.
 *   - a genuine human `type:'user'` row, skipping `isLocalCommandStdout`
 *     artifacts (those are user-role transcript rows, not the message that
 *     started the run).
 */
import type { ChatMessage } from '../types/types';

export function resolveRunStartedAt(chatMessages: ChatMessage[]): number | null {
  for (let i = chatMessages.length - 1; i >= 0; i--) {
    const message = chatMessages[i];
    if (message.isCompactionBoundary) {
      const ts = new Date(message.timestamp as string | number | Date).getTime();
      return Number.isFinite(ts) ? ts : null;
    }
    if (message.type !== 'user' || message.isLocalCommandStdout) continue;
    const ts = new Date(message.timestamp as string | number | Date).getTime();
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}
