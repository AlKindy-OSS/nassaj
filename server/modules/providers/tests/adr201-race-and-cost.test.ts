/**
 * ADR-201 A-P4 — swap races and the cost of a pinned open.
 *
 * Race harness, two layers:
 *   1. deterministic: `openPinned` with a checkpoint that swaps the name at
 *      each step of lstat → open → fstat → /proc name → settle → /proc name →
 *      lstat recheck, for each swap kind (foreign regular file, symlink,
 *      hardlink, unlink);
 *   2. stochastic: a worker thread renames genuine / forged / symlinked /
 *      hardlinked files over the recorded path in a tight loop while the main
 *      thread opens it through `openSessionTranscript` and the history fetch;
 *   3. opt-in stress (NASSAJ_TEST_PINNED_FD_STRESS=1): the B-1614 `(deleted)`
 *      symlink attack in a tight loop, zero admissions required.
 * Invariant in both: a successful open never yields foreign bytes (a link
 * target, another session's header, member /10's file).
 *
 * Cost: p50/p95 over 200 opens of a plain open+read, `openPinned`, and the full
 * `openSessionTranscript` (authorisation, row, roots, pinned open, header
 * scan). The asserted bounds are generous (shared CI hosts); the measured
 * numbers are printed as test diagnostics.
 *
 * Runner: TMPDIR=/var/tmp node scripts/run-isolated-node-tests.mjs server <this file>
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { getConnection, initializeDatabase, participantsDb } from '@/modules/database/index.js';
import { resetHistorySnapshotCacheForTests } from '@/modules/providers/services/session-history-light.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import {
  openPinned, PinnedOpenError, SETTLE_FOR_TESTS, settleDirectory,
} from '@/modules/providers/shared/pinned-fd.js';
import { isTranscriptHandle, openSessionTranscript } from '@/modules/providers/shared/session-transcript.js';

import { claudeTranscript } from './helpers/adr201-real-headers.js';

process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
const PROJECT = '/workspace/adr201-race';
const DIR = path.join(SANDBOX_HOME, '.claude', 'projects', '-workspace-adr201-race');
const MEMBER_DIR = path.join(SANDBOX_HOME, '.nassaj-users', '10', '.claude', 'projects', '-workspace-adr201-race');
const OUTSIDE = path.join(SANDBOX_HOME, 'outside-every-root');
const SID = '00000000-0000-4000-a203-000000000001';
const OTHER = '00000000-0000-4000-a203-000000000002';
const RECORDED = path.join(DIR, `${SID}.jsonl`);
const FOREIGN = /zqforeign/;

await initializeDatabase();
const ownerId = Number(getConnection().prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
  .run('race-owner', 'x').lastInsertRowid);
getConnection().prepare('INSERT INTO sessions (session_id, provider, jsonl_path) VALUES (?, ?, ?)')
  .run(SID, 'claude', RECORDED);
participantsDb.recordSpawn(SID, ownerId);

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const GENUINE_TEXT = claudeTranscript(SID, PROJECT, 'zqgenuine');
/** Every foreign file the swapper or a checkpoint can put at the recorded name. */
const FOREIGN_FILES = {
  forgedHeader: write(path.join(OUTSIDE, 'forged-src.jsonl'), claudeTranscript(OTHER, PROJECT, 'zqforeignheader')),
  memberTree: write(path.join(MEMBER_DIR, `${SID}.jsonl`), claudeTranscript(SID, PROJECT, 'zqforeignmember')),
  outside: write(path.join(OUTSIDE, `${SID}.jsonl`), claudeTranscript(SID, PROJECT, 'zqforeignoutside')),
};
write(RECORDED, GENUINE_TEXT);

async function readAll(handle: fsp.FileHandle): Promise<string> {
  const { size } = await handle.stat();
  const buffer = Buffer.alloc(Number(size));
  await handle.read(buffer, 0, buffer.length, 0);
  return buffer.toString('utf8');
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.warn = original;
  }
}

type SwapKind = 'regular' | 'symlink' | 'hardlink' | 'unlink';

