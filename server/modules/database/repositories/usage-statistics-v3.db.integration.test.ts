import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { DELETION_DEPENDENCIES } from '@/modules/database/deletion-dependency-manifest.js';
import {
  MAX_USAGE_V3_FACTS_PER_RUN,
  MAX_USAGE_V3_SOURCES,
  usageStatisticsV3Db,
  usageStatisticsV3ReaderMode,
  usageStatisticsV3WriterMode,
  type UsageStatisticsV3Fact,
  type UsageStatisticsV3Run,
  type UsageV3ProcessProof,
} from '@/modules/database/repositories/usage-statistics-v3.db.js';
/* eslint-disable boundaries/dependencies -- this database integration test exercises the v3 adapter contract end to end. */
import {
  buildCodexStatisticsV3,
  readReadyUsageV3,
} from '@/modules/providers/services/cost/usage-statistics-v3.service.js';
import { UsageIngestionScheduler } from '@/modules/providers/services/cost/usage-ingestion.scheduler.js';
import { calculateSessionCost } from '@/modules/providers/services/cost/cost-calculator.js';
/* eslint-enable boundaries/dependencies */

async function withDatabase(run: () => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp('/var/tmp/usage-statistics-v3-');
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'db.sqlite');
  await initializeDatabase();
  try {
    await run();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

const run = (overrides: Partial<UsageStatisticsV3Run> = {}): UsageStatisticsV3Run => ({
  runId: 'run-a', sessionId: 'session-a', rootSessionId: 'root-a', provider: 'codex',
  status: 'building', manifestFingerprint: 'manifest-a', scopeFingerprint: 'scope-a',
  attributionFingerprint: 'attribution-a', metricsFingerprint: 'metrics-a', pricingVersion: 'prices-a',
  generation: 1, leaseOwner: 'writer-a', leaseExpiresAtMs: Date.now() + 60_000,
  evidence: { sourceKey: 'codex:/root-a', generation: 1 },
  ...overrides,
});

const fact = (overrides: Partial<UsageStatisticsV3Fact> = {}): UsageStatisticsV3Fact => {
  const evidence = overrides.evidence ?? { sourceKey: 'codex:/root-a', generation: 1, byteStart: 0, byteEnd: 120 };
  const sourceKey = String(evidence.sourceKey);
  const generation = Number(evidence.generation);
  const byteStart = Number(evidence.byteStart);
  return {
    eventKey: `${sourceKey}+${generation}+${byteStart}`,
    occurredAt: '2026-09-22T10:00:00.000Z', model: 'gpt-5',
    inputTokens: 10, outputTokens: 2, cachedInputTokens: 3, requestCount: 1, isSubagent: false,
    ...overrides,
    evidence,
  };
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const establishTrustedSpawnOwner = (sessionId: string, userId = 1): void => {
  const db = getConnection();
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(userId, `v3-owner-${userId}`, 'hash');
  db.prepare('INSERT INTO sessions (session_id, provider) VALUES (?, ?)').run(sessionId, 'codex');
  db.prepare(`INSERT INTO session_participants (session_id, user_id, role, attribution)
    VALUES (?, ?, 'owner', 'spawn')`).run(sessionId, userId);
};

const claimProcessSource = `
  const repository = await import(process.env.USAGE_V3_REPOSITORY_URL);
  const connection = await import(process.env.USAGE_V3_CONNECTION_URL);
  process.stdout.write('ready\\n');
  process.stdin.once('data', () => {
    try {
      process.stdout.write(JSON.stringify({ claimed: repository.usageStatisticsV3Db.claimRun(
        JSON.parse(process.env.USAGE_V3_RUN)
      ) }) + '\\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ failure: error instanceof Error ? error.message : String(error) }) + '\\n');
    } finally {
      connection.closeConnection();
    }
  });
`;

test('v3 migration is additive, idempotent, and isolates retention from sessions', async () => {
  await withDatabase(async () => {
    await initializeDatabase();
    const tables = new Set((getConnection().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    for (const name of ['usage_statistics_runs', 'usage_statistics_facts', 'usage_statistics_lineage', 'usage_retention_v3']) {
      assert.ok(tables.has(name), `${name} must be created by the additive v3 migration`);
    }
    const retentionFks = getConnection().pragma('foreign_key_list(usage_retention_v3)') as Array<{ table: string; on_delete: string }>;
    assert.equal(retentionFks.some((foreignKey) => foreignKey.table === 'sessions' || foreignKey.on_delete === 'CASCADE'), false);
    const classifications = DELETION_DEPENDENCIES.filter((entry) => entry.table.startsWith('usage_'));
    assert.ok(classifications.some((entry) => entry.table === 'usage_statistics_runs'
      && entry.column === 'session_id' && entry.disposition === 'isolated_retention'));
    for (const table of ['usage_statistics_facts', 'usage_statistics_lineage', 'usage_source_snapshots_v3', 'usage_run_events_v3']) {
      assert.ok(classifications.some((entry) => entry.table === table
        && entry.column === 'run_id' && entry.disposition === 'cascade'), `${table} must cascade only inside a retained run`);
    }
  });
});

test('v3 flags fail closed and rollback stays a read-only v1 selection', () => {
  const writer = process.env.USAGE_STATISTICS_V3_WRITER;
  const reader = process.env.USAGE_STATISTICS_V3_READER;
  try {
    process.env.USAGE_STATISTICS_V3_WRITER = 'unsafe';
    process.env.USAGE_STATISTICS_V3_READER = 'unsafe';
    assert.equal(usageStatisticsV3WriterMode(), 'off');
    assert.equal(usageStatisticsV3ReaderMode(), 'off');
    process.env.USAGE_STATISTICS_V3_WRITER = 'on';
    process.env.USAGE_STATISTICS_V3_READER = 'rollback';
    assert.equal(usageStatisticsV3WriterMode(), 'on');
    assert.equal(usageStatisticsV3ReaderMode(), 'rollback');
  } finally {
    if (writer === undefined) delete process.env.USAGE_STATISTICS_V3_WRITER; else process.env.USAGE_STATISTICS_V3_WRITER = writer;
    if (reader === undefined) delete process.env.USAGE_STATISTICS_V3_READER; else process.env.USAGE_STATISTICS_V3_READER = reader;
  }
});

test('fenced preflight rejects owner mismatch, stale CAS, terminal rewrite, and cleanup races', async () => {
  await withDatabase(() => {
    const db = getConnection();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'v3-owner', 'hash')").run();
    db.prepare("INSERT INTO sessions (session_id, provider) VALUES ('v3-root', 'codex')").run();
    db.prepare("INSERT INTO session_participants (session_id, user_id, role, attribution) VALUES ('v3-root', 1, 'owner', 'spawn')").run();
    const previous = process.env.USAGE_STATISTICS_V3_WRITER;
    const reader = process.env.USAGE_STATISTICS_V3_READER;
    process.env.USAGE_STATISTICS_V3_WRITER = 'on';
    delete process.env.USAGE_STATISTICS_V3_READER;
    const proof: UsageV3ProcessProof = { processIdentityId: 'proc-a', hostBootId: 'boot-a', pid: 42, procStartTicks: '99' };
    const key = { ownerUserId: 1, provider: 'codex', rootSessionId: 'v3-root', scopeFingerprint: 'scope', attributionFingerprint: 'attr' };
    try {
      assert.equal(usageStatisticsV3Db.beginPreflight({ ...key, ownerUserId: 2, authorityId: 'bad', receiptId: 'bad-r', proof,
        nowMonotonicNs: 1n, leaseDeadlineMonotonicNs: 2n }), null);
      const begun = usageStatisticsV3Db.beginPreflight({ ...key, authorityId: 'auth-a', receiptId: 'receipt-a', proof,
        nowMonotonicNs: 1n, leaseDeadlineMonotonicNs: 100n });
      assert.deepEqual(begun, { token: 1, attemptNo: 1 });
      assert.equal(usageStatisticsV3Db.passPreflight(key, 'receipt-a', 1, proof, 99n, 2n, 1_000), false);
      assert.equal(usageStatisticsV3Db.passPreflight(key, 'receipt-a', 1, proof, 100n, 2n, 1_000), true);
      assert.equal(usageStatisticsV3Db.passPreflight(key, 'receipt-a', 2, proof, 100n, 2n, 1_000), false);
      assert.equal(usageStatisticsV3Db.claimCanonicalRun({ ...key, receiptId: 'receipt-a', runId: 'stale-run', token: 2,
        proof, nowMonotonicNs: 2n, expectedLeaseDeadlineMonotonicNs: 99n,
        leaseDeadlineMonotonicNs: 100n, retainUntilMs: 2_000 }), false);
      assert.equal(usageStatisticsV3Db.claimCanonicalRun({ ...key, receiptId: 'receipt-a', runId: 'run-a', token: 2, proof,
        nowMonotonicNs: 2n, expectedLeaseDeadlineMonotonicNs: 100n,
        leaseDeadlineMonotonicNs: 100n, retainUntilMs: 2_000 }), true);
      assert.equal(usageStatisticsV3Db.cleanupPreflightReceipts(10_000), 0, 'running run pins its receipt');
    } finally {
      if (previous === undefined) delete process.env.USAGE_STATISTICS_V3_WRITER; else process.env.USAGE_STATISTICS_V3_WRITER = previous;
      if (reader === undefined) delete process.env.USAGE_STATISTICS_V3_READER; else process.env.USAGE_STATISTICS_V3_READER = reader;
    }
  });
});

test('fenced preflight persists only path-free snapshots and finalizes through an exact Merkle CAS', async () => {
  await withDatabase(() => {
    const db = getConnection();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'v3-final-owner', 'hash')").run();
    db.prepare("INSERT INTO sessions (session_id, provider) VALUES ('v3-final-root', 'codex')").run();
    db.prepare("INSERT INTO session_participants (session_id, user_id, role, attribution) VALUES ('v3-final-root', 1, 'owner', 'spawn')").run();
    const prior = process.env.USAGE_STATISTICS_V3_WRITER;
    process.env.USAGE_STATISTICS_V3_WRITER = 'on';
    const proof = { processIdentityId: 'proc-final', hostBootId: 'boot-final', pid: 73, procStartTicks: '123' };
    const key = { ownerUserId: 1, provider: 'codex', rootSessionId: 'v3-final-root', scopeFingerprint: 'scope-final', attributionFingerprint: 'attr-final' };
    const hash = 'a'.repeat(64);
    const merkle = { receiptId: 'receipt-final', sourceRootHex: hash, topologyRootHex: hash,
      rootSourceIdentityHash: hash, envelopeJson: '{"manifestVersion":1}' };
    try {
      assert.deepEqual(usageStatisticsV3Db.beginPreflight({ ...key, authorityId: 'auth-final', receiptId: merkle.receiptId,
        proof, nowMonotonicNs: 1n, leaseDeadlineMonotonicNs: 100n }), { token: 1, attemptNo: 1 });
      const preflight = { status: 'preflighting' as const, activePreflightId: merkle.receiptId, activeRunId: null,
        token: 1, proof, leaseDeadlineMonotonicNs: 100n };
      assert.equal(usageStatisticsV3Db.recordPreflightSource(key, preflight, 2n, { receiptId: merkle.receiptId,
        sourceIdentityHash: hash, generation: 0, descriptorJson: '{"sizeBytes":0}' }), true);
      assert.equal(usageStatisticsV3Db.recordPreflightMerkle(key, preflight, 2n, merkle), true);
      assert.equal(usageStatisticsV3Db.renewPreflightLease(key, preflight, 100n, 200n), false);
      assert.equal(usageStatisticsV3Db.renewPreflightLease(key, preflight, 2n, 200n), true);
      const renewed = { ...preflight, leaseDeadlineMonotonicNs: 200n };
      assert.equal(usageStatisticsV3Db.passPreflight(key, merkle.receiptId, 1, proof, 200n, 2n, 10_000), true);
      assert.equal(usageStatisticsV3Db.claimCanonicalRun({ ...key, receiptId: merkle.receiptId, runId: 'run-final', token: 2,
        proof, nowMonotonicNs: 2n, expectedLeaseDeadlineMonotonicNs: 200n,
        leaseDeadlineMonotonicNs: 300n, retainUntilMs: 20_000 }), true);
      const running = { status: 'running' as const, activePreflightId: merkle.receiptId, activeRunId: 'run-final',
        token: 3, proof, leaseDeadlineMonotonicNs: 300n };
      assert.equal(usageStatisticsV3Db.recordCanonicalFact(key, running, 3n, {
        eventKey: sha256(`${hash}+0+0`), sourceIdentityHash: hash, sourceGeneration: 0, byteStart: 0,
        occurredAt: '2026-09-22T10:00:00.000Z', model: 'gpt-5', inputTokens: 1, outputTokens: 1,
        cachedInputTokens: 0, requestCount: 1, isSubagent: false, evidence: { generation: 0, byteStart: 0 },
      }), true);
      assert.equal(usageStatisticsV3Db.setCanonicalWorkDuration(key, running, 3n, 1_000), true);
      assert.equal(usageStatisticsV3Db.finalizeCanonicalRun(key, running, 3n, { ...merkle, sourceRootHex: 'b'.repeat(64) }), false);
      assert.equal(usageStatisticsV3Db.finalizeCanonicalRun(key, running, 3n, merkle), true);
      assert.deepEqual(db.prepare('SELECT status FROM usage_v3_canonical_runs WHERE run_id = ?').get('run-final'), { status: 'ready' });
      assert.deepEqual(usageStatisticsV3Db.getReadyCanonicalRun({ ...key, metricsFingerprint: '' }), { runId: 'run-final' });
      assert.deepEqual(usageStatisticsV3Db.listCanonicalFacts('run-final').map(fact => fact.eventKey), [sha256(`${hash}+0+0`)]);
      assert.deepEqual(usageStatisticsV3Db.getCanonicalProjectionMeta('run-final'), { sourceCount: 1, factCount: 1, lineageCount: 0, workDurationMs: 1_000 });
      assert.equal(usageStatisticsV3Db.recoverMissingWriterContext(key, { ...renewed, status: 'preflight_passed' }, 3n, true), false);
    } finally {
      if (prior === undefined) delete process.env.USAGE_STATISTICS_V3_WRITER; else process.env.USAGE_STATISTICS_V3_WRITER = prior;
    }
  });
});

test('canonical terminal and dead-owner recovery CAS to idle without changing receipts', async () => {
  await withDatabase(() => {
    const db = getConnection();
    db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'v3-terminal-owner', 'hash')").run();
    db.prepare("INSERT INTO sessions (session_id, provider) VALUES ('v3-terminal-root', 'codex')").run();
    db.prepare("INSERT INTO session_participants (session_id, user_id, role, attribution) VALUES ('v3-terminal-root', 1, 'owner', 'spawn')").run();
    const prior = process.env.USAGE_STATISTICS_V3_WRITER;
    process.env.USAGE_STATISTICS_V3_WRITER = 'on';
    const proof = { processIdentityId: 'proc-terminal', hostBootId: 'boot-terminal', pid: 91, procStartTicks: '888' };
    const key = { ownerUserId: 1, provider: 'codex', rootSessionId: 'v3-terminal-root', scopeFingerprint: 'scope-terminal', attributionFingerprint: 'attr-terminal' };
    const start = (authorityId: string, receiptId: string, runId: string, beginToken: number, passToken: number) => {
      assert.deepEqual(usageStatisticsV3Db.beginPreflight({ ...key, authorityId, receiptId, proof,
        nowMonotonicNs: 1n, leaseDeadlineMonotonicNs: 100n }), { token: beginToken, attemptNo: beginToken === 1 ? 1 : 2 });
      assert.equal(usageStatisticsV3Db.passPreflight(key, receiptId, beginToken, proof, 100n, 2n, 1_000), true);
      assert.equal(usageStatisticsV3Db.claimCanonicalRun({ ...key, receiptId, runId, token: passToken, proof,
        nowMonotonicNs: 2n, expectedLeaseDeadlineMonotonicNs: 100n,
        leaseDeadlineMonotonicNs: 100n, retainUntilMs: 2_000 }), true);
    };
    try {
      start('auth-terminal', 'receipt-terminal-a', 'run-terminal-a', 1, 2);
      const runningA = { status: 'running' as const, activePreflightId: 'receipt-terminal-a', activeRunId: 'run-terminal-a',
        token: 3, proof, leaseDeadlineMonotonicNs: 100n };
      assert.equal(usageStatisticsV3Db.terminateCanonicalRun(key, runningA, 100n, 'failed', 'canonical_context_lost', 3_000), false);
      assert.equal(usageStatisticsV3Db.terminateCanonicalRun(key, runningA, 3n, 'failed', 'canonical_context_lost', 3_000), true);
      assert.deepEqual(db.prepare('SELECT status, failure_code FROM usage_v3_canonical_runs WHERE run_id = ?').get('run-terminal-a'),
        { status: 'failed', failure_code: 'canonical_context_lost' });
      assert.deepEqual(db.prepare('SELECT status, active_preflight_id, active_run_id FROM usage_v3_preflight_authorities').get(),
        { status: 'idle', active_preflight_id: null, active_run_id: null });
      assert.deepEqual(db.prepare('SELECT status FROM usage_v3_preflight_receipts WHERE receipt_id = ?').get('receipt-terminal-a'), { status: 'passed' });
      start('auth-terminal', 'receipt-terminal-b', 'run-terminal-b', 5, 6);
      const runningB = { status: 'running' as const, activePreflightId: 'receipt-terminal-b', activeRunId: 'run-terminal-b',
        token: 7, proof, leaseDeadlineMonotonicNs: 100n };
      assert.equal(usageStatisticsV3Db.recoverDeadCanonicalRun(key, runningB, {
        kind: 'process_missing', observedHostBootId: proof.hostBootId, observedPid: proof.pid, observedProcStartTicks: null,
      }, 4_000), true);
      assert.deepEqual(db.prepare('SELECT status, failure_code FROM usage_v3_canonical_runs WHERE run_id = ?').get('run-terminal-b'),
        { status: 'superseded', failure_code: 'canonical_owner_dead' });
    } finally {
      if (prior === undefined) delete process.env.USAGE_STATISTICS_V3_WRITER; else process.env.USAGE_STATISTICS_V3_WRITER = prior;
    }
  });
});

test('rolling attempt window links parents and expired-owner CAS fails closed', async () => {
  await withDatabase(() => {
    establishTrustedSpawnOwner('rolling-root');
    const previous = process.env.USAGE_STATISTICS_V3_WRITER;
    process.env.USAGE_STATISTICS_V3_WRITER = 'on';
    const proof = { processIdentityId: 'rolling-process', hostBootId: 'rolling-boot', pid: 101, procStartTicks: '55' };
    const key = { ownerUserId: 1, provider: 'codex', rootSessionId: 'rolling-root',
      scopeFingerprint: 'rolling-scope', attributionFingerprint: 'rolling-attribution' };
    const begin = (receiptId: string, wallNowMs: number, expectedToken: number, expectedAttempt: number) => {
      assert.deepEqual(usageStatisticsV3Db.beginPreflight({ ...key, authorityId: 'rolling-authority', receiptId, proof,
        nowMonotonicNs: 1n, leaseDeadlineMonotonicNs: 10n, wallNowMs }),
      { token: expectedToken, attemptNo: expectedAttempt });
    };
    const expire = (receiptId: string, token: number) => assert.equal(usageStatisticsV3Db.expireOwnedPreflight(key,
      { status: 'preflighting', activePreflightId: receiptId, activeRunId: null, token, proof, leaseDeadlineMonotonicNs: 10n },
      10n, 10_000), true);
    try {
      begin('rolling-r1', 0, 1, 1);
      const first = { status: 'preflighting' as const, activePreflightId: 'rolling-r1', activeRunId: null,
        token: 1, proof, leaseDeadlineMonotonicNs: 10n };
      assert.equal(usageStatisticsV3Db.reserveAttemptIoBudget(key, first, 100 * 1024 * 1024, 0), true);
      assert.equal(usageStatisticsV3Db.reserveAttemptIoBudget(key, first, 1, 0), false, 'receipt reserves once');
      expire('rolling-r1', 1);
      begin('rolling-r2', 1, 3, 2);
      const second = { ...first, activePreflightId: 'rolling-r2', token: 3 };
      assert.equal(usageStatisticsV3Db.reserveAttemptIoBudget(key, second, 156 * 1024 * 1024, 1), true);
      assert.deepEqual(usageStatisticsV3Db.getAttemptIoBudget('rolling-r2'), {
        accountedIoBytes: 156 * 1024 * 1024, reserved: true,
      });
      assert.deepEqual(getConnection().prepare('SELECT parent_receipt_id FROM usage_v3_preflight_receipts WHERE receipt_id = ?')
        .get('rolling-r2'), { parent_receipt_id: 'rolling-r1' });
      expire('rolling-r2', 3);
      begin('rolling-r3', 2, 5, 3);
      const third = { ...first, activePreflightId: 'rolling-r3', token: 5 };
      assert.equal(usageStatisticsV3Db.reserveAttemptIoBudget(key, third, 1, 2), false, 'rolling authority budget is exhausted');
      expire('rolling-r3', 5);
      assert.equal(usageStatisticsV3Db.beginPreflight({ ...key, authorityId: 'rolling-authority', receiptId: 'rolling-r4', proof,
        nowMonotonicNs: 1n, leaseDeadlineMonotonicNs: 10n, wallNowMs: 2 }), null);
      begin('rolling-r4', 900_001, 7, 4);
      assert.deepEqual(getConnection().prepare('SELECT parent_receipt_id FROM usage_v3_preflight_receipts WHERE receipt_id = ?')
        .get('rolling-r4'), { parent_receipt_id: 'rolling-r3' });
      const view = usageStatisticsV3Db.getAuthorityRecoveryView(key);
      assert.deepEqual(view, { status: 'preflighting', activePreflightId: 'rolling-r4', activeRunId: null, token: 7,
        process: proof, leaseDeadlineMonotonicNs: 10n });
      const current = { status: 'preflighting' as const, activePreflightId: 'rolling-r4', activeRunId: null,
        token: 7, proof, leaseDeadlineMonotonicNs: 10n };
      assert.equal(usageStatisticsV3Db.expireOwnedPreflight(key, current, 9n, 20_000), false);
      assert.equal(usageStatisticsV3Db.expireOwnedPreflight(key, { ...current, token: 6 }, 10n, 20_000), false);
      assert.equal(usageStatisticsV3Db.expireOwnedPreflight(key, current, 10n, 20_000), true);
      assert.deepEqual(getConnection().prepare('SELECT status, failure_code FROM usage_v3_preflight_receipts WHERE receipt_id = ?')
        .get('rolling-r4'), { status: 'failed', failure_code: 'lease_expired' });
    } finally {
      if (previous === undefined) delete process.env.USAGE_STATISTICS_V3_WRITER; else process.env.USAGE_STATISTICS_V3_WRITER = previous;
    }
  });
});

test('expired canonical owner is fenced to failed without touching prior ready', async () => {
  await withDatabase(() => {
    establishTrustedSpawnOwner('expiry-root');
    const previous = process.env.USAGE_STATISTICS_V3_WRITER;
    process.env.USAGE_STATISTICS_V3_WRITER = 'on';
    const proof = { processIdentityId: 'expiry-process', hostBootId: 'expiry-boot', pid: 102, procStartTicks: '77' };
    const key = { ownerUserId: 1, provider: 'codex', rootSessionId: 'expiry-root',
      scopeFingerprint: 'expiry-scope', attributionFingerprint: 'expiry-attribution' };
    try {
      assert.deepEqual(usageStatisticsV3Db.beginPreflight({ ...key, authorityId: 'expiry-authority', receiptId: 'expiry-receipt',
        proof, nowMonotonicNs: 1n, leaseDeadlineMonotonicNs: 10n, wallNowMs: 1 }), { token: 1, attemptNo: 1 });
      assert.equal(usageStatisticsV3Db.passPreflight(key, 'expiry-receipt', 1, proof, 10n, 2n, 10_000), true);
      assert.equal(usageStatisticsV3Db.claimCanonicalRun({ ...key, receiptId: 'expiry-receipt', runId: 'expiry-running',
        token: 2, proof, nowMonotonicNs: 2n, expectedLeaseDeadlineMonotonicNs: 10n,
        leaseDeadlineMonotonicNs: 10n, retainUntilMs: 10_000 }), true);
      const db = getConnection();
      db.prepare(`INSERT INTO usage_v3_canonical_runs (run_id, authority_id, preflight_receipt_id, owner_user_id,
        root_session_id, status, retain_until_ms) VALUES ('expiry-ready', 'expiry-authority', 'expiry-receipt', 1,
        'expiry-root', 'ready', 10000)`).run();
      const expected = { status: 'running' as const, activePreflightId: 'expiry-receipt', activeRunId: 'expiry-running',
        token: 3, proof, leaseDeadlineMonotonicNs: 10n };
      assert.equal(usageStatisticsV3Db.expireOwnedCanonical(key, expected, 9n, 20_000), false);
      assert.equal(usageStatisticsV3Db.expireOwnedCanonical(key, expected, 10n, 20_000), true);
      assert.deepEqual(db.prepare('SELECT run_id, status, failure_code FROM usage_v3_canonical_runs ORDER BY run_id').all(), [
        { run_id: 'expiry-ready', status: 'ready', failure_code: null },
        { run_id: 'expiry-running', status: 'failed', failure_code: 'lease_expired' },
      ]);
    } finally {
      if (previous === undefined) delete process.env.USAGE_STATISTICS_V3_WRITER; else process.env.USAGE_STATISTICS_V3_WRITER = previous;
    }
  });
});

test('dead passed-context recovery matches PID-reuse proof and preserves passed receipt', async () => {
  await withDatabase(() => {
    establishTrustedSpawnOwner('passed-death-root');
    const previous = process.env.USAGE_STATISTICS_V3_WRITER;
    process.env.USAGE_STATISTICS_V3_WRITER = 'on';
    const proof = { processIdentityId: 'passed-death-process', hostBootId: 'passed-death-boot', pid: 111, procStartTicks: '10' };
    const key = { ownerUserId: 1, provider: 'codex', rootSessionId: 'passed-death-root',
      scopeFingerprint: 'passed-death-scope', attributionFingerprint: 'passed-death-attribution' };
    try {
      assert.deepEqual(usageStatisticsV3Db.beginPreflight({ ...key, authorityId: 'passed-death-authority',
        receiptId: 'passed-death-receipt', proof, nowMonotonicNs: 1n, leaseDeadlineMonotonicNs: 100n,
        wallNowMs: 1 }), { token: 1, attemptNo: 1 });
      assert.equal(usageStatisticsV3Db.passPreflight(key, 'passed-death-receipt', 1, proof, 99n, 2n, 10_000), false);
      assert.equal(usageStatisticsV3Db.passPreflight(key, 'passed-death-receipt', 1, proof, 100n, 2n, 10_000), true);
      const expected = { status: 'preflight_passed' as const, activePreflightId: 'passed-death-receipt',
        activeRunId: null, token: 2, proof, leaseDeadlineMonotonicNs: 100n };
      assert.equal(usageStatisticsV3Db.recoverDeadPassedContext(key, expected, {
        kind: 'process_reused', observedHostBootId: proof.hostBootId, observedPid: proof.pid,
        observedProcStartTicks: proof.procStartTicks,
      }, 20_000), false);
      assert.equal(usageStatisticsV3Db.recoverDeadPassedContext(key, expected, {
        kind: 'process_reused', observedHostBootId: proof.hostBootId, observedPid: proof.pid,
        observedProcStartTicks: '11',
      }, 20_000), true);
      assert.deepEqual(getConnection().prepare(`SELECT status, retain_until_ms AS retainUntil,
        failure_code AS failureCode FROM usage_v3_preflight_receipts WHERE receipt_id = ?`).get('passed-death-receipt'),
      { status: 'passed', retainUntil: 10_000, failureCode: null });
      assert.deepEqual(usageStatisticsV3Db.getAuthorityRecoveryView(key), { status: 'idle', activePreflightId: null,
        activeRunId: null, token: 3, process: null, leaseDeadlineMonotonicNs: null });
    } finally {
      if (previous === undefined) delete process.env.USAGE_STATISTICS_V3_WRITER; else process.env.USAGE_STATISTICS_V3_WRITER = previous;
    }
  });
});

test('owned passed-context expiry rejects stale tuples and permits a fresh begin', async () => {
  await withDatabase(() => {
    establishTrustedSpawnOwner('passed-expiry-root');
    const previous = process.env.USAGE_STATISTICS_V3_WRITER;
    process.env.USAGE_STATISTICS_V3_WRITER = 'on';
    const proof = { processIdentityId: 'passed-expiry-process', hostBootId: 'passed-expiry-boot', pid: 112, procStartTicks: '12' };
    const key = { ownerUserId: 1, provider: 'codex', rootSessionId: 'passed-expiry-root',
      scopeFingerprint: 'passed-expiry-scope', attributionFingerprint: 'passed-expiry-attribution' };
    try {
      assert.deepEqual(usageStatisticsV3Db.beginPreflight({ ...key, authorityId: 'passed-expiry-authority',
        receiptId: 'passed-expiry-r1', proof, nowMonotonicNs: 1n, leaseDeadlineMonotonicNs: 10n,
        wallNowMs: 1 }), { token: 1, attemptNo: 1 });
      assert.equal(usageStatisticsV3Db.passPreflight(key, 'passed-expiry-r1', 1, proof, 10n, 2n, 10_000), true);
      const passed = { status: 'preflight_passed' as const, activePreflightId: 'passed-expiry-r1',
        activeRunId: null, token: 2, proof, leaseDeadlineMonotonicNs: 10n };
      assert.equal(usageStatisticsV3Db.renewPreflightLease(key, passed, 2n, 20n), false);
      assert.equal(usageStatisticsV3Db.expireOwnedPassedContext(key, passed, 9n), false);
      assert.equal(usageStatisticsV3Db.expireOwnedPassedContext(key, { ...passed, token: 1 }, 10n), false);
      getConnection().prepare(`INSERT INTO usage_v3_canonical_runs (run_id, authority_id, preflight_receipt_id,
        owner_user_id, root_session_id, status, retain_until_ms) VALUES ('passed-expiry-ready',
        'passed-expiry-authority', 'passed-expiry-r1', 1, 'passed-expiry-root', 'ready', 20000)`).run();
      assert.equal(usageStatisticsV3Db.expireOwnedPassedContext(key, passed, 10n), true);
      assert.deepEqual(getConnection().prepare('SELECT status FROM usage_v3_preflight_receipts WHERE receipt_id = ?')
        .get('passed-expiry-r1'), { status: 'passed' });
      assert.deepEqual(getConnection().prepare('SELECT status FROM usage_v3_canonical_runs WHERE run_id = ?')
        .get('passed-expiry-ready'), { status: 'ready' });
      assert.deepEqual(usageStatisticsV3Db.beginPreflight({ ...key, authorityId: 'passed-expiry-authority',
        receiptId: 'passed-expiry-r2', proof, nowMonotonicNs: 11n, leaseDeadlineMonotonicNs: 20n,
        wallNowMs: 2 }), { token: 4, attemptNo: 2 });
    } finally {
      if (previous === undefined) delete process.env.USAGE_STATISTICS_V3_WRITER; else process.env.USAGE_STATISTICS_V3_WRITER = previous;
    }
  });
});

test('cleanup caller is bounded to five batches of one hundred receipts', async () => {
  await withDatabase(() => {
    const previousWriter = process.env.USAGE_STATISTICS_V3_WRITER;
    const previousReader = process.env.USAGE_STATISTICS_V3_READER;
    const db = getConnection();
    db.prepare(`INSERT INTO usage_v3_preflight_authorities (authority_id, owner_user_id, provider, root_session_id,
      scope_fingerprint, attribution_fingerprint, status) VALUES ('cleanup-authority', 1, 'codex', 'cleanup-root',
      'cleanup-scope', 'cleanup-attribution', 'idle')`).run();
    const insert = db.prepare(`INSERT INTO usage_v3_preflight_receipts (receipt_id, authority_id, attempt_no,
      owner_user_id, root_session_id, status, retain_until_ms, created_at_ms) VALUES (?, 'cleanup-authority', ?,
      1, 'cleanup-root', 'failed', 1, ?)`);
    db.transaction(() => { for (let index = 1; index <= 501; index += 1) insert.run(`cleanup-${index}`, index, index); })();
    try {
      process.env.USAGE_STATISTICS_V3_WRITER = 'on';
      delete process.env.USAGE_STATISTICS_V3_READER;
      let deleted = 0;
      for (let batch = 0; batch < 5; batch += 1) deleted += usageStatisticsV3Db.cleanupPreflightReceipts(2, 100);
      assert.equal(deleted, 500);
      assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM usage_v3_preflight_receipts').get(), { count: 1 });
    } finally {
      if (previousWriter === undefined) delete process.env.USAGE_STATISTICS_V3_WRITER;
      else process.env.USAGE_STATISTICS_V3_WRITER = previousWriter;
      if (previousReader === undefined) delete process.env.USAGE_STATISTICS_V3_READER;
      else process.env.USAGE_STATISTICS_V3_READER = previousReader;
    }
  });
});

test('scheduler maintenance mutates zero v3 rows during reader rollback', async () => {
  await withDatabase(async () => {
    const previousWriter = process.env.USAGE_STATISTICS_V3_WRITER;
    const previousReader = process.env.USAGE_STATISTICS_V3_READER;
    const db = getConnection();
    db.prepare(`INSERT INTO usage_v3_preflight_authorities (authority_id, owner_user_id, provider, root_session_id,
      scope_fingerprint, attribution_fingerprint, status) VALUES ('rollback-cleanup-authority', 1, 'codex',
      'rollback-cleanup-root', 'all', 'none', 'idle')`).run();
    db.prepare(`INSERT INTO usage_v3_preflight_receipts (receipt_id, authority_id, attempt_no, owner_user_id,
      root_session_id, status, retain_until_ms, created_at_ms) VALUES ('rollback-cleanup-receipt',
      'rollback-cleanup-authority', 1, 1, 'rollback-cleanup-root', 'failed', 1, 1)`).run();
    const before = JSON.stringify(db.prepare('SELECT * FROM usage_v3_preflight_receipts ORDER BY receipt_id').all());
    const scheduler = new UsageIngestionScheduler({
      writerMode: () => 'on',
      resolveContext: async () => ({ sessionId: 'rollback-cleanup-root', provider: 'claude', transcriptPath: '/unused' }),
      ingest: async () => ({ skipped: false, caughtUp: true, ingestComplete: true, eventsWritten: 0, madeProgress: false }),
    });
    try {
      process.env.USAGE_STATISTICS_V3_WRITER = 'on';
      process.env.USAGE_STATISTICS_V3_READER = 'rollback';
      await scheduler.schedule({ provider: 'claude', filePath: '/unused', sessionId: 'rollback-cleanup-root' });
      assert.equal(usageStatisticsV3Db.cleanupPreflightReceipts(Date.now(), 100), 0,
        'repository guard independently rejects cleanup during rollback');
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM usage_v3_preflight_receipts ORDER BY receipt_id').all()), before);
    } finally {
      scheduler.close();
      if (previousWriter === undefined) delete process.env.USAGE_STATISTICS_V3_WRITER;
      else process.env.USAGE_STATISTICS_V3_WRITER = previousWriter;
      if (previousReader === undefined) delete process.env.USAGE_STATISTICS_V3_READER;
      else process.env.USAGE_STATISTICS_V3_READER = previousReader;
    }
  });
});

test('v3 ADR run limits are exact and enforced without allocating boundary-sized fixtures', async () => {
  await withDatabase(() => {
    assert.equal(MAX_USAGE_V3_FACTS_PER_RUN, 500_000);
    assert.equal(MAX_USAGE_V3_SOURCES, 256);
    assert.equal(usageStatisticsV3Db.claimRun(run({ runId: 'bounded-run' })), true);

    getConnection().prepare('UPDATE usage_statistics_runs SET fact_count = ? WHERE run_id = ?')
      .run(MAX_USAGE_V3_FACTS_PER_RUN, 'bounded-run');
    assert.equal(usageStatisticsV3Db.appendFact('bounded-run', 'writer-a', 1, fact()), false);
    assert.throws(() => getConnection().prepare('UPDATE usage_statistics_runs SET fact_count = ? WHERE run_id = ?')
      .run(MAX_USAGE_V3_FACTS_PER_RUN + 1, 'bounded-run'));

    getConnection().prepare('UPDATE usage_statistics_runs SET source_count = ? WHERE run_id = ?')
      .run(MAX_USAGE_V3_SOURCES, 'bounded-run');
    assert.equal(usageStatisticsV3Db.recordSourceSnapshot('bounded-run', 'writer-a', 1, {
      sourceKey: 'codex:/bounded', sourceGeneration: 1, contentSha256: sha256('bounded-content'),
      sizeBytes: 1, factCount: 0, terminalVectorSha256: sha256('bounded-vector'), manifestFingerprint: 'manifest-a',
    }), false);
    assert.throws(() => getConnection().prepare('UPDATE usage_statistics_runs SET source_count = ? WHERE run_id = ?')
      .run(MAX_USAGE_V3_SOURCES + 1, 'bounded-run'));
  });
});

test('ready lookup rejects a mismatched metrics fingerprint and preserves explicit legacy compatibility', async () => {
  await withDatabase(() => {
    assert.equal(usageStatisticsV3Db.claimRun(run({ runId: 'metrics-ready', rootSessionId: 'metrics-root',
      metricsFingerprint: 'metrics-current' })), true);
    assert.equal(usageStatisticsV3Db.finalizeReady('metrics-ready', 'writer-a', 1), true);
    assert.deepEqual(usageStatisticsV3Db.getReadyRun(
      'metrics-root', 'scope-a', 'attribution-a', 'metrics-current',
    ), { runId: 'metrics-ready' });
    assert.equal(usageStatisticsV3Db.getReadyRun(
      'metrics-root', 'scope-a', 'attribution-a', 'metrics-stale',
    ), null);
    assert.equal(usageStatisticsV3Db.getReadyRunForMetrics(
      'metrics-root', 'scope-a', 'attribution-a', 'metrics-stale',
    ), null);
    assert.deepEqual(usageStatisticsV3Db.getReadyRun(
      'metrics-root', 'scope-a', 'attribution-a',
    ), { runId: 'metrics-ready' }, 'three-argument lookup remains the explicit legacy compatibility path');
  });
});

test('stale writers cannot append; identical eventKey is idempotent and a conflict quarantines', async () => {
  await withDatabase(() => {
    assert.equal(usageStatisticsV3Db.claimRun(run()), true);
    assert.equal(usageStatisticsV3Db.appendFact('run-a', 'writer-stale', 0, fact()), false);
    assert.equal(usageStatisticsV3Db.appendFact('run-a', 'writer-a', 1, fact()), true);
    const firstBytes = (getConnection().prepare('SELECT fact_bytes AS factBytes FROM usage_statistics_runs WHERE run_id = ?')
      .get('run-a') as { factBytes: number }).factBytes;
    assert.equal(usageStatisticsV3Db.appendFact('run-a', 'writer-a', 1, fact()), true);
    assert.equal((getConnection().prepare('SELECT fact_bytes AS factBytes FROM usage_statistics_runs WHERE run_id = ?')
      .get('run-a') as { factBytes: number }).factBytes, firstBytes);
    assert.equal(usageStatisticsV3Db.appendFact('run-a', 'writer-a', 1, fact({ outputTokens: 9 })), false);
    const row = getConnection().prepare('SELECT status, failure_code, fact_bytes FROM usage_statistics_runs WHERE run_id = ?').get('run-a') as { status: string; failure_code: string; fact_bytes: number };
    assert.deepEqual(row, { status: 'quarantined', failure_code: 'duplicate_event_payload_mismatch', fact_bytes: firstBytes });
  });
});

test('v3 rejects evidence beyond 4KiB and fences appends at the 256MiB run budget', async () => {
  await withDatabase(() => {
    assert.equal(usageStatisticsV3Db.claimRun(run()), true);
    assert.throws(() => usageStatisticsV3Db.appendFact('run-a', 'writer-a', 1, fact({
      evidence: {
        sourceKey: 'codex:/root-a', generation: 1, byteStart: 0, byteEnd: 120,
        manifestFingerprint: 'x'.repeat(4_097),
      },
    })), /4KiB/);
    getConnection().prepare('UPDATE usage_statistics_runs SET fact_bytes = ? WHERE run_id = ?').run(256 * 1024 * 1024, 'run-a');
    assert.equal(usageStatisticsV3Db.appendFact('run-a', 'writer-a', 1, fact()), false);
    assert.equal((getConnection().prepare('SELECT COUNT(*) AS count FROM usage_statistics_facts').get() as { count: number }).count, 0);
  });
});

test('v3 repository enforces 100k/source, 500k/run, and 256 sources without large fixtures', async () => {
  await withDatabase(() => {
    assert.equal(usageStatisticsV3Db.claimRun(run()), true);
    getConnection().prepare('UPDATE usage_statistics_runs SET fact_count = ? WHERE run_id = ?').run(500_000, 'run-a');
    const runFactAccepted = usageStatisticsV3Db.appendFact('run-a', 'writer-a', 1, fact());
    const snapshot = {
      sourceKey: 'codex:/bounded-source', sourceGeneration: 1, contentSha256: sha256('content'),
      sizeBytes: 1, factCount: 0, terminalVectorSha256: sha256('vector'), manifestFingerprint: 'manifest-a',
    };
    assert.equal(usageStatisticsV3Db.claimRun(run({ runId: 'source-run', rootSessionId: 'source-root',
      leaseOwner: 'source-writer' })), true);
    getConnection().prepare('UPDATE usage_statistics_runs SET source_count = ? WHERE run_id = ?').run(256, 'source-run');
    const sourceAccepted = usageStatisticsV3Db.recordSourceSnapshot('source-run', 'source-writer', 1, snapshot);

    assert.equal(usageStatisticsV3Db.claimRun(run({ runId: 'source-facts', rootSessionId: 'source-facts-root',
      leaseOwner: 'source-facts-writer' })), true);
    const oversizedSnapshotAccepted = usageStatisticsV3Db.recordSourceSnapshot('source-facts', 'source-facts-writer', 1, {
      ...snapshot, sourceKey: 'codex:/too-many-facts', factCount: 100_001,
    });
    assert.deepEqual({ runFactAccepted, sourceAccepted, oversizedSnapshotAccepted }, {
      runFactAccepted: false, sourceAccepted: false, oversizedSnapshotAccepted: false,
    });
  });
});

test('v3 persistence hashes source identity and never stores raw paths or PII in fact evidence', async () => {
  await withDatabase(() => {
    const rawSource = '/home/user/private/customer@example.com/rollout.jsonl';
    assert.equal(usageStatisticsV3Db.claimRun(run({
      manifestFingerprint: sha256('manifest'),
      evidence: { sourceKey: rawSource, generation: 1, manifestFingerprint: sha256('manifest') },
    })), true);
    assert.equal(usageStatisticsV3Db.appendFact('run-a', 'writer-a', 1, fact({
      eventKey: `${rawSource}+1+0`,
      evidence: { sourceKey: rawSource, generation: 1, byteStart: 0, byteEnd: 120 },
    })), true);
    assert.equal(usageStatisticsV3Db.recordSourceSnapshot('run-a', 'writer-a', 1, {
      sourceKey: rawSource, sourceGeneration: 1, contentSha256: sha256('content'), sizeBytes: 120,
      factCount: 1, terminalVectorSha256: sha256('vector'), manifestFingerprint: sha256('manifest'),
    }), true);
    assert.equal(usageStatisticsV3Db.appendLineage('run-a', 'writer-a', 1, {
      rootSessionId: 'root-a', parentThreadId: 'parent', spawnCallId: 'spawn', agentThreadId: 'child',
      childGeneration: 1, sourceKey: rawSource,
    }), true);

    const persisted = JSON.stringify({
      run: getConnection().prepare('SELECT evidence_json FROM usage_statistics_runs WHERE run_id = ?').get('run-a'),
      fact: getConnection().prepare('SELECT event_key, evidence_json FROM usage_statistics_facts WHERE run_id = ?').get('run-a'),
      event: getConnection().prepare('SELECT event_key_hash, source_identity_hash FROM usage_run_events_v3 WHERE run_id = ?').get('run-a'),
      source: getConnection().prepare('SELECT source_identity_hash FROM usage_source_snapshots_v3 WHERE run_id = ?').get('run-a'),
      lineage: getConnection().prepare('SELECT source_key FROM usage_statistics_lineage WHERE run_id = ?').get('run-a'),
    });
    assert.doesNotMatch(persisted, /alice|customer@example\.com|rollout\.jsonl|\/home\//);
  });
});

test('nested parent lineage publishes only when every child source is sealed', async () => {
  await withDatabase(() => {
    assert.equal(usageStatisticsV3Db.claimRun(run({ evidence: { workDurationRequired: true } })), true);
    const lineages = [
      { parentThreadId: 'root-a', spawnCallId: 'spawn-1', agentThreadId: 'child-1', sourceKey: 'codex:/child-1' },
      { parentThreadId: 'child-1', spawnCallId: 'spawn-2', agentThreadId: 'child-2', sourceKey: 'codex:/child-2' },
    ];
    for (const [index, lineage] of lineages.entries()) {
      assert.equal(usageStatisticsV3Db.appendLineage('run-a', 'writer-a', 1, {
        rootSessionId: 'root-a', childGeneration: 1, ...lineage,
      }), true);
      assert.equal(usageStatisticsV3Db.recordSourceSnapshot('run-a', 'writer-a', 1, {
        sourceKey: lineage.sourceKey, sourceGeneration: 1, contentSha256: sha256(`content-${index}`),
        sizeBytes: 1, factCount: 0, terminalVectorSha256: sha256(`vector-${index}`),
        manifestFingerprint: 'manifest-a',
      }), true);
    }
    assert.equal(usageStatisticsV3Db.setRunWorkDuration('run-a', 'writer-a', 1, 0), true);
    assert.equal(usageStatisticsV3Db.finalizeReady('run-a', 'writer-a', 1), true);
    assert.deepEqual(usageStatisticsV3Db.getReadyProjectionMeta('run-a'), {
      sourceCount: 2, lineageCount: 2, subagentRolloutCount: 0, workDurationMs: 0,
    });
  });
});

test('v3 reader applies [since, until) exactly and preserves caller attribution', async () => {
  await withDatabase(() => {
    const priorWriter = process.env.USAGE_STATISTICS_V3_WRITER;
    const priorReader = process.env.USAGE_STATISTICS_V3_READER;
    process.env.USAGE_STATISTICS_V3_WRITER = 'on';
    delete process.env.USAGE_STATISTICS_V3_READER;
    establishTrustedSpawnOwner('root-a');
    const proof: UsageV3ProcessProof = {
      processIdentityId: 'proc-window', hostBootId: 'boot-window', pid: 101, procStartTicks: '501',
    };
    const key = { ownerUserId: 1, provider: 'codex', rootSessionId: 'root-a',
      scopeFingerprint: 'scope-a', attributionFingerprint: 'attribution-a' };
    const sourceIdentityHash = sha256('canonical-window-source');
    const merkle = { receiptId: 'receipt-window', sourceRootHex: sha256('window-source-root'),
      topologyRootHex: sha256('window-topology-root'), rootSourceIdentityHash: sourceIdentityHash,
      envelopeJson: '{"manifestVersion":1,"fixture":"window"}' };
    try {
      assert.deepEqual(usageStatisticsV3Db.beginPreflight({ ...key, authorityId: 'authority-window',
        receiptId: merkle.receiptId, proof, nowMonotonicNs: 1n, leaseDeadlineMonotonicNs: 100n }),
      { token: 1, attemptNo: 1 });
      const preflight = { status: 'preflighting' as const, activePreflightId: merkle.receiptId,
        activeRunId: null, token: 1, proof, leaseDeadlineMonotonicNs: 100n };
      assert.equal(usageStatisticsV3Db.recordPreflightSource(key, preflight, 2n, {
        receiptId: merkle.receiptId, sourceIdentityHash, generation: 0,
        descriptorJson: '{"ctimeNs":"1","deviceId":"1","inode":"1","sizeBytes":2,"contentSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
      }), true);
      assert.equal(usageStatisticsV3Db.recordPreflightMerkle(key, preflight, 2n, merkle), true);
      assert.equal(usageStatisticsV3Db.passPreflight(key, merkle.receiptId, 1, proof, 100n, 2n, 10_000), true);
      assert.equal(usageStatisticsV3Db.claimCanonicalRun({ ...key, receiptId: merkle.receiptId,
        runId: 'run-window', token: 2, proof, nowMonotonicNs: 2n, expectedLeaseDeadlineMonotonicNs: 100n,
        leaseDeadlineMonotonicNs: 100n,
        retainUntilMs: 20_000, metricsFingerprint: 'metrics-window', pricingVersion: 'prices-window',
        envelopeJson: merkle.envelopeJson }), true);
      const running = { status: 'running' as const, activePreflightId: merkle.receiptId,
        activeRunId: 'run-window', token: 3, proof, leaseDeadlineMonotonicNs: 100n };
      for (const [byteStart, occurredAt] of [
        [0, '2026-09-22T10:00:00.000Z'],
        [1, '2026-09-22T11:00:00.000Z'],
      ] as const) {
        assert.equal(usageStatisticsV3Db.recordCanonicalFact(key, running, 3n, {
          eventKey: sha256(`${sourceIdentityHash}+0+${byteStart}`), sourceIdentityHash,
          sourceGeneration: 0, byteStart, occurredAt, model: 'gpt-5', inputTokens: 10,
          outputTokens: 2, cachedInputTokens: 3, requestCount: 1, isSubagent: false,
          evidence: { generation: 0, byteStart },
        }), true);
      }
      assert.equal(usageStatisticsV3Db.setCanonicalWorkDuration(key, running, 3n, 1_000), true);
      assert.equal(usageStatisticsV3Db.finalizeCanonicalRun(key, running, 3n, merkle), true);

      const ready = readReadyUsageV3({ sessionId: 'root-a', scopeFingerprint: 'scope-a',
        attributionFingerprint: 'attribution-a', metricsFingerprint: 'metrics-window',
        since: '2026-09-22T10:00:00.000Z', until: '2026-09-22T11:00:00.000Z' });
      assert.deepEqual(ready?.facts.map((item) => item.occurredAt), ['2026-09-22T10:00:00.000Z']);
      assert.deepEqual(ready?.window, { since: '2026-09-22T10:00:00.000Z', until: '2026-09-22T11:00:00.000Z' });
      assert.deepEqual(ready?.attribution, { scopeFingerprint: 'scope-a', attributionFingerprint: 'attribution-a' });
    } finally {
      if (priorWriter === undefined) delete process.env.USAGE_STATISTICS_V3_WRITER;
      else process.env.USAGE_STATISTICS_V3_WRITER = priorWriter;
      if (priorReader === undefined) delete process.env.USAGE_STATISTICS_V3_READER;
      else process.env.USAGE_STATISTICS_V3_READER = priorReader;
    }
  });
});

test('rollback blocks the v3 background writer before manifest or database mutation', async () => {
  await withDatabase(async () => {
    const writer = process.env.USAGE_STATISTICS_V3_WRITER;
    const reader = process.env.USAGE_STATISTICS_V3_READER;
    try {
      process.env.USAGE_STATISTICS_V3_WRITER = 'on';
      process.env.USAGE_STATISTICS_V3_READER = 'rollback';
      assert.equal(await buildCodexStatisticsV3({
        sessionId: 'session-a', transcriptPath: '/path/that/must/not/be-read.jsonl', scopeFingerprint: 'scope',
        attributionFingerprint: 'attribution', metricsFingerprint: 'metrics', pricingVersion: 'prices',
      }), 'off');
      assert.equal((getConnection().prepare('SELECT COUNT(*) AS count FROM usage_statistics_runs').get() as { count: number }).count, 0);
    } finally {
      if (writer === undefined) delete process.env.USAGE_STATISTICS_V3_WRITER; else process.env.USAGE_STATISTICS_V3_WRITER = writer;
      if (reader === undefined) delete process.env.USAGE_STATISTICS_V3_READER; else process.env.USAGE_STATISTICS_V3_READER = reader;
    }
  });
});

test('v3 writer rejects records beyond 4MiB and oversized manifests before expensive traversal', async () => {
  await withDatabase(async () => {
    const writer = process.env.USAGE_STATISTICS_V3_WRITER;
    const directory = await mkdtemp('/var/tmp/usage-statistics-v3-bounds-');
    const rootId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const transcript = path.join(directory, `rollout-${rootId}.jsonl`);
    try {
      process.env.USAGE_STATISTICS_V3_WRITER = 'on';
      establishTrustedSpawnOwner(rootId);
      await writeFile(transcript, `${JSON.stringify({ type: 'session_meta', payload: {
        id: rootId, session_id: rootId, thread_source: 'user', padding: 'x'.repeat(4 * 1024 * 1024),
      } })}\n`);
      const file = await stat(transcript);
      const manifest = { root: { sessionId: rootId, threadId: rootId }, linked: [], spawns: [], spawnCount: 0,
        files: [{ rolloutPath: transcript, model: 'gpt-5', size: file.size, mtimeMs: file.mtimeMs }], complete: true,
        limitReason: null } as never;
      assert.equal(await buildCodexStatisticsV3({ sessionId: rootId, transcriptPath: transcript,
        scopeFingerprint: 'scope', attributionFingerprint: 'attribution', metricsFingerprint: 'metrics',
        pricingVersion: 'prices', ownerUserId: 1, manifest }), 'failed');

      const tooManySources = { ...manifest, files: Array.from({ length: 257 }, (_, index) => ({
        rolloutPath: `/must/not/read/source-${index}`, model: null, size: 0, mtimeMs: 0,
      })) } as never;
      assert.equal(await buildCodexStatisticsV3({ sessionId: rootId, transcriptPath: transcript,
        scopeFingerprint: 'scope', attributionFingerprint: 'attribution', metricsFingerprint: 'metrics',
        pricingVersion: 'prices', ownerUserId: 1, manifestResolver: async () => tooManySources }), 'incomplete');
      const tooManyEdges = { ...manifest, linked: Array.from({ length: 513 }, () => ({})) } as never;
      assert.equal(await buildCodexStatisticsV3({ sessionId: rootId, transcriptPath: transcript,
        scopeFingerprint: 'scope', attributionFingerprint: 'attribution', metricsFingerprint: 'metrics',
        pricingVersion: 'prices', ownerUserId: 1, manifestResolver: async () => tooManyEdges }), 'incomplete');
    } finally {
      if (writer === undefined) delete process.env.USAGE_STATISTICS_V3_WRITER; else process.env.USAGE_STATISTICS_V3_WRITER = writer;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('ready promotion atomically supersedes the old matching root and rejects a stale fence', async () => {
  await withDatabase(() => {
    assert.equal(usageStatisticsV3Db.claimRun(run({ runId: 'old', generation: 1, leaseOwner: 'old-writer' })), true);
    assert.equal(usageStatisticsV3Db.finalizeReady('old', 'old-writer', 1), true);
    assert.equal(usageStatisticsV3Db.claimRun(run({ runId: 'new', generation: 2, leaseOwner: 'new-writer' })), true);
    assert.equal(usageStatisticsV3Db.finalizeReady('new', 'old-writer', 1), false);
    assert.equal(usageStatisticsV3Db.finalizeReady('new', 'new-writer', 2), true);
    assert.deepEqual(getConnection().prepare('SELECT run_id, status FROM usage_statistics_runs ORDER BY run_id').all(), [
      { run_id: 'new', status: 'ready' }, { run_id: 'old', status: 'superseded' },
    ]);
  });
});

test('two concurrent writers receive monotonic authority tokens and only the winner can append', async () => {
  await withDatabase(async () => {
    const contenders = [
      run({ runId: 'race-a', rootSessionId: 'race-root', sessionId: 'race-session', generation: 11,
        leaseOwner: 'race-writer-a', evidence: { generation: 11 } }),
      run({ runId: 'race-b', rootSessionId: 'race-root', sessionId: 'race-session', generation: 12,
        leaseOwner: 'race-writer-b', evidence: { generation: 12 } }),
    ];
    const workers = contenders.map((input) => spawn(process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', claimProcessSource], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: path.resolve('server/tsconfig.json'),
        USAGE_V3_RUN: JSON.stringify(input),
        USAGE_V3_REPOSITORY_URL: new URL('./usage-statistics-v3.db.ts', import.meta.url).href,
        USAGE_V3_CONNECTION_URL: new URL('../connection.ts', import.meta.url).href,
      },
    }));
    const exits = workers.map((worker) => once(worker, 'exit'));
    const readers = workers.map((worker) => createInterface({ input: worker.stdout! })[Symbol.asyncIterator]());
    await Promise.all(readers.map(async (reader) => {
      const message = await reader.next();
      assert.deepEqual(message, { value: 'ready', done: false });
    }));
    const results = readers.map((reader) => reader.next());
    workers.forEach((worker) => worker.stdin!.end('claim\n'));
    for (const pending of results) {
      const message = await pending;
      assert.equal(message.done, false);
      assert.deepEqual(JSON.parse(message.value ?? ''), { claimed: true });
    }
    await Promise.all(exits);

    const rows = getConnection().prepare(`SELECT run_id AS runId, generation, authority_token AS authorityToken
      FROM usage_statistics_runs WHERE root_session_id = ? ORDER BY authority_token`).all('race-root') as Array<{
        runId: string; generation: number; authorityToken: number;
      }>;
    assert.deepEqual(rows.map((row) => row.authorityToken), [1, 2]);
    const authority = getConnection().prepare(`SELECT authority_token AS authorityToken, active_run_id AS activeRunId
      FROM usage_root_authority_v3 WHERE root_session_id = ?`).get('race-root') as {
        authorityToken: number; activeRunId: string;
      };
    assert.equal(authority.authorityToken, 2);
    const active = rows.find((row) => row.runId === authority.activeRunId)!;
    const stale = rows.find((row) => row.runId !== authority.activeRunId)!;
    const raceFact = (generation: number): UsageStatisticsV3Fact => fact({
      evidence: { sourceKey: 'codex:/race', generation, byteStart: 0, byteEnd: 1 },
    });
    assert.equal(usageStatisticsV3Db.appendFact(stale.runId, `race-writer-${stale.runId.endsWith('a') ? 'a' : 'b'}`,
      stale.generation, raceFact(stale.generation)), false);
    assert.equal(usageStatisticsV3Db.appendFact(active.runId, `race-writer-${active.runId.endsWith('a') ? 'a' : 'b'}`,
      active.generation, raceFact(active.generation)), true);
  });
});

test('lease expiry during publish leaves the previous ready run untouched', async () => {
  await withDatabase(() => {
    assert.equal(usageStatisticsV3Db.claimRun(run({ runId: 'lease-old', rootSessionId: 'lease-root',
      generation: 1, leaseOwner: 'lease-old-writer' })), true);
    assert.equal(usageStatisticsV3Db.finalizeReady('lease-old', 'lease-old-writer', 1), true);
    assert.equal(usageStatisticsV3Db.claimRun(run({ runId: 'lease-new', rootSessionId: 'lease-root',
      generation: 2, leaseOwner: 'lease-new-writer' })), true);
    getConnection().prepare('UPDATE usage_statistics_runs SET lease_expires_at_ms = ? WHERE run_id = ?')
      .run(Date.now() - 1, 'lease-new');
    assert.equal(usageStatisticsV3Db.finalizeReady('lease-new', 'lease-new-writer', 2), false);
    assert.deepEqual(getConnection().prepare(`SELECT run_id, status FROM usage_statistics_runs
      WHERE root_session_id = ? ORDER BY run_id`).all('lease-root'), [
      { run_id: 'lease-new', status: 'building' },
      { run_id: 'lease-old', status: 'ready' },
    ]);
  });
});

test('source snapshot and manifest identity changes cannot publish', async () => {
  await withDatabase(() => {
    assert.equal(usageStatisticsV3Db.claimRun(run({ runId: 'source-change', rootSessionId: 'source-root',
      leaseOwner: 'source-writer' })), true);
    const snapshot = {
      sourceKey: 'codex:/source-a', sourceGeneration: 1, contentSha256: sha256('content-a'),
      sizeBytes: 10, factCount: 0, terminalVectorSha256: sha256('vector-a'), manifestFingerprint: 'manifest-a',
    };
    assert.equal(usageStatisticsV3Db.recordSourceSnapshot('source-change', 'source-writer', 1, snapshot), true);
    assert.equal(usageStatisticsV3Db.recordSourceSnapshot('source-change', 'source-writer', 1, {
      ...snapshot, contentSha256: sha256('content-b'),
    }), false);
    assert.deepEqual(getConnection().prepare('SELECT status, failure_code FROM usage_statistics_runs WHERE run_id = ?')
      .get('source-change'), { status: 'quarantined', failure_code: 'source_snapshot_mismatch' });

    assert.equal(usageStatisticsV3Db.claimRun(run({ runId: 'manifest-change', rootSessionId: 'manifest-root',
      leaseOwner: 'manifest-writer' })), true);
    assert.equal(usageStatisticsV3Db.recordSourceSnapshot('manifest-change', 'manifest-writer', 1, {
      ...snapshot, sourceKey: 'codex:/source-b', manifestFingerprint: 'manifest-b',
    }), true);
    assert.throws(() => usageStatisticsV3Db.finalizeReady('manifest-change', 'manifest-writer', 1),
      /USAGE_V3_FINALIZE_VALIDATION_FAILED/);
    assert.deepEqual(getConnection().prepare('SELECT status, completed_at FROM usage_statistics_runs WHERE run_id = ?')
      .get('manifest-change'), { status: 'building', completed_at: null });
  });
});

test('v3 adapter keeps an unresolved child incomplete and never creates a run', async () => {
  await withDatabase(async () => {
    const previous = process.env.USAGE_STATISTICS_V3_WRITER;
    const directory = await mkdtemp('/var/tmp/usage-statistics-v3-rollout-');
    const rootId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const childId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const transcript = path.join(directory, `rollout-${rootId}.jsonl`);
    try {
      process.env.USAGE_STATISTICS_V3_WRITER = 'on';
      establishTrustedSpawnOwner(rootId);
      await writeFile(transcript, `${JSON.stringify({ type: 'session_meta', payload: {
        id: rootId, session_id: rootId, thread_source: 'user', model: 'gpt-5',
      } })}\n${JSON.stringify({ type: 'event_msg', payload: {
        type: 'sub_agent_activity', kind: 'started', agent_thread_id: childId, agent_path: '/root/missing',
      } })}\n`);
      assert.equal(await buildCodexStatisticsV3({
        sessionId: rootId, transcriptPath: transcript, scopeFingerprint: 'scope', attributionFingerprint: 'attribution',
        metricsFingerprint: 'metrics', pricingVersion: 'prices',
      }), 'incomplete');
      assert.equal((getConnection().prepare('SELECT COUNT(*) AS count FROM usage_statistics_runs').get() as { count: number }).count, 0);
    } finally {
      if (previous === undefined) delete process.env.USAGE_STATISTICS_V3_WRITER; else process.env.USAGE_STATISTICS_V3_WRITER = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('v3 retry resolves a child added between attempts and never publishes the old topology', async () => {
  await withDatabase(async () => {
    const previous = process.env.USAGE_STATISTICS_V3_WRITER;
    const directory = await mkdtemp('/var/tmp/usage-statistics-v3-retry-topology-');
    const rootId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const childId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const transcript = path.join(directory, `rollout-${rootId}.jsonl`);
    const child = path.join(directory, `rollout-${childId}.jsonl`);
    try {
      process.env.USAGE_STATISTICS_V3_WRITER = 'on';
      establishTrustedSpawnOwner(rootId);
      await writeFile(transcript, [
        JSON.stringify({ type: 'session_meta', payload: { id: rootId, session_id: rootId, thread_source: 'user' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_result', id: 'work-root', totalDurationMs: 1_000 } }),
        JSON.stringify({ timestamp: '2026-09-22T10:00:00.000Z', type: 'event_msg', payload: { type: 'token_count',
          model: 'gpt-5', info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 1 } } } }),
      ].join('\n') + '\n');
      const rootStat = await stat(transcript);
      const spawn = { callId: 'call-child', taskName: 'child', linkKind: 'direct', agentPath: '/root/child',
        agentThreadId: childId, childRolloutPath: child, occurredAtMs: Date.parse('2026-09-22T10:00:00.500Z') };
      const root = { models: ['gpt-5'], model: 'gpt-5', threadId: rootId, sessionId: rootId,
        parentThreadId: null, threadSource: 'user', sourceIsSubagent: false, agentPath: null, agentRole: null,
        spawns: [spawn], snapshotStable: true, snapshotSize: rootStat.size, snapshotMtimeMs: rootStat.mtimeMs };
      const rootFile = { rolloutPath: transcript, model: 'gpt-5', size: rootStat.size, mtimeMs: rootStat.mtimeMs };
      const incomplete = { root, linked: [], spawns: [spawn], spawnCount: 1, files: [rootFile],
        complete: false, limitReason: 'child_not_found' } as never;
      let childVisible = false;
      let complete: typeof incomplete | undefined;
      let resolutions = 0;
      const sleeps: number[] = [];
      const built = await buildCodexStatisticsV3({ sessionId: rootId, transcriptPath: transcript,
        scopeFingerprint: 'scope', attributionFingerprint: 'attribution', metricsFingerprint: 'metrics',
        pricingVersion: 'prices', ownerUserId: 1,
        manifestResolver: async () => { resolutions += 1; return childVisible ? complete! : incomplete; },
        retryPolicy: { nowMs: () => 0, sleep: async (ms) => {
          sleeps.push(ms);
          await writeFile(child, [
            JSON.stringify({ type: 'session_meta', payload: { id: childId, session_id: childId,
              parent_thread_id: rootId, thread_source: 'subagent' } }),
            JSON.stringify({ timestamp: '2026-09-22T10:00:01.000Z', type: 'event_msg', payload: { type: 'token_count',
              model: 'gpt-5', info: { total_token_usage: { input_tokens: 4, cached_input_tokens: 1, output_tokens: 1 } } } }),
          ].join('\n') + '\n');
          const childStat = await stat(child);
          complete = { root, linked: [{ rolloutPath: child, model: 'gpt-5', parentThreadId: rootId, spawn }],
            spawns: [spawn], spawnCount: 1, files: [rootFile,
              { rolloutPath: child, model: 'gpt-5', size: childStat.size, mtimeMs: childStat.mtimeMs }],
            complete: true, limitReason: null } as never;
          childVisible = true;
        } },
      });
      assert.equal(built, 'ready');
      assert.equal(resolutions, 2);
      assert.deepEqual(sleeps, [1_000]);
      const ready = readReadyUsageV3({ sessionId: rootId, scopeFingerprint: 'scope',
        attributionFingerprint: 'attribution', metricsFingerprint: 'metrics' });
      assert.deepEqual(ready?.counts, { facts: 2, requests: 2, rolloutCount: 2, subagentSpawnCount: 1,
        subagentRolloutCount: 1, subagentRequestCount: 1, subagentRequests: 1 });
    } finally {
      if (previous === undefined) delete process.env.USAGE_STATISTICS_V3_WRITER;
      else process.env.USAGE_STATISTICS_V3_WRITER = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('v3 writer and reader preserve delta vectors, model switches, request counts, and cache reads', async () => {
  await withDatabase(async () => {
    const previous = process.env.USAGE_STATISTICS_V3_WRITER;
    const renewPreflightLease = usageStatisticsV3Db.renewPreflightLease;
    const renewedStatuses: string[] = [];
    const directory = await mkdtemp('/var/tmp/usage-statistics-v3-ready-');
    const rootId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const transcript = path.join(directory, `rollout-${rootId}.jsonl`);
    try {
      process.env.USAGE_STATISTICS_V3_WRITER = 'on';
      usageStatisticsV3Db.renewPreflightLease = (key, expected, now, next) => {
        renewedStatuses.push(expected.status);
        return renewPreflightLease(key, expected, now, next);
      };
      establishTrustedSpawnOwner(rootId);
      const event = (timestamp: string, model: string, input: number, cached: number, output: number) => [
        JSON.stringify({ type: 'turn_context', payload: { model } }),
        JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
        } } }),
      ];
      await writeFile(transcript, [
        JSON.stringify({ type: 'session_meta', payload: { id: rootId, session_id: rootId, thread_source: 'user' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_result', id: 'work-1', totalDurationMs: 60_000 } }),
        ...event('2026-09-22T10:00:00.000Z', 'gpt-5.2-codex', 10, 2, 1),
        ...event('2026-09-22T10:01:00.000Z', 'gpt-5.6-sol', 30, 7, 4),
      ].join('\n') + '\n');
      const buildStartedAt = Date.now();
      const built = await buildCodexStatisticsV3({
        sessionId: rootId, transcriptPath: transcript, scopeFingerprint: 'scope', attributionFingerprint: 'attribution',
        metricsFingerprint: 'metrics', pricingVersion: 'prices', ownerUserId: 1,
      });
      assert.equal(built, 'ready', JSON.stringify({
        authority: getConnection().prepare('SELECT status, token FROM usage_v3_preflight_authorities').get(),
        runs: getConnection().prepare('SELECT status, failure_code, fact_count, work_duration_ms FROM usage_v3_canonical_runs').all(),
      }));
      assert.equal(renewedStatuses.includes('preflight_passed'), false,
        'the passed tuple must flow directly into claim without renewal');
      const usage = readReadyUsageV3({ sessionId: rootId, scopeFingerprint: 'scope', attributionFingerprint: 'attribution',
        metricsFingerprint: 'metrics' });
      assert.ok(usage);
      assert.deepEqual(usage.usage.perModel, [
        { model: 'gpt-5.2-codex', requests: 1, totals: { input: 8, output: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 2 } },
        { model: 'gpt-5.6-sol', requests: 1, totals: { input: 15, output: 3, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 5 } },
      ]);
      assert.equal(usage.usage.subagentRequests, 0);
      assert.equal(usage.usage.snapshotStatus, 'complete');
      assert.equal(usage.facts.length, 2);
      assert.deepEqual(usage.counts, { facts: 2, requests: 2, rolloutCount: 1, subagentSpawnCount: 0,
        subagentRolloutCount: 0, subagentRequestCount: 0, subagentRequests: 0 });
      assert.deepEqual(usage.durations, { workDurationMs: 60_000 });
      const cost = calculateSessionCost(usage.usage);
      assert.equal(cost.totalUsd, cost.perModel.reduce((sum, row) => sum + (row.costUsd ?? 0), 0));
      assert.deepEqual(cost.perModel.map((row) => [row.model, row.requests, row.tokens]),
        usage.usage.perModel.map((row) => [row.model, row.requests, row.totals]));
    } finally {
      usageStatisticsV3Db.renewPreflightLease = renewPreflightLease;
      if (previous === undefined) delete process.env.USAGE_STATISTICS_V3_WRITER; else process.env.USAGE_STATISTICS_V3_WRITER = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
