import assert from 'node:assert/strict';
import { appendFile, copyFile, mkdtemp, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  closeConnection,
  conversationUsageSnapshotsDb,
  initializeDatabase,
  stopReconcileScheduler,
  usageIngestionDb,
} from '@/modules/database/index.js';
import { resolveCodexLinkedRollouts } from '@/modules/providers/list/codex/codex-rollout-links.js';
import { calculateSessionCost } from '@/modules/providers/services/cost/cost-calculator.js';
import {
  extractClaudeSessionUsage,
  extractCodexConversationUsage,
} from '@/modules/providers/services/cost/usage-extractors.js';

import {
  conversationSnapshotReaderMode,
  ingestConversationUsage,
  readConversationUsageSnapshot,
  usageIngestWriterMode,
} from './usage-ingestion.service.js';
import { UsageIngestionScheduler } from './usage-ingestion.scheduler.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

async function withEnvironment(run: (root: string) => Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousWriter = process.env.USAGE_INGEST_WRITER;
  const previousReader = process.env.CONVERSATION_SNAPSHOT_READER;
  const root = await mkdtemp(path.join(os.tmpdir(), 'usage-writer-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'db.sqlite');
  await initializeDatabase();
  stopReconcileScheduler();
  try {
    await run(root);
  } finally {
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousWriter === undefined) delete process.env.USAGE_INGEST_WRITER;
    else process.env.USAGE_INGEST_WRITER = previousWriter;
    if (previousReader === undefined) delete process.env.CONVERSATION_SNAPSHOT_READER;
    else process.env.CONVERSATION_SNAPSHOT_READER = previousReader;
    await rm(root, { recursive: true, force: true });
  }
}

const claudeLine = (outputTokens: number): string => JSON.stringify({
  type: 'assistant',
  timestamp: '2026-08-17T10:00:00.000Z',
  requestId: 'request-1',
  message: {
    id: 'message-1',
    model: 'claude-opus-5',
    usage: { input_tokens: 3, output_tokens: outputTokens, cache_read_input_tokens: 2 },
  },
});

test('flags are fail-closed and shadow never becomes a reader implicitly', () => {
  const writer = process.env.USAGE_INGEST_WRITER;
  const reader = process.env.CONVERSATION_SNAPSHOT_READER;
  try {
    process.env.USAGE_INGEST_WRITER = 'unexpected';
    process.env.CONVERSATION_SNAPSHOT_READER = 'unexpected';
    assert.equal(usageIngestWriterMode(), 'off');
    assert.equal(conversationSnapshotReaderMode(), 'legacy');
    process.env.USAGE_INGEST_WRITER = 'shadow';
    assert.equal(usageIngestWriterMode(), 'shadow');
    assert.equal(conversationSnapshotReaderMode(), 'legacy');
  } finally {
    if (writer === undefined) delete process.env.USAGE_INGEST_WRITER;
    else process.env.USAGE_INGEST_WRITER = writer;
    if (reader === undefined) delete process.env.CONVERSATION_SNAPSHOT_READER;
    else process.env.CONVERSATION_SNAPSHOT_READER = reader;
  }
});

test('Claude shadow writer resumes offset+tail and merges duplicate output by max', async () => {
  await withEnvironment(async (root) => {
    process.env.USAGE_INGEST_WRITER = 'shadow';
    const transcript = path.join(root, 'claude.jsonl');
    await writeFile(transcript, `${claudeLine(5)}\n${claudeLine(20)}`);

    await ingestConversationUsage({ sessionId: 'claude-1', provider: 'claude', transcriptPath: transcript });
    let snapshot = conversationUsageSnapshotsDb.get({
      sessionId: 'claude-1', attributionKind: 'coordinator', attributionId: '', attributionScope: 'conversation',
    });
    assert.equal(snapshot?.snapshotStatus, 'stale');
    assert.equal(snapshot?.outputTokens, 5);
    assert.equal(snapshot?.requestCount, 1);

    await appendFile(transcript, '\n');
    await ingestConversationUsage({ sessionId: 'claude-1', provider: 'claude', transcriptPath: transcript });
    snapshot = conversationUsageSnapshotsDb.get({
      sessionId: 'claude-1', attributionKind: 'coordinator', attributionId: '', attributionScope: 'conversation',
    });
    assert.equal(snapshot?.snapshotStatus, 'ready');
    assert.equal(snapshot?.outputTokens, 20);
    assert.equal(snapshot?.requestCount, 1);
    const ledger = readConversationUsageSnapshot('claude-1')!.cost;
    const legacy = calculateSessionCost(await extractClaudeSessionUsage(transcript));
    assert.equal(ledger.perModel[0].tokens.output, 20);
    assert.deepEqual(ledger.perModel, legacy.perModel, 'shadow snapshot يطابق legacy على facts نفسها');
    assert.equal(ledger.totalUsd, legacy.totalUsd);
  });
});

test('Codex stores latest cumulative counters and rebuilds after truncation', async () => {
  await withEnvironment(async (root) => {
    process.env.USAGE_INGEST_WRITER = 'on';
    const threadId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const transcript = path.join(root, `rollout-${threadId}.jsonl`);
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, session_id: threadId, thread_source: 'user', model: 'gpt-5.2-codex' },
    });
    const tokens = (input: number, output: number) => JSON.stringify({
      timestamp: '2026-08-17T10:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output } } },
    });
    await writeFile(transcript, `${meta}\n${tokens(10, 2)}\n`);
    let manifest = await resolveCodexLinkedRollouts(transcript);
    await ingestConversationUsage({
      sessionId: 'codex-1', provider: 'codex', transcriptPath: transcript, manifest,
    });
    await appendFile(transcript, `${tokens(25, 7)}\n`);
    manifest = await resolveCodexLinkedRollouts(transcript);
    await ingestConversationUsage({
      sessionId: 'codex-1', provider: 'codex', transcriptPath: transcript, manifest,
    });
    let ledger = readConversationUsageSnapshot('codex-1')!.cost;
    const legacy = calculateSessionCost(await extractCodexConversationUsage(transcript, undefined, { manifest }));
    assert.equal(ledger.perModel[0].tokens.input, 25);
    assert.equal(ledger.perModel[0].tokens.output, 7);
    assert.deepEqual(ledger.perModel, legacy.perModel, 'Codex cumulative snapshot يطابق legacy');

    await writeFile(transcript, `${meta}\n${tokens(3, 1)}\n`);
    manifest = await resolveCodexLinkedRollouts(transcript);
    await ingestConversationUsage({
      sessionId: 'codex-1', provider: 'codex', transcriptPath: transcript, manifest,
    });
    const sourceKey = `codex:${await realpath(transcript)}`;
    assert.equal(usageIngestionDb.getCheckpoint(sourceKey)?.generation, 1);
    ledger = readConversationUsageSnapshot('codex-1')!.cost;
    assert.equal(ledger.perModel[0].tokens.input, 3);

    const replacement = path.join(root, 'replacement.jsonl');
    await writeFile(replacement, `${meta}\n${tokens(4, 1)}\n`);
    await rename(replacement, transcript);
    manifest = await resolveCodexLinkedRollouts(transcript);
    await ingestConversationUsage({
      sessionId: 'codex-1', provider: 'codex', transcriptPath: transcript, manifest,
    });
    assert.equal(usageIngestionDb.getCheckpoint(sourceKey)?.generation, 2, 'استبدال inode يعيد البناء');
    assert.equal(readConversationUsageSnapshot('codex-1')?.cost.perModel[0].tokens.input, 4);

    await writeFile(transcript, `${meta}\n${tokens(8, 1)}\n`);
    manifest = await resolveCodexLinkedRollouts(transcript);
    await ingestConversationUsage({
      sessionId: 'codex-1', provider: 'codex', transcriptPath: transcript, manifest,
    });
    assert.equal(usageIngestionDb.getCheckpoint(sourceKey)?.generation, 3, 'إعادة كتابة بنفس inode والحجم يبطل boundary hash');
    assert.equal(readConversationUsageSnapshot('codex-1')?.cost.perModel[0].tokens.input, 8);

    await ingestConversationUsage({
      sessionId: 'codex-1', provider: 'codex', transcriptPath: transcript, manifest, parserVersion: 2,
    });
    assert.equal(usageIngestionDb.getCheckpoint(sourceKey)?.generation, 4, 'تغيير parser version يعيد البناء');
  });
});

