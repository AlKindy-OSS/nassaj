/**
 * useRunProgress — derive a compact task/agent progress snapshot from the chat
 * transcript so ClaudeStatus can show a "tasks done / total" counter and feed a
 * time estimate, *without* ever re-scanning messages on the per-second tick.
 *
 * Design (locked by review — see task spec §3):
 *   - Pure message scan, memoized on `[chatMessages]` ONLY. It does not read the
 *     clock, so it recomputes only when the transcript actually changes, not
 *     every second.
 *   - CURRENT-REPLY SCOPE (T-170): the scan is bounded to the messages AFTER the
 *     last genuine human user prompt — i.e. the start of the reply now in
 *     flight. The snapshot (agents, agentsTotal/agentsDone, activeSubagent, and
 *     the plan fraction) therefore reflects ONLY the current reply. This is
 *     required because the AgentActivityStrip is a per-reply indicator that must
 *     "appear and disappear with each reply": an unbounded pass folded in sub-agent
 *     rows from PRIOR turns, so a new prompt showed the previous
 *     reply's sub-agents (e.g. "0/8 running" with 8 ✓ agents from an earlier
 *     search) before the new run had delegated anything.
 *   - The boundary is the index of the last genuine human user message. The
 *     loop runs `i > boundaryIndex` (not `>= 0`). The "last human prompt"
 *     discriminator is `type === 'user' && !isToolUse && !originKind`: in some
 *     transcripts a `tool_result` row can also carry role `user`, but the
 *     normalizer (useChatMessages) never emits those as `type:'user'` (they
 *     become `assistant`/`ToolResult`), and machine-authored user rows
 *     (coordinator/peer/channel/task-notification) always carry `originKind`.
 *     So only a real written prompt is a boundary — never a tool_result or a
 *     coordinator-to-subagent prompt — and the scan is not truncated mid-reply.
 *     Fallback: no human prompt found ⇒ boundaryIndex = -1 ⇒ `i > -1` scans all
 *     messages (the original whole-transcript behaviour).
 *   - A single tail→head pass over that window, NO early exit. The latest
 *     plan snapshot wins by timestamp (it may be top-level or nested in a
 *     sub-agent's childTools); every sub-agent row IN THE CURRENT
 *     REPLY is still visited and deduped by toolId so all of this reply's
 *     sub-agents are counted and the newest incomplete one is the active one.
 *     One pass, no map/filter over the whole array. (Do NOT add a `break`: the
 *     boundary already stops the pass at the reply edge; a `break` *inside* the
 *     window would stop counting older container rows of the SAME reply and
 *     undercount its sub-agents.)
 *   - Consumes the FULL `chatMessages`, never the windowed `visibleMessages`
 *     (last ~100), so sub-agent rows of the current reply scrolled out of the
 *     visible window are still counted — a single delegation reply can exceed
 *     the ~100-message window (agents with 60+ tool calls each).
 *
 * Counter model (ADR-199, provider-neutral): the hook reads ONLY the neutral
 * fields the server adapters stamp — `plan` (todo snapshot) and `subagent`
 * (delegation lifecycle) — never tool names, so every harness whose adapter
 * emits them gets the same counter. A guard test (progressHooksNeutral.test.ts)
 * keeps provider and tool names out of this file.
 *   - Numerator/denominator come ONLY from the latest plan snapshot of the
 *     current reply. Items whose status is cancelled/canceled/skipped/deleted
 *     leave both; an unrecognised status counts as pending, so it can never
 *     inflate the percent. A snapshot left with no counted item gives no number.
 *   - Sub-agents are tooltip detail; they never enter the fraction.
 *   - Safe degradation: plan → counter; else an active sub-agent → "agent
 *     working" indicator (no bar, no estimate); else nothing.
 *
 * Plan location (B-63): the coordinator often delegates and writes no plan of
 * its own; the list lives inside the sub-agent. So the latest plan is located
 * across BOTH positions — top-level rows AND `subagentState.childTools` of
 * sub-agent rows — and the newest (by timestamp) wins. Live children reach
 * `childTools` through useChatMessages, which folds rows by `parentToolUseId`.
 */

