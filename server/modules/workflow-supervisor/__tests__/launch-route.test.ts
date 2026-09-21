/**
 * T-820 — the explicit launch route (POST /api/workflow-supervisor/launch),
 * end-to-end against a REAL migrated temp DB and a live HTTP listener.
 *
 * Proves the web surface's security posture:
 *   - flag OFF  => 404, ZERO intent on disk (the master no-op).
 *   - owner     => 202 + a valid DurableTask intent under intents/<ownerId>/.
 *   - non-owner => 403 + ZERO intent (fail-closed ownership pre-check).
 *   - bad input (traversal conversationId / missing prompt / relative path) =>
 *     400 + ZERO intent.
 * Identity always comes from req.user (the JWT), never the body.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  closeConnection,
  initializeDatabase,
  projectsDb,
  userDb,
} from '@/modules/database/index.js';
import launchRouter from '@/modules/workflow-supervisor/launch.route.js';

type Ctx = {
  ownerId: number;
  strangerId: number;
  projectPath: string;
  stateDir: string;
  baseUrl: string;
  setActingUser: (id: number) => void;
  close: () => Promise<void>;
};

async function setup(): Promise<Ctx> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'wf-route-'));
  const stateDir = path.join(tempRoot, 'state');
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'db.sqlite');
  process.env.WORKFLOW_SUPERVISOR_STATE_DIR = stateDir;
  await initializeDatabase();

  const ownerId = userDb.createUser('owner', 'hash', 'owner').id;
  const strangerId = userDb.createUser('stranger', 'hash', 'user').id;
  const projectPath = path.join(tempRoot, 'proj');
  projectsDb.createProjectPath(projectPath, null, ownerId);

  let actingUser = ownerId;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: number } }).user = { id: actingUser };
    next();
  });
  app.use('/api/workflow-supervisor', launchRouter);
  // Minimal AppError → HTTP mapper (mirrors the app's global handler shape).
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.statusCode ?? 500).json({ success: false, error: { code: err?.code, message: err?.message } });
  });

  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;

  return {
    ownerId,
    strangerId,
    projectPath,
    stateDir,
    baseUrl: `http://127.0.0.1:${port}`,
    setActingUser: (id) => {
      actingUser = id;
    },
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      closeConnection();
      delete process.env.DATABASE_PATH;
      delete process.env.WORKFLOW_SUPERVISOR;
      delete process.env.WORKFLOW_SUPERVISOR_STATE_DIR;
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

async function post(ctx: Ctx, body: unknown): Promise<Response> {
  return fetch(`${ctx.baseUrl}/api/workflow-supervisor/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function intentCount(stateDir: string, userId: number): Promise<number> {
  const dir = path.join(stateDir, 'intents', String(userId));
  const files = await readdir(dir).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith('.json')).length;
}

const goodBody = (projectPath: string) => ({
  projectPath,
  scriptOrPrompt: 'run the audit',
  conversationId: 'conv-1',
  originMessageId: 'msg-1',
  model: 'haiku',
});

test('launch route: flag OFF => 404 and ZERO intent on disk', async () => {
  const ctx = await setup();
  try {
    delete process.env.WORKFLOW_SUPERVISOR; // OFF
    const res = await post(ctx, goodBody(ctx.projectPath));
    assert.equal(res.status, 404);
    assert.equal(await intentCount(ctx.stateDir, ctx.ownerId), 0, 'no intent while the flag is off');
  } finally {
    await ctx.close();
  }
});

test('launch route: owner => 202 + a valid intent under intents/<ownerId>/', async () => {
  const ctx = await setup();
  try {
    process.env.WORKFLOW_SUPERVISOR = '1';
    ctx.setActingUser(ctx.ownerId);
    const res = await post(ctx, goodBody(ctx.projectPath));
    assert.equal(res.status, 202);
    const json = (await res.json()) as { data?: { taskId?: string } };
    assert.ok(json.data?.taskId, 'a taskId is returned');
    assert.equal(await intentCount(ctx.stateDir, ctx.ownerId), 1, 'exactly one intent written');
  } finally {
    await ctx.close();
  }
});

test('launch route: NON-OWNER => 403 + ZERO intent (fail-closed ownership pre-check)', async () => {
  const ctx = await setup();
  try {
    process.env.WORKFLOW_SUPERVISOR = '1';
    ctx.setActingUser(ctx.strangerId); // valid user, does NOT own the project
    const res = await post(ctx, goodBody(ctx.projectPath));
    assert.equal(res.status, 403);
    assert.equal(await intentCount(ctx.stateDir, ctx.strangerId), 0, 'non-owner writes nothing');
    assert.equal(await intentCount(ctx.stateDir, ctx.ownerId), 0, 'and nothing under the owner either');
  } finally {
    await ctx.close();
  }
});

test('launch route: a path-traversal conversationId => 400 + ZERO intent', async () => {
  const ctx = await setup();
  try {
    process.env.WORKFLOW_SUPERVISOR = '1';
    ctx.setActingUser(ctx.ownerId);
    const res = await post(ctx, { ...goodBody(ctx.projectPath), conversationId: '../../etc/passwd' });
    assert.equal(res.status, 400);
    assert.equal(await intentCount(ctx.stateDir, ctx.ownerId), 0, 'a rejected request writes nothing');
  } finally {
    await ctx.close();
  }
});

test('launch route: missing scriptOrPrompt => 400; relative projectPath => 400', async () => {
  const ctx = await setup();
  try {
    process.env.WORKFLOW_SUPERVISOR = '1';
    ctx.setActingUser(ctx.ownerId);

    const noPrompt = await post(ctx, { ...goodBody(ctx.projectPath), scriptOrPrompt: '' });
    assert.equal(noPrompt.status, 400);

    const relPath = await post(ctx, { ...goodBody(ctx.projectPath), projectPath: 'relative/x' });
    assert.equal(relPath.status, 400);

    assert.equal(await intentCount(ctx.stateDir, ctx.ownerId), 0, 'no intent from invalid requests');
  } finally {
    await ctx.close();
  }
});
