/**
 * T-2046 (Q3): prompt collection and the arrow-key recall matrix.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/utils/promptHistory.test.ts
 */
import { describe, it, expect } from 'vitest';

import type { ChatMessage } from '../types/types';

import { collectUserPrompts, decidePromptRecall, type RecallKeyInput } from './promptHistory';

const user = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ type: 'user', content, timestamp: 0, ...extra });

describe('collectUserPrompts', () => {
  it('returns human prompts newest first', () => {
    const messages = [user('one'), { type: 'assistant', content: 'reply', timestamp: 0 }, user('two')];
    expect(collectUserPrompts(messages, null)).toEqual(['two', 'one']);
  });

  it('skips machine-authored, injected, empty and other participants, and collapses repeats', () => {
    const messages = [
      user('mine', { userId: 1 }),
      user('theirs', { userId: 2 }),
      user('coord', { originKind: 'coordinator' }),
      user('steer', { injected: true }),
      user('   '),
      user('again'),
      user('again'),
    ];
    expect(collectUserPrompts(messages, 1)).toEqual(['again', 'mine']);
  });

  it('keeps every participant when the viewer is unknown', () => {
    expect(collectUserPrompts([user('a', { userId: 1 }), user('b', { userId: 2 })], null)).toEqual(['b', 'a']);
  });

  it('handles an empty list', () => {
    expect(collectUserPrompts([], 1)).toEqual([]);
  });
});

const prompts = ['newest', 'line1\nline2', 'oldest'];

function key(k: string, value: string, caret = value.length, extra: Partial<RecallKeyInput> = {}): RecallKeyInput {
  return {
    key: k, value, selectionStart: caret, selectionEnd: caret,
    shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...extra,
  };
}

describe('decidePromptRecall', () => {
  it('ArrowUp on an empty draft recalls the newest prompt', () => {
    expect(decidePromptRecall(key('ArrowUp', ''), prompts, -1)).toEqual({ kind: 'set', index: 0, value: 'newest' });
  });

  it('ArrowUp with no history does nothing', () => {
    expect(decidePromptRecall(key('ArrowUp', ''), [], -1)).toEqual({ kind: 'none' });
  });

  it('ArrowUp walks older while the draft equals the recalled entry', () => {
    expect(decidePromptRecall(key('ArrowUp', 'newest'), prompts, 0)).toEqual({ kind: 'set', index: 1, value: 'line1\nline2' });
  });

  it('ArrowUp in a multi-line entry moves the caret natively until the first line', () => {
    expect(decidePromptRecall(key('ArrowUp', 'line1\nline2'), prompts, 1)).toEqual({ kind: 'none' });
    expect(decidePromptRecall(key('ArrowUp', 'line1\nline2', 2), prompts, 1)).toEqual({ kind: 'set', index: 2, value: 'oldest' });
  });

  it('ArrowUp stops at the oldest prompt', () => {
    expect(decidePromptRecall(key('ArrowUp', 'oldest'), prompts, 2)).toEqual({ kind: 'none' });
  });

  it('never replaces a typed or edited draft', () => {
    expect(decidePromptRecall(key('ArrowUp', 'my draft'), prompts, -1)).toEqual({ kind: 'none' });
    expect(decidePromptRecall(key('ArrowUp', 'newest!'), prompts, 0)).toEqual({ kind: 'none' });
    expect(decidePromptRecall(key('ArrowDown', 'newest!'), prompts, 0)).toEqual({ kind: 'none' });
  });

  it('ArrowDown walks newer, then back to an empty draft', () => {
    expect(decidePromptRecall(key('ArrowDown', 'oldest'), prompts, 2)).toEqual({ kind: 'set', index: 1, value: 'line1\nline2' });
    expect(decidePromptRecall(key('ArrowDown', 'newest'), prompts, 0)).toEqual({ kind: 'set', index: -1, value: '' });
  });

  it('ArrowDown in a multi-line entry waits for the last line', () => {
    expect(decidePromptRecall(key('ArrowDown', 'line1\nline2', 0), prompts, 1)).toEqual({ kind: 'none' });
    expect(decidePromptRecall(key('ArrowDown', 'line1\nline2', 8), prompts, 1)).toEqual({ kind: 'set', index: 0, value: 'newest' });
  });

  it('ArrowDown on an empty draft does nothing', () => {
    expect(decidePromptRecall(key('ArrowDown', ''), prompts, -1)).toEqual({ kind: 'none' });
  });

  it.each([
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['meta', { metaKey: true }],
    ['IME composition', { isComposing: true }],
  ])('leaves %s+arrow to the textarea', (_label, extra) => {
    expect(decidePromptRecall(key('ArrowUp', '', 0, extra), prompts, -1)).toEqual({ kind: 'none' });
  });

  it('leaves a selection to the textarea', () => {
    expect(decidePromptRecall({ ...key('ArrowUp', 'newest'), selectionStart: 0, selectionEnd: 3 }, prompts, 0)).toEqual({ kind: 'none' });
  });

  it('ignores other keys and a stale index', () => {
    expect(decidePromptRecall(key('ArrowLeft', ''), prompts, -1)).toEqual({ kind: 'none' });
    expect(decidePromptRecall(key('ArrowUp', 'newest'), prompts, 9)).toEqual({ kind: 'none' });
  });

  it('works on Arabic (RTL) text the same as Latin', () => {
    const ar = ['مرحباً', 'سؤال سابق'];
    expect(decidePromptRecall(key('ArrowUp', 'مرحباً'), ar, 0)).toEqual({ kind: 'set', index: 1, value: 'سؤال سابق' });
  });
});
