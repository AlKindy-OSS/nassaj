/**
 * T-2037 — a confirmed composer shell submit opens the Shell tab with a
 * one-shot run (never the chat transcript); the run strip lists the agent's
 * CLI first; a refused run mounts no shell, so nothing can re-send its init.
 *
 * Run: NODE_ENV=test npx vitest run src/components/main-content/view/MainContent.oneShot.test.tsx
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MainContentProps } from '../types/types';
import {
  ONESHOT_RUN_TTL_MS,
  markOneShotFinished,
  markOneShotRefused,
  requestOneShotRun,
  resetOneShotRunsForTests,
  startOneShotRun,
} from '../../shell/oneShot/oneShotRunsStore';

type AnyProps = Record<string, unknown>;
const panels = vi.hoisted(() => ({
  chat: vi.fn((_props: Record<string, unknown>) => null),
  shell: vi.fn((_props: Record<string, unknown>) => null),
  standalone: vi.fn((_props: Record<string, unknown>) => null),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options?.provider ? `${key}:${String(options.provider)}` : key),
  }),
}));
vi.mock('../../../contexts/PaletteOpsContext', () => ({ usePaletteOpsRegister: vi.fn() }));
vi.mock('../../../hooks/useUiPreferences', () => ({ useUiPreferences: () => ({ preferences: {} }) }));
const auth = vi.hoisted(() => ({ user: { id: 7, username: 'u7', role: 'owner' } as Record<string, unknown> }));
vi.mock('../../auth', () => ({ useAuth: () => ({ user: auth.user }) }));
vi.mock('../../code-editor/hooks/useEditorSidebar', () => ({ useEditorSidebar: () => ({}) }));
vi.mock('../../chat/view/ChatInterface', () => ({ default: panels.chat }));
vi.mock('../../file-tree/view/FileTree', () => ({ default: () => null }));
vi.mock('../../git-panel/view/GitPanel', () => ({ default: () => null }));
vi.mock('../../project-board', () => ({ ProjectBoardPanel: () => null }));
vi.mock('../../standalone-shell/view/StandaloneShell', () => ({ default: panels.standalone }));
vi.mock('../../shell/view/Shell', () => ({ default: panels.shell }));
vi.mock('../../code-editor/view/EditorSidebar', () => ({ default: () => null }));
vi.mock('../../wiki', () => ({ WikiPanel: () => null }));
vi.mock('../../terminals/view/TerminalsPanel', () => ({ default: () => null }));
vi.mock('./subcomponents/MainContentHeader', () => ({ default: () => null }));
vi.mock('./subcomponents/MainContentStateView', () => ({ default: () => null }));

import MainContent from './MainContent';

const project = { projectId: 'p1', name: 'P', displayName: 'P', path: '/p', fullPath: '/p' };

function baseProps(overrides: Partial<MainContentProps> = {}) {
  return {
    selectedProject: project,
    selectedSession: { id: 's1', __provider: 'claude' },
    activeTab: 'chat',
    deepLinkResolution: { status: 'idle' },
    setActiveTab: vi.fn(),
    ...overrides,
  } as unknown as MainContentProps;
}

function storeRuns(key: string, runs: Array<Record<string, unknown>>) {
  window.localStorage.setItem(`nassaj.oneShotRuns.v1:${key}`, JSON.stringify(runs));
}

afterEach(() => {
  auth.user = { id: 7, username: 'u7', role: 'owner' };
  cleanup();
  vi.clearAllMocks();
  resetOneShotRunsForTests();
  window.localStorage.clear();
});

describe('MainContent one-shot runs (T-2037)', () => {
  it('a composer request switches to the Shell tab and mounts a one-shot shell', () => {
    const props = baseProps();
    const { rerender } = render(<MainContent {...props} />);
    act(() => {
      requestOneShotRun('ls -la');
    });
    expect(props.setActiveTab).toHaveBeenCalledWith('shell');
    // The transcript (ChatInterface) received nothing new to render.
    const chatCalls = panels.chat.mock.calls.length;

    rerender(<MainContent {...props} activeTab="shell" />);
    const shellProps = panels.shell.mock.lastCall?.[0] as AnyProps;
    expect(shellProps).toEqual(expect.objectContaining({
      initialCommand: 'ls -la',
      isPlainShell: true,
      autoConnect: true,
    }));
    expect(typeof shellProps.oneShotRunId).toBe('string');
    expect(panels.standalone).not.toHaveBeenCalled();
    expect(panels.chat.mock.calls.slice(chatCalls).every(([p]) => !('initialCommand' in p))).toBe(true);
  });

  it('the strip lists the agent CLI first, labelled as the agent CLI, then the runs', () => {
    startOneShotRun('7:p1', 'git status');
    render(<MainContent {...baseProps({ activeTab: 'shell' })} />);
    const nav = screen.getByRole('navigation', { name: 'shellRuns.label' });
    const buttons = nav.querySelectorAll('button');
    expect(buttons[0].textContent).toBe('shellRuns.agentCli:Claude');
    expect(buttons[1].textContent).toContain('git status');

    fireEvent.click(buttons[0]);
    expect(panels.standalone).toHaveBeenCalled();
  });

  it('a refused run is final: no Shell is mounted for it', () => {
    const run = startOneShotRun('7:p1', 'pm2 stop all');
    markOneShotRefused('7:p1', run.runId, 'denied_command:pm2_lifecycle');
    render(<MainContent {...baseProps({ activeTab: 'shell' })} />);
    expect(panels.shell).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('shellMode.disabledReason.denied_command');
  });

  it('switching runs remounts with the stored runId, never a new one', () => {
    const first = startOneShotRun('7:p1', 'echo 1');
    const second = startOneShotRun('7:p1', 'echo 2');
    render(<MainContent {...baseProps({ activeTab: 'shell' })} />);
    expect(panels.shell.mock.lastCall?.[0].oneShotRunId).toBe(second.runId);
    fireEvent.click(screen.getByText('echo 1'));
    expect(panels.shell.mock.lastCall?.[0].oneShotRunId).toBe(first.runId);
    const ids = new Set(panels.shell.mock.calls.map(([p]) => p.oneShotRunId));
    expect(ids).toEqual(new Set([first.runId, second.runId]));
  });

  it('[qa critical-1] a run restored from storage mounts no shell (no init at all)', () => {
    storeRuns('7:p1', [{ runId: 'old-run', command: 'rm -rf build', startedAt: Date.now() - 60_000, status: 'running', exitCode: null, refusalCode: null }]);
    render(<MainContent {...baseProps({ activeTab: 'shell' })} />);
    fireEvent.click(screen.getByText('rm -rf build'));
    expect(panels.shell).not.toHaveBeenCalled();
    expect(screen.getByText('shellRuns.stale')).toBeTruthy();
  });

  it('drops stored runs older than the 30 min TTL', () => {
    storeRuns('7:p1', [{ runId: 'ancient', command: 'echo old', startedAt: Date.now() - ONESHOT_RUN_TTL_MS - 1, status: 'finished', exitCode: 0, refusalCode: null }]);
    render(<MainContent {...baseProps({ activeTab: 'shell' })} />);
    expect(screen.queryByText('echo old')).toBeNull();
  });

  it('a different user on the same browser neither sees nor mounts another user\'s runs', () => {
    startOneShotRun('7:p1', 'whoami');
    auth.user = { id: 8, username: 'u8', role: 'owner' };
    render(<MainContent {...baseProps({ activeTab: 'shell' })} />);
    expect(screen.queryByText('whoami')).toBeNull();
    expect(screen.queryByTestId('oneshot-run-strip')).toBeNull();
    expect(panels.shell).not.toHaveBeenCalled();
  });

  it('a live run that finished elsewhere becomes static once you navigate back to it', () => {
    const first = startOneShotRun('7:p1', 'echo a');
    const second = startOneShotRun('7:p1', 'echo b');
    markOneShotFinished('7:p1', first.runId, { exitCode: 0 });
    render(<MainContent {...baseProps({ activeTab: 'shell' })} />);
    expect(panels.shell.mock.lastCall?.[0].oneShotRunId).toBe(second.runId);
    const before = panels.shell.mock.calls.length;
    fireEvent.click(screen.getByText('echo a'));
    expect(panels.shell.mock.calls.slice(before).some(([p]) => p.oneShotRunId === first.runId)).toBe(false);
  });

  it.each([
    [{ exitCode: null, interrupted: true }, 'shellRuns.outcome.interrupted'],
    [{ exitCode: null, unknown: true }, 'shellRuns.outcome.unknown'],
    [{ exitCode: null }, 'shellRuns.outcome.unknown'],
    [{ exitCode: null, refused: true }, 'shellRuns.outcome.refused'],
  ])('[qa round 3] finish %o never reads as success: %s', (outcome, label) => {
    const run = startOneShotRun('7:p1', 'npm run migrate');
    markOneShotFinished('7:p1', run.runId, outcome);
    render(<MainContent {...baseProps({ activeTab: 'shell' })} />);
    const shown = screen.getAllByText(label);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((node) => !node.className.includes('emerald'))).toBe(true);
    expect(screen.queryByText('shellRuns.exit')).toBeNull();
  });

  it('a real numeric exit code shows the exit code', () => {
    const run = startOneShotRun('7:p1', 'true');
    markOneShotFinished('7:p1', run.runId, { exitCode: 0 });
    render(<MainContent {...baseProps({ activeTab: 'shell' })} />);
    expect(screen.getByText('shellRuns.exit').className).toContain('emerald');
  });
});
