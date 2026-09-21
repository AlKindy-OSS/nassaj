/**
 * coordinator-session-start.test.ts — T-939 (ADR-064 baseline, path ②).
 *
 * Proves the SessionStart ground-truth builder is:
 *  - correctly source-gated (compact/resume/startup inject; clear/junk do not),
 *  - neutral-fact (never imperative),
 *  - token-bounded,
 *  - and FAIL-SAFE ABSOLUTE (git failure / corrupt JSON / missing file / garbage
 *    args ⇒ no throw, no injection) — a hook error must never break a session start.
 *
 * Runner: node:test via tsx. Uses REAL fixtures — a real temp git repo and a real
 * temp project-state.json — never synthetic in-memory doubles (feedback:
 * synthetic-fixtures-false-confidence). Shares the fixture shape of path ①'s test.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  isRelevantSource,
  renderSessionStartContext,
  buildSessionStartContext,
} from './coordinator-session-start.js';

// --- fixtures ---------------------------------------------------------------

function makeTempRepo(commitSubjects: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'css-repo-'));
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
  { id: 'T-939', status: 'in_progress', title: 'SessionStart ground-truth injection ثانية' },
  { id: 'T-100', status: 'todo', title: 'مهمة معلّقة يجب ألا تظهر عند البدء' },
  { id: 'T-200', status: 'done', title: 'مهمة منجزة يجب ألا تظهر' },
];

// --- source gating ----------------------------------------------------------

test('isRelevantSource: compact/resume/startup relevant, clear/junk not', () => {
  assert.equal(isRelevantSource('compact'), true);
  assert.equal(isRelevantSource('resume'), true);
  assert.equal(isRelevantSource('startup'), true);
  assert.equal(isRelevantSource('clear'), false);
  assert.equal(isRelevantSource('nonsense'), false);
  assert.equal(isRelevantSource(undefined), false);
  assert.equal(isRelevantSource(42 as any), false);
});

// --- rendering: neutral facts, bounded, source-framed -----------------------

test('renderSessionStartContext: neutral wording, no imperative commands', () => {
  for (const source of ['compact', 'resume', 'startup']) {
    const text = renderSessionStartContext(
      ['abc feat: x'],
      [{ id: 'T-1', status: 'in_progress', title: 'y' }],
      source,
    );
    assert.ok(text, `expected text for source=${source}`);
    const t = text as string;
    // Self-labels as fact, not instruction.
    assert.ok(t.includes('لا تعليمات') || t.includes('حقيقة'), `fact-label missing for ${source}`);
    // No imperative command verbs directed at the model.
    for (const imperative of ['يجب عليك', 'نفّذ الآن', 'توقف', 'لا تفوّض', 'افعل']) {
      assert.ok(!t.includes(imperative), `unexpected imperative "${imperative}" for ${source}`);
    }
  }
});

test('renderSessionStartContext: compact/resume carry the anti-replay note; startup lighter', () => {
  const compact = renderSessionStartContext(['c'], [{ id: 'T-1', status: 'in_progress', title: 'y' }], 'compact') as string;
  assert.ok(compact.includes('تكرار ذاتي'));
  const startup = renderSessionStartContext(['c'], [{ id: 'T-1', status: 'in_progress', title: 'y' }], 'startup') as string;
  assert.ok(!startup.includes('تكرار ذاتي'));
  assert.ok(startup.includes('بدء هذه الجلسة'));
});

test('renderSessionStartContext: hard line cap (≤ 40)', () => {
  const commits = Array.from({ length: 100 }, (_, i) => `c${i}`);
  const tasks = Array.from({ length: 100 }, (_, i) => ({ id: `T-${i}`, status: 'in_progress', title: 't' }));
  const text = renderSessionStartContext(commits, tasks, 'resume') as string;
  assert.ok(text.split('\n').length <= 40);
});

test('renderSessionStartContext: empty inputs ⇒ still returns a frame (never throws)', () => {
  const text = renderSessionStartContext([], [], 'compact');
  assert.ok(typeof text === 'string' && (text as string).length > 0);
});

// --- integration: buildSessionStartContext ----------------------------------

test('buildSessionStartContext: compact ⇒ commits + in_progress tasks present', async () => {
  const repo = makeTempRepo(['feat: session start layer', 'fix: earlier work']);
  writeState(repo, SAMPLE_TASKS);
  const ctx = await buildSessionStartContext({ source: 'compact', repoRoot: repo });
  assert.ok(ctx);
  const c = ctx as string;
  assert.ok(c.includes('session start layer'));
  assert.ok(c.includes('T-939')); // in_progress
  assert.ok(!c.includes('T-100')); // todo, not shown at session start
  assert.ok(!c.includes('T-200')); // done, never shown
});

test('buildSessionStartContext: resume ⇒ injects (context-loss moment)', async () => {
  const repo = makeTempRepo(['feat: something']);
  writeState(repo, SAMPLE_TASKS);
  const ctx = await buildSessionStartContext({ source: 'resume', repoRoot: repo });
  assert.ok(ctx);
});

test('buildSessionStartContext: clear ⇒ null (deliberate reset, no injection)', async () => {
  const repo = makeTempRepo(['feat: something']);
  writeState(repo, SAMPLE_TASKS);
  assert.equal(await buildSessionStartContext({ source: 'clear', repoRoot: repo }), null);
});

test('buildSessionStartContext: irrelevant/undefined source ⇒ null', async () => {
  const repo = makeTempRepo(['feat: something']);
  assert.equal(await buildSessionStartContext({ source: undefined as any, repoRoot: repo }), null);
  assert.equal(await buildSessionStartContext({ source: 'bogus', repoRoot: repo }), null);
});

// --- FAIL-SAFE --------------------------------------------------------------

test('buildSessionStartContext: non-git + no state ⇒ null (nothing to inject)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'css-empty-'));
  assert.equal(await buildSessionStartContext({ source: 'compact', repoRoot: dir }), null);
});

test('buildSessionStartContext: corrupt state still yields commits (partial, no throw)', async () => {
  const repo = makeTempRepo(['feat: only commits here']);
  const docs = path.join(repo, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(path.join(docs, 'project-state.json'), 'NOT JSON');
  const ctx = await buildSessionStartContext({ source: 'compact', repoRoot: repo });
  assert.ok(ctx);
  assert.ok((ctx as string).includes('only commits here'));
});

test('buildSessionStartContext: garbage / bad-path args ⇒ resolve without throwing', async () => {
  // Non-string repoRoot is treated as "unknown root" (⇒ null, unless the operator
  // override env var is set); never guesses process.cwd().
  await assert.doesNotReject(async () => {
    await buildSessionStartContext({ source: 'compact', repoRoot: 12345 as any });
  });
  assert.equal(
    await buildSessionStartContext({ source: 'compact', repoRoot: '/nope/not/a/repo' }),
    null,
  );
});

// --- T-1810: no silent fallback to the shared server process's cwd ----------
//
// Per-project temp git repos live under /var/tmp, cleaned up in `finally`.

const VAR_TMP_ROOT = '/var/tmp';

function makeVarTmpRepo(commitSubjects: string[]): string {
  const dir = fs.mkdtempSync(path.join(VAR_TMP_ROOT, 'css-t1810-repo-'));
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

function rmVarTmp(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * `buildSessionStartContext` with NO repoRoot, in a clean child process whose
 * cwd is a real commit- and task-bearing project. Child process for the same
 * reason as in coordinator-ground-truth.test.ts: the module is re-imported with
 * exactly the env the test sets, so "the env var is ignored" is proven rather
 * than assumed from an in-process mutation the module may already have read.
 */