test('full committed-prefix fingerprint detects a same-size rewrite in the middle beyond 128KiB', async () => {
  await withEnvironment(async (root) => {
    process.env.USAGE_INGEST_WRITER = 'on';
    const transcript = path.join(root, 'large-claude.jsonl');
    const padding = JSON.stringify({ type: 'user', payload: 'a'.repeat(180 * 1024) });
    await writeFile(transcript, `${padding}\n${claudeLine(5)}\n`);
    await ingestConversationUsage({ sessionId: 'large-claude', provider: 'claude', transcriptPath: transcript });
    const sourceKey = `claude:${await realpath(transcript)}`;
    assert.equal(usageIngestionDb.getCheckpoint(sourceKey)?.generation, 0);
    const rewritten = `${padding.slice(0, 90 * 1024)}b${padding.slice(90 * 1024 + 1)}\n${claudeLine(5)}\n`;
    assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(`${padding}\n${claudeLine(5)}\n`));
    await writeFile(transcript, rewritten);
    await ingestConversationUsage({ sessionId: 'large-claude', provider: 'claude', transcriptPath: transcript });
    assert.equal(usageIngestionDb.getCheckpoint(sourceKey)?.generation, 1);
  });
});

test('append fingerprint preserves old fixed chunks and only recomputes the bounded tail', async () => {
  await withEnvironment(async (root) => {
    process.env.USAGE_INGEST_WRITER = 'on';
    const transcript = path.join(root, 'large-append.jsonl');
    const padding = JSON.stringify({ type: 'user', payload: 'x'.repeat(2200 * 1024) });
    await writeFile(transcript, `${padding}\n${claudeLine(2)}\n`);
    await ingestConversationUsage({ sessionId: 'large-append', provider: 'claude', transcriptPath: transcript });
    const sourceKey = `claude:${await realpath(transcript)}`;
    const before = JSON.parse(usageIngestionDb.getCheckpoint(sourceKey)?.boundaryHash ?? '[]') as string[];
    assert.equal(before.length >= 3, true);
    await appendFile(transcript, `${claudeLine(3)}\n`);
    await ingestConversationUsage({ sessionId: 'large-append', provider: 'claude', transcriptPath: transcript });
    const after = JSON.parse(usageIngestionDb.getCheckpoint(sourceKey)?.boundaryHash ?? '[]') as string[];
    assert.deepEqual(after.slice(0, 2), before.slice(0, 2), 'completed 1MiB chunks are not reread/rehashed on append');
  });
});

