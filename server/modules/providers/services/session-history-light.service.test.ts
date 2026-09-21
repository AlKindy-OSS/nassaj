import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';

import type { FetchHistoryResult, LLMProvider, NormalizedMessage } from '@/shared/types.js';

import {
  isLightHistoryEnabled,
  loadStableHistorySnapshot,
  projectLightHistory,
  resetHistorySnapshotCacheForTests,
} from './session-history-light.service.js';

const baseResult = (messages: NormalizedMessage[]): FetchHistoryResult => ({
  messages, total: messages.length, hasMore: true, offset: 4, limit: 2, nextCursor: 'older-1',
});

afterEach(() => resetHistorySnapshotCacheForTests());

test('light projector preserves order, ids, text, status, paging and tool pair links', () => {
  const input = baseResult([
    {
      id: 'm1', sessionId: 's1', timestamp: '2026-09-04T00:00:00Z', provider: 'claude',
      kind: 'tool_use', role: 'assistant', content: 'safe prose', toolName: 'Read', toolId: 'tool-1',
      status: 'complete', toolInput: { file: '/x', providerEnvelope: 'x'.repeat(100_000) },
      toolResult: { content: 'result text', isError: false, toolUseResult: { raw: 'secret-heavy' } },
      images: [{ source: { data: 'data:image/png;base64,AAAA' } }],
    },
    {
      id: 'm2', sessionId: 's1', timestamp: '2026-09-04T00:00:01Z', provider: 'claude',
      kind: 'text', role: 'user', content: 'An innocent sentence mentions data:image/png;base64, but is prose.',
    },
  ]);
  const projected = projectLightHistory(input);
  assert.deepEqual(projected.messages.map((message) => message.id), ['m1', 'm2']);
  assert.equal(projected.messages[0].toolId, 'tool-1');
  assert.equal(projected.messages[0].toolResult?.content, 'result text');
  assert.equal(projected.messages[0].status, 'complete');
  assert.equal(projected.messages[1].content, input.messages[1].content);
  assert.equal(projected.hasMore, true);
  assert.equal(projected.nextCursor, 'older-1');
  assert.equal(projected.messages[0].toolInput, undefined);
  assert.equal(projected.messages[0].images, undefined);
  assert.deepEqual(
    (projected.messages[0] as NormalizedMessage & { deferredPayload: { fields: string[] } }).deferredPayload.fields,
    ['images', 'toolInput', 'toolResult.toolUseResult'],
  );
});

test('light projector preserves display-critical scalar and local-command fields', () => {
  const projected = projectLightHistory(baseResult([{
    id: 'local-1', sessionId: 's1', timestamp: '2026-09-04T00:00:00Z', provider: 'claude',
    kind: 'text', role: 'assistant', content: '', displayText: '/compact completed',
    commandName: 'compact', commandMessage: 'completed', commandArgs: '--keep',
    isLocalCommand: true, isLocalCommandStdout: false, isCompactSummary: true,
    model: 'claude-opus-5', transcriptMessageId: 'transcript-1', isFinalAnswer: true,
    taskStatus: 'completed', imagesOmitted: 2, code: 'safe-code', staleSessionId: 'old-1',
  }]));
  assert.deepEqual(projected.messages[0], {
    id: 'local-1', sessionId: 's1', timestamp: '2026-09-04T00:00:00Z', provider: 'claude',
    kind: 'text', role: 'assistant', content: '', displayText: '/compact completed',
    commandName: 'compact', commandMessage: 'completed', commandArgs: '--keep',
    isLocalCommand: true, isLocalCommandStdout: false, isCompactSummary: true,
    model: 'claude-opus-5', transcriptMessageId: 'transcript-1', isFinalAnswer: true,
    taskStatus: 'completed', imagesOmitted: 2, code: 'safe-code', staleSessionId: 'old-1',
  });
});

test('light projector keeps the B-1078 displayClientMsgId render pairing next to clientMsgId', () => {
  const row = (extra: Partial<NormalizedMessage>): NormalizedMessage => ({
    id: 'u1', sessionId: 's1', timestamp: '2026-09-11T00:00:00Z', provider: 'claude',
    kind: 'text', role: 'user', content: 'hello ', ...extra,
  });
  assert.equal(projectLightHistory(baseResult([row({ displayClientMsgId: 'cmid_a' })])).messages[0].displayClientMsgId, 'cmid_a');
  const both = projectLightHistory(baseResult([row({ displayClientMsgId: 'cmid_a', clientMsgId: 'cmid_a' })])).messages[0];
  assert.equal(both.displayClientMsgId, 'cmid_a'); assert.equal(both.clientMsgId, 'cmid_a');
  assert.equal('displayClientMsgId' in projectLightHistory(baseResult([row({})])).messages[0], false);
});

