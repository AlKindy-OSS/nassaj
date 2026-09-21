/** Linux private FIFO race: no writer or device is opened; nonblocking open must reach regular-file validation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { HistoryReadLease } from './history-budget.service.js';
test('source swapped to a private FIFO after lstat cannot block before fstat', { skip: process.platform !== 'linux', timeout: 2000 }, async () => {
  const root = await fsp.mkdtemp(path.resolve('.memory-c1-fifo-')), file = path.join(root, 'source.jsonl');
  const open = fsp.open, lease = new HistoryReadLease(new AbortController().signal); let opens = 0, closed = 0;
  const before = (await fsp.readdir('/proc/self/fd')).length;
  try {
    await fsp.writeFile(file, '{}\n');
    fsp.open = async (...args: Parameters<typeof open>) => {
      assert.equal(args[0], file); const flags = args[1] as number;
      assert.ok(flags & fs.constants.O_NOFOLLOW); assert.ok(flags & fs.constants.O_NONBLOCK);
      await fsp.unlink(file); execFileSync('mkfifo', ['--mode=600', file]); opens++;
      const fd = await open(...args), close = fd.close.bind(fd); fd.close = async () => { await close(); closed++; }; return fd;
    };
    await assert.rejects(lease.initialize(file), { code: 'HISTORY_SOURCE_UNAVAILABLE' }); fsp.open = open;
    await lease.close(); assert.equal(opens, 1); assert.equal(closed, 1);
    assert.ok((await fsp.readdir('/proc/self/fd')).length <= before);
    const other = new HistoryReadLease(new AbortController().signal);
    try { fsp.open = async () => { throw new Error('preexisting FIFO must be rejected before open'); };
      await assert.rejects(other.initialize(file), { code: 'HISTORY_SOURCE_UNAVAILABLE' });
    } finally { fsp.open = open; await other.close(); }
  } finally { fsp.open = open; await lease.close(); await fsp.rm(root, { recursive: true, force: true }); }
});
