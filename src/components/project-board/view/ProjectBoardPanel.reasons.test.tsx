/**
 * B-1524: the board says WHY it cannot be shown instead of always claiming
 * "no board yet". Only `missing` (or a legacy server with no reason) may offer
 * the starter template; every other reason must not invite overwriting a file.
 *
 * RUNNER: NODE_ENV=test npx vitest run src/components/project-board/view/ProjectBoardPanel.reasons.test.tsx
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import arProjectBoard from '../../../i18n/locales/ar/projectBoard.json';
import enProjectBoard from '../../../i18n/locales/en/projectBoard.json';

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

type HookResult = { board: unknown; isLoading: boolean; loadError: boolean; notFound: boolean };
const hookResult: { current: HookResult } = {
  current: { board: null, isLoading: false, loadError: false, notFound: false },
};

vi.mock('../hooks/useProjectBoard', () => ({ useProjectBoard: () => hookResult.current }));
vi.mock('../hooks/useProjectStats', () => ({
  useProjectStats: () => ({
    cost: null,
    stats: null,
    codeStats: null,
    isLoading: false,
    loadError: null,
    refresh: vi.fn(),
  }),
}));

import ProjectBoardPanel from './ProjectBoardPanel';

const state = {
  $version: 1,
  project: 'Nassaj',
  updated: '2026-07-29',
  phases: [{ id: 'P1', title: 'Foundations', status: 'current', progress: 40 }],
  tasks: [],
  issues: [],
  decisions: [],
};

const setBoard = (overrides: Record<string, unknown>) => {
  hookResult.current = {
    board: {
      projectId: 'proj-1',
      available: false,
      state: null,
      stateError: false,
      architecture: { technical: null, simplified: null },
      ...overrides,
    },
    isLoading: false,
    loadError: false,
    notFound: false,
  };
};

const renderPanel = () =>
  render(
    <ProjectBoardPanel
      selectedProject={{ projectId: 'proj-1', displayName: 'Nassaj', name: 'nassaj' } as never}
    />,
  );

afterEach(cleanup);

describe('board unavailable reasons', () => {
  it.each([
    ['invalid_json', enProjectBoard.unavailable.invalid_json],
    ['outside_project', enProjectBoard.unavailable.outside_project],
    ['external_source_unconfigured', enProjectBoard.unavailable.external_source_unconfigured],
    ['unreadable', enProjectBoard.unavailable.unreadable],
  ])('%s renders its own message and no template button', (stateReason, message) => {
    setBoard({ stateReason });
    renderPanel();

    expect(screen.getByTestId('board-unavailable')).toBeTruthy();
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByText(enProjectBoard.empty.title)).toBeNull();
    expect(screen.queryByText(enProjectBoard.empty.copyTemplate)).toBeNull();
  });

  it('too_large interpolates the limit when the server sends one', () => {
    setBoard({ stateReason: 'too_large', stateLimitMb: 5 });
    renderPanel();
    expect(screen.getByText('The project state file is larger than the allowed limit (5 MB).')).toBeTruthy();
  });

  it('too_large drops the limit when none is sent', () => {
    setBoard({ stateReason: 'too_large' });
    renderPanel();
    expect(screen.getByText(enProjectBoard.unavailable.too_large_nolimit)).toBeTruthy();
  });

  it('missing still offers the starter template', () => {
    setBoard({ stateReason: 'missing' });
    renderPanel();
    expect(screen.getByText(enProjectBoard.empty.title)).toBeTruthy();
    expect(screen.getByText(enProjectBoard.empty.copyTemplate)).toBeTruthy();
    expect(screen.queryByTestId('board-unavailable')).toBeNull();
  });

  it('legacy server (no stateReason, no state) keeps the empty state', () => {
    setBoard({});
    renderPanel();
    expect(screen.getByText(enProjectBoard.empty.copyTemplate)).toBeTruthy();
    expect(screen.queryByTestId('board-unavailable')).toBeNull();
  });

  it('serves the last good state with a non-blocking notice when the reason is not ok', () => {
    setBoard({ available: true, state, stateReason: 'invalid_json' });
    renderPanel();

    const notice = screen.getByTestId('board-stale-notice');
    expect(notice.textContent).toContain(enProjectBoard.unavailable.invalid_json);
    expect(screen.getByText('Foundations')).toBeTruthy();
    expect(screen.queryByTestId('board-unavailable')).toBeNull();
  });

  it('shows no notice when the reason is ok', () => {
    setBoard({ available: true, state, stateReason: 'ok' });
    renderPanel();
    expect(screen.queryByTestId('board-stale-notice')).toBeNull();
    expect(screen.getByText('Foundations')).toBeTruthy();
  });

  it('404 shows the not-visible message instead of the generic error', () => {
    hookResult.current = { board: null, isLoading: false, loadError: false, notFound: true };
    renderPanel();
    expect(screen.getByText(enProjectBoard.unavailable.notVisible)).toBeTruthy();
    expect(screen.queryByText(enProjectBoard.error)).toBeNull();
  });

  it('ships the Arabic strings for every reason', () => {
    const keys = Object.keys(enProjectBoard.unavailable).sort();
    expect(Object.keys(arProjectBoard.unavailable).sort()).toEqual(keys);
  });
});
