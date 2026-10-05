/**
 * B-1289 / ADR-198: HTTP contract of `GET /api/providers/:provider/quota` when the
 * admitted in-process read is refused or cannot settle.
 *
 * Drives the REAL provider router and the REAL quota service. The read is the real
 * runAuthorizedInProcessRead over a real permission gateway on an in-memory database;
 * only its test seams (authorize, fetchImpl) and the credential are injected, by
 * wrapping providerQuotaService.getWindows. A refusal must answer 5xx with an explicit
 * code (never the 404 "no quota source") and must never send the network request.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, afterEach, before } from 'node:test';

import Database from 'better-sqlite3';
import express from 'express';

import {
  countPermissionGenerationBlocks,
  listPermissionEffectFences,
  migratePermissionExecution,
  reconcileExpiredPermissionExecutions,
} from '@/modules/database/index.js';
// eslint-disable-next-line boundaries/dependencies -- the real gateway seams drive the route test.
import { createAuthenticatedLaunchActor } from '@/modules/execution-permissions/actor.js';
// eslint-disable-next-line boundaries/dependencies -- the real gateway seams drive the route test.
import { computePermissionReleaseCapabilityDigest, PERMISSION_CAPABILITY_ARTIFACT_DIGEST } from '@/modules/execution-permissions/capability-registry.js';
// eslint-disable-next-line boundaries/dependencies -- the real gateway seams drive the route test.
import { createExecutionPermissionGateway, type PermissionExecutionHandle } from '@/modules/execution-permissions/execution-gateway.service.js';
// eslint-disable-next-line boundaries/dependencies -- the real gateway seams drive the route test.
import { CLAUDE_REFERENCE_VECTOR_V1 } from '@/modules/execution-permissions/fixtures/claude-reference-v1.js';
// eslint-disable-next-line boundaries/dependencies -- the real gateway seams drive the route test.
import { runAuthorizedInProcessRead } from '@/modules/execution-permissions/in-process-read.js';
// eslint-disable-next-line boundaries/dependencies -- the real gateway seams drive the route test.
import { processAlive } from '@/modules/execution-permissions/runtime-gateway.js';
import { providerQuotaService } from '@/modules/providers/services/usage/provider-quota.service.js';

import providerRouter from '../provider.routes.js';

const RELEASE = 'c'.repeat(64);
const PROFILE = `sha256:${'a'.repeat(64)}`;
const BOOT_ID = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const DEAD_PID = spawnSync(process.execPath, ['-e', '']).pid as number;
const OWNER = Object.freeze({ ownerId: 'server:old', ownerPid: DEAD_PID, ownerBootId: BOOT_ID, ownerStartTicks: '1' });

const actor = createAuthenticatedLaunchActor({
  id: 1, role: 'owner', status: 'active', is_active: 1,
  authenticationKind: 'session', authorizationGeneration: 1,
}, '2030-01-01T00:00:00.000Z');

const setupDatabase = (): Database.Database => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
      is_active INTEGER NOT NULL DEFAULT 1, password_changed_at INTEGER
    );
    CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, key_digest TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO users (id, username, password_hash, role) VALUES (1, 'owner', 'hash', 'owner');
  `);
  migratePermissionExecution(database);
  return database;
};

let sequence = 0;
const authorizeOn = (
  database: Database.Database,
  effectFootprint: 'local' | 'external' = 'local',
): PermissionExecutionHandle => {
  const gateway = createExecutionPermissionGateway({
    database,
    authority: Object.freeze({
      source: 'sealed_release_manifest', profileId: 'full_delegation', contractVersion: 'permission-parity/v1',
      profileDigest: PROFILE, capabilityDigest: computePermissionReleaseCapabilityDigest(RELEASE, PROFILE, 1),
      protocolGeneration: 1,
    }),
    reference: CLAUDE_REFERENCE_VECTOR_V1,
    candidateFor: () => null,
    capabilityArtifactDigest: PERMISSION_CAPABILITY_ARTIFACT_DIGEST,
    releaseBuild: RELEASE,
    manifestDigest: null,
    processIdentity: OWNER,
    randomId: () => `id-${++sequence}`,
    nowMs: () => 1_000,
    isDevicePrincipalCurrent: () => true,
  });
  const result = gateway.authorize(actor, {
    launchId: `launch-${sequence}`, principalId: 'user:1', sessionId: null, projectId: 'system:provider-quota',
    workspacePath: '/workspace', provider: 'codex', body: 'codex', engine: 'quota',
    entrypoint: 'provider.routes.quota', purpose: 'quota', effectFootprint,
  }, 'full_delegation');
  if (result.kind !== 'authorized') throw new Error(`unexpected admission ${result.kind}`);
  return result.execution;
};

const originalGetWindows = providerQuotaService.getWindows;
let server: Server;
let baseUrl = '';
let fetchCalls = 0;

/** Routes the quota read through the real in-process read with the given seams. */
const useRead = (
  authorize: () => unknown,
  respond: () => Response = () => new Response('{}', { status: 200 }),
): void => {
  providerQuotaService.getWindows = (provider, userId, _deps, model) => originalGetWindows.call(
    providerQuotaService, provider, userId, {
      credential: 'token',
      read: descriptor => runAuthorizedInProcessRead(
        { authenticatedPrincipal: {}, provider: 'codex', purpose: 'quota' },
        descriptor,
        {
          authorize: authorize as () => PermissionExecutionHandle,
          fetchImpl: async () => { fetchCalls += 1; return respond(); },
        },
      ),
    }, model);
};

