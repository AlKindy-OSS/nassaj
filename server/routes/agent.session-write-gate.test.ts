/**
 * ADR-173 rev.3 H5 (always on, no flag): a POST /api/agent resume names a
 * sessionId the caller must be able to WRITE, not merely see. A viewer of a
 * public project is refused; a member who is not the strict spawn owner gets
 * 409 shared_writing_unsupported (shared writing is chat-only in v1); the strict
 * owner still resumes. Launchers are mocked as recorders.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

import express from 'express';

const launched: Array<{ sessionId: unknown }> = [];

mock.module('@/claude-sdk.js', {
  namedExports: {
    queryClaudeSDK: async (_message: string, options: { sessionId?: unknown }) => {
      launched.push({ sessionId: options?.sessionId });
    },
    abortClaudeSDKSession: async () => false,
    isClaudeSDKSessionActive: () => false,
  },
});
mock.module('@/cursor-cli.js', { namedExports: { spawnCursor: async () => {} } });
mock.module('@/openai-codex.js', { namedExports: { queryCodex: async () => {} } });
mock.module('@/opencode-cli.js', { namedExports: { spawnOpenCode: async () => {} } });
// The credential gate has its own suite (credential-gate.entry-points.test.ts).
mock.module('@/services/isolation/credential-gate.js', {
  namedExports: { admitCredentialTurn: () => ({ principalId: 1, grantedBy: null }), credentialNotLinkedPayload: () => null },
});

const {
  apiKeysDb, closeConnection, getConnection, initializeDatabase, projectsDb, sessionsDb, userDb,
} = await import('@/modules/database/index.js');
const { writeDisabledRecordOn } = await import('@/modules/database/repositories/sso-oidc-config.js');
const { setExternalApiEnabled } = await import('@/services/external-api-config.js');
const { default: agentRouter } = await import('./agent.js');

const SESSION_ID = 'adr173-h5-session-0001';
let server: Server;
let baseUrl = '';
let projectPath = '';
let viewerPath = '';
const keys: Record<'owner' | 'member' | 'viewer', string> = { owner: '', member: '', viewer: '' };
const previousRoot = process.env.WORKSPACES_ROOT;

before(async () => {
  const root = fs.mkdtempSync('/var/tmp/adr173-h5-');
  process.env.WORKSPACES_ROOT = root;
  closeConnection();
  await initializeDatabase();
  writeDisabledRecordOn(getConnection(), 'owner', Date.now());
  setExternalApiEnabled(true);
  // API keys are issued to platform owner/admin roles only (API_KEY_ALLOWED_ROLES).
  const owner = userDb.createUser('h5-owner', 'hash', 'admin');
  const member = userDb.createUser('h5-member', 'hash', 'admin');
  const viewer = userDb.createUser('h5-viewer', 'hash', 'admin');
  for (const [name, user] of [['owner', owner], ['member', member], ['viewer', viewer]] as const) {
    keys[name] = apiKeysDb.createApiKey(user.id, name).apiKey;
  }
  projectPath = fs.mkdtempSync(path.join(root, 'proj-'));
  const projectId = projectsDb.createProjectPath(projectPath, 'H5', owner.id).project?.project_id ?? '';
  projectsDb.setProjectVisibility(projectId, 'public');
  getConnection().prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'member')")
    .run(projectId, member.id);
  // The viewer launches in a project of its own, so only the session gate stands
  // between it and resuming the owner's conversation.
  viewerPath = fs.mkdtempSync(path.join(root, 'viewer-'));
  projectsDb.createProjectPath(viewerPath, 'Viewer', viewer.id);
  sessionsDb.createSession(SESSION_ID, 'claude', projectPath, 'H5 session');
  getConnection().prepare(`INSERT INTO session_participants (session_id, user_id, role, attribution)
    VALUES (?, ?, 'owner', 'spawn')`).run(SESSION_ID, owner.id);

  const app = express();
  app.use(express.json());
  // The admission gateway is index.js wiring; a stub authorizes every launch.
  app.locals.authorizeProviderExecution = () => ({
    kind: 'authorized',
    execution: {
      mode: 'enforce',
      effectivePolicy: { profileId: 'full_delegation' },
      consume: () => undefined,
      markStarted: () => undefined,
      attachChildIdentity: () => undefined,
      settle: () => undefined,
      notStarted: () => undefined,
    },
  });
  app.use('/api/agent', agentRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  if (previousRoot === undefined) delete process.env.WORKSPACES_ROOT;
  else process.env.WORKSPACES_ROOT = previousRoot;
});

beforeEach(() => { launched.length = 0; });

async function resumeAs(who: keyof typeof keys, sessionId = SESSION_ID, cwd = projectPath) {
  const response = await fetch(`${baseUrl}/api/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': keys[who] },
    body: JSON.stringify({ projectPath: cwd, sessionId, message: 'hi', provider: 'claude', stream: false, cleanup: false }),
  });
  return { status: response.status, body: await response.json() as { error?: string; code?: string; reason?: string } };
}

describe('POST /api/agent resume write gate (ADR-173 H5)', () => {
  it('refuses a non-member viewer of a public project who names a sessionId', async () => {
    const res = await resumeAs('viewer', SESSION_ID, viewerPath);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'SESSION_WRITE_FORBIDDEN');
    assert.deepEqual(launched, []);
  });

  it('refuses a writing member who is not the strict spawn owner with shared_writing_unsupported', async () => {
    const res = await resumeAs('member');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'shared_writing_unsupported');
    assert.equal(res.body.reason, 'not_session_owner');
    assert.match(String(res.body.error), /only the member who started/iu);
    assert.deepEqual(launched, []);
  });

  it('refuses a session with no determinable strict owner (never grants ownership)', async () => {
    sessionsDb.createSession('adr173-h5-ownerless-01', 'claude', projectPath, 'No rows');
    const res = await resumeAs('owner', 'adr173-h5-ownerless-01');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'shared_writing_unsupported');
    assert.equal(res.body.reason, 'owner_unconfirmed', 'not told someone else owns it');
    assert.match(String(res.body.error), /no confirmed owner/iu);
    assert.deepEqual(launched, []);
  });

  it('still resumes for the strict spawn owner', async () => {
    const res = await resumeAs('owner');
    assert.notEqual(res.status, 403);
    assert.notEqual(res.status, 409);
    assert.deepEqual(launched, [{ sessionId: SESSION_ID }]);
  });
});
