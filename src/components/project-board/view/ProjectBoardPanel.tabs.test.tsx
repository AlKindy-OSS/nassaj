/**
 * The board's tab split — pinned against what a split like this actually breaks.
 *
 * Overview used to be one page holding the phase timeline, every task, every
 * issue and every decision. On a real board that is hundreds of rows in one
 * scroll, so the lists became tabs of their own. Three things must survive that:
 *
 *  1. **The bug-task → issue link still lands.** It used to be a scroll inside
 *     one page; it is now a tab switch plus a scroll, and the issue rows do not
 *     exist in the document at the moment of the click. This is the crux test:
 *     if it regresses, a link that looks clickable silently does nothing.
 *  2. **Nothing was dropped in the move.** Every task, issue and decision is
 *     still reachable — on its own tab rather than on the overview.
 *  3. **Empty sections get no tab**, and a selected tab that stops existing
 *     falls back instead of rendering a blank pane.
 *
 * Tab ORDER is asserted too, since "logical order" is the requirement: reading
 * the tabs left to right must follow the project's narrative.
 *
 * RUNNER: NODE_ENV=test npx vitest run src/components/project-board/view/ProjectBoardPanel.tabs.test.tsx
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enProjectBoard from '../../../i18n/locales/en/projectBoard.json';
import type { ProjectBoardState } from '../types';

// ── i18n against the shipped bundle (a renamed key surfaces here) ─────────────

function lookup(key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) =>
      node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
    enProjectBoard as unknown,
  );
  return typeof value === 'string' ? value : undefined;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const template = lookup(key) ?? ((options?.defaultValue as string) ?? key);
      return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
        options && name in options ? String(options[name]) : match,
      );
    },
    i18n: { language: 'en', dir: () => 'ltr' as const },
  }),
}));

// ── the panel's data sources ─────────────────────────────────────────────────

const boardState: { current: ProjectBoardState | null } = { current: null };

vi.mock('../hooks/useProjectBoard', () => ({
  useProjectBoard: () => ({
    board: {
      projectId: 'proj-1',
      available: true,
      state: boardState.current,
      stateError: false,
      architecture: { technical: '# Arch', simplified: '' },
    },
    isLoading: false,
    loadError: null,
  }),
}));

vi.mock('../hooks/useProjectStats', () => ({
  useProjectStats: () => ({ cost: null, stats: null }),
}));

vi.mock('../../runner/useRunner', () => ({
  useRunner: () => ({
    runner: null,
    registered: false,
    actionPending: false,
    start: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    approve: vi.fn(),
    forceStop: vi.fn(),
    approveApproval: vi.fn(),
    rejectApproval: vi.fn(),
  }),
}));

import ProjectBoardPanel from './ProjectBoardPanel';

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<ProjectBoardState> = {}): ProjectBoardState {
  return {
    $version: 1,
    project: 'Nassaj',
    updated: '2026-07-29',
    phases: [{ id: 'P1', title: 'Foundations', status: 'current', progress: 40 }],
    tasks: [
      { id: 'T-1', title: 'Wire the ledger', phase: 'P1', status: 'in_progress' },
      { id: 'T-2', title: 'Fix the double count', phase: 'P1', status: 'open', kind: 'bug', issue: 'B-2' },
      { id: 'T-3', title: 'Ship the tabs', phase: 'P1', status: 'done' },
    ],
    issues: [
      { id: 'B-1', title: 'Cost understated 3.2x', severity: 'critical', status: 'fixed' },
      { id: 'B-2', title: 'Orphan subagents double counted', severity: 'critical', status: 'open' },
    ],
    decisions: [{ id: 'ADR-078', title: 'Cost accounting reads transcripts' }],
    ...overrides,
  } as ProjectBoardState;
}

const scrollIntoView = vi.fn();

beforeEach(() => {
  boardState.current = makeState();
  // jsdom has no layout, so scrollIntoView is absent — the link's scroll is
  // observed through this spy rather than through a real viewport.
  Element.prototype.scrollIntoView = scrollIntoView;
  scrollIntoView.mockClear();
});

afterEach(cleanup);

const renderPanel = () =>
  render(
    <ProjectBoardPanel
      selectedProject={{ projectId: 'proj-1', displayName: 'Nassaj', name: 'nassaj' } as never}
    />,
  );

/** The pill bar only — the overview's summary tiles carry the same words. */
const tabBar = () => within(screen.getByTestId('board-tabs'));
const tab = (name: string) => tabBar().getByRole('button', { name: new RegExp(`^${name}$`, 'i') });
const queryTab = (name: string) =>
  tabBar().queryByRole('button', { name: new RegExp(`^${name}$`, 'i') });