test('scheduler fairly continues a stable transcript larger than 4MiB until caught up', async () => {
  await withEnvironment(async (root) => {
    process.env.USAGE_INGEST_WRITER = 'on';
    const transcript = path.join(root, 'multi-chunk.jsonl');
    const paddingLine = `${JSON.stringify({ type: 'user', payload: 'p'.repeat(16 * 1024) })}\n`;
    await writeFile(transcript, `${paddingLine.repeat(270)}${claudeLine(9)}\n`);
    assert.equal((await stat(transcript)).size > 4 * 1024 * 1024, true);
    let passes = 0;
    const scheduler = new UsageIngestionScheduler({
      writerMode: () => 'on', concurrency: 1,
      resolveContext: async () => ({
        sessionId: 'multi-chunk', provider: 'claude', transcriptPath: transcript,
      }),
      ingest: async (value) => { passes += 1; return ingestConversationUsage(value); },
    });
    const outcome = await scheduler.schedule({
      provider: 'claude', filePath: transcript, sessionId: 'multi-chunk',
    });
    assert.equal(outcome?.caughtUp, true);
    assert.equal(passes, 2);
    const checkpoint = usageIngestionDb.getCheckpoint(`claude:${await realpath(transcript)}`);
    assert.equal(checkpoint?.offsetBytes, (await stat(transcript)).size);
  });
});

