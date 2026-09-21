import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  conversationUsageSnapshotsDb,
  getConnection,
  initializeDatabase,
  MAX_USAGE_PARTIAL_TAIL_BYTES,
  sessionsDb,
  stopReconcileScheduler,
  usageIngestionDb,
} from '@/modules/database/index.js';
import {
  resumeUsageIngestionBackfill,
  startUsageIngestionBackfill,
} from '@/modules/providers/services/cost/usage-ingestion.scheduler.js';

async function withDatabase(run: (directory: string) => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'usage-ingestion-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'db.sqlite');
  await initializeDatabase();
  stopReconcileScheduler();
  try {
    await run(directory);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('usage v2 migration is additive and idempotent', async () => {
  await withDatabase(async () => {
    const names = new Set(
      (getConnection().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name),
    );
    for (const table of [
      'usage_source_checkpoints',
      'usage_request_events',
      'usage_source_links',
      'usage_duration_events',
      'usage_backfill_generations',
      'conversation_usage_snapshots',
      'project_cost_daily',
    ]) {
      assert.ok(names.has(table), `${table} was not migrated`);
    }
    await initializeDatabase();
  });
});

test('checkpoint CAS rejects stale writers, supports reset generation, and bounds partial tails', async () => {
  await withDatabase(() => {
    assert.equal(usageIngestionDb.createCheckpoint({
      sourceKey: 'claude:/one.jsonl', provider: 'claude', sourcePath: '/one.jsonl',
      deviceId: '1', inode: '2', parserVersion: 3,
    }), true);
    assert.equal(usageIngestionDb.advanceCheckpointCas({
      sourceKey: 'claude:/one.jsonl', expectedGeneration: 0, expectedOffsetBytes: 0,
      nextOffsetBytes: 100, partialTail: '{"partial":', observedSizeBytes: 110,
    }), true);
    assert.equal(usageIngestionDb.advanceCheckpointCas({
      sourceKey: 'claude:/one.jsonl', expectedGeneration: 0, expectedOffsetBytes: 0,
      nextOffsetBytes: 101, partialTail: '',
    }), false, 'a stale offset must CAS-miss');
    assert.equal(usageIngestionDb.resetCheckpointCas({
      sourceKey: 'claude:/one.jsonl', expectedGeneration: 0, provider: 'claude',
      sourcePath: '/one.jsonl', deviceId: '1', inode: '9', parserVersion: 4,
    }), true);
    assert.equal(usageIngestionDb.getCheckpoint('claude:/one.jsonl')?.generation, 1);
    assert.throws(() => usageIngestionDb.advanceCheckpointCas({
      sourceKey: 'claude:/one.jsonl', expectedGeneration: 1, expectedOffsetBytes: 0,
      nextOffsetBytes: 1, partialTail: 'x'.repeat(MAX_USAGE_PARTIAL_TAIL_BYTES + 1),
    }), /partialTail exceeds/);
  });
});

test('logical request dedupe collapses parent/child copies while preserving attribution scopes', async () => {
  await withDatabase(() => {
    const base = {
      sourceGeneration: 0, byteStart: 10, byteEnd: 20, occurredAt: '2026-08-17T00:00:00Z',
      provider: 'claude', sessionId: 'session-1', requestKey: 'req-1', inputTokens: 7,
      attributionScope: 'conversation' as const, attributionKind: 'coordinator' as const,
    };
    assert.equal(usageIngestionDb.insertRequestEvent({
      ...base, eventId: 'physical-parent', sourceKey: 'parent',
    }), true);
    assert.equal(usageIngestionDb.insertRequestEvent({
      ...base, eventId: 'physical-child', sourceKey: 'child',
    }), true, 'alternate physical provenance is retained');
    assert.equal(usageIngestionDb.insertRequestEvent({
      ...base, eventId: 'physical-child', sourceKey: 'child',
    }), false, 'the same physical occurrence is idempotent');
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS n FROM usage_request_events').get() as { n: number }).n, 1);
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS n FROM usage_request_occurrences').get() as { n: number }).n, 2);
    assert.equal(usageIngestionDb.insertRequestEvent({
      ...base, eventId: 'physical-scope', sourceKey: 'child', byteStart: 21, byteEnd: 30,
      attributionScope: 'agent',
    }), true, 'the same kind/id in a distinct scope is a distinct logical fact');
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS n FROM usage_request_events').get() as { n: number }).n, 2);

    usageIngestionDb.purgeSourceGenerationsBefore('parent', 1);
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS n FROM usage_request_events').get() as { n: number }).n, 2,
      'purging parent provenance preserves facts backed by child occurrences');
    usageIngestionDb.purgeSourceGenerationsBefore('child', 1);
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS n FROM usage_request_events').get() as { n: number }).n, 0,
      'a fact is removed only after its last occurrence is purged');
  });
});

