import { describe, expect, it } from 'vitest';

import type { ChatMessage, PendingPermissionRequest } from '../types/types';

import { classifyPendingQuestions } from './pendingQuestionState';

const askA = { questions: [{ question: 'مشاريع وثائقها أقل من الحد: تلقائياً أم بموافقتك؟', options: [] }] };
const askB = { questions: [{ question: 'المشاريع التي وثائقها أقل من الحد: هل تُبنى تلقائياً؟', options: [] }] };

function ask(requestId: string, input: unknown, sessionId: string | null = 's1'): PendingPermissionRequest {
  return { requestId, toolName: 'AskUserQuestion', input, sessionId };
}

function toolUse(input: unknown, withResult: boolean): ChatMessage {
  return {
    type: 'assistant',
    isToolUse: true,
    toolName: 'AskUserQuestion',
    toolInput: input,
    toolResult: withResult ? { content: 'cancelled', isError: true } : null,
    timestamp: new Date(),
  } as ChatMessage;
}

describe('classifyPendingQuestions', () => {
  it('keeps only the newest of two unresolved asks interactive', () => {
    const states = classifyPendingQuestions([ask('a', askA), ask('b', askB)], [toolUse(askA, false), toolUse(askB, false)]);
    expect(states.get('a')).toBe('superseded');
    expect(states.get('b')).toBe('active');
  });

  it('supersedes an older ask even with no transcript at all', () => {
    const states = classifyPendingQuestions([ask('a', askA), ask('b', askB)]);
    expect([states.get('a'), states.get('b')]).toEqual(['superseded', 'active']);
  });

  it('marks an ask whose tool_use has a tool_result as resolved', () => {
    const states = classifyPendingQuestions([ask('a', askA)], [toolUse(askA, true)]);
    expect(states.get('a')).toBe('resolved');
  });

  it('matches inputs regardless of key order', () => {
    const reordered = { questions: [{ options: [], question: askA.questions[0].question }] };
    const states = classifyPendingQuestions([ask('a', reordered)], [toolUse(askA, true)]);
    expect(states.get('a')).toBe('resolved');
  });

  it('keeps a re-ask of identical text active while its new tool_use is open', () => {
    const states = classifyPendingQuestions([ask('a2', askA)], [toolUse(askA, true), toolUse(askA, false)]);
    expect(states.get('a2')).toBe('active');
  });

  it('a resolved stale ask does not supersede the live one', () => {
    const states = classifyPendingQuestions([ask('a', askA), ask('b', askB)], [toolUse(askA, true), toolUse(askB, false)]);
    expect([states.get('a'), states.get('b')]).toEqual(['resolved', 'active']);
  });

  it('scopes supersession per session and never touches other tools', () => {
    const states = classifyPendingQuestions([
      ask('a', askA, 's1'),
      ask('b', askB, 's2'),
      { requestId: 'w', toolName: 'Write', input: {}, sessionId: 's1' },
      { requestId: 'w2', toolName: 'Write', input: {}, sessionId: 's1' },
    ]);
    expect([...states.values()]).toEqual(['active', 'active', 'active', 'active']);
  });
});
