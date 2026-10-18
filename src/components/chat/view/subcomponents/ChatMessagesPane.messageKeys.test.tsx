/**
 * B-1665: React keys for chat rows. A cached row object and a freshly rebuilt
 * object carrying the same id in ONE render must never share a key (that is
 * the "same message painted twice / another one missing" reconciliation
 * failure); fresh objects across renders must keep their stable key.
 */
import { useEffect } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mounts = vi.hoisted(() => ({ count: 0 }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../participants', () => ({ useSessionParticipants: () => ({ participants: [] }) }));
vi.mock('./MessageComponent', () => ({
  default: function Row({ message }: any) {
    useEffect(() => { mounts.count += 1; }, []);
    return <p data-testid="row">{message.content}</p>;
  },
}));
vi.mock('./ProviderSelectionEmptyState', () => ({ default: () => null }));

import ChatMessagesPane from './ChatMessagesPane';

const ts = '2026-10-17T10:00:00Z';
const msg = (id: string, content: string) => ({ id, type: 'assistant', content, timestamp: ts });

const props = (visibleMessages: any[]) => ({
  scrollContainerRef: { current: null }, onWheel: () => {}, onTouchMove: () => {},
  isLoadingSessionMessages: false, chatMessages: visibleMessages, visibleMessages,
  selectedSession: { id: 's1' }, currentSessionId: 's1', visibleMessageCount: 100,
  totalMessages: visibleMessages.length, selectedProject: {}, isLoadingMoreMessages: false,
  isLoadingAllMessages: false, hasMoreMessages: false,
}) as any;

afterEach(() => { cleanup(); vi.restoreAllMocks(); mounts.count = 0; });

describe('ChatMessagesPane message keys', () => {
  it('a cached object and a fresh object with the same id in one render get distinct keys', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cached = msg('m1', 'first');
    const view = render(<ChatMessagesPane {...props([cached])} />);
    view.rerender(<ChatMessagesPane {...props([cached, msg('m1', 'second')])} />);
    const keyWarnings = errors.mock.calls.filter((args) => args.join(' ').includes('same key'));
    expect(keyWarnings).toHaveLength(0);
    expect(screen.getAllByTestId('row').map((row) => row.textContent)).toEqual(['first', 'second']);
  });

  it('fresh objects for the same rows across renders keep their keys (no remount)', () => {
    const view = render(<ChatMessagesPane {...props([msg('a', 'A'), msg('b', 'B')])} />);
    view.rerender(<ChatMessagesPane {...props([msg('a', 'A'), msg('b', 'B2')])} />);
    view.rerender(<ChatMessagesPane {...props([msg('a', 'A'), msg('b', 'B3')])} />);
    expect(mounts.count).toBe(2);
    expect(screen.getAllByTestId('row').map((row) => row.textContent)).toEqual(['A', 'B3']);
  });
});
