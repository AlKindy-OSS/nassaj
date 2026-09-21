/** Pinned-source contract regressions on project-disk synthetic fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { HistoryReadLease } from './history-budget.service.js';

async function sourceCase(run: (lease: HistoryReadLease, file: string, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.resolve(import.meta.dirname, '../../../../.memory-c0-c1-source-'));
  const file = path.join(root, 'synthetic.jsonl');
  const lease = new HistoryReadLease(new AbortController().signal);
  const beforeFds = (await fs.readdir('/proc/self/fd')).length;
  try { await fs.writeFile(file, '{"text":"العربية 🧵"}\n{"text":"second"}\n'); await lease.initialize(file); await run(lease, file, root); }
  finally {
    await lease.close();
    assert.ok((await fs.readdir('/proc/self/fd')).length <= beforeFds, 'pinned source descriptors released');
    await fs.rm(root, { recursive: true, force: true });
  }
}
async function consume(lease: HistoryReadLease, file: string) {
  const rows = [];
  for await (const line of lease.lines(file)) rows.push(lease.parse(line));
  return rows;
}

test('memory source preserves Unicode records and pinned bigint fingerprint with exactly two scans', async () => sourceCase(async (lease, file) => {
  const actual = await fs.stat(file, { bigint: true }), pinned = await lease.stat(file);
  assert.equal(pinned.ino, actual.ino); assert.equal(pinned.mtimeNs, actual.mtimeNs);
  assert.deepEqual(await consume(lease, file), [{ text: 'العربية 🧵' }, { text: 'second' }]);
  await lease.verify(); assert.equal(lease.counts.scannedBytes, Number(actual.size) * 2);
}));

test('memory source accepts append beyond the pinned prefix without mixing new rows', async () => sourceCase(async (lease, file) => {
  const size = (await fs.stat(file)).size;
  assert.equal((await consume(lease, file)).length, 2); await fs.appendFile(file, '{"text":"new"}\n');
  await lease.verify(); assert.equal(lease.counts.scannedBytes, size * 2);
}));

test('memory source detects same-size prefix replacement before result publication', async () => sourceCase(async (lease, file) => {
  await consume(lease, file); const contents = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, contents.replace('second', 'tamper'));
  await assert.rejects(lease.verify(), { code: 'HISTORY_REVISION_CHANGED', statusCode: 409 });
}));

test('memory source rejects a second provider consumption instead of an unaccounted scan', async () => sourceCase(async (lease, file) => {
  await consume(lease, file); await assert.rejects(consume(lease, file), { code: 'HISTORY_BUDGET_EXCEEDED', statusCode: 413 });
}));

test('memory source rejects symlink aliases before opening a duplicate descriptor', async () => sourceCase(async (lease, file, root) => {
  const alias = path.join(root, 'alias.jsonl'); await fs.symlink(file, alias);
  await assert.rejects(lease.admit(alias), { code: 'HISTORY_SOURCE_UNAVAILABLE', statusCode: 409 });
}));

test('memory source detects truncation between reading and verification', async () => sourceCase(async (lease, file) => {
  await consume(lease, file); await fs.truncate(file, 0);
  await assert.rejects(lease.verify(), { code: 'HISTORY_REVISION_CHANGED', statusCode: 409 });
}));

test('memory source deletion produces a typed source or revision failure rather than leaking an OS path', async () => sourceCase(async (lease, file) => {
  await consume(lease, file); await fs.unlink(file);
  await assert.rejects(lease.verify(), (error: unknown) => {
    const failure = error as { code?: string; statusCode?: number; message?: string };
    assert.ok(['HISTORY_SOURCE_UNAVAILABLE', 'HISTORY_REVISION_CHANGED'].includes(failure.code ?? ''));
    assert.equal(failure.statusCode, 409); assert.ok(!failure.message?.includes(file)); return true;
  });
}));

test('memory source permits an unchanged metadata-only journal without requiring body consumption', async () => sourceCase(async (lease, file, root) => {
  const journal = path.join(root, 'ignored-journal.jsonl'); await fs.writeFile(journal, '{"type":"result"}\n');
  await lease.stat(journal); await consume(lease, file); await lease.verify();
}));


for (const text of ['{"complete":true}', '{"partial":']) test(`memory source marks a non-LF ${text.includes('complete') ? 'complete JSON' : 'partial JSON'} tail as explicit incompleteness`, async () => {
  const root = await fs.mkdtemp(path.resolve(import.meta.dirname, '../../../../.memory-c0-c1-tail-'));
  const lease = new HistoryReadLease(new AbortController().signal);
  try {
    const file = path.join(root, 'tail.jsonl'); await fs.writeFile(file, text); await lease.initialize(file);
    await assert.rejects(consume(lease, file), { code: 'HISTORY_SOURCE_INCOMPLETE', statusCode: 409 });
  } finally { await lease.close(); await fs.rm(root, { recursive: true, force: true }); }
});
