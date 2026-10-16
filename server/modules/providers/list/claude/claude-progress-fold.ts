/**
 * ADR-199 Addendum A: one progress fold for Claude, shared by the history
 * loader (pure function of the ordered rows) and the live run (an object the
 * run owns, so it dies with the run). It combines the subagent tracker, the
 * TaskCreate/TaskUpdate accumulator and background-agent settlement.
 */

import type { ProgressPlan, SubagentState } from '@/shared/progress-normalize.js';
import type { NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId } from '@/shared/utils.js';

import { claudeToolUseProgress, createClaudeSubagentTracker } from './claude-progress.js';
import { createClaudeTaskPlan, type ClaudeTaskPlan } from './claude-task-plan.js';

type AnyRecord = Record<string, any>;

// B-1400: the CLI's own `<task-notification>` text names the task and its tool call.
const NOTIFICATION_BLOCK_RE = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g;
const NOTIFICATION_TASK_ID_RE = /<task-id>([^<\s]+)<\/task-id>/;
const NOTIFICATION_TOOL_USE_ID_RE = /<tool-use-id>([^<\s]+)<\/tool-use-id>/;
const NOTIFICATION_STATUS_RE = /<status>([^<\s]+)<\/status>/;
const NOTIFICATION_BODY_RE = /<summary>|<result>/;

/** Addendum A §9: the only notification statuses that settle a delegation. */
const SETTLED_STATES: Readonly<Record<string, SubagentState>> = Object.freeze({
  completed: 'completed', failed: 'failed', killed: 'failed', stopped: 'failed',
});

export type ClaudeNotifiedTask = { taskId: string | null; toolUseId: string | null; status: string | null };

/** Text of a user message, or '' — only used to find `<task-notification>` blocks. */
function userMessageText(message: AnyRecord): string {
  const content = message?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block: AnyRecord) => (typeof block?.text === 'string' ? block.text : '')).join('');
}

/**
 * `{ taskId, toolUseId, status }` per `<task-notification>` block of a user
 * message the CLI itself delivered as a background-task notification. Such a
 * message carries `origin.kind === 'task-notification'` with no `subkind` (a
 * subkind marks scheduled/peer/relay deliveries, whose text another sender
 * authored), so text a human or a peer typed can never settle a task. `status`
 * is read from the block header only, before `<summary>`/`<result>`, so text
 * quoted in a report cannot settle anything.
 */
export function claudeNotifiedTasks(message: AnyRecord): ClaudeNotifiedTask[] {
  const origin = message?.type === 'user' ? message.origin : null;
  if (origin?.kind !== 'task-notification' || origin.subkind) return [];
  return Array.from(userMessageText(message).matchAll(NOTIFICATION_BLOCK_RE), ([, block]) => {
    const body = block.search(NOTIFICATION_BODY_RE);
    const header = body === -1 ? block : block.slice(0, body);
    return {
      taskId: block.match(NOTIFICATION_TASK_ID_RE)?.[1] ?? null,
      toolUseId: block.match(NOTIFICATION_TOOL_USE_ID_RE)?.[1] ?? null,
      status: header.match(NOTIFICATION_STATUS_RE)?.[1] ?? null,
    };
  });
}

/**
 * Delegations a raw event settles: CLI notification blocks (both paths) and the
 * SDK's structured `system/task_notification` event (live). Unknown statuses
 * settle nothing, so the agent stays `running`.
 */
export function claudeSettlements(raw: AnyRecord): Array<{ toolUseId: string; state: SubagentState }> {
  const found = raw?.type === 'system' && raw.subtype === 'task_notification'
    ? [{ toolUseId: raw.tool_use_id, status: raw.status }]
    : claudeNotifiedTasks(raw);
  const settled: Array<{ toolUseId: string; state: SubagentState }> = [];
  for (const { toolUseId, status } of found) {
    const state = typeof status === 'string' ? SETTLED_STATES[status] : undefined;
    if (typeof toolUseId === 'string' && toolUseId && state) settled.push({ toolUseId, state });
  }
  return settled;
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
  const settlementRows = (raw: AnyRecord): NormalizedMessage[] => claudeSettlements(raw).flatMap(({ toolUseId, state }) => {
    const subagent = subagents.settle(toolUseId, state);
    if (!subagent) return [];
    const base = typeof raw.uuid === 'string' && raw.uuid ? raw.uuid : generateMessageId('claude');
    const rowSessionId = raw.session_id ?? raw.sessionId ?? sessionId;
    return [createNormalizedMessage({ id: `${base}_settle_${toolUseId}`, sessionId: rowSessionId, provider: 'claude',
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

  return {
    observe(raw, rows) {
      if (mode === 'history' && opensTurn(rows)) endTurn();
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
