// FIRST import — HOME becomes a /var/tmp sandbox before any provider root is computed.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
import {
  claudeHeaderLine,
  claudeProjectsRoot,
  codexSessionsRoot,
} from './__tests__/bound-transcripts.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

/**
 * ADR-201 A-P2c: ingestion binds every source to its session, so transcripts
 * live in sandbox provider roots, named after their id, with an id header.
 */
type Layout = { claudeFile(sessionId: string): string; codexFile(threadId: string): string };

async function withEnvironment(run: (root: string, layout: Layout) => Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const previousWriter = process.env.USAGE_INGEST_WRITER;
  const previousReader = process.env.CONVERSATION_SNAPSHOT_READER;
  const root = await mkdtemp(path.join(os.tmpdir(), 'usage-writer-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(root, 'db.sqlite');
  await initializeDatabase();
  stopReconcileScheduler();
  const claudeDir = path.join(claudeProjectsRoot(), path.basename(root));
  const codexDir = path.join(codexSessionsRoot(), path.basename(root));
  await Promise.all([mkdir(claudeDir, { recursive: true }), mkdir(codexDir, { recursive: true })]);
  const layout: Layout = {
    claudeFile: (sessionId) => path.join(claudeDir, `${sessionId}.jsonl`),
    codexFile: (threadId) => path.join(codexDir, `rollout-2026-08-17T10-00-00-${threadId}.jsonl`),
  };
  try {
    await run(root, layout);
  } finally {
    await rm(claudeDir, { recursive: true, force: true });
    await rm(codexDir, { recursive: true, force: true });
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
  await withEnvironment(async (root, layout) => {
    process.env.USAGE_INGEST_WRITER = 'shadow';
    const transcript = layout.claudeFile('claude-1');
    await writeFile(transcript, `${claudeHeaderLine('claude-1')}${claudeLine(5)}\n${claudeLine(20)}`);

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
    const legacy = calculateSessionCost(await extractClaudeSessionUsage({ sessionId: 'claude-1', transcriptPath: transcript }));
    assert.equal(ledger.perModel[0].tokens.output, 20);
    assert.deepEqual(ledger.perModel, legacy.perModel, 'shadow snapshot يطابق legacy على facts نفسها');
    assert.equal(ledger.totalUsd, legacy.totalUsd);
  });
});

test('Codex stores latest cumulative counters and rebuilds after truncation', async () => {
  await withEnvironment(async (root, layout) => {
    process.env.USAGE_INGEST_WRITER = 'on';
    const threadId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const transcript = layout.codexFile(threadId);
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
      sessionId: threadId, provider: 'codex', transcriptPath: transcript, manifest,
    });
    await appendFile(transcript, `${tokens(25, 7)}\n`);
    manifest = await resolveCodexLinkedRollouts(transcript);
    await ingestConversationUsage({
      sessionId: threadId, provider: 'codex', transcriptPath: transcript, manifest,
    });
    let ledger = readConversationUsageSnapshot(threadId)!.cost;
    const legacy = calculateSessionCost(await extractCodexConversationUsage({ sessionId: threadId, transcriptPath: transcript }, undefined, { manifest }));
    assert.equal(ledger.perModel[0].tokens.input, 25);
    assert.equal(ledger.perModel[0].tokens.output, 7);
    assert.deepEqual(ledger.perModel, legacy.perModel, 'Codex cumulative snapshot يطابق legacy');

    await writeFile(transcript, `${meta}\n${tokens(3, 1)}\n`);
    manifest = await resolveCodexLinkedRollouts(transcript);
    await ingestConversationUsage({
      sessionId: threadId, provider: 'codex', transcriptPath: transcript, manifest,
    });
    const sourceKey = `codex:${await realpath(transcript)}`;
    assert.equal(usageIngestionDb.getCheckpoint(sourceKey)?.generation, 1);
    ledger = readConversationUsageSnapshot(threadId)!.cost;
    assert.equal(ledger.perModel[0].tokens.input, 3);

    const replacement = path.join(path.dirname(transcript), 'replacement.jsonl');
    await writeFile(replacement, `${meta}\n${tokens(4, 1)}\n`);
    await rename(replacement, transcript);
    manifest = await resolveCodexLinkedRollouts(transcript);
    await ingestConversationUsage({
      sessionId: threadId, provider: 'codex', transcriptPath: transcript, manifest,
    });
    assert.equal(usageIngestionDb.getCheckpoint(sourceKey)?.generation, 2, 'استبدال inode يعيد البناء');
    assert.equal(readConversationUsageSnapshot(threadId)?.cost.perModel[0].tokens.input, 4);

    await writeFile(transcript, `${meta}\n${tokens(8, 1)}\n`);
    manifest = await resolveCodexLinkedRollouts(transcript);
    await ingestConversationUsage({
      sessionId: threadId, provider: 'codex', transcriptPath: transcript, manifest,
    });
    assert.equal(usageIngestionDb.getCheckpoint(sourceKey)?.generation, 3, 'إعادة كتابة بنفس inode والحجم يبطل boundary hash');
    assert.equal(readConversationUsageSnapshot(threadId)?.cost.perModel[0].tokens.input, 8);

    await ingestConversationUsage({
      sessionId: threadId, provider: 'codex', transcriptPath: transcript, manifest, parserVersion: 2,
    });
    assert.equal(usageIngestionDb.getCheckpoint(sourceKey)?.generation, 4, 'تغيير parser version يعيد البناء');
  });
});