/** Replaces the name `target` atomically (rename over it) with a `kind` object. */
function swapName(target: string, kind: SwapKind): void {
  const staging = `${target}.staging`;
  fs.rmSync(staging, { force: true });
  if (kind === 'unlink') return void fs.rmSync(target, { force: true });
  if (kind === 'regular') fs.writeFileSync(staging, claudeTranscript(OTHER, PROJECT, 'zqforeignregular'));
  if (kind === 'symlink') fs.symlinkSync(FOREIGN_FILES.outside, staging);
  if (kind === 'hardlink') fs.linkSync(FOREIGN_FILES.memberTree, staging);
  fs.renameSync(staging, target);
}

test('race (deterministic): a swap at every step of the pinned open never yields a link target', async () => {
  const dir = fs.mkdtempSync(path.join(SANDBOX_HOME, 'pinned-race-'));
  const target = path.join(dir, 'transcript.jsonl');
  const table: Record<string, string> = {};
  for (const kind of ['regular', 'symlink', 'hardlink', 'unlink'] as const) {
    for (let swapAt = 1; swapAt <= 6; swapAt += 1) {
      fs.rmSync(target, { force: true }); // never write through a link left by the previous case
      write(target, GENUINE_TEXT);
      let step = 0;
      const checkpoint = () => {
        step += 1;
        if (step === swapAt) swapName(target, kind);
      };
      let outcome: string;
      try {
        const pinned = await openPinned(target, 'file', { singleLink: true, checkpoint });
        const text = await readAll(pinned.handle);
        await pinned.handle.close();
        assert.doesNotMatch(text, /zqforeign(member|outside)/, `${kind}@${swapAt}: a link target was read`);
        outcome = /zqgenuine/.test(text) ? 'ok:genuine' : 'ok:replaced';
      } catch (error) {
        assert.ok(error instanceof PinnedOpenError, `${kind}@${swapAt}: ${String(error)}`);
        outcome = error.reason;
      }
      table[`${kind}@${swapAt}`] = outcome;
    }
  }
  // Step 1 = before lstat (a plain replacement: the reader's id check owns it),
  // 2 = between lstat and open (the TOCTOU window), 3 = after open (fstat sees
  // the pinned inode unlinked, nlink 0), 4 = after fstat (/proc names a deleted
  // file), 5 = after the first /proc check (the re-check after the directory
  // settles names a deleted file, B-1609), 6 = after that re-check (the
  // descriptor already holds the genuine inode).
  const row = (kind: string, at1: string, at2: string) => ({
    [`${kind}@1`]: at1, [`${kind}@2`]: at2, [`${kind}@3`]: 'multiply_linked', [`${kind}@4`]: 'changed_during_open',
    [`${kind}@5`]: 'changed_during_open', [`${kind}@6`]: 'ok:genuine',
  });
  assert.deepEqual(table, {
    ...row('regular', 'ok:replaced', 'changed_during_open'),
    ...row('symlink', 'symlink', 'symlink'),
    ...row('hardlink', 'multiply_linked', 'changed_during_open'),
    ...row('unlink', 'missing', 'changed_during_open'),
  });
});

// B-1614: a rename over the name drops the victim's nlink before it unhashes the
// victim's dentry, so fstat (nlink 1) and the /proc name (still `expected`) can
// both land inside that kernel window for member /10's hardlinked file. The gate
// reads nlink, then settles the parent directory (waits out the rename), and
// only then reads the name — here the rename completes at the barrier.
test('race (deterministic): a rename completing at the directory barrier is refused (B-1614)', async () => {
  const dir = fs.mkdtempSync(path.join(SANDBOX_HOME, 'pinned-settle-'));
  const target = write(path.join(dir, 'transcript.jsonl'), GENUINE_TEXT);
  const events: string[] = [];
  const settle = async (directory: string) => {
    events.push(`settle:${directory === dir}`);
    swapName(target, 'regular');
    await settleDirectory(directory);
  };
  await assert.rejects(
    openPinned(target, 'file', {
      singleLink: true, [SETTLE_FOR_TESTS]: settle, checkpoint: () => void events.push('step'),
    } as Parameters<typeof openPinned>[2]),
    (error: unknown) => error instanceof PinnedOpenError && error.reason === 'changed_during_open',
  );
  // lstat, open, fstat (nlink read), first /proc name, barrier; the /proc name
  // read after it reports the victim `(deleted)` and refuses it.
  assert.deepEqual(events, ['step', 'step', 'step', 'step', 'step', 'settle:true']);
  await assert.rejects(settleDirectory(path.join(dir, 'gone')),
    (error: unknown) => error instanceof PinnedOpenError && error.reason === 'changed_during_open');
});