import { useMemo } from 'react';
import type { SkillObservation, SkillCoverage } from '../../../../shared/skillObservations';

import type { ChatMessage, ProgressPlan, SubagentChildTool } from '../types/types';

import { parseLatestDeclaredProgress, type DeclaredProgress } from './declaredProgress';

/**
 * One delegated sub-agent (a row carrying `subagent`), surfaced for the
 * AgentActivityStrip: a *per-agent* view that the legacy single-`activeSubagent`
 * field cannot express. Derived in the SAME scan pass — no new data path.
 *
 * Ordering: emitted in the order the containers first appear in the transcript
 * (delegation order), so the strip lists agents top-to-bottom as they launched
 * and rows don't reshuffle as one finishes.
 */
export interface RunAgent {
  observedSkills?: SkillObservation[];
  skillCoverage?: SkillCoverage;
  skillsStale?: boolean;
  /** container toolId — stable React key */
  id: string;
  /**
   * `subagent_type` from the container toolInput (an identifier, not
   * translated); '' when absent — the card supplies its own generic label.
   */
  type: string;
  /** Provider-neutral display name, when exposed by the harness. */
  agentName?: string;
  /** Model actually used by this child, or the parent model when inherited. */
  model?: string;
  /** True only when `model` is the parent session model inherited by this child. */
  modelInherited?: boolean;
  /** Provider effort/reasoning setting, when exposed. */
  effort?: string;
  /** Provider-neutral child tool history, including in-progress calls. */
  tools?: Array<{ id?: string; name: string; status?: string }>;
  /** `description` from the container toolInput, else the neutral `subagent.label`; '' when neither. */
  description: string;
  /**
   * running = no tool_result yet; done = container resolved.
   * `stale` is only ever produced by the workflow source (server-read rows):
   * an agent that started, never finished, and has been silent long enough that
   * calling it "running" would be a claim the filesystem does not support. The
   * transcript-derived rows in this file never emit it.
   */
  status: 'running' | 'done' | 'stale';
  /** name of the most recent child tool while running (e.g. 'Read'); undefined when done or idle. */
  currentTool?: string;
  /** number of child tool calls this sub-agent has issued so far. */
  callCount: number;
  /** epoch ms of the container row, for stable ordering / future elapsed display. */
  startedAt: number;
  /** all child tool calls this sub-agent has issued, for the tool-history panel. */
  childTools?: SubagentChildTool[];
  /** Latest self-reported progress line (declared by the agent, not computed). */
  progress?: DeclaredProgress;
}

export interface RunProgress {
  /** completed items in the latest plan snapshot */
  done: number;
  /** counted items (excluded statuses removed) in the latest plan snapshot */
  total: number;
  /** in-progress items in the latest plan snapshot */
  inProgress: number;
  /** unique sub-agents in the current reply — tooltip detail only */
  agentsTotal: number;
  /** sub-agents whose lifecycle is completed or failed — tooltip detail only */
  agentsDone: number;
  /**
   * The single currently-running sub-agent (isComplete === false), if any.
   * `callCount` = number of child tool calls it has issued so far. `null` when
   * no sub-agent is active. Retained for ClaudeStatus's single-agent chip; the
   * full per-agent list lives in `agents`.
   */
  activeSubagent: { callCount: number } | null;
  /**
   * Per-agent rows for the AgentActivityStrip — one entry per unique delegated
   * sub-agent (running OR done) seen in this run, in delegation order. Empty
   * when no sub-agent has been delegated, in which case the strip is not shown
   * and ClaudeStatus keeps its unchanged behaviour.
   */
  agents: RunAgent[];
  /**
   * Percent the coordinator itself declared in its latest top-level progress
   * line of the current reply (`⏳ N%` / `✅ 100%`); null when it never did.
   * Agent-reported, so the UI marks it as declared.
   */
  declaredPercent?: number | null;
  /**
   * True when the run has stopped and this snapshot keeps only the reply's
   * last plan (and its sub-agent tally) for a provider that reports its plan
   * once per turn. Cleared by the next human prompt (the scan boundary).
   */
  settled?: boolean;
  /**
   * True when the provider's sub-agents arrive only once settled (capability
   * `subagents: 'turn'`): the rows hold finished agents only and the card says
   * so, with no running indicator. Set by gateTurnSubagents.
   */
  subagentsWhenFinished?: boolean;
}

