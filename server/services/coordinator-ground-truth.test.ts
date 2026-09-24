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
  filterOpenTasks,
  renderGroundTruthContext,
  buildGroundTruthContext,
  resolveSessionRepoRoot,
} from './coordinator-ground-truth.js';
import { createGovernanceTestFixture } from './governance-content-test-fixture.js';

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

function governanceArgs(root: string) {
  const publication = createGovernanceTestFixture([{
    projectId: 'test-project', filename: 'project-state.json',
    content: fs.readFileSync(path.join(root, 'docs', 'project-state.json'), 'utf8'), actorIds: [7],
  }]);
  return {
    projectId: 'test-project',
    actorId: 7,
    governanceResolver: publication.resolver,
  };
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
  // `undefined` intentionally selects the production default (`process.env`).
  // Use an explicit nullish test double when proving fail-closed input handling.
  assert.equal(isCoordinatorInjectionEnabled(null as any), false);
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

test('filterOpenTasks: keyword match wins, excludes done', () => {
  const matched = filterOpenTasks({ tasks: SAMPLE_TASKS }, ['terminals']);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].id, 'T-300');
  assert.ok(matched.every((t) => t.status !== 'done'));
});

test('filterOpenTasks: no keyword match falls back to in_progress only', () => {
  const fallback = filterOpenTasks({ tasks: SAMPLE_TASKS }, ['nonexistentkeyword']);
  assert.ok(fallback.length >= 1);
  assert.ok(fallback.every((t) => t.status === 'in_progress'));
});

test('filterOpenTasks: malformed state ⇒ [] (no throw)', () => {
  assert.deepEqual(filterOpenTasks(null, []), []);
  assert.deepEqual(filterOpenTasks({ tasks: 'not-an-array' }, []), []);
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
    ...governanceArgs(repo),
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
  // Non-string repoRoot is treated as "unknown root" (⇒ null, unless the operator
  // override env var is set); a bad string path also yields null. The load-bearing
  // guarantee is: it never throws (fail-safe), and never guesses process.cwd().
  await assert.doesNotReject(async () => {
    await buildGroundTruthContext({ repoRoot: 12345 as any });
  });
  assert.equal(await buildGroundTruthContext({ repoRoot: '/nope/not/a/repo' }), null);
});

// --- T-1810: no silent fallback to the shared server process's cwd ----------
//
// Per-project temp git repos live under /var/tmp (not the default os.tmpdir()
// used by the fixtures above), so this suite is the isolated-project fixture
// with "a board of its own" required by T-1810's test plan. Cleaned up in a
// `finally` in each test.

const VAR_TMP_ROOT = '/var/tmp';

function makeVarTmpRepo(commitSubjects: string[]): string {
  const dir = fs.mkdtempSync(path.join(VAR_TMP_ROOT, 'cgt-t1810-repo-'));
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
 * Run `buildGroundTruthContext` with NO repoRoot in a clean child process whose
 * cwd is a real, commit- and task-bearing project, returning the raw result.
 *
 * A CHILD PROCESS, not an in-process env tweak: the module used to capture
 * NASSAJ_COORDINATOR_REPO_ROOT at import time, so mutating `process.env` here
 * could not have exercised either case honestly. The env var is gone from the
 * code now (B-1250), but the child keeps the test honest about that too — it
 * re-imports the module fresh with the env exactly as the test sets it.
 */
function groundTruthWithNoRepoRoot(cwd: string, env: NodeJS.ProcessEnv): string {
  const script = `
      const { buildGroundTruthContext } = await import(${JSON.stringify(
    path.join(process.cwd(), 'server/services/coordinator-ground-truth.js'),
  )});
      const ctx = await buildGroundTruthContext({ delegationPrompt: 'x' });
      process.stdout.write(JSON.stringify(ctx));
    `;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd, env, encoding: 'utf8',
  }).trim();
}

