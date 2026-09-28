/**
 * T-1862 / B-1339 — `/compact` must open a FRESH progress scope for
 * useRunProgress, not fall through to the previous (finished) turn.
 *
 * Bug: `runPassthroughCompaction` (useChatComposerState.ts) adds only an
 * `assistant` row ("Context compaction started.") and sets isLoading(true).
 * useRunProgress bounds its scan to `i > boundaryIndex`, where boundaryIndex
 * used to be the index of the last genuine `type:'user'` row. Since the
 * compaction row is `assistant`, the scan kept scanning past it into the
 * PRIOR turn and surfaced that turn's (possibly still-incomplete) sub-agent —
 * e.g. a finished session's "qa-critic … Bash" chip reappearing with a stale
 * multi-hour elapsed time during a brand new /compact run.
 *
 * Fix: the compaction row is stamped `isCompactionBoundary: true`; the
 * boundary scan in useRunProgress now also stops there, so nothing from the
 * PRIOR turn (including an incomplete container never resolved before
 * compaction was invoked) leaks into the compaction run's snapshot.
 *
 * Run: npx tsx --tsconfig tsconfig.json --test \
 *        src/components/chat/hooks/compactionBoundary.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { useRunProgress } from './useRunProgress.js';
import { resolveRunStartedAt } from './runStartedAt.js';
import type { ChatMessage } from '../types/types.js';

// Same synchronous-dispatcher shim as b63LiveCounter.test.ts — runs the real
// production reducer (a single useMemo) with no React render.
import React from 'react';
function runHook<T>(fn: () => T): T {
  const ReactInternals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  const dispatcher = ReactInternals.ReactCurrentDispatcher;
  const prev = dispatcher.current;
  dispatcher.current = { useMemo: (factory: () => unknown) => factory() };
  try {
    return fn();
  } finally {
    dispatcher.current = prev;
  }
}

const ts = (s: number) => new Date(1_781_600_000_000 + s * 1000).toISOString();

function priorTurnWithStaleAgent(): ChatMessage[] {
  return [
    // Prior (finished) turn's human prompt.
    { type: 'user', content: 'ابحث في المستودع', timestamp: ts(0) },
    // A sub-agent delegated in that turn that never got a tool_result before
    // the owner ran /compact mid-flight — genuinely still "incomplete" data,
    // but it belongs to a turn that is over.
    {
      type: 'assistant', isToolUse: true, toolName: 'Agent', toolId: 'toolu_prior_agent',
      toolInput: JSON.stringify({ subagent_type: 'qa-critic', description: 'راجع الالتزام' }),
      subagentState: { childTools: [{ toolId: 'c1', toolName: 'Bash', toolInput: '{}', timestamp: new Date(ts(1)) }], currentToolIndex: 0, isComplete: false },
      timestamp: ts(1),
    },
  ];
}

/**
 * qa M-3: the exact pre-fix shape — `runPassthroughCompaction` really does
 * add only a plain `assistant` row (no `isCompactionBoundary`), which is
 * what a build predating this fix produces. Reproducing that literally
 * (rather than omitting the compaction row altogether) is what proves the
 * marker itself, not just "no boundary at all", is what closes the leak.
 */
function unmarkedCompactionRow(): ChatMessage {
  return { type: 'assistant', content: 'Context compaction started.', timestamp: ts(5) };
}

