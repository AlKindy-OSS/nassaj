import { createPortal } from 'react-dom';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MainContentProps } from '../types/types';

const panels = vi.hoisted(() => ({ git: vi.fn(), files: vi.fn(), board: vi.fn(), chat: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../contexts/PaletteOpsContext', () => ({ usePaletteOpsRegister: vi.fn() }));
vi.mock('../../../hooks/useUiPreferences', () => ({ useUiPreferences: () => ({ preferences: {} }) }));
vi.mock('../../auth', () => ({ useAuth: () => ({ user: { role: 'owner' } }) }));
vi.mock('../../code-editor/hooks/useEditorSidebar', () => ({ useEditorSidebar: () => ({}) }));
vi.mock('../../chat/view/ChatInterface', () => ({ default: panels.chat }));
vi.mock('../../file-tree/view/FileTree', () => ({ default: panels.files }));
vi.mock('../../git-panel/view/GitPanel', () => ({ default: panels.git }));
vi.mock('../../project-board', () => ({ ProjectBoardPanel: panels.board }));
vi.mock('../../standalone-shell/view/StandaloneShell', () => ({ default: () => null }));
vi.mock('../../code-editor/view/EditorSidebar', () => ({ default: () => null }));
vi.mock('../../wiki', () => ({ WikiPanel: () => null }));
vi.mock('../../terminals/view/TerminalsPanel', () => ({ default: () => null }));
vi.mock('./subcomponents/MainContentHeader', () => ({ default: ({ sessionHeaderRef }: { sessionHeaderRef: (el: HTMLDivElement | null) => void }) => <div data-testid="header-slot" ref={sessionHeaderRef} /> }));
vi.mock('./subcomponents/MainContentStateView', () => ({ default: () => null }));

import MainContent from './MainContent';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe.each([false, true])('project tools (mobile=%s)', (isMobile) => {
  it.each(['git', 'files', 'board'] as const)('%s follows the project independently of the retained conversation', (activeTab) => {
    const project = { projectId: 'project-a', name: 'A', displayName: 'A', path: '/a', fullPath: '/a' };
    const session = { id: 'legacy-session-without-binding' };
    const props = { selectedProject: project, selectedSession: session, activeTab, isMobile,
      deepLinkResolution: { status: 'idle' }, setActiveTab: vi.fn() } as unknown as MainContentProps;
    const { rerender } = render(<MainContent {...props} />);
    const panel = panels[activeTab];
    expect(panel.mock.lastCall?.[0].selectedProject).toBe(project);
    expect(panel.mock.lastCall?.[0].selectedSession).toBeUndefined();
    expect(panels.chat.mock.lastCall?.[0].selectedSession).toBe(session);
    const nextProject = { projectId: 'project-b', name: 'B', displayName: 'B', path: '/b', fullPath: '/b' };
    rerender(<MainContent {...props} selectedProject={nextProject} />);
    expect(panel.mock.lastCall?.[0].selectedProject).toBe(nextProject);
    expect(panel.mock.lastCall?.[0].selectedSession).toBeUndefined();
  });
});


it('keeps the same header target and visible portal through chat, shell and files navigation', () => {
  panels.chat.mockImplementation(({ sessionHeaderTarget, selectedSession }) => sessionHeaderTarget
    ? createPortal(<button>{selectedSession.id}</button>, sessionHeaderTarget)
    : null);
  const props = { selectedProject: { projectId: 'p', path: '/p' }, selectedSession: { id: 'first-session' },
    activeTab: 'chat', deepLinkResolution: { status: 'idle' }, setActiveTab: vi.fn() } as unknown as MainContentProps;
  const { rerender } = render(<MainContent {...props} />);
  const target = screen.getByTestId('header-slot');
  for (const activeTab of ['shell', 'files', 'chat'] as const) {
    rerender(<MainContent {...props} activeTab={activeTab} />);
    expect(screen.getByTestId('header-slot')).toBe(target);
    expect(target.contains(screen.getByRole('button', { name: 'first-session' }))).toBe(true);
    expect(panels.chat.mock.lastCall?.[0].sessionHeaderTarget).toBe(target);
  }
  rerender(<MainContent {...props} selectedSession={{ id: 'next-session' }} />);
  expect(screen.queryByText('first-session')).toBeNull();
  expect(target.contains(screen.getByRole('button', { name: 'next-session' }))).toBe(true);
});
