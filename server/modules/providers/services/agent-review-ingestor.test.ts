import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { applyAgentReviewSchema, AgentReviewRepository } from '../../database/index.js';

import { parseAgentReviewRawEvidence } from './agent-review-raw-parser.js';
import { reviewBytesSha } from './agent-review-raw-evidence.js';
import { AgentReviewIngestor } from './agent-review-ingestor.js';

const source = { sessionId: 's', source: 'workflow' as const, workflowId: 'wf_1' };
const start = { type: 'started', key: 'key-1', agentId: 'agent-1' };
const result = { ...start, type: 'result', result: 'completed' };
const jsonl = (...rows: object[]): string => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

async function fixture(run: (context: { db: Database.Database; ingestor: AgentReviewIngestor; file: string; roots: string[];
  reopen: () => Database.Database }) => Promise<void>): Promise<void> {
  const artifacts = path.join(ROOT, '.artifacts'); await fs.mkdir(artifacts, { recursive: true });
  const root = await fs.mkdtemp(path.join(artifacts, 'c4-integration-'));
  const project = path.join(root, 'project'); const directory = path.join(project, 's/subagents/workflows/wf_1');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'journal.jsonl'); await fs.writeFile(file, jsonl(start, result));
  const dbPath = path.join(root, 'fixture.db'); const db = new Database(dbPath); db.pragma('foreign_keys=ON');
  db.transaction(() => applyAgentReviewSchema(db)).immediate();
  db.exec('CREATE TABLE sessions(session_id TEXT PRIMARY KEY, provider TEXT, jsonl_path TEXT)');
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run('s', 'claude', path.join(project, 's.jsonl'));
  try { await run({ db, ingestor: new AgentReviewIngestor(db, [root]), file, roots: [root], reopen: () => new Database(dbPath) }); }
  finally { if (db.open) db.close(); await fs.rm(root, { recursive: true, force: true }); }
}

function counts(db: Database.Database): unknown {
  return db.prepare(`SELECT (SELECT COUNT(*) FROM agent_review_results) AS results,
    (SELECT COUNT(*) FROM agent_review_events) AS events,(SELECT COUNT(*) FROM agent_review_ingestion_heads) AS heads,
    (SELECT COUNT(*) FROM agent_review_states) AS states,(SELECT COUNT(*) FROM agent_review_current) AS current`).get();
}

function failFirstRead(t: Parameters<Parameters<typeof test>[1]>[0], file: string): void {
  const open = fs.open.bind(fs); let reads = 0;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('/journal.jsonl')) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, 'read', async (options: Parameters<typeof handle.read>[0]) => {
        const value = await read(options); if (++reads === 1) await fs.appendFile(file, jsonl(start, result)); return value;
      });
    }
    return handle;
  });
}

test('actual workflow file to stable FD to atomic state; replay and restart reads write nothing', async () => fixture(async ({ db, ingestor, file, roots, reopen }) => {
  assert.deepEqual(await ingestor.ingest(source), { bindings: 0, completions: 1, headAdvanced: true });
  assert.deepEqual(counts(db), { results: 1, events: 1, heads: 1, states: 1, current: 1 });
  const before = db.prepare('SELECT total_changes() AS n').get();
  assert.deepEqual(await ingestor.ingest(source), { bindings: 0, completions: 0, headAdvanced: false });
  assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before);
  await fs.appendFile(file, jsonl(start, result));
  assert.equal((await ingestor.ingest(source)).completions, 1);
  db.close(); const reopened = reopen();
  try {
    const service = new AgentReviewIngestor(reopened, roots);
    assert.equal((await service.ingest(source)).headAdvanced, false);
    const reads = new AgentReviewRepository(reopened, { actorUserId: 1, assertCurrent: () => true });
    const unchanged = reopened.prepare('SELECT total_changes() AS n').get();
    assert.equal(reads.readSummary('s').total, 1); reads.listActiveIncidents('s', { afterId: 0, limit: 100 });
    assert.deepEqual(reopened.prepare('SELECT total_changes() AS n').get(), unchanged);
  } finally { reopened.close(); }
}));