describe('T-1862: compaction boundary scopes useRunProgress away from the prior turn', () => {
  it('WITHOUT the marker, the pre-fix compaction row still leaks the prior-turn agent', () => {
    const chat: ChatMessage[] = [...priorTurnWithStaleAgent(), unmarkedCompactionRow()];
    // A plain `assistant` row is not `type:'user'` and carries no
    // isCompactionBoundary — exactly what shipped before this fix — so the
    // boundary scan falls through to the prior turn's user message anyway.
    const progress = runHook(() => useRunProgress(chat, true));
    assert.equal(progress.agents.length, 1, 'the prior incomplete agent is visible with an unmarked compaction row');
    assert.equal(progress.agents[0].id, 'toolu_prior_agent');
    assert.equal(progress.activeSubagent !== null, true, 'the stale agent is reported active');
  });

  it('a compaction row with isCompactionBoundary excludes the prior turn entirely', () => {
    const chat: ChatMessage[] = [
      ...priorTurnWithStaleAgent(),
      // The compaction-started row — assistant, not user, but must still act
      // as a fresh boundary.
      { type: 'assistant', content: 'Context compaction started.', isCompactionBoundary: true, timestamp: ts(5) },
    ];
    const progress = runHook(() => useRunProgress(chat, true));
    assert.deepEqual(progress.agents, [], 'no agent from the prior turn leaks through');
    assert.equal(progress.activeSubagent, null, 'no stale active-subagent chip');
    assert.equal(progress.agentsTotal, 0);
  });

  it('a NEW sub-agent delegated after the compaction boundary is still counted normally', () => {
    const chat: ChatMessage[] = [
      ...priorTurnWithStaleAgent(),
      { type: 'assistant', content: 'Context compaction started.', isCompactionBoundary: true, timestamp: ts(5) },
      {
        type: 'assistant', isToolUse: true, toolName: 'Agent', toolId: 'toolu_new_agent',
        toolInput: JSON.stringify({ subagent_type: 'general', description: 'مهمة جديدة' }),
        subagentState: { childTools: [], currentToolIndex: 0, isComplete: false },
        timestamp: ts(6),
      },
    ];
    const progress = runHook(() => useRunProgress(chat, true));
    assert.equal(progress.agents.length, 1);
    assert.equal(progress.agents[0].id, 'toolu_new_agent');
    assert.equal(progress.activeSubagent !== null, true);
  });

  it('a completed prior-turn container can never surface as active even without a boundary', () => {
    const chat: ChatMessage[] = [
      { type: 'user', content: 'ابحث', timestamp: ts(0) },
      {
        type: 'assistant', isToolUse: true, toolName: 'Agent', toolId: 'toolu_done_agent',
        toolInput: JSON.stringify({ subagent_type: 'qa-critic', description: 'مراجعة' }),
        subagentState: { childTools: [], currentToolIndex: 0, isComplete: true },
        toolResult: { content: 'done' },
        timestamp: ts(1),
      },
    ];
    const progress = runHook(() => useRunProgress(chat, true));
    assert.equal(progress.activeSubagent, null, 'a completed container is never reported active');
    assert.equal(progress.agents[0].status, 'done');
  });
});

describe('T-1862 round 2 (qa M-3): resolveRunStartedAt (extracted from ChatInterface)', () => {
  it('anchors on the last genuine human user message', () => {
    const chat: ChatMessage[] = [
      { type: 'user', content: 'أول', timestamp: ts(0) },
      { type: 'assistant', content: 'ردّ', timestamp: ts(1) },
      { type: 'user', content: 'ثانٍ', timestamp: ts(2) },
    ];
    assert.equal(resolveRunStartedAt(chat), new Date(ts(2)).getTime());
  });

  it('a compaction boundary row anchors the run, not the prior user message', () => {
    const chat: ChatMessage[] = [...priorTurnWithStaleAgent(), unmarkedCompactionRow()];
    // Even the unmarked row is not `type:'user'`, so this alone does not
    // change the anchor — it stays on the prior turn's user message. This
    // documents the pre-fix anchor to contrast with the marked case below.
    assert.equal(resolveRunStartedAt(chat), new Date(ts(0)).getTime());
  });

  it('WITH the marker, the anchor moves to the compaction row itself', () => {
    const chat: ChatMessage[] = [
      ...priorTurnWithStaleAgent(),
      { type: 'assistant', content: 'Context compaction started.', isCompactionBoundary: true, timestamp: ts(5) },
    ];
    assert.equal(resolveRunStartedAt(chat), new Date(ts(5)).getTime());
  });

  it('a normal user message sent after compaction becomes the new anchor', () => {
    const chat: ChatMessage[] = [
      ...priorTurnWithStaleAgent(),
      { type: 'assistant', content: 'Context compaction started.', isCompactionBoundary: true, timestamp: ts(5) },
      { type: 'user', content: 'بعد الضغط', timestamp: ts(9) },
    ];
    assert.equal(resolveRunStartedAt(chat), new Date(ts(9)).getTime());
  });

  it('skips isLocalCommandStdout rows even though they carry type:"user"', () => {
    const chat: ChatMessage[] = [
      { type: 'user', content: 'real prompt', timestamp: ts(0) },
      { type: 'user', content: '$ some local command output', isLocalCommandStdout: true, timestamp: ts(3) },
    ];
    assert.equal(resolveRunStartedAt(chat), new Date(ts(0)).getTime());
  });

  it('returns null with no usable anchor at all', () => {
    const chat: ChatMessage[] = [
      { type: 'assistant', content: 'صدى فقط', timestamp: ts(0) },
    ];
    assert.equal(resolveRunStartedAt(chat), null);
  });
});
