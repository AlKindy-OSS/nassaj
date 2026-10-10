/**
 * Declared (agent-reported) progress: parser edge cases, folding of sub-agent
 * prose into the container (prose must stay out of the chat), hook propagation
 * and the overall-percent resolution order.
 *
 * Run: npx tsx --tsconfig tsconfig.json --test src/components/chat/hooks/declaredProgress.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';

import {
  parseLatestDeclaredProgress,
  resolveOverallPercent,
} from './declaredProgress.js';
import { normalizedToChatMessages } from './useChatMessages.js';
import { useRunProgress } from './useRunProgress.js';
import type { NormalizedMessage } from '../../../stores/useSessionStore.js';

function runHook<T>(fn: () => T): T {
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  const dispatcher = internals.ReactCurrentDispatcher;
  const prev = dispatcher.current;
  dispatcher.current = { useMemo: (factory: () => unknown) => factory() };
  try {
    return fn();
  } finally {
    dispatcher.current = prev;
  }
}

describe('parseLatestDeclaredProgress', () => {
  it('parses the full governance line', () => {
    assert.deepEqual(
      parseLatestDeclaredProgress('⏳ 40% · done: schema · next: UI · left ~12 min'),
      { percent: 40, done: 'schema', next: 'UI', left: 12 },
    );
  });

  it('returns null when nothing matches (never a fabricated 0)', () => {
    assert.equal(parseLatestDeclaredProgress('working on it, 40% sure'), null);
    assert.equal(parseLatestDeclaredProgress(''), null);
    assert.equal(parseLatestDeclaredProgress('no percent here'), null);
  });

  it('the LATEST matching line wins', () => {
    const text = '⏳ 10% · done: a\nsome prose\n⏳ 55% · done: b\ntrailing prose';
    assert.equal(parseLatestDeclaredProgress(text)?.percent, 55);
    assert.equal(parseLatestDeclaredProgress(text)?.done, 'b');
  });

  it('clamps values above 100', () => {
    assert.equal(parseLatestDeclaredProgress('⏳ 250% · done: x')?.percent, 100);
  });

  it('reads Arabic-Indic digits, Arabic percent sign and Arabic labels', () => {
    assert.deepEqual(
      parseLatestDeclaredProgress('⏳ ٦٠٪ · تم: الواجهة · التالي: الاختبارات · متبقي ~٥ د'),
      { percent: 60, done: 'الواجهة', next: 'الاختبارات', left: 5 },
    );
  });

  it('accepts the completion marker', () => {
    assert.equal(parseLatestDeclaredProgress('✅ 100% · done: all')?.percent, 100);
  });

  it('tolerates missing parts and markdown noise', () => {
    assert.deepEqual(parseLatestDeclaredProgress('**⏳ 33%**'), { percent: 33 });
    assert.deepEqual(parseLatestDeclaredProgress('> ⏳ 70% · next: ship'), { percent: 70, next: 'ship' });
  });
});

describe('parser ignores quoted examples', () => {
  it('ignores fenced and inline-code examples, keeps quote/bullet prefixes', () => {
    assert.equal(parseLatestDeclaredProgress('```\n⏳ 40% · done: x\n```'), null);
    assert.equal(parseLatestDeclaredProgress('~~~text\n⏳ 40%\n~~~\nprose'), null);
    assert.equal(parseLatestDeclaredProgress('format: `⏳ 40% · done: x`'), null);
    assert.equal(parseLatestDeclaredProgress('`⏳ 40%`'), null);
    assert.equal(parseLatestDeclaredProgress('```\n⏳ 40%'), null);
    assert.equal(parseLatestDeclaredProgress('⏳ 20%\n```\n⏳ 90%\n```')?.percent, 20);
    assert.equal(parseLatestDeclaredProgress('- ⏳ 30%')?.percent, 30);
    assert.equal(parseLatestDeclaredProgress('* ⏳ 31%')?.percent, 31);
  });
});

const SESSION = { sessionId: 's1', provider: 'claude' as const };
const AGENT = 'toolu_agent_1';

const rows = (extra: Partial<NormalizedMessage>[]): NormalizedMessage[] => [
  { ...SESSION, id: 'u1', kind: 'text', role: 'user', content: 'go', timestamp: '2026-10-09T10:00:00.000Z', userId: 1 },
  { ...SESSION, id: 'c1', kind: 'tool_use', toolId: AGENT, toolName: 'Agent', timestamp: '2026-10-09T10:00:01.000Z',
    toolInput: { subagent_type: 'frontend-dev', description: 'build' },
    subagent: { id: AGENT, parentId: null, label: 'build', state: 'started' } },
  ...extra,
] as NormalizedMessage[];

const prose = (id: string, role: 'user' | 'assistant', content: string, kind = 'text') => ({
  ...SESSION, id, kind, role, content, parentToolUseId: AGENT, timestamp: '2026-10-09T10:00:05.000Z',
}) as NormalizedMessage;

describe('sub-agent prose folding keeps the progress, drops the rows', () => {
  it('attaches the latest assistant progress line to the container and renders no prose row', () => {
    const chat = normalizedToChatMessages(rows([
      prose('p1', 'assistant', '⏳ 20% · done: a'),
      prose('p2', 'assistant', '⏳ 65% · done: b · next: c · left ~3 min'),
    ]));
    assert.deepEqual(chat.map(m => m.id), ['u1', 'c1']);
    assert.deepEqual(chat[1].subagentState?.progress, { percent: 65, done: 'b', next: 'c', left: 3 });
  });

  it('ignores the delegated PROMPT (role user) even if it quotes the format', () => {
    const chat = normalizedToChatMessages(rows([prose('p1', 'user', 'report like: ⏳ 90% · done: x')]));
    assert.equal(chat[1].subagentState?.progress, undefined);
  });

  it('ignores thinking rows', () => {
    const chat = normalizedToChatMessages(rows([prose('t1', 'assistant', '⏳ 90%', 'thinking')]));
    assert.equal(chat[1].subagentState?.progress, undefined);
  });

  it('propagates to RunAgent; absent prose (page refresh) leaves it undefined', () => {
    const withProse = runHook(() => useRunProgress(
      normalizedToChatMessages(rows([prose('p1', 'assistant', '⏳ 40%')])), true));
    assert.equal(withProse.agents[0].progress?.percent, 40);
    const refreshed = runHook(() => useRunProgress(normalizedToChatMessages(rows([])), true));
    assert.equal(refreshed.agents[0].progress, undefined);
  });
});

describe('accumulated stream_delta with a truncated trailing line', () => {
  it('keeps the last complete value', () => {
    const chat = normalizedToChatMessages(rows([
      prose('d1', 'assistant', '⏳ 40% · done: a\n⏳ 4', 'stream_delta'),
    ]));
    assert.equal(chat[1].subagentState?.progress?.percent, 40);
  });
});

describe('coordinator declaredPercent in useRunProgress', () => {
  it('ignores task notification / reconcile summaries', () => {
    const chat = [
      ...chatOfPlain('on it'),
      { id: 'n1', type: 'assistant', content: 'finished ✅ 100%\n✅ 100%', timestamp: '2026-10-09T10:00:03.000Z',
        isTaskNotification: true },
      { id: 'n2', type: 'assistant', content: '✅ 100%', timestamp: '2026-10-09T10:00:04.000Z',
        isTaskNotification: true, isReconcile: true },
    ] as any[];
    assert.equal(runHook(() => useRunProgress(chat, true)).declaredPercent ?? null, null);
  });

  const chatOf = (assistantText: string) => normalizedToChatMessages([
    { ...SESSION, id: 'u1', kind: 'text', role: 'user', content: 'go', timestamp: '2026-10-09T10:00:00.000Z', userId: 1 },
    { ...SESSION, id: 'a1', kind: 'text', role: 'assistant', content: assistantText, timestamp: '2026-10-09T10:00:02.000Z' },
  ] as NormalizedMessage[]);

  it('reads the latest top-level progress line of the current reply', () => {
    assert.equal(runHook(() => useRunProgress(chatOf('⏳ 45% · done: x'), true)).declaredPercent, 45);
  });

  it('is null (not 0) without a progress line', () => {
    assert.equal(runHook(() => useRunProgress(chatOf('hello'), true)).declaredPercent ?? null, null);
  });

  it('ignores a progress line from a previous reply', () => {
    const chat = normalizedToChatMessages([
      { ...SESSION, id: 'a0', kind: 'text', role: 'assistant', content: '⏳ 80%', timestamp: '2026-10-09T09:00:00.000Z' },
      { ...SESSION, id: 'u1', kind: 'text', role: 'user', content: 'next', timestamp: '2026-10-09T10:00:00.000Z', userId: 1 },
      { ...SESSION, id: 'a1', kind: 'text', role: 'assistant', content: 'on it', timestamp: '2026-10-09T10:00:02.000Z' },
    ] as NormalizedMessage[]);
    assert.equal(runHook(() => useRunProgress(chat, true)).declaredPercent ?? null, null);
  });
});

function chatOfPlain(text: string) {
  return normalizedToChatMessages([
    { ...SESSION, id: 'u9', kind: 'text', role: 'user', content: 'go', timestamp: '2026-10-09T10:00:00.000Z', userId: 1 },
    { ...SESSION, id: 'a9', kind: 'text', role: 'assistant', content: text, timestamp: '2026-10-09T10:00:02.000Z' },
  ] as NormalizedMessage[]);
}

describe('resolveOverallPercent', () => {
  const base = { done: 0, total: 0, inProgress: 0, declaredPercent: null, agents: [] as any[] };

  it('prefers the computed plan fraction (half credit for in-progress)', () => {
    assert.deepEqual(resolveOverallPercent({ ...base, done: 1, total: 4, inProgress: 1, declaredPercent: 90 }),
      { percent: 38, source: 'tasks' });
  });

  it('falls back to the coordinator declared percent', () => {
    assert.deepEqual(resolveOverallPercent({ ...base, declaredPercent: 70 }), { percent: 70, source: 'declared' });
  });

  it('averages agents only when every agent has a value (done counts as 100)', () => {
    const agents = [
      { status: 'running', progress: { percent: 40 } },
      { status: 'done' },
    ] as any[];
    assert.deepEqual(resolveOverallPercent({ ...base, agents }), { percent: 70, source: 'agents' });
    assert.equal(resolveOverallPercent({ ...base, agents: [...agents, { status: 'running' }] }), null);
  });

  it('is null with nothing known', () => {
    assert.equal(resolveOverallPercent(base), null);
  });
});
