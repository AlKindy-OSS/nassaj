// FIRST import — HOME becomes a /var/tmp sandbox before any provider root is computed.
import '@/shared/__tests__/sandbox-home.js';
/**
 * B-1616 (ADR-206 containment): cost and binding of codex-cli 0.160 (multi_agent v2)
 * children.
 *
 * Fixtures `__fixtures__/codex-0160-v2/{parent,child}.jsonl` are derived read-only from
 * a real 2026-10-05 nassaj run on this host (cli 0.160.0, gpt-6.1-sol, 6 children):
 * structure, record order, token counters and the refused-spawn text are real; thread
 * ids are remapped, every free-text field is "[redacted]", account ids, cwd, git and
 * instructions are dropped. The parent keeps one spawned child and one spawn Codex
 * refused at the thread cap (no child).
 *
 * Shape facts the fixtures carry: the child's line 0 is its own session_meta
 * (thread_source "subagent", subagent_history_start_ordinal), line 1 is the PARENT's
 * session_meta (thread_source "user"), then the replayed parent history; the parent
 * links the child only through `item_completed {SubAgentActivity, kind:"started"}`.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeConnection, initializeDatabase, stopReconcileScheduler, usageIngestionDb } from '@/modules/database/index.js';
import {
  readCodexRolloutMetadata,
  resolveCodexLinkedRollouts,
} from '@/modules/providers/list/codex/codex-rollout-links.js';

import { codexSessionsRoot } from './__tests__/bound-transcripts.js';
import { extractCodexConversationUsage, extractCodexSessionUsage } from './usage-extractors.js';
import { ingestConversationUsage, readConversationUsageSnapshot } from './usage-ingestion.service.js';
import { FactArena, preflightWriterAttemptSource, type WriterAttemptContext } from './usage-statistics-v3.service.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'codex-0160-v2');
const PARENT_ID = '00000001-0000-7000-8000-00000000a001';
const CHILD_ID = '00000002-0000-7000-8000-00000000c001';
const CHILD_PATH = '/root/brand_directions';

type Row = { ordinal: number; type: string; payload: Record<string, any>; timestamp: string };
const rows = async (name: string): Promise<Row[]> =>
  (await readFile(path.join(FIXTURES, name), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
const jsonl = (list: Row[]): string => `${list.map((row, ordinal) => JSON.stringify({ ...row, ordinal })).join('\n')}\n`;

/** Last cumulative counters of a rollout's own token_count records. */
function lastTotals(list: Row[], from = 0) {
  const total = list.slice(from).filter((row) => row.payload.type === 'token_count').at(-1)!.payload.info.total_token_usage;
  return { input: total.input_tokens - total.cached_input_tokens, cacheRead: total.cached_input_tokens, output: total.output_tokens };
}

/**
 * SYNTHETIC variant (not observed on this host: 0 of 1087 real 0.160 children replay a
 * token_count before their start ordinal). Derived from the real fixture by injecting
 * the parent's final token_count into the child's replayed history. Models a child
 * forked later in a long parent that replays a parent token_count
 * (the parent's final cumulative counters, larger than the child's own) before its
 * own history; the start ordinal moves past it.
 */
async function childWithReplayedParentUsage(): Promise<Row[]> {
  const [parent, child] = [await rows('parent.jsonl'), await rows('child.jsonl')];
  const start = child[0].payload.subagent_history_start_ordinal as number;
  const replayed = { ...parent.filter((row) => row.payload.type === 'token_count').at(-1)!, timestamp: child[2].timestamp };
  const out = [...child.slice(0, start), replayed, ...child.slice(start)];
  out[0] = { ...out[0], payload: { ...out[0].payload, subagent_history_start_ordinal: start + 1 } };
  return out;
}

