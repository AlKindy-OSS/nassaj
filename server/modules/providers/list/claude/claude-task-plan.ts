/**
 * ADR-199 Addendum A §1/§6/§7: folds Claude's TaskCreate/TaskUpdate calls into
 * one session-scoped task list and renders it as a neutral `plan` snapshot.
 *
 * Shapes verified on a real capture (Claude Code 2.1.289): TaskCreate input
 * `{subject, description}` carries no id; its result `{task:{id, subject}}`
 * does. TaskUpdate input `{taskId, status}`; result `{success, taskId,
 * updatedFields, statusChange:{from,to}}`; `deleted` removes the task.
 * Subagent transcripts (`subagents/agent-*.jsonl`) record no structured result,
 * only the text `Task #<id> created successfully: <subject>`, so the create id
 * falls back to that text and an update to its input.
 *
 * The accumulator is a plain object owned by its caller (one history load or
 * one live run); nothing here is module-level state.
 */

import { buildProgressPlan, type ProgressPlan } from '@/shared/progress-normalize.js';
import type { NormalizedMessage } from '@/shared/types.js';

type AnyRecord = Record<string, any>;
type HeldCall = { tool: 'create' | 'update'; input: AnyRecord };
type TaskUpdate = { status?: string; subject?: string };

export const TASK_PLAN_MAX_ITEMS = 200;
export const TASK_PLAN_PENDING_MAX = 50;
const HELD_CALLS_MAX = 200;
const APPLIED_RESULTS_MAX = 1000;
const CREATED_TEXT_RE = /^Task #(\S+) created successfully/;
const TASK_TOOLS: Readonly<Record<string, HeldCall['tool']>> = Object.freeze({
  TaskCreate: 'create', TaskUpdate: 'update',
});

/** Session-scoped Claude task list; see createClaudeTaskPlan. */
export type ClaudeTaskPlan = {
  /**
   * Records Task* tool_use rows and applies Task* results.
   * @returns the tool_result rows of `rows` that changed or confirmed the list.
   */
  observe(raw: AnyRecord, rows: NormalizedMessage[]): NormalizedMessage[];
  /** Current neutral snapshot, or null when no item is left. */
  snapshot(): ProgressPlan | null;
  /** Drops buffered updates whose task never appeared in this turn. */
  endTurn(): void;
  /** True once a create was ignored at the item cap (server-side only). */
  readonly truncated: boolean;
};

/** Adds `value` under `key` to a bounded insertion-ordered map, evicting the oldest. */
function boundedSet<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  if (!map.has(key) && map.size >= max) map.delete(map.keys().next().value as string);
  map.set(key, value);
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {};
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The update a TaskUpdate result applies, read from the result first, the input second. */
function readUpdate(result: AnyRecord, input: AnyRecord): { taskId?: string; update: TaskUpdate } {
  const taskId = stringOrUndefined(result.taskId) ?? stringOrUndefined(input.taskId);
  const status = stringOrUndefined(asRecord(result.statusChange).to) ?? stringOrUndefined(input.status);
  return { taskId, update: { status, subject: stringOrUndefined(input.subject) } };
}

/** Accumulator state; every method is small and the instance is caller-owned. */
class ClaudeTaskPlanState implements ClaudeTaskPlan {
  private readonly items = new Map<string, { label: string; status: string }>();
  private readonly held = new Map<string, HeldCall>();
  private readonly pending = new Map<string, TaskUpdate>();
  private readonly applied = new Map<string, true>();
  private wasTruncated = false;

  get truncated(): boolean {
    return this.wasTruncated;
  }

  observe(raw: AnyRecord, rows: NormalizedMessage[]): NormalizedMessage[] {
    const touched: NormalizedMessage[] = [];
    for (const message of rows) {
      const tool = message.kind === 'tool_use' && typeof message.toolName === 'string'
        ? TASK_TOOLS[message.toolName] : undefined;
      if (tool && message.toolId) {
        boundedSet(this.held, message.toolId, { tool, input: asRecord(message.toolInput) }, HELD_CALLS_MAX);
      } else if (message.kind === 'tool_result' && this.applyResult(message, raw)) {
        touched.push(message);
      }
    }
    return touched;
  }

  snapshot(): ProgressPlan | null {
    return buildProgressPlan('tool', [...this.items].map(([id, item]) => ({ id, ...item })));
  }

  endTurn(): void {
    this.pending.clear();
  }

  /** @returns true when the row is a Task* result (applied, duplicate or failed). */
  private applyResult(message: NormalizedMessage, raw: AnyRecord): boolean {
    const toolId = message.toolId;
    const call = toolId ? this.held.get(toolId) : undefined;
    if (!call || !toolId) return false;
    const result = asRecord(raw.toolUseResult ?? raw.tool_use_result);
    if (message.isError === true || result.success === false || this.applied.has(toolId)) return true;
    boundedSet(this.applied, toolId, true, APPLIED_RESULTS_MAX);
    if (call.tool === 'create') {
      this.applyCreate(result, call.input, message.content);
    } else {
      const { taskId, update } = readUpdate(result, call.input);
      if (taskId) this.applyUpdate(taskId, update);
    }
    return true;
  }

  private applyCreate(result: AnyRecord, input: AnyRecord, text: unknown): void {
    const task = asRecord(result.task);
    const id = stringOrUndefined(task.id)
      ?? (typeof text === 'string' ? text.match(CREATED_TEXT_RE)?.[1] : undefined);
    const label = stringOrUndefined(task.subject) ?? stringOrUndefined(input.subject);
    if (!id || !label) return;
    if (!this.items.has(id) && this.items.size >= TASK_PLAN_MAX_ITEMS) {
      this.wasTruncated = true;
      return;
    }
    this.items.set(id, { label, status: 'pending' });
    const buffered = this.pending.get(id);
    this.pending.delete(id);
    if (buffered) this.applyUpdate(id, buffered);
  }

  /** Applies an update, or buffers it (bounded) until its task is created. */
  private applyUpdate(taskId: string, update: TaskUpdate): void {
    const item = this.items.get(taskId);
    if (!item) {
      const merged = { ...this.pending.get(taskId), ...stripUndefined(update) };
      if (this.pending.has(taskId) || this.pending.size < TASK_PLAN_PENDING_MAX) this.pending.set(taskId, merged);
      return;
    }
    if (update.status === 'deleted') this.items.delete(taskId);
    else Object.assign(item, stripUndefined({ status: update.status, label: update.subject }));
  }
}

/** Creates an empty accumulator. */
export function createClaudeTaskPlan(): ClaudeTaskPlan {
  return new ClaudeTaskPlanState();
}

/** Copy of `value` without its undefined entries. */
function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
