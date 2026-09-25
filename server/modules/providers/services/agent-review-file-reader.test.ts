import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { AgentReviewFileReader, ReviewFileReadError, assertStableReviewSnapshot } from './agent-review-file-reader.js';
import { reviewBytesSha, reviewRawContainer } from './agent-review-raw-evidence.js';

const source = { sessionId: 's', source: 'agent' as const };
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
type FileHandle = Awaited<ReturnType<typeof fs.open>>;

async function fixture(run: (reader: AgentReviewFileReader, file: string, root: string) => Promise<void>): Promise<void> {
  const artifacts = path.join(ROOT, '.artifacts'); await fs.mkdir(artifacts, { recursive: true });
  const root = await fs.mkdtemp(path.join(artifacts, 'c4-fd-'));
  const file = path.join(root, 's.jsonl'); await fs.writeFile(file, '{}\n');
  const reader = new AgentReviewFileReader(async () => ({ ...reviewRawContainer(source), projectDirectory: root }));
  const before = (await fs.readdir('/proc/self/fd')).length;
  try { await run(reader, file, root); }
  finally {
    assert.ok((await fs.readdir('/proc/self/fd')).length <= before, 'all pinned directories and file descriptors closed');
    await fs.rm(root, { recursive: true, force: true });
  }
}

function modifyTargetOpen(t: Parameters<Parameters<typeof test>[1]>[0], modify: (handle: FileHandle) => void): void {
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('/s.jsonl')) modify(handle);
    return handle;
  });
}

test('closed same-FD snapshot is reader-minted, immutable, prefix-bound and not a caller-copy claim', async (t) => fixture(async (reader, file) => {
  let targetOpens = 0;
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const flags = args[1] as number;
    assert.ok(flags & constants.O_NOFOLLOW);
    if (String(args[0]).endsWith('/s.jsonl')) { targetOpens++; assert.ok(flags & constants.O_NONBLOCK); }
    return open(...args);
  });
  const snapshot = await reader.read(source);
  assert.equal(assertStableReviewSnapshot(snapshot), true);
  assert.throws(() => assertStableReviewSnapshot({ ...snapshot }));
  assert.equal(targetOpens, 1);
  const actual = await fs.stat(file, { bigint: true });
  assert.equal(snapshot.fileIno, String(actual.ino)); assert.equal(snapshot.capturedSize, 3);
  assert.equal(snapshot.fullSha256, reviewBytesSha('{}\n'));
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.evidence), true);
  const next = await reader.read(source, { offset: 3, sha256: snapshot.fullSha256, fileDev: snapshot.fileDev, fileIno: snapshot.fileIno });
  assert.equal(next.committedPrefixSha256, snapshot.fullSha256);
}));

test('wrong server session binding and symlink leaf or ancestor never produce a verified snapshot', async () => fixture(async (reader, file, root) => {
  const wrong = new AgentReviewFileReader(async () => ({ ...reviewRawContainer(source), sessionId: 'other', projectDirectory: root }));
  await assert.rejects(wrong.read(source), ReviewFileReadError);
  await fs.rename(file, path.join(root, 'original')); await fs.symlink('original', file);
  await assert.rejects(reader.read(source), (error: unknown) => {
    const failure = (error as ReviewFileReadError).failures[0];
    assert.deepEqual(failure.observation, { phase: 'preopen', failure: 'nofollow' });
    return failure.reason === 'invalid_shape';
  });
  await fs.symlink(root, path.join(root, 'alias'));
  const alias = new AgentReviewFileReader(async () => ({ ...reviewRawContainer(source), projectDirectory: path.join(root, 'alias') }));
  await assert.rejects(alias.read(source), ReviewFileReadError);
}));

test('growth on each captured read yields exactly two honest postopen failures and closes every descriptor', async (t) => fixture(async (reader, file) => {
  let attempts = 0;
  modifyTargetOpen(t, handle => {
    attempts++; const read = handle.read.bind(handle);
    t.mock.method(handle, 'read', async (options: Parameters<typeof handle.read>[0]) => {
      const result = await read(options); await fs.appendFile(file, '{}\n'); return result;
    });
  });
  await assert.rejects(reader.read(source), (error: unknown) => {
    const failures = (error as ReviewFileReadError).failures;
    assert.equal(failures.length, 2); assert.ok(failures.every(value => value.reason === 'source_grew'));
    assert.ok(failures.every(value => value.observation.phase === 'postopen'));
    return true;
  });
  assert.equal(attempts, 2);
}));