test('full committed-prefix fingerprint detects a same-size rewrite in the middle beyond 128KiB', async () => {
  await withEnvironment(async (root, layout) => {
    process.env.USAGE_INGEST_WRITER = 'on';
    const transcript = layout.claudeFile('large-claude');
    const padding = JSON.stringify({ type: 'user', payload: 'a'.repeat(180 * 1024) });
    await writeFile(transcript, `${claudeHeaderLine('large-claude')}${padding}\n${claudeLine(5)}\n`);
    await ingestConversationUsage({ sessionId: 'large-claude', provider: 'claude', transcriptPath: transcript });
    const sourceKey = `claude:${await realpath(transcript)}`;
    assert.equal(usageIngestionDb.getCheckpoint(sourceKey)?.generation, 0);
    const header = claudeHeaderLine('large-claude');
    const rewritten = `${header}${padding.slice(0, 90 * 1024)}b${padding.slice(90 * 1024 + 1)}\n${claudeLine(5)}\n`;
    assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(`${header}${padding}\n${claudeLine(5)}\n`));
    await writeFile(transcript, rewritten);
    await ingestConversationUsage({ sessionId: 'large-claude', provider: 'claude', transcriptPath: transcript });
    assert.equal(usageIngestionDb.getCheckpoint(sourceKey)?.generation, 1);
  });
});

