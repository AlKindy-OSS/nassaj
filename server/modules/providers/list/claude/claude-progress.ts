/**
 * ADR-199 P1: maps Claude's plan and subagent signals onto the neutral
 * `plan`/`subagent` fields. Claude tool names stay inside this adapter; the
 * client reads only the neutral fields.
 *
 * Shapes verified against a real SDK stream (Claude Code 2.1.289) and real
 * JSONL transcripts: `TodoWrite.input.todos[{content,status,activeForm}]`, a
 * delegating `Agent`/`Task` tool_use with `input.description`, and its
 * tool_result whose `toolUseResult` (JSONL) / `tool_use_result` (SDK) carries
 * `status: 'completed' | 'async_launched'`, or a string on error.
 */

import {
  buildProgressPlan,
  buildProgressSubagent,
  type ProgressPlan,
  type ProgressSubagent,
  type SubagentState,
} from '@/shared/progress-normalize.js';
import type { NormalizedMessage } from '@/shared/types.js';

type AnyRecord = Record<string, any>;

const PLAN_TOOL = 'TodoWrite';
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);
const TRACKER_MAX_ENTRIES = 500;

/** Parent tool_use id of a raw SDK event or row; null on the main thread. */
export function claudeParentToolUseId(raw: AnyRecord): string | null {
  const value = raw.parent_tool_use_id ?? raw.parentToolUseId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Neutral progress fields for one Claude tool_use block: `plan` for a todo
 * snapshot, `subagent` (state `started`) for a delegation.
 * @returns an object to spread into the tool_use row; empty for other tools.
 */
export function claudeToolUseProgress(
  name: unknown, toolId: unknown, input: unknown, parentId: string | null,
  parentModel?: unknown,
): { plan?: ProgressPlan; subagent?: ProgressSubagent } {
  if (typeof name !== 'string') return {};
  const record = input && typeof input === 'object' ? input as AnyRecord : {};
  if (name === PLAN_TOOL) {
    const todos: unknown[] = Array.isArray(record.todos) ? record.todos : [];
    const entries = todos.map((todo) => {
      const item = todo && typeof todo === 'object' ? todo as AnyRecord : {};
      return { label: item.content, status: item.status };
    });
    const plan = buildProgressPlan('tool', entries);
    return plan ? { plan } : {};
  }
  if (!SUBAGENT_TOOLS.has(name)) return {};
  const label = typeof record.description === 'string' && record.description.trim()
    ? record.description
    : record.subagent_type;
  const model = typeof record.model === 'string' && record.model.trim() ? record.model : parentModel;
  const modelInherited = !(typeof record.model === 'string' && record.model.trim())
    && typeof model === 'string' && model.length > 0;
  const effort = record.effort ?? record.reasoning_effort;
  const subagent = buildProgressSubagent({
    id: toolId,
    parentId,
    label,
    state: 'started',
    agentName: record.subagent_type,
    model,
    modelInherited,
    effort,
  });
  return subagent ? { subagent } : {};
}

/**
 * Lifecycle state carried by a delegation's tool_result: an error fails it, a
 * background launch keeps it running, any other returned result completes it.
 */
export function claudeSubagentResultState(toolUseResult: unknown, isError: boolean): SubagentState {
  if (isError) return 'failed';
  const status = toolUseResult && typeof toolUseResult === 'object'
    ? (toolUseResult as AnyRecord).status
    : undefined;
  return status === 'async_launched' ? 'running' : 'completed';
}

/** Pairs a delegation's tool_result with the tool_use that started it. */
export type ClaudeSubagentTracker = {
  /** Records delegations/child tools and stamps snapshots on results (mutates `messages`). */
  observe(raw: AnyRecord, messages: NormalizedMessage[]): ProgressSubagent[];
  /**
   * Lifecycle record closing a delegation by its tool_use id, or null when this
   * tracker never saw that delegation (e.g. a background Bash task), so a
   * notification can never invent a subagent.
   */
  settle(toolUseId: string, state: SubagentState): ProgressSubagent | null;
};

/**
 * Creates a tracker for one run (live) or one history load. A tool_result row
 * carries no tool name, so the pairing needs the earlier tool_use; the map is
 * bounded so a long run cannot grow it without limit.
 */
export function createClaudeSubagentTracker(maxEntries = TRACKER_MAX_ENTRIES): ClaudeSubagentTracker {
  const started = new Map<string, ProgressSubagent>();
  const childTools = new Map<string, Map<string, { name: string; status: string }>>();
  return {
    observe(raw, messages) {
      const updates: ProgressSubagent[] = [];
      for (const message of messages) {
        if (message.kind === 'tool_use' && message.subagent && message.toolId) {
          if (started.size >= maxEntries) {
            const oldestId = started.keys().next().value as string;
            started.delete(oldestId);
            childTools.delete(oldestId);
          }
          started.set(message.toolId, message.subagent);
          continue;
        }
        const parentValue: unknown = message.parentToolUseId ?? claudeParentToolUseId(raw);
        const parentId = typeof parentValue === 'string' ? parentValue : null;
        if (parentId && (message.kind === 'tool_use' || message.kind === 'tool_result')) {
          const update = trackChildTool(message, parentId, started, childTools);
          if (update) updates.push(update);
          continue;
        }
        const origin = message.kind === 'tool_result' && message.toolId ? started.get(message.toolId) : undefined;
        if (origin && !message.subagent) settleDelegation(raw, message, origin, childTools);
      }
      return updates;
    },
    settle(toolUseId, state) {
      const origin = started.get(toolUseId);
      return origin ? buildProgressSubagent({ ...origin, state }) : null;
    },
  };
}

/** Fresh parent snapshot after a child tool event. */
function snapshotWithTools(
  parent: ProgressSubagent | undefined,
  tools: Map<string, { name: string; status: string }>,
): ProgressSubagent | null {
  if (!parent) return null;
  return buildProgressSubagent({ ...parent, state: 'running', tools: [...tools.values()] });
}

/** Adds or settles one child tool and returns the updated parent snapshot. */
function trackChildTool(
  message: NormalizedMessage,
  parentId: string,
  started: Map<string, ProgressSubagent>,
  childTools: Map<string, Map<string, { name: string; status: string }>>,
): ProgressSubagent | null {
  if (!message.toolId) return null;
  const tools = childTools.get(parentId) ?? new Map<string, { name: string; status: string }>();
  if (message.kind === 'tool_use' && message.toolName) {
    if (tools.size >= 100) tools.delete(tools.keys().next().value as string);
    tools.set(message.toolId, { name: message.toolName, status: 'running' });
  } else if (message.kind === 'tool_result' && tools.has(message.toolId)) {
    tools.get(message.toolId)!.status = message.isError === true ? 'failed' : 'completed';
  } else {
    return null;
  }
  childTools.set(parentId, tools);
  return snapshotWithTools(started.get(parentId), tools);
}

/** Attaches final lifecycle metadata to a Claude delegation result row. */
function settleDelegation(
  raw: AnyRecord,
  message: NormalizedMessage,
  origin: ProgressSubagent,
  childTools: Map<string, Map<string, { name: string; status: string }>>,
): void {
  const result = raw.toolUseResult ?? raw.tool_use_result;
  const resultModel = result && typeof result === 'object' ? (result as AnyRecord).resolvedModel : undefined;
  const subagent = buildProgressSubagent({
    ...origin,
    state: claudeSubagentResultState(result, message.isError === true),
    ...(typeof resultModel === 'string' && resultModel ? { model: resultModel, modelInherited: false } : {}),
    ...(Array.isArray(raw.subagentTools) ? {
      tools: raw.subagentTools.map((tool: AnyRecord) => ({
        name: tool.toolName,
        status: tool.toolResult?.isError ? 'failed' : tool.toolResult ? 'completed' : 'running',
      })),
    } : {}),
    ...(childTools.has(message.toolId ?? '') ? { tools: [...childTools.get(message.toolId ?? '')!.values()] } : {}),
  });
  if (subagent) message.subagent = subagent;
}