test('file replacement is structural and cannot be accepted as a fresh retry', async (t) => fixture(async (reader, file) => {
  modifyTargetOpen(t, handle => {
    const read = handle.read.bind(handle);
    t.mock.method(handle, 'read', async (options: Parameters<typeof handle.read>[0]) => {
      const result = await read(options); await fs.rename(file, `${file}.old`); await fs.writeFile(file, '{}\n'); return result;
    });
  });
  await assert.rejects(reader.read(source), (error: unknown) => {
    const failures = (error as ReviewFileReadError).failures;
    assert.equal(failures.length, 1); return failures[0].reason === 'inode_replaced';
  });
}));

test('same-size mutation and short reads fail rather than publishing mixed bytes', async (t) => fixture(async (reader, file) => {
  modifyTargetOpen(t, handle => {
    const read = handle.read.bind(handle);
    t.mock.method(handle, 'read', async (options: Parameters<typeof handle.read>[0]) => {
      const result = await read(options); const before = await fs.stat(file);
      await fs.writeFile(file, '[]\n'); await fs.utimes(file, before.atime, new Date(before.mtimeMs + 1000)); return result;
    });
  });
  await assert.rejects(reader.read(source), ReviewFileReadError);
  t.mock.restoreAll(); await fs.writeFile(file, '{}\n');
  modifyTargetOpen(t, handle => { t.mock.method(handle, 'read', async () => ({ bytesRead: 0, buffer: Buffer.alloc(0) })); });
  await assert.rejects(reader.read(source), (error: unknown) => (error as ReviewFileReadError).failures.every(value => value.reason === 'unstable_read'));
}));

test('committed inode/prefix/truncation and oversized artifact are rejected without altering files', async () => fixture(async (reader, file) => {
  const first = await reader.read(source);
  const prefix = { offset: 3, sha256: first.fullSha256, fileDev: first.fileDev, fileIno: first.fileIno };
  for (const [changed, reason] of [[{ ...prefix, sha256: '0'.repeat(64) }, 'prefix_changed'],
    [{ ...prefix, fileIno: '0' }, 'inode_replaced'], [{ ...prefix, offset: 4 }, 'truncated_source']] as const) {
    await assert.rejects(reader.read(source, changed), (error: unknown) => (error as ReviewFileReadError).failures[0].reason === reason);
  }
  await fs.truncate(file, 67_108_865);
  await assert.rejects(reader.read(source), (error: unknown) => {
    const failure = (error as ReviewFileReadError).failures[0];
    assert.equal(failure.observation.phase, 'postopen'); return failure.reason === 'artifact_too_large';
  });
}));

test('deadline rejects late-completing I/O after finally-close; it does not claim kernel syscall cancellation', async (t) => fixture(async (reader) => {
  let clock = 0; let targetCloses = 0;
  t.mock.method(performance, 'now', () => clock);
  modifyTargetOpen(t, handle => {
    const read = handle.read.bind(handle); const close = handle.close.bind(handle);
    t.mock.method(handle, 'read', async (options: Parameters<typeof handle.read>[0]) => {
      const result = await read(options); clock += 5001; return result;
    });
    t.mock.method(handle, 'close', async () => { targetCloses++; await close(); });
  });
  await assert.rejects(reader.read(source), (error: unknown) => {
    const failures = (error as ReviewFileReadError).failures;
    assert.equal(failures.length, 2);
    return failures.every(value => value.reason === 'read_timeout' && value.observation.phase === 'postopen');
  });
  assert.equal(targetCloses, 2);
  assert.equal(clock, 10_002, 'each attempt gets five seconds; elapsed time can exceed ten seconds');
}));

