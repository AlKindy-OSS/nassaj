/**
 * B-1624: a Codex user stop arrives as `kind: 'notice'` after the turn's
 * `complete`. It renders as one muted line (no error bubble, no copy control),
 * and it is not a delivery verdict, so the sent message is never marked failed.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/MessageComponent.notice.test.tsx
 */

import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import { normalizedToChatMessages } from '../../hooks/useChatMessages';
import type { NormalizedMessage } from '../../../../stores/useSessionStore';

import { resolveOutboxVerdict } from '../../utils/messageOutbox';

import MessageComponent from './MessageComponent';
import arChat from '../../../../i18n/locales/ar/chat.json';
import enChat from '../../../../i18n/locales/en/chat.json';

vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false }),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; name?: string }) =>
      (opts?.defaultValue || key).replace('{{name}}', opts?.name ?? ''),
    i18n: { language: 'ar' },
  }),
}));

vi.mock('../../../auth/context/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: null }),
}));

vi.mock('../../../auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: null }),
}));

vi.mock('../../../../hooks/useServerActionCatalog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useServerActionCatalog: () => ({
    catalog: [],
    runAction: async () => ({ status: 'error', code: 'not_initialized' }),
    liveStatusOf: () => null,
  }),
}));

type Props = ComponentProps<typeof MessageComponent>;

afterEach(cleanup);

const notice = {
  id: 'n1', sessionId: 's', timestamp: '2026-10-20T10:00:00.000Z', provider: 'codex',
  kind: 'notice', code: 'codex_processes_stopped', clientMsgId: 'c-1',
  content: 'أُوقفت الجولة. العمليات المُوقفة: sleep (4321).',
} as unknown as NormalizedMessage;

const renderRow = (message: unknown, prevMessage: unknown = null) => render(
  <MessageComponent {...({ prevMessage, createDiff: () => [], provider: 'codex', message } as unknown as Props)} />,
);

describe('neutral notice row (B-1624)', () => {
  it('converts to a notice chat message carrying the server text', () => {
    const [chat] = normalizedToChatMessages([notice]);
    expect(chat.type).toBe('assistant');
    expect(chat.isNotice).toBe(true);
    expect(chat.content).toContain('sleep (4321)');
  });

  it('drops an empty notice', () => {
    expect(normalizedToChatMessages([{ ...notice, content: '' } as NormalizedMessage])).toHaveLength(0);
  });

  it('renders one muted line, not an error bubble, without a copy control', () => {
    const [chat] = normalizedToChatMessages([notice]);
    const view = renderRow(chat);
    const line = view.container.querySelector('[data-chat-notice]') as HTMLElement;
    expect(line).toBeTruthy();
    expect(line.className).toContain('text-muted-foreground');
    expect(line.textContent).toContain('sleep (4321)');
    expect(view.container.querySelector('.chat-message.error')).toBeNull();
    expect(view.container.innerHTML).not.toMatch(/text-red|bg-red|destructive/);
    expect(view.queryByRole('button')).toBeNull();
  });

  it('is never grouped under the preceding assistant reply', () => {
    const [reply, chat] = normalizedToChatMessages([
      { ...notice, id: 'r1', kind: 'text', role: 'assistant', content: 'done' } as NormalizedMessage,
      notice,
    ]);
    const view = renderRow(chat, reply);
    expect(view.container.querySelector('.chat-message')?.className).not.toContain('grouped');
  });

  it('is not an outbox delivery verdict even with a clientMsgId', () => {
    const verdict = resolveOutboxVerdict(notice as unknown as Record<string, unknown>, {
      isActiveViewSession: true,
      readErrorCode: () => 'codex_processes_stopped',
      readErrorDetail: () => null,
    });
    expect(verdict).toBeNull();
  });
});

describe('scheduled wake-up notice (B-1699)', () => {
  const wake = {
    id: 'wake-1', sessionId: 's', timestamp: '2026-10-27T01:53:00.756Z', provider: 'claude',
    kind: 'notice', noticeCode: 'scheduled_wakeup', content: 'Scheduled wake-up',
  } as unknown as NormalizedMessage;

  it('keeps its code and renders the translated line, not the server text', () => {
    const [chat] = normalizedToChatMessages([wake]);
    expect(chat.isNotice).toBe(true);
    expect(chat.noticeCode).toBe('scheduled_wakeup');
    const line = renderRow(chat).container.querySelector('[data-chat-notice]') as HTMLElement;
    expect(line.textContent).toBe('chatNotice.scheduledWakeup');
  });

  it('has an Arabic and an English label', () => {
    expect(arChat.chatNotice.scheduledWakeup).toBe('استيقاظ مجدول');
    expect(enChat.chatNotice.scheduledWakeup).toBe('Scheduled wake-up');
  });
});

describe('scheduled wake-up hold closed notice (B-1699)', () => {
  const closed = (reason: string) => ({
    id: `closed-${reason}`, sessionId: 's', timestamp: '2026-10-27T02:00:00.000Z', provider: 'claude',
    kind: 'notice', noticeCode: 'scheduled_wakeup_closed', noticeReason: reason,
    content: `Scheduled wake-up hold ended (${reason})`,
  } as unknown as NormalizedMessage);

  it('renders the translated reason for every known close reason', () => {
    for (const reason of ['expired', 'cap', 'total_cap', 'drain', 'listeners_gone', 'quota', 'disabled']) {
      const [chat] = normalizedToChatMessages([closed(reason)]);
      expect(chat.noticeReason).toBe(reason);
      const line = renderRow(chat).container.querySelector('[data-chat-notice]') as HTMLElement;
      expect(line.textContent).toBe(`chatNotice.wakeupClosed.${reason}`);
      cleanup();
    }
  });

  it('an unknown reason falls back to the server text', () => {
    const [chat] = normalizedToChatMessages([closed('mystery')]);
    const line = renderRow(chat).container.querySelector('[data-chat-notice]') as HTMLElement;
    expect(line.textContent).toBe('Scheduled wake-up hold ended (mystery)');
  });

  it('every reason has an ar and en label', () => {
    for (const reason of ['expired', 'cap', 'total_cap', 'drain', 'listeners_gone', 'quota', 'disabled']) {
      expect(typeof (arChat.chatNotice.wakeupClosed as Record<string, string>)[reason]).toBe('string');
      expect(typeof (enChat.chatNotice.wakeupClosed as Record<string, string>)[reason]).toBe('string');
    }
  });
});
