/**
 * The statistics tab, pinned against the ONE failure mode that matters here:
 * a figure the server never produced being drawn as a confident `$0.00`.
 *
 * Three rules of ADR-078 are asserted structurally, not by wording:
 *  1. A missing counter is a dash. `$0.00` appears in this tab only where the
 *     server measured a real zero.
 *  2. The API-equivalent caveat travels with the headline amount — always, not
 *     only for subscriptions we happen to recognise.
 *  3. A partial total names what is missing instead of quietly under-reporting
 *     (the 3.2x understatement this whole feature exists to fix).
 *
 * `t` resolves against the REAL en/projectBoard.json and falls back to the
 * caller's defaultValue, so the assertions keep holding once the coordinator
 * lands the `stats.*` keys — and a renamed key surfaces here.
 *
 * RUNNER: NODE_ENV=test npx vitest run src/components/project-board/view/ProjectStatsTab.test.tsx
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import enProjectBoard from '../../../i18n/locales/en/projectBoard.json';
import type { ProjectStats } from '../projectStatsHelpers';

import ProjectStatsTab from './ProjectStatsTab';

/** The component's own defaultValues — a drift here means the tab changed wording. */
const DEFAULTS = {
  apiEquivalent:
    'Flat subscriptions are not billed per token: this is the API-equivalent value of the usage measured for this project, not an amount charged.',
  partialModels: 'Partial total — no official price for: {{models}}',
  empty: 'No cost data has been measured for this project yet.',
};

// ── i18n against the shipped bundle ──────────────────────────────────────────

let uiDirection: 'ltr' | 'rtl' = 'ltr';

function lookup(key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) =>
      node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
    enProjectBoard as unknown,
  );
  return typeof value === 'string' ? value : undefined;
}

function translate(key: string, options: Record<string, unknown> = {}): string {
  const template = lookup(key) ?? (options.defaultValue as string) ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in options ? String(options[name]) : match,
  );
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => translate(key, options ?? {}),
    i18n: { language: 'en', dir: () => uiDirection },
  }),
}));

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeStats(overrides: Partial<ProjectStats> = {}): ProjectStats {
  return {
    totalUsd: 21_347.25,
    daily: [
      { day: '2026-07-01', costUsd: 900 },
      { day: '2026-07-04', costUsd: 0.3 },
    ],
    activeDays: 2,
    firstActivity: '2026-07-01T08:00:00Z',
    lastActivity: '2026-07-04T23:00:00Z',
    conversations: 432,
    agents: 11,
    byVendor: [{ label: 'anthropic', costUsd: 21_347.25, share: 1 }],
    byModel: [
      { label: 'claude-opus-5', costUsd: 21_347.25, share: 1 },
      { label: 'brand-new-model', costUsd: null, share: 0 },
    ],
    pricesAsOf: '2026-07-28',
    ...overrides,
  };
}

afterEach(() => {
  uiDirection = 'ltr';
  cleanup();
});

describe('ProjectStatsTab', () => {
  it('shows the total with its API-equivalent caveat', () => {
    render(<ProjectStatsTab stats={makeStats()} cost={null} />);

    // The amount also appears in the breakdown rows; the headline is the big one.
    const amounts = screen.getAllByText('$21,347.25');
    expect(amounts.length).toBeGreaterThan(0);
    expect(amounts.some((node) => node.className.includes('text-2xl'))).toBe(true);
    expect(
      screen.getByText(translate('stats.apiEquivalent', { defaultValue: DEFAULTS.apiEquivalent })),
    ).toBeTruthy();
  });

  it('renders the measured counters', () => {
    render(<ProjectStatsTab stats={makeStats()} cost={null} />);

    expect(screen.getByText('432')).toBeTruthy();
    expect(screen.getByText('11')).toBeTruthy();
    // Span is inclusive: 2026-07-01 .. 2026-07-04.
    expect(screen.getByText('4')).toBeTruthy();
  });

  it('draws a dash — never $0.00 — for counters the server did not report', () => {
    const { container } = render(
      <ProjectStatsTab
        stats={makeStats({ conversations: null, agents: null, activeDays: null })}
        cost={null}
      />,
    );

    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
    // No tile prints a zero. (`$0.00` does appear inside the chart's per-bar
    // <title> for the two silent days — those are measured zeros, not unknowns,
    // and an exact-text query never matches that composed tooltip string.)
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(container.querySelectorAll('svg[role="img"] rect').length).toBeGreaterThan(0);
  });

  it('lists an unpriced model as unknown, not as free', () => {
    render(<ProjectStatsTab stats={makeStats()} cost={null} />);

    const row = screen.getByText('brand-new-model').closest('div');
    expect(row?.textContent).toContain('—');
    expect(row?.textContent).not.toContain('$0.00');
  });

  it('names the unpriced models when the total is partial', () => {
    render(
      <ProjectStatsTab
        stats={makeStats()}
        cost={{
          totalUsd: 21_347.25,
          complete: false,
          unpricedModels: ['brand-new-model'],
          firstDay: '2026-07-01',
          lastDay: '2026-07-04',
          pricesAsOf: '2026-07-28',
        }}
      />,
    );

    expect(
      screen.getByText(
        translate('stats.partialModels', {
          defaultValue: DEFAULTS.partialModels,
          models: 'brand-new-model',
        }),
      ),
    ).toBeTruthy();
  });

  it('draws one bar per calendar day of the measured range, gaps included', () => {
    const { container } = render(<ProjectStatsTab stats={makeStats()} cost={null} />);

    // `svg[role="img"]` is the sparkline; the lucide tile icons are <svg> too.
    const bars = container.querySelectorAll('svg[role="img"] rect');
    // 4 days spanned; the two silent days in between are real, measured zeros.
    expect(bars.length).toBe(4);
    // A tiny but real day keeps a visible bar; a zero day draws none.
    const heights = Array.from(bars).map((bar) => Number(bar.getAttribute('height')));
    expect(heights[0]).toBeGreaterThan(0);
    expect(heights[1]).toBe(0);
    expect(heights[3]).toBeGreaterThan(0);
  });

  it('mirrors the timeline under RTL so it runs with the reading direction', () => {
    uiDirection = 'rtl';
    const { container } = render(<ProjectStatsTab stats={makeStats()} cost={null} />);

    expect(container.querySelector('svg[role="img"]')?.getAttribute('class')).toContain(
      '-scale-x-100',
    );
  });

  it('renders a message, not an empty shell, when nothing was measured', () => {
    const { container } = render(<ProjectStatsTab stats={null} cost={null} />);

    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(container.textContent).not.toContain('$');
    expect(
      screen.getByText(translate('stats.empty', { defaultValue: DEFAULTS.empty })),
    ).toBeTruthy();
  });
});
