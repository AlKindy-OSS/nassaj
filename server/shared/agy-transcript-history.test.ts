import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, 'agy-history-'));
const transcript = path.join(root, 'transcript.jsonl');
after(() => fs.rm(root, { recursive: true, force: true }));
mock.module('@/modules/database/index.js', { namedExports: {
  sessionsDb: { getSessionById: () => ({ jsonl_path: transcript }) },
  providerRunFailuresDb: { getFailure: () => null },
} });
const { AntigravitySessionsProvider } = await import('../modules/providers/list/antigravity/antigravity-sessions.provider.js');
const { finalAgyTranscriptMessage } = await import('../modules/providers/list/antigravity/agy-transcript-identity.js');

test('AGY native final timing identity joins repeated actual history reads after the turn baseline', async () => {
  const contents = [0, 1].map(step_index => JSON.stringify({
    step_index, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE',
    content: `reply-${step_index}`, created_at: '2026-09-05T12:00:00Z',
  })).join('\n');
  await fs.writeFile(transcript, contents);
  const final = finalAgyTranscriptMessage(contents, 'agy-history-fixture', 0);
  assert.ok(final);
  const reader = new AntigravitySessionsProvider();
  const first = await reader.fetchHistory('agy-history-fixture');
  const second = await reader.fetchHistory('agy-history-fixture');
  assert.deepEqual(first, second);
  assert.equal(first.messages.find(message => message.id === final.id)?.content, 'reply-1');
  assert.equal(finalAgyTranscriptMessage(contents, 'agy-history-fixture', 1), null);
});
