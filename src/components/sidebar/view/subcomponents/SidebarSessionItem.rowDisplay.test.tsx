/**
 * B-1668 items 2, 7, 8 and 10 on a conversation row: the age shows on every
 * row (shared rows too), the dead message-count badge is gone, the title is
 * clamped in logical order, and a URL-selected row scrolls into view once.
 */
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import type { SessionWithProvider } from '../../types/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('../../../../contexts/AuthContext', () => ({
  useOptionalAuth: () => ({ isMultiUser: true }),
}));

const SidebarSessionItem = (await import('./SidebarSessionItem')).default;
const { requestSessionReveal } = await import('../../utils/sessionReveal');

const t = ((key: string, opts?: { defaultValue?: string; count?: number }) =>
  (opts?.defaultValue ?? key).replace('{{count}}', String(opts?.count ?? ''))) as unknown as TFunction;

const project = { projectId: 'p-1', displayName: 'nassaj', fullPath: '/w/nassaj' };
const session = {
  id: 's-1',
  summary: 'أصلح خطأ in the build pipeline',
  lastActivity: '2026-10-01T00:00:00.000Z',
  messageCount: 7,
  participants: [{ userId: 1, username: 'owner', avatarUrl: null, role: 'owner' }],
  __provider: 'claude',
} as unknown as SessionWithProvider;

const renderRow = (selected = false) =>
  render(
    <SidebarSessionItem
      project={project}
      session={session}
      selectedSession={selected ? session : null}
      isStarred={false}
      onToggleStar={() => {}}
      currentTime={new Date('2026-10-01T03:00:00.000Z')}
      editingSession={null}
      editingSessionName=""
      onEditingSessionNameChange={() => {}}
      onStartEditingSession={() => {}}
      onCancelEditingSession={() => {}}
      onSaveEditingSession={() => {}}
      onSessionSelect={() => {}}
      onDeleteSession={() => {}}
      t={t}
    />,
  );

const scrollIntoView = vi.fn();

beforeEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  scrollIntoView.mockReset();
  vi.useRealTimers();
});

describe('conversation row display', () => {
  it('shows the age on a shared row, as a time element', () => {
    const { container } = renderRow();
    const age = container.querySelector('time[data-session-age]');
    expect(age?.textContent).toBe('3h');
    expect(age?.getAttribute('dateTime')).toBe('2026-10-01T00:00:00.000Z');
  });

  it('renders no message-count badge', () => {
    const { container } = renderRow();
    expect(container.textContent).not.toContain('7');
  });

  it('clamps the title to one line in logical order, isolated per title', () => {
    const { container } = renderRow();
    const title = container.querySelector('[data-session-title]')!;
    expect(title.getAttribute('dir')).toBe('auto');
    expect(title.className).toContain('line-clamp-1');
    expect(title.className).not.toContain('truncate');
  });
});

describe('reveal of a URL-selected row', () => {
  it('scrolls the row into view once, after the row enter transition', () => {
    requestSessionReveal('s-1');
    renderRow(true);
    // Still inside AnimatedRow's collapsed track: scrolling now would scroll the track.
    expect(scrollIntoView).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });

    cleanup();
    renderRow(true);
    vi.advanceTimersByTime(400);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('never scrolls a row selected without a reveal request (a click, a remount)', () => {
    renderRow(true);
    vi.advanceTimersByTime(400);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