const EMPTY_PROGRESS: RunProgress = {
  done: 0,
  total: 0,
  inProgress: 0,
  agentsTotal: 0,
  agentsDone: 0,
  activeSubagent: null,
  agents: [],
  declaredPercent: null,
};

/**
 * Read `subagent_type` / `description` off a delegation row's `toolInput`,
 * mirroring SubagentContainer.tsx. `toolInput` is a JSON string (or, in tests,
 * the raw object); any malformed payload yields empty strings.
 */
function readAgentMeta(toolInput: unknown): { type: string; description: string } {
  let parsed: unknown = toolInput;
  if (typeof toolInput === 'string') {
    try {
      parsed = JSON.parse(toolInput);
    } catch {
      parsed = {};
    }
  }
  const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const type = typeof obj.subagent_type === 'string' ? obj.subagent_type : '';
  const description = typeof obj.description === 'string' ? obj.description : '';
  return { type, description };
}

/** Plan statuses that leave the numerator AND the denominator (ADR-199 Addendum A, Decision 4). */
const EXCLUDED_PLAN_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'canceled', 'skipped', 'deleted']);

/** Server totals over the full list (ADR-199 item 12), or null when absent or inconsistent. */
function validCounts(plan: ProgressPlan | undefined): { done: number; total: number } | null {
  const counts = plan?.counts;
  if (!counts) return null;
  const { done, total } = counts;
  const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  return isCount(done) && isCount(total) && done <= total ? { done, total } : null;
}

/**
 * Counts of one plan snapshot; `total` is 0 when no item is counted. Server
 * `counts` (over the full, uncapped list) win when present; the in-progress
 * figure is then read from the visible items, bounded by the open remainder.
 */
export function countPlan(plan: ProgressPlan | undefined): { done: number; total: number; inProgress: number } {
  const fromItems = countPlanItems(plan);
  const counts = validCounts(plan);
  if (!counts) return fromItems;
  return { ...counts, inProgress: Math.min(fromItems.inProgress, counts.total - counts.done) };
}

function countPlanItems(plan: ProgressPlan | undefined): { done: number; total: number; inProgress: number } {
  let done = 0;
  let total = 0;
  let inProgress = 0;
  for (const item of plan?.items ?? []) {
    const status = typeof item?.status === 'string' ? item.status : '';
    if (EXCLUDED_PLAN_STATUSES.has(status)) continue;
    total++;
    if (status === 'completed') done++;
    else if (status === 'in_progress') inProgress++;
    // Anything else (pending or unrecognised) counts as pending.
  }
  return { done, total, inProgress };
}

/** Newest child carrying a plan, scanning tail→head. */
function latestChildPlan(childTools: SubagentChildTool[] | undefined): SubagentChildTool | undefined {
  if (!childTools) return undefined;
  for (let c = childTools.length - 1; c >= 0; c--) {
    if (childTools[c].plan) return childTools[c];
  }
  return undefined;
}

/**
 * Hide the computed task bar for a provider whose adapter emits no plan
 * (capability `plan: 'none'`). The declared `⏳` percent and the sub-agent rows
 * are untouched, so a provider without a plan still shows what its agent says.
 */
export function gateComputedProgress(progress: RunProgress, planTiming: string): RunProgress {
  if (planTiming !== 'none' || progress.total === 0) return progress;
  return { ...progress, done: 0, total: 0, inProgress: 0 };
}

/**
 * Snapshot kept once the run stopped: the plan and the sub-agent tally only
 * (no active agent, no rows, no declared line). No plan → nothing.
 */
function settledSnapshot(progress: RunProgress): RunProgress {
  if (progress.total === 0) return EMPTY_PROGRESS;
  const { done, total, inProgress, agentsTotal, agentsDone } = progress;
  return { ...EMPTY_PROGRESS, done, total, inProgress, agentsTotal, agentsDone, settled: true };
}

