import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';

import SidebarSearchRow from './SidebarSearchRow';

const t = ((key: string) => key) as unknown as TFunction;

function renderRow(overrides: Partial<React.ComponentProps<typeof SidebarSearchRow>> = {}) {
  const props: React.ComponentProps<typeof SidebarSearchRow> = {
    searchFilter: '',
    onSearchFilterChange: vi.fn(),
    onClearSearchFilter: vi.fn(),
    searchMode: 'projects',
    onSearchModeChange: vi.fn(),
    searchScope: 'all',
    onSearchScopeChange: vi.fn(),
    isMessageSearching: false,
    t,
    ...overrides,
  };
  render(<SidebarSearchRow {...props} />);
  return props;
}

describe('SidebarSearchRow', () => {
  afterEach(cleanup);

  it('keeps the project search input and both controls operational after relocation', () => {
    const props = renderRow();
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: 'alpha' } });
    expect(props.onSearchFilterChange).toHaveBeenCalledWith('alpha');
    const row = document.querySelector('[data-sidebar-search-row]');
    expect(row).toBeTruthy();
    expect(row?.className).toContain('h-11');
    expect(row?.className).not.toContain('border-b');
    expect(row?.className).not.toContain('border-border/40');
    expect(input.className).toContain('h-8');
    expect(input.className).not.toContain('h-10');
  });

  it('uses the archive placeholder and omits the irrelevant scope control', () => {
    renderRow({ searchMode: 'archived' });

    expect(screen.getByPlaceholderText('search.archivedPlaceholder')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'search.scope.label' })).toBeNull();
  });

  it('exposes clear and loading state without changing the fixed top rail', () => {
    const onClearSearchFilter = vi.fn();
    renderRow({ searchFilter: 'alpha', isMessageSearching: true, onClearSearchFilter });

    expect(screen.getByLabelText('search.searchingConversations')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'tooltips.clearSearch' }));
    expect(onClearSearchFilter).toHaveBeenCalledTimes(1);
  });
});
