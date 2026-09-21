/**
 * project-board-integrity.test.ts — the board cannot hold two things under one id.
 *
 * Why this exists. On 2026-07-28 five id collisions happened in a single day
 * between parallel Claude sessions sharing this working tree. Four merely raced
 * (the second writer picked an id the first had just taken, and noticed). The
 * fifth was worse: a task recorded as T-1036 was OVERWRITTEN by an unrelated task
 * under the same id, and its record vanished — the work survived in git, the
 * account of it did not. An earlier round had already destroyed a B-257 entry the
 * same way.
 *
 * Nothing detected any of it. Each session read the file, computed «the next free
 * id», and wrote — and two sessions doing that seconds apart compute the SAME
 * next id. The window is unavoidable without locking; what is avoidable is the
 * SILENCE afterwards.
 *
 * So this is a detector, not a lock. It runs on the REAL docs/project-state.json
 * inside `npm test`, which every session runs before committing — which is the
 * only reason it binds sessions other than the one that wrote it. A helper script
 * would have protected whoever remembered to call it, i.e. nobody.
 *
 * It deliberately asserts only what is objectively broken (a duplicate id, a
 * missing id, an id that is not a string). Board CONTENT — statuses, phases,
 * wording — is the coordinator's business and is not policed here.
 *
 * Runner: node:test via tsx (`npm run test:server`). Reads the real board, never
 * a synthetic double: a fixture would have passed happily through all five of the
 * collisions this file exists to catch (feedback: synthetic-fixtures-false-confidence).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BOARD = path.join(REPO, 'docs/project-state.json');

/**
 * The board is OPERATOR data, not product code: it records this deployment's own
 * tasks and issues, so it is excluded from the public export. These are integrity
 * checks ON that artifact — with no board there is nothing to check, and failing
 * would report a defect in a checkout that has none. Skip explicitly (never
 * silently pass, and never substitute a synthetic board: a fabricated fixture
 * would assert nothing about the real file these tests exist to guard).
 */
const NO_BOARD = fs.existsSync(BOARD)
  ? undefined
  : `no ${path.relative(REPO, BOARD)} in this checkout (operator artifact, excluded from the public export)`;

type Entry = { id?: unknown; title?: unknown; status?: unknown };

function board(): { issues: Entry[]; tasks: Entry[] } {
  const parsed = JSON.parse(fs.readFileSync(BOARD, 'utf8')) as Record<string, unknown>;
  return {
    issues: Array.isArray(parsed.issues) ? (parsed.issues as Entry[]) : [],
    tasks: Array.isArray(parsed.tasks) ? (parsed.tasks as Entry[]) : [],
  };
}

/** Ids appearing more than once, with the titles now sharing them. */
function duplicates(entries: Entry[]): string[] {
  const seen = new Map<string, string[]>();
  for (const e of entries) {
    if (typeof e.id !== 'string') continue;
    const titles = seen.get(e.id) ?? [];
    titles.push(typeof e.title === 'string' ? e.title.slice(0, 70) : '(untitled)');
    seen.set(e.id, titles);
  }
  return [...seen.entries()]
    .filter(([, titles]) => titles.length > 1)
    .map(([id, titles]) => `${id} → ${titles.length}×: ${titles.join(' | ')}`);
}

test('the board holds no duplicate issue ids', { skip: NO_BOARD }, () => {
  const dupes = duplicates(board().issues);
  assert.deepEqual(
    dupes,
    [],
    `Duplicate B- ids. Two sessions wrote the same id; the later write may have\n`
      + `overwritten the earlier entry's content. Re-record the lost one under a\n`
      + `fresh id (compute it AT WRITE TIME) and keep whichever id is already\n`
      + `referenced from committed code.\n${dupes.join('\n')}`,
  );
});

test('the board holds no duplicate task ids', { skip: NO_BOARD }, () => {
  const dupes = duplicates(board().tasks);
  assert.deepEqual(dupes, [], `Duplicate T- ids.\n${dupes.join('\n')}`);
});

test('an id is never reused across issues and tasks', { skip: NO_BOARD }, () => {
  const { issues, tasks } = board();
  const taskIds = new Set(tasks.map((t) => t.id).filter((i): i is string => typeof i === 'string'));
  const crossed = issues
    .map((i) => i.id)
    .filter((i): i is string => typeof i === 'string' && taskIds.has(i));
  assert.deepEqual(crossed, [], `Ids used on BOTH lists: ${crossed.join(', ')}`);
});

test('every entry carries a well-formed string id', { skip: NO_BOARD }, () => {
  const { issues, tasks } = board();
  const bad = [
    ...issues.map((e, i) => ({ e, where: `issues[${i}]`, want: /^B-\d+$/ })),
    ...tasks.map((e, i) => ({ e, where: `tasks[${i}]`, want: /^T-\d+$/ })),
  ]
    // Historical entries predate the B-/T- convention; only reject a MISSING or
    // non-string id, which is what makes an entry unaddressable and un-deduped.
    .filter(({ e }) => typeof e.id !== 'string' || e.id.length === 0)
    .map(({ where }) => where);

  assert.deepEqual(bad, [], `Entries without a usable id: ${bad.join(', ')}`);
});

test('the board is parseable and non-empty', { skip: NO_BOARD }, () => {
  // Guards the guard: a corrupt or truncated file would otherwise make every
  // assertion above pass over an empty list and prove nothing.
  const { issues, tasks } = board();
  assert.ok(issues.length > 0, 'no issues parsed — board corrupt or shape changed');
  assert.ok(tasks.length > 0, 'no tasks parsed — board corrupt or shape changed');
});