/** A sub-agent lifecycle state that has ended. */
function isSettledState(state: unknown): boolean {
  return state === 'completed' || state === 'failed';
}

/** Per-provider reading options, from its progress capability (ADR-199). */
export interface RunProgressOptions {
  /**
   * Plan arrives once at turn end (capability `plan: 'turn'`): after the run
   * stops, keep the reply's plan as a `settled` snapshot until the next human
   * prompt.
   */
  keepPlanAfterStop?: boolean;
  /**
   * Subagents arrive only on status rows (capability `subagents: 'turn'`):
   * count those with no delegating call. Off otherwise, so a settlement whose
   * call is outside the loaded window never invents an agent.
   */
  statusSubagents?: boolean;
}

/**
 * Show only finished sub-agents for a provider whose sub-agents arrive settled
 * (capability `subagents: 'turn'`, ADR-199 Decision 18): only `done` rows stay,
 * so unfinished `running` and `stale` rows, the active-agent chip and the
 * running count are dropped, and the counter equals the rows shown. The
 * snapshot is flagged so the card can say rows appear when they finish. Other
 * timings pass through unchanged.
 */
export function gateTurnSubagents(progress: RunProgress, subagentTiming: string): RunProgress {
  if (subagentTiming !== 'turn') return progress;
  const agents = progress.agents.filter((agent) => agent.status === 'done');
  return {
    ...progress,
    agents,
    activeSubagent: null,
    agentsTotal: progress.agentsDone,
    subagentsWhenFinished: true,
  };
}

/** Mutable accumulator for one tail→head scan of the current reply. */
interface ScanState {
  done: number;
  total: number;
  inProgress: number;
  foundTodos: boolean;
  /**
   * Timestamp (ms) of the plan snapshot currently locked in, so a snapshot
   * found inside a sub-agent's childTools can win over an older top-level one
   * and vice-versa. -Infinity until the first snapshot is found.
   */
  todosAt: number;
  /** Unique sub-agent ids seen. */
  taskIds: Set<string>;
  agentsDone: number;
  activeSubagent: { callCount: number } | null;
  /**
   * Per-agent rows for the strip, collected in tail→head order (newest first);
   * reversed to delegation order before return. Keyed dedup is via `taskIds`.
   */
  agentsRev: RunAgent[];
  declaredPercent: number | null;
}

function createScanState(): ScanState {
  return {
    done: 0,
    total: 0,
    inProgress: 0,
    foundTodos: false,
    todosAt: -Infinity,
    taskIds: new Set<string>(),
    agentsDone: 0,
    activeSubagent: null,
    agentsRev: [],
    declaredPercent: null,
  };
}

/**
 * Read a timestamp (string|number|Date) as epoch ms; non-finite → -Infinity so
 * a row with no usable timestamp never displaces a properly-stamped list.
 */
function tsMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const ms = new Date(value as string | number).getTime();
  return Number.isFinite(ms) ? ms : -Infinity;
}

/**
 * Apply a candidate plan snapshot if it is newer than the one held. Keeps the
 * "latest snapshot wins" contract across top-level and child positions. A
 * newer snapshot whose items are all excluded still wins (and shows no number):
 * it is the latest state, not a missing one.
 */
function considerPlan(state: ScanState, plan: ProgressPlan | undefined, at: number): void {
  if (!plan || !Array.isArray(plan.items) || plan.items.length === 0 || at < state.todosAt) return;
  state.foundTodos = true;
  state.todosAt = at;
  const counts = countPlan(plan);
  state.done = counts.done;
  state.total = counts.total;
  state.inProgress = counts.inProgress;
}

/**
 * Register one sub-agent id: dedup, settle tally, and the active agent (the
 * first unsettled one scanning backwards). Returns false when already seen.
 */
function registerAgent(state: ScanState, id: string, complete: boolean, callCount: number): boolean {
  if (!id || state.taskIds.has(id)) return false;
  state.taskIds.add(id);
  if (complete) state.agentsDone++;
  else if (state.activeSubagent === null) state.activeSubagent = { callCount };
  return true;
}

