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
 *     the TodoWrite fraction) therefore reflects ONLY the current reply. This is
 *     required because the AgentActivityStrip is a per-reply indicator that must
 *     "appear and disappear with each reply": an unbounded pass folded in Task/
 *     Agent containers from PRIOR turns, so a new prompt showed the previous
 *     reply's sub-agents (e.g. "0/8 running" with 8 ✓ agents from an earlier
 *     search) before the new run had delegated anything.
 *   - The boundary is the index of the last genuine human user message. The
 *     loop runs `i > boundaryIndex` (not `>= 0`). The "last human prompt"
 *     discriminator is `type === 'user' && !isToolUse && !originKind`: in Claude
 *     transcripts a `tool_result` row can also carry role `user`, but the
 *     normalizer (useChatMessages) never emits those as `type:'user'` (they
 *     become `assistant`/`ToolResult`), and machine-authored user rows
 *     (coordinator/peer/channel/task-notification) always carry `originKind`.
 *     So only a real written prompt is a boundary — never a tool_result or a
 *     coordinator-to-subagent prompt — and the scan is not truncated mid-reply.
 *     Fallback: no human prompt found ⇒ boundaryIndex = -1 ⇒ `i > -1` scans all
 *     messages (the original whole-transcript behaviour).
 *   - A single tail→head pass over that window, NO early exit. The latest
 *     TodoWrite wins by timestamp (it may be top-level or nested in a
 *     sub-agent's childTools); every container row (Task/Agent) IN THE CURRENT
 *     REPLY is still visited and deduped by toolId so all of this reply's
 *     sub-agents are counted and the newest incomplete one is the active one.
 *     One pass, no map/filter over the whole array. (Do NOT add a `break`: the
 *     boundary already stops the pass at the reply edge; a `break` *inside* the
 *     window would stop counting older container rows of the SAME reply and
 *     undercount its sub-agents.)
 *   - Consumes the FULL `chatMessages`, never the windowed `visibleMessages`
 *     (last ~100), so Task containers of the current reply scrolled out of the
 *     visible window are still counted — a single delegation reply can exceed
 *     the ~100-message window (agents with 60+ tool calls each).
 *
 * Counter model (nested, TodoWrite-primary):
 *   - Numerator/denominator come ONLY from the most recent TodoWrite list.
 *   - Sub-agents (Task / Agent) are tooltip detail; they never enter the fraction.
 *   - Safe degradation: TodoWrite list → counter; else an active sub-agent →
 *     "agent working" indicator (no bar, no estimate); else nothing.
 *
 * TodoWrite location (B-63): in nassaj the coordinator delegates via the `Agent`
 * tool and writes NO top-level TodoWrite; the to-do list lives inside the
 * sub-agent. So the latest TodoWrite must be located across BOTH positions —
 * top-level tool_use rows AND `subagentState.childTools` of sub-agent container
 * rows — and the newest of the two (by timestamp) wins. The legacy top-level
 * path is preserved unchanged for sessions whose coordinator does its own
 * TodoWrite. Sub-agent child tools reach `childTools` in two ways: from the
 * history aggregate (`subagentTools`, fetchHistory / completed run) AND — live,
 * mid-run — from the SDK's streamed sub-agent tool blocks, which useChatMessages
 * folds into their container by `parentToolUseId === container.toolId` (B-63).
 * So during a live delegation run the counter now updates as the sub-agent
 * writes its TodoWrite, instead of only showing the active-agent chip.
 */

import { useMemo } from 'react';

import type { ChatMessage, SubagentChildTool } from '../types/types';

/**
 * One delegated sub-agent (a `Task`/`Agent` container row), surfaced for the
 * AgentActivityStrip: a *per-agent* view that the legacy single-`activeSubagent`
 * field cannot express. Derived in the SAME scan pass — no new data path.
 *
 * Ordering: emitted in the order the containers first appear in the transcript
 * (delegation order), so the strip lists agents top-to-bottom as they launched
 * and rows don't reshuffle as one finishes.
 */
export interface RunAgent {
  /** container toolId — stable React key */
  id: string;
  /** `subagent_type` from the container toolInput (an identifier, not translated). */
  type: string;
  /** `description` from the container toolInput; '' when absent. */
  description: string;
  /** running = no tool_result yet; done = container resolved. */
  status: 'running' | 'done';
  /** name of the most recent child tool while running (e.g. 'Read'); undefined when done or idle. */
  currentTool?: string;
  /** number of child tool calls this sub-agent has issued so far. */
  callCount: number;
  /** epoch ms of the container row, for stable ordering / future elapsed display. */
  startedAt: number;
  /** all child tool calls this sub-agent has issued, for the tool-history panel. */
  childTools?: SubagentChildTool[];
}

export interface RunProgress {
  /** completed todos in the latest TodoWrite list */
  done: number;
  /** total todos in the latest TodoWrite list */
  total: number;
  /** in-progress todos in the latest TodoWrite list */
  inProgress: number;
  /** unique Task (sub-agent) tool invocations — tooltip detail only */
  agentsTotal: number;
  /** Task invocations that already have a matching tool_result — tooltip detail only */
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
}

const EMPTY_PROGRESS: RunProgress = {
  done: 0,
  total: 0,
  inProgress: 0,
  agentsTotal: 0,
  agentsDone: 0,
  activeSubagent: null,
  agents: [],
};

/**
 * Read `subagent_type` / `description` off a container's `toolInput`, mirroring
 * SubagentContainer.tsx (verified against real transcripts: the `Agent` tool —
 * the one nassaj actually delegates with, 723 uses vs 1 `Task` — carries the
 * SAME `{ subagent_type, description, prompt }` shape as native `Task`).
 * `toolInput` on a normalized row is a string (JSON) or, in tests, the raw
 * object; handle both. Returns safe fallbacks on any malformed payload.
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
  const type = typeof obj.subagent_type === 'string' && obj.subagent_type ? obj.subagent_type : 'Agent';
  const description = typeof obj.description === 'string' ? obj.description : '';
  return { type, description };
}

/** Same guard the renderer uses (TodoListContent.isTodoItem): drop malformed entries. */
function isTodoItem(value: unknown): value is { content: string; status: string } {
  if (typeof value !== 'object' || value === null) return false;
  const todo = value as Record<string, unknown>;
  return typeof todo.content === 'string' && typeof todo.status === 'string';
}

/**
 * `toolInput` on a normalized ChatMessage is ALWAYS a string: useChatMessages
 * stores it as `typeof toolInput === 'string' ? toolInput : JSON.stringify(...)`.
 * For TodoWrite the original input is an object `{ todos: [...] }`, so we parse
 * and read `.todos`. Returns [] on any malformed / non-JSON payload.
 */
function parseTodos(toolInput: unknown): Array<{ content: string; status: string }> {
  let parsed: unknown = toolInput;
  if (typeof toolInput === 'string') {
    try {
      parsed = JSON.parse(toolInput);
    } catch {
      return [];
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const todos = (parsed as Record<string, unknown>).todos;
  if (!Array.isArray(todos)) return [];
  return todos.filter(isTodoItem);
}

/**
 * @param chatMessages full transcript (NOT the windowed visibleMessages)
 * @param isLoading    whether a run is currently in flight; when false the
 *                     snapshot is forced empty so no stale counter lingers
 *                     (the caller hides the indicators on !isLoading anyway,
 *                     but an empty snapshot keeps the contract clean).
 */
export function useRunProgress(
  chatMessages: ChatMessage[],
  isLoading: boolean,
): RunProgress {
  return useMemo<RunProgress>(() => {
    if (!isLoading || chatMessages.length === 0) {
      return EMPTY_PROGRESS;
    }

    let done = 0;
    let total = 0;
    let inProgress = 0;
    let foundTodos = false;
    // Timestamp (ms) of the TodoWrite list currently locked in, so a TodoWrite
    // found inside a sub-agent's childTools can win over an older top-level one
    // and vice-versa. -Infinity until the first list is found.
    let todosAt = -Infinity;

    // Unique sub-agent (Task / Agent) ids seen, and which have a tool_result.
    const taskIds = new Set<string>();
    let agentsDone = 0;
    let activeSubagent: { callCount: number } | null = null;
    // Per-agent rows for the strip, collected in tail→head order (newest first);
    // reversed to delegation order before return. Keyed dedup is via `taskIds`.
    const agentsRev: RunAgent[] = [];

    // Read a timestamp (string|number|Date) as epoch ms; non-finite → -Infinity
    // so a row with no usable timestamp never displaces a properly-stamped list.
    const tsMs = (value: unknown): number => {
      if (value instanceof Date) return value.getTime();
      const ms = new Date(value as string | number).getTime();
      return Number.isFinite(ms) ? ms : -Infinity;
    };

    // Apply a candidate TodoWrite list if it is newer than the one held. Keeps
    // the "latest list wins" contract across both top-level and child positions.
    const considerTodos = (
      todos: Array<{ content: string; status: string }>,
      at: number,
    ): void => {
      if (todos.length === 0 || at < todosAt) return;
      foundTodos = true;
      todosAt = at;
      let d = 0;
      let p = 0;
      for (const todo of todos) {
        if (todo.status === 'completed') d++;
        else if (todo.status === 'in_progress') p++;
      }
      done = d;
      total = todos.length;
      inProgress = p;
    };

    // Current-reply boundary (T-170): index of the last GENUINE human user
    // prompt. The scan is restricted to rows after it so the snapshot reflects
    // only the reply now in flight and the strip never shows prior turns' agents.
    // Discriminator: a written prompt is `type:'user'` with no `isToolUse` and no
    // `originKind`. A Claude `tool_result` may have role `user`, but the
    // normalizer never emits it as `type:'user'` (it becomes assistant/ToolResult),
    // and machine-authored user rows always carry `originKind` — so neither is a
    // boundary, and the scan is not cut off mid-reply. -1 when no human prompt
    // exists ⇒ the loop bound `i > -1` falls back to the whole transcript.
    let boundaryIndex = -1;
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const m = chatMessages[i];
      if (m.type === 'user' && !m.isToolUse && !m.originKind) {
        boundaryIndex = i;
        break;
      }
    }

    // Tail→head pass over the current reply only (i > boundaryIndex), no early
    // exit *within* the window. The *latest* TodoWrite wins by timestamp via
    // `considerTodos` (it may live top-level OR inside a sub-agent's childTools,
    // so a pure first-hit lock is no longer enough). Container rows (Task/Agent)
    // of this reply must ALL be visited and deduped by toolId so every unique
    // sub-agent is counted; the active sub-agent is the first incomplete
    // container hit scanning backwards (= the most recent one still running).
    // Intentionally `continue`, never `break`: the boundary stops the pass at the
    // reply edge, but a `break` inside the window would skip older container rows
    // of the SAME reply and undercount its sub-agents.
    for (let i = chatMessages.length - 1; i > boundaryIndex; i--) {
      const msg = chatMessages[i];
      if (!msg.isToolUse) continue;

      const toolName = msg.toolName;

      if (toolName === 'TodoWrite') {
        // Top-level TodoWrite (coordinator's own list). Compete by timestamp so
        // a newer list — wherever it lives — always wins.
        considerTodos(parseTodos(msg.toolInput), tsMs(msg.timestamp));
        continue;
      }

      // Sub-agent container: `Task` (Claude native) or `Agent` (agy/Antigravity,
      // the one nassaj actually uses). Count it as a sub-agent AND descend into
      // its childTools for any TodoWrite the sub-agent wrote — that is where the
      // to-do list lives when the coordinator delegates (B-63).
      if (toolName === 'Task' || toolName === 'Agent') {
        const childTools = msg.subagentState?.childTools;
        if (childTools && childTools.length > 0) {
          // Walk tail→head: the newest child TodoWrite is the freshest list for
          // this sub-agent; stop at the first hit to honour "latest wins" while
          // still letting considerTodos arbitrate against other positions.
          for (let c = childTools.length - 1; c >= 0; c--) {
            const child = childTools[c];
            if (child.toolName !== 'TodoWrite') continue;
            considerTodos(parseTodos(child.toolInput), tsMs(child.timestamp));
            break;
          }
        }

        const id = msg.toolId;
        // Unique by toolId; ignore container rows without an id (cannot dedupe).
        if (id && !taskIds.has(id)) {
          taskIds.add(id);
          const complete = msg.subagentState?.isComplete ?? Boolean(msg.toolResult);
          const callCount = childTools?.length ?? 0;
          if (complete) {
            agentsDone++;
          } else if (activeSubagent === null) {
            // First incomplete container scanning backwards = the active one.
            activeSubagent = { callCount };
          }

          // Per-agent row for the strip. `currentTool` (running only) is the
          // most recent child tool name — the same "last child" the container
          // UI treats as current (useChatMessages sets currentToolIndex to the
          // last child). Done agents expose no current tool.
          const meta = readAgentMeta(msg.toolInput);
          const lastChild = childTools && childTools.length > 0 ? childTools[childTools.length - 1] : undefined;
          agentsRev.push({
            id,
            type: meta.type,
            description: meta.description,
            status: complete ? 'done' : 'running',
            currentTool: complete ? undefined : lastChild?.toolName || undefined,
            callCount,
            startedAt: tsMs(msg.timestamp),
            childTools: childTools && childTools.length > 0 ? childTools : undefined,
          });
        }
        continue;
      }
    }

    // Nothing actionable: no todos and no running sub-agent → empty snapshot so
    // the caller renders the unchanged elapsed-only status.
    if (!foundTodos && activeSubagent === null && taskIds.size === 0) {
      return EMPTY_PROGRESS;
    }

    return {
      done,
      total,
      inProgress,
      agentsTotal: taskIds.size,
      agentsDone,
      activeSubagent,
      // tail→head collection reversed → delegation (head→tail) order for the strip.
      agents: agentsRev.reverse(),
    };
  }, [chatMessages, isLoading]);
}
