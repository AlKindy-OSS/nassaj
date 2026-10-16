/**
 * T-2038: idempotent vendor transcript appends keep a per-file eventId index
 * instead of re-reading the whole JSONL on every append. These tests pin the
 * cost (one seed scan per file per process) and the unchanged semantics:
 * duplicates rejected (also after a restart), torn-tail repair, reseed on a
 * replaced/shrunk/rewritten file, foreign growth, and LRU eviction.
 *
 * Fixture lines mirror real ~/.nassaj-vendor-sessions shapes: a `meta` header,
 * legacy hermes `message` lines without an eventId, and qwen/kimi turn lines
 * carrying `eventId` + `message.id` (+ `nassajReceipt` on user turns).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

type TranscriptModule = typeof import('./vendor-transcript.js');

const PROJECT = '/home/user/Project/fixture-project';
let restartCounter = 0;

/** A fresh module instance = a restarted process (empty in-memory index). */
async function freshModule(): Promise<TranscriptModule> {
  restartCounter += 1;
  return import(`./vendor-transcript.js?restart=${restartCounter}`) as Promise<TranscriptModule>;
}

function realShapedFixture(sessionId: string): string {
  const lines: unknown[] = [
    { type: 'meta', projectPath: PROJECT, sessionName: 'بالنسبة لمشاركة الملفات والمستندات' },
    { type: 'message', message: { role: 'user', content: 'سؤال قديم بلا معرّف حدث' } },
    { type: 'message', message: { role: 'assistant', content: 'legacy hermes answer' } },
  ];
  for (let i = 0; i < 40; i += 1) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const user = i % 2 === 0;
    lines.push({
      type: 'message', timestamp: '2026-09-16T09:36:39.449Z',
      message: user
        ? { id, role: 'user', content: `رسالة ${i}`, nassajReceipt: {
          version: 1, provider: 'qwen', sessionId, userId: 1,
          clientMsgId: `cmid_${id}`, textOnly: true } }
        : { id, role: 'assistant', content: `جواب ${i}`, isFinalAnswer: false },
      eventId: id,
    });
  }
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

interface ReadSpy { streams: Array<{ file: string; start: number }>; streamBytes: number; handleBytes: number; readFiles: number }

/** Counts every transcript byte the module reads, by API. */
function spyReads(t: TestContext, transcriptDir: string): ReadSpy {
  const spy: ReadSpy = { streams: [], streamBytes: 0, handleBytes: 0, readFiles: 0 };
  const inTranscripts = (file: unknown): boolean => String(file).startsWith(transcriptDir)
    && String(file).endsWith('.jsonl');
  const createReadStream = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
    const stream = createReadStream(...args);
    if (inTranscripts(args[0])) {
      const options = args[1] as { start?: number } | undefined;
      spy.streams.push({ file: String(args[0]), start: options?.start ?? 0 });
      stream.on('data', (chunk) => { spy.streamBytes += chunk.length; });
    }
    return stream;
  });
  const readFile = fsp.readFile;
  t.mock.method(fsp, 'readFile', (...args: Parameters<typeof fsp.readFile>) => {
    if (inTranscripts(args[0])) spy.readFiles += 1;
    return readFile(...args);
  });
  const open = fsp.open;
  t.mock.method(fsp, 'open', async (...args: Parameters<typeof fsp.open>) => {
    const handle = await open(...args);
    if (!inTranscripts(args[0])) return handle;
    const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<{ bytesRead: number }>;
    Object.assign(handle, { read: async (...readArgs: unknown[]) => {
      const result = await read(...readArgs);
      spy.handleBytes += result.bytesRead;
      return result;
    } });
    return handle;
  });
  return spy;
}

async function withHome(t: TestContext): Promise<string> {
  const home = await fsp.mkdtemp(path.join('/var/tmp', 'vendor-transcript-index-'));
  t.mock.method(os, 'homedir', () => home);
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  return home;
}

async function seedFile(mod: TranscriptModule, sessionId: string, content: string): Promise<string> {
  const file = mod.vendorTranscriptPath('qwen', sessionId, PROJECT);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
  return file;
}

async function eventIdsOf(file: string): Promise<string[]> {
  return (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean)
    .map((line) => (JSON.parse(line) as { eventId?: string }).eventId)
    .filter((id): id is string => typeof id === 'string');
}

