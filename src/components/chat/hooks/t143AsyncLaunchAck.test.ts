/**
 * T-143 (B-63 root-cause fix) — a background-launched Agent/Task sub-agent's
 * FIRST tool_result is a launch ACKNOWLEDGMENT, not the real completion.
 *
 * Root cause, established from real production transcripts (this project's
 * own `~/.claude/projects/-home-dev-workspace-nassaj/*.jsonl` history):
 * of the two execution modes for the `Agent` tool, the background one (the
 * default — `run_in_background`) resolves its container's tool_result within
 * ~3-7ms of the tool_use, with `toolUseResult` shaped
 * `{ isAsync: true, status: 'async_launched', agentId, outputFile, ... }`.
 * The delegated work has barely started at that point and continues
 * out-of-process for the rest of the turn (often past it), reporting real
 * completion later via a separate task-notification message — never a second
 * tool_result on the same toolId.
 *
 * Before this fix, `normalizedToChatMessages` treated ANY tool_result on the
 * container as `isComplete: true` (useChatMessages.ts), so a background
 * delegation flipped to "done" within milliseconds: useRunProgress's
 * `activeSubagent` nulled out immediately, `agentsDone` incremented on launch,
 * and the per-agent strip row showed "done" for the rest of the run — even
 * though the sub-agent was still working. This is why the "still working"
 * signal (and any chance of a later TodoWrite being attributed to a live
 * container) never survived long enough to render (T-143).
 *
 * This test drives the real production units against a true-shaped stream —
 * an Agent container immediately followed by its async-launch acknowledgment
 * tool_result — and asserts the container (and therefore useRunProgress)
 * still treats it as running. A sibling case proves a genuine (foreground,
 * blocking) completion is untouched.
 *
 * Run: npx tsx --tsconfig tsconfig.json --test \
 *        src/components/chat/hooks/t143AsyncLaunchAck.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizedToChatMessages } from './useChatMessages.js';
import { useRunProgress } from './useRunProgress.js';
import type { NormalizedMessage } from '../../../stores/useSessionStore.js';

// ── Minimal React dispatcher shim (same as b63LiveCounter.test.ts) ─────────
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

const PARENT_ID = 'toolu_agent_container_01';
const ts = (s: number) => new Date(1_781_600_000_000 + s * 1000).toISOString();

describe('T-143: background-launch acknowledgment is not real completion', () => {
  it('keeps an async-launched Agent container running (isComplete=false)', () => {
    const stream: NormalizedMessage[] = [
      { id: 'm1', kind: 'text', role: 'user', content: 'نفّذ مهمة في الخلفية', timestamp: ts(0) },
      {
        id: 'm2', kind: 'tool_use', role: 'assistant',
        toolName: 'Agent', toolId: PARENT_ID,
        toolInput: { description: 'خلفية', subagent_type: 'general' },
        timestamp: ts(2),
      },
      // Real-shape launch acknowledgment: arrives ~5ms later (production
      // transcripts measured 0.003-0.007s), long before any real work is done.
      {
        id: 'm3', kind: 'tool_result', role: 'user', toolId: PARENT_ID,
        content: 'launched', timestamp: ts(2),
        toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'a1' },
      },
    ] as NormalizedMessage[];

    const chat = normalizedToChatMessages(stream);
    const container = chat.find((m) => m.isToolUse && m.toolId === PARENT_ID);
    assert.ok(container, 'Agent container row present');
    assert.equal(
      container!.subagentState?.isComplete,
      false,
      'a launch acknowledgment must not mark the container complete',
    );

    const progress = runHook(() => useRunProgress(chat, /* isLoading */ true));
    assert.ok(
      progress.activeSubagent,
      'the background-launched sub-agent is still reported as the active one',
    );
    assert.equal(progress.agentsDone, 0, 'not counted as done off a launch ack');
    assert.equal(progress.agents[0]?.status, 'running', 'strip row stays running');
  });

  it('still resolves a genuine (foreground/blocking) completion as done', () => {
    const stream: NormalizedMessage[] = [
      { id: 'm1', kind: 'text', role: 'user', content: 'نفّذ مهمة الآن', timestamp: ts(0) },
      {
        id: 'm2', kind: 'tool_use', role: 'assistant',
        toolName: 'Agent', toolId: PARENT_ID,
        toolInput: { description: 'مباشرة', subagent_type: 'general' },
        timestamp: ts(2),
      },
      // Foreground delegation: the tool_result carries the real aggregated
      // result, no isAsync/async_launched marker — unchanged behaviour.
      {
        id: 'm3', kind: 'tool_result', role: 'user', toolId: PARENT_ID,
        content: 'done', timestamp: ts(20),
        toolUseResult: { status: 'completed', prompt: '...' },
      },
    ] as NormalizedMessage[];

    const chat = normalizedToChatMessages(stream);
    const container = chat.find((m) => m.isToolUse && m.toolId === PARENT_ID);
    assert.equal(
      container!.subagentState?.isComplete,
      true,
      'a real (non-async) completion still resolves isComplete',
    );

    const progress = runHook(() => useRunProgress(chat, /* isLoading */ true));
    assert.equal(progress.activeSubagent, null, 'no active sub-agent once genuinely done');
    assert.equal(progress.agentsDone, 1, 'counted as done on a real completion');
  });
});