test('light projector never returns standalone data URIs or oversized unknown nested payloads', () => {
  const projected = projectLightHistory(baseResult([{
    id: 'm', sessionId: 's', timestamp: 'now', provider: 'gemini', kind: 'text', role: 'assistant',
    content: 'data:image/png;base64,AAAA', providerPayload: { blob: 'x'.repeat(100_000) },
  }]));
  assert.equal(projected.messages[0].content, undefined);
  assert.equal(projected.messages[0].providerPayload, undefined);
  const fields = (projected.messages[0] as NormalizedMessage & { deferredPayload: { fields: string[] } })
    .deferredPayload.fields;
  assert.deepEqual(fields, ['content', 'providerPayload']);
});

test('projector contract is provider-neutral across the registered history matrix', () => {
  const providers: LLMProvider[] = [
    'claude', 'codex', 'cursor', 'gemini', 'antigravity', 'opencode', 'hermes',
    'kimi', 'deepseek', 'glm', 'qwen',
  ];
  for (const provider of providers) {
    const projected = projectLightHistory(baseResult([{
      id: `${provider}-1`, sessionId: 's', timestamp: 'now', provider, kind: 'text', content: provider,
    }]));
    assert.equal(projected.messages[0].provider, provider);
    assert.equal(projected.messages[0].content, provider);
  }
});

test('snapshot loader coalesces inflight reads, caches by fingerprint and changes revision after mutation', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'light-history-cache-'));
  const transcript = path.join(dir, 'history.jsonl');
  await fsp.writeFile(transcript, 'one\n');
  let reads = 0;
  const load = async () => {
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return baseResult([]);
  };
  const input = {
    sessionId: 's', requesterUserId: 7,
    source: { provider: 'claude' as const, projectPath: '/p', jsonlPath: transcript, updatedAt: 'now' },
    pageKey: '[20,0,null]', load,
  };
  try {
    const [first, second] = await Promise.all([
      loadStableHistorySnapshot(input), loadStableHistorySnapshot(input),
    ]);
    assert.equal(reads, 1);
    assert.equal(first.revision, second.revision);
    await loadStableHistorySnapshot(input);
    assert.equal(reads, 1, 'stable source uses the bounded TTL cache');

    await new Promise((resolve) => setTimeout(resolve, 2));
    await fsp.appendFile(transcript, 'two\n');
    const changed = await loadStableHistorySnapshot(input);
    assert.equal(reads, 2);
    assert.notEqual(changed.revision, first.revision);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('snapshot loader retries one torn read then fails closed with 409', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'light-history-torn-'));
  const transcript = path.join(dir, 'history.jsonl');
  await fsp.writeFile(transcript, 'zero\n');
  let reads = 0;
  try {
    await assert.rejects(
      loadStableHistorySnapshot({
        sessionId: 'torn', requesterUserId: 7,
        source: { provider: 'claude', projectPath: '/p', jsonlPath: transcript, updatedAt: 'now' },
        pageKey: 'page',
        load: async () => {
          reads += 1;
          await fsp.appendFile(transcript, `${reads}\n`);
          return baseResult([]);
        },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'HISTORY_REVISION_CHANGED');
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        return true;
      },
    );
    assert.equal(reads, 2);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('feature flag is strict and defaults off', () => {
  assert.equal(isLightHistoryEnabled({}), false);
  assert.equal(isLightHistoryEnabled({ NASSAJ_LIGHT_HISTORY_ENABLED: 'true' }), false);
  assert.equal(isLightHistoryEnabled({ NASSAJ_LIGHT_HISTORY_ENABLED: '1' }), true);
});

test('projector enforces a final serialized byte budget', () => {
  const messages = Array.from({ length: 500 }, (_, index) => ({
    id: `${index}-${'i'.repeat(16_000)}`,
    sessionId: 's', timestamp: 'now', provider: 'claude' as const, kind: 'status' as const,
    status: 's'.repeat(16_000),
  }));
  assert.throws(
    () => projectLightHistory(baseResult(messages)),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'LIGHT_HISTORY_PAYLOAD_TOO_LARGE');
      assert.equal((error as { statusCode?: number }).statusCode, 413);
      return true;
    },
  );
});