/** Clicks inside act() so the resulting tab switch is flushed before assertions. */
const click = (element: HTMLElement) => {
  act(() => {
    fireEvent.click(element);
  });
};

describe('board tabs', () => {
  it('CRUX: a bug-task link opens the issues tab and scrolls to its issue', () => {
    renderPanel();

    click(tab('Tasks'));
    // The link is a task-card badge; the issue rows are NOT rendered yet.
    expect(screen.queryByText('Orphan subagents double counted')).toBeNull();

    click(screen.getByRole('button', { name: /B-2/i }));

    // It crossed the tab boundary: the issue is now on screen…
    const row = screen.getByText('Orphan subagents double counted');
    expect(row).toBeTruthy();
    // …and was scrolled to, which is the part a naive split silently loses.
    expect(scrollIntoView).toHaveBeenCalled();
    // The flash ring marks WHICH issue was asked for, not merely that the tab opened.
    expect(document.getElementById('board-issue-B-2')?.className).toMatch(/ring-2/);
  });

  it('moves the long lists off the overview without losing any of them', () => {
    renderPanel();

    // The overview no longer carries the lists…
    expect(screen.queryByText('Wire the ledger')).toBeNull();
    expect(screen.queryByText('Cost understated 3.2x')).toBeNull();
    expect(screen.queryByText('Cost accounting reads transcripts')).toBeNull();
    // …but it still shows the phase timeline, which IS the overview's job.
    expect(screen.getByText('Foundations')).toBeTruthy();

    // …and every list is reachable on its own tab.
    click(tab('Tasks'));
    expect(screen.getByText('Wire the ledger')).toBeTruthy();
    expect(screen.getByText('Ship the tabs')).toBeTruthy();

    click(tab('Issues'));
    expect(screen.getByText('Cost understated 3.2x')).toBeTruthy();

    click(tab('Decisions'));
    expect(screen.getByText('Cost accounting reads transcripts')).toBeTruthy();
  });

  it('summarises on the overview what it no longer lists, and the counts lead there', () => {
    renderPanel();

    // A split that only hides things costs the glance the scroll used to give.
    const tasksTile = screen.getByRole('button', { name: /3\s*1 done\s*Tasks/i });
    expect(tasksTile).toBeTruthy();
    expect(screen.getByRole('button', { name: /2\s*1 open\s*Issues/i })).toBeTruthy();

    click(tasksTile);
    expect(screen.getByText('Wire the ledger')).toBeTruthy();
  });

  it('shows the tabs in the project narrative order', () => {
    renderPanel();

    const order = ['Overview', 'Tasks', 'Issues', 'Decisions', 'Architecture'];
    const shown = tabBar()
      .getAllByRole('button')
      .map((node) => node.textContent ?? '')
      .filter((label) => order.some((name) => label.includes(name)));

    // Present tabs keep the declared sequence: state → execution → record → build.
    expect(shown.map((label) => order.find((name) => label.includes(name)))).toEqual(order);
  });

  it('gives an empty section no tab of its own', () => {
    boardState.current = makeState({ issues: [], decisions: [] });
    renderPanel();

    expect(queryTab('Issues')).toBeNull();
    expect(queryTab('Decisions')).toBeNull();
    // A tab whose section still has rows stays.
    expect(tab('Tasks')).toBeTruthy();
  });

  it('falls back to the overview when the open tab stops existing', () => {
    const { rerender } = renderPanel();

    click(tab('Issues'));
    expect(screen.getByText('Cost understated 3.2x')).toBeTruthy();

    // The board file is rewritten with its issues resolved away while open.
    boardState.current = makeState({ issues: [] });
    rerender(
      <ProjectBoardPanel
        selectedProject={{ projectId: 'proj-1', displayName: 'Nassaj', name: 'nassaj' } as never}
      />,
    );

    // Not a blank pane: the overview, with its phase timeline.
    expect(screen.getByText('Foundations')).toBeTruthy();
  });
});
