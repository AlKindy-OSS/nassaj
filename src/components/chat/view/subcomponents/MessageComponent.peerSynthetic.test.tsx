/**
 * ADR-219 S1 (T-2072): a relayed delivery row is shown as a machine line from the
 * server marker, and a live peer turn carries its delivery id for the tag.
 */

import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import { normalizedToChatMessages } from '../../hooks/useChatMessages';
import type { NormalizedMessage } from '../../../../stores/useSessionStore';
import { isPeerTurnStart } from '../../../peer-relay/peerDisplay';

import MessageComponent from './MessageComponent';

vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false }),
}));

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

type MessageComponentProps = ComponentProps<typeof MessageComponent>;

const renderMessage = (message: Record<string, unknown>, provider: string = 'claude', extra: Partial<MessageComponentProps> = {}) => {
  const props = {
    prevMessage: null,
    createDiff: () => [],
    provider,
    message: { id: 'm1', timestamp: '2026-07-26T10:00:00.000Z', ...message },
    ...extra,
  } as unknown as MessageComponentProps;
  return render(<MessageComponent {...props} />);
};
afterEach(cleanup);

/** ADR-219 S1: the delivered wrapper row as history and the live echo produce it. */
const wrapper = '[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\n<nassaj-peer-message from="x">hi</nassaj-peer-message>';

describe('MessageComponent — ADR-219 synthetic delivery row', () => {
  it('renders an isSynthetic user row as a collapsed machine line, never a user bubble', () => {
    const view = renderMessage({ type: 'user', content: wrapper, isSynthetic: true, userId: 7 }, 'claude', {
      owner: { userId: 7, username: 'owner' } as MessageComponentProps['owner'],
    });
    const line = view.container.querySelector('[data-synthetic-message]');
    expect(line).not.toBeNull();
    expect(line!.tagName.toLowerCase()).toBe('details');
    expect(view.getByText('syntheticMessage.label')).toBeTruthy();
    expect(view.container.querySelector('.chat-message.user')!.className).not.toContain('justify-end');
    expect(view.container.innerHTML).not.toContain('user-bubble');
  });

  it('flows through normalizedToChatMessages from the server marker, not the text', () => {
    const rows = [
      { id: 'u1', sessionId: 's', timestamp: '2026-10-27T10:00:00.000Z', provider: 'claude', kind: 'text', role: 'user', content: wrapper, isSynthetic: true },
      { id: 'u2', sessionId: 's', timestamp: '2026-10-27T10:00:01.000Z', provider: 'claude', kind: 'text', role: 'user', content: wrapper },
    ] as unknown as NormalizedMessage[];
    const [synthetic, plain] = normalizedToChatMessages(rows);
    expect(synthetic.isSynthetic).toBe(true);
    expect(plain.isSynthetic).toBeUndefined();
    const plainView = renderMessage(plain as unknown as Record<string, unknown>);
    expect(plainView.container.querySelector('[data-synthetic-message]')).toBeNull();
  });

  it('trusts only the server peerDeliveryId marker, never a crafted clientMsgId', () => {
    const rows = [
      { id: 'a1', sessionId: 's', timestamp: '2026-10-27T10:00:02.000Z', provider: 'claude', kind: 'text', role: 'assistant', content: 'ok', peerDeliveryId: 'pm-9' },
      { id: 'a2', sessionId: 's', timestamp: '2026-10-27T10:00:03.000Z', provider: 'claude', kind: 'text', role: 'assistant', content: 'ok', clientMsgId: 'peer:pm-9:1' },
    ] as unknown as NormalizedMessage[];
    const [marked, spoofed] = normalizedToChatMessages(rows);
    expect(marked.peerDeliveryId).toBe('pm-9');
    expect(spoofed.peerDeliveryId).toBeUndefined();
  });
});

describe('isPeerTurnStart', () => {
  const ids = new Set(['pm-9']);
  const row = (over: Record<string, unknown>) => ({ type: 'assistant', timestamp: 0, ...over }) as never;

  it('tags the first reply row of a delivery addressed to this session', () => {
    expect(isPeerTurnStart(row({ peerDeliveryId: 'pm-9' }), row({ type: 'user', peerDeliveryId: 'pm-9' }), ids)).toBe(true);
    expect(isPeerTurnStart(row({ peerDeliveryId: 'pm-9' }), null, ids)).toBe(true);
  });

  it('does not repeat inside the turn, and ignores unknown ids and user rows', () => {
    expect(isPeerTurnStart(row({ peerDeliveryId: 'pm-9' }), row({ type: 'tool', peerDeliveryId: 'pm-9' }), ids)).toBe(false);
    expect(isPeerTurnStart(row({ peerDeliveryId: 'pm-other' }), null, ids)).toBe(false);
    expect(isPeerTurnStart(row({ type: 'user', peerDeliveryId: 'pm-9' }), null, ids)).toBe(false);
    expect(isPeerTurnStart(row({}), null, ids)).toBe(false);
  });
});