test('buildGroundTruthContext: unknown session root ⇒ null, no block built', async () => {
  // Server process cwd = a DIFFERENT, real, task-bearing project (the leak
  // scenario) — proves the null result is NOT because there is simply
  // nothing to find at cwd.
  const repo = makeVarTmpRepo(['feat: this must never leak']);
  writeState(repo, SAMPLE_TASKS);
  try {
    const env = { ...process.env };
    delete env.NASSAJ_COORDINATOR_REPO_ROOT;
    assert.equal(groundTruthWithNoRepoRoot(repo, env), 'null',
      'must not silently fall back to process.cwd() of the shared server process');
  } finally {
    rmVarTmp(repo);
  }
});

test('buildGroundTruthContext: NASSAJ_COORDINATOR_REPO_ROOT has no effect (B-1250)', async () => {
  // THE REGRESSION. T-1810 removed the cwd fallback but kept an operator
  // override, and on the live host that override is set to the nassaj-dev root
  // — so a session whose root was unknown still received nassaj-dev's commits
  // and open tasks. Same leak, different door. The override is gone from the
  // code; setting it must now change nothing at all.
  const overrideRepo = makeVarTmpRepo(['feat: override commit, must never be injected']);
  writeState(overrideRepo, [
    { id: 'OVERRIDE-1', status: 'in_progress', title: 'override task, must never be injected' },
  ]);
  const cwdRepo = makeVarTmpRepo(['feat: cwd commit, must never be injected']);
  writeState(cwdRepo, SAMPLE_TASKS);
  try {
    const env = { ...process.env, NASSAJ_COORDINATOR_REPO_ROOT: overrideRepo };
    assert.equal(groundTruthWithNoRepoRoot(cwdRepo, env), 'null',
      'an env override must not stand in for an unknown session root');
  } finally {
    rmVarTmp(overrideRepo);
    rmVarTmp(cwdRepo);
  }
});

test('resolveSessionRepoRoot: only a non-empty session root resolves, and env is never consulted', () => {
  const originalRepoRootEnv = process.env.NASSAJ_COORDINATOR_REPO_ROOT;
  try {
    process.env.NASSAJ_COORDINATOR_REPO_ROOT = '/leaky/override/root';
    assert.equal(resolveSessionRepoRoot('/session/root'), '/session/root');
    assert.equal(resolveSessionRepoRoot('  /session/root  '), '/session/root');
    for (const absent of [undefined, null, '', '   ', 42, {}]) {
      assert.equal(resolveSessionRepoRoot(absent as never), null,
        `${String(absent)} is not a session root, and must not resolve to the env override`);
    }
  } finally {
    if (originalRepoRootEnv === undefined) delete process.env.NASSAJ_COORDINATOR_REPO_ROOT;
    else process.env.NASSAJ_COORDINATOR_REPO_ROOT = originalRepoRootEnv;
  }
});

test('buildGroundTruthContext: session root from another project ⇒ block carries ONLY that project\'s data', async () => {
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
    // Server process cwd = a DIFFERENT project than the delegating session's own root.
    process.chdir(serverCwdRepo);
    delete process.env.NASSAJ_COORDINATOR_REPO_ROOT;
    const ctx = await buildGroundTruthContext({
      delegationPrompt: 'x',
      repoRoot: otherProjectRepo, // the session's own, known, project root
      ...governanceArgs(otherProjectRepo),
    });
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

test('buildGroundTruthContext: nassaj-dev\'s own root behaviour is unchanged when explicitly passed', async () => {
  const repo = makeTempRepo(['feat: standalone terminals', 'fix: something']);
  writeState(repo, SAMPLE_TASKS);
  const ctx = await buildGroundTruthContext({
    delegationPrompt: 'work on terminals', repoRoot: repo, ...governanceArgs(repo),
  });
  assert.ok(ctx);
  const c = ctx as string;
  assert.ok(c.includes('standalone terminals'));
  assert.ok(c.includes('T-300'));
});
