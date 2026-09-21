/**
 * transcript-parser.provider.test.js — T-1144 parser integration.
 *
 * The fixture is DERIVED FROM THE REAL incident transcript 43b0dc60
 * (2026-07-31): one assistant entry of each model that answered in it, with
 * the exact wire envelopes recorded there (kimi turns: chatcmpl- id, no
 * requestId; the stolen turn: msg_ + req_). Not synthetic shapes — the same
 * lesson as feedback_synthetic_fixtures_false_confidence.
 *
 * Verifies parseClaudeStyleTranscript tags every model row with the wire-
 * fingerprinted provider, and that the stolen claude-opus-5 turn INSIDE a
 * kimi session is still attributed to anthropic — the exact mislabel the user
 * asked to make impossible.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseClaudeStyleTranscript } from './transcript-parser.js';

function assistantEntry({ model, id, requestId }) {
  return JSON.stringify({
    type: 'assistant',
    ...(requestId ? { requestId } : {}),
    message: {
      id,
      role: 'assistant',
      model,
      content: [{ type: 'text', text: '…' }],
    },
  });
}

test('incident fixture: each model row carries its wire-fingerprinted provider', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tp-provider-'));
  const transcript = path.join(dir, 'session.jsonl');
  try {
    await writeFile(
      transcript,
      [
        // Exact envelopes from 43b0dc60:
        assistantEntry({ model: 'kimi-k3', id: 'chatcmpl-6a6c75002861d64155cd4a3a', requestId: null }),
        assistantEntry({ model: 'kimi-k3', id: 'chatcmpl-6a6c7511deadbeefcafe', requestId: null }),
        assistantEntry({ model: 'claude-opus-5', id: 'msg_synthetic_011CdZzMcJGtTfm91NxJ3Qu8', requestId: 'req_synthetic_011CdZzMaWsgHFQ6ZeFhUTfM' }),
        assistantEntry({ model: 'kimi-k2.6', id: 'chatcmpl-6a6c9e06ea1b91cd111c1', requestId: null }),
        '',
        'not-json',
      ].join('\n'),
    );

    const agents = await parseClaudeStyleTranscript(transcript);
    const byName = new Map(agents.filter((a) => a.agent_kind === 'model').map((a) => [a.agent_name, a]));

    assert.equal(byName.get('kimi-k3')?.agent_provider, 'moonshot');
    assert.equal(byName.get('kimi-k3')?.invocation_count, 2);
    // THE KILLER ASSERTION: the stolen turn inside the vendor session is
    // attributed to Anthropic by its envelope — visible, never blended away.
    assert.equal(byName.get('claude-opus-5')?.agent_provider, 'anthropic');
    assert.equal(byName.get('kimi-k2.6')?.agent_provider, 'moonshot');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a transcript with no envelope fields degrades to unknown, not to a guess', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tp-provider-'));
  const transcript = path.join(dir, 'session.jsonl');
  try {
    await writeFile(transcript, assistantEntry({ model: 'claude-fable-5', id: 'x', requestId: null }));
    const agents = await parseClaudeStyleTranscript(transcript);
    assert.equal(agents.find((a) => a.agent_kind === 'model')?.agent_provider, 'unknown');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