test('raw Agent launch binding completion sets matching task; source paths cannot supply authority', async () => fixture(async ({ db, ingestor, file, roots }) => {
  const transcript = path.join(roots[0], 'project/s.jsonl');
  await fs.writeFile(transcript, jsonl(
    { type: 'assistant', sessionId: 's', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Agent', id: 'tool-1' }] } },
    { type: 'user', sessionId: 's', toolUseResult: { agentId: 'agent-1' }, message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] } },
    { type: 'queue-operation', operation: 'enqueue', sessionId: 's', content: '<task-notification><task-id>agent-1</task-id><tool-use-id>tool-1</tool-use-id><status>completed</status><result>done</result></task-notification>' },
  ));
  assert.equal((await ingestor.ingest({ sessionId: 's', source: 'agent' })).completions, 1);
  assert.deepEqual(db.prepare('SELECT task_id,agent_id,revision FROM agent_review_agent_bindings').get(), { task_id: 'agent-1', agent_id: 'agent-1', revision: 1 });
  db.prepare('UPDATE sessions SET jsonl_path=?').run(file);
  await assert.rejects(ingestor.ingest(source), /untrusted_provenance/);
  await assert.rejects(ingestor.ingest({ ...source, projectDirectory: roots[0] } as typeof source), /invalid_shape/);
}));

test('structural raw ambiguity is durable across restart; no read or later valid artifact clears it', async () => fixture(async ({ db, ingestor, file, roots, reopen }) => {
  await fs.writeFile(file, jsonl(start, start, result));
  await assert.rejects(ingestor.ingest(source));
  assert.deepEqual(counts(db), { results: 0, events: 0, heads: 0, states: 0, current: 0 });
  assert.deepEqual(db.prepare('SELECT reason,state,scope,scope_agent_id FROM agent_review_quarantine_incidents').get(),
    { reason: 'ambiguous_launch', state: 'active', scope: 'identity', scope_agent_id: 'agent-1' });
  await fs.writeFile(file, jsonl(start, result)); db.close(); const reopened = reopen();
  try {
    const before = reopened.prepare('SELECT total_changes() AS n').get();
    await assert.rejects(new AgentReviewIngestor(reopened, roots).ingest(source), /unavailable/);
    assert.deepEqual(reopened.prepare('SELECT total_changes() AS n').get(), before);
  } finally { reopened.close(); }
}));

test('successful retry records first failure, then recovers it with result and head in one transaction', async (t) => fixture(async ({ db, ingestor, file }) => {
  failFirstRead(t, file);
  assert.equal((await ingestor.ingest(source)).completions, 2);
  assert.deepEqual(db.prepare('SELECT reason,state,revision FROM agent_review_quarantine_incidents').get(),
    { reason: 'source_grew', state: 'recovered', revision: 1 });
}));

test('failed result write rolls back recovery, bindings/results/events/head and leaves prior incident active', async (t) => fixture(async ({ db, ingestor, file }) => {
  failFirstRead(t, file);
  db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON agent_review_events BEGIN SELECT RAISE(ABORT,'injected_failure'); END");
  await assert.rejects(ingestor.ingest(source), /injected_failure/);
  assert.deepEqual(counts(db), { results: 0, events: 0, heads: 0, states: 0, current: 0 });
  assert.deepEqual(db.prepare('SELECT state,revision FROM agent_review_quarantine_incidents').get(), { state: 'active', revision: 0 });
}));

test('session binding changed after FD read denies inside transaction before any effect', async (t) => fixture(async ({ db, ingestor }) => {
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('/journal.jsonl')) {
      const close = handle.close.bind(handle);
      t.mock.method(handle, 'close', async () => { await close(); db.prepare("UPDATE sessions SET provider='other'").run(); });
    }
    return handle;
  });
  await assert.rejects(ingestor.ingest(source), /untrusted_provenance/);
  assert.deepEqual(counts(db), { results: 0, events: 0, heads: 0, states: 0, current: 0 });
}));


test('storage structural failure rolls back its fold then records a durable incident separately', async () => fixture(async ({ db, ingestor, file }) => {
  await ingestor.ingest(source);
  const second = { ...source, workflowId: 'wf_2' };
  const otherDirectory = path.join(path.dirname(path.dirname(file)), 'wf_2');
  await fs.mkdir(otherDirectory); await fs.writeFile(path.join(otherDirectory, 'journal.jsonl'), jsonl(start, result));
  const before = counts(db);
  await assert.rejects(ingestor.ingest(second), /conflicting_binding/);
  assert.deepEqual(counts(db), before);
  assert.deepEqual(db.prepare('SELECT reason,state,scope,scope_agent_id FROM agent_review_quarantine_incidents').get(),
    { reason: 'conflicting_binding', state: 'active', scope: 'identity', scope_agent_id: 'agent-1' });
}));


