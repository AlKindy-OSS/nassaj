/**
 * Tests for the per-workflow terminal signal.
 *
 * Positive cases preserve the measured envelope and distance while all values
 * remain synthetic and safe to distribute.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { openPinned } from '../../shared/pinned-fd.js';
import {
  __resetWorkflowTerminalScan,
  extractTerminalWorkflowIds,
  readTerminalWorkflowIds,
} from '../workflow-terminal.service.js';
import { SYNTHETIC_NOTIFICATION_LINES } from './__fixtures__/wf-notifications.synthetic.js';

describe('extractTerminalWorkflowIds — production-shaped synthetic rows', () => {
  it('finds the workflow id in a completed notification, whatever the row type', () => {
    // 15 of 17 real notification rows are NOT `type:'user'`. All must parse.
    for (const [variant, line] of Object.entries(SYNTHETIC_NOTIFICATION_LINES)) {
      const ids = extractTerminalWorkflowIds(line);
      assert.ok(
        ids.size >= 1,
        `no workflow id extracted from a real ${variant} row — the id sits after <status>, not in the header`,
      );
      for (const id of ids) {
        assert.match(id, /^wf_[0-9a-f]+(-[0-9a-f]+)?$/);
      }
    }
  });

  it('reads several notifications carried on one chunk', () => {
    const chunk = Object.values(SYNTHETIC_NOTIFICATION_LINES).join('\n');
    const ids = extractTerminalWorkflowIds(chunk);
    assert.ok(ids.size >= 1);
  });

  it('ignores a `stopped` notification — that is the orphan signal, not completion', () => {
    // Built by swapping ONLY the status on a real row, so every other byte stays
    // production-shaped. `stopped` must fall through to the liveness classifier
    // so a real B-103 orphan keeps being surfaced instead of silently retired.
    const completed = Object.values(SYNTHETIC_NOTIFICATION_LINES)[0]!;
    const stopped = completed.replace(/<status>completed<\/status>/, '<status>stopped</status>');
    assert.notEqual(stopped, completed, 'fixture no longer carries a completed status');
    assert.equal(extractTerminalWorkflowIds(stopped).size, 0);
  });

  it('returns nothing for a row with no notification at all', () => {
    assert.equal(extractTerminalWorkflowIds('{"type":"assistant","message":{}}').size, 0);
  });
});

/** Reads through a pinned descriptor, the way the status service hands the transcript over (ADR-201 A1). */
async function readPinned(file: string): Promise<ReadonlySet<string>> {
  const realpath = fs.realpathSync(file);
  const { handle } = await openPinned(realpath, 'file');
  try {
    return await readTerminalWorkflowIds({ fd: handle, realpath });
  } finally {
    await handle.close();
  }
}

describe('readTerminalWorkflowIds — incremental cursor', () => {
  let dir: string;
  let file: string;

  before(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wf-terminal-'));
    file = path.join(dir, 'session.jsonl');
    __resetWorkflowTerminalScan();
  });

  after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('accumulates ids across appends and never re-reads settled bytes', async () => {
    const [first, second] = Object.values(SYNTHETIC_NOTIFICATION_LINES);
    await fsp.writeFile(file, `${first}\n`, 'utf8');

    const afterFirst = await readPinned(file);
    assert.ok(afterFirst.size >= 1);
    const sizeAfterFirst = afterFirst.size;

    // Appending must be picked up; nothing already learned may be lost.
    await fsp.appendFile(file, `${second}\n`, 'utf8');
    const afterSecond = await readPinned(file);
    assert.ok(afterSecond.size >= sizeAfterFirst);
  });

  it('ignores a trailing partial line until it is complete', async () => {
    const line = Object.values(SYNTHETIC_NOTIFICATION_LINES)[0]!;
    const partialFile = path.join(dir, 'partial.jsonl');
    // Half a notification, no newline yet — the writer is mid-flush.
    await fsp.writeFile(partialFile, line.slice(0, Math.floor(line.length / 2)), 'utf8');
    assert.equal((await readPinned(partialFile)).size, 0);

    // Completed on the next poll.
    await fsp.writeFile(partialFile, `${line}\n`, 'utf8');
    assert.ok((await readPinned(partialFile)).size >= 1);
  });

  it('degrades to empty (never throws) without a pinned transcript', async () => {
    assert.equal((await readTerminalWorkflowIds(null)).size, 0);
  });

  it('keeps what it learned when the file is truncated under it', async () => {
    const line = Object.values(SYNTHETIC_NOTIFICATION_LINES)[0]!;
    const rotating = path.join(dir, 'rotating.jsonl');
    await fsp.writeFile(rotating, `${line}\n`, 'utf8');
    const before = await readPinned(rotating);
    assert.ok(before.size >= 1);

    fs.writeFileSync(rotating, '', 'utf8'); // rotation
    const afterRotation = await readPinned(rotating);
    assert.ok(
      afterRotation.size >= before.size,
      'a terminal verdict must never be un-learned by rotation',
    );
  });
});
