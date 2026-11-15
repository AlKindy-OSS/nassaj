/**
 * ADR-173 P6 — a colleague's prompt in a shared conversation is captioned with
 * its author, live (`authorName` from the user_turn frame, before the roster
 * loads) and on reload (roster lookup by `userId`), the same "User: <name>"
 * caption the owner's prompts already carry. P8: in a conversation with more than
 * one human author, every user prompt (the viewer's own too) carries it, the same
 * live and after reload; a solo conversation looks exactly as before.
 */
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import type { SessionParticipant } from '../../../participants/types';

import MessageComponent from './MessageComponent';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'userAuthor.withName') return `User: ${String(options?.username)}`;
      if (key === 'sharedWriting.turnImages') return `images:${String(options?.count)}`;
      return String(options?.defaultValue ?? key);
    },
    i18n: { language: 'ar' },
  }),
}));

vi.mock('../../../auth/context/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: { id: 2, username: 'viewer' } }),
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

function renderUser(
  input: Record<string, unknown>,
  participantsById?: Map<string, SessionParticipant>,
) {
  const { isMultiAuthor, owner = { userId: 1, username: 'ibrahim' }, ...message } = input;
  return render(
    <MessageComponent
      {...({
        prevMessage: null,
        createDiff: () => [],
        provider: 'claude',
        owner,
        participantsById,
        isMultiAuthor,
        message: { id: 'm1', type: 'user', content: 'نص الزميل', timestamp: '2026-11-15T00:00:00.000Z', ...message },
      } as unknown as Props)}
    />,
  );
}

describe('MessageComponent — shared writer author caption', () => {
  it('names a live colleague prompt from its frame before the roster loads', () => {
    renderUser({ userId: 3, authorName: 'sara', sharedImageCount: 2 });
    expect(screen.getByText('User: sara')).not.toBeNull();
    expect(screen.getByText('images:2')).not.toBeNull();
  });

  it('names a reloaded colleague prompt from the roster', () => {
    const roster = new Map<string, SessionParticipant>([['3', {
      userId: 3, username: 'sara', role: 'participant', first_seen: '', last_seen: '', message_count: 1,
    }]]);
    renderUser({ userId: 3 }, roster);
    expect(screen.getByText('User: sara')).not.toBeNull();
  });

  it('in a conversation with several human authors, captions the viewer own prompt too (live and reload)', () => {
    // live optimistic send (owner not known yet for a fresh conversation) and the reloaded row
    renderUser({ userId: 2, isMultiAuthor: true });
    expect(screen.getByText('User: viewer')).not.toBeNull();
    cleanup();
    renderUser({ userId: 2, isMultiAuthor: true, owner: undefined });
    expect(screen.getByText('User: viewer')).not.toBeNull();
  });

  it('a solo conversation looks as before: no caption on the viewer own prompt', () => {
    renderUser({ userId: 2 });
    expect(screen.queryByText(/^User: /)).toBeNull();
    cleanup();
    renderUser({ userId: 2, isMultiAuthor: false, owner: undefined });
    expect(screen.queryByText(/^User: /)).toBeNull();
  });

  it('shows exactly one caption on the owner own prompt', () => {
    renderUser({ userId: 1 });
    expect(screen.getAllByText(/^User: /)).toHaveLength(1);
  });
});