/**
 * Sub-agents a row carries from status rows (no delegating call): counted and
 * listed like any other, deduped by id, newest first like the scan.
 */
function considerTurnSubagents(state: ScanState, msg: ChatMessage): void {
  const list = msg.turnSubagents ?? [];
  for (let k = list.length - 1; k >= 0; k--) {
    const sub = list[k];
    const complete = isSettledState(sub?.state);
    if (!sub || !registerAgent(state, sub.id, complete, 0)) continue;
    state.agentsRev.push({
      id: sub.id,
      type: sub.agentName ?? '',
      description: typeof sub.label === 'string' ? sub.label : '',
      agentName: sub.agentName,
      model: sub.model,
      modelInherited: sub.modelInherited,
      effort: sub.effort,
      tools: sub.tools,
      status: complete ? 'done' : 'running',
      callCount: 0,
      startedAt: tsMs(msg.timestamp),
    });
  }
}

/**
 * Newest top-level assistant prose carrying a progress line wins.
 * Background-task notification / reconcile rows are assistant-typed but carry
 * server summaries, not the coordinator's own words.
 */
function considerDeclaredPercent(state: ScanState, msg: ChatMessage): void {
  if (state.declaredPercent !== null || msg.type !== 'assistant') return;
  if (msg.isThinking || msg.isTaskNotification) return;
  state.declaredPercent = parseLatestDeclaredProgress(msg.content ?? '')?.percent ?? null;
}

/**
 * Per-agent row for the strip. `currentTool` (running only) is the most recent
 * child tool name — the same "last child" the container UI treats as current.
 * Done agents expose no current tool.
 */
function buildAgentRow(msg: ChatMessage, id: string, label: string, complete: boolean): RunAgent {
  const childTools = msg.subagentState?.childTools;
  const meta = readAgentMeta(msg.toolInput);
  const lastChild = childTools && childTools.length > 0 ? childTools[childTools.length - 1] : undefined;
  return {
    id,
    type: msg.subagent?.agentName ?? meta.type,
    agentName: msg.subagent?.agentName,
    model: msg.subagent?.model,
    modelInherited: msg.subagent?.modelInherited,
    effort: msg.subagent?.effort,
    tools: msg.subagent?.tools,
    description: meta.description || label,
    status: complete ? 'done' : 'running',
    currentTool: complete ? undefined : lastChild?.toolName || undefined,
    callCount: childTools?.length ?? 0,
    startedAt: tsMs(msg.timestamp),
    childTools: childTools && childTools.length > 0 ? childTools : undefined,
    progress: msg.subagentState?.progress,
  };
}

/**
 * Sub-agent row: count it AND descend into its childTools for the plan the
 * sub-agent wrote — that is where the list lives when the coordinator
 * delegates (B-63). Unique by id; the neutral id equals the delegating call's id.
 */
function considerSubagentRow(state: ScanState, msg: ChatMessage): void {
  const subagent = msg.subagent;
  if (!subagent) return;
  const childTools = msg.subagentState?.childTools;
  const childPlan = latestChildPlan(childTools);
  if (childPlan) considerPlan(state, childPlan.plan, tsMs(childPlan.timestamp));

  const id = msg.toolId || subagent.id;
  const complete = isSettledState(subagent.state);
  if (!registerAgent(state, id, complete, childTools?.length ?? 0)) return;
  state.agentsRev.push(buildAgentRow(msg, id, subagent.label, complete));
}

/**
 * One row of the tail→head pass. Plan snapshot on this row: a call's own, its
 * result's, or a turn-end snapshot useChatMessages carried onto the reply's
 * last row.
 */
function scanMessage(state: ScanState, msg: ChatMessage, statusSubagents: boolean): void {
  considerPlan(state, msg.plan, tsMs(msg.timestamp));
  if (statusSubagents) considerTurnSubagents(state, msg);
  if (msg.isToolUse) considerSubagentRow(state, msg);
  else considerDeclaredPercent(state, msg);
}

