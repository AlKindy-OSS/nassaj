/**
 * ADR-199 Addendum A: one progress fold for Claude, shared by the history
 * loader (pure function of the ordered rows) and the live run (an object the
 * run owns, so it dies with the run). It combines the subagent tracker, the
 * TaskCreate/TaskUpdate accumulator and background-agent settlement.
 */

import type { ProgressPlan, SubagentState } from '@/shared/progress-normalize.js';
import type { NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId } from '@/shared/utils.js';

import { claudeParentToolUseId, claudeToolUseProgress, createClaudeSubagentTracker } from './claude-progress.js';
import { createClaudeTaskPlan, type ClaudeTaskPlan } from './claude-task-plan.js';
import { claudeTaskEnds, claudeUserMessageText } from './claude-task-events.js';

type AnyRecord = Record<string, any>;

/** The CLI's main-thread cut marker after an owner interrupt (the CLI emits two wordings). */
const INTERRUPT_MARKER_PREFIX = '[Request interrupted by user';

export { claudeNotifiedTasks, type ClaudeNotifiedTask } from './claude-task-events.js';

/**
 * True for the CLI's own main-thread `[Request interrupted by user…]` row: the
 * owner stopped the run at that point (study §3.2 "history resolution").
 */
export function isClaudeInterruptMarker(raw: AnyRecord): boolean {
  if (raw?.type !== 'user' || raw.isSidechain === true || claudeParentToolUseId(raw)) return false;
  return claudeUserMessageText(raw).trimStart().startsWith(INTERRUPT_MARKER_PREFIX);
}

/**
 * Delegations a raw event settles: CLI notification blocks (both paths) and the
 * SDK's structured `system/task_notification` event (live). Unknown statuses
 * settle nothing, so the agent stays `running`.
 */
export function claudeSettlements(raw: AnyRecord): Array<{ toolUseId: string; state: SubagentState }> {
  return claudeTaskEnds(raw).flatMap(({ toolUseId, state }) => (toolUseId ? [{ toolUseId, state }] : []));
}

/** A human prompt opens a new turn; machine-routed, subagent and injected rows do not. */
function opensTurn(rows: NormalizedMessage[]): boolean {
  return rows.some((m) => m.kind === 'text' && m.role === 'user' && !m.originKind && !m.isSidechain && !m.injected);
}

export type ClaudeProgressFold = {
  /**
   * Folds one raw row/event and its normalized rows (mutated in place).
   * @returns derived `status` rows that settle background delegations.
   */
  observe(raw: AnyRecord, rows: NormalizedMessage[]): NormalizedMessage[];
  /**
   * B-1563: folds one row replayed from the transcript before a live run. A
   * human prompt closes the prior turn exactly as on the history path, so
   * buffered updates drop at the same boundaries; rows are not annotated.
   */
  seed(raw: AnyRecord, rows: NormalizedMessage[]): void;
  /** Closes the current turn: history attaches its snapshot; buffered updates drop. */
  endTurn(): void;
  /**
   * Live only, at the exit of the run's CLI process (study §3.2, N3): settles
   * every delegation this run launched (seeded ones excluded) and that never
   * ended, as `stopped (owner)` or `unknown (process-exit)`. Idempotent.
   * @returns `status` rows carrying the inferred records.
   */
  processExit(cause: 'owner' | 'process-exit', rowSessionId?: string | null): NormalizedMessage[];
  /** History: delegations still unsettled when an owner interrupt marker was written. */
  readonly ownerStoppedIds: ReadonlySet<string>;
  readonly taskPlan: ClaudeTaskPlan;
};

/**
 * `history`: turns are detected from human prompts and the plan snapshot is
 * attached only to the last Task* result row of each turn (call endTurn after
 * the last row). `live`: the run is the turn and every Task* result row
 * carries the snapshot.
 */
