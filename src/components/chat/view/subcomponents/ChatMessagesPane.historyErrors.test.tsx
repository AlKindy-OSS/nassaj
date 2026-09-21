import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../participants', () => ({ useSessionParticipants: () => ({ participants: [] }) }));
vi.mock('./MessageComponent', () => ({ default: ({ message }: any) => <p>{message.content}</p> }));
vi.mock('./ProviderSelectionEmptyState', () => ({ default: () => <div>ordinary-empty-state</div> }));
import ChatMessagesPane from './ChatMessagesPane';
const props = { scrollContainerRef: createRef<HTMLDivElement>(), onWheel: () => {}, onTouchMove: () => {},
  isLoadingSessionMessages: false, chatMessages: [], visibleMessages: [], selectedSession: { id: 's1' },
  currentSessionId: 's1', visibleMessageCount: 100, totalMessages: 0, selectedProject: {},
  isLoadingMoreMessages: false, isLoadingAllMessages: false, hasMoreMessages: false } as any;
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe('existing history pane error state', () => {
  it.each([[413, 'HISTORY_BUDGET_EXCEEDED', 'budget'], [409, 'HISTORY_SOURCE_INCOMPLETE', 'incomplete'],
    [409, 'HISTORY_REVISION_CHANGED', 'revision'], [409, 'CURSOR_STALE', 'revision'], [503, 'HISTORY_BUSY', 'busy'], [504, 'HISTORY_TIMEOUT', 'timeout']])(
    'renders %i %s as an accessible error, not an empty conversation', (status, code, key) => {
      const retry = vi.fn();
      render(<ChatMessagesPane {...props} retryHistory={retry} historyError={{ ok: false, status: Number(status), code: String(code), retryAfterMs: null, retryAt: 0, operation: 'initial' }} />);
      expect(screen.getByRole('alert').textContent).toContain(`session.historyError.${key}`);
      expect(screen.queryByText('ordinary-empty-state')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: `session.historyError.${key === 'revision' ? 'refresh' : 'retry'}` }));
      expect(retry).toHaveBeenCalledTimes(1);
    });
  it('keeps held rows visible and disables retry until the server delay elapses', () => {
    vi.useFakeTimers();
    const message = { id: 'held', type: 'assistant', content: 'held reply', timestamp: new Date() };
    render(<ChatMessagesPane {...props} chatMessages={[message]} visibleMessages={[message]}
      historyError={{ ok: false, status: 503, code: 'HISTORY_BUSY', retryAfterMs: 5000, retryAt: Date.now() + 5000, operation: 'older' }} />);
    expect(screen.getByText('held reply')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'session.historyError.wait' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => { vi.advanceTimersByTime(5000); });
    expect((screen.getByRole('button', { name: 'session.historyError.retry' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
