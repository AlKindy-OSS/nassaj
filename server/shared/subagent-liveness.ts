/**
 * Agent-progress study §3.2 "history resolution", condition N3 (P0).
 *
 * A history fold cannot see a process exit, and its result is cached by
 * transcript stat (`loadStableHistorySnapshot`). A process that exits without
 * writing to the transcript leaves that cache valid, so liveness must never be
 * folded into the cached value. This overlay runs at response time, on the
 * per-request clone of the snapshot, and settles only delegations that no
 * measured event ended:
 *
 * - session process alive  → stays `running`, unless the provider has a
 *   session-level timeout and the delegation had no event for that long →
 *   `unknown (timeout)`. Turn end is never settlement.
 * - no live process        → `stopped (owner)` when the transcript recorded an
 *   owner interrupt after the launch, else `unknown (process-exit)`.
 *
 * Process-exit signal per runtime (what "no live process" means):
 * - claude: the run's query iterator ended (`for await` finished or threw) and
 *   `removeSession` dropped the registry entry; `isClaudeSDKSessionActive` is
 *   then false. The live run also emits the same inferred records at that
 *   moment (`ClaudeProgressFold.processExit`), so open clients settle.
 * - codex: the SDK turn stream ends and the session leaves status `running`
 *   (`isCodexSessionActive`).
 * - cursor, opencode, antigravity, kimi agent: the child process `close`
 *   handler drops the session from the runtime's active map.
 * - qwen, glm, deepseek, kimi: the shared vendor runtime's child exit
 *   (`isVendorSessionActive`).
 *   None of these emits a live inferred record yet (P2b); the overlay applies on
 *   the next history read.
 */

import {
  isTerminalSubagentState,
  type SubagentInferredCause,
  type SubagentState,
} from '../../shared/subagent-states.js';

import type { NormalizedMessage } from './types.js';

export type SubagentLivenessInput = {
  /** Whether the session's process is alive; null when unknown (overlay skipped). */
  alive: boolean | null;
  /** Session-level timeout in ms, or null when the provider's own exit rule covers it (Claude, N6). */
  timeoutMs: number | null;
  /** Delegations unsettled when an owner interrupt marker was written. */
  ownerStoppedIds?: readonly string[];
  now?: number;
};

type Latest = { row: NormalizedMessage; terminal: boolean; at: number };

function timestampMs(value: unknown): number {
  const ms = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * Latest lifecycle row per delegation id, in row order. A terminal row is never
 * reopened by a later non-terminal one; a plain tool_result for a delegation
 * still `started` resolves it, as the client already reads it.
 */
function latestByDelegation(messages: NormalizedMessage[]): Map<string, Latest> {
  const latest = new Map<string, Latest>();
  for (const row of messages) {
    const subagent = row.subagent;
    if (subagent?.id) {
      const previous = latest.get(subagent.id);
      const terminal = isTerminalSubagentState(subagent.state);
      if (previous?.terminal && !terminal) continue;
      latest.set(subagent.id, { row, terminal, at: timestampMs(row.timestamp) });
    } else if (row.kind === 'tool_result' && row.toolId) {
      const previous = latest.get(row.toolId);
      if (previous && !previous.terminal && previous.row.subagent?.state === 'started') previous.terminal = true;
    }
  }
  return latest;
}

function inferredOutcome(
  id: string, at: number, input: SubagentLivenessInput, now: number, ownerStops: ReadonlySet<string>,
): { state: SubagentState; cause: SubagentInferredCause } | null {
  if (input.alive === false) {
    return ownerStops.has(id) ? { state: 'stopped', cause: 'owner' } : { state: 'unknown', cause: 'process-exit' };
  }
  if (input.timeoutMs !== null && Number.isFinite(at) && now - at > input.timeoutMs) {
    return { state: 'unknown', cause: 'timeout' };
  }
  return null;
}

/**
 * Settles unsettled delegations of a history page from the session's liveness.
 * Mutates `messages` in place: call it only on a per-request copy, never on a
 * cached snapshot. A later measured event still wins on the client
 * (`preferSubagentRecord`).
 * @returns how many delegations were settled.
 */
export function applySubagentLiveness(messages: NormalizedMessage[], input: SubagentLivenessInput): number {
  if (input.alive === null) return 0;
  const now = input.now ?? Date.now();
  const ownerStops = new Set(input.ownerStoppedIds ?? []);
  let settled = 0;
  for (const [id, { row, terminal, at }] of latestByDelegation(messages)) {
    if (terminal || !row.subagent) continue;
    const outcome = inferredOutcome(id, at, input, now, ownerStops);
    if (!outcome) continue;
    row.subagent = { ...row.subagent, state: outcome.state, inferredCause: outcome.cause };
    settled += 1;
  }
  return settled;
}