test('durable session identity is fail-closed when absent or mismatched', async () => {
  await withEnvironment(async (root) => {
    process.env.USAGE_INGEST_WRITER = 'on';
    const expected = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const transcript = path.join(root, 'identity.jsonl');
    await writeFile(transcript, `${claudeLine(2)}\n`);
    await assert.rejects(ingestConversationUsage({
      sessionId: expected, provider: 'claude', transcriptPath: transcript,
    }), /Cannot prove transcript session identity/);
    const mismatched = { ...JSON.parse(claudeLine(2)), sessionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };
    await writeFile(transcript, `${JSON.stringify(mismatched)}\n`);
    await assert.rejects(ingestConversationUsage({
      sessionId: expected, provider: 'claude', transcriptPath: transcript,
    }), /does not match/);
    assert.equal(usageIngestionDb.listConversationFacts(expected).length, 0);
  });
});

test('ordinary nested JSON cannot masquerade as a duration event', async () => {
  await withEnvironment(async (root) => {
    process.env.USAGE_INGEST_WRITER = 'on';
    const transcript = path.join(root, 'duration.jsonl');
    const ordinary = JSON.stringify({
      type: 'user', timestamp: '2026-08-17T10:00:00.000Z',
      payload: { id: 'ordinary-record', agentId: 'looks-like-agent', totalDurationMs: 999_999 },
    });
    await writeFile(transcript, `${ordinary}\n${claudeLine(2)}\n`);
    await ingestConversationUsage({ sessionId: 'duration-test', provider: 'claude', transcriptPath: transcript });
    assert.equal(readConversationUsageSnapshot('duration-test')?.snapshot.reportedWorkDurationMs, null);
  });
});

test('trusted structured tool-result duration is accepted and included', async () => {
  await withEnvironment(async (root) => {
    process.env.USAGE_INGEST_WRITER = 'on';
    const transcript = path.join(root, 'trusted-duration.jsonl');
    const result = JSON.stringify({
      type: 'user', timestamp: '2026-08-17T10:00:01.000Z',
      payload: {
        type: 'tool_result', id: 'tool-result-1', agentId: 'agent-1', totalDurationMs: 1_250,
      },
    });
    await writeFile(transcript, `${result}\n${claudeLine(2)}\n`);
    await ingestConversationUsage({
      sessionId: 'trusted-duration', provider: 'claude', transcriptPath: transcript,
    });
    assert.equal(readConversationUsageSnapshot('trusted-duration')?.snapshot.reportedWorkDurationMs, 1_250);
  });
});

test('shadow fixture parity and source CAS keep one logical fact under concurrent ingestion', async () => {
  await withEnvironment(async (root) => {
    process.env.USAGE_INGEST_WRITER = 'shadow';
    const transcript = path.join(root, 'fixture.jsonl');
    await copyFile(path.join(FIXTURES, 'claude-parent.jsonl'), transcript);
    const context = { sessionId: 'fixture-parity', provider: 'claude' as const, transcriptPath: transcript };
    const results = await Promise.allSettled([
      ingestConversationUsage(context),
      ingestConversationUsage(context),
    ]);
    assert.ok(results.some((result) => result.status === 'fulfilled'), 'كاتب واحد على الأقل يفوز بـCAS');
    const legacy = calculateSessionCost(await extractClaudeSessionUsage(transcript));
    const ledger = readConversationUsageSnapshot('fixture-parity')!.cost;
    assert.deepEqual(ledger.perModel, legacy.perModel);
    assert.equal(ledger.totalUsd, legacy.totalUsd);
    assert.equal(
      usageIngestionDb.listConversationFacts('fixture-parity')[0].requests,
      legacy.perModel[0].requests,
      'CAS المتزامن لا يضاعف facts المنطقية',
    );
  });
});
