/**
 * B-1668 items 9 and 10 on the project header: the counter follows the search,
 * "load more" hides under search results, same-named projects carry their
 * path, and the path card is hover-only (it stuck after a tap on touch).
 */
import type { ComponentProps } from 'react';
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

let canHover = false;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', dir: () => 'ltr' } }),
}));
vi.mock('../../../../contexts/AuthContext', () => ({
  useOptionalAuth: () => ({ isMultiUser: false }),
}));
vi.mock('../../../participants', () => ({
  ProjectParticipantsSummary: () => null,
  ParticipantAvatarStack: () => null,
}));
vi.mock('../../../../hooks/useMediaQuery', () => ({
  useMediaQuery: (query: string) => query === '(hover: hover)' && canHover,
}));

const SidebarProjectItem = (await import('./SidebarProjectItem')).default;

const t = ((key: string, opts?: { defaultValue?: string; count?: number }) =>
  (opts?.defaultValue ?? key).replace('{{count}}', String(opts?.count ?? ''))) as unknown as TFunction;

const project = {
  projectId: 'p-1',
  displayName: 'nassaj',
  fullPath: '/home/user/Project/nassaj-dev',
  sessionMeta: { total: 120, hasMore: true },
};
const session = { id: 's-1', summary: 'matched row', lastActivity: '2026-10-01T00:00:00Z', __provider: 'claude' as const };

function renderItem(props: Partial<ComponentProps<typeof SidebarProjectItem>> = {}) {
  return render(
    <SidebarProjectItem
      project={project}
      selectedProject={null}
      selectedSession={null}
      isExpanded
      isDeleting={false}
      isStarred={false}
      isSessionStarred={() => false}
      onToggleStarSession={() => {}}
      editingProject={null}
      editingName=""
      sessions={[session]}
      initialSessionsLoaded
      isLoadingMoreSessions={false}
      currentTime={new Date('2026-10-01T01:00:00Z')}
      editingSession={null}
      editingSessionName=""
      onEditingNameChange={() => {}}
      onToggleProject={() => {}}
      onToggleStarProject={() => {}}
      onStartEditingProject={() => {}}
      onCancelEditingProject={() => {}}
      onSaveProjectName={() => {}}
      onDeleteProject={() => {}}
      onArchiveProject={() => {}}
      onSessionSelect={() => {}}
      onDeleteSession={() => {}}
      onLoadMoreSessions={() => {}}
      onNewSession={() => {}}
      onEditingSessionNameChange={() => {}}
      onStartEditingSession={() => {}}
      onCancelEditingSession={() => {}}
      onSaveEditingSession={() => {}}
      t={t}
      {...props}
    />,
  );
}

afterEach(() => {
  cleanup();
  canHover = false;
});

const counterText = () =>
  document.querySelector('[title*="conversations"]')?.firstChild?.textContent;

describe('project header while searching', () => {
  it('shows the project total and "load more" when the search does not narrow it', () => {
    renderItem({ searchMatchCount: null });
    expect(counterText()).toBe('120');
    expect(document.querySelector('.sidebar-project-load-more')).toBeTruthy();
  });

  it('shows the matched count and hides "load more" under results', () => {
    renderItem({ searchMatchCount: 1 });
    expect(counterText()).toBe('1');
    expect(document.querySelector('.sidebar-project-load-more')).toBeNull();
  });
});

describe('project names', () => {
  it('shows the disambiguating path suffix and names the row with it', () => {
    renderItem({ nameSuffix: 'nassaj-dev' });
    expect(document.querySelector('[data-project-name-suffix]')?.textContent).toBe('nassaj-dev');
    expect(screen.getByRole('button', { name: 'Collapse project: nassaj (nassaj-dev)' })).toBeTruthy();
  });

  it('renders no suffix for a unique name', () => {
    renderItem();
    expect(document.querySelector('[data-project-name-suffix]')).toBeNull();
  });

  it('opens the path card on hover devices only', () => {
    vi.useFakeTimers();
    try {
      renderItem();
      fireEvent.mouseEnter(screen.getByText('nassaj'));
      act(() => vi.advanceTimersByTime(400));
      expect(screen.getAllByText('/home/user/Project/nassaj-dev')).toHaveLength(1);

      cleanup();
      canHover = true;
      renderItem();
      fireEvent.mouseEnter(screen.getByText('nassaj').parentElement!);
      act(() => vi.advanceTimersByTime(400));
      expect(screen.getAllByText('/home/user/Project/nassaj-dev')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
