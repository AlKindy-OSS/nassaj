/**
 * ADR-199 P0: the shared progress mapper — status vocabulary, snapshot-index
 * ids, label bounds, item cap and the text-only rule.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boundProgressPlan,
  boundProgressSubagent,
  isExcludedPlanStatus,
  buildProgressPlan,
  buildProgressSubagent,
  normalizePlanStatus,
  PLAN_COUNT_MAX_ENTRIES,
  PLAN_LABEL_MAX_CHARS,
  PLAN_MAX_ITEMS,
  SUBAGENT_LABEL_MAX_CHARS,
  toPlainLabel,
} from './progress-normalize.js';

test('excluded statuses drop items from the snapshot; an all-excluded snapshot is omitted', () => {
  for (const status of ['deleted', 'cancelled', 'Canceled', 'skipped']) assert.equal(isExcludedPlanStatus(status), true);
  assert.equal(isExcludedPlanStatus('blocked'), false);
  const plan = buildProgressPlan('tool', [
    { label: 'kept', status: 'blocked' }, { label: 'gone', status: 'cancelled' }, { label: 'done', status: 'done' },
  ]);
  assert.deepEqual(plan?.items.map((item) => [item.id, item.status]), [['0', 'pending'], ['1', 'completed']]);
  assert.equal(buildProgressPlan('tool', [{ label: 'x', status: 'deleted' }]), null);
});

test('provider ids are kept as item ids; the index is the fallback', () => {
  const plan = buildProgressPlan('tool', [{ id: '7', label: 'a', status: 'pending' }, { label: 'b', status: 'pending' }]);
  assert.deepEqual(plan?.items.map((item) => item.id), ['7', '1']);
});

test('status vocabulary maps provider words onto three states; unknown is pending', () => {
  const cases: Array<[unknown, string]> = [
    ['pending', 'pending'], ['TODO', 'pending'], ['not started', 'pending'],
    ['in_progress', 'in_progress'], ['in-progress', 'in_progress'], ['Running', 'in_progress'],
    ['completed', 'completed'], ['done', 'completed'], ['cancelled', 'pending'],
    ['weird', 'pending'], [undefined, 'pending'], [3, 'pending'], [null, 'pending'],
  ];
  for (const [input, expected] of cases) assert.equal(normalizePlanStatus(input), expected, String(input));
});

test('labels are plain text: non-strings dropped, controls and bidi overrides removed, cut with ellipsis', () => {
  assert.equal(toPlainLabel({ html: '<b>x</b>' }, 10), '');
  assert.equal(toPlainLabel('  a\n\tb‮c\u0000 ', 10), 'a b c');
  const invisible = ['؜', ' ', ' ', '﻿', '⁠', '⁡', '⁢', '⁣', '⁤'];
  for (const ch of invisible) {
    assert.equal(toPlainLabel(`a${ch}b`, 10), 'a b', `U+${ch.codePointAt(0)?.toString(16)}`);
  }
  assert.equal(toPlainLabel('﻿مهمة؜', 10), 'مهمة', 'BOM and Arabic letter mark stripped');
  assert.equal(toPlainLabel('a⁥b', 10), 'a⁥b', 'unassigned U+2065 is outside the class');
  const long = 'ع'.repeat(PLAN_LABEL_MAX_CHARS + 5);
  const cut = toPlainLabel(long, PLAN_LABEL_MAX_CHARS);
  assert.equal(Array.from(cut).length, PLAN_LABEL_MAX_CHARS);
  assert.ok(cut.endsWith('…'));
  assert.equal(toPlainLabel('<script>x</script>', 50), '<script>x</script>', 'kept as inert text, never parsed');
});

test('plan ids are snapshot indexes after dropping unlabeled entries, capped at 50 items', () => {
  const plan = buildProgressPlan('tool', [
    { label: 'first', status: 'completed' }, { label: '   ', status: 'pending' }, { label: 'second', status: 'x' },
  ]);
  assert.deepEqual(plan, { source: 'tool', items: [
    { id: '0', label: 'first', status: 'completed' }, { id: '1', label: 'second', status: 'pending' },
  ], counts: { done: 1, total: 2 } });
  const many = Array.from({ length: PLAN_MAX_ITEMS + 10 }, (_, i) => ({ label: `t${i}`, status: 'pending' }));
  assert.equal(buildProgressPlan('artifact', many)?.items.length, PLAN_MAX_ITEMS);
  assert.equal(buildProgressPlan('tool', []), null);
  assert.equal(buildProgressPlan('tool', [{ label: 5, status: 'done' }]), null);
});

test('subagent records require an id and a known state; parentId defaults to null', () => {
  assert.equal(buildProgressSubagent({ id: '', label: 'x', state: 'started' }), null);
  assert.equal(buildProgressSubagent({ id: 'a', label: 'x', state: 'paused' }), null);
  const record = buildProgressSubagent({ id: 'a', parentId: '', label: 'y'.repeat(300), state: 'running' });
  assert.equal(record?.parentId, null);
  assert.equal(Array.from(record?.label ?? '').length, SUBAGENT_LABEL_MAX_CHARS);
});

test('bound* rebuilds untrusted values with contract keys only', () => {
  const plan = boundProgressPlan({
    source: 'tool', extra: 'leak', items: [{ id: '99', label: 'a', status: 'done', secret: 's' }],
  });
  assert.deepEqual(plan, { source: 'tool', items: [{ id: '99', label: 'a', status: 'completed' }],
    counts: { done: 1, total: 1 } });
  assert.equal(boundProgressPlan({ source: 'html', items: [] }), null);
  assert.equal(boundProgressPlan([]), null);
  assert.deepEqual(boundProgressSubagent({ id: 't', parentId: null, label: 'L', state: 'failed', prompt: 'p' }),
    { id: 't', parentId: null, label: 'L', state: 'failed' });
  assert.equal(boundProgressSubagent('t'), null);
});

test('Addendum A §12: counts cover the full list after exclusions while items stay capped', () => {
  const entries = Array.from({ length: 120 }, (_, i) => ({
    label: `t${i}`,
    status: i % 4 === 0 ? 'completed' : i % 4 === 1 ? 'deleted' : i % 4 === 2 ? 'mystery' : 'in_progress',
  }));
  entries.push({ label: '  ', status: 'completed' }, { label: 'late-skip', status: 'skipped' });
  const plan = buildProgressPlan('tool', entries);
  assert.equal(plan?.items.length, PLAN_MAX_ITEMS);
  // 120 entries: 30 completed, 30 deleted (excluded), 30 unknown (pending), 30 in progress.
  assert.deepEqual(plan?.counts, { done: 30, total: 90 });
  assert.ok(plan?.items.every((item) => item.status !== 'completed' || item.label.startsWith('t')));
});

test('counts scan is bounded; untrusted counts are kept only when consistent with the items', () => {
  const huge = Array.from({ length: PLAN_COUNT_MAX_ENTRIES + 5 }, () => ({ label: 'x', status: 'done' }));
  assert.deepEqual(buildProgressPlan('tool', huge)?.counts, { done: PLAN_COUNT_MAX_ENTRIES, total: PLAN_COUNT_MAX_ENTRIES });
  const items = [{ id: '0', label: 'a', status: 'completed' }, { id: '1', label: 'b', status: 'pending' }];
  assert.deepEqual(boundProgressPlan({ source: 'tool', items, counts: { done: 40, total: 90 } })?.counts,
    { done: 40, total: 90 }, 'a full-list count from the server survives re-bounding');
  for (const counts of [{ done: 3, total: 2 }, { done: -1, total: 5 }, { done: 1, total: 1 }, { done: 1.5, total: 4 },
    { done: '1', total: 4 }, { done: 0, total: PLAN_COUNT_MAX_ENTRIES + 1 }, 'x']) {
    assert.deepEqual(boundProgressPlan({ source: 'tool', items, counts })?.counts, { done: 1, total: 2 }, JSON.stringify(counts));
  }
});
