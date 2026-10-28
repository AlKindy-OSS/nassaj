/**
 * Pure readers of the Claude CLI's task lifecycle signals, shared by the run's
 * background-task tracker (claude-sdk.js), the progress fold and the session
 * agents registry (ADR-218), so every consumer agrees on what ends a task.
 *
 * Only structured signals count: the SDK's `system/task_*` events and the CLI's
 * own `<task-notification>` delivery (origin `task-notification`, no subkind).
 */

import type { SubagentState } from '@/shared/progress-normalize.js';

type AnyRecord = Record<string, any>;

// B-1400: the CLI's own `<task-notification>` text names the task and its tool call.
const NOTIFICATION_BLOCK_RE = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g;
const NOTIFICATION_TASK_ID_RE = /<task-id>([^<\s]+)<\/task-id>/;
const NOTIFICATION_TOOL_USE_ID_RE = /<tool-use-id>([^<\s]+)<\/tool-use-id>/;
const NOTIFICATION_STATUS_RE = /<status>([^<\s]+)<\/status>/;
const NOTIFICATION_BODY_RE = /<summary>|<result>/;

/** B-1120: `task_updated` statuses that end a task (`task_notification` ends it at any status). */
export const CLAUDE_TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'killed']);

/**
 * Addendum A §9: the only notification statuses that settle a delegation.
 * Study §3.2 (P0): `killed`/`stopped` are a measured stop, never a failure.
 */
export const CLAUDE_SETTLED_STATES: Readonly<Record<string, SubagentState>> = Object.freeze({
  completed: 'completed', failed: 'failed', killed: 'stopped', stopped: 'stopped',
});

export type ClaudeNotifiedTask = { taskId: string | null; toolUseId: string | null; status: string | null };

/** A task end with its settled state; `taskId` is authoritative, `toolUseId` the fallback. */
export type ClaudeTaskEnd = { taskId: string | null; toolUseId: string | null; state: SubagentState };

/** Text of a user message, or '' — only used to find `<task-notification>` blocks. */
export function claudeUserMessageText(message: AnyRecord): string {
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
  return Array.from(claudeUserMessageText(message).matchAll(NOTIFICATION_BLOCK_RE), ([, block]) => {
    const body = block.search(NOTIFICATION_BODY_RE);
    const header = body === -1 ? block : block.slice(0, body);
    return {
      taskId: block.match(NOTIFICATION_TASK_ID_RE)?.[1] ?? null,
      toolUseId: block.match(NOTIFICATION_TOOL_USE_ID_RE)?.[1] ?? null,
      status: header.match(NOTIFICATION_STATUS_RE)?.[1] ?? null,
    };
  });
}

const idOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * Task ends a raw event reports: the SDK's `system/task_notification`, the CLI
 * notification blocks and, with `includeUpdates`, a terminal `task_updated`
 * (which names the task only). Unknown statuses end nothing.
 */
export function claudeTaskEnds(raw: AnyRecord, options: { includeUpdates?: boolean } = {}): ClaudeTaskEnd[] {
  let found: ClaudeNotifiedTask[];
  if (raw?.type === 'system' && raw.subtype === 'task_notification') {
    found = [{ taskId: idOf(raw.task_id), toolUseId: idOf(raw.tool_use_id), status: raw.status }];
  } else if (options.includeUpdates && raw?.type === 'system' && raw.subtype === 'task_updated'
    && CLAUDE_TERMINAL_TASK_STATUSES.has(raw.patch?.status)) {
    found = [{ taskId: idOf(raw.task_id), toolUseId: idOf(raw.tool_use_id), status: raw.patch.status }];
  } else {
    found = claudeNotifiedTasks(raw);
  }
  const ends: ClaudeTaskEnd[] = [];
  for (const { taskId, toolUseId, status } of found) {
    const state = typeof status === 'string' ? CLAUDE_SETTLED_STATES[status] : undefined;
    if (state && (taskId || toolUseId)) ends.push({ taskId, toolUseId, state });
  }
  return ends;
}

/**
 * `{ taskId, toolUseId }` an event binds: a `local_agent` task_started (its task
 * id is the agent id), or a delegation result naming its agent (`agentId`).
 */
export function claudeAgentTaskBindings(raw: AnyRecord): Array<{ taskId: string; toolUseId: string }> {
  if (raw?.type === 'system' && raw.subtype === 'task_started') {
    const taskId = idOf(raw.task_id);
    const toolUseId = idOf(raw.tool_use_id);
    return raw.task_type === 'local_agent' && taskId && toolUseId ? [{ taskId, toolUseId }] : [];
  }
  if (raw?.type !== 'user' || !Array.isArray(raw.message?.content)) return [];
  const result = raw.toolUseResult ?? raw.tool_use_result;
  const agentId = result && typeof result === 'object' ? idOf((result as AnyRecord).agentId) : null;
  if (!agentId) return [];
  return raw.message.content.flatMap((block: AnyRecord) => {
    const toolUseId = block?.type === 'tool_result' ? idOf(block.tool_use_id) : null;
    return toolUseId ? [{ taskId: agentId, toolUseId }] : [];
  });
}
