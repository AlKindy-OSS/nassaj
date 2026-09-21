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
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import enProjectBoard from '../../../i18n/locales/en/projectBoard.json';
import arProjectBoard from '../../../i18n/locales/ar/projectBoard.json';
import type { CodebaseStats, ProjectStats } from '../projectStatsHelpers';

import ProjectStatsTab from './ProjectStatsTab';

/** The component's own defaultValues — a drift here means the tab changed wording. */
const DEFAULTS = {
  apiEquivalent:
    'Flat subscriptions are not billed per token: this is the API-equivalent value of the usage measured for this project, not an amount charged.',
  partialModels: 'Partial total — no official price for: {{models}}',
  empty: 'No cost data has been measured for this project yet.',
  codebaseTruncated:
    'The scan stopped at its file limit — these figures are a floor, not the whole tree.',
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
    complete: true,
    unpricedModels: [],
    assumedModels: [],
    gaps: [],
    daily: [
      { day: '2026-07-01', costUsd: 900, complete: true, unpriced: false, assumed: false },
      { day: '2026-07-04', costUsd: 0.3, complete: true, unpriced: false, assumed: false },
    ],
    activeDays: 2,
    firstActivity: '2026-07-01T08:00:00Z',
    lastActivity: '2026-07-04T23:00:00Z',
    dataThrough: '2026-07-04',
    projectActivityThrough: '2026-07-04',
    conversations: 432,
    agents: [
      { name: 'claude-opus-5', kind: 'model', invocations: 432 },
      { name: 'researcher', kind: 'subagent', invocations: 8 },
      { name: 'tester', kind: 'subagent', invocations: 3 },
    ],
    byVendor: [
      {
        label: 'Claude',
        costUsd: 21_347.25,
        share: 1,
        requests: 432,
        complete: true,
        unpriced: false,
        assumed: false,
      },
    ],
    byModel: [
      {
        label: 'claude-opus-5',
        costUsd: 21_347.25,
        share: 1,
        requests: 431,
        complete: true,
        unpriced: false,
        assumed: false,
      },
      {
        label: 'brand-new-model',
        costUsd: null,
        share: 0,
        requests: 1,
        complete: false,
        unpriced: true,
        assumed: false,
      },
    ],
    pricesAsOf: '2026-07-28',
    ...overrides,
  };
}

function makeCodeStats(overrides: Partial<CodebaseStats> = {}): CodebaseStats {
  return {
    totalBytes: 838_000,
    totalLines: 14_302,
    fileCount: 70,
    linesCounted: 68,
    complete: true,
    incompleteReasons: [],
    truncated: false,
    byExtension: [
      { extension: '.md', files: 33, bytes: 300_000 },
      { extension: '.py', files: 30, bytes: 500_000 },
    ],
    largestFiles: [{ path: 'src/wafeq_mcp/oauth.py', bytes: 26_700, modifiedAt: 1_785_000_000_000 }],
    recentlyModified: [{ path: 'README.md', bytes: 1_200, modifiedAt: 1_785_400_000_000 }],
    scannedAt: 1_785_500_000_000,
    ...overrides,
  };
}

afterEach(() => {
  uiDirection = 'ltr';
  cleanup();
});