test('10,000 appends read the whole file once (the seed scan) and nothing per append', async (t) => {
  const home = await withHome(t);
  const mod = await freshModule();
  const fixture = realShapedFixture('bulk');
  const file = await seedFile(mod, 'bulk', fixture);
  const spy = spyReads(t, home);
  const appends = 10_000;
  const started = performance.now();
  for (let i = 0; i < appends; i += 1) {
    if (i % 2 === 0) {
      await mod.appendVendorTranscriptTurnIdempotent('qwen', 'bulk', PROJECT, 'assistant', `جواب ${i}`, `bulk-${i}`);
    } else {
      await mod.appendVendorTranscriptEventIdempotent('qwen', 'bulk', PROJECT,
        { type: 'message', timestamp: '2026-09-16T09:51:06.344Z', message: { id: `bulk-${i}`, role: 'user', content: `س ${i}` } },
        `bulk-${i}`);
    }
  }
  const elapsedMs = performance.now() - started;
  // Retrying an already-committed id is still rejected.
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'bulk', PROJECT, 'assistant', 'retry', 'bulk-0');

  assert.equal(spy.readFiles, 0, 'no readFile of the transcript');
  assert.deepEqual(spy.streams, [{ file, start: 0 }], 'exactly one streaming scan: the seed');
  assert.equal(spy.streamBytes, Buffer.byteLength(fixture), 'the seed reads the pre-existing file once');
  assert.ok(spy.handleBytes <= appends + 1, `positional reads stay at ~1 byte/append (${spy.handleBytes})`);
  const ids = await eventIdsOf(file);
  assert.equal(ids.length, 40 + appends);
  assert.equal(new Set(ids).size, ids.length, 'every eventId committed once');
  t.diagnostic(`10,000 indexed appends: ${Math.round(elapsedMs)} ms`);
});

test('a duplicate eventId is rejected after a simulated process restart', async (t) => {
  const home = await withHome(t);
  const first = await freshModule();
  const file = await seedFile(first, 'restart', realShapedFixture('restart'));
  await first.appendVendorTranscriptTurnIdempotent('qwen', 'restart', PROJECT, 'assistant', 'once', 'evt-restart');
  const second = await freshModule();
  assert.notEqual(second, first, 'a distinct module instance with its own empty index');
  const spy = spyReads(t, home);
  await second.appendVendorTranscriptTurnIdempotent('qwen', 'restart', PROJECT, 'assistant', 'twice', 'evt-restart');
  await second.appendVendorTranscriptTurnIdempotent('qwen', 'restart', PROJECT, 'assistant', 'old', '00000000-0000-4000-8000-000000000003');
  const ids = await eventIdsOf(file);
  assert.equal(ids.filter((id) => id === 'evt-restart').length, 1);
  assert.equal(ids.length, 41);
  assert.deepEqual(spy.streams, [{ file, start: 0 }], 'the restarted process reseeds from disk once');
});

test('an unterminated suffix is still truncated before the append', async (t) => {
  const home = await withHome(t);
  const mod = await freshModule();
  const fixture = realShapedFixture('torn');
  const file = await seedFile(mod, 'torn', `${fixture}{"type":"message","eventId":"torn-1","message":{"ro`);
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'torn', PROJECT, 'user', 'after crash', 'torn-1');
  const afterFirst = await fsp.readFile(file, 'utf8');
  assert.ok(afterFirst.startsWith(fixture));
  assert.deepEqual(JSON.parse(afterFirst.slice(fixture.length)), {
    type: 'message', eventId: 'torn-1', message: { id: 'torn-1', role: 'user', content: 'after crash' },
  });

  // A crash tail after the index exists: repaired without a reseed.
  const spy = spyReads(t, home);
  await fsp.appendFile(file, '{"type":"message","eventId":"torn-2"');
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'torn', PROJECT, 'user', 'again', 'torn-2');
  assert.deepEqual(spy.streams, []);
  assert.equal((await eventIdsOf(file)).filter((id) => id === 'torn-2').length, 1);
  assert.ok((await fsp.readFile(file, 'utf8')).endsWith('\n'));
});

test('a torn tail longer than 64 KiB walks back to the last complete line', async (t) => {
  await withHome(t);
  const mod = await freshModule();
  const fixture = realShapedFixture('long-tail');
  const file = await seedFile(mod, 'long-tail', `${fixture}{"content":"${'x'.repeat(200 * 1024)}`);
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'long-tail', PROJECT, 'user', 'ok', 'long-1');
  const text = await fsp.readFile(file, 'utf8');
  assert.equal(text.slice(0, fixture.length), fixture);
  assert.equal(text.split('\n').filter(Boolean).length, 44);

  const allTorn = await seedFile(mod, 'all-torn', `{"partial":${'y'.repeat(70 * 1024)}`);
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'all-torn', PROJECT, 'user', 'first', 'only');
  assert.deepEqual(await eventIdsOf(allTorn), ['only']);
});

