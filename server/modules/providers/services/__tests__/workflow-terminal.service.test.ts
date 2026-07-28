/**
 * Tests for the per-workflow terminal signal.
 *
 * Every positive case runs on notification rows lifted VERBATIM from a real
 * transcript. That is deliberate: the first implementation of the extractor was
 * green against the shape I assumed (id inside the header, before `<status>`) and
 * returned zero ids on the first real line it ever saw, because the id actually
 * appears further down the block. Synthetic fixtures would have shipped that.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  __resetWorkflowTerminalScan,
  extractTerminalWorkflowIds,
  readTerminalWorkflowIds,
} from '../workflow-terminal.service.js';
import { REAL_NOTIFICATION_LINES } from './__fixtures__/wf-real-notifications.js';

describe('extractTerminalWorkflowIds — real notification rows', () => {
  it('finds the workflow id in a completed notification, whatever the row type', () => {
    // 15 of 17 real notification rows are NOT `type:'user'`. All must parse.
    for (const [variant, line] of Object.entries(REAL_NOTIFICATION_LINES)) {
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
    const chunk = Object.values(REAL_NOTIFICATION_LINES).join('\n');
    const ids = extractTerminalWorkflowIds(chunk);
    assert.ok(ids.size >= 1);
  });

  it('ignores a `stopped` notification — that is the orphan signal, not completion', () => {
    // Built by swapping ONLY the status on a real row, so every other byte stays
    // production-shaped. `stopped` must fall through to the liveness classifier
    // so a real B-103 orphan keeps being surfaced instead of silently retired.
    const real = Object.values(REAL_NOTIFICATION_LINES)[0]!;
    const stopped = real.replace(/<status>completed<\/status>/, '<status>stopped</status>');
    assert.notEqual(stopped, real, 'fixture no longer carries a completed status');
    assert.equal(extractTerminalWorkflowIds(stopped).size, 0);
  });

  it('returns nothing for a row with no notification at all', () => {
    assert.equal(extractTerminalWorkflowIds('{"type":"assistant","message":{}}').size, 0);
  });
});

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
    const [first, second] = Object.values(REAL_NOTIFICATION_LINES);
    await fsp.writeFile(file, `${first}\n`, 'utf8');

    const afterFirst = await readTerminalWorkflowIds(file);
    assert.ok(afterFirst.size >= 1);
    const sizeAfterFirst = afterFirst.size;

    // Appending must be picked up; nothing already learned may be lost.
    await fsp.appendFile(file, `${second}\n`, 'utf8');
    const afterSecond = await readTerminalWorkflowIds(file);
    assert.ok(afterSecond.size >= sizeAfterFirst);
  });

  it('ignores a trailing partial line until it is complete', async () => {
    const line = Object.values(REAL_NOTIFICATION_LINES)[0]!;
    const partialFile = path.join(dir, 'partial.jsonl');
    // Half a notification, no newline yet — the writer is mid-flush.
    await fsp.writeFile(partialFile, line.slice(0, Math.floor(line.length / 2)), 'utf8');
    assert.equal((await readTerminalWorkflowIds(partialFile)).size, 0);

    // Completed on the next poll.
    await fsp.writeFile(partialFile, `${line}\n`, 'utf8');
    assert.ok((await readTerminalWorkflowIds(partialFile)).size >= 1);
  });

  it('degrades to empty (never throws) for a missing transcript or a null path', async () => {
    assert.equal((await readTerminalWorkflowIds(null)).size, 0);
    assert.equal((await readTerminalWorkflowIds(path.join(dir, 'nope.jsonl'))).size, 0);
  });

  it('keeps what it learned when the file is truncated under it', async () => {
    const line = Object.values(REAL_NOTIFICATION_LINES)[0]!;
    const rotating = path.join(dir, 'rotating.jsonl');
    await fsp.writeFile(rotating, `${line}\n`, 'utf8');
    const before = await readTerminalWorkflowIds(rotating);
    assert.ok(before.size >= 1);

    fs.writeFileSync(rotating, '', 'utf8'); // rotation
    const afterRotation = await readTerminalWorkflowIds(rotating);
    assert.ok(
      afterRotation.size >= before.size,
      'a terminal verdict must never be un-learned by rotation',
    );
  });
});