describe('ProjectStatsTab', () => {
  it('renders an accessible skeleton while the first measurements load', () => {
    render(<ProjectStatsTab stats={null} cost={null} isLoading />);

    const loading = screen.getByRole('status', { name: enProjectBoard.stats.loading });
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(enProjectBoard.stats.empty)).toBeNull();
  });

  it('renders an explicit error when all statistics endpoints fail', () => {
    const retry = vi.fn();
    render(
      <ProjectStatsTab
        stats={null}
        cost={null}
        loadError="statistics-load-failed"
        onRefreshCodeStats={retry}
      />,
    );

    expect(screen.getByRole('alert').textContent).toContain(enProjectBoard.stats.loadError);
    expect(screen.queryByText(enProjectBoard.stats.empty)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: enProjectBoard.stats.retry }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('distinguishes an unavailable statistics capability from a measured-empty project', () => {
    render(
      <ProjectStatsTab stats={null} cost={null} loadError="statistics-unavailable" />,
    );

    expect(screen.getByRole('alert').textContent).toContain(
      enProjectBoard.stats.endpointUnavailable,
    );
    expect(screen.queryByRole('button', { name: enProjectBoard.stats.retry })).toBeNull();
    expect(screen.queryByText(enProjectBoard.stats.empty)).toBeNull();
  });

  it('ships the ledger-day and scanned-file qualifiers in English and Arabic', () => {
    expect(enProjectBoard.stats.pricedActiveDays).toBe('Days represented in ledger');
    expect(arProjectBoard.stats.pricedActiveDays).toBe('أيام ممثلة في السجل');
    expect(enProjectBoard.stats.codebaseLargestScanned).toContain('scanned files');
    expect(arProjectBoard.stats.codebaseLargestScanned).toContain('الملفات المفحوصة');
  });
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
    expect(
      screen.getByText(translate('stats.measuredDelegatedAgents')).closest('div')?.parentElement
        ?.textContent,
    ).toContain('2');
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

  it('distinguishes priced floors from estimates and their combination', () => {
    render(
      <ProjectStatsTab
        stats={makeStats({
          byModel: [
            {
              label: 'unpriced-part', costUsd: 10, share: 0.2, requests: 1,
              complete: false, unpriced: true, assumed: false,
            },
            {
              label: 'estimated-only', costUsd: 20, share: 0.4, requests: 1,
              complete: false, unpriced: false, assumed: true,
            },
            {
              label: 'mixed-part', costUsd: 30, share: 0.4, requests: 1,
              complete: false, unpriced: true, assumed: true,
            },
          ],
        })}
        cost={null}
      />,
    );

    expect(screen.getByText('≥$10.00')).toBeTruthy();
    expect(screen.getByText('≈$20.00')).toBeTruthy();
    expect(screen.getByText('≈$30.00')).toBeTruthy();
    expect(screen.getByText(translate('stats.breakdownFloor'))).toBeTruthy();
    expect(screen.getByText(translate('stats.assumedBreakdown'))).toBeTruthy();
    expect(screen.getByText(translate('stats.breakdownFloorWithEstimates'))).toBeTruthy();
  });

  it('names the unpriced models when the total is partial', () => {
    render(
      <ProjectStatsTab
        stats={makeStats({ complete: false, unpricedModels: ['brand-new-model'] })}
        cost={{
          totalUsd: 21_347.25,
          complete: false,
          unpricedModels: ['brand-new-model'],
          assumedModels: [],
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

  it('uses completeness from the payload that supplied the displayed total', () => {
    render(
      <ProjectStatsTab
        stats={makeStats({ complete: false, unpricedModels: ['stats-only-gap'] })}
        cost={{
          totalUsd: 999,
          complete: true,
          unpricedModels: [],
          assumedModels: [],
          firstDay: null,
          lastDay: null,
          pricesAsOf: null,
        }}
      />,
    );

    expect(screen.getByText(translate('stats.partialShort'))).toBeTruthy();
    expect(screen.getByText(/stats-only-gap/)).toBeTruthy();
  });

  it('draws sparse measured days without inventing zero-cost gap bars', () => {
    const { container } = render(<ProjectStatsTab stats={makeStats()} cost={null} />);

    // `svg[role="img"]` is the sparkline; the lucide tile icons are <svg> too.
    const bars = container.querySelectorAll('svg[role="img"] rect');
    expect(bars.length).toBe(2);
    const heights = Array.from(bars).map((bar) => Number(bar.getAttribute('height')));
    expect(heights[0]).toBeGreaterThan(0);
    expect(heights[1]).toBeGreaterThan(0);
  });

  it('mirrors the timeline under RTL so it runs with the reading direction', () => {
    uiDirection = 'rtl';
    const { container } = render(<ProjectStatsTab stats={makeStats()} cost={null} />);

    expect(container.querySelector('svg[role="img"]')?.getAttribute('class')).toContain(
      '-scale-x-100',
    );
  });

  it('labels a capped daily chart as the last 90 days', () => {
    render(
      <ProjectStatsTab
        stats={makeStats({
          dataThrough: '2026-06-01',
          projectActivityThrough: '2026-06-01',
          daily: [
            { day: '2026-01-01', costUsd: 1, complete: true, unpriced: false, assumed: false },
            { day: '2026-06-01', costUsd: 2, complete: true, unpriced: false, assumed: false },
          ],
        })}
        cost={null}
      />,
    );

    expect(
      screen.getByText(translate('stats.dailyLastDays', { days: 90 })),
    ).toBeTruthy();
  });

  it('draws all-unpriced zero usage as a visible marker with an honest tooltip and legend', () => {
    const { container } = render(
      <ProjectStatsTab
        stats={makeStats({
          daily: [
            { day: '2026-07-04', costUsd: 0, complete: false, unpriced: true, assumed: false },
          ],
        })}
        cost={null}
      />,
    );
    const bar = container.querySelector('svg[role="img"] rect');
    expect(Number(bar?.getAttribute('height'))).toBeGreaterThan(0);
    expect(bar?.textContent).toContain(translate('stats.dailyUnpriced'));
    expect(bar?.textContent).not.toContain('$0.00');
    expect(screen.getByText(translate('stats.dailyLegendComplete'))).toBeTruthy();
    expect(screen.getByText(translate('stats.dailyLegendEstimate'))).toBeTruthy();
    expect(screen.getByText(translate('stats.dailyLegendFloor'))).toBeTruthy();
  });

  it('labels a daily mixed estimate as approximate with remaining unpriced usage', () => {
    const { container } = render(
      <ProjectStatsTab
        stats={makeStats({
          daily: [
            { day: '2026-07-04', costUsd: 12, complete: false, unpriced: true, assumed: true },
          ],
        })}
        cost={null}
      />,
    );

    const bar = container.querySelector('svg[role="img"] rect');
    expect(bar?.textContent).toContain('≈$12.00');
    expect(bar?.textContent).toContain(translate('stats.dailyMixedEstimate'));
    expect(bar?.textContent).not.toContain('≥$12.00');
    expect(screen.getByText(translate('stats.dailyLegendMixed'))).toBeTruthy();
  });

  it('renders a message, not an empty shell, when nothing was measured', () => {
    const { container } = render(<ProjectStatsTab stats={null} cost={null} />);

    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(container.textContent).not.toContain('$');
    expect(
      screen.getByText(translate('stats.empty', { defaultValue: DEFAULTS.empty })),
    ).toBeTruthy();
  });

  it('renders a measured cost even when the richer stats endpoint is unavailable', () => {
    render(
      <ProjectStatsTab
        stats={null}
        cost={{
          totalUsd: 99,
          complete: true,
          unpricedModels: [],
          assumedModels: [],
          firstDay: '2026-07-01',
          lastDay: '2026-07-04',
          pricesAsOf: '2026-07-28',
        }}
      />,
    );

    expect(screen.getByText('$99.00')).toBeTruthy();
    expect(screen.queryByText(translate('stats.empty', { defaultValue: DEFAULTS.empty }))).toBeNull();
  });

  it('counts delegated agents only and lists base models separately', () => {
    render(<ProjectStatsTab stats={makeStats()} cost={null} />);

    expect(screen.getByText('researcher')).toBeTruthy();
    expect(screen.getByText('tester')).toBeTruthy();
    expect(screen.getAllByText('claude-opus-5').length).toBeGreaterThan(0);
    expect(screen.getByText(translate('stats.subagentRoster'))).toBeTruthy();
    expect(screen.getByText(translate('stats.modelRoster'))).toBeTruthy();
  });
  // ── the codebase block (T-1169) ────────────────────────────────────────────
  //
  // A second measurement on the same tab. It is INDEPENDENT of the ledger: the
  // tab must show files for a project that was never priced, and must show cost
  // for a server too old to walk the tree.

  it('shows the working tree next to the cost when both were measured', () => {
    render(<ProjectStatsTab stats={makeStats()} cost={null} codeStats={makeCodeStats()} />);

    expect(screen.getByText('70')).toBeTruthy();       // files
    expect(screen.getByText('14,302')).toBeTruthy();   // lines
    expect(screen.getByText('src/wafeq_mcp/oauth.py')).toBeTruthy();
    expect(screen.getByText(/Scanned/)).toBeTruthy();
  });

  it('renders the codebase alone for a project with no priced conversations', () => {
    const { container } = render(
      <ProjectStatsTab stats={null} cost={null} codeStats={makeCodeStats()} />,
    );

    expect(screen.getByText('70')).toBeTruthy();
    // The cost side stays honest about being absent instead of drawing $0.00.
    expect(container.textContent).not.toContain('$0.00');
    expect(
      screen.getByText(translate('stats.empty', { defaultValue: DEFAULTS.empty })),
    ).toBeTruthy();
  });

  it('shows every scan limit and marks aggregate measurements as floors', () => {
    render(
      <ProjectStatsTab
        stats={makeStats()}
        cost={null}
        codeStats={makeCodeStats({
          complete: false,
          incompleteReasons: [
            { code: 'DIRECTORY_LIMIT', count: 1 },
            { code: 'DIRECTORY_ENTRY_LIMIT', count: 2 },
          ],
        })}
      />,
    );

    expect(screen.getByText(translate('stats.codebaseIncomplete'))).toBeTruthy();
    expect(screen.getByText(translate('stats.codebaseReasonDirectoryLimit', { count: 1 }))).toBeTruthy();
    expect(
      screen.getByText(translate('stats.codebaseReasonDirectoryEntryLimit', { count: 2 })),
    ).toBeTruthy();
    expect(screen.getByText('≥838.0 KB')).toBeTruthy();
    expect(screen.getByText('≥14,302')).toBeTruthy();
    expect(screen.getByText('≥70')).toBeTruthy();
    expect(screen.getByText(translate('stats.codebaseLargestScanned'))).toBeTruthy();
    expect(screen.getByText(translate('stats.codebaseRecentScanned'))).toBeTruthy();
  });

  it('compares latest ledger and indexed activity neutrally only when they differ by over 48 hours', () => {
    const { rerender } = render(
      <ProjectStatsTab
        stats={makeStats({ dataThrough: '2026-07-30', projectActivityThrough: '2026-08-19' })}
        cost={null}
      />,
    );
    expect(screen.getByText(/Latest ledger activity:.*Latest indexed project activity:/)).toBeTruthy();

    rerender(
      <ProjectStatsTab
        stats={makeStats({ dataThrough: '2026-07-30', projectActivityThrough: '2026-08-01' })}
        cost={null}
      />,
    );
    expect(screen.queryByText(/Latest indexed project activity:/)).toBeNull();
  });

  it('offers the rescan control only when a handler is wired', () => {
    const { container, rerender } = render(
      <ProjectStatsTab stats={null} cost={null} codeStats={makeCodeStats()} />,
    );
    expect(container.querySelector('button')).toBeNull();

    rerender(
      <ProjectStatsTab
        stats={null}
        cost={null}
        codeStats={makeCodeStats()}
        onRefreshCodeStats={() => {}}
      />,
    );
    expect(container.querySelector('button')).not.toBeNull();
  });
});
