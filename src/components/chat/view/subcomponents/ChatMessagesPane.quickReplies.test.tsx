/**
 * T-2027 (ADR-209) — eligibility is decided once in the pane: only the last
 * settled reply gets interactive buttons, older replies keep a static list.
 * Uses the real MessageComponent and transcript rows from normalizedToChatMessages.
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/ChatMessagesPane.quickReplies.test.tsx
 */
import { createRef } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage } from '../../types/types';
import { assistantText, toChat, toolUse, userText } from '../../utils/__fixtures__/choicesTranscript';

import ChatMessagesPane from './ChatMessagesPane';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => (opts && opts.defaultValue) || key,
    i18n: { language: 'ar' },
  }),
}));
vi.mock('../../../participants', () => ({ useSessionParticipants: () => ({ participants: [] }) }));
vi.mock('../../../../contexts/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('../../../auth/context/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: null }),
}));
vi.mock('../../../../hooks/useServerActionCatalog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useServerActionCatalog: () => ({ catalog: [], runAction: async () => ({ status: 'error' }), liveStatusOf: () => null }),
}));

const OPEN_GATE = { isRunActive: false, hasPendingPrompt: false, composerCanSend: true };
const base = {
  scrollContainerRef: createRef<HTMLDivElement>(), onWheel: () => {}, onTouchMove: () => {},
  isLoadingSessionMessages: false, selectedSession: { id: 'session-choices-1' }, currentSessionId: 'session-choices-1',
  visibleMessageCount: 100, totalMessages: 0, selectedProject: { name: 'p' }, provider: 'claude', displayProvider: 'claude',
  isLoadingMoreMessages: false, isLoadingAllMessages: false, hasMoreMessages: false, createDiff: () => [],
};

const renderPane = (messages: ChatMessage[], extra: Record<string, unknown> = {}) => {
  const props = { ...base, chatMessages: messages, visibleMessages: messages, quickReplyGate: OPEN_GATE, onQuickReply: vi.fn(), ...extra };
  return { onQuickReply: props.onQuickReply, view: render(<ChatMessagesPane {...(props as any)} />) };
};
const interactive = (container: HTMLElement) => container.querySelectorAll('[data-quick-replies="interactive"]');
const statics = (container: HTMLElement) => container.querySelectorAll('[data-quick-replies="static"]');

afterEach(cleanup);

describe('ChatMessagesPane quick-reply eligibility', () => {
  const history = () => toChat([userText('u1', 'q1'), assistantText('a1'), userText('u2', 'شغّلته'), assistantText('a2')]);

  it('history reload: only the last reply is interactive, the older one is static', () => {
    const { view, onQuickReply } = renderPane(history());
    expect(interactive(view.container)).toHaveLength(1);
    expect(statics(view.container)).toHaveLength(1);
    fireEvent.click(view.getByRole('button', { name: 'لم يعمل' }));
    expect(onQuickReply).toHaveBeenCalledWith('لم يعمل');
  });

  it.each([
    ['streaming', { isStreaming: true }],
    ['a run is active', { quickReplyGate: { ...OPEN_GATE, isRunActive: true } }],
    ['an AskUserQuestion is pending', { quickReplyGate: { ...OPEN_GATE, hasPendingPrompt: true } }],
    ['the viewer composer cannot send', { quickReplyGate: { ...OPEN_GATE, composerCanSend: false } }],
  ])('%s → every reply is static', (_label, extra) => {
    const { view } = renderPane(history(), extra);
    expect(interactive(view.container)).toHaveLength(0);
    expect(statics(view.container)).toHaveLength(2);
  });

  it('a later user message or tool call makes the reply static', () => {
    for (const later of [userText('u9', 'next'), toolUse('t9')]) {
      const { view } = renderPane(toChat([userText('u1', 'q1'), assistantText('a1'), later]));
      expect(interactive(view.container)).toHaveLength(0);
      cleanup();
    }
  });

  it('without the callback (no composer wiring) nothing is interactive', () => {
    const { view } = renderPane(history(), { onQuickReply: undefined });
    expect(interactive(view.container)).toHaveLength(0);
  });
});
