/**
 * Sub-agent (delegation) lifecycle vocabulary, read by the server validators
 * and the client in lockstep (agent-progress study §3.2, P0; ADR-199
 * `subagent.state`). One list, so a state the server emits is never a state an
 * up-to-date client treats as "running forever".
 *
 * Measured vs inferred: `completed`/`failed`/`stopped` come from harness events.
 * `stopped` with `inferredCause: 'owner'` and every `unknown` are inferred by
 * Nassaj and carry their cause. A measured terminal state always overrides an
 * inferred one, and an inferred state never overrides a measured terminal one.
 */

export const SUBAGENT_STATES = ['started', 'running', 'completed', 'failed', 'stopped', 'unknown'] as const;
export type SubagentState = (typeof SUBAGENT_STATES)[number];

/** States that end a delegation. Only `completed` is a success. */
export const TERMINAL_SUBAGENT_STATES = ['completed', 'failed', 'stopped', 'unknown'] as const;
export type SubagentOutcome = (typeof TERMINAL_SUBAGENT_STATES)[number];

/**
 * Why Nassaj inferred a state: the owner stopped the run (`stopped`), the
 * owning process exited without a terminal event (`unknown`), or the session
 * timeout below elapsed with no event (`unknown`).
 */
export const SUBAGENT_INFERRED_CAUSES = ['owner', 'process-exit', 'timeout'] as const;
export type SubagentInferredCause = (typeof SUBAGENT_INFERRED_CAUSES)[number];

/**
 * Session-level timeout: an unsettled delegation with no event for this long,
 * while its session process is still alive, becomes `unknown (timeout)`.
 * Calibrated on 2026-10-18 from real Claude background-agent launches settled by
 * `<task-notification>` (≈30k, all local homes): p50 5 min, p90 20 min, p99
 * 50 min, max 2.7 h; 6 h is ~2× the longest observed. On Claude it is not
 * reachable in practice: the CLI releases its channel after the background idle
 * cap (`CLAUDE_SDK_BACKGROUND_HOLD_IDLE_MAX_MS`, default 1 h) and exits, which
 * already yields `unknown (process-exit)`. It applies to the other bodies.
 */
export const SUBAGENT_SESSION_TIMEOUT_MS = 6 * 60 * 60 * 1000;

const STATE_SET: ReadonlySet<string> = new Set(SUBAGENT_STATES);
const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_SUBAGENT_STATES);
const CAUSE_SET: ReadonlySet<string> = new Set(SUBAGENT_INFERRED_CAUSES);

/** True for a value of the shared state vocabulary. */
export function isSubagentState(value: unknown): value is SubagentState {
  return typeof value === 'string' && STATE_SET.has(value);
}

/** True when the state ends the delegation (success or not). */
export function isTerminalSubagentState(value: unknown): value is SubagentOutcome {
  return typeof value === 'string' && TERMINAL_SET.has(value);
}

/**
 * The cause to keep for a state: only `stopped` and `unknown` may be inferred,
 * and `unknown` is always inferred.
 * @returns the cause, or undefined when the pair is not valid.
 */
export function validInferredCause(state: unknown, cause: unknown): SubagentInferredCause | undefined {
  if (typeof cause !== 'string' || !CAUSE_SET.has(cause)) return undefined;
  if (state === 'stopped') return cause === 'owner' ? 'owner' : undefined;
  if (state === 'unknown') return cause === 'owner' ? undefined : cause as SubagentInferredCause;
  return undefined;
}

type StateRecord = { state: SubagentState; inferredCause?: SubagentInferredCause };

/** True for a terminal state Nassaj inferred rather than measured. */
export function isInferredTerminal(record: StateRecord): boolean {
  return record.state === 'unknown' || (record.state === 'stopped' && record.inferredCause === 'owner');
}

/**
 * Which of two lifecycle records of the same delegation wins, `next` being the
 * later one. A terminal state is never reopened by a non-terminal one, and an
 * inferred terminal never replaces a measured terminal; otherwise later wins.
 */
export function preferSubagentRecord<T extends StateRecord>(previous: T | undefined, next: T): T {
  if (!previous || !isTerminalSubagentState(previous.state)) return next;
  if (!isTerminalSubagentState(next.state)) return previous;
  if (isInferredTerminal(next) && !isInferredTerminal(previous)) return previous;
  return next;
}