function sessionStartWithNoRepoRoot(cwd: string, env: NodeJS.ProcessEnv): string {
  const script = `
      const { buildSessionStartContext } = await import(${JSON.stringify(
    path.join(process.cwd(), 'server/services/coordinator-session-start.js'),
  )});
      const ctx = await buildSessionStartContext({ source: 'compact' });
      process.stdout.write(JSON.stringify(ctx));
    `;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd, env, encoding: 'utf8',
  }).trim();
}

test('buildSessionStartContext: unknown session root ⇒ null, no block built', async () => {
  const repo = makeVarTmpRepo(['feat: this must never leak']);
  writeState(repo, SAMPLE_TASKS);
  try {
    const env = { ...process.env };
    delete env.NASSAJ_COORDINATOR_REPO_ROOT;
    assert.equal(sessionStartWithNoRepoRoot(repo, env), 'null',
      'must not silently fall back to process.cwd() of the shared server process');
  } finally {
    rmVarTmp(repo);
  }
});

test('buildSessionStartContext: NASSAJ_COORDINATOR_REPO_ROOT has no effect (B-1250)', async () => {
  // The SessionStart half of the same leak: on the live host the override named
  // the nassaj-dev root, so every resume/compact of a session with an unknown
  // root was hydrated with nassaj-dev's commits and tasks. Removed, not merely
  // deprioritised — setting it must change nothing.
  const overrideRepo = makeVarTmpRepo(['feat: override commit, must never be injected']);
  writeState(overrideRepo, [
    { id: 'OVERRIDE-1', status: 'in_progress', title: 'override task, must never be injected' },
  ]);
  const cwdRepo = makeVarTmpRepo(['feat: cwd commit, must never be injected']);
  writeState(cwdRepo, SAMPLE_TASKS);
  try {
    const env = { ...process.env, NASSAJ_COORDINATOR_REPO_ROOT: overrideRepo };
    assert.equal(sessionStartWithNoRepoRoot(cwdRepo, env), 'null',
      'an env override must not stand in for an unknown session root');
  } finally {
    rmVarTmp(overrideRepo);
    rmVarTmp(cwdRepo);
  }
});

test('buildSessionStartContext: session root from another project ⇒ block carries ONLY that project\'s data', async () => {
  const originalCwd = process.cwd();
  const originalRepoRootEnv = process.env.NASSAJ_COORDINATOR_REPO_ROOT;
  const serverCwdRepo = makeVarTmpRepo(['feat: nassaj-dev-only commit, must not appear']);
  writeState(serverCwdRepo, [
    { id: 'NASSAJ-1', status: 'in_progress', title: 'nassaj-dev-only task, must not appear' },
  ]);
  const otherProjectRepo = makeVarTmpRepo(['feat: SampleTwo-only commit']);
  writeState(otherProjectRepo, [
    { id: 'SAMPLETWO-1', status: 'in_progress', title: 'SampleTwo-only task' },
  ]);
  try {
    process.chdir(serverCwdRepo);
    delete process.env.NASSAJ_COORDINATOR_REPO_ROOT;
    const ctx = await buildSessionStartContext({ source: 'compact', repoRoot: otherProjectRepo });
    assert.ok(ctx);
    const c = ctx as string;
    assert.ok(c.includes('SampleTwo-only commit'));
    assert.ok(c.includes('SAMPLETWO-1'));
    assert.ok(!c.includes('nassaj-dev-only'));
    assert.ok(!c.includes('NASSAJ-1'));
  } finally {
    process.chdir(originalCwd);
    if (originalRepoRootEnv === undefined) {
      delete process.env.NASSAJ_COORDINATOR_REPO_ROOT;
    } else {
      process.env.NASSAJ_COORDINATOR_REPO_ROOT = originalRepoRootEnv;
    }
    rmVarTmp(serverCwdRepo);
    rmVarTmp(otherProjectRepo);
  }
});
