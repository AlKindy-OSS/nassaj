/**
 * B-1707 P1 — REST `POST /api/agent` hands OpenCode (and the GLM carrier) the same
 * permission inputs it hands Claude: `permissionMode` and the admitted
 * `permissionExecution` handle. With those, spawnOpenCode resolves the mode Claude
 * would run under (owner ruling 2026-10-28).
 *
 * The REAL router runs against the case-local database; only the launchers are
 * module-mocked, as recorders of the options they receive.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import express from 'express';

type Options = Record<string, unknown>;
const launched: Array<{ provider: string; options: Options }> = [];
const recorder = (provider: string) => async (_message: string, options: Options) => {
  launched.push({ provider, options });
};

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

// A workspace root of its own: a checkout may itself sit under .git (session overlays),
// which the workspace validator refuses.
const workspaceRoot = await fs.realpath(await fs.mkdtemp(path.join('/var/tmp', 'b1707-rest-root-')));
process.env.WORKSPACES_ROOT = workspaceRoot;

const {
  apiKeysDb, closeConnection, initializeDatabase, projectsDb, userDb,
} = await import('@/modules/database/index.js');
const { setExternalApiEnabled } = await import('@/services/external-api-config.js');
const { default: agentRouter } = await import('./agent.js');

const issued: Array<{ provider: string; execution: object }> = [];
let server: Server;
let baseUrl = '';
let apiKey = '';
let projectPath = '';

async function agent(provider: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/api/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ projectPath, message: 'hello', provider, stream: false }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

function optionsOf(provider: string, response: { status: number; body: unknown }): Options {
  const hit = launched.find((entry) => entry.provider === provider);
  assert.ok(hit, `${provider} must launch: ${response.status} ${JSON.stringify(response.body)}`);
  return hit.options;
}

before(async () => {
  closeConnection();
  await initializeDatabase();
  const owner = userDb.createUser('b1707-rest-owner', 'hash', 'owner');
  apiKey = apiKeysDb.createApiKey(owner.id, 'b1707-rest').apiKey;
  projectPath = path.join(workspaceRoot, 'project');
  await fs.mkdir(projectPath);
  projectsDb.createProjectPath(projectPath, null, owner.id);
  setExternalApiEnabled(true);
  const app = express();
  app.use(express.json());
  // The admission gateway is index.js wiring; a stub issues one recorded handle per request.
  app.locals.authorizeProviderExecution = (_user: unknown, context: { provider: string }) => {
    const execution = {
      mode: 'enforce',
      effectivePolicy: { profileId: 'full_delegation' },
      consume: () => undefined,
      markStarted: () => undefined,
      attachChildIdentity: () => undefined,
      settle: () => undefined,
      notStarted: () => undefined,
    };
    issued.push({ provider: context.provider, execution });
    return { kind: 'authorized', execution };
  };
  app.use('/api/agent', agentRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  launched.length = 0;
  issued.length = 0;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe('B-1707 REST permission parity', () => {
  it('OpenCode receives the same permissionMode Claude receives, and its own admitted handle', async () => {
    const claude = optionsOf('claude', await agent('claude'));
    launched.length = 0;
    issued.length = 0;
    const opencode = optionsOf('opencode', await agent('opencode'));
    assert.equal(claude.permissionMode, 'bypassPermissions');
    assert.equal(opencode.permissionMode, claude.permissionMode);
    assert.equal(issued.length, 1);
    assert.equal(issued[0].provider, 'opencode');
    assert.equal(opencode.permissionExecution, issued[0].execution, 'the handle admitted for this request');
  });

  it('the GLM carrier REST branch passes the same inputs', async () => {
    const previous = process.env.NASSAJ_OPENCODE_CARRIER;
    process.env.NASSAJ_OPENCODE_CARRIER = '1';
    try {
      const glm = optionsOf('opencode', await agent('glm'));
      assert.equal(glm.carrier, true);
      assert.equal(glm.permissionMode, 'bypassPermissions');
      assert.equal(glm.permissionExecution, issued[0]?.execution);
    } finally {
      if (previous === undefined) delete process.env.NASSAJ_OPENCODE_CARRIER;
      else process.env.NASSAJ_OPENCODE_CARRIER = previous;
    }
  });
});
