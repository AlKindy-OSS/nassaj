/**
 * T-2027 (ADR-209) — only the last, settled primary reply is interactive.
 * Run: NODE_ENV=test npx vitest run src/components/chat/utils/quickReplyEligibility.test.ts
 */
import { describe, expect, it } from 'vitest';

import {
  assistantText, errorRow, interactivePrompt, streamDelta, thinking, toChat, toolUse, userText,
} from './__fixtures__/choicesTranscript';
import {
  buildQuickReplyGate, findQuickReplyEligibleIndex, type QuickReplyGate, type QuickReplyGateInput,
} from './quickReplyEligibility';

const OPEN: QuickReplyGate = { isStreaming: false, isRunActive: false, hasPendingPrompt: false, composerCanSend: true };
const conversation = () => toChat([userText('u1', 'كيف أشغّل الاختبارات؟'), assistantText('a1')]);

describe('findQuickReplyEligibleIndex', () => {
  it('the settled last assistant reply is eligible', () => {
    const messages = conversation();
    expect(findQuickReplyEligibleIndex(messages, OPEN)).toBe(messages.length - 1);
  });

  it.each([
    ['the session is streaming', { isStreaming: true }],
    ['a run is active (incl. viewing another member\'s run)', { isRunActive: true }],
    ['an AskUserQuestion / permission panel is pending', { hasPendingPrompt: true }],
    ['the viewer composer cannot send (offline or a command is running)', { composerCanSend: false }],
    ['history is still loading', { isLoadingHistory: true }],
  ])('none while %s', (_label, override) => {
    expect(findQuickReplyEligibleIndex(conversation(), { ...OPEN, ...override })).toBe(-1);
  });

  it('none while the reply itself is still a stream delta', () => {
    const messages = toChat([userText('u1', 'q'), streamDelta('d1')]);
    expect(messages.at(-1)?.isStreaming).toBe(true);
    expect(findQuickReplyEligibleIndex(messages, OPEN)).toBe(-1);
  });

  it.each([
    ['a later user message', () => userText('u2', 'شغّلته')],
    ['a later tool call', () => toolUse('t1')],
    ['a later error', () => errorRow('e1')],
    ['a later interactive prompt', () => interactivePrompt('p1')],
  ])('none after %s', (_label, later) => {
    const messages = toChat([userText('u1', 'q'), assistantText('a1'), later()]);
    expect(findQuickReplyEligibleIndex(messages, OPEN)).toBe(-1);
  });

  it('ignores only the listed trailing non-content rows (thinking)', () => {
    const messages = toChat([userText('u1', 'q'), assistantText('a1'), thinking('th1')]);
    expect(messages.at(-1)?.isThinking).toBe(true);
    expect(findQuickReplyEligibleIndex(messages, OPEN)).toBe(1);
  });

  it('history reload: freshly converted rows keep the last reply eligible and older ones not', () => {
    const rows = [userText('u1', 'q1'), assistantText('a1'), userText('u2', 'شغّلته'), assistantText('a2')];
    const first = toChat(rows);
    const reloaded = toChat(rows);
    expect(reloaded).not.toBe(first);
    expect(findQuickReplyEligibleIndex(reloaded, OPEN)).toBe(3);
  });

  it('no messages → none', () => {
    expect(findQuickReplyEligibleIndex([], OPEN)).toBe(-1);
  });
});

describe('buildQuickReplyGate (ChatInterface state → pane gate)', () => {
  const IDLE: QuickReplyGateInput = {
    isRunActiveForViewer: false, isLoading: false, pendingPermissionCount: 0,
    isConnected: true, executingCommand: null, isImageCropping: false,
  };
  const eligibleWith = (override: Partial<QuickReplyGateInput>) =>
    findQuickReplyEligibleIndex(conversation(), { ...buildQuickReplyGate({ ...IDLE, ...override }), isStreaming: false });

  it('an idle, connected composer opens the gate', () => {
    expect(buildQuickReplyGate(IDLE)).toEqual({ isRunActive: false, hasPendingPrompt: false, composerCanSend: true });
    expect(eligibleWith({})).toBe(1);
  });

  it.each([
    ['a run seen as viewer', { isRunActiveForViewer: true }],
    ['local loading', { isLoading: true }],
    ['a pending permission / AskUserQuestion', { pendingPermissionCount: 1 }],
    ['a lost connection', { isConnected: false }],
    ['a running command', { executingCommand: { name: '/compact', sessionId: 's' } }],
    ['image cropping', { isImageCropping: true }],
  ])('%s blocks it', (_label, override) => {
    expect(eligibleWith(override)).toBe(-1);
  });
});
