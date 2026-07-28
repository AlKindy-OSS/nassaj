/**
 * coordinator-ground-truth.test.ts — T-937 (ADR-064 baseline, path ①).
 *
 * Proves the ground-truth injection builder is:
 *  - correctly gated (NASSAJ_COORDINATOR discrimination),
 *  - neutral-fact (never imperative),
 *  - token-bounded,
 *  - and FAIL-SAFE ABSOLUTE (git failure / corrupt JSON / missing file ⇒ no throw,
 *    no injection) — a hook error must never break a delegation.
 *
 * Runner: node:test via tsx. Uses REAL fixtures — a real temp git repo and a real
 * temp project-state.json — never synthetic in-memory doubles (feedback:
 * synthetic-fixtures-false-confidence).
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  isCoordinatorInjectionEnabled,
  extractKeywords,
  readRecentCommits,
  readOpenTasks,
  renderGroundTruthContext,
  buildGroundTruthContext,
} from './coordinator-ground-truth.js';

// --- fixtures ---------------------------------------------------------------

function makeTempRepo(commitSubjects: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgt-repo-'));
  const run = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  run(['init', '-q']);
  run(['config', 'user.email', 'test@nassaj.local']);
  run(['config', 'user.name', 'test']);
  run(['config', 'commit.gpgsign', 'false']);
  for (let i = 0; i < commitSubjects.length; i += 1) {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), String(i));
    run(['add', `f${i}.txt`]);
    run(['commit', '-q', '-m', commitSubjects[i]]);
  }
  return dir;
}

function writeState(dir: string, tasks: unknown): string {
  const docs = path.join(dir, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  const p = path.join(docs, 'project-state.json');
  fs.writeFileSync(p, JSON.stringify({ tasks }, null, 2));
  return p;
}

const SAMPLE_TASKS = [
  { id: 'T-937', status: 'in_progress', title: 'حقن ground-truth عند تفويض المنسّق لمنع التكرار الذاتي' },
  { id: 'T-100', status: 'todo', title: 'شيء آخر لا صلة له بالطرفيات' },
  { id: 'T-200', status: 'done', title: 'مهمة منجزة يجب ألا تظهر' },
  { id: 'T-300', status: 'in_progress', title: 'ميزة الطرفيات المستقلة terminals' },
];

// --- discrimination ---------------------------------------------------------

test('isCoordinatorInjectionEnabled: only "1" enables', () => {
  assert.equal(isCoordinatorInjectionEnabled({ NASSAJ_COORDINATOR: '1' } as any), true);
  assert.equal(isCoordinatorInjectionEnabled({ NASSAJ_COORDINATOR: '0' } as any), false);
  assert.equal(isCoordinatorInjectionEnabled({ NASSAJ_COORDINATOR: 'true' } as any), false);
  assert.equal(isCoordinatorInjectionEnabled({} as any), false);
  assert.equal(isCoordinatorInjectionEnabled(undefined as any), false);
});

// --- keyword extraction -----------------------------------------------------

test('extractKeywords: drops short tokens, de-dupes, handles junk safely', () => {
  const kw = extractKeywords('Build the terminals terminals API for T-937');
  assert.ok(kw.includes('terminals'));
  assert.ok(kw.includes('build'));
  assert.ok(!kw.includes('the')); // < 4 chars
  assert.equal(kw.filter((k) => k === 'terminals').length, 1); // de-dup
  assert.deepEqual(extractKeywords(undefined), []);
  assert.deepEqual(extractKeywords(42 as any), []);
  assert.deepEqual(extractKeywords(''), []);
});

// --- task reading -----------------------------------------------------------

test('readOpenTasks: keyword match wins, excludes done', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgt-state-'));
  const p = writeState(dir, SAMPLE_TASKS);
  const matched = await readOpenTasks(p, ['terminals']);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].id, 'T-300');
  assert.ok(matched.every((t) => t.status !== 'done'));
});

test('readOpenTasks: no keyword match falls back to in_progress only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgt-state-'));
  const p = writeState(dir, SAMPLE_TASKS);
  const fallback = await readOpenTasks(p, ['nonexistentkeyword']);
  assert.ok(fallback.length >= 1);
  assert.ok(fallback.every((t) => t.status === 'in_progress'));
});

test('readOpenTasks: missing file / corrupt JSON ⇒ [] (no throw)', async () => {
  assert.deepEqual(await readOpenTasks('/nope/does/not/exist.json', []), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgt-bad-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{ this is not json ');
  assert.deepEqual(await readOpenTasks(bad, []), []);
});

// --- git reading ------------------------------------------------------------

test('readRecentCommits: reads real repo, caps at 12', async () => {
  const subjects = Array.from({ length: 15 }, (_, i) => `feat: commit number ${i}`);
  const repo = makeTempRepo(subjects);
  const commits = await readRecentCommits(repo);
  assert.equal(commits.length, 12);
  assert.ok(commits[0].includes('commit number 14')); // newest first
});

test('readRecentCommits: non-git dir ⇒ [] (fail-safe, no throw)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgt-nogit-'));
  assert.deepEqual(await readRecentCommits(dir), []);
});

// --- rendering: neutral facts, bounded --------------------------------------

test('renderGroundTruthContext: neutral wording, no imperative commands', () => {
  const text = renderGroundTruthContext(['abc feat: x'], [{ id: 'T-1', status: 'in_progress', title: 'y' }]);
  assert.ok(text);
  const t = text as string;
  // Self-labels as fact, not instruction.
  assert.ok(t.includes('لا تعليمات') || t.includes('حقيقة'));
  // No imperative command verbs directed at the model.
  for (const imperative of ['يجب عليك', 'نفّذ الآن', 'توقف', 'لا تفوّض', 'افعل']) {
    assert.ok(!t.includes(imperative), `unexpected imperative: ${imperative}`);
  }
});

test('renderGroundTruthContext: hard line cap (≤ 40)', () => {
  const commits = Array.from({ length: 100 }, (_, i) => `c${i}`);
  const tasks = Array.from({ length: 100 }, (_, i) => ({ id: `T-${i}`, status: 'in_progress', title: 't' }));
  const text = renderGroundTruthContext(commits, tasks) as string;
  assert.ok(text.split('\n').length <= 40);
});

test('renderGroundTruthContext: empty inputs ⇒ still returns header note (never throws)', () => {
  const text = renderGroundTruthContext([], []);
  assert.ok(typeof text === 'string' && (text as string).length > 0);
});

// --- integration: buildGroundTruthContext -----------------------------------

test('buildGroundTruthContext: real repo + state ⇒ facts present', async () => {
  const repo = makeTempRepo(['feat: standalone terminals', 'fix: something']);
  writeState(repo, SAMPLE_TASKS);
  const ctx = await buildGroundTruthContext({
    delegationPrompt: 'work on terminals',
    repoRoot: repo,
  });
  assert.ok(ctx);
  const c = ctx as string;
  assert.ok(c.includes('standalone terminals'));
  assert.ok(c.includes('T-300')); // keyword-matched open task
});

test('buildGroundTruthContext: non-git + no state ⇒ null (nothing to inject)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgt-empty-'));
  const ctx = await buildGroundTruthContext({ delegationPrompt: 'x', repoRoot: dir });
  assert.equal(ctx, null);
});

test('buildGroundTruthContext: corrupt state still yields commits (partial, no throw)', async () => {
  const repo = makeTempRepo(['feat: only commits here']);
  const docs = path.join(repo, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, 'project-state.json'), 'NOT JSON');
  const ctx = await buildGroundTruthContext({ delegationPrompt: 'x', repoRoot: repo });
  assert.ok(ctx);
  assert.ok((ctx as string).includes('only commits here'));
});

test('buildGroundTruthContext: garbage / bad-path args ⇒ resolve without throwing', async () => {
  // Non-string repoRoot falls back to the module default; a bad string path yields
  // null. The load-bearing guarantee is: it never throws (fail-safe).
  await assert.doesNotReject(async () => {
    await buildGroundTruthContext({ repoRoot: 12345 as any });
  });
  assert.equal(await buildGroundTruthContext({ repoRoot: '/nope/not/a/repo' }), null);
});