/**
 * Current-reply boundary (T-170): index of the last GENUINE human user prompt.
 * The scan is restricted to rows after it so the snapshot reflects only the
 * reply now in flight and the strip never shows prior turns' agents.
 * Discriminator: a written prompt is `type:'user'` with no `isToolUse` and no
 * `originKind`. A `tool_result` may have role `user`, but the normalizer never
 * emits it as `type:'user'` (it becomes assistant/ToolResult), and
 * machine-authored user rows always carry `originKind` — so neither is a
 * boundary, and the scan is not cut off mid-reply. -1 when no human prompt
 * exists ⇒ the loop bound `i > -1` falls back to the whole transcript.
 * T-1862: `/compact` starts a fresh run with no genuine human `type:'user'`
 * prompt — only the locally-added "Context compaction started." assistant row,
 * stamped `isCompactionBoundary`. Without also stopping there, this scan fell
 * through to the PREVIOUS turn's last user message and folded in that turn's
 * (possibly still-incomplete) sub-agents as if they belonged to the
 * compaction run.
 */
function findReplyBoundary(chatMessages: ChatMessage[]): number {
  for (let i = chatMessages.length - 1; i >= 0; i--) {
    const m = chatMessages[i];
    if (m.isCompactionBoundary || (m.type === 'user' && !m.isToolUse && !m.originKind)) return i;
  }
  return -1;
}

/**
 * Snapshot from a finished scan. Nothing actionable (no plan, no sub-agent, no
 * declared line) → empty snapshot so the caller renders the unchanged
 * elapsed-only status.
 */
function snapshotFromScan(state: ScanState): RunProgress {
  if (!state.foundTodos && state.activeSubagent === null && state.taskIds.size === 0 && state.declaredPercent === null) {
    return EMPTY_PROGRESS;
  }
  return {
    done: state.done,
    total: state.total,
    inProgress: state.inProgress,
    agentsTotal: state.taskIds.size,
    agentsDone: state.agentsDone,
    activeSubagent: state.activeSubagent,
    // tail→head collection reversed → delegation (head→tail) order for the strip.
    agents: state.agentsRev.reverse(),
    declaredPercent: state.declaredPercent,
  };
}

/**
 * Pure snapshot computation behind useRunProgress (see the file header).
 * Tail→head pass over the current reply only (i > boundaryIndex), no early
 * exit *within* the window: the latest plan wins by timestamp, and sub-agent
 * rows of this reply must ALL be visited and deduped so every unique sub-agent
 * is counted; the active sub-agent is the first incomplete one hit scanning
 * backwards. Intentionally never `break`: a `break` inside the window would
 * skip older container rows of the SAME reply and undercount its sub-agents.
 */
export function computeRunProgress(
  chatMessages: ChatMessage[],
  isLoading: boolean,
  options: RunProgressOptions = {},
): RunProgress {
  const { keepPlanAfterStop = false, statusSubagents = false } = options;
  if ((!isLoading && !keepPlanAfterStop) || chatMessages.length === 0) return EMPTY_PROGRESS;

  const state = createScanState();
  const boundaryIndex = findReplyBoundary(chatMessages);
  for (let i = chatMessages.length - 1; i > boundaryIndex; i--) {
    scanMessage(state, chatMessages[i], statusSubagents);
  }
  const snapshot = snapshotFromScan(state);
  return isLoading ? snapshot : settledSnapshot(snapshot);
}

/**
 * @param chatMessages full transcript (NOT the windowed visibleMessages)
 * @param isLoading    whether a run is currently in flight; when false the
 *                     snapshot is forced empty so no stale counter lingers,
 *                     unless `options.keepPlanAfterStop`.
 */
export function useRunProgress(
  chatMessages: ChatMessage[],
  isLoading: boolean,
  options: RunProgressOptions = {},
): RunProgress {
  const { keepPlanAfterStop = false, statusSubagents = false } = options;
  return useMemo<RunProgress>(
    () => computeRunProgress(chatMessages, isLoading, { keepPlanAfterStop, statusSubagents }),
    [chatMessages, isLoading, keepPlanAfterStop, statusSubagents],
  );
}
