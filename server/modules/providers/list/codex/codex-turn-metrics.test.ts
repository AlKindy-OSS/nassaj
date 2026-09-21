import assert from 'node:assert/strict';
import { appendFile, mkdtemp, open, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';

import {
  captureCodexTurnBaseline,
  newestCompletedTurnFromJsonl,
  readCodexJsonlAppend,
  resolveCompletedCodexTurn,
} from './codex-turn-metrics.js';

// Provider-shaped bytes reduced from a measured append window to the minimum
// contract: commentary/noise, a durable final answer, and task_complete. All
// operational identifiers, paths, and free text are replaced with explicitly
// synthetic values; retaining them adds no provenance to the parser contract.
const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'codex-rollout-append.jsonl',
);
const DURABLE_TURN_ID = 'turn-fixture-durable';
const DURABLE_MESSAGE_ID = 'msg_fixture_final';

const readFixture = () => readFile(FIXTURE_PATH, 'utf8');

describe('newestCompletedTurnFromJsonl', () => {
  it('resolves the durable turn from a normalized provider-shaped append', async () => {
    assert.deepEqual(newestCompletedTurnFromJsonl(await readFixture()), {
      turnId: DURABLE_TURN_ID,
      assistantMessageId: DURABLE_MESSAGE_ID,
    });
  });

  it('contains only the minimum sanitized fixture contract', async () => {
    const text = await readFixture();
    const records = text.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.payload.type), [
      'task_started', 'message', 'token_count', 'message', 'task_complete',
    ]);
    assert.equal(/\/[Hh]ome\/|nassaj-session-overlays/.test(text), false);
    assert.equal(/\b[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(text), false);
    assert.equal(/\bmsg_[0-9a-f]{32,}\b/i.test(text), false);
  });

  it('never sees an SDK item id in the rollout, so it cannot join on one', async () => {
    // The whole defect in one assertion: the live stream emits `item_N`, the
    // rollout only ever writes `msg_<hex>`, so an equality join is unsatisfiable.
    const text = await readFixture();
    assert.equal(text.includes('"id":"item_'), false);
    assert.match(DURABLE_MESSAGE_ID, /^msg_/);
  });

  it('returns no metric while the newest answer is still missing its task_complete', async () => {
    const text = await readFixture();
    const lines = text.split('\n');
    const completionIndex = lines.findIndex((line) => line.includes('"task_complete"'));
    assert.ok(completionIndex > 0, 'fixture must contain the durable completion');
    assert.equal(newestCompletedTurnFromJsonl(lines.slice(0, completionIndex).join('\n')), null);
  });

  it('rejects a completion already present in the pre-run baseline', async () => {
    assert.equal(
      newestCompletedTurnFromJsonl(await readFixture(), new Set([DURABLE_TURN_ID])),
      null,
    );
  });

  it('never returns an older completed turn when a newer one is still flushing', () => {
    const text = [
      JSON.stringify({ type: 'response_item', payload: {
        type: 'message', id: 'msg_old', role: 'assistant', phase: 'final_answer',
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-old' },
      } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-old' } }),
      JSON.stringify({ type: 'response_item', payload: {
        type: 'message', id: 'msg_current', role: 'assistant', phase: 'final_answer',
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-current' },
      } }),
    ].join('\n');
    assert.equal(newestCompletedTurnFromJsonl(text), null);
  });

  it('ignores commentary: only a final_answer may carry the metric', () => {
    const text = [
      JSON.stringify({ type: 'response_item', payload: {
        type: 'message', id: 'msg_fixture_commentary', role: 'assistant', phase: 'commentary',
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
      } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } }),
    ].join('\n');
    assert.equal(newestCompletedTurnFromJsonl(text), null);
  });

  it('reads only bytes appended after an inode-bound baseline', async () => {
    const directory = await mkdtemp('/var/tmp/codex-turn-append-');
    const filePath = `${directory}/rollout.jsonl`;
    try {
      await writeFile(filePath, `${JSON.stringify({ type: 'event_msg', payload: {
        type: 'task_complete', turn_id: 'turn-old',
      } })}\n`);
      const handle = await open(filePath, 'r');
      const stat = await handle.stat();
      await handle.close();
      const baseline = {
        filePath, device: stat.dev, inode: stat.ino, byteOffset: stat.size,
      };
      const appended = [
        JSON.stringify({ type: 'response_item', payload: {
          type: 'message', id: 'msg-current', role: 'assistant', phase: 'final_answer',
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-current' },
        } }),
        JSON.stringify({ type: 'event_msg', payload: {
          type: 'task_complete', turn_id: 'turn-current',
        } }),
      ].join('\n');
      await appendFile(filePath, `${appended}\n`);
      assert.equal(await readCodexJsonlAppend(baseline), `${appended}\n`);

      await rename(filePath, `${filePath}.replaced`);
      await writeFile(filePath, `${appended}\n`);
      assert.equal(await readCodexJsonlAppend(baseline), null,
        'replacement inode must fail closed even when path and content look valid');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails closed when the bound rollout is truncated below its captured offset', async () => {
    const directory = await mkdtemp('/var/tmp/codex-turn-truncated-');
    const filePath = `${directory}/rollout.jsonl`;
    try {
      await writeFile(filePath, 'durable baseline bytes\n');
      const handle = await open(filePath, 'r');
      const stat = await handle.stat();
      await handle.close();
      const baseline = {
        filePath, device: stat.dev, inode: stat.ino, byteOffset: stat.size,
      };

      await truncate(filePath, 0);
      assert.equal(await readCodexJsonlAppend(baseline), null);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('resolveCompletedCodexTurn', () => {
  /**
   * End-to-end shape of one live Codex turn: an indexed session pointing at a
   * rollout that already holds earlier turns, a baseline captured at spawn, then
   * this run's real bytes appended underneath it.
   */
  const withLiveCodexTurn = async (
    run: (context: { sessionId: string; rolloutPath: string }) => Promise<void>,
  ): Promise<void> => {
    const previous = process.env.DATABASE_PATH;
    // Tests must not allocate in /tmp: it is tmpfs on Nassaj hosts.
    const directory = await mkdtemp('/var/tmp/codex-turn-resolve-');
    const rolloutPath = path.join(directory, 'rollout.jsonl');
    const databasePath = path.join(directory, 'db.sqlite');
    const sessionId = 'session-fixture-codex-turn';
    closeConnection();
    process.env.DATABASE_PATH = databasePath;
    await writeFile(databasePath, '');
    await initializeDatabase();
    try {
      // A previous turn that already completed: it must never win.
      await writeFile(rolloutPath, [
        JSON.stringify({ type: 'response_item', payload: {
          type: 'message', id: 'msg_fixture_previous', role: 'assistant', phase: 'final_answer',
          internal_chat_message_metadata_passthrough: { turn_id: 'turn-before-this-run' },
        } }),
        JSON.stringify({ type: 'event_msg', payload: {
          type: 'task_complete', turn_id: 'turn-before-this-run',
        } }),
      ].join('\n') + '\n');
      getConnection().prepare(
        'INSERT INTO sessions (session_id, provider, jsonl_path) VALUES (?, ?, ?)',
      ).run(sessionId, 'codex', rolloutPath);
      await run({ sessionId, rolloutPath });
    } finally {
      closeConnection();
      if (previous === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previous;
      await rm(directory, { recursive: true, force: true });
    }
  };

  it('resolves the durable turn a live run appended, given only the baseline', async () => {
    await withLiveCodexTurn(async ({ sessionId, rolloutPath }) => {
      const baseline = await captureCodexTurnBaseline(sessionId);
      assert.ok(baseline, 'baseline must be captured before the run appends');
      // The live SDK id for this turn is `item_7`; it is deliberately absent
      // here because the resolver may not depend on it (B-822).
      await appendFile(rolloutPath, await readFixture());

      assert.deepEqual(await resolveCompletedCodexTurn(sessionId, baseline), {
        turnId: DURABLE_TURN_ID,
        assistantMessageId: DURABLE_MESSAGE_ID,
      });
    });
  });

  it('never reaches back past the baseline for an older completed turn', async () => {
    await withLiveCodexTurn(async ({ sessionId }) => {
      const baseline = await captureCodexTurnBaseline(sessionId);
      assert.ok(baseline);
      // Nothing appended: the pre-run completion is outside the window.
      assert.equal(await resolveCompletedCodexTurn(sessionId, baseline), null);
    });
  });
});
