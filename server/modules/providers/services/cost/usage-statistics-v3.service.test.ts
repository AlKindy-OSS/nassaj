import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { usageStatisticsV3Db } from '@/modules/database/index.js';

import {
  buildWriterAttemptManifest,
  createUsageV3CleanupMaintenance,
  createUsageV3LifecycleSemaphore,
  FactArena,
  preflightWriterAttemptSource,
  runUsageV3RetryPolicy,
  usageV3MerkleRoot,
  validateWriterAttemptTopology,
  writerProcessIdentityId,
  type V3SourceDescriptor,
  type WriterAttemptContext,
} from './usage-statistics-v3.service.js';

const hash = (value: string): string => value.repeat(64).slice(0, 64);
const source = (identity: string): V3SourceDescriptor => ({
  contentSha256: hash('a'), ctimeNs: 1, device: 1, generation: 0, inode: identity === hash('1') ? 1 : 2,
  mode: 0o100644, mtimeNs: 2, sizeBytes: 3, sourceIdentityHash: identity,
});

test('Merkle v1 duplicates an odd final leaf and has stable empty roots', () => {
  assert.equal(usageV3MerkleRoot('manifest', []), 'c8917122570c4cbd41dff77195bd6355fbbf019a8a4560055c92fb2b26b1a7ce');
  const root = usageV3MerkleRoot('manifest', ['a', 'b', 'c']);
  assert.equal(root, usageV3MerkleRoot('manifest', ['a', 'b', 'c']));
  assert.notEqual(root, usageV3MerkleRoot('manifest', ['a', 'b']));
});

test('rooted topology rejects duplicate, detached, and non-spawn edges', () => {
  const root = hash('1'); const child = hash('2');
  const descriptors = [source(root), source(child)];
  validateWriterAttemptTopology(root, descriptors, [{ parentSourceIdentityHash: root, childSourceIdentityHash: child, edgeType: 'spawn' }]);
  assert.throws(() => validateWriterAttemptTopology(root, descriptors, [
    { parentSourceIdentityHash: root, childSourceIdentityHash: child, edgeType: 'spawn' },
    { parentSourceIdentityHash: root, childSourceIdentityHash: child, edgeType: 'spawn' },
  ]));
  assert.throws(() => validateWriterAttemptTopology(root, descriptors, [
    { parentSourceIdentityHash: root, childSourceIdentityHash: child, edgeType: 'custom' as never },
  ]));
});

test('receipt envelope is path-free and bounded', () => {
  const root = hash('1'); const child = hash('2');
  const manifest = buildWriterAttemptManifest({ rootSessionId: 'root', rootSourceIdentityHash: root,
    process: { hostBootId: '00000000-0000-0000-0000-000000000000', pid: 1, procStartTicks: '1' },
    sources: new Map([[root, '/not/persisted/root'], [child, '/not/persisted/child']]),
  }, [source(child), source(root)], [{ parentSourceIdentityHash: root, childSourceIdentityHash: child, edgeType: 'spawn' }]);
  assert.equal(manifest.descriptors[0]?.sourceIdentityHash, root);
  assert.equal(manifest.envelope.includes('/not/persisted'), false);
  assert.ok(Buffer.byteLength(manifest.envelope) <= 4 * 1024);
});

test('process identity hash is deterministic and changes with the proc triple', () => {
  const identity = { hostBootId: '00000000-0000-0000-0000-000000000000', pid: 42, procStartTicks: '99' };
  assert.equal(writerProcessIdentityId(identity), writerProcessIdentityId({ ...identity }));
  assert.notEqual(writerProcessIdentityId(identity), writerProcessIdentityId({ ...identity, procStartTicks: '100' }));
});

test('lifecycle semaphore admits four and fails closed after its wait bound', async () => {
  const semaphore = createUsageV3LifecycleSemaphore(4, 5);
  const releases = await Promise.all([semaphore.acquire(), semaphore.acquire(), semaphore.acquire(), semaphore.acquire()]);
  await assert.rejects(semaphore.acquire(), /admission timeout/);
  releases.shift()!();
  const release = await semaphore.acquire();
  release();
  for (const unlock of releases) unlock();
});

