/**
 * B-1599 L6 — the header verdict of a pinned transcript is cached by the
 * descriptor's identity and content clock (dev, ino, birth time, size, mtime,
 * ctime), so an unchanged settled file is not scanned again, while any growth
 * or rewrite is verified again. The cache is bounded (LRU).
 *
 * Runner: TMPDIR=/var/tmp node scripts/run-isolated-node-tests.mjs server <this file>
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
// eslint-disable-next-line import-x/order -- must evaluate before every other import
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

import { HeaderVerdictCache, headerVerdicts } from '@/modules/providers/shared/header-verdict-cache.js';
import {
  isTranscriptHandle, openRecordedTranscript, type SessionTranscriptResult,
} from '@/modules/providers/shared/session-transcript-reader.js';
import { transcriptSpecOf, type TranscriptSpec } from '@/modules/providers/shared/session-transcript-specs.js';
// eslint-disable-next-line boundaries/no-unknown -- shared test fixture helper (same seam as sandbox-home)
import { claudeHeaderLine } from '@/shared/__tests__/provider-root-sandbox.js';

process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
const DIR = path.join(SANDBOX_HOME, '.claude', 'projects', '-workspace-l6');
const RULES = {};
let counter = 0;
const nextId = () => `00000000-0000-4000-a6a6-${String(++counter).padStart(12, '0')}`;

/** The Claude spec with a counted `verify`. */
function countingSpec(): { specOf: () => TranscriptSpec; calls: () => number } {
  const claude = transcriptSpecOf('claude') as TranscriptSpec;
  let calls = 0;
  const spec: TranscriptSpec = { ...claude, verify: (...args) => { calls += 1; return claude.verify(...args); } };
  return { specOf: () => spec, calls: () => calls };
}

async function close(result: SessionTranscriptResult): Promise<string> {
  if (!isTranscriptHandle(result)) return result.reason;
  await result.fd.close();
  return 'ok';
}

function transcript(sessionId: string, headerId = sessionId): string {
  const file = path.join(DIR, `${sessionId}.jsonl`);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file, `${claudeHeaderLine(headerId)}\n`);
  return file;
}

/** Runs with the shared cache's clock moved past the settle margin of every file written so far. */
async function settled(run: () => Promise<void>): Promise<void> {
  headerVerdicts.clear();
  headerVerdicts.clock = () => Date.now() + 60_000;
  try {
    await run();
  } finally {
    headerVerdicts.clock = Date.now;
    headerVerdicts.clear();
  }
}

test('L6: an unchanged settled transcript is bound once; growth and a same-size rewrite re-verify', async () => {
  await settled(async () => {
    const sessionId = nextId();
    const file = transcript(sessionId);
    const row = { session_id: sessionId, provider: 'claude', jsonl_path: file };
    const { specOf, calls } = countingSpec();
    assert.equal(await close(await openRecordedTranscript(row, 'history', specOf)), 'ok');
    assert.equal(await close(await openRecordedTranscript(row, 'history', specOf)), 'ok');
    assert.equal(calls(), 1, 'the second open of an unchanged file is not scanned again');

    fs.appendFileSync(file, '{"type":"user"}\n');
    assert.equal(await close(await openRecordedTranscript(row, 'history', specOf)), 'ok');
    assert.equal(calls(), 2, 'a grown file is verified again');

    await sleep(50); // past one coarse timestamp tick
    const forged = `${claudeHeaderLine(nextId())}\n{"type":"user"}\n`;
    assert.equal(Buffer.byteLength(forged), fs.statSync(file).size, 'same size');
    fs.writeFileSync(file, forged);
    assert.equal(await close(await openRecordedTranscript(row, 'history', specOf)), 'id_mismatch');
    assert.equal(calls(), 3, 'an in-place rewrite of the same size is verified again');
  });
});

test('L6: a refusal is cached like an admission, keyed by the session id', async () => {
  await settled(async () => {
    const sessionId = nextId();
    const file = transcript(sessionId, nextId());
    const { specOf, calls } = countingSpec();
    const row = { session_id: sessionId, provider: 'claude', jsonl_path: file };
    assert.equal(await close(await openRecordedTranscript(row, 'history', specOf)), 'id_mismatch');
    assert.equal(await close(await openRecordedTranscript(row, 'history', specOf)), 'id_mismatch');
    assert.equal(calls(), 1);
  });
});

test('L6: a verdict is never reused across rules (specs)', async () => {
  await settled(async () => {
    const sessionId = nextId();
    const row = { session_id: sessionId, provider: 'claude', jsonl_path: transcript(sessionId) };
    const first = countingSpec();
    const second = countingSpec();
    await close(await openRecordedTranscript(row, 'history', first.specOf));
    await close(await openRecordedTranscript(row, 'history', second.specOf));
    assert.deepEqual([first.calls(), second.calls()], [1, 1]);
  });
});

test('L6: a file changed within the settle margin is never cached', async () => {
  headerVerdicts.clear();
  const sessionId = nextId();
  const row = { session_id: sessionId, provider: 'claude', jsonl_path: transcript(sessionId) };
  const { specOf, calls } = countingSpec();
  await close(await openRecordedTranscript(row, 'history', specOf));
  await close(await openRecordedTranscript(row, 'history', specOf));
  assert.equal(calls(), 2);
  assert.equal(headerVerdicts.size, 0);
});

test('L6: the cache is bounded and evicts the least recently used verdict', async () => {
  const cache = new HeaderVerdictCache(2, () => Date.now() + 60_000);
  const stat = fs.statSync(transcript(nextId()), { bigint: true });
  const subject = (sessionId: string) => ({ rules: RULES, provider: 'claude', sessionId, realpath: '/r', root: '/', stat });
  let calls = 0;
  const verify = async () => { calls += 1; return null; };
  await cache.verify(subject('a'), verify);
  await cache.verify(subject('b'), verify);
  await cache.verify(subject('a'), verify); // a is now the most recent
  await cache.verify(subject('c'), verify); // evicts b
  assert.equal(cache.size, 2);
  assert.equal(calls, 3);
  await cache.verify(subject('a'), verify);
  assert.equal(calls, 3, 'a survived');
  await cache.verify(subject('b'), verify);
  assert.equal(calls, 4, 'b was evicted');
});

test('L6: a verify that throws is not cached', async () => {
  const cache = new HeaderVerdictCache(2, () => Date.now() + 60_000);
  const stat = fs.statSync(transcript(nextId()), { bigint: true });
  const subject = { rules: RULES, provider: 'claude', sessionId: 's', realpath: '/r', root: '/', stat };
  await assert.rejects(cache.verify(subject, async () => { throw new Error('EIO'); }));
  assert.equal(cache.size, 0);
});
