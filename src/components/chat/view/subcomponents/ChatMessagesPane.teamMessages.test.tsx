/**
 * ADR-187: team messages render inline in the conversation timeline, placed
 * by time between chat rows, styled apart from chat and marked internal.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) => (options?.name ? `${key}:${options.name}` : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../../participants', () => ({ useSessionParticipants: () => ({ participants: [] }) }));
vi.mock('./MessageComponent', () => ({
  default: ({ message }: any) => <p data-testid="row">{message.content}</p>,
}));
vi.mock('./ProviderSelectionEmptyState', () => ({ default: () => null }));

import { placeTeamMessages } from '../../../internal-session-chat/interleaveTeamMessages';

import ChatMessagesPane from './ChatMessagesPane';

const chat = (id: string, content: string, at: string) => ({ id, type: 'assistant', content, timestamp: at });
const team = (id: string, sequence: number, body: string, at: string, authorName: string | null = 'sara') =>
  ({ id, sequence, body, authorUserId: authorName ? 7 : null, authorName, createdAt: at });

const props = (visibleMessages: any[], internalMessages: any[], extra: Record<string, unknown> = {}) => ({
  scrollContainerRef: { current: null }, onWheel: () => {}, onTouchMove: () => {},
  isLoadingSessionMessages: false, chatMessages: visibleMessages, visibleMessages, internalMessages,
  selectedSession: { id: 's1' }, currentSessionId: 's1', visibleMessageCount: 100,
  totalMessages: visibleMessages.length, selectedProject: {}, isLoadingMoreMessages: false,
  isLoadingAllMessages: false, hasMoreMessages: false, ...extra,
}) as any;

/** Timeline text in document order: chat rows and team bubble bodies. */
const timeline = (container: HTMLElement) => [...container.querySelectorAll('[data-testid="row"], [data-internal-message] article > div:last-child')]
  .map((node) => node.textContent);

afterEach(cleanup);

describe('team messages in the timeline', () => {
  it('interleaves team messages with chat rows by time', () => {
    const { container } = render(<ChatMessagesPane {...props(
      [chat('c1', 'chat-1', '2026-10-20T10:00:00Z'), chat('c2', 'chat-2', '2026-10-20T10:10:00Z')],
      [team('t1', 1, 'team-1', '2026-10-20T10:05:00Z'), team('t2', 2, 'team-2', '2026-10-20T10:20:00Z')],
    )} />);
    expect(timeline(container)).toEqual(['chat-1', 'team-1', 'chat-2', 'team-2']);
  });

  it('marks each team bubble as internal with its author, and names a deleted author', () => {
    render(<ChatMessagesPane {...props(
      [chat('c1', 'chat-1', '2026-10-20T10:00:00Z')],
      [team('t1', 1, 'from sara', '2026-10-20T10:05:00Z'), team('t2', 2, 'orphan', '2026-10-20T10:06:00Z', null)],
    )} />);
    expect(screen.getByLabelText('internalChat.bubbleAria:sara')).toBeTruthy();
    expect(screen.getByLabelText('internalChat.bubbleAria:internalChat.unknownAuthor')).toBeTruthy();
    expect(screen.getAllByText('internalChat.inlineLabel')).toHaveLength(2);
  });

  it('holds back team messages older than unloaded chat history', () => {
    const { container } = render(<ChatMessagesPane {...props(
      [chat('c5', 'chat-5', '2026-10-20T10:00:00Z')],
      [team('t1', 1, 'too-old', '2026-10-20T09:00:00Z'), team('t2', 2, 'recent', '2026-10-20T11:00:00Z')],
      { hasMoreMessages: true },
    )} />);
    expect(timeline(container)).toEqual(['chat-5', 'recent']);
  });
});

describe('placeTeamMessages', () => {
  it('puts older team messages before the first row once history is complete', () => {
    const placed = placeTeamMessages([chat('c1', 'x', '2026-10-20T10:00:00Z')], [team('t1', 1, 'a', '2026-10-20T09:00:00Z')], false);
    expect(placed.before[0].map((m) => m.id)).toEqual(['t1']);
    expect(placed.trailing).toEqual([]);
  });

  it('skips chat rows without a timestamp and keeps sequence order', () => {
    const rows = [{ timestamp: undefined }, chat('c2', 'y', '2026-10-20T10:00:00Z')];
    const placed = placeTeamMessages(rows, [team('t1', 1, 'a', '2026-10-20T09:00:00Z'), team('t2', 2, 'b', 'not a date')], false);
    expect(placed.before.map((group) => group.map((m) => m.id))).toEqual([[], ['t1']]);
    expect(placed.trailing.map((m) => m.id)).toEqual(['t2']);
  });
});
