import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

// B-1564: agy history reads only transcripts under a brain root (the sandbox HOME's brain).
const { AGY_BRAIN_UNDER_HOME } = await import('../modules/providers/list/antigravity/agy-brain-layout.js');
const root = path.join(os.homedir(), AGY_BRAIN_UNDER_HOME, '00000000-0000-4000-8000-0000000000b1');
const transcript = path.join(root, '.system_generated', 'logs', 'transcript.jsonl');
await fs.mkdir(path.dirname(transcript), { recursive: true });
after(() => fs.rm(root, { recursive: true, force: true }));
mock.module('@/modules/database/index.js', { namedExports: {
  sessionsDb: { getSessionById: () => ({ jsonl_path: transcript }) },
  providerRunFailuresDb: { getFailure: () => null },
} });
const { AntigravitySessionsProvider } = await import('../modules/providers/list/antigravity/antigravity-sessions.provider.js');
const { finalAgyTranscriptMessage } = await import('../modules/providers/list/antigravity/agy-transcript-identity.js');
const { withPinnedTranscript } = await import('./__tests__/provider-root-sandbox.js');

test('AGY native final timing identity joins repeated actual history reads after the turn baseline', async () => {
  const contents = [0, 1].map(step_index => JSON.stringify({
    step_index, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
    content: `reply-${step_index}`, created_at: '2026-09-05T12:00:00Z',
  })).join('\n');
  await fs.writeFile(transcript, contents);
  const final = finalAgyTranscriptMessage(contents, 'agy-history-fixture', 0);
  assert.ok(final);
  const reader = new AntigravitySessionsProvider();
  // ADR-201: the history service supplies the pinned transcript to the reader.
  const read = () => withPinnedTranscript(transcript, 'agy-history-fixture', 'antigravity',
    (pinned) => reader.fetchHistory('agy-history-fixture', { transcript: pinned }));
  const first = await read();
  const second = await read();
  assert.deepEqual(first, second);
  assert.equal(first.messages.find(message => message.id === final.id)?.content, 'reply-1');
  assert.equal(finalAgyTranscriptMessage(contents, 'agy-history-fixture', 1), null);
});
