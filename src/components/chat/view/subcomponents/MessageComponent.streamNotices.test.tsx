/**
 * T-2113: hook health, lost transcript writes and an ending Claude sign-in render
 * as chat notices; the hook heartbeat status reads as a localized status word.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/view/subcomponents/MessageComponent.streamNotices.test.tsx
 */

import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

import { normalizedToChatMessages } from '../../hooks/useChatMessages';
import type { NormalizedMessage } from '../../../../stores/useSessionStore';

import MessageComponent from './MessageComponent';
import { statusTranslationKey } from './runStatusText';

const LOCALES = ['ar', 'de', 'en', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN'] as const;
const chatLocales = import.meta.glob('../../../../i18n/locales/*/chat.json', { eager: true, import: 'default' });

const openSettings = vi.fn();
const authState: { user: { id: number } | null } = { user: { id: 7 } };

vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false }),
}));

vi.mock('../../../../contexts/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ openSettings, openFile: () => undefined, refreshProjects: () => undefined }),
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts && typeof opts.date === 'string' ? `${key}|${opts.date}` : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../auth/context/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => authState,
}));

vi.mock('../../../auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => authState,
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

afterEach(() => {
  cleanup();
  openSettings.mockReset();
  authState.user = { id: 7 };
});

const notice = (fields: Record<string, unknown>) => ({
  id: `n-${String(fields.noticeCode)}`, sessionId: 's', timestamp: '2026-11-14T10:00:00.000Z',
  provider: 'claude', kind: 'notice', content: 'server text', ...fields,
} as unknown as NormalizedMessage);

const renderNotice = (fields: Record<string, unknown>) => {
  const [chat] = normalizedToChatMessages([notice(fields)]);
  return render(
    <MessageComponent {...({ prevMessage: null, createDiff: () => [], provider: 'claude', message: chat } as unknown as Props)} />,
  );
};

const readKey = (tree: unknown, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree);

describe('hook heartbeat status', () => {
  it('maps the server status text to a localized key', () => {
    expect(statusTranslationKey('Running checks')).toBe('claudeStatus.actions.runningChecks');
  });
});

describe('hook health notices', () => {
  it('a hook that gave no verdict renders a quiet warning with the CLI detail on demand', () => {
    const view = renderNotice({ noticeCode: 'hook_no_verdict', noticeLevel: 'warning', noticeReason: 'timed_out',
      content: "A hook didn't answer in time, so it didn't check this action." });
    const line = view.container.querySelector('[data-chat-notice]') as HTMLElement;
    expect(line.textContent).toContain('chatNotice.hookNoVerdict.timed_out');
    expect(line.querySelector('[data-notice-detail]')?.textContent).toContain("didn't answer in time");
    expect(line.querySelector('.text-warning')).toBeTruthy();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });

  it('a failed hook renders the hook-failed line; the shared text is not offered as detail', () => {
    const view = renderNotice({ noticeCode: 'hook_failed', noticeLevel: 'warning', content: 'A hook failed.' });
    expect(view.container.querySelector('[data-chat-notice]')?.textContent).toContain('chatNotice.hookFailed');
    expect(view.container.querySelector('[data-notice-detail]')).toBeNull();
  });

  const shared = () => notice({ noticeCode: 'hook_failed', noticeLevel: 'warning', id: 'h1',
    content: 'A hook failed, so its answer was treated as empty.' });
  const detail = (fields: Record<string, unknown> = {}) => notice({ noticeCode: 'hook_failed',
    noticeLevel: 'warning', id: 'h1:detail', noticeDetailOf: 'h1', audienceUserId: 7,
    content: 'PreToolUse: Hook callback cb failed: ENOENT /srv/x', ...fields });
  const renderRow = (rows: NormalizedMessage[]) => {
    const chats = normalizedToChatMessages(rows);
    expect(chats).toHaveLength(1);
    return render(
      <MessageComponent {...({ prevMessage: null, createDiff: () => [], provider: 'claude', message: chats[0] } as unknown as Props)} />,
    );
  };

  it('the owner-only detail folds into the shared line and shows to its owner', () => {
    const view = renderRow([shared(), detail()]);
    expect(view.container.querySelector('[data-notice-detail]')?.textContent).toContain('ENOENT /srv/x');
  });

  it('the folded detail stays hidden from any other user', () => {
    authState.user = { id: 8 };
    const view = renderRow([shared(), detail()]);
    expect(view.container.querySelector('[data-chat-notice]')?.textContent).toContain('chatNotice.hookFailed');
    expect(view.container.querySelector('[data-notice-detail]')).toBeNull();
  });

  it('a detail whose shared line is missing is its own owner-only row', () => {
    const view = renderRow([detail()]);
    expect(view.container.querySelector('[data-notice-detail]')?.textContent).toContain('ENOENT');
    cleanup();
    authState.user = { id: 8 };
    expect(renderRow([detail()]).container.querySelector('[data-chat-notice]')).toBeNull();
  });
});

describe('lost transcript writes', () => {
  it('renders an error alert naming the cause and the resume risk', () => {
    const view = renderNotice({ noticeCode: 'session_writes_lost', noticeLevel: 'error', noticeReason: 'ENOSPC',
      lostWrites: ['transcript'] });
    const alert = view.container.querySelector('[role="alert"][data-chat-notice]') as HTMLElement;
    expect(alert).toBeTruthy();
    expect(alert.textContent).toContain('chatNotice.sessionWritesLost.ENOSPC');
    expect(alert.textContent).toContain('chatNotice.sessionWritesLost.transcript');
    expect(alert.className).toContain('text-danger');
  });

  it('an unknown error code falls back to the generic line', () => {
    const view = renderNotice({ noticeCode: 'session_writes_lost', noticeLevel: 'error', noticeReason: 'EIO',
      lostWrites: ['global_config'] });
    const text = view.container.querySelector('[data-chat-notice]')?.textContent ?? '';
    expect(text).toContain('chatNotice.sessionWritesLost.unknown');
    expect(text).toContain('chatNotice.sessionWritesLost.globalConfig');
  });
});

describe('ending Claude sign-in', () => {
  const credential = (fields: Record<string, unknown> = {}) => ({
    noticeCode: 'credential_expiring', noticeLevel: 'warning', noticeReason: 'soon',
    credentialExpiresAt: '2026-11-16T09:30:00.000Z', audienceUserId: 7, ...fields,
  });

  it('warns its owner with the date and opens the Claude account settings', () => {
    const view = renderNotice(credential());
    const line = view.container.querySelector('[data-chat-notice]') as HTMLElement;
    expect(line.getAttribute('role')).toBe('status');
    expect(line.textContent).toContain('chatNotice.credentialExpiring.soon|');
    expect(line.textContent).toMatch(/2026/);
    fireEvent.click(view.getByRole('button', { name: 'chatNotice.credentialExpiring.action' }));
    expect(openSettings).toHaveBeenCalledWith('agents', { tab: 'agents', agent: 'claude', category: 'account' });
  });

  it('is hidden from any other user', () => {
    authState.user = { id: 8 };
    const view = renderNotice(credential());
    expect(view.container.querySelector('[data-chat-notice]')).toBeNull();
  });

  it('keeps only the latest sign-in warning in a conversation', () => {
    const rows = normalizedToChatMessages([
      notice({ ...credential(), id: 'c1' }),
      notice({ noticeCode: 'hook_failed', noticeLevel: 'warning', id: 'h1' }),
      notice({ ...credential({ noticeReason: 'expired' }), id: 'c2' }),
    ]);
    expect(rows.map(r => r.id)).toEqual(['h1', 'c2']);
  });
});

describe('locale coverage', () => {
  const keys = [
    'claudeStatus.actions.runningChecks',
    'chatNotice.hookNoVerdict.timed_out', 'chatNotice.hookNoVerdict.no_answer', 'chatNotice.hookFailed',
    'chatNotice.hookDetails',
    'chatNotice.sessionWritesLost.ENOSPC', 'chatNotice.sessionWritesLost.EDQUOT',
    'chatNotice.sessionWritesLost.unknown', 'chatNotice.sessionWritesLost.transcript',
    'chatNotice.sessionWritesLost.globalConfig',
    'chatNotice.credentialExpiring.soon', 'chatNotice.credentialExpiring.expired',
    'chatNotice.credentialExpiring.action',
  ];

  it.each(LOCALES)('%s has every new key', (locale) => {
    const tree = chatLocales[`../../../../i18n/locales/${locale}/chat.json`];
    expect(tree).toBeTruthy();
    for (const key of keys) expect(typeof readKey(tree, key), `${locale}:${key}`).toBe('string');
    for (const key of ['chatNotice.credentialExpiring.soon', 'chatNotice.credentialExpiring.expired']) {
      expect(readKey(tree, key), `${locale}:${key}`).toContain('{{date}}');
    }
  });
});
