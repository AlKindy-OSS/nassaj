import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';

import { applyAgentReviewSchema, sessionsDb, userDb } from '../../../../database/index.js';
import { AgentReviewIngestor } from '../../../services/agent-review-ingestor.js';
import { closeSessionsWatcher, initializeSessionsWatcher } from '../../../services/sessions-watcher.service.js';
import { ClaudeSessionSynchronizer } from '../claude-session-synchronizer.provider.js';

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const started = { type: 'started', key: 'k', agentId: 'agent-1' };
const result = { ...started, type: 'result', result: 'finished' };
const jsonl = (...rows: object[]): string => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
type Fixture = { db: Database.Database; sync: ClaudeSessionSynchronizer; journal: string; parent: string; projects: string; ingestor: AgentReviewIngestor };

async function fixture(t: TestContext, run: (value: Fixture) => Promise<void>, schema = true): Promise<void> {
  const artifacts = path.join(ROOT, '.artifacts'); await fs.mkdir(artifacts, { recursive: true });
  const root = await fs.mkdtemp(path.join(artifacts, 'c4-sync-'));
  const projects = path.join(root, '.claude/projects');
  const directory = path.join(projects, 'project/s/subagents/workflows/wf_1'); await fs.mkdir(directory, { recursive: true });
  const journal = path.join(directory, 'journal.jsonl'); const parent = path.join(projects, 'project/s.jsonl');
  await fs.writeFile(parent, jsonl({ type: 'user', sessionId: 's', cwd: '/synthetic-project' }));
  await fs.writeFile(journal, jsonl(started, result));
  const db = new Database(path.join(root, 'fixture.db')); db.pragma('foreign_keys=ON');
  if (schema) db.transaction(() => applyAgentReviewSchema(db)).immediate();
  db.exec('CREATE TABLE sessions(session_id TEXT PRIMARY KEY,provider TEXT,jsonl_path TEXT)');
  t.mock.method(os, 'homedir', () => root);
  t.mock.method(userDb, 'listUsers', () => []);
  t.mock.method(sessionsDb, 'getSessionById', () => null);
  t.mock.method(sessionsDb, 'getSessionFilePathsByProvider', () => []);
  t.mock.method(sessionsDb, 'createSession', (sessionId: string, provider: string, _project: string, _name: unknown,
    _created: unknown, _updated: unknown, file: string) => {
    db.prepare('INSERT INTO sessions VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET provider=excluded.provider,jsonl_path=excluded.jsonl_path')
      .run(sessionId, provider, file); return sessionId;
  });
  const ingestor = new AgentReviewIngestor(db, [projects]);
  try { await run({ db, sync: new ClaudeSessionSynchronizer(ingestor), journal, parent, projects, ingestor }); }
  finally { await closeSessionsWatcher(); t.mock.restoreAll(); db.close(); await fs.rm(root, { recursive: true, force: true }); }
}

test('full synchronizer indexes parents before exact workflow journals and restart replay adds no review event', async t => fixture(t, async ({ db, sync, journal, projects }) => {
  assert.equal(await sync.synchronize(), 1);
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM agent_review_events').get(), { n: 1 });
  const next = new ClaudeSessionSynchronizer(new AgentReviewIngestor(db, [projects]));
  assert.equal(await next.synchronize(), 1);
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM agent_review_events').get(), { n: 1 });
  const before = db.prepare('SELECT total_changes() AS n').get();
  assert.equal(await next.synchronizeFile(journal.replace('/workflows/wf_1/journal.jsonl', '/agent-ignore.jsonl')), null);
  assert.equal(await next.synchronizeFile(journal.replace('wf_1', 'invalid')), null);
  assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before);
}));

test('absent schema fails injected synchronization without creating C4 objects; default remains dormant', async t => fixture(t, async ({ db, sync, journal, parent }) => {
  const dormant = new ClaudeSessionSynchronizer();
  assert.equal(await dormant.synchronizeFile(journal), null);
  assert.equal(await dormant.synchronizeFile(parent), 's');
  await assert.rejects(sync.synchronizeFile(journal), /no such table/);
  assert.deepEqual(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'agent_review_%'").get(), { n: 0 });
}, false));

test('structural failure propagates from full sync and durable quarantine prevents a later successful scan', async t => fixture(t, async ({ db, sync, journal }) => {
  await fs.writeFile(journal, jsonl(started, started, result));
  await assert.rejects(sync.synchronize(), /ambiguous_launch/);
  await fs.writeFile(journal, jsonl(started, result));
  await assert.rejects(sync.synchronize(), /unavailable/);
  assert.deepEqual(db.prepare('SELECT reason,state FROM agent_review_quarantine_incidents').get(), { reason: 'ambiguous_launch', state: 'active' });
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM agent_review_events').get(), { n: 0 });
}));

test('configured topology cannot redirect a registered session to another project artifact', async t => fixture(t, async ({ sync, ingestor, projects, parent }) => {
  await sync.synchronizeFile(parent);
  await assert.rejects(ingestor.ingestFile(path.join(projects, 'other/s.jsonl')), /untrusted_provenance/);
  assert.equal(await ingestor.ingestFile(path.join(projects, 'project/s/subagents/other.jsonl')), null);
}));

class SyntheticWatcher extends EventEmitter {
  /** Release the synthetic watcher through the same lifecycle as the real watcher. */
  async close(): Promise<void> {}
}

test('existing watcher change event reaches synchronizer and atomic workflow fold without a second watcher', async t => fixture(t, async ({ db, sync, parent, journal, projects }) => {
  await sync.synchronizeFile(parent);
  const watcher = new SyntheticWatcher(); let watchCount = 0;
  let resolveSync!: () => void; let rejectSync!: (error: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => { resolveSync = resolve; rejectSync = reject; });
  await initializeSessionsWatcher({ targets: [{ provider: 'claude', rootPath: projects }],
    watch: (() => { watchCount++; queueMicrotask(() => watcher.emit('ready')); return watcher as unknown as FSWatcher; }) as never,
    requestSynchronization: () => undefined, startUsageBackfill: async () => undefined,
    onSynchronizationComplete: () => () => undefined,
    scheduleUsageIngestion: async () => undefined, resumeUsageBackfill: async () => undefined,
    synchronizeProviderFile: async (provider, file) => {
      try { const sessionId = await sync.synchronizeFile(file); resolveSync(); return { provider, indexed: !!sessionId, sessionId }; }
      catch (error) { rejectSync(error); throw error; }
    },
  });
  watcher.emit('change', journal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([completed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('watcher event timeout')), 2000); })]); }
  finally { clearTimeout(timer); }
  assert.equal(watchCount, 1);
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM agent_review_events').get(), { n: 1 });
}));
