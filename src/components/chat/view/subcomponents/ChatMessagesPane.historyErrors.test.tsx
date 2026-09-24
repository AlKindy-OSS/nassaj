import { createRef } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
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

// T-1821: زرّ إعادة المحاولة انتقل إلى ChatComposer (jump-down الموحَّد).
// ChatMessagesPane يعرض النصّ فقط — لا زرّ.
describe('history pane error state (T-1821)', () => {
  it.each([[413, 'HISTORY_BUDGET_EXCEEDED', 'budget'], [409, 'HISTORY_SOURCE_INCOMPLETE', 'incomplete'],
    [409, 'HISTORY_REVISION_CHANGED', 'revision'], [409, 'CURSOR_STALE', 'revision'], [503, 'HISTORY_BUSY', 'busy'], [504, 'HISTORY_TIMEOUT', 'timeout']])(
    'renders %i %s as an accessible error banner with no button (button in jump-down)', (status, code, key) => {
      // T-1821: retryHistory prop removed — banner is text-only.
      render(<ChatMessagesPane {...props} historyError={{ ok: false, status: Number(status), code: String(code), retryAfterMs: null, retryAt: 0, operation: 'initial' }} />);
      expect(screen.getByRole('alert').textContent).toContain(`session.historyError.${key}`);
      expect(screen.queryByText('ordinary-empty-state')).toBeNull();
      // No interactive button in the banner — only text.
      expect(screen.queryByRole('button')).toBeNull();
    });

  it('keeps held rows visible while historyError is set', () => {
    const message = { id: 'held', type: 'assistant', content: 'held reply', timestamp: new Date() };
    render(<ChatMessagesPane {...props} chatMessages={[message]} visibleMessages={[message]}
      historyError={{ ok: false, status: 503, code: 'HISTORY_BUSY', retryAfterMs: 5000, retryAt: Date.now() + 5000, operation: 'older' }} />);
    expect(screen.getByText('held reply')).toBeTruthy();
  });

  it('shows no empty state when historyError is present with zero messages (fix-1 coverage)', () => {
    // Zero messages + historyError → no ordinary-empty-state, and banner is shown.
    render(<ChatMessagesPane {...props} chatMessages={[]} visibleMessages={[]}
      historyError={{ ok: false, status: 503, code: 'HISTORY_BUSY', retryAfterMs: null, retryAt: 0, operation: 'initial' }} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText('ordinary-empty-state')).toBeNull();
  });
});
