import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import MainContentTabSwitcher from './MainContentTabSwitcher';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../hooks/useResolvedTabsMode', () => ({ useResolvedTabsMode: () => 'icons' }));
afterEach(cleanup);
// B-971: on mobile with the sidebar drawer closed, project tools (files/git/board)
// must be hidden from the top bar — the sidebar toolbar is always mounted and
// fires onProjectToolbarPresence regardless of drawer open state.
it('hides project tools on mobile when sidebar drawer is closed (B-971)', () => {
  const setActiveTab = vi.fn();
  // Simulate: projectToolbarId matches selectedProject (sidebar mounted, project expanded)
  // but drawer is closed on mobile — hideProjectTools must still be true.
  render(<MainContentTabSwitcher activeTab="chat" setActiveTab={setActiveTab} hideProjectTools />);
  expect(screen.queryByRole('button', { name: 'tabs.files' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'tabs.git' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'tabs.board' })).toBeNull();
  // Non-project tabs remain visible on mobile
  expect(screen.getByRole('button', { name: 'tabs.chat' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'tabs.shell' })).toBeTruthy();
});
it('restores accessible project tools when the sidebar toolbar becomes unavailable', () => {
  const setActiveTab = vi.fn();
  const { rerender } = render(<MainContentTabSwitcher activeTab="chat" setActiveTab={setActiveTab} hideProjectTools />);
  expect(screen.queryByRole('button', { name: 'tabs.files' })).toBeNull();
  expect(screen.getByRole('button', { name: 'tabs.chat' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'tabs.shell' })).toBeTruthy();
  rerender(<MainContentTabSwitcher activeTab="chat" setActiveTab={setActiveTab} hideProjectTools={false} />);
  for (const tool of ['files', 'git', 'board']) {
    fireEvent.click(screen.getByRole('button', { name: `tabs.${tool}` }));
    expect(setActiveTab).toHaveBeenLastCalledWith(tool);
  }
});