test('conversation snapshots use attribution composite identity and revision CAS', async () => {
  await withDatabase(() => {
    const snapshot = {
      sessionId: 'session-1', attributionKind: 'coordinator' as const, attributionId: '',
      attributionScope: 'conversation' as const,
      provider: 'claude', generation: 2, snapshotStatus: 'ready' as const,
      measured: true, ingestComplete: true, pricingComplete: false,
      requestCount: 2, outputMaxCount: 1, inputTokens: 10, outputTokens: 5,
      cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 3,
      reportedWorkDurationMs: 900,
    };
    assert.equal(conversationUsageSnapshotsDb.upsertCas(snapshot, null), true);
    assert.equal(conversationUsageSnapshotsDb.upsertCas({ ...snapshot, requestCount: 3 }, null), false);
    assert.equal(conversationUsageSnapshotsDb.upsertCas({ ...snapshot, requestCount: 3 }, 0), true);
    assert.equal(conversationUsageSnapshotsDb.upsertCas({ ...snapshot, requestCount: 4 }, 0), false);
    assert.equal(conversationUsageSnapshotsDb.get(snapshot)?.requestCount, 3);
    assert.equal(conversationUsageSnapshotsDb.upsertCas({
      ...snapshot, attributionScope: 'agent', requestCount: 1,
    }, null), true);
    assert.equal(conversationUsageSnapshotsDb.get({
      sessionId: snapshot.sessionId,
      attributionKind: snapshot.attributionKind,
      attributionId: snapshot.attributionId,
      attributionScope: 'agent',
    })?.requestCount, 1, 'scope participates in snapshot identity');
  });
});

test('source links, durations and backfill generations are idempotent/CAS guarded', async () => {
  await withDatabase(() => {
    assert.equal(usageIngestionDb.insertSourceLink({
      parentSourceKey: 'parent', childSourceKey: 'child', relation: 'subagent', generation: 1,
    }), true);
    assert.equal(usageIngestionDb.insertSourceLink({
      parentSourceKey: 'parent', childSourceKey: 'child', relation: 'subagent', generation: 1,
    }), false);
    assert.equal(usageIngestionDb.insertDurationEvent({
      eventId: 'duration-1', sourceKey: 'parent', sourceGeneration: 1, sessionId: 'session-1',
      kind: 'work_interval', startedAt: '2026-08-17T00:00:00Z', endedAt: '2026-08-17T00:00:01Z',
      durationMs: 1000,
    }), true);
    assert.equal(usageIngestionDb.insertDurationEvent({
      eventId: 'duration-1', sourceKey: 'parent', sourceGeneration: 1,
      kind: 'work_interval', startedAt: 'x', endedAt: 'y', durationMs: 1,
    }), false);
    const generation = usageIngestionDb.createBackfillGeneration(4, 2);
    assert.equal(usageIngestionDb.claimBackfillGeneration(generation), true);
    assert.equal(usageIngestionDb.claimBackfillGeneration(generation), false);
    assert.equal(usageIngestionDb.updateBackfillProgressCas({
      generation, expectedSourcesProcessed: 0, sourcesProcessed: 1, eventsWritten: 2,
      cursorSourceKey: 'claude:/stable/a.jsonl',
    }), true);
    assert.deepEqual(usageIngestionDb.getResumableBackfillGeneration(4), {
      generation,
      parserVersion: 4,
      status: 'running',
      cursorSourceKey: 'claude:/stable/a.jsonl',
      sourcesTotal: 2,
      sourcesProcessed: 1,
      eventsWritten: 2,
    }, 'a restarted worker resumes the durable generation boundary/cursor');
    assert.equal(usageIngestionDb.updateBackfillProgressCas({
      generation, expectedSourcesProcessed: 0, sourcesProcessed: 2, eventsWritten: 3,
    }), false);
    assert.equal(usageIngestionDb.finishBackfillGeneration(generation, 'complete'), true);
    assert.equal(usageIngestionDb.finishBackfillGeneration(generation, 'complete'), false);
  });
});

