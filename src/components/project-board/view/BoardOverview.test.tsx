/**
 * BoardOverview's phase bar, pinned against the T-1809 regression: a phase
 * marked status:"done" used to short-circuit to a green 100% bar even when
 * only some of its tasks were actually finished. The bar and its caption must
 * now reflect `phaseTaskStats` (lib/boardStats), not the phase's stored status
 * or its legacy manual `progress` field.
 *
 * RUNNER: NODE_ENV=test npx vitest run src/components/project-board/view/BoardOverview.test.tsx
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

import BoardOverview from './BoardOverview';

function makeState(overrides: Partial<ProjectBoardState> = {}): ProjectBoardState {
  return {
    $version: 1,
    project: 'Nassaj',
    updated: '2026-09-18',
    phases: [],
    tasks: [],
    issues: [],
    decisions: [],
    ...overrides,
  } as ProjectBoardState;
}

afterEach(cleanup);

describe('BoardOverview phase timeline', () => {
  it('CRUX: a phase marked done with 3/5 tasks finished reads 60%, not a fabricated 100%', () => {
    const state = makeState({
      phases: [{ id: 'P0', title: 'Foundations', status: 'done', progress: 100 }],
      tasks: [
        { id: 'T-1', title: 'a', phase: 'P0', status: 'done' },
        { id: 'T-2', title: 'b', phase: 'P0', status: 'done' },
        { id: 'T-3', title: 'c', phase: 'P0', status: 'done' },
        { id: 'T-4', title: 'd', phase: 'P0', status: 'open' },
        { id: 'T-5', title: 'e', phase: 'P0', status: 'in_progress' },
      ],
    });

    render(<BoardOverview state={state} />);

    // The caption reads the real figure and count …
    expect(screen.getByText('60% (3/5)')).toBeTruthy();

    // … and the fill element is neither green (only a genuinely-100% phase
    // gets that) nor width:100% — it must reflect the real 60%.
    const track = screen.getByText('60% (3/5)').previousElementSibling as HTMLElement;
    const fill = track.querySelector('div') as HTMLElement | null;
    expect(fill).not.toBeNull();
    expect(fill?.className).not.toMatch(/bg-green-500/);
    expect(fill?.style.width).toBe('60%');
  });

  it('a taskless phase in flight shows — with no fill element and no fabricated 0%', () => {
    // `current` with no task rows: nothing states a percentage, so nothing is
    // printed. This is the only case that still reads «—» (B-1249).
    const state = makeState({
      phases: [{ id: 'P9', title: 'Under way', status: 'current', progress: 40 }],
      tasks: [],
    });

    render(<BoardOverview state={state} />);

    const caption = screen.getByText('—');
    expect(caption).toBeTruthy();
    expect(screen.queryByText('0%')).toBeNull();
    expect(screen.queryByText('null%')).toBeNull();
    expect(screen.queryByText('NaN%')).toBeNull();
    // Nothing to average either — so no overall bar in the header.
    expect(screen.queryByRole('progressbar')).toBeNull();

    const track = caption.previousElementSibling as HTMLElement;
    // No fill div at all — an empty track, not a bare 0%.
    expect(track.querySelector('div')).toBeNull();
  });

  it('B-1249: a taskless phase not started reads 0%, and the header still appears', () => {
    const state = makeState({
      phases: [{ id: 'P9', title: 'Later', status: 'pending', progress: 40 }],
      tasks: [],
    });

    render(<BoardOverview state={state} />);

    // The stored 40 is never shown; the status says "not started".
    expect(screen.queryByText(/40/)).toBeNull();
    expect(screen.getAllByText('0%').length).toBeGreaterThan(0);
    // A board with phases but no task rows keeps its progress header.
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });

  it('B-1249: a taskless phase marked done reads a green 100%, not «—»', () => {
    const state = makeState({
      phases: [{ id: 'S0', title: 'Kickoff', status: 'done', progress: 0 }],
      tasks: [],
    });

    render(<BoardOverview state={state} />);

    expect(screen.queryByText('—')).toBeNull();
    // The phase caption, not the header figure (both read 100% here).
    const caption = screen
      .getAllByText('100%')
      .find((node) => node.className.includes('text-[11px]')) as HTMLElement;
    expect(caption).toBeTruthy();
    const track = caption.previousElementSibling as HTMLElement;
    const fill = track.querySelector('div') as HTMLElement | null;
    expect(fill?.className).toMatch(/bg-green-500/);
    expect(fill?.style.width).toBe('100%');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });

  it('a phase genuinely 100% done renders the green fill', () => {
    const state = makeState({
      phases: [{ id: 'P1', title: 'Shipped', status: 'done', progress: 100 }],
      tasks: [
        { id: 'T-1', title: 'a', phase: 'P1', status: 'done' },
        { id: 'T-2', title: 'b', phase: 'P1', status: 'done' },
      ],
    });

    render(<BoardOverview state={state} />);

    expect(screen.getByText('100% (2/2)')).toBeTruthy();
    const track = screen.getByText('100% (2/2)').previousElementSibling as HTMLElement;
    const fill = track.querySelector('div') as HTMLElement | null;
    expect(fill?.className).toMatch(/bg-green-500/);
    expect(fill?.style.width).toBe('100%');
  });
});