async function layout(child: Row[]) {
  const dir = path.join(codexSessionsRoot(), '2026', '10', '05');
  await mkdir(dir, { recursive: true });
  const parentFile = path.join(dir, `rollout-2026-10-05T13-23-22-${PARENT_ID}.jsonl`);
  const childFile = path.join(dir, `rollout-2026-10-05T13-24-15-${CHILD_ID}.jsonl`);
  await writeFile(parentFile, jsonl(await rows('parent.jsonl')));
  await writeFile(childFile, jsonl(child));
  return { dir, parentFile, childFile, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('the v2 child is linked through SubAgentActivity; the refused spawn links nothing', async () => {
  const files = await layout(await rows('child.jsonl'));
  try {
    const manifest = await resolveCodexLinkedRollouts(files.parentFile);
    assert.equal(manifest.complete, true, manifest.limitReason ?? '');
    assert.deepEqual(manifest.linked.map((child) => [child.parentThreadId, path.basename(child.rolloutPath)]),
      [[PARENT_ID, path.basename(files.childFile)]]);
    assert.equal(manifest.spawnCount, 1);
    const [spawn] = manifest.spawns;
    assert.equal(spawn.linkKind, 'activity');
    assert.equal(spawn.agentThreadId, CHILD_ID);
    assert.equal(spawn.agentPath, CHILD_PATH);
    assert.equal(spawn.taskName, 'brand_directions');
    assert.equal(manifest.files[1].threadId, CHILD_ID);
    assert.equal(manifest.files[1].historyStartOrdinal, 5);
  } finally {
    await files.cleanup();
  }
});

test('a forged v2 activity link (wrong parent or another path) is not costed', async () => {
  for (const forge of ['parent', 'path'] as const) {
    const child = await rows('child.jsonl');
    if (forge === 'parent') child[0].payload.parent_thread_id = '00000001-0000-7000-8000-00000000ffff';
    else child[0].payload.agent_path = '/root/other_task';
    const files = await layout(child);
    try {
      const manifest = await resolveCodexLinkedRollouts(files.parentFile);
      assert.equal(manifest.linked.length, 0, forge);
      assert.equal(manifest.complete, false, `${forge}: an unresolvable explicit link marks the tree incomplete`);
    } finally {
      await files.cleanup();
    }
  }
});

test('child identity comes from line 0 only; the parent session_meta on line 1 never re-identifies it', async () => {
  const child = await rows('child.jsonl');
  const files = await layout(child);
  try {
    const metadata = await readCodexRolloutMetadata(files.childFile);
    assert.equal(metadata.threadId, CHILD_ID);
    assert.equal(metadata.parentThreadId, PARENT_ID);
    assert.equal(metadata.threadSource, 'subagent');
    assert.equal(metadata.agentPath, CHILD_PATH);
    assert.equal(metadata.historyStartOrdinal, 5);
    // A line 0 that is not a session_meta leaves the file without identity; the
    // parent's session_meta below it must not become the child's.
    const broken = [{ ...child[0], type: 'event_msg', payload: { type: 'task_started' } }, ...child.slice(1)];
    await writeFile(files.childFile, jsonl(broken));
    const unbound = await readCodexRolloutMetadata(files.childFile);
    assert.equal(unbound.threadId, null);
    assert.equal(unbound.threadSource, null);
    assert.equal(unbound.sessionId, null);
  } finally {
    await files.cleanup();
  }
});

test('conversation cost counts the child once and attributes it to the child', async () => {
  const [parent, child] = [await rows('parent.jsonl'), await rows('child.jsonl')];
  const files = await layout(child);
  try {
    const usage = await extractCodexConversationUsage(
      { sessionId: PARENT_ID, transcriptPath: files.parentFile }, undefined, { captureRequests: true },
    );
    const p = lastTotals(parent);
    const c = lastTotals(child, 5);
    assert.equal(usage.snapshotStatus, 'complete', usage.snapshotReason);
    assert.equal(usage.perModel.length, 1);
    assert.equal(usage.perModel[0].model, 'gpt-6.1-sol');
    assert.equal(usage.perModel[0].totals.input, p.input + c.input);
    assert.equal(usage.perModel[0].totals.cacheRead, p.cacheRead + c.cacheRead);
    assert.equal(usage.perModel[0].totals.output, p.output + c.output);
    assert.equal(usage.subagentRequests, 1, 'one child; the refused spawn is not a child');
  } finally {
    await files.cleanup();
  }
});

test('the replayed parent history in a child is not counted again (requests and windows)', async () => {
  const child = await childWithReplayedParentUsage();
  const files = await layout(child);
  try {
    const source = { rolloutPath: files.childFile, threadId: CHILD_ID, root: codexSessionsRoot() };
    const own = child.slice(child[0].payload.subagent_history_start_ordinal).filter((row) => row.payload.type === 'token_count');
    const usage = await extractCodexSessionUsage(source, undefined, undefined, undefined, undefined, undefined,
      { captureRequests: true, isSubagent: true });
    assert.equal(usage.requests?.length, own.length, 'only the child\'s own requests');
    const c = lastTotals(child);
    assert.deepEqual(
      [usage.perModel[0].totals.input, usage.perModel[0].totals.cacheRead, usage.perModel[0].totals.output],
      [c.input, c.cacheRead, c.output],
    );
    // A window opening at the child's start: the replayed parent counters are not a
    // baseline to subtract (which would erase the child's own usage).
    const since = Date.parse(own[0].timestamp) - 1;
    const windowed = await extractCodexSessionUsage(source, { since });
    assert.equal(windowed.perModel[0].totals.output, c.output);
  } finally {
    await files.cleanup();
  }
});

test('ingestion writes parent + child exactly once and attributes the child by its agent path', async () => {
  const previousDb = process.env.DATABASE_PATH;
  const previousWriter = process.env.USAGE_INGEST_WRITER;
  const dbRoot = await mkdtemp(path.join(os.tmpdir(), 'b1616-ingest-'));
  const [parent, child] = [await rows('parent.jsonl'), await childWithReplayedParentUsage()];
  const files = await layout(child);
  closeConnection();
  process.env.DATABASE_PATH = path.join(dbRoot, 'db.sqlite');
  process.env.USAGE_INGEST_WRITER = 'on';
  try {
    await initializeDatabase();
    stopReconcileScheduler();
    const manifest = await resolveCodexLinkedRollouts(files.parentFile);
    await ingestConversationUsage({ sessionId: PARENT_ID, provider: 'codex', transcriptPath: files.parentFile, manifest });
    const cost = readConversationUsageSnapshot(PARENT_ID)!.cost;
    const p = lastTotals(parent);
    const c = lastTotals(child);
    assert.equal(cost.perModel[0].tokens.output, p.output + c.output, 'parent not double counted through the child');
    assert.equal(cost.perModel[0].tokens.input, p.input + c.input);
    assert.deepEqual(usageIngestionDb.listConversationAttributions(PARENT_ID).map((row) => row.id), [CHILD_PATH]);
  } finally {
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previousDb;
    if (previousWriter === undefined) delete process.env.USAGE_INGEST_WRITER; else process.env.USAGE_INGEST_WRITER = previousWriter;
    await files.cleanup();
    await rm(dbRoot, { recursive: true, force: true });
  }
});

test('the v3 fact reader skips the replayed parent counters instead of quarantining the child', async () => {
  // SYNTHETIC fixture: see childWithReplayedParentUsage (injected replayed counters).
  const child = await childWithReplayedParentUsage();
  const files = await layout(child);
  try {
    const canonical = await realpath(files.childFile);
    const identity = createHash('sha256').update(canonical).digest('hex');
    const context: WriterAttemptContext = { rootSessionId: PARENT_ID, rootSourceIdentityHash: identity,
      process: { hostBootId: '00000000-0000-0000-0000-000000000000', pid: 1, procStartTicks: '1' },
      sources: new Map([[identity, canonical]]) };
    const arena = new FactArena();
    const scan = await preflightWriterAttemptSource(context, identity, 0, undefined,
      { parseFacts: true, modelHint: 'gpt-6.1-sol', factArena: arena, isSubagent: true });
    assert.equal(scan.sourceIdentityHash, identity);
  } finally {
    await files.cleanup();
  }
});