test('resume-only never creates after completion and partial facts persist without cursor movement', async () => {
  await withDatabase(async () => {
    const previousWriter = process.env.USAGE_INGEST_WRITER;
    const previousBackfill = process.env.USAGE_INGEST_BACKFILL;
    try {
      process.env.USAGE_INGEST_WRITER = 'on';
      process.env.USAGE_INGEST_BACKFILL = 'on';
      const complete = usageIngestionDb.createBackfillGeneration(1, 0);
      assert.equal(usageIngestionDb.claimBackfillGeneration(complete), true);
      assert.equal(usageIngestionDb.finishBackfillGeneration(complete, 'complete'), true);
      const before = (getConnection().prepare('SELECT COUNT(*) AS count FROM usage_backfill_generations')
        .get() as { count: number }).count;
      await resumeUsageIngestionBackfill();
      const after = (getConnection().prepare('SELECT COUNT(*) AS count FROM usage_backfill_generations')
        .get() as { count: number }).count;
      assert.equal(after, before, 'resume-only cannot create a post-completion generation');

      const partial = usageIngestionDb.createBackfillGeneration(2, 2);
      assert.equal(usageIngestionDb.claimBackfillGeneration(partial), true);
      assert.equal(usageIngestionDb.updateBackfillProgressCas({
        generation: partial, expectedSourcesProcessed: 0, sourcesProcessed: 0,
        eventsWritten: 7, cursorSourceKey: null,
      }), true);
      let state = usageIngestionDb.getResumableBackfillGeneration(2)!;
      assert.equal(state.eventsWritten, 7);
      assert.equal(state.sourcesProcessed, 0);
      assert.equal(state.cursorSourceKey, null);
      // Resume reparses the committed prefix idempotently: zero new events must
      // preserve the accumulated count rather than double it.
      assert.equal(usageIngestionDb.updateBackfillProgressCas({
        generation: partial, expectedSourcesProcessed: 0, sourcesProcessed: 0,
        eventsWritten: state.eventsWritten, cursorSourceKey: state.cursorSourceKey,
      }), true);
      state = usageIngestionDb.getResumableBackfillGeneration(2)!;
      assert.equal(state.eventsWritten, 7);
      assert.equal(state.sourcesProcessed, 0);
      assert.equal(state.cursorSourceKey, null);
    } finally {
      if (previousWriter === undefined) delete process.env.USAGE_INGEST_WRITER;
      else process.env.USAGE_INGEST_WRITER = previousWriter;
      if (previousBackfill === undefined) delete process.env.USAGE_INGEST_BACKFILL;
      else process.env.USAGE_INGEST_BACKFILL = previousBackfill;
    }
  });
});

test('resume requested during a partial flight is latched, reruns, and still never creates after completion', async () => {
  await withDatabase(async (directory) => {
    const previousWriter = process.env.USAGE_INGEST_WRITER;
    const previousBackfill = process.env.USAGE_INGEST_BACKFILL;
    try {
      process.env.USAGE_INGEST_WRITER = 'on';
      process.env.USAGE_INGEST_BACKFILL = 'on';
      const transcript = path.join(directory, 'partial-race.jsonl');
      const assistant = JSON.stringify({
        type: 'assistant', timestamp: '2026-08-17T10:00:00.000Z', requestId: 'r1',
        message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 2 } },
      });
      await writeFile(transcript, `${assistant}\n{"type":`);
      sessionsDb.createSession('race-session', 'claude', directory, undefined, undefined, undefined, transcript);

      const first = startUsageIngestionBackfill();
      const latched = resumeUsageIngestionBackfill();
      await Promise.all([first, latched]);
      const running = usageIngestionDb.getResumableBackfillGeneration(1)!;
      assert.equal(running.status, 'running');
      assert.equal(running.sourcesProcessed, 0);
      assert.equal(running.eventsWritten, 1, 'latched rerun preserves deduped cumulative facts');
      const snapshot = conversationUsageSnapshotsDb.get({
        sessionId: 'race-session', attributionKind: 'coordinator', attributionId: '', attributionScope: 'conversation',
      });
      assert.equal((snapshot?.revision ?? 0) >= 2, true, 'latched resume performed a second pass after old flight settled');

      await appendFile(transcript, `"user"}\n`);
      await resumeUsageIngestionBackfill();
      assert.equal(usageIngestionDb.getResumableBackfillGeneration(1), null, 'append resume completes the same generation');
      const countBefore = (getConnection().prepare('SELECT COUNT(*) AS count FROM usage_backfill_generations')
        .get() as { count: number }).count;
      await resumeUsageIngestionBackfill();
      const countAfter = (getConnection().prepare('SELECT COUNT(*) AS count FROM usage_backfill_generations')
        .get() as { count: number }).count;
      assert.equal(countAfter, countBefore, 'resume after completion cannot create a generation');
    } finally {
      if (previousWriter === undefined) delete process.env.USAGE_INGEST_WRITER;
      else process.env.USAGE_INGEST_WRITER = previousWriter;
      if (previousBackfill === undefined) delete process.env.USAGE_INGEST_BACKFILL;
      else process.env.USAGE_INGEST_BACKFILL = previousBackfill;
    }
  });
});
