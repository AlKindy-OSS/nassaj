/**
 * ADR-201 A-P4 — swap races and the cost of a pinned open.
 *
 * Race harness, two layers:
 *   1. deterministic: `openPinned` with a checkpoint that swaps the name at
 *      each step of lstat → open → fstat → /proc realpath, for each swap kind
 *      (foreign regular file, symlink, hardlink, unlink);
 *   2. stochastic: a worker thread renames genuine / forged / symlinked /
 *      hardlinked files over the recorded path in a tight loop while the main
 *      thread opens it through `openSessionTranscript` and the history fetch.
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
import { openPinned, PinnedOpenError } from '@/modules/providers/shared/pinned-fd.js';
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
    for (let swapAt = 1; swapAt <= 5; swapAt += 1) {
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
  // file), 5 = after the /proc check (the descriptor already holds the genuine inode).
  const row = (kind: string, at1: string, at2: string) => ({
    [`${kind}@1`]: at1, [`${kind}@2`]: at2, [`${kind}@3`]: 'multiply_linked', [`${kind}@4`]: 'io_error',
    [`${kind}@5`]: 'ok:genuine',
  });
  assert.deepEqual(table, {
    ...row('regular', 'ok:replaced', 'changed_during_open'),
    ...row('symlink', 'symlink', 'symlink'),
    ...row('hardlink', 'multiply_linked', 'changed_during_open'),
    ...row('unlink', 'missing', 'changed_during_open'),
  });
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
