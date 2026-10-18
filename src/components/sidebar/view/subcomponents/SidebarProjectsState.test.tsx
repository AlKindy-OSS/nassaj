/**
 * B-1668 item 9: an empty search result is worded for what was searched, and
 * a conversation scan still in flight is not reported as "no results".
 */
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import SidebarProjectsState from './SidebarProjectsState';

const t = ((key: string) => key) as unknown as TFunction;

const renderState = (props: Partial<Parameters<typeof SidebarProjectsState>[0]> = {}) =>
  render(
    <SidebarProjectsState
      isLoading={false}
      loadingProgress={null}
      projectsCount={3}
      filteredProjectsCount={0}
      isSearchActive
      t={t}
      {...props}
    />,
  );

afterEach(cleanup);

describe('SidebarProjectsState search empty state', () => {
  it('says "no matching conversations" when message bodies were searched', () => {
    renderState({ searchScope: 'all' });
    expect(screen.getByText('projects.noMatchingConversations')).toBeTruthy();
    cleanup();
    renderState({ searchScope: 'messages' });
    expect(screen.getByText('projects.noMatchingConversations')).toBeTruthy();
  });

  it('says "no matching projects" for a titles-only search', () => {
    renderState({ searchScope: 'titles' });
    expect(screen.getByText('projects.noMatchingProjects')).toBeTruthy();
  });

  it('shows a searching state while the conversation scan streams', () => {
    renderState({ searchScope: 'all', isMessageSearching: true });
    expect(screen.getByText('projects.searchingConversations')).toBeTruthy();
    expect(screen.queryByText('projects.tryDifferentSearch')).toBeNull();
  });

  it('renders nothing while results are on screen', () => {
    const { container } = renderState({ filteredProjectsCount: 2 });
    expect(container.textContent).toBe('');
  });
});
