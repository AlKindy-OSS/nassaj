/**
 * B-1373 — POST /api/agent refuses a projectPath that is the service home or a
 * hidden home entry with 400 PROJECT_ROOT_FORBIDDEN, before registering a
 * project or launching anything. Launchers are mocked as recorders.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it, mock } from 'node:test';

import express from 'express';

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
  apiKeysDb, closeConnection, getConnection, initializeDatabase, projectsDb, userDb,
} = await import('@/modules/database/index.js');
const { writeDisabledRecordOn } = await import('@/modules/database/repositories/sso-oidc-config.js');
const { setExternalApiEnabled } = await import('@/services/external-api-config.js');
const { default: agentRouter } = await import('./agent.js');

let server: Server;
let baseUrl = '';
let ownerKey = '';
const previousWorkspacesRoot = process.env.WORKSPACES_ROOT;

before(async () => {
  // The home must pass the workspace-root containment check so the request
  // reaches the B-1373 guard (the runner sets WORKSPACES_ROOT to the checkout).
  process.env.WORKSPACES_ROOT = os.homedir();
  fs.mkdirSync(path.join(os.homedir(), '.cloudflared'), { recursive: true });
  closeConnection();
  await initializeDatabase();
  writeDisabledRecordOn(getConnection(), 'owner', Date.now());
  setExternalApiEnabled(true);
  const owner = userDb.createUser('agent-root-owner', 'hash', 'owner');
  ownerKey = apiKeysDb.createApiKey(owner.id, 'owner').apiKey;

  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  if (previousWorkspacesRoot === undefined) delete process.env.WORKSPACES_ROOT;
  else process.env.WORKSPACES_ROOT = previousWorkspacesRoot;
});

async function agentAt(projectPath: string) {
  const response = await fetch(`${baseUrl}/api/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ownerKey },
    body: JSON.stringify({ projectPath, message: 'hi', provider: 'claude', stream: false }),
  });
  return { status: response.status, body: await response.json() as { error?: string; code?: string } };
}

describe('POST /api/agent protected project roots (B-1373)', () => {
  for (const [label, root] of [
    ['the home directory', () => os.homedir()],
    ['a hidden home entry', () => path.join(os.homedir(), '.cloudflared')],
  ] as const) {
    it(`refuses ${label} without registering or launching`, async () => {
      const target = root();
      const res = await agentAt(target);
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'PROJECT_ROOT_FORBIDDEN');
      assert.equal(projectsDb.getProjectPath(target), null, 'no project row');
      assert.deepEqual(launched, []);
    });
  }
});
