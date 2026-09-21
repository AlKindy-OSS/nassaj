import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import CommandPalette from './CommandPalette';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ toggleDarkMode: vi.fn() }) }));
vi.mock('../../contexts/PaletteOpsContext', () => ({ usePaletteOps: () => ({ openFile: vi.fn() }) }));
vi.mock('../auth', () => ({ useAuth: () => ({ user: { role: 'owner' } }) }));
vi.mock('./sources/useSessionsSource', () => ({ useSessionsSource: () => [] }));
vi.mock('./sources/useFilesSource', () => ({ useFilesSource: () => [] }));
vi.mock('./sources/useCommitsSource', () => ({ useCommitsSource: () => [] }));
vi.mock('./sources/useSessionMessageSearch', () => ({ useSessionMessageSearch: () => [] }));
vi.mock('./sources/useBranchesSource', () => ({ useBranchesSource: () => [] }));
vi.mock('./sources/useGitActions', () => ({ useGitActions: () => ({ fetch: vi.fn(), pull: vi.fn(), push: vi.fn(), checkout: vi.fn() }) }));

function LocationProbe() {
  return <output>{useLocation().pathname}</output>;
}

describe('CommandPalette scheduled-message navigation', () => {
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(cleanup);

  it('navigates to the app-level scheduled-message center', () => {
    render(<MemoryRouter initialEntries={['/session/current']}><Routes><Route path="*" element={<><CommandPalette selectedProject={null} onStartNewChat={() => undefined} onOpenSettings={() => undefined} /><LocationProbe /></>} /></Routes></MemoryRouter>);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    fireEvent.click(screen.getByText('chat:scheduled.center.title'));
    expect(screen.getByText('/scheduled')).toBeTruthy();
  });
});
