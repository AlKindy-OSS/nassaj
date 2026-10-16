/**
 * ADR-199 Addendum B (B-1560, P3): the one reader of an OpenCode tool `part`,
 * shared by the live `opencode run --format json` stream and the history
 * `part` rows so the two paths cannot drift.
 *
 * Real shape (OpenCode 1.18.34 capture): a live line is
 * `{type:'tool_use', timestamp, sessionID, part}` and a history row's data is the
 * same `part`: `{callID, tool, type:'tool', state:{status, input, output,
 * metadata, title, time}}`. `run` emits only settled parts (`completed`|`error`).
 *
 * - `todowrite` → `plan`: items from `state.metadata.todos`, else
 *   `state.input.todos` (`{content, status, priority}`). `state.title` counts
 *   only open items, so it is never used. Ids are indexes (no stable ids).
 * - `task` → `subagent`: id `callID` (else the child `metadata.sessionId`),
 *   label `input.description` (else `input.subagent_type`); `completed` →
 *   completed, `error` → failed. No running state exists, so none is emitted.
 */

import {
  buildProgressPlan,
  buildProgressSubagent,
  type ProgressPlan,
  type ProgressSubagent,
} from '@/shared/progress-normalize.js';

type AnyRecord = Record<string, any>;

export type OpenCodeToolPart = {
  toolName: string;
  toolId: string | undefined;
  toolInput: unknown;
  /** Present once the part settled (`completed`/`error`) or a legacy flat event carried output. */
  toolResult?: { content: string; isError: boolean };
  plan?: ProgressPlan;
  subagent?: ProgressSubagent;
};

const asRecord = (value: unknown): AnyRecord | undefined => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : undefined
);

const asString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.length > 0 ? value : undefined
);

/** Tool output as display text; objects are pretty-printed JSON. */
export const formatToolContent = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

/** Plan snapshot of a settled `todowrite` state; null when no item survives. */
export function openCodeTodoPlan(state: AnyRecord): ProgressPlan | null {
  const fromMetadata = asRecord(state.metadata)?.todos;
  const todos = Array.isArray(fromMetadata) ? fromMetadata : asRecord(state.input)?.todos;
  if (!Array.isArray(todos)) return null;
  return buildProgressPlan('tool', todos.map((todo: unknown) => {
    const record = asRecord(todo) ?? {};
    return { label: record.content, status: record.status };
  }));
}

/** Subagent record of a settled `task` part; null while unsettled or without an id. */
export function openCodeTaskSubagent(callId: string | undefined, state: AnyRecord): ProgressSubagent | null {
  const status = asString(state.status);
  if (status !== 'completed' && status !== 'error') return null;
  const input = asRecord(state.input) ?? {};
  // OpenCode's real task part includes metadata.model.modelID for the child
  // session. It does not expose a reasoning/effort field on this event shape.
  const model = asString(asRecord(state.metadata)?.model?.modelID);
  return buildProgressSubagent({
    id: callId ?? asString(asRecord(state.metadata)?.sessionId),
    parentId: null,
    label: asString(input.description) ?? input.subagent_type,
    state: status === 'error' ? 'failed' : 'completed',
    agentName: input.subagent_type,
    model,
  });
}

/**
 * Reads one tool part. `legacy` is the enclosing flat live event, consulted
 * only when the part lacks a field (pre-`part` stream shapes).
 */
export function openCodeToolPart(part: unknown, legacy: AnyRecord = {}): OpenCodeToolPart {
  const record = asRecord(part) ?? {};
  const state = asRecord(record.state) ?? {};
  const status = asString(state.status);
  const toolName = asString(record.tool) ?? asString(legacy.tool) ?? asString(legacy.name) ?? 'Tool';
  const toolId = asString(record.callID) ?? asString(legacy.callID) ?? asString(legacy.toolCallId);
  const result: OpenCodeToolPart = {
    toolName,
    toolId,
    toolInput: state.input ?? record.input ?? legacy.input ?? legacy.arguments ?? {},
  };

  if (status === 'completed' || status === 'error') {
    result.toolResult = {
      content: formatToolContent(status === 'error' ? (state.error ?? state.output) : (state.output ?? state.error)),
      isError: status === 'error',
    };
  } else if (!status && (legacy.output !== undefined || legacy.error !== undefined)) {
    result.toolResult = { content: formatToolContent(legacy.output ?? legacy.error), isError: legacy.error !== undefined };
  }

  if (toolName === 'todowrite' && status === 'completed') {
    const plan = openCodeTodoPlan(state);
    if (plan) result.plan = plan;
  } else if (toolName === 'task') {
    const subagent = openCodeTaskSubagent(toolId, state);
    if (subagent) result.subagent = subagent;
  }
  return result;
}
