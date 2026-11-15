/**
 * ADR-229, stage S0 (acceptance first): project stats ignore the hidden
 * conversations of the removed Kimi, Qwen Code and Hermes harnesses.
 *
 * `GET /api/projects/:id/stats` reads two values from the project's session
 * rows (project-stats.routes.ts readProjectAgents / readProjectActivityThrough).
 * A hidden conversation must not feed either: its agents must not appear in the
 * roster and its activity must not move the "activity through" day. The
 * cursor and agy (antigravity) conversations keep feeding both.
 *
 * Fails today: the hidden rows are still read.
 *
 * The cost ledger is mocked exactly as in project-stats.routes.test.ts: this file
 * tests which sessions the route reads, not the ledger.
 *
 * Runner:
 *   TMPDIR=/var/tmp bash scripts/run-without-core.sh node scripts/run-isolated-node-tests.mjs server \
 *     server/modules/projects/tests/removed-harness-hidden.project-stats.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

const url = (relative: string): string => pathToFileURL(path.resolve(import.meta.dirname, relative)).href;

mock.module(url('../../providers/services/cost/cost-ledger.service.js'), {
  namedExports: {
    costLedgerService: {
      scan: async () => ({}),
      getProjectTotal: async () => ({ measured: false }),
      getProjectDaily: async () => [],
      getProjectStats: async () => ({}),
    },
    startCostLedgerScheduler: () => {},
    stopCostLedgerScheduler: () => {},
  },
});

const { closeConnection, initializeDatabase, participantsDb, projectsDb, sessionAgentsDb, sessionsDb, userDb } =
  await import('@/modules/database/index.js');
const { AppError } = await import('@/shared/utils.js');
const projectStatsRouter = (await import('../project-stats.routes.js')).default;

const HIDDEN = ['kimi', 'qwen', 'hermes'] as const;
const VISIBLE = ['cursor', 'antigravity'] as const;
const VISIBLE_DAY = '2026-11-01';
const HIDDEN_DAY = '2026-11-10';

let server: Server;
let baseUrl = '';
let ownerId = 0;
let projectId = '';
let workspace = '';

before(async () => {
  closeConnection();
  await initializeDatabase();
  ownerId = userDb.createUser('adr229-stats-owner', 'hash', 'owner').id;
  workspace = fs.mkdtempSync(path.join(os.homedir(), 'adr229-stats-'));
  const created = projectsDb.createProjectPath(workspace, 'ADR-229 stats', ownerId).project;
  assert.ok(created, 'project row created');
  projectId = created.project_id;

  let counter = 0;
  for (const provider of [...HIDDEN, ...VISIBLE]) {
    const hidden = (HIDDEN as readonly string[]).includes(provider);
    const at = `${hidden ? HIDDEN_DAY : VISIBLE_DAY}T10:00:00.000Z`;
    const sessionId = `00000229-0000-4000-9000-${String(++counter).padStart(12, '0')}`;
    sessionsDb.createSession(sessionId, provider, created.project_path, `${provider} conversation`, at, at);
    participantsDb.recordSpawn(sessionId, ownerId);
    sessionAgentsDb.replaceForSession(sessionId, [
      { agent_name: `${provider}-agent`, agent_kind: 'subagent', invocation_count: 1 },
    ], 1);
  }

  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: number; role: string } }).user = { id: ownerId, role: 'owner' };
    next();
  });
  app.use('/api/projects', projectStatsRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: String(err) } });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function readStats(): Promise<{ projectActivityThrough?: string | null; agents?: Array<{ name: string }> | null }> {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}/stats`);
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  return (JSON.parse(raw) as { stats: { projectActivityThrough?: string | null; agents?: Array<{ name: string }> } }).stats;
}

test('the agent roster lists only agents of visible conversations', async () => {
  const names = ((await readStats()).agents ?? []).map((agent) => agent.name);
  for (const provider of HIDDEN) assert.equal(names.includes(`${provider}-agent`), false, `${provider} agent hidden`);
  for (const provider of VISIBLE) assert.equal(names.includes(`${provider}-agent`), true, `${provider} agent listed`);
});

test('project activity runs through the newest VISIBLE conversation only', async () => {
  assert.equal((await readStats()).projectActivityThrough, VISIBLE_DAY);
});