/**
 * B-1614 round 2: `target` is a hardlink of a foreign file (nlink 2) and the
 * attacker owns the parent directory, so it plants `<name> (deleted)` -> `<name>`.
 * A rename over the name between open and fstat drops the victim to nlink 1 and
 * makes the kernel name its descriptor `<target> (deleted)`. Following that
 * text (realpath) resolved the planted link back to `target` and admitted the
 * foreign bytes; reading it (readlink) refuses.
 */
function plantDeletedSuffixAttack(dir: string): { target: string; foreign: string } {
  const foreign = write(path.join(dir, 'foreign-member.jsonl'), claudeTranscript(SID, PROJECT, 'zqforeignmember'));
  const target = path.join(dir, 'transcript.jsonl');
  fs.rmSync(target, { force: true });
  fs.linkSync(foreign, target);
  fs.rmSync(`${target} (deleted)`, { force: true });
  fs.symlinkSync('transcript.jsonl', `${target} (deleted)`);
  return { target, foreign };
}

test('race (deterministic): a planted "<name> (deleted)" symlink never admits the victim (B-1614)', async () => {
  const dir = fs.mkdtempSync(path.join(SANDBOX_HOME, 'pinned-deleted-'));
  const { target } = plantDeletedSuffixAttack(dir);
  let step = 0;
  const checkpoint = () => {
    step += 1;
    if (step === 3) swapName(target, 'regular'); // after open, before fstat
  };
  await assert.rejects(
    openPinned(target, 'file', { singleLink: true, checkpoint }),
    (error: unknown) => error instanceof PinnedOpenError && error.reason === 'changed_during_open',
  );
  assert.equal(step, 4, 'refused at the name read, before the final checkpoint');
});

const STRESS = process.env.NASSAJ_TEST_PINNED_FD_STRESS === '1';
const STRESS_SWAPPER = `
const fs = require('node:fs');
const { workerData, parentPort } = require('node:worker_threads');
const { target, foreign, genuine, flag } = workerData;
const stop = new Int32Array(flag);
const linkStaging = target + '.link';
const fileStaging = target + '.file';
let swaps = 0;
while (Atomics.load(stop, 0) === 0) {
  try {
    // Fresh names each step: never write through a hardlink of the foreign file.
    fs.rmSync(linkStaging, { force: true });
    fs.linkSync(foreign, linkStaging);
    fs.renameSync(linkStaging, target); // the name is the foreign hardlink (nlink 2)
    fs.rmSync(fileStaging, { force: true });
    fs.writeFileSync(fileStaging, genuine);
    fs.renameSync(fileStaging, target); // rename over it: the victim drops to nlink 1
    swaps += 1;
  } catch {}
}
parentPort.postMessage(swaps);
`;

