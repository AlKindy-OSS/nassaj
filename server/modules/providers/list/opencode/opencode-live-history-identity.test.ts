/**
 * B-1751: a live OpenCode reply and its history copy must be one bubble.
 *
 * Real `opencode run --format json` lines carry the message and part ids only
 * under `part` (fixture `opencode-progress.real.json`), while history rows are
 * `${message_id}_${part_id}`. A live row with a generated id never matched its
 * history copy, so the client kept both. The replay below feeds the real
 * stream through the client's own frame log and merge (`applyStreamFrame`,
 * `computeMerged`), mirroring the stream branch of useChatRealtimeHandlers.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, mock } from 'node:test';

import type { NormalizedMessage } from '@/shared/types.js';

import { applyStreamFrame, streamFinalId, type StreamFrameMap } from '../../../../../src/contexts/streamFrameLog.js';

import { OpenCodeSessionsProvider } from './opencode-sessions.provider.js';

type AnyRecord = Record<string, any>;

// The store's HTTP helper reads Vite's import.meta.env at load; the merge never calls it.
const srcRoot = path.resolve(import.meta.dirname, '../../../../../src');
mock.module(pathToFileURL(path.join(srcRoot, 'utils/api.js')).href, {
  namedExports: { authenticatedFetch: async () => { throw new Error('no network in this test'); } },
});
const { computeMerged } = await import('../../../../../src/stores/useSessionStore.js');

const fixture = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, '__fixtures__', 'opencode-progress.real.json'), 'utf8')) as AnyRecord;
const SESSION = fixture.sessionId as string;
const provider = new OpenCodeSessionsProvider();

const live = (): NormalizedMessage[] => (fixture.stream as AnyRecord[])
  .flatMap((line) => provider.normalizeMessage(line, null));
const history = (): NormalizedMessage[] => (provider as any).normalizeHistoryRows(
  (fixture.rows as AnyRecord[]).map((row) => ({
    ...row,
    message_data: JSON.stringify(row.message_data),
    part_data: row.part_data ? JSON.stringify(row.part_data) : null,
  })),
  SESSION,
);

/**
 * The client's live path for one session: stream frames go through the frame
 * log; a frame that the log marks ended becomes a realtime row with the
 * handler's finalId; every other kind is appended as is.
 */
function replayLive(frames: NormalizedMessage[]): any[] {
  let log: StreamFrameMap = new Map();
  let realtime: any[] = [];
  let processed = 0;
  frames.forEach((raw, index) => {
    const frame = { ...raw, sessionId: SESSION, responseToMessageId: 'client-1' };
    const seq = index + 1;
    log = applyStreamFrame(log, frame, seq);
    const entry = log.get(SESSION);
    if (!['stream_delta', 'stream_end', 'text'].includes(frame.kind)) {
      realtime = [...realtime.filter((row) => row.id !== frame.id), frame];
      return;
    }
    if (!entry || entry.seq <= processed) return;
    processed = entry.seq;
    const finalId = streamFinalId(SESSION, entry);
    if (entry.ended && realtime.some((row) => row.id === finalId)) return;
    if (entry.frame?.kind === 'text' && entry.frame?.role === 'assistant') {
      realtime = [...realtime.filter((row) => row.id !== entry.frame.id), entry.frame];
      return;
    }
    const streamId = `__streaming_${SESSION}`;
    if (entry.text) {
      const row = { id: streamId, sessionId: SESSION, provider: 'opencode', kind: 'stream_delta',
        clientStream: true, content: entry.text, responseToMessageId: 'client-1',
        timestamp: new Date(Number(raw.timestamp ? Date.parse(raw.timestamp) : 0) + 50).toISOString(),
        ...(entry.frame?.model ? { model: entry.frame.model } : {}) };
      realtime = [...realtime.filter((r) => r.id !== streamId), row];
    }
    if (entry.ended) {
      realtime = realtime.map((row) => (row.id === streamId
        ? { ...row, id: finalId, kind: 'text', role: 'assistant' } : row));
    }
  });
  return realtime;
}

describe('B-1751: live OpenCode rows carry their history identity', () => {
  it('derives the live text id and model from the part, as history does', () => {
    const liveText = live().find((m) => m.content === 'DONE');
    const historyText = history().find((m) => m.kind === 'text' && m.content === 'DONE');
    assert.ok(liveText && historyText);
    assert.equal(liveText.id, historyText.id);
    assert.equal(liveText.id, 'msg_aaaaaaaa-0005_prt_120f5bc40001bLqWgxNu6xqKCW');
  });

  it('carries a model named on the event', () => {
    const [message] = provider.normalizeMessage({
      type: 'text', sessionID: SESSION,
      part: { id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'hi', modelID: 'big-pickle' },
    }, null);
    assert.equal(message.id, 'msg_1_prt_1');
    assert.equal(message.model, 'big-pickle');
  });

  it('gives live tool and step rows their history ids', () => {
    const historyIds = new Set(history().map((m) => m.id));
    for (const message of live().filter((m) => m.kind === 'tool_use' || m.kind === 'stream_end')) {
      assert.ok(historyIds.has(message.id), `${message.kind} ${message.id} has a history twin`);
    }
  });

  // The client finalizes a streamed reply with the durable id its deltas share
  // (streamFinalId), so the merge retires the live copy by id equality.
  it('shows exactly one assistant bubble after history arrives', () => {
    const merged = computeMerged(history() as any, replayLive(live()));
    const bubbles = merged.filter((m: AnyRecord) => m.content === 'DONE'
      && (m.kind === 'stream_delta' || (m.kind === 'text' && m.role === 'assistant')));
    assert.equal(bubbles.length, 1, JSON.stringify(bubbles.map((m: AnyRecord) => m.id)));
  });

  it('keeps the frame model on the finalized live reply', () => {
    // opencode-cli.js stamps the launched `--model` on deltas and stream ends.
    const model = 'opencode/big-pickle';
    const frames = live().map((m) => (['stream_delta', 'stream_end'].includes(m.kind) && !m.model
      ? { ...m, model } : m));
    const reply = replayLive(frames).find((m) => m.content === 'DONE' && m.kind === 'text');
    assert.equal(reply?.id, 'msg_aaaaaaaa-0005_prt_120f5bc40001bLqWgxNu6xqKCW');
    assert.equal(reply?.model, model);
  });
});