test('a successful second attempt retains the first failure for durable quarantine/recovery integration', async (t) => fixture(async (reader, file) => {
  let reads = 0;
  modifyTargetOpen(t, handle => {
    const read = handle.read.bind(handle);
    t.mock.method(handle, 'read', async (options: Parameters<typeof handle.read>[0]) => {
      const result = await read(options); if (++reads === 1) await fs.appendFile(file, '{}\n'); return result;
    });
  });
  const snapshot = await reader.read(source);
  assert.equal(assertStableReviewSnapshot(snapshot), true);
  assert.equal(snapshot.failedAttempts.length, 1);
  assert.equal(snapshot.failedAttempts[0].reason, 'source_grew');
  assert.equal(snapshot.capturedSize, 6);
  assert.equal(Object.isFrozen(snapshot.failedAttempts[0].observation), true);
}));

test('metadata-only changes still reject the snapshot when bytes and size match', async (t) => fixture(async (reader, file) => {
  modifyTargetOpen(t, handle => {
    const read = handle.read.bind(handle);
    t.mock.method(handle, 'read', async (options: Parameters<typeof handle.read>[0]) => {
      const result = await read(options); const stat = await fs.stat(file);
      await fs.utimes(file, stat.atime, new Date(stat.mtimeMs + 1000)); return result;
    });
  });
  await assert.rejects(reader.read(source), (error: unknown) => (error as ReviewFileReadError).failures
    .every(value => value.reason === 'unstable_read' && value.observation.phase === 'postopen'));
}));

test('timeout before target fstat carries no invented dev/ino/size fields', async (t) => fixture(async (reader) => {
  let clock = 0; const open = fs.open.bind(fs);
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args); clock += 5001; return handle;
  });
  await assert.rejects(reader.read(source), (error: unknown) => {
    const failures = (error as ReviewFileReadError).failures;
    assert.equal(failures.length, 2);
    for (const failure of failures) assert.deepEqual(failure.observation, { phase: 'preopen', failure: 'read_timeout' });
    return true;
  });
}));

test('non-regular target and a reported close failure cannot mint a successful snapshot', async (t) => fixture(async (reader, file) => {
  await fs.unlink(file); await fs.mkdir(file);
  await assert.rejects(reader.read(source), (error: unknown) => (error as ReviewFileReadError).failures[0].reason === 'invalid_shape');
  await fs.rmdir(file); await fs.writeFile(file, '{}\n');
  modifyTargetOpen(t, handle => {
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { await close(); throw new Error('injected close failure'); });
  });
  await assert.rejects(reader.read(source), ReviewFileReadError);
}));


test('primary growth plus failed close is structural: no retry or snapshot, every cleanup attempted', async (t) => fixture(async (reader, file) => {
  const open = fs.open.bind(fs);
  let opened = 0; let cleanupAttempts = 0; let targetOpens = 0;
  let leakedHandle: FileHandle | undefined;
  let releaseTarget: (() => Promise<void>) | undefined;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args); opened++;
    const close = handle.close.bind(handle);
    const isTarget = String(args[0]).endsWith('/s.jsonl');
    if (isTarget) {
      targetOpens++; leakedHandle = handle; releaseTarget = close;
      const read = handle.read.bind(handle);
      t.mock.method(handle, 'read', async (options: Parameters<typeof handle.read>[0]) => {
        const result = await read(options); await fs.appendFile(file, '{}\n'); return result;
      });
    }
    t.mock.method(handle, 'close', async () => {
      cleanupAttempts++;
      if (isTarget) throw new Error('injected failure before actual close');
      await close();
    });
    return handle;
  });
  try {
    await assert.rejects(reader.read(source), (error: unknown) => {
      assert.ok(error instanceof ReviewFileReadError);
      assert.equal(error.failures.length, 2);
      assert.equal(error.failures[0].reason, 'source_grew');
      assert.equal(error.failures[1].reason, 'invalid_shape');
      assert.equal(error.failures[1].closureFailed, true);
      assert.deepEqual(error.failures[1].observation, error.failures[0].observation);
      return true;
    });
    assert.equal(targetOpens, 1);
    assert.equal(cleanupAttempts, opened);
    assert.ok(leakedHandle && leakedHandle.fd >= 0, 'a rejected close is not falsely reported as closed');
    await leakedHandle.stat();
  } finally { await releaseTarget?.(); }
}));