test('race (stress, opt-in): the "(deleted)" symlink attack in a tight loop admits nothing', { skip: !STRESS }, async (t) => {
  const dir = fs.mkdtempSync(path.join(SANDBOX_HOME, 'pinned-stress-'));
  const { target, foreign } = plantDeletedSuffixAttack(dir);
  const flag = new SharedArrayBuffer(4);
  const worker = new Worker(STRESS_SWAPPER, { eval: true, workerData: { target, foreign, genuine: GENUINE_TEXT, flag } });
  const swapped = new Promise<number>((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  const iterations = Number(process.env.NASSAJ_TEST_PINNED_FD_STRESS_ITERATIONS ?? 20_000);
  const counts = new Map<string, number>();
  try {
    for (let index = 0; index < iterations; index += 1) {
      try {
        const pinned = await openPinned(target, 'file', { singleLink: true });
        const text = await readAll(pinned.handle);
        await pinned.handle.close();
        tally(counts, FOREIGN.test(text) ? 'admitted_foreign' : 'ok');
      } catch (error) {
        assert.ok(error instanceof PinnedOpenError, String(error));
        tally(counts, error.reason);
      }
    }
  } finally {
    Atomics.store(new Int32Array(flag), 0, 1);
  }
  const swaps = await swapped;
  await worker.terminate();
  t.diagnostic(`swaps=${swaps} outcomes=${JSON.stringify(Object.fromEntries(counts))}`);
  assert.ok(swaps > 0, 'the swapper ran');
  assert.equal(counts.get('admitted_foreign') ?? 0, 0, 'zero foreign admissions');
});

/**
 * B-1609 fixture: `target` starts as a second name of member /10's file; right
 * after the open, a genuine file is renamed over it, so the descriptor holds the
 * member inode, single-linked again and unlinked from `target`.
 */
function hardlinkThenReplace(dir: string): { target: string; replace: () => void } {
  const target = path.join(dir, 'transcript.jsonl');
  fs.linkSync(FOREIGN_FILES.memberTree, target);
  return {
    target,
    replace: () => {
      write(`${target}.genuine`, GENUINE_TEXT);
      fs.renameSync(`${target}.genuine`, target);
    },
  };
}

async function admittedText(open: Promise<{ handle: fsp.FileHandle }>): Promise<string> {
  try {
    const { handle } = await open;
    try {
      return await readAll(handle);
    } finally {
      await handle.close();
    }
  } catch (error) {
    assert.ok(error instanceof PinnedOpenError, String(error));
    return `refused:${error.reason}`;
  }
}

test('B-1609 (deterministic): a planted "<name> (deleted)" symlink cannot vouch for an unlinked descriptor', async () => {
  const dir = fs.mkdtempSync(path.join(SANDBOX_HOME, 'pinned-deleted-'));
  const { target, replace } = hardlinkThenReplace(dir);
  let step = 0;
  const checkpoint = () => {
    step += 1;
    if (step !== 3) return; // after open, before fstat
    replace();
    // The kernel names the descriptor `<target> (deleted)`; resolving that text by name follows this link.
    fs.symlinkSync(target, `${target} (deleted)`);
  };
  const text = await admittedText(openPinned(target, 'file', { singleLink: true, checkpoint }));
  assert.doesNotMatch(text, FOREIGN, 'member bytes admitted through a planted "(deleted)" name');
  assert.equal(text, 'refused:changed_during_open');
});

test('B-1609 (deterministic): a descriptor named during an in-flight rename is re-checked after the directory settles', async () => {
  // ext4 drops the replaced inode's link count inside rename(2) and moves the
  // dentry only afterwards, both under the directory lock. A reader whose fstat
  // and /proc read fall in between sees nlink 1 AND the live name. The procFdDir
  // seam models that kernel view: the live name until the first /proc check,
  // `(deleted)` once the rename has finished.
  const dir = fs.mkdtempSync(path.join(SANDBOX_HOME, 'pinned-window-'));
  const proc = fs.mkdtempSync(path.join(SANDBOX_HOME, 'fake-proc-'));
  const { target, replace } = hardlinkThenReplace(dir);
  let fdLink = '';
  let step = 0;
  const checkpoint = () => {
    step += 1;
    if (step === 3) replace(); // the in-flight rename has already dropped the member inode to nlink 1
    if (step === 5) { // after the first /proc check: the rename completes and the dentry is gone
      fs.rmSync(fdLink);
      fs.symlinkSync(`${target} (deleted)`, fdLink);
    }
  };
  const track = (handle: fsp.FileHandle) => {
    fdLink = path.join(proc, String(handle.fd));
    fs.symlinkSync(target, fdLink);
  };
  const text = await admittedText(openPinned(target, 'file', { singleLink: true, checkpoint, track, procFdDir: proc }));
  assert.doesNotMatch(text, FOREIGN, 'member bytes admitted inside the rename window');
  assert.equal(text, 'refused:changed_during_open');
});

const SWAPPER = `
const fs = require('node:fs');
const { workerData } = require('node:worker_threads');
const { recorded, genuine, forgedHeader, memberTree, outside, flag } = workerData;
const stop = new Int32Array(flag);
const staging = recorded + '.swap';
let swaps = 0;
while (Atomics.load(stop, 0) === 0) {
  const kind = swaps % 4;
  try {
    fs.rmSync(staging, { force: true });
    if (kind === 0) fs.writeFileSync(staging, genuine);
    else if (kind === 1) fs.copyFileSync(forgedHeader, staging);
    else if (kind === 2) fs.symlinkSync(outside, staging);
    else fs.linkSync(memberTree, staging);
    fs.renameSync(staging, recorded);
    swaps += 1;
  } catch {}
}
fs.rmSync(staging, { force: true });
fs.writeFileSync(staging, genuine);
fs.renameSync(staging, recorded);
require('node:worker_threads').parentPort.postMessage(swaps);
`;

/** Runs `body` while a worker thread keeps swapping the recorded name; returns the swap count. */
async function withSwapper(body: () => Promise<void>): Promise<number> {
  const flag = new SharedArrayBuffer(4);
  const worker = new Worker(SWAPPER, {
    eval: true,
    workerData: { recorded: RECORDED, genuine: GENUINE_TEXT, ...FOREIGN_FILES, flag },
  });
  const swaps = new Promise<number>((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  try {
    await body();
  } finally {
    Atomics.store(new Int32Array(flag), 0, 1);
  }
  const count = await swaps;
  await worker.terminate();
  return count;
}

function tally(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

test('race (concurrent): openSessionTranscript under a swapping name never admits foreign bytes', async (t) => {
  const counts = new Map<string, number>();
  const swaps = await withSwapper(() => quietly(async () => {
    for (let index = 0; index < 2000; index += 1) {
      const opened = await openSessionTranscript(SID, ownerId, 'history');
      if (!isTranscriptHandle(opened)) {
        tally(counts, opened.reason);
        continue;
      }
      const text = await readAll(opened.fd);
      await opened.fd.close();
      assert.doesNotMatch(text, FOREIGN, `iteration ${index}: foreign bytes admitted`);
      assert.match(text, /zqgenuine/);
      tally(counts, 'ok');
    }
  }));
  t.diagnostic(`swaps=${swaps} outcomes=${JSON.stringify(Object.fromEntries(counts))}`);
  assert.equal([...counts.values()].reduce((sum, n) => sum + n, 0), 2000);
  assert.ok(swaps > 0, 'the swapper ran');
});

test('race (concurrent): the history fetch under a swapping name shows only genuine text', async (t) => {
  const counts = new Map<string, number>();
  const swaps = await withSwapper(() => quietly(async () => {
    for (let index = 0; index < 300; index += 1) {
      resetHistorySnapshotCacheForTests();
      try {
        const { messages } = await sessionsService.fetchHistory(SID, ownerId, {});
        const text = JSON.stringify(messages);
        assert.doesNotMatch(text, FOREIGN, `iteration ${index}: foreign history shown`);
        tally(counts, messages.length > 0 ? 'genuine' : 'empty');
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
        tally(counts, `error:${(error as { code?: string }).code ?? 'unknown'}`);
      }
    }
  }));
  t.diagnostic(`swaps=${swaps} outcomes=${JSON.stringify(Object.fromEntries(counts))}`);
  assert.ok(swaps > 0, 'the swapper ran');
});

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function timeEach(runs: number, op: () => Promise<void>): Promise<{ p50: number; p95: number }> {
  for (let warm = 0; warm < 20; warm += 1) await op();
  const samples: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    await op();
    samples.push((performance.now() - start) * 1000);
  }
  return { p50: percentile(samples, 50), p95: percentile(samples, 95) };
}

test('cost: pinned open overhead and full reader open, p50 over 200 opens', async (t) => {
  write(RECORDED, GENUINE_TEXT);
  const head = Buffer.alloc(64 * 1024);
  const plain = await timeEach(200, async () => {
    const handle = await fsp.open(RECORDED, 'r');
    await handle.read(head, 0, head.length, 0);
    await handle.close();
  });
  const pinned = await timeEach(200, async () => {
    const { handle } = await openPinned(RECORDED, 'file', { singleLink: true });
    await handle.read(head, 0, head.length, 0);
    await handle.close();
  });
  const reader = await timeEach(200, async () => {
    const opened = await openSessionTranscript(SID, ownerId, 'history');
    assert.ok(isTranscriptHandle(opened));
    await opened.fd.close();
  });
  const fmt = (name: string, m: { p50: number; p95: number }) => `${name} p50=${m.p50.toFixed(1)}µs p95=${m.p95.toFixed(1)}µs`;
  t.diagnostic([fmt('plain open+read', plain), fmt('openPinned+read', pinned), fmt('openSessionTranscript', reader),
    `pinned overhead p50=${(pinned.p50 - plain.p50).toFixed(1)}µs`].join(' | '));
  assert.ok(pinned.p50 - plain.p50 < 1000, 'the extra lstat+fstat+readlink stays well under 1 ms per open');
  assert.ok(reader.p50 < 20_000, 'a full reader open stays under 20 ms per open');
});