test('append fingerprint preserves old fixed chunks and only recomputes the bounded tail', async () => {
  await withEnvironment(async (root, layout) => {
    process.env.USAGE_INGEST_WRITER = 'on';
    const transcript = layout.claudeFile('large-append');
    const padding = JSON.stringify({ type: 'user', payload: 'x'.repeat(2200 * 1024) });
    await writeFile(transcript, `${claudeHeaderLine('large-append')}${padding}\n${claudeLine(2)}\n`);
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
  await withEnvironment(async (root, layout) => {
    process.env.USAGE_INGEST_WRITER = 'on';
    const transcript = layout.claudeFile('multi-chunk');
    const paddingLine = `${JSON.stringify({ type: 'user', payload: 'p'.repeat(16 * 1024) })}\n`;
    await writeFile(transcript, `${claudeHeaderLine('multi-chunk')}${paddingLine.repeat(270)}${claudeLine(9)}\n`);
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
  await withEnvironment(async (root, layout) => {
    process.env.USAGE_INGEST_WRITER = 'on';
    const expected = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const transcript = layout.claudeFile(expected);
    await writeFile(transcript, `${claudeLine(2)}\n`);
    await assert.rejects(ingestConversationUsage({
      sessionId: expected, provider: 'claude', transcriptPath: transcript,
    }), { name: 'TranscriptRefusedError', reason: 'header_missing' });
    const mismatched = { ...JSON.parse(claudeLine(2)), sessionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' };
    await writeFile(transcript, `${JSON.stringify(mismatched)}\n`);
    await assert.rejects(ingestConversationUsage({
      sessionId: expected, provider: 'claude', transcriptPath: transcript,
    }), { name: 'TranscriptRefusedError', reason: 'id_mismatch' });
    assert.equal(usageIngestionDb.listConversationFacts(expected).length, 0);
  });
});

test('ordinary nested JSON cannot masquerade as a duration event', async () => {
  await withEnvironment(async (root, layout) => {
    process.env.USAGE_INGEST_WRITER = 'on';
    const transcript = layout.claudeFile('duration-test');
    const ordinary = JSON.stringify({
      type: 'user', timestamp: '2026-08-17T10:00:00.000Z',
      payload: { id: 'ordinary-record', agentId: 'looks-like-agent', totalDurationMs: 999_999 },
    });
    await writeFile(transcript, `${claudeHeaderLine('duration-test')}${ordinary}\n${claudeLine(2)}\n`);
    await ingestConversationUsage({ sessionId: 'duration-test', provider: 'claude', transcriptPath: transcript });
    assert.equal(readConversationUsageSnapshot('duration-test')?.snapshot.reportedWorkDurationMs, null);
  });
});

test('trusted structured tool-result duration is accepted and included', async () => {
  await withEnvironment(async (root, layout) => {
    process.env.USAGE_INGEST_WRITER = 'on';
    const transcript = layout.claudeFile('trusted-duration');
    const result = JSON.stringify({
      type: 'user', timestamp: '2026-08-17T10:00:01.000Z',
      payload: {
        type: 'tool_result', id: 'tool-result-1', agentId: 'agent-1', totalDurationMs: 1_250,
      },
    });
    await writeFile(transcript, `${claudeHeaderLine('trusted-duration')}${result}\n${claudeLine(2)}\n`);
    await ingestConversationUsage({
      sessionId: 'trusted-duration', provider: 'claude', transcriptPath: transcript,
    });
    assert.equal(readConversationUsageSnapshot('trusted-duration')?.snapshot.reportedWorkDurationMs, 1_250);
  });
});

test('shadow fixture parity and source CAS keep one logical fact under concurrent ingestion', async () => {
  await withEnvironment(async (root, layout) => {
    process.env.USAGE_INGEST_WRITER = 'shadow';
    const transcript = layout.claudeFile('fixture-parity');
    await writeFile(transcript, claudeHeaderLine('fixture-parity') + await readFile(path.join(FIXTURES, 'claude-parent.jsonl'), 'utf8'));
    const context = { sessionId: 'fixture-parity', provider: 'claude' as const, transcriptPath: transcript };
    const results = await Promise.allSettled([
      ingestConversationUsage(context),
      ingestConversationUsage(context),
    ]);
    assert.ok(results.some((result) => result.status === 'fulfilled'), 'كاتب واحد على الأقل يفوز بـCAS');
    const legacy = calculateSessionCost(await extractClaudeSessionUsage({ sessionId: 'fixture-parity', transcriptPath: transcript }));
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

// ---------------------------------------------------------------------------
// ADR-201 A-P2c — ingestion never attributes a file not bound to the session
// ---------------------------------------------------------------------------

test('A-P2c: forged header, wrong name, other tree and symlink are refused before any fact', async () => {
  await withEnvironment(async (_root, layout) => {
    process.env.USAGE_INGEST_WRITER = 'on';
    const victim = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const refuse = async (transcriptPath: string, reason: string) => {
      await assert.rejects(ingestConversationUsage({ sessionId: victim, provider: 'claude', transcriptPath }),
        { name: 'TranscriptRefusedError', reason });
      assert.equal(usageIngestionDb.listConversationFacts(victim).length, 0);
    };
    const forged = layout.claudeFile(victim);
    await writeFile(forged, `${claudeHeaderLine('dddddddd-dddd-4ddd-8ddd-dddddddddddd')}${claudeLine(9)}\n`);
    await refuse(forged, 'id_mismatch');

    const misnamed = path.join(path.dirname(forged), 'misnamed.jsonl');
    await writeFile(misnamed, `${claudeHeaderLine(victim)}${claudeLine(9)}\n`);
    await refuse(misnamed, 'name_mismatch');

    const one = path.join(claudeProjectsRoot('1'), 'ingest-prefix');
    const ten = path.join(claudeProjectsRoot('10'), 'ingest-prefix');
    try {
      await mkdir(one, { recursive: true });
      await mkdir(path.dirname(ten), { recursive: true });
      await writeFile(path.join(one, `${victim}.jsonl`), `${claudeHeaderLine(victim)}${claudeLine(9)}\n`);
      await symlink(one, ten);
      await refuse(path.join(ten, `${victim}.jsonl`), 'outside_tree');
    } finally {
      await rm(one, { recursive: true, force: true });
      await rm(ten, { force: true });
    }
  });
});

test('A-P2c: a subagent file carrying another session id is skipped and marks the snapshot incomplete', async () => {
  await withEnvironment(async (_root, layout) => {
    process.env.USAGE_INGEST_WRITER = 'on';
    const sessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const transcript = layout.claudeFile(sessionId);
    await writeFile(transcript, `${claudeHeaderLine(sessionId)}${claudeLine(2)}\n`);
    const subagents = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
    await mkdir(subagents, { recursive: true });
    const foreign = JSON.stringify({ ...JSON.parse(claudeLine(500)), requestId: 'r-foreign', message: {
      ...JSON.parse(claudeLine(500)).message, id: 'm-foreign' } });
    await writeFile(path.join(subagents, 'agent-forged.jsonl'),
      `${claudeHeaderLine('ffffffff-ffff-4fff-8fff-ffffffffffff')}${foreign}\n`);
    await symlink(path.join(subagents, 'agent-forged.jsonl'), path.join(subagents, 'agent-link.jsonl'));

    const outcome = await ingestConversationUsage({ sessionId, provider: 'claude', transcriptPath: transcript });
    assert.equal(outcome.ingestComplete, false);
    const ledger = readConversationUsageSnapshot(sessionId)!.cost;
    assert.equal(ledger.perModel[0].tokens.output, 2, 'only the bound parent is counted');
  });
});
