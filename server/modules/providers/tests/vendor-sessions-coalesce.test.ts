/**
 * vendor-sessions-coalesce.test.ts — B-351: token-level deltas must not fragment
 * into single-char bubbles in fetchHistory.
 *
 * The vendor transcript (one JSONL line per SSE event) carries one token per line.
 * Without coalescing, fetchHistory re-normalizes each line into its own message,
 * so a 1389-line transcript becomes 1389 UI bubbles. This test asserts that
 * consecutive stream_delta and thinking messages are merged into single blocks.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { KimiSessionsProvider } from '@/modules/providers/list/kimi/kimi-sessions.provider.js';
import { vendorTranscriptPath } from '@/modules/providers/shared/vendor/vendor-transcript.js';

const provider = new KimiSessionsProvider();

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeTranscript(filePath: string, events: unknown[]) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

test('fetchHistory coalesces consecutive stream_delta into one text message', async () => {
  const sessionId = 'coalesce-text-' + crypto.randomUUID();
  const projectPath = os.tmpdir();
  const filePath = vendorTranscriptPath('kimi', sessionId, projectPath);
  try {
    const meta = { type: 'meta', projectPath, sessionName: 'coalesce text' };
    const userMsg = { type: 'message', message: { role: 'user', content: 'hi' } };
    const deltas = [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ا' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ل' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'س' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'لام' } },
    ];
    writeTranscript(filePath, [meta, userMsg, ...deltas]);

    const result = await provider.fetchHistory(sessionId, { projectPath });

    const textMsgs = result.messages.filter((m) => m.kind === 'text' && m.role === 'assistant');
    assert.strictEqual(textMsgs.length, 1, 'expected exactly one coalesced text message');
    assert.strictEqual(textMsgs[0].content, 'السلام', 'content should be concatenated in order');
    assert.strictEqual(textMsgs[0].role, 'assistant');
  } finally {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('fetchHistory coalesces consecutive thinking_delta into one thinking message', async () => {
  const sessionId = 'coalesce-thinking-' + crypto.randomUUID();
  const projectPath = os.tmpdir();
  const filePath = vendorTranscriptPath('kimi', sessionId, projectPath);
  try {
    const meta = { type: 'meta', projectPath, sessionName: 'thinking test' };
    const deltas = [
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' user' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' asks' } },
    ];
    writeTranscript(filePath, [meta, ...deltas]);

    const result = await provider.fetchHistory(sessionId, { projectPath });
    const thinkingMsgs = result.messages.filter((m) => m.kind === 'thinking');

    assert.strictEqual(thinkingMsgs.length, 1, 'expected exactly one coalesced thinking message');
    assert.strictEqual(thinkingMsgs[0].content, 'The user asks');
  } finally {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('fetchHistory preserves separation between text and tool_use blocks', async () => {
  const sessionId = 'coalesce-tool-' + crypto.randomUUID();
  const projectPath = os.tmpdir();
  const filePath = vendorTranscriptPath('kimi', sessionId, projectPath);
  try {
    const meta = { type: 'meta', projectPath, sessionName: 'tool test' };
    const deltas = [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'First ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'line.' } },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
      },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'After ' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'tool.' } },
    ];
    writeTranscript(filePath, [meta, ...deltas]);

    const result = await provider.fetchHistory(sessionId, { projectPath });
    const textMsgs = result.messages.filter((m) => m.kind === 'text');

    assert.strictEqual(textMsgs.length, 2, 'text should split around tool_use');
    assert.strictEqual(textMsgs[0].content, 'First line.');
    assert.strictEqual(textMsgs[1].content, 'After tool.');
  } finally {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});
