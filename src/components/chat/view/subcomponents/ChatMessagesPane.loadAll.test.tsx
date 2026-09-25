import { createRef } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (
  key === 'session.messages.loadAll' && opts && 'count' in (opts as any) ? `${key} (${(opts as any).count})` : key
) }) }));
vi.mock('../../../participants', () => ({ useSessionParticipants: () => ({ participants: [] }) }));
vi.mock('./MessageComponent', () => ({ default: ({ message }: any) => <p>{message.content}</p> }));
vi.mock('./ProviderSelectionEmptyState', () => ({ default: () => <div>ordinary-empty-state</div> }));
import ChatMessagesPane from './ChatMessagesPane';

const heldMessage = { id: 'm1', type: 'assistant', content: 'hi', timestamp: new Date() };

const baseProps = {
  scrollContainerRef: createRef<HTMLDivElement>(), onWheel: () => {}, onTouchMove: () => {},
  isLoadingSessionMessages: false, chatMessages: [heldMessage], visibleMessages: [heldMessage],
  selectedSession: { id: 's1' },
  currentSessionId: 's1', visibleMessageCount: 100, selectedProject: {},
  isLoadingMoreMessages: false,
} as any;

afterEach(() => { cleanup(); vi.useRealTimers(); });

// B-fix: كان هناك زرّان لـ«تحميل الكل» يعملان معاً (السطر الملخِّص + اللوحة
// العائمة) حين hasMoreMessages && isLoadingAllMessages — تكرار محض لنفس الفعل.
// أُبقي على واحد فقط (زر السطر الملخِّص)، والعائمة صارت مجرّد رسالة نجاح عابرة.
describe('ChatMessagesPane — single "load all" control', () => {
  it('renders exactly one load-all button while more messages remain', () => {
    render(
      <ChatMessagesPane
        {...baseProps}
        hasMoreMessages
        totalMessages={40}
        sessionMessagesCount={10}
        isLoadingAllMessages={false}
        allMessagesLoaded={false}
        loadAllJustFinished={false}
        loadAllMessages={() => {}}
        loadMoreMessages={() => {}}
        loadEarlierMessages={() => {}}
      />,
    );
    const loadAllButtons = screen.getAllByText(/session\.messages\.loadAll/);
    expect(loadAllButtons).toHaveLength(1);
  });

  it('keeps exactly one load-all button while the load-all request is in flight', () => {
    render(
      <ChatMessagesPane
        {...baseProps}
        hasMoreMessages
        totalMessages={40}
        sessionMessagesCount={10}
        isLoadingAllMessages
        allMessagesLoaded={false}
        loadAllJustFinished={false}
        loadAllMessages={() => {}}
        loadMoreMessages={() => {}}
        loadEarlierMessages={() => {}}
      />,
    );
    expect(screen.getAllByText('session.messages.loadingAll')).toHaveLength(1);
    // No second, floating loading button duplicating the same action.
    expect(screen.queryAllByRole('button').filter((btn) =>
      btn.textContent?.includes('session.messages.loadingAll'),
    )).toHaveLength(1);
  });

  it('shows the completion toast (not a second button) right after loading all', () => {
    render(
      <ChatMessagesPane
        {...baseProps}
        hasMoreMessages={false}
        totalMessages={40}
        sessionMessagesCount={40}
        isLoadingAllMessages={false}
        allMessagesLoaded
        loadAllJustFinished
        loadAllMessages={() => {}}
        loadMoreMessages={() => {}}
        loadEarlierMessages={() => {}}
      />,
    );
    expect(screen.getByText('session.messages.allLoaded')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

// B-fix follow-up (qa-critic T-1858 round 2): the legacy non-paginated
// "load all" link had no loading feedback of its own — it relied on the
// floating overlay (now removed) to signal an in-flight request. Restore an
// inline loading state so a click still gives feedback.
describe('ChatMessagesPane — legacy load-all link loading state', () => {
  const manyMessages = Array.from({ length: 5 }, (_, i) => ({
    id: `m${i}`, type: 'assistant', content: `msg ${i}`, timestamp: new Date(),
  }));
  const legacyProps = {
    ...baseProps,
    chatMessages: manyMessages,
    visibleMessages: manyMessages.slice(0, 2),
    visibleMessageCount: 2,
    hasMoreMessages: false,
    totalMessages: 0,
    sessionMessagesCount: 0,
    allMessagesLoaded: false,
    loadAllJustFinished: false,
    loadAllMessages: () => {},
    loadMoreMessages: () => {},
    loadEarlierMessages: () => {},
  };

  it('shows the plain label and an enabled button when idle', () => {
    render(<ChatMessagesPane {...legacyProps} isLoadingAllMessages={false} />);
    const button = screen.getByText('session.messages.loadAll').closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('disables the link and swaps to the loading label while in flight', () => {
    render(<ChatMessagesPane {...legacyProps} isLoadingAllMessages />);
    expect(screen.queryByText('session.messages.loadAll')).toBeNull();
    const button = screen.getByText('session.messages.loadingAll').closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
