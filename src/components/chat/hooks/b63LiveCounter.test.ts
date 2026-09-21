/**
 * B-63 behavioural verification — live task-progress counter during a sub-agent
 * delegation run (Package C, end-user verification of commit 95574f9).
 *
 * Premise (confirmed in the served bundle dist/assets/index-DVetNxPH.js, built
 * 2026-06-16 after the fix): a live delegation run streams the sub-agent's
 * tool_use blocks stamped with `parent_tool_use_id` (forwarded by the server as
 * `parentToolUseId`). The end-to-end chain that must hold so ClaudeStatus draws
 * the counter *while the agent is still working* is:
 *
 *   server parentToolUseId  →  NormalizedMessage.parentToolUseId
 *     →  normalizedToChatMessages pre-pass folds the live child into its
 *        Agent/Task container's subagentState.childTools (NOT a flat orphan row)
 *     →  useRunProgress descends into childTools, counts the sub-agent's live
 *        TodoWrite, and marks the running container as activeSubagent
 *     →  ClaudeStatus renders Tasks done/total + bar + active-agent chip.
 *
 * This test drives the REAL production units (normalizedToChatMessages and the
 * real useRunProgress reducer) against a true-shaped LIVE stream — the same
 * shape the SDK emits mid-run — and asserts the counter is non-empty *before*
 * the container has any tool_result (i.e. while still loading). The pre-fix
 * behaviour (orphaned child rows, useRunProgress never descending) would yield
 * an empty snapshot here; the post-fix behaviour yields the live counter.
 *
 * Run: npx tsx --tsconfig tsconfig.json --test \
 *        src/components/chat/hooks/b63LiveCounter.test.ts
 * Typecheck-validated by `npm run typecheck` like the sibling client tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizedToChatMessages } from './useChatMessages.js';
import { useRunProgress } from './useRunProgress.js';
import type { NormalizedMessage } from '../../../stores/useSessionStore.js';

// ── Minimal React dispatcher shim ───────────────────────────────────────────
// useRunProgress is a pure-reducer hook whose only React surface is a single
// useMemo. Run it outside a component by installing a dispatcher that executes
// the memo factory synchronously. This invokes the genuine production reducer
// (no fork / re-implementation), so any regression in useRunProgress is caught.
import React from 'react';
function runHook<T>(fn: () => T): T {
  const ReactInternals =
    (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  const dispatcher = ReactInternals.ReactCurrentDispatcher;
  const prev = dispatcher.current;
  dispatcher.current = {
    useMemo: (factory: () => unknown) => factory(),
    useRef: (v: unknown) => ({ current: v }),
    useCallback: (cb: unknown) => cb,
    useState: (v: unknown) => [v, () => {}],
    useEffect: () => {},
    useContext: () => undefined,
  };
  try {
    return fn();
  } finally {
    dispatcher.current = prev;
  }
}

// ── Fixtures: a LIVE delegation run, mid-flight (no container tool_result) ───
const PARENT_ID = 'toolu_agent_container_01';
const ts = (s: number) => new Date(1_781_600_000_000 + s * 1000).toISOString();

function liveDelegationStream(): NormalizedMessage[] {
  return [
    // 1) Human prompt.
    { id: 'm1', kind: 'text', role: 'user', content: 'نفّذ مهمة من عدة خطوات', timestamp: ts(0) },
    // 2) Sub-agent CONTAINER (Agent — the tool nassaj actually delegates with).
    //    Still running: NO toolResult / no isFinal on the container.
    {
      id: 'm2', kind: 'tool_use', role: 'assistant',
      toolName: 'Agent', toolId: PARENT_ID,
      toolInput: { description: 'multi-step task', subagent_type: 'general' },
      timestamp: ts(2),
    },
    // 3) LIVE child tool_use streamed by the sub-agent: a TodoWrite with 4 items,
    //    1 completed + 1 in_progress. Stamped with parentToolUseId === container.
    {
      id: 'm3', kind: 'tool_use', role: 'assistant',
      toolName: 'TodoWrite', toolId: 'toolu_child_todo_01',
      parentToolUseId: PARENT_ID,
      toolInput: {
        todos: [
          { content: 'اقرأ الملف', status: 'completed' },
          { content: 'عُدّ الأسطر', status: 'in_progress' },
          { content: 'لخّص', status: 'pending' },
          { content: 'أبلغ', status: 'pending' },
        ],
      },
      timestamp: ts(6),
    },
    // 4) Another live child (a Read) — also parent-stamped; must fold, not orphan.
    {
      id: 'm4', kind: 'tool_use', role: 'assistant',
      toolName: 'Read', toolId: 'toolu_child_read_01',
      parentToolUseId: PARENT_ID,
      toolInput: { file_path: '/tmp/x' },
      timestamp: ts(7),
    },
  ] as NormalizedMessage[];
}

describe('B-63 live task-progress counter (commit 95574f9)', () => {
  it('folds live parentToolUseId child rows into the Agent container, not orphans', () => {
    const chat = normalizedToChatMessages(liveDelegationStream());

    // The two parent-stamped children must NOT appear as flat top-level tool rows.
    const flatChildTools = chat.filter(
      (m) => m.isToolUse && (m.toolId === 'toolu_child_todo_01' || m.toolId === 'toolu_child_read_01'),
    );
    assert.equal(flatChildTools.length, 0, 'live child rows must be folded, never emitted flat (B-63)');

    // The container must exist and own both children in subagentState.childTools.
    const container = chat.find((m) => m.isToolUse && m.toolId === PARENT_ID);
    assert.ok(container, 'Agent container row present');
    assert.equal(container!.isSubagentContainer, true, 'recognised as sub-agent container');
    const childTools = container!.subagentState?.childTools ?? [];
    assert.equal(childTools.length, 2, 'both live children folded into the container');
    assert.ok(
      childTools.some((c) => c.toolName === 'TodoWrite'),
      'the sub-agent live TodoWrite is reachable inside childTools',
    );
    // Container is mid-run (no result) → useRunProgress must treat it as active.
    assert.equal(container!.subagentState?.isComplete, false, 'container still running (no tool_result)');
  });

  it('useRunProgress counts the sub-agent live TodoWrite and marks it active while loading', () => {
    const chat = normalizedToChatMessages(liveDelegationStream());
    const progress = runHook(() => useRunProgress(chat, /* isLoading */ true));

    // The fraction comes from the sub-agent's live TodoWrite: 1 done / 4 total.
    assert.equal(progress.total, 4, 'total tasks from the live child TodoWrite');
    assert.equal(progress.done, 1, 'one completed task counted live');
    assert.equal(progress.inProgress, 1, 'one in-progress task counted live');

    // The running container is the active sub-agent (drives the violet chip).
    assert.ok(progress.activeSubagent, 'an active sub-agent is reported (violet chip)');
    assert.equal(progress.agentsTotal, 1, 'one unique sub-agent counted');
    assert.equal(progress.agentsDone, 0, 'sub-agent not yet complete');

    // ClaudeStatus gate: showTaskCounter = isLoading && total > 0. With total=4
    // and isLoading=true, the counter + bar render. This is the live counter.
    assert.ok(progress.total > 0, 'showTaskCounter precondition (total>0) holds during the run');
  });

  it('forces an empty snapshot when not loading (no stale counter lingers)', () => {
    const chat = normalizedToChatMessages(liveDelegationStream());
    const progress = runHook(() => useRunProgress(chat, /* isLoading */ false));
    assert.equal(progress.total, 0);
    assert.equal(progress.activeSubagent, null);
    assert.deepEqual(progress.agents, [], 'no per-agent rows when not loading');
  });

  // AgentActivityStrip data: the per-agent `agents` array derived in the SAME
  // scan, without disturbing the legacy counter fields above.
  it('emits a per-agent row for the running sub-agent (strip data)', () => {
    const chat = normalizedToChatMessages(liveDelegationStream());
    const progress = runHook(() => useRunProgress(chat, /* isLoading */ true));

    assert.equal(progress.agents.length, 1, 'one delegated sub-agent → one strip row');
    const a = progress.agents[0];
    assert.equal(a.id, PARENT_ID, 'row keyed by the container toolId');
    assert.equal(a.type, 'general', 'subagent_type read from the Agent container toolInput');
    assert.equal(a.description, 'multi-step task', 'description read from the container toolInput');
    assert.equal(a.status, 'running', 'mid-run container → running');
    // Two live children folded (TodoWrite then Read); the most recent is current.
    assert.equal(a.callCount, 2, 'callCount = number of folded child tools');
    assert.equal(a.currentTool, 'Read', 'currentTool = the most recent child tool while running');
  });

  // T-170: the AgentActivityStrip is a per-reply indicator — the scan must be
  // bounded to the messages after the last genuine human prompt, so a NEW prompt
  // never surfaces the PRIOR reply's sub-agents. Transcript: (user1 + a COMPLETED
  // agent) then (user2 + a RUNNING agent). Only the second reply's agent counts.
  it('scopes agents to the current reply, excluding a prior reply\'s sub-agents', () => {
    const prevDone = 'toolu_prev_agent_done';
    const curRunning = 'toolu_cur_agent_running';
    const stream: NormalizedMessage[] = [
      // ── Reply 1: a human prompt + a sub-agent that finished. ──
      { id: 'u1', kind: 'text', role: 'user', content: 'ابحث عن شيء', timestamp: ts(0) },
      {
        id: 'a1', kind: 'tool_use', role: 'assistant',
        toolName: 'Agent', toolId: prevDone,
        toolInput: { description: 'prior search', subagent_type: 'researcher' },
        timestamp: ts(2),
      },
      // tool_result for the prior agent → normalizer marks it isComplete=true.
      { id: 'r1', kind: 'tool_result', role: 'user', toolId: prevDone, content: 'done', timestamp: ts(5) },
      // ── Reply 2: a NEW human prompt + a sub-agent still running. ──
      { id: 'u2', kind: 'text', role: 'user', content: 'مهمة جديدة', timestamp: ts(10) },
      {
        id: 'a2', kind: 'tool_use', role: 'assistant',
        toolName: 'Agent', toolId: curRunning,
        toolInput: { description: 'new task', subagent_type: 'general' },
        timestamp: ts(12),
      },
    ] as NormalizedMessage[];

    const chat = normalizedToChatMessages(stream);
    const progress = runHook(() => useRunProgress(chat, /* isLoading */ true));

    // Only the second reply's agent is in scope.
    assert.equal(progress.agentsTotal, 1, 'only the current reply\'s sub-agent counted');
    assert.equal(progress.agents.length, 1, 'one strip row — the prior reply\'s agent is excluded');
    assert.equal(progress.agents[0].id, curRunning, 'the in-scope agent is the current reply\'s one');
    assert.equal(progress.agents[0].status, 'running', 'current reply\'s agent is running');
    // The prior reply\'s completed agent must NOT leak into the done count.
    assert.equal(progress.agentsDone, 0, 'prior reply\'s done agent excluded from agentsDone');
    assert.ok(progress.activeSubagent, 'the current reply\'s running agent is active');
  });

  it('marks a finished sub-agent as done with no currentTool', () => {
    const stream = liveDelegationStream();
    // Resolve the container: a tool_result for the Agent container toolId makes
    // normalizedToChatMessages set subagentState.isComplete = true.
    stream.push({
      id: 'm5', kind: 'tool_result', role: 'user', toolId: PARENT_ID,
      content: 'done', timestamp: ts(20),
    } as NormalizedMessage);
    const chat = normalizedToChatMessages(stream);
    const progress = runHook(() => useRunProgress(chat, /* isLoading */ true));

    assert.equal(progress.agents.length, 1, 'still one unique sub-agent');
    const a = progress.agents[0];
    assert.equal(a.status, 'done', 'resolved container → done');
    assert.equal(a.currentTool, undefined, 'done agents expose no current tool');
    assert.equal(progress.activeSubagent, null, 'no active sub-agent once it resolved');
    assert.equal(progress.agentsDone, 1, 'legacy agentsDone still counts the finished agent');
  });
});
