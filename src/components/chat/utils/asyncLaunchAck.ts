/**
 * B-63/T-143 + B-1665: a background (async) sub-agent launch returns an
 * acknowledgment, not the agent's work ("Async agent launched successfully.
 * agentId: … output_file: …"). It must never be shown as raw text or as the
 * agent's final result.
 */

/**
 * True when a sub-agent container's `tool_result` is a background-launch
 * ACKNOWLEDGMENT, not the real completion (B-63/T-143 root cause).
 *
 * Background delegation has a distinct, documented result shape: its
 * container's tool_result is an acknowledgment with `toolUseResult` shaped
 * `{ isAsync: true, status: 'async_launched', agentId, outputFile, ... }` —
 * the delegated work has barely started and continues out-of-process for the
 * rest of the turn, reporting final completion later via a
 * separate task-notification message, never a second tool_result on this same
 * toolId. Treating that acknowledgment as `isComplete` (as the container
 * branch in useChatMessages used to, unconditionally) flipped the sub-agent to "done"
 * immediately after delegation, so useRunProgress's activeSubagent /
 * agentsDone and the per-agent strip row showed it finished for the rest of
 * the run even though it was still working — foreclosing any chance of the
 * live "still working" signal (or a later plan snapshot) ever being attributed to
 * a container the UI hadn't already written off as resolved.
 *
 * Foreground (blocking) delegations are unaffected: their tool_result has no
 * `isAsync`/`status:'async_launched'` marker and still resolves isComplete
 * exactly as before.
 */
export function isAsyncLaunchAck(toolUseResult: unknown): boolean {
  if (typeof toolUseResult !== 'object' || toolUseResult === null) return false;
  const tur = toolUseResult as Record<string, unknown>;
  return tur.isAsync === true && tur.status === 'async_launched';
}

/**
 * Light history defers `toolUseResult`, so the fixed opening line Claude Code
 * writes for the ack is the only signal left there.
 */
const ASYNC_LAUNCH_ACK_TEXT = /^\s*Async agent launched successfully/;

export function isAsyncLaunchAckResult(result: { content?: unknown; toolUseResult?: unknown } | null | undefined): boolean {
  if (!result) return false;
  if (isAsyncLaunchAck(result.toolUseResult)) return true;
  return typeof result.content === 'string' && ASYNC_LAUNCH_ACK_TEXT.test(result.content);
}