test('lazy cleanup runs at most five batches and never creates an interval', () => {
  const original = usageStatisticsV3Db.cleanupPreflightReceipts;
  const previousWriter = process.env.USAGE_STATISTICS_V3_WRITER;
  const previousReader = process.env.USAGE_STATISTICS_V3_READER;
  let calls = 0;
  usageStatisticsV3Db.cleanupPreflightReceipts = (_wallNowMs, batchSize = 100): number => {
    calls += 1;
    assert.equal(batchSize, 100);
    return 100;
  };
  try {
    process.env.USAGE_STATISTICS_V3_WRITER = 'on';
    delete process.env.USAGE_STATISTICS_V3_READER;
    const maintenance = createUsageV3CleanupMaintenance();
    assert.equal(maintenance(1n, 1), 500);
    assert.equal(calls, 5);
    assert.equal(maintenance(2n, 2), 0);
    assert.equal(calls, 5);
  } finally {
    usageStatisticsV3Db.cleanupPreflightReceipts = original;
    if (previousWriter === undefined) delete process.env.USAGE_STATISTICS_V3_WRITER;
    else process.env.USAGE_STATISTICS_V3_WRITER = previousWriter;
    if (previousReader === undefined) delete process.env.USAGE_STATISTICS_V3_READER;
    else process.env.USAGE_STATISTICS_V3_READER = previousReader;
  }
});

test('v3 retry policy uses exact ADR-184 backoff and three total attempts', async () => {
  let clock = 0;
  const sleeps: number[] = [];
  let attempts = 0;
  const result = await runUsageV3RetryPolicy(async () => {
    attempts += 1;
    return attempts === 3 ? 'ready' : 'incomplete';
  }, {
    nowMs: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  assert.equal(result, 'ready');
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [1_000, 4_000]);
});

test('v3 retry policy never starts an attempt outside its 15-minute window', async () => {
  let clock = 0;
  let attempts = 0;
  const sleeps: number[] = [];
  const result = await runUsageV3RetryPolicy(async () => {
    attempts += 1;
    clock = 15 * 60 * 1_000 - 500;
    return 'incomplete';
  }, { nowMs: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  assert.equal(result, 'incomplete');
  assert.equal(attempts, 1);
  assert.deepEqual(sleeps, []);
});

test('framing failures and shared pending-fact overflow are quarantined', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'usage-v3-service-'));
  const sourcePath = path.join(directory, 'rollout.jsonl');
  try {
    const run = async (content: string, nearArenaLimit = false): Promise<void> => {
      await writeFile(sourcePath, content);
      const canonical = await realpath(sourcePath);
      const identity = createHash('sha256').update(canonical).digest('hex');
      const context: WriterAttemptContext = { rootSessionId: 'root', rootSourceIdentityHash: identity,
        process: { hostBootId: '00000000-0000-0000-0000-000000000000', pid: 1, procStartTicks: '1' },
        sources: new Map([[identity, canonical]]) };
      const factArena = nearArenaLimit ? new FactArena(512, 128) : new FactArena();
      if (nearArenaLimit) {
        factArena.append({ sourceIdentityHash: identity, generation: 0, byteStart: 0, byteEnd: 1,
          occurredAt: '2026-01-01T00:00:00.000Z', model: 'x'.repeat(180), inputTokens: 0, outputTokens: 0,
          cachedInputTokens: 0, requestCount: 1, isSubagent: false });
      }
      await preflightWriterAttemptSource(context, identity, 0, undefined, {
        parseFacts: true, modelHint: 'gpt-test', factArena,
      });
    };
    await assert.rejects(run('{invalid}\n'), /source_invalid/);
    await assert.rejects(run('{}'), /source_invalid/);
    const fact = JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', payload: { type: 'token_count', model: 'gpt-test',
      info: { total_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } } } });
    await assert.rejects(run(`${fact}\n`, true), /source_invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('FactArena shares its allocation boundary across multiple sources', () => {
  const arena = new FactArena(1024, 128);
  const identities = [hash('a'), hash('b')];
  const append = (sourceIdentityHash: string, byteStart: number): void => arena.append({ sourceIdentityHash,
    generation: 0, byteStart, byteEnd: byteStart + 1, occurredAt: '2026-01-01T00:00:00.000Z', model: 'gpt-test',
    inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, requestCount: 1, isSubagent: false });
  append(identities[0]!, 0); append(identities[1]!, 1);
  let offset = 2;
  assert.throws(() => { for (;;) { append(identities[offset % 2]!, offset); offset += 1; } }, /source_invalid/);
  assert.ok(arena.usedBytes <= 1024);
  assert.ok(arena.allocatedBytes <= 1024);
  assert.deepEqual([...new Set([...arena.values()].map(value => value.sourceIdentityHash))], identities);
});