export function createClaudeProgressFold(mode: 'history' | 'live', sessionId: string | null): ClaudeProgressFold {
  const subagents = createClaudeSubagentTracker();
  const taskPlan = createClaudeTaskPlan();
  let lastTaskRow: NormalizedMessage | null = null;
  const ownerStoppedIds = new Set<string>();
  const runOwned = new Set<string>();

  const attach = (row: NormalizedMessage): void => {
    const plan = taskPlan.snapshot();
    if (plan) row.plan = plan;
    else delete row.plan;
  };
  const endTurn = (): void => {
    if (lastTaskRow) attach(lastTaskRow);
    lastTaskRow = null;
    taskPlan.endTurn();
  };
  // ADR-218: the task id names the agent across SendMessage resumes, whose
  // notification carries the SendMessage call's tool_use_id instead.
  const settlementRows = (raw: AnyRecord): NormalizedMessage[] => claudeTaskEnds(raw).flatMap(({ taskId, toolUseId, state }) => {
    const subagent = subagents.settle(toolUseId, state, taskId);
    if (!subagent) return [];
    const base = typeof raw.uuid === 'string' && raw.uuid ? raw.uuid : generateMessageId('claude');
    const rowSessionId = raw.session_id ?? raw.sessionId ?? sessionId;
    return [createNormalizedMessage({ id: `${base}_settle_${subagent.id}`, sessionId: rowSessionId, provider: 'claude',
      timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : undefined, kind: 'status', subagent })];
  });

  const fold = (raw: AnyRecord, rows: NormalizedMessage[]): NormalizedMessage[] => {
    const subagentUpdates = subagents.observe(raw, rows);
    const taskProgress = raw?.type === 'system' && raw.subtype === 'task_progress'
      ? subagents.progress(raw) : null;
    if (taskProgress) subagentUpdates.push(taskProgress);
    if (mode === 'live') {
      const base = typeof raw.uuid === 'string' && raw.uuid ? raw.uuid : generateMessageId('claude');
      const rowSessionId = raw.session_id ?? raw.sessionId ?? sessionId;
      subagentUpdates.forEach((subagent, index) => rows.push(createNormalizedMessage({
        id: `${base}_agent_tools_${subagent.id}_${index}`,
        sessionId: rowSessionId,
        provider: 'claude',
        timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : undefined,
        kind: 'status',
        subagent,
      })));
    }
    return taskPlan.observe(raw, rows);
  };

  const noteOwnership = (raw: AnyRecord, rows: NormalizedMessage[]): void => {
    if (isClaudeInterruptMarker(raw)) subagents.unsettled().forEach(({ id }) => ownerStoppedIds.add(id));
    for (const row of rows) if (row.kind === 'tool_use' && row.subagent && row.toolId) runOwned.add(row.toolId);
  };
  const processExit = (cause: 'owner' | 'process-exit', rowSessionId?: string | null): NormalizedMessage[] => {
    const state: SubagentState = cause === 'owner' ? 'stopped' : 'unknown';
    return subagents.unsettled().filter(({ id }) => runOwned.has(id)).flatMap(({ id }) => {
      const subagent = subagents.settle(id, state);
      if (!subagent) return [];
      return [createNormalizedMessage({ id: `${generateMessageId('claude')}_exit_${id}`,
        sessionId: rowSessionId ?? sessionId,
        provider: 'claude', kind: 'status', subagent: { ...subagent, inferredCause: cause } })];
    });
  };

  return {
    observe(raw, rows) {
      if (mode === 'history' && opensTurn(rows)) endTurn();
      noteOwnership(raw, rows);
      const touched = fold(raw, rows);
      if (mode === 'live') touched.forEach(attach);
      else if (touched.length > 0) lastTaskRow = touched[touched.length - 1];
      return settlementRows(raw);
    },
    seed(raw, rows) {
      if (opensTurn(rows)) endTurn();
      fold(raw, rows);
      settlementRows(raw);
    },
    endTurn,
    processExit,
    ownerStoppedIds,
    taskPlan,
  };
}

/** A history `subagentTools` item as built by the Claude provider's agent-file parser. */
type ChildToolItem = AnyRecord & { toolId?: unknown; toolName?: unknown; toolInput?: unknown };

export type ClaudeChildToolsProgress = {
  /** Records a child tool_use item (TodoWrite plan, Task* call). */
  toolUse(item: ChildToolItem): void;
  /** Applies a child tool_result to the task list; `entry` is its raw transcript row. */
  toolResult(entry: AnyRecord, item: ChildToolItem, isError: boolean): void;
  /** Attaches the final plan to the last plan-bearing item (the subagent run is one turn). */
  finish(): void;
};

/**
 * ADR-199: progress for a subagent's own tool list on the history path, so a
 * reload mid-run still shows the subagent's plan. Same rules as the main fold:
 * TodoWrite snapshots and the TaskCreate/TaskUpdate fold, one snapshot on the
 * last Task* or TodoWrite item of the run.
 */
export function createClaudeChildToolsProgress(): ClaudeChildToolsProgress {
  const taskPlan = createClaudeTaskPlan();
  let last: { item: ChildToolItem; plan: ProgressPlan | null } | null = null;
  return {
    toolUse(item) {
      const { plan } = claudeToolUseProgress(item.toolName, item.toolId, item.toolInput, null);
      if (plan) last = { item, plan };
      const row = { kind: 'tool_use', toolName: item.toolName, toolId: item.toolId, toolInput: item.toolInput };
      taskPlan.observe({}, [row as NormalizedMessage]);
    },
    toolResult(entry, item, isError) {
      const row = { kind: 'tool_result', toolId: item.toolId, isError, content: item.toolResult?.content };
      if (taskPlan.observe(entry, [row as NormalizedMessage]).length > 0) last = { item, plan: null };
    },
    finish() {
      const plan = last ? last.plan ?? taskPlan.snapshot() : null;
      if (last && plan) last.item.plan = plan;
    },
  };
}
