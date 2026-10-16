/**
 * T-2027 (ADR-209) — a trailing ```choices fence on the PRIMARY assistant text
 * is cut before Markdown and rendered as quick replies; everywhere else it
 * stays an ordinary code block.
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/MessageComponent.quickReplies.test.tsx
 */
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';

import type { NormalizedMessage } from '../../../../stores/useSessionStore';
import type { ChatMessage } from '../../types/types';
import {
  CHOICES, CHOICES_REPLY, assistantText, errorRow, streamDelta, thinking, toChat, toolUse, userText,
} from '../../utils/__fixtures__/choicesTranscript';
import { MarkdownContent } from '../../tools/components';

import MessageComponent from './MessageComponent';

const clipboard = vi.hoisted(() => ({ copy: vi.fn(async () => true) }));
vi.mock('../../../../utils/clipboard', () => ({ copyTextToClipboard: clipboard.copy }));
vi.mock('../../../../contexts/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => (opts && opts.defaultValue) || key,
    i18n: { language: 'ar' },
  }),
}));
vi.mock('../../../auth/context/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: null }),
}));
vi.mock('../../../../hooks/useServerActionCatalog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useServerActionCatalog: () => ({ catalog: [], runAction: async () => ({ status: 'error' }), liveStatusOf: () => null }),
}));

type Props = ComponentProps<typeof MessageComponent>;
const renderMessage = (message: ChatMessage, extra: Partial<Props> = {}) =>
  render(<MessageComponent {...({ prevMessage: null, createDiff: () => [], provider: 'claude', message, ...extra } as Props)} />);
const lastOf = (rows: NormalizedMessage[]) => toChat(rows).at(-1)!;
const reply = (content = CHOICES_REPLY) => lastOf([userText('u1', 'q'), assistantText('a1', content)]);

afterEach(() => { cleanup(); clipboard.copy.mockClear(); });

describe('primary assistant text with a valid trailing fence', () => {
  it('eligible: hides the fence and renders interactive buttons in a labelled group', () => {
    const onQuickReply = vi.fn();
    const view = renderMessage(reply(), { quickReplyEligible: true, onQuickReply });
    const group = view.getByRole('group', { name: 'Suggested replies' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(CHOICES);
    expect(buttons.every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(buttons[0].querySelector('span')?.getAttribute('dir')).toBe('auto');
    expect(view.container.querySelector('pre')).toBeNull();
    expect(view.container.textContent).not.toContain('```');
    expect(view.container.textContent).toContain('ثم أخبرني بالنتيجة');

    fireEvent.click(buttons[1]);
    expect(onQuickReply).toHaveBeenCalledWith('لم يعمل');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('non-eligible: hides the fence and shows a static, non-interactive list', () => {
    const view = renderMessage(reply(), { quickReplyEligible: false, onQuickReply: vi.fn() });
    const list = view.getByRole('list', { name: 'Options offered in this reply' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(CHOICES);
    expect(view.queryByRole('group', { name: 'Suggested replies' })).toBeNull();
    expect(view.queryByRole('button', { name: 'شغّلته' })).toBeNull();
    expect(view.container.querySelector('pre')).toBeNull();
  });

  it('streaming: the parseable fence is hidden and no options render until the stream ends', () => {
    const message = lastOf([userText('u1', 'q'), streamDelta('d1')]);
    const view = renderMessage(message, { quickReplyEligible: true, onQuickReply: vi.fn() });
    expect(view.container.querySelector('[data-quick-replies]')).toBeNull();
    expect(view.container.querySelector('pre')).toBeNull();
    expect(view.container.textContent).not.toContain('لم يعمل');
  });

  it('copy keeps the raw fence (faithful markdown copy)', async () => {
    const view = renderMessage(reply(), { quickReplyEligible: true, onQuickReply: vi.fn() });
    fireEvent.click(view.getByRole('button', { name: /Copy as markdown/ }));
    await waitFor(() => expect(clipboard.copy).toHaveBeenCalledWith(CHOICES_REPLY));
  });
});

describe('the fence stays a code block everywhere else', () => {
  const FENCE_ONLY = '```choices\nشغّلته\nلم يعمل\n```';

  it('an invalid fence (one option) on primary text renders as code', () => {
    const view = renderMessage(reply('اختر:\n\n```choices\nوحيد\n```'), { quickReplyEligible: true, onQuickReply: vi.fn() });
    expect(view.container.querySelector('[data-quick-replies]')).toBeNull();
    expect(view.container.querySelector('pre')?.textContent).toContain('وحيد');
  });

  it('thinking text renders the fence as code', () => {
    const message = lastOf([userText('u1', 'q'), thinking('th1')]);
    const view = renderMessage({ ...message, content: FENCE_ONLY }, { showThinking: true, quickReplyEligible: true, onQuickReply: vi.fn() });
    expect(view.container.querySelector('[data-quick-replies]')).toBeNull();
    expect(view.container.querySelector('pre')?.textContent).toContain('لم يعمل');
  });

  it('a tool call and its result never produce quick replies', () => {
    const rows = [userText('u1', 'q'), toolUse('t1'),
      { id: 'r1', sessionId: 'session-choices-1', provider: 'claude', kind: 'tool_result', toolId: 'tool-t1',
        content: FENCE_ONLY, timestamp: '2026-10-15T09:10:00.000Z' } as NormalizedMessage];
    const message = toChat(rows).at(-1)!;
    expect(message.isToolUse).toBe(true);
    vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
    const view = renderMessage(message, { autoExpandTools: true, showToolCalls: true, quickReplyEligible: true, onQuickReply: vi.fn() });
    expect(view.container.querySelector('[data-quick-replies]')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('a tool result (MarkdownContent) renders the fence as a code block', () => {
    const view = render(<MarkdownContent content={`Output:\n\n${FENCE_ONLY}`} />);
    expect(view.container.querySelector('[data-quick-replies]')).toBeNull();
    expect(view.container.querySelector('pre')?.textContent).toContain('لم يعمل');
  });

  it('error rows never produce quick replies', () => {
    const message = lastOf([userText('u1', 'q'), errorRow('e1')]);
    const view = renderMessage({ ...message, content: FENCE_ONLY }, { quickReplyEligible: true, onQuickReply: vi.fn() });
    expect(message.type).toBe('error');
    expect(view.container.querySelector('[data-quick-replies]')).toBeNull();
  });
});