async function getQuota(): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/providers/codex/quota`);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: number } }).user = { id: 1 };
    next();
  });
  app.use('/api/providers', providerRouter);
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'unmapped', code: 'INTERNAL_ERROR', unmapped: true });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  providerQuotaService.getWindows = originalGetWindows;
  providerQuotaService.__resetCache();
  fetchCalls = 0;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('B-1289: a fenced codex:quota scope answers 503 PROVIDER_QUOTA_FENCED and sends nothing', async () => {
  const database = setupDatabase();
  try {
    // An earlier external read interrupted by a restart fences the user's codex quota scope.
    const interrupted = authorizeOn(database, 'external');
    interrupted.consume();
    interrupted.markStarted();
    const alive = (identity: { pid: number; bootId: string; startTicks: string }) => processAlive(BOOT_ID, identity);
    reconcileExpiredPermissionExecutions(database, 1_000 + 31_000, alive, alive);
    assert.deepEqual(listPermissionEffectFences(database).map(fence => fence.scopeKey), ['1:codex:quota']);

    useRead(() => authorizeOn(database));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { status, body } = await getQuota();
      assert.equal(status, 503);
      assert.equal(body.code, 'PROVIDER_QUOTA_FENCED');
      assert.equal(body.unmapped, undefined, 'the route maps the refusal, not the error middleware');
    }
    assert.equal(fetchCalls, 0, 'a refused read never reaches the network');
  } finally { database.close(); }
});

test('B-1289: a settlement failure answers 500, blocks the generation, and later reads are refused', async () => {
  const database = setupDatabase();
  try {
    useRead(() => authorizeOn(database), () => {
      // A concurrent writer moves the decision: the terminal settlement CAS cannot land.
      database.prepare('UPDATE permission_launch_decisions SET revision = revision + 1').run();
      return new Response('{"rate_limit":{}}', { status: 200 });
    });
    const failed = await getQuota();
    assert.equal(failed.status, 500);
    assert.equal(failed.body.code, 'PROVIDER_QUOTA_ERROR');
    assert.equal(failed.body.unmapped, undefined);
    assert.equal(fetchCalls, 1);
    assert.equal(countPermissionGenerationBlocks(database), 1);

    // The blocked generation refuses admission before any request leaves the process.
    const refused = await getQuota();
    assert.equal(refused.status, 500);
    assert.equal(refused.body.code, 'PROVIDER_QUOTA_ERROR');
    assert.equal(fetchCalls, 1, 'GENERATION_BLOCKED refuses before the network');
  } finally { database.close(); }
});

test('B-1289: an untrusted handle answers 500 and sends nothing', async () => {
  useRead(() => ({ consume: () => {}, settle: () => {}, markStartedInProcessRead: () => {} }));
  const { status, body } = await getQuota();
  assert.equal(status, 500);
  assert.equal(body.code, 'PROVIDER_QUOTA_ERROR');
  assert.ok(!JSON.stringify(body).includes('IN_PROCESS_READ_HANDLE_UNTRUSTED'), 'no internal code leaks');
  assert.equal(fetchCalls, 0);
});

test('B-1289: an admitted read with a corrupt body is still "no source" (404), not an error', async () => {
  const database = setupDatabase();
  try {
    useRead(() => authorizeOn(database), () => new Response('not json', { status: 200 }));
    const { status, body } = await getQuota();
    assert.equal(status, 404);
    assert.equal(body.code, 'PROVIDER_QUOTA_UNAVAILABLE');
    assert.equal(fetchCalls, 1);
  } finally { database.close(); }
});