test('truncated previously observed partial tail cannot pass as unchanged committed head', async () => fixture(async ({ db, ingestor, file }) => {
  await fs.appendFile(file, '{"partial":');
  await ingestor.ingest(source);
  const before = counts(db);
  await fs.truncate(file, Buffer.byteLength(jsonl(start, result)));
  await assert.rejects(ingestor.ingest(source), /truncated_source/);
  assert.deepEqual(counts(db), before);
  assert.deepEqual(db.prepare('SELECT reason,state FROM agent_review_quarantine_incidents').get(),
    { reason: 'truncated_source', state: 'active' });
}));


for (const column of ['provider', 'jsonl_path'] as const) {
  test(`incident guard rejects ${column} rebound by a second connection after precheck before BEGIN`, async (t) => fixture(async ({ db, ingestor, file, reopen }) => {
    await fs.writeFile(file, jsonl(start, start, result));
    const other = reopen(); const transaction = db.transaction.bind(db);
    const before = db.prepare('SELECT total_changes() AS n').get(); let intercepted = 0;
    t.mock.method(db, 'transaction', (callback: () => unknown) => {
      assert.equal(db.inTransaction, false); intercepted++;
      if (column === 'provider') other.prepare("UPDATE sessions SET provider='other'").run();
      else other.prepare("UPDATE sessions SET jsonl_path='/other/s.jsonl'").run();
      return transaction(callback);
    });
    try {
      await assert.rejects(ingestor.ingest(source), /untrusted_provenance/);
      assert.equal(intercepted, 1);
      assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before);
      assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM agent_review_quarantine_incidents').get(), { n: 0 });
    } finally { other.close(); }
  }));
}

for (const reason of ['reused_launch', 'invalid_sequence'] as const) {
  test(`proved storage ${reason} preserves bounded identity and exposes no result text`, async () => fixture(async ({ db, ingestor, file }) => {
    const evidence = parseAgentReviewRawEvidence(source, await fs.readFile(file));
    const completion = evidence.completions[0];
    const fakeGeneration = reviewBytesSha('stored-generation');
    db.prepare('INSERT INTO agent_review_results VALUES (?,?,?,?,?,?,?,?,?,?)').run('s', 'workflow', 'agent-1', fakeGeneration,
      evidence.container.sourceContainerId, 3, reason === 'reused_launch' ? completion.launchEvidenceSha256 : reviewBytesSha('other-launch'),
      reviewBytesSha('other-completion'), reviewBytesSha('other-payload'), '2026-09-24T00:00:00.000Z');
    if (reason === 'invalid_sequence') db.prepare('INSERT INTO agent_review_current VALUES (?,?,?,?,?,?,0,?)').run(
      's', 'workflow', 'agent-1', fakeGeneration, evidence.container.sourceContainerId, 3, '2026-09-24T00:00:00.000Z');
    const before = counts(db);
    await assert.rejects(ingestor.ingest(source), (error: unknown) => {
      assert.ok(error instanceof Error); assert.equal(error.message, reason);
      assert.equal(JSON.stringify(error).includes('completed'), false); return true;
    });
    assert.deepEqual(counts(db), before);
    assert.deepEqual(db.prepare('SELECT reason,scope,scope_agent_id FROM agent_review_quarantine_incidents').get(),
      { reason, scope: 'identity', scope_agent_id: 'agent-1' });
  }));
}

test('prefix change remains container-scoped with an empty identity', async () => fixture(async ({ db, ingestor, file }) => {
  await ingestor.ingest(source);
  await fs.writeFile(file, jsonl(start, { ...result, result: 'different' }));
  await assert.rejects(ingestor.ingest(source), /prefix_changed/);
  assert.deepEqual(db.prepare('SELECT reason,scope,scope_agent_id FROM agent_review_quarantine_incidents').get(),
    { reason: 'prefix_changed', scope: 'container', scope_agent_id: '' });
}));
