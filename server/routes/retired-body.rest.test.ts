/**
 * retired-body.rest.test.ts — T-1953 (ADR-192), review finding M1.
 *
 * The REST surfaces that accepted a retired body until now answer the same typed
 * refusal as the sockets — 400 with `code: 'provider_removed'`, before any
 * launcher is called:
 *
 *   - `POST /api/agent` for cursor and kimi (it never accepted hermes or qwen;
 *     those are refused the same way instead of by the generic allowlist);
 *   - `POST /api/git/generate-commit-message` for cursor;
 *   - every `/api/cursor/*` request.
 *
 * `glm` on `/api/agent` is deliberately untouched (open owner decision).
 *
 * The REAL routers run against the case-local database; only the launchers are
 * module-mocked, as recorders, so "nothing was spawned" is observed.
 *
 * Runner: node:test (`npm run test:server -- <this file>`).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import express from 'express';

import { PROVIDER_REMOVED_CODE, PROVIDER_REMOVED_MESSAGE } from '../../shared/retiredProviders.js';

const launched: string[] = [];
const recorder = (name: string) => async () => { launched.push(name); };

mock.module('@/claude-sdk.js', {
  namedExports: {
    queryClaudeSDK: recorder('claude'),
    abortClaudeSDKSession: async () => false,
    isClaudeSDKSessionActive: () => false,
  },
});
mock.module('@/cursor-cli.js', { namedExports: { spawnCursor: recorder('cursor') } });
mock.module('@/kimi-agent-cli.js', { namedExports: { spawnKimiAgent: recorder('kimi') } });
mock.module('@/openai-codex.js', { namedExports: { queryCodex: recorder('codex') } });
mock.module('@/opencode-cli.js', { namedExports: { spawnOpenCode: recorder('opencode') } });

const {
  apiKeysDb, closeConnection, initializeDatabase, projectsDb, userDb,
} = await import('@/modules/database/index.js');
const { setExternalApiEnabled } = await import('@/services/external-api-config.js');
const { default: agentRouter } = await import('./agent.js');
const { default: cursorRouter } = await import('./cursor.js');
const { default: gitRouter } = await import('./git.js');

let server: Server;
let baseUrl = '';
let apiKey = '';
let projectPath = '';
/** A project the requester may write: the git router's access gate runs before the handler. */
let projectId = '';

type RestResponse = { status: number; body: { error?: string; code?: string } };

async function request(method: string, routePath: string, body?: unknown, headers: Record<string, string> = {}): Promise<RestResponse> {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as RestResponse['body'] : {} };
}

function assertProviderRemoved(response: RestResponse, label: string): void {
  assert.equal(response.status, 400, `${label}: typed 400, got ${response.status} ${JSON.stringify(response.body)}`);
  assert.deepEqual(response.body, { error: PROVIDER_REMOVED_MESSAGE, code: PROVIDER_REMOVED_CODE }, label);
  assert.deepEqual(launched, [], `${label}: no launcher is called`);
}

before(async () => {
  closeConnection();
  await initializeDatabase();
  const owner = userDb.createUser('retired-rest-owner', 'hash', 'owner');
  apiKey = apiKeysDb.createApiKey(owner.id, 'retired-rest').apiKey;
  projectPath = path.join(os.homedir(), 'retired-rest-project');
  await fs.mkdir(projectPath, { recursive: true });
  projectId = projectsDb.createProjectPath(projectPath, null, owner.id).project.project_id;
  // ADR-102: the agent endpoint is closed until the owner opens it.
  setExternalApiEnabled(true);

  const app = express();
  app.use(express.json());
  // Mounted as index.js mounts them; the session stand-in replaces authenticateToken.
  const session: express.RequestHandler = (req, _res, next) => {
    (req as express.Request & { user?: unknown }).user = { id: owner.id, role: 'owner' };
    (req as unknown as { assertCurrentIdentity: () => boolean }).assertCurrentIdentity = () => true;
    next();
  };
  app.use('/api/git', session, gitRouter);
  app.use('/api/cursor', session, cursorRouter);
  app.use('/api/agent', agentRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  launched.length = 0;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  await fs.rm(projectPath, { recursive: true, force: true });
});

describe('POST /api/agent', () => {
  const agent = (provider: unknown) => request(
    'POST', '/api/agent',
    { projectPath: process.cwd(), message: 'hello', provider, stream: false },
    { 'x-api-key': apiKey },
  );

  for (const provider of ['cursor', 'kimi', 'hermes', 'qwen']) {
    it(`refuses ${provider} with provider_removed and launches nothing`, async () => {
      assertProviderRemoved(await agent(provider), `provider=${provider}`);
    });
  }

  it('matches the id the way the sockets do (case and surrounding space)', async () => {
    assertProviderRemoved(await agent(' Kimi '), 'provider=" Kimi "');
  });

  it('keeps the generic 400 for an id that was never a body, without naming retired ids', async () => {
    const response = await agent('nonsense');
    assert.equal(response.status, 400);
    assert.equal(response.body.code, undefined);
    assert.equal(response.body.error, 'provider must be "claude", "codex", "opencode", or "glm"');
    assert.deepEqual(launched, []);
  });

  it('leaves glm on its own flag-gated refusal, not provider_removed', async () => {
    const response = await agent('glm');
    assert.equal(response.status, 400);
    assert.equal(response.body.code, undefined);
    assert.equal(response.body.error, 'glm agent provider is not enabled');
  });

  it('still requires the API key before any provider check', async () => {
    const response = await request('POST', '/api/agent', { projectPath: process.cwd(), message: 'hello', provider: 'kimi' });
    assert.equal(response.status, 401);
  });
});

describe('POST /api/git/generate-commit-message', () => {
  const generate = (provider: unknown) => request(
    'POST', '/api/git/generate-commit-message',
    { project: projectId, files: ['a.txt'], provider },
  );

  it('refuses cursor with provider_removed and launches nothing', async () => {
    assertProviderRemoved(await generate('cursor'), 'provider=cursor');
  });

  it('keeps the generic 400 for any other non-claude id', async () => {
    const response = await generate('codex');
    assert.equal(response.status, 400);
    assert.equal(response.body.code, undefined);
    assert.equal(response.body.error, 'provider must be "claude"');
    assert.deepEqual(launched, []);
  });
});

describe('/api/cursor/*', () => {
  for (const [method, routePath] of [['GET', '/api/cursor/config'], ['GET', '/api/cursor/anything'], ['POST', '/api/cursor/config']]) {
    it(`${method} ${routePath} answers provider_removed`, async () => {
      assertProviderRemoved(await request(method, routePath, method === 'POST' ? {} : undefined), `${method} ${routePath}`);
    });
  }
});
