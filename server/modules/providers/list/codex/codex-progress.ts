/**
 * ADR-199 P4a: maps Codex plan and subagent signals onto the neutral
 * `plan`/`subagent` fields. Codex item and tool names stay inside this adapter.
 *
 * Shapes:
 * - Live `todo_list` item (@openai/codex-sdk TodoListItem): `items[{text, completed}]`.
 *   It starts when the plan is issued, updates as steps change and completes at
 *   turn end (SDK doc comment). No real stream sample exists on this host.
 * - History `update_plan` function_call: `arguments.plan[{step, status}]` (one real call).
 * - Live `collab_tool_call` (real capture, codex 0.160.0): `{tool, status, receiver_thread_ids: []}`.
 *   The spawn is never streamed and `wait` names no agent, so it maps to one
 *   anonymous "agents working" record keyed by the item id, with no label.
 * - History `spawn_agent` and its FINAL_ANSWER `agent_message` (real capture);
 *   `wait_agent` carries only `timeout_ms` (13423 real calls), so it settles nothing.
 */

import {
  buildProgressPlan,
  buildProgressSubagent,
  type ProgressPlan,
  type ProgressSubagent,
  type SubagentState,
} from '@/shared/progress-normalize.js';

type AnyRecord = Record<string, any>;

const LIVE_PROGRESS_ITEM_TYPES: ReadonlySet<string> = new Set(['todo_list', 'collab_tool_call']);

/** True for a live SDK item whose start and updates are forwarded for progress. */
export function isCodexProgressItem(item: unknown): boolean {
  return Boolean(item && typeof item === 'object' && LIVE_PROGRESS_ITEM_TYPES.has((item as AnyRecord).type));
}

/** Plan from a live `todo_list` item; null when no item survives. */
export function codexTodoListPlan(items: unknown): ProgressPlan | null {
  if (!Array.isArray(items)) return null;
  return buildProgressPlan('tool', items.map((item: unknown) => {
    const record = item && typeof item === 'object' ? item as AnyRecord : {};
    return { label: record.text, status: record.completed === true ? 'completed' : 'pending' };
  }));
}

/** Plan from a history `update_plan` call's parsed arguments; null when none survives. */
export function codexUpdatePlanPlan(args: unknown): ProgressPlan | null {
  const steps = args && typeof args === 'object' ? (args as AnyRecord).plan : undefined;
  if (!Array.isArray(steps)) return null;
  return buildProgressPlan('tool', steps.map((step: unknown) => {
    const record = step && typeof step === 'object' ? step as AnyRecord : {};
    return { label: record.step, status: record.status };
  }));
}

/** Lifecycle of a live `collab_tool_call` item from its phase and status. */
export function codexCollabState(phase: 'started' | 'completed', status: unknown): SubagentState {
  if (status === 'failed') return 'failed';
  return phase === 'completed' ? 'completed' : 'running';
}

/** Anonymous "agents working" record for a live `collab_tool_call` item. */
export function codexCollabSubagent(itemId: unknown, phase: 'started' | 'completed', status: unknown): ProgressSubagent | null {
  return buildProgressSubagent({ id: itemId, parentId: null, label: '', state: codexCollabState(phase, status) });
}

/** Subagent record for a history `spawn_agent` call or its settling result. */
export function codexSpawnSubagent(callId: unknown, label: unknown, state: SubagentState): ProgressSubagent | null {
  // Codex rollout spawn_agent exposes task_name; the transcript does not
  // provide the spawned thread's model, reasoning effort, or tool call list.
  return buildProgressSubagent({ id: callId, parentId: null, label, state });
}

/**
 * Run-scoped record of which progress items already opened a live card, so a
 * later phase of the same item settles that card instead of opening a second
 * one. Created per run in openai-codex.js and dropped with it; bounded.
 */
export type CodexLiveProgressPhases = {
  /** Phase for one item event, or null when the event should not be forwarded. */
  phaseOf(eventType: string, itemId: string): { phase: 'started' | 'updated' | 'completed'; opened: boolean; revision: number } | null;
};

const PHASE_TRACKER_MAX = 200;

/** Creates the per-run phase tracker for `todo_list` and `collab_tool_call` items. */
export function createCodexLiveProgressPhases(maxEntries = PHASE_TRACKER_MAX): CodexLiveProgressPhases {
  const revisions = new Map<string, number>();
  return {
    phaseOf(eventType, itemId) {
      const opened = revisions.has(itemId);
      if (eventType === 'item.completed') {
        const revision = (revisions.get(itemId) ?? 0) + 1;
        revisions.delete(itemId);
        return { phase: 'completed', opened, revision };
      }
      if (eventType === 'item.started' && !opened) {
        if (revisions.size >= maxEntries) revisions.delete(revisions.keys().next().value as string);
        revisions.set(itemId, 0);
        return { phase: 'started', opened: false, revision: 0 };
      }
      if (eventType === 'item.updated' && opened) {
        const revision = (revisions.get(itemId) ?? 0) + 1;
        revisions.set(itemId, revision);
        return { phase: 'updated', opened: true, revision };
      }
      return null;
    },
  };
}

/**
 * Decides whether one live item event reaches the normalizer. Plan/subagent
 * items get their phase stamped on `transformed`; any other item forwards only
 * its terminal `item.completed`, as before ADR-199.
 * @returns true when the event should be normalized and sent.
 */
export function stampCodexProgressPhase(
  phases: CodexLiveProgressPhases,
  eventType: string,
  item: unknown,
  transformed: AnyRecord | null | undefined,
): boolean {
  const intermediate = eventType === 'item.started' || eventType === 'item.updated';
  if (!isCodexProgressItem(item) || typeof transformed?.uuid !== 'string') return !intermediate;
  const progress = phases.phaseOf(eventType, transformed.uuid);
  if (!progress) return false;
  transformed.progressPhase = progress.phase;
  transformed.progressOpened = progress.opened;
  transformed.progressRevision = progress.revision;
  return true;
}

/** Plain text of a Codex content array (`input_text`/`output_text`/`text` parts), joined by newlines. */
export function extractCodexTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const record = item as AnyRecord;
      const textual = record.type === 'input_text' || record.type === 'output_text' || record.type === 'text';
      return textual && typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Display label for a Codex tool or spawn task name (`agent_1` → `Agent 1`). */
export function humanizeCodexToolName(toolName: string): string {
  return toolName
    .replace(/__/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Author path, message type and payload of a rollout `agent_message` (a child
 * agent's report to its parent), or null when it names no author. Shared by
 * the history fold and the live rollout tail so both settle the same spawn.
 */
export function parseCodexSubagentMessage(payload: AnyRecord): {
  author: string;
  messageType: string;
  result: string;
} | null {
  const text = extractCodexTextContent(payload.content);
  const header = /Message Type:\s*([^\r\n]+)[\s\S]*?Sender:\s*([^\r\n]+)[\s\S]*?Payload:\s*\r?\n([\s\S]*)/i.exec(text);
  const author = (typeof payload.author === 'string' && payload.author) || header?.[2]?.trim();
  if (!author) return null;
  return {
    author,
    messageType: header?.[1]?.trim().toUpperCase() || 'MESSAGE',
    result: header?.[3]?.trim() || '',
  };
}
