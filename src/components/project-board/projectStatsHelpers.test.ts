/**
 * The honesty rules of ADR-078 as executable assertions.
 *
 * What is pinned here is not formatting: it is that a missing figure stays
 * missing (`null`) all the way to the view, that the ONE invented zero (a silent
 * day inside a measured range) is deliberate, and that an unpriced model is
 * ordered and shared as UNKNOWN rather than as cheap.
 *
 * RUNNER: npx tsx --test src/components/project-board/projectStatsHelpers.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildSparkline,
  buildDailyWindow,
  fillDailyGaps,
  formatDayLabel,
  ledgerLagInDays,
  normalizeBreakdown,
  normalizeCodebaseStats,
  normalizeDaily,
  normalizeProjectCost,
  normalizeProjectStats,
  spanInDays,
  toDay,
  type DailyCost,
} from './projectStatsHelpers';

function completeDay(day: string, costUsd: number): DailyCost {
  return { day, costUsd, complete: true, unpriced: false, assumed: false };
}

describe('normalizeProjectCost', () => {
  it('reads the documented envelope', () => {
    const cost = normalizeProjectCost({
      success: true,
      cost: {
        totalUsd: 21_347.25,
        complete: false,
        unpricedModels: ['some-new-model', '  '],
        assumedModels: ['compatible-model'],
        firstDay: '2026-05-01',
        lastDay: '2026-07-28',
        pricesAsOf: '2026-07-28',
      },
    });
    assert.equal(cost?.totalUsd, 21_347.25);
    assert.equal(cost?.complete, false);
    assert.deepEqual(cost?.unpricedModels, ['some-new-model']);
    assert.equal(cost?.firstDay, '2026-05-01');
  });

  it('is null when the endpoint is absent or errored — never a zero total', () => {
    assert.equal(normalizeProjectCost(null), null);
    assert.equal(normalizeProjectCost({ success: false, error: 'not found' }), null);
    assert.equal(normalizeProjectCost({ success: true, cost: {} }), null);
    assert.equal(normalizeProjectCost({ success: true, cost: { totalUsd: null } }), null);
  });

  it('treats a negative total as unknown, not as a credit', () => {
    assert.equal(normalizeProjectCost({ cost: { totalUsd: -3 } }), null);
  });

  it('defaults unknown completeness conservatively to false', () => {
    assert.equal(normalizeProjectCost({ cost: { totalUsd: 1 } })?.complete, false);
    assert.equal(normalizeProjectCost({ cost: { totalUsd: 1, complete: false } })?.complete, false);
    assert.equal(normalizeProjectCost({ cost: { totalUsd: 1, complete: true } })?.complete, true);
  });
});

describe('normalizeCodebaseStats', () => {
  it('does not invent zero measurements for fields an older server omitted', () => {
    const stats = normalizeCodebaseStats({
      success: true,
      codeStats: {
        fileCount: 4,
        byExtension: [{ extension: '.ts', files: 4 }],
        largestFiles: [{ path: 'src/index.ts' }],
      },
    });

    assert.equal(stats?.totalBytes, null);
    assert.equal(stats?.totalLines, null);
    assert.equal(stats?.linesCounted, null);
    assert.equal(stats?.byExtension[0]?.bytes, null);
    assert.equal(stats?.largestFiles[0]?.bytes, null);
    assert.equal(stats?.largestFiles[0]?.modifiedAt, null);
  });

  it('preserves every scanner incompleteness reason and completeness flag', () => {
    const stats = normalizeCodebaseStats({
      codeStats: {
        fileCount: 20,
        complete: false,
        incompleteReasons: [
          { code: 'DIRECTORY_LIMIT', count: 1 },
          { code: 'DIRECTORY_ENTRY_LIMIT', count: 3 },
        ],
      },
    });
    assert.equal(stats?.complete, false);
    assert.deepEqual(stats?.incompleteReasons, [
      { code: 'DIRECTORY_LIMIT', count: 1 },
      { code: 'DIRECTORY_ENTRY_LIMIT', count: 3 },
    ]);
  });
});

describe('normalizeProjectStats', () => {
  const payload = {
    success: true,
    stats: {
      totalUsd: 120.5,
      complete: false,
      unpricedModels: ['unlisted-model'],
      assumedModels: ['compatible-model'],
      gaps: [{ harness: 'codex', reason: 'older transcript unavailable' }],
      daily: [
        { day: '2026-07-03', costUsd: 20 },
        { day: '2026-07-01', costUsd: 100.5 },
      ],
      activeDays: 2,
      firstActivity: '2026-07-01T09:00:00Z',
      lastActivity: '2026-07-03T22:00:00Z',
      dataThrough: '2026-07-03',
      projectActivityThrough: '2026-07-06',
      conversations: 42,
      agents: [
        { name: 'claude-opus-5', kind: 'model', invocations: 42 },
        { name: 'researcher', kind: 'subagent', invocations: 7 },
      ],
      byVendor: [
        {
          vendor: 'anthropic',
          displayName: 'Claude',
          totalUsd: 100.5,
          requests: 40,
          complete: true,
          unpriced: false,
          assumed: false,
        },
        {
          vendor: 'openai',
          displayName: 'OpenAI',
          totalUsd: 20,
          requests: 2,
          complete: true,
          unpriced: false,
          assumed: false,
        },
      ],
      byModel: [
        {
          model: 'claude-opus-5',
          costUsd: 100.5,
          requests: 40,
          complete: true,
          unpriced: false,
          assumed: false,
        },
      ],
      pricesAsOf: '2026-07-28',
    },
  };

  it('normalises and sorts the daily series', () => {
    const stats = normalizeProjectStats(payload);
    assert.deepEqual(
      stats?.daily.map((point) => point.day),
      ['2026-07-01', '2026-07-03'],
    );
    assert.equal(stats?.conversations, 42);
    assert.deepEqual(stats?.agents, [
      { name: 'claude-opus-5', kind: 'model', invocations: 42 },
      { name: 'researcher', kind: 'subagent', invocations: 7 },
    ]);
    assert.equal(stats?.complete, false);
    assert.deepEqual(stats?.unpricedModels, ['unlisted-model']);
    assert.deepEqual(stats?.assumedModels, ['compatible-model']);
    assert.deepEqual(stats?.gaps, [{ harness: 'codex', reason: 'older transcript unavailable' }]);
    assert.equal(stats?.byVendor[0]?.label, 'Claude');
    assert.equal(stats?.byVendor[0]?.requests, 40);
    assert.equal(stats?.byVendor[0]?.complete, true);
  });

  it('is null for an absent endpoint or an empty shell', () => {
    assert.equal(normalizeProjectStats(undefined), null);
    assert.equal(normalizeProjectStats({ success: false }), null);
    assert.equal(normalizeProjectStats({ success: true, stats: {} }), null);
  });

  it('keeps missing counters null instead of 0', () => {
    const stats = normalizeProjectStats({ stats: { totalUsd: 5 } });
    assert.equal(stats?.conversations, null);
    assert.equal(stats?.agents, null);
    assert.equal(stats?.activeDays, null);
  });
});

describe('normalizeDaily', () => {
  it('drops malformed rows and rows with no priced amount', () => {
    const points = normalizeDaily([
      { day: '2026-07-01', costUsd: 3 },
      { day: 'yesterday', costUsd: 9 },
      { day: '2026-07-02', costUsd: null },
      { day: '2026-07-03' },
      null,
      { costUsd: 4 },
    ]);
    assert.deepEqual(points, [
      { day: '2026-07-01', costUsd: 3, complete: false, unpriced: false, assumed: false },
    ]);
  });

  it('accepts `date` as the day field', () => {
    assert.deepEqual(normalizeDaily([{ date: '2026-07-04', totalUsd: 2 }]), [
      { day: '2026-07-04', costUsd: 2, complete: false, unpriced: false, assumed: false },
    ]);
  });

  it('defaults absent daily honesty flags conservatively', () => {
    assert.deepEqual(normalizeDaily([{ day: '2026-07-04', costUsd: 2 }]), [
      { day: '2026-07-04', costUsd: 2, complete: false, unpriced: false, assumed: false },
    ]);
  });
});

describe('buildDailyWindow', () => {
  it('keeps a sparse 90-day calendar window and merges duplicate flags honestly', () => {
    const window = buildDailyWindow(
      [
        completeDay('2026-05-01', 99),
        completeDay('2026-08-18', 2),
        { day: '2026-08-18', costUsd: 3, complete: false, unpriced: true, assumed: false },
        { day: '2026-08-19', costUsd: 4, complete: true, unpriced: false, assumed: true },
      ],
      '2026-08-19',
      90,
    );
    assert.equal(window?.startDay, '2026-05-22');
    assert.equal(window?.endDay, '2026-08-19');
    assert.deepEqual(window?.points, [
      { day: '2026-08-18', costUsd: 5, complete: false, unpriced: true, assumed: false },
      { day: '2026-08-19', costUsd: 4, complete: true, unpriced: false, assumed: true },
    ]);
  });

  it('positions sparse bars by calendar distance rather than array index', () => {
    const spark = buildSparkline(
      [completeDay('2026-08-01', 1), completeDay('2026-08-10', 1)],
      { width: 100, rangeStart: '2026-08-01', rangeEnd: '2026-08-10' },
    );
    assert.ok(spark);
    assert.ok(spark.bars[1].x - spark.bars[0].x > 80);
  });
});

describe('normalizeBreakdown', () => {
  it('accepts a map and an array, sorted by amount descending', () => {
    const fromMap = normalizeBreakdown({ openai: 20, anthropic: 80 });
    assert.deepEqual(
      fromMap.map((row) => row.label),
      ['anthropic', 'openai'],
    );
    assert.equal(fromMap[0].share, 0.8);
    assert.equal(fromMap[0].requests, null);

    const fromArray = normalizeBreakdown([
      { model: 'gpt-5', costUsd: 20 },
      { model: 'claude-opus-5', costUsd: 80 },
    ]);
    assert.deepEqual(
      fromArray.map((row) => row.label),
      ['claude-opus-5', 'gpt-5'],
    );
  });

  it('places unpriced rows last with no share, and never as 0 cost', () => {
    const rows = normalizeBreakdown([
      { model: 'unpriced-model', costUsd: null },
      { model: 'claude-opus-5', costUsd: 50 },
    ]);
    assert.deepEqual(
      rows.map((row) => row.label),
      ['claude-opus-5', 'unpriced-model'],
    );
    assert.equal(rows[1].costUsd, null);
    assert.equal(rows[1].share, 0);
    // The priced row owns the whole priced total; the unknown one dilutes nothing.
    assert.equal(rows[0].share, 1);
  });

  it('returns nothing for an unusable shape', () => {
    assert.deepEqual(normalizeBreakdown(undefined), []);
    assert.deepEqual(normalizeBreakdown('anthropic'), []);
  });
});

describe('fillDailyGaps', () => {
  it('preserves partial/estimated qualifications while merging duplicate days', () => {
    const series = fillDailyGaps([
      { day: '2026-07-01', costUsd: 2, complete: true, unpriced: false, assumed: true },
      { day: '2026-07-01', costUsd: 3, complete: false, unpriced: true, assumed: false },
    ]);

    assert.deepEqual(series, [
      { day: '2026-07-01', costUsd: 5, complete: false, unpriced: true, assumed: true },
    ]);
  });

  it('inserts the silent days inside the measured range', () => {
    const series = fillDailyGaps([
      completeDay('2026-07-01', 10),
      completeDay('2026-07-04', 4),
    ]);
    assert.deepEqual(series, [
      completeDay('2026-07-01', 10),
      completeDay('2026-07-02', 0),
      completeDay('2026-07-03', 0),
      completeDay('2026-07-04', 4),
    ]);
  });

  it('sums duplicate days rather than dropping one', () => {
    const series = fillDailyGaps([
      completeDay('2026-07-01', 2),
      completeDay('2026-07-01', 3),
    ]);
    assert.deepEqual(series, [completeDay('2026-07-01', 5)]);
  });

  it('keeps the most recent days when the range is longer than the cap', () => {
    const series = fillDailyGaps(
      [
        completeDay('2026-01-01', 1),
        completeDay('2026-03-01', 2),
      ],
      7,
    );
    assert.equal(series.length, 7);
    assert.equal(series[6].day, '2026-03-01');
  });

  it('is empty for no points', () => {
    assert.deepEqual(fillDailyGaps([]), []);
  });
});

describe('buildSparkline', () => {
  it('scales to the peak and keeps a sliver for tiny non-zero days', () => {
    const spark = buildSparkline(
      [
        completeDay('2026-07-01', 900),
        completeDay('2026-07-02', 0.3),
        completeDay('2026-07-03', 0),
      ],
      { width: 90, height: 100 },
    );
    assert.ok(spark);
    assert.equal(spark.maxUsd, 900);
    assert.equal(spark.bars[0].height, 100);
    assert.ok(spark.bars[1].height > 0, 'a real, tiny spend must stay visible');
    assert.equal(spark.bars[2].height, 0, 'a zero day draws nothing');
    // Bars advance left-to-right in the viewBox; RTL mirrors the SVG as a whole.
    assert.ok(spark.bars[0].x < spark.bars[1].x);
  });

  it('is null for an empty series', () => {
    assert.equal(buildSparkline([]), null);
  });

  it('draws a flat baseline when nothing was priced', () => {
    const spark = buildSparkline([completeDay('2026-07-01', 0)]);
    assert.equal(spark?.maxUsd, 0);
    assert.equal(spark?.bars[0].height, 0);
  });
});

describe('spanInDays / toDay / formatDayLabel', () => {
  it('counts the span inclusively', () => {
    assert.equal(spanInDays('2026-07-01', '2026-07-01'), 1);
    assert.equal(spanInDays('2026-07-01', '2026-07-10'), 10);
  });

  it('crosses a DST boundary without losing a day', () => {
    assert.equal(spanInDays('2026-03-28', '2026-03-30'), 3);
  });

  it('is null for missing or reversed bounds', () => {
    assert.equal(spanInDays(null, '2026-07-01'), null);
    assert.equal(spanInDays('2026-07-10', '2026-07-01'), null);
  });

  it('reduces an activity timestamp to its UTC day', () => {
    assert.equal(toDay('2026-07-03T22:15:00Z'), '2026-07-03');
    assert.equal(toDay('2026-07-03'), '2026-07-03');
    assert.equal(toDay('not a date'), null);
    assert.equal(toDay(null), null);
  });

  it('formats a day without shifting it by timezone', () => {
    assert.equal(formatDayLabel('2026-07-01', 'en-US'), 'Jul 1, 2026');
    assert.equal(formatDayLabel(null, 'en-US'), null);
  });

  it('measures lag only when observed project activity is newer than ledger coverage', () => {
    assert.equal(ledgerLagInDays('2026-07-30', '2026-08-19'), 20);
    assert.equal(ledgerLagInDays('2026-08-19', '2026-08-19'), null);
    assert.equal(ledgerLagInDays(null, '2026-08-19'), null);
  });
});
