/**
 * ADR-218: folds one Claude event (a raw SDK stream message, or a recorded
 * transcript row on reconstruction) into the session agents registry.
 *
 * Starts: `system/task_started` of a `local_agent`, or an `Agent`/`Task`
 * tool_use. Resume: a SendMessage result carrying the structured
 * `resumedAgentId`. Ends: only a structured end — `task_notification`, a
 * terminal `task_updated`, or the CLI's own notification row (origin
 * `task-notification` without subkind) — or the delegation's own tool_result
 * for an agent never moved to the background. No free text is ever read.
 */

import { CLAUDE_TERMINAL_TASK_STATUSES, claudeTaskEnds } from '@/modules/providers/list/claude/claude-task-events.js';
import type { SubagentState } from '@/shared/progress-normalize.js';

import type { AgentAccuracy, AgentEventContext, AgentState, RunToken, SessionAgentRegistry } from './registry.js';

type AnyRecord = Record<string, any>;

const DELEGATION_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);

const END_STATE: Readonly<Partial<Record<SubagentState, Exclude<AgentState, 'running'>>>> = {
  completed: 'done', failed: 'failed', stopped: 'stopped', unknown: 'unknown',
};

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

export type ClaudeEventSource = { accuracy: AgentAccuracy; runToken?: RunToken | null; now?: () => number };

/** Folds one event; never throws on malformed input (it is ignored). */
export function observeClaudeAgentEvent(
  registry: SessionAgentRegistry, sessionId: string | null, raw: unknown, source: ClaudeEventSource,
): void {
  if (!sessionId || !raw || typeof raw !== 'object') return;
  const event = raw as AnyRecord;
  const now = source.now ?? Date.now;
  const stamped = source.accuracy === 'reconstructed' ? Date.parse(event.timestamp) : NaN;
  const ctx: AgentEventContext = { at: Number.isFinite(stamped) ? stamped : now(),
    accuracy: source.accuracy, runToken: source.runToken ?? null };
  if (event.type === 'system') observeSystem(registry, sessionId, event, ctx);
  else if (event.type === 'assistant') observeDelegations(registry, sessionId, event, ctx);
  else if (event.type === 'user') observeResults(registry, sessionId, event, ctx);
  if (event.type === 'system' || event.type === 'user') applyEnds(registry, sessionId, event, ctx);
}

function observeSystem(registry: SessionAgentRegistry, sessionId: string, event: AnyRecord, ctx: AgentEventContext) {
  const agentId = text(event.task_id);
  if (!agentId) return;
  if (event.subtype === 'task_started') {
    if (event.task_type !== 'local_agent' || event.ambient === true || event.skip_transcript === true) return;
    registry.start(sessionId, { agentId, toolUseId: text(event.tool_use_id), label: text(event.description),
      agentType: text(event.subagent_type), background: event.is_backgrounded === true }, ctx);
    return;
  }
  if (event.subtype === 'task_updated' && event.patch?.is_backgrounded === true
    && !CLAUDE_TERMINAL_TASK_STATUSES.has(event.patch?.status)) {
    registry.markBackgrounded(sessionId, { agentId });
  }
}

function observeDelegations(registry: SessionAgentRegistry, sessionId: string, event: AnyRecord, ctx: AgentEventContext) {
  const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
  for (const block of blocks) {
    if (block?.type !== 'tool_use' || !DELEGATION_TOOLS.has(block.name) || !text(block.id)) continue;
    const input: AnyRecord = block.input && typeof block.input === 'object' ? block.input : {};
    registry.start(sessionId, { toolUseId: block.id, label: text(input.description) ?? text(input.subagent_type),
      agentType: text(input.subagent_type), model: text(input.model),
      effort: text(input.effort) ?? text(input.reasoning_effort), background: input.run_in_background === true }, ctx);
  }
}

function observeResults(registry: SessionAgentRegistry, sessionId: string, event: AnyRecord, ctx: AgentEventContext) {
  const blocks = Array.isArray(event.message?.content)
    ? event.message.content.filter((block: AnyRecord) => block?.type === 'tool_result' && text(block.tool_use_id))
    : [];
  const structured = event.toolUseResult ?? event.tool_use_result;
  // The structured result belongs to the message's only tool_result.
  const result: AnyRecord | null = blocks.length === 1 && structured && typeof structured === 'object' ? structured : null;
  for (const block of blocks) {
    const toolUseId: string = block.tool_use_id;
    const resumed = text(result?.resumedAgentId);
    if (resumed) {
      registry.resume(sessionId, resumed, toolUseId, ctx);
      continue;
    }
    const agentId = text(result?.agentId);
    if (agentId) registry.bind(sessionId, toolUseId, agentId, ctx);
    const model = text(result?.resolvedModel);
    if (model) registry.update(sessionId, { toolUseId }, { model });
    if (result?.status === 'async_launched') {
      registry.markBackgrounded(sessionId, { toolUseId });
      continue;
    }
    registry.endForeground(sessionId, toolUseId, block.is_error === true ? 'failed' : 'done', ctx);
  }
}

function applyEnds(registry: SessionAgentRegistry, sessionId: string, event: AnyRecord, ctx: AgentEventContext) {
  for (const { taskId, toolUseId, state } of claudeTaskEnds(event, { includeUpdates: true })) {
    const ended = END_STATE[state];
    if (ended) registry.end(sessionId, { agentId: taskId, toolUseId }, ended, ctx);
  }
}