test('inode replacement, truncation and in-place rewrite force a reseed', async (t) => {
  const home = await withHome(t);
  const mod = await freshModule();
  const fixture = realShapedFixture('replace');
  const file = await seedFile(mod, 'replace', fixture);
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'replace', PROJECT, 'user', 'a', 'evt-a');
  const spy = spyReads(t, home);

  // Replaced (new inode) by a file without evt-a but with evt-z.
  const replacement = `${fixture}${JSON.stringify({ type: 'message', eventId: 'evt-z', message: { id: 'evt-z', role: 'user', content: 'z' } })}\n`;
  await fsp.writeFile(`${file}.new`, replacement);
  await fsp.rename(`${file}.new`, file);
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'replace', PROJECT, 'user', 'z again', 'evt-z');
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'replace', PROJECT, 'user', 'a again', 'evt-a');
  assert.deepEqual((await eventIdsOf(file)).slice(-2), ['evt-z', 'evt-a']);
  assert.equal(spy.streams.length, 1);
  assert.equal(spy.streams[0]?.start, 0);

  // Truncated (same inode, smaller): evt-a is gone from disk, so it may land again.
  await fsp.truncate(file, Buffer.byteLength(fixture));
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'replace', PROJECT, 'user', 'a third', 'evt-a');
  assert.deepEqual((await eventIdsOf(file)).slice(-1), ['evt-a']);
  assert.equal(spy.streams.length, 2);
  assert.equal(spy.streams[1]?.start, 0);

  // Rewritten in place and grown past the indexed size, off a line boundary.
  const sizeBefore = (await fsp.stat(file)).size;
  const rewritten = `${JSON.stringify({ type: 'meta', projectPath: PROJECT, sessionName: 'r'.repeat(sizeBefore) })}\n`
    + `${JSON.stringify({ type: 'message', eventId: 'evt-rw', message: { id: 'evt-rw', role: 'user', content: 'rw' } })}\n`;
  await fsp.writeFile(file, rewritten);
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'replace', PROJECT, 'user', 'rw again', 'evt-rw');
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'replace', PROJECT, 'user', 'a fourth', 'evt-a');
  assert.deepEqual(await eventIdsOf(file), ['evt-rw', 'evt-a']);
  assert.equal(spy.streams.at(-1)?.start, 0);
});

test('growth by a writer outside the index is scanned from the indexed offset only', async (t) => {
  const home = await withHome(t);
  const mod = await freshModule();
  const file = await seedFile(mod, 'foreign', realShapedFixture('foreign'));
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'foreign', PROJECT, 'user', 'mine', 'evt-mine');
  const indexedSize = (await fsp.stat(file)).size;
  const spy = spyReads(t, home);

  // Another process (or the unlocked meta writer) appends behind our back.
  await fsp.appendFile(file, `${JSON.stringify({ type: 'message', eventId: 'evt-foreign', message: { id: 'evt-foreign', role: 'assistant', content: 'theirs' } })}\n`);
  await mod.appendVendorTranscript('qwen', 'foreign', PROJECT, { type: 'meta', projectPath: PROJECT, sessionName: 'unlocked' });
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'foreign', PROJECT, 'assistant', 'dup', 'evt-foreign');
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'foreign', PROJECT, 'user', 'dup', 'evt-mine');

  assert.deepEqual(spy.streams, [{ file, start: indexedSize }]);
  const ids = await eventIdsOf(file);
  assert.equal(ids.filter((id) => id === 'evt-foreign').length, 1);
  assert.equal(ids.filter((id) => id === 'evt-mine').length, 1);
});

test('the index is an LRU capped at 256 files', async (t) => {
  const home = await withHome(t);
  const mod = await freshModule();
  for (let i = 0; i <= 256; i += 1) {
    await mod.appendVendorTranscriptTurnIdempotent('qwen', `lru-${i}`, PROJECT, 'user', 'x', `evt-${i}`);
  }
  const spy = spyReads(t, home);
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'lru-256', PROJECT, 'user', 'dup', 'evt-256');
  assert.deepEqual(spy.streams, [], 'a recent file is still indexed');
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'lru-0', PROJECT, 'user', 'dup', 'evt-0');
  assert.equal(spy.streams.length, 1, 'the least recently used file was evicted and reseeds');
  assert.equal(spy.streams[0]?.start, 0);
  assert.deepEqual(await eventIdsOf(mod.vendorTranscriptPath('qwen', 'lru-0', PROJECT)), ['evt-0']);
  // Reseeding lru-0 evicted lru-1 (now the oldest); lru-2..256 stay indexed.
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'lru-2', PROJECT, 'user', 'dup', 'evt-2');
  assert.equal(spy.streams.length, 1);
  await mod.appendVendorTranscriptTurnIdempotent('qwen', 'lru-1', PROJECT, 'user', 'dup', 'evt-1');
  assert.equal(spy.streams.length, 2);
});
