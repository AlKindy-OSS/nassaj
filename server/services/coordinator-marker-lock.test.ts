/**
 * coordinator-marker-lock.test.ts — T-938 (ADR-064 baseline, path ④).
 *
 * Proves the marker-lock is:
 *  - phrasing-resistant (same taskRef across different wording ⇒ match; different
 *    wording of the SAME subject without a ref ⇒ still match via keyword Jaccard),
 *  - precise (genuinely different work ⇒ no warning; a first dispatch ⇒ no warning),
 *  - commit-gated (warns only when commits landed after the prior dispatch),
 *  - self-rotating, and
 *  - FAIL-SAFE ABSOLUTE (corrupt / unwritable marker file, no git ⇒ no throw, no
 *    warning, delegation proceeds).
 *
 * Runner: node:test via tsx. REAL fixtures — a real temp marker file on disk and a
 * real temp git repo — never synthetic in-memory doubles (feedback:
 * synthetic-fixtures-false-confidence).
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  resolveMarkerPath,
  extractTaskRef,
  fingerprintKeywords,
  computeDelegationKey,
  jaccard,
  keysMatch,
  readCommitLog,
  countLanded,
  renderDuplicateWarning,
  readMarkers,
  writeMarkers,
  rotateMarkers,
  evaluateMarkerLock,
  __test__,
} from './coordinator-marker-lock.js';

// --- fixtures ---------------------------------------------------------------

function tmpMarker(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-'));
  return path.join(dir, 'coordinator-markers.json');
}

function makeTempRepo(commitSubjects: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-repo-'));
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

// The real incident: three RE-WORDED copies of the SAME T-935 restart-button work.
const T935_PENDING = 'أصلح زر إعادة التشغيل عبر pending-command في الواجهة لجلسة nassaj';
const T935_SERVER = 'نفّذ زر إعادة التشغيل من خلال server-actions في الواجهة لجلسة nassaj';
// Same subject, ref dropped entirely (the phrasing-resistance case).
const T935_NO_REF_A = 'إصلاح زر إعادة التشغيل في الواجهة لجلسة nassaj عبر pending-command';
const T935_NO_REF_B = 'معالجة زر إعادة التشغيل في الواجهة لجلسة nassaj من خلال server-actions';

// --- unit: key design -------------------------------------------------------

test('extractTaskRef: finds first T-/B- ref, uppercased; null otherwise', () => {
  assert.equal(extractTaskRef('work on t-935 restart'), 'T-935');
  assert.equal(extractTaskRef('fix B-178 regression'), 'B-178');
  assert.equal(extractTaskRef('no ref here at all'), null);
  assert.equal(extractTaskRef(undefined as any), null);
  assert.equal(extractTaskRef(42 as any), null);
});

test('fingerprintKeywords: strips stop-words / generic verbs, order-independent', () => {
  const a = fingerprintKeywords('Build the restart button session handler');
  assert.ok(a.includes('restart'));
  assert.ok(a.includes('button'));
  assert.ok(a.includes('session'));
  assert.ok(!a.includes('build')); // generic verb stripped
  assert.ok(!a.includes('the')); // stop-word / too short
  // Sorted & order-independent: same words in a different order ⇒ identical set.
  const b = fingerprintKeywords('session button restart handler');
  assert.deepEqual(b.filter((w) => ['restart', 'button', 'session', 'handler'].includes(w)).sort(),
    ['button', 'handler', 'restart', 'session']);
  assert.deepEqual(fingerprintKeywords(undefined as any), []);
  assert.deepEqual(fingerprintKeywords(''), []);
});

test('computeDelegationKey: ref ⇒ task key; no ref ⇒ kw key; snippet bounded', () => {
  const withRef = computeDelegationKey(T935_PENDING + ' T-935');
  assert.equal(withRef.taskRef, 'T-935');
  assert.ok(withRef.key.startsWith('task:T-935'));
  const noRef = computeDelegationKey(T935_NO_REF_A);
  assert.equal(noRef.taskRef, null);
  assert.ok(noRef.key.startsWith('kw:'));
  assert.ok(noRef.keywords.length > 0);
  assert.ok(noRef.snippet.length <= 120);
});

test('jaccard: overlap ratio, empty-safe', () => {
  assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccard(['a', 'b', 'c', 'd'], ['a', 'b']), 0.5);
  assert.equal(jaccard([], ['a']), 0);
  assert.equal(jaccard(['a'], []), 0);
});

// --- unit: matching ---------------------------------------------------------

test('keysMatch: same taskRef, DIFFERENT wording ⇒ match (pending vs server)', () => {
  const a = computeDelegationKey(T935_PENDING + ' T-935');
  const b = computeDelegationKey(T935_SERVER + ' T-935');
  assert.ok(keysMatch(a, b), 'same T-935, re-worded, must match');
});

test('keysMatch: no ref, same SUBJECT re-worded ⇒ match via keyword Jaccard', () => {
  const a = computeDelegationKey(T935_NO_REF_A);
  const b = computeDelegationKey(T935_NO_REF_B);
  // Sanity: both really lack a ref and share the subject bag above threshold.
  assert.equal(a.taskRef, null);
  assert.equal(b.taskRef, null);
  assert.ok(jaccard(a.keywords, b.keywords) >= __test__.JACCARD_THRESHOLD);
  assert.ok(keysMatch(a, b), 'same subject, different label, no ref ⇒ must match');
});

test('keysMatch: DIFFERENT explicit refs ⇒ never match, even with keyword overlap', () => {
  const a = computeDelegationKey('أصلح زر إعادة التشغيل في الواجهة T-935');
  const b = computeDelegationKey('أصلح زر إعادة التشغيل في الواجهة T-999');
  assert.ok(!keysMatch(a, b), 'different refs are different work');
});

test('keysMatch: genuinely unrelated delegations ⇒ no match (no false positive)', () => {
  const a = computeDelegationKey('أضف ترقيم صفحات لقائمة المشاريع pagination');
  const b = computeDelegationKey('أصلح زر إعادة التشغيل في الواجهة لجلسة nassaj');
  assert.ok(!keysMatch(a, b));
});

// --- unit: commit accounting ------------------------------------------------

test('countLanded: counts newer-than-marker commits; unknown when off-window', () => {
  const log = ['h5', 'h4', 'h3', 'h2', 'h1']; // newest first
  assert.deepEqual(countLanded(log, 'h3'), { count: 2, hashes: ['h5', 'h4'] });
  assert.deepEqual(countLanded(log, 'h5'), { count: 0, hashes: [] }); // HEAD == marker
  assert.deepEqual(countLanded(log, 'gone'), { count: -1, hashes: [] });
  assert.deepEqual(countLanded([], 'h1'), { count: 0, hashes: [] });
});

test('readCommitLog: reads a real repo (newest first), non-git ⇒ []', async () => {
  const repo = makeTempRepo(['feat: a', 'feat: b', 'feat: c']);
  const log = await readCommitLog(repo);
  assert.equal(log.length, 3);
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-nogit-'));
  assert.deepEqual(await readCommitLog(nonGit), []);
});

// --- unit: rendering (neutral facts) ----------------------------------------

test('renderDuplicateWarning: neutral, includes key/snippet/landed count', () => {
  const text = renderDuplicateWarning({
    marker: { taskRef: 'T-935', keywords: [], snippet: 'restart button', ts: 0 },
    now: 5 * 60 * 1000,
    landed: { count: 2, hashes: ['abc123', 'def456'] },
  });
  assert.ok(text);
  const t = text as string;
  assert.ok(t.includes('T-935'));
  assert.ok(t.includes('restart button'));
  assert.ok(t.includes('2 commit'));
  assert.ok(t.includes('abc123'));
  assert.ok(t.includes('replay'));
  // Neutral: no imperative order to stop / not delegate.
  for (const imperative of ['يجب عليك', 'توقف', 'لا تفوّض', 'ممنوع']) {
    assert.ok(!t.includes(imperative), `unexpected imperative: ${imperative}`);
  }
});

// --- unit: store + rotation -------------------------------------------------

test('read/writeMarkers round-trips; corrupt ⇒ [] (no throw)', async () => {
  const p = tmpMarker();
  assert.deepEqual(await readMarkers(p), []); // missing file
  await writeMarkers(p, [{ key: 'task:T-1', ts: 1 }]);
  const back = await readMarkers(p);
  assert.equal(back.length, 1);
  fs.writeFileSync(p, '{ not json');
  assert.deepEqual(await readMarkers(p), []); // corrupt
});

test('rotateMarkers: drops stale (>14d) and caps to MAX_MARKERS', () => {
  const now = 1_000_000_000_000;
  const stale = { key: 'k-old', ts: now - (__test__.MAX_AGE_MS + 1) };
  const fresh = Array.from({ length: __test__.MAX_MARKERS + 50 }, (_, i) => ({
    key: `k-${i}`, ts: now - i * 1000,
  }));
  const out = rotateMarkers([stale, ...fresh], now);
  assert.ok(out.length <= __test__.MAX_MARKERS);
  assert.ok(!out.some((m: any) => m.key === 'k-old'), 'stale marker dropped');
});

// --- integration: evaluateMarkerLock (real marker file + injected commit log) --

test('evaluate: first dispatch ⇒ no warning, records marker', async () => {
  const p = tmpMarker();
  const res = await evaluateMarkerLock({
    delegationPrompt: T935_PENDING + ' T-935',
    markerPath: p,
    commitLog: ['c1'],
    now: 1000,
  });
  assert.equal(res.warning, null);
  const markers = await readMarkers(p);
  assert.equal(markers.length, 1);
  assert.equal((markers[0] as any).taskRef, 'T-935');
  assert.equal((markers[0] as any).lastCommitAtDispatch, 'c1');
});

test('evaluate: same T-935 re-worded AFTER a commit landed ⇒ WARN', async () => {
  const p = tmpMarker();
  // First dispatch at commit c1.
  await evaluateMarkerLock({
    delegationPrompt: T935_PENDING + ' T-935', markerPath: p, commitLog: ['c1'], now: 1000,
  });
  // A commit lands (c2 now HEAD); the SAME task re-dispatched with different wording.
  const res = await evaluateMarkerLock({
    delegationPrompt: T935_SERVER + ' T-935',
    markerPath: p,
    commitLog: ['c2', 'c1'],
    now: 1000 + 6 * 60 * 1000,
  });
  assert.ok(res.warning, 'must warn: same task, commit advanced');
  assert.ok((res.warning as string).includes('T-935'));
  assert.ok((res.warning as string).includes('1 commit'));
  assert.ok((res.warning as string).includes('c2'));
});

test('evaluate: same subject, NO ref, re-worded, commit landed ⇒ WARN (phrasing-resistant)', async () => {
  const p = tmpMarker();
  await evaluateMarkerLock({
    delegationPrompt: T935_NO_REF_A, markerPath: p, commitLog: ['c1'], now: 1000,
  });
  const res = await evaluateMarkerLock({
    delegationPrompt: T935_NO_REF_B, markerPath: p, commitLog: ['c2', 'c1'], now: 2000,
  });
  assert.ok(res.warning, 'keyword-fingerprint match must warn across re-wording');
});

test('evaluate: same task but NO commit landed ⇒ no warning (still same HEAD)', async () => {
  const p = tmpMarker();
  await evaluateMarkerLock({
    delegationPrompt: T935_PENDING + ' T-935', markerPath: p, commitLog: ['c1'], now: 1000,
  });
  const res = await evaluateMarkerLock({
    delegationPrompt: T935_SERVER + ' T-935', markerPath: p, commitLog: ['c1'], now: 2000,
  });
  assert.equal(res.warning, null, 'no commit advanced ⇒ not a replay signal');
});

test('evaluate: genuinely different delegation ⇒ no warning (no false positive)', async () => {
  const p = tmpMarker();
  await evaluateMarkerLock({
    delegationPrompt: 'أصلح زر إعادة التشغيل في الواجهة لجلسة nassaj T-935',
    markerPath: p, commitLog: ['c1'], now: 1000,
  });
  const res = await evaluateMarkerLock({
    delegationPrompt: 'أضف ترقيم صفحات pagination لقائمة المشاريع T-500',
    markerPath: p, commitLog: ['c2', 'c1'], now: 2000,
  });
  assert.equal(res.warning, null);
});

test('evaluate: no git (empty commit log) ⇒ silent by construction, still records', async () => {
  const p = tmpMarker();
  await evaluateMarkerLock({
    delegationPrompt: T935_PENDING + ' T-935', markerPath: p, commitLog: ['c1'], now: 1000,
  });
  const res = await evaluateMarkerLock({
    delegationPrompt: T935_SERVER + ' T-935', markerPath: p, commitLog: [], now: 2000,
  });
  assert.equal(res.warning, null, 'no currentCommit ⇒ cannot confirm replay ⇒ no warn');
});

// --- integration: end-to-end against a REAL git repo ------------------------

test('evaluate: real repo, commit landed between dispatches ⇒ WARN', async () => {
  const repo = makeTempRepo(['feat: initial T-935 restart button work']);
  const p = tmpMarker();
  // First dispatch anchored at real HEAD.
  await evaluateMarkerLock({
    delegationPrompt: 'أصلح زر إعادة التشغيل T-935', markerPath: p, repoRoot: repo, now: 1000,
  });
  // A real commit lands.
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'chore: land work'], { stdio: 'pipe' });
  const res = await evaluateMarkerLock({
    delegationPrompt: 'نفّذ زر إعادة التشغيل T-935', markerPath: p, repoRoot: repo, now: 2000,
  });
  assert.ok(res.warning, 'real repo: commit advanced ⇒ warn');
  assert.ok((res.warning as string).includes('T-935'));
});

// --- fail-safe (load-bearing) ----------------------------------------------

test('evaluate: unwritable marker path ⇒ no throw, no warning (fail-safe)', async () => {
  // A path whose parent is a FILE, so mkdir/write must fail.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cml-ro-'));
  const asFile = path.join(dir, 'afile');
  fs.writeFileSync(asFile, 'x');
  const badPath = path.join(asFile, 'markers.json'); // parent is a file
  await assert.doesNotReject(async () => {
    const res = await evaluateMarkerLock({
      delegationPrompt: 'x T-1', markerPath: badPath, commitLog: ['c1'], now: 1,
    });
    assert.equal(res.warning, null);
  });
});

test('evaluate: corrupt existing marker file ⇒ no throw, treated as empty', async () => {
  const p = tmpMarker();
  fs.writeFileSync(p, 'NOT JSON AT ALL');
  const res = await evaluateMarkerLock({
    delegationPrompt: 'x T-1', markerPath: p, commitLog: ['c1'], now: 1,
  });
  assert.equal(res.warning, null); // no prior markers to match
  // And it recovered the file by overwriting with a valid array.
  assert.ok(Array.isArray(await readMarkers(p)));
});

test('evaluate: garbage args ⇒ resolves without throwing', async () => {
  await assert.doesNotReject(async () => {
    await evaluateMarkerLock({ delegationPrompt: 42 as any, markerPath: tmpMarker(), commitLog: 'x' as any });
  });
});

test('resolveMarkerPath: derives from DATABASE_PATH, else default; never throws', () => {
  assert.equal(
    resolveMarkerPath({ DATABASE_PATH: '/data/app/db.sqlite' } as any),
    path.join('/data/app', 'coordinator-markers.json'),
  );
  const def = resolveMarkerPath({} as any);
  assert.ok(def.endsWith(path.join('nassaj-dev', 'coordinator-markers.json')));
});
