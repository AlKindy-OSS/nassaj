/**
 * local-models.isolation.test — ownership scope, generated-config determinism and the
 * manager gate for the local model servers feature (ADR-163, B-1268).
 *
 * Bootstrap mirrors credential-grants.test.ts: sandboxed $HOME + throwaway DB opened
 * before importing any project module. Runner: node:test.
 *
 * Proves:
 *  - a user under an OPENCODE credential grant gets NO block and NO key from the
 *    granter's servers, and the repository never returns another owner's row
 *    (sharing is deferred to T-1807 while B-1243 is open);
 *  - the generated opencode.json is deterministic for the same caller, keeps the `glm`
 *    carrier block and any MCP overlay, and carries the owner's own key only;
 *  - with the feature switched off nothing local is generated at all;
 *  - the routes refuse every mutation while `local_models.enabled` is off, and refuse
 *    activation for a non-manager role.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-local-models-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const ORIGINAL_SECRETS_KEY = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const { initializeDatabase, closeConnection, userDb, credentialGrantsDb, appConfigDb, localModelServersDb } =
  await import('@/modules/database/index.js');
const { _resetProviderSecretsServerKeyCache } = await import('@/services/isolation/provider-secrets-store.js');
const { authorizedLocalModelServers, hasRunnableLocalServers, localModelProviderBlocks, localModelsEnabled } =
  await import('@/services/isolation/local-model-config.js');
const { buildOpenCodeConfig, serializeOpenCodeConfig } = await import('@/services/isolation/opencode-config-material.js');
const { localModelsService } = await import('./services/local-models.service.js');
const { default: localModelsRouter } = await import('./local-models.routes.js');

await initializeDatabase();
_resetProviderSecretsServerKeyCache();

const owner = userDb.createUser('local-owner', 'hash', 'user');
const grantee = userDb.createUser('local-grantee', 'hash', 'user');

const OWNER_KEY = 'sk-owner-local-key';
const OWNER_ENDPOINT = 'http://127.0.0.1:11434/v1';
const MCP_OVERLAY = { demo: { type: 'local', command: ['echo'], enabled: true } };

const enableFeature = () => {
  appConfigDb.set('local_models.enabled', 'true');
  appConfigDb.set('local_models.consent_version', '1');
};
const disableFeature = () => appConfigDb.set('local_models.enabled', 'false');

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = ORIGINAL_DB;
  if (ORIGINAL_SECRETS_KEY === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  else process.env.NASSAJ_PROVIDER_SECRETS_KEY = ORIGINAL_SECRETS_KEY;
  _resetProviderSecretsServerKeyCache();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

enableFeature();
const ownerServer = localModelsService.save(owner.id, {
  name: 'Workstation Ollama',
  baseUrl: OWNER_ENDPOINT,
  runtime: 'ollama',
  models: [{ id: 'llama3.1', name: 'Llama 3.1', contextWindow: 131072 }],
  apiKey: OWNER_KEY,
});

describe('ownership scope — a grantee never inherits the granter\'s server (B-1268)', () => {
  before(() => {
    enableFeature();
    credentialGrantsDb.grant(owner.id, grantee.id, 'opencode');
  });
  after(() => credentialGrantsDb.revoke(owner.id, grantee.id, 'opencode'));

  it('the repository returns only the caller\'s own rows', () => {
    assert.equal(localModelServersDb.list(owner.id).length, 1);
    assert.deepEqual(localModelServersDb.list(grantee.id), []);
    assert.equal(localModelServersDb.count(grantee.id), 0);
    assert.equal(localModelServersDb.get(ownerServer.id, grantee.id), null);
    assert.equal(localModelServersDb.get(ownerServer.id, owner.id)?.ownerId, owner.id);
  });

  it('no block and no key are generated for the grantee', () => {
    assert.deepEqual(authorizedLocalModelServers(grantee.id), []);
    assert.deepEqual(localModelProviderBlocks(grantee.id), {});
    assert.equal(hasRunnableLocalServers(grantee.id), false);
    const generated = serializeOpenCodeConfig(buildOpenCodeConfig(undefined, grantee.id)).toString('utf8');
    assert.ok(!generated.includes(OWNER_KEY), 'the granter\'s key must never reach the grantee config');
    assert.ok(!generated.includes('nassaj_local_'), 'no foreign local block in the grantee config');
    assert.ok(generated.includes('"glm"'), 'the carrier block stays');
  });

  it('the grantee cannot read or delete the granter\'s server through the service', () => {
    assert.deepEqual(localModelsService.list(grantee.id, 'user').servers, []);
    assert.throws(() => localModelsService.remove(grantee.id, ownerServer.id), /LOCAL_MODEL_SERVER_NOT_FOUND|تعذّر/);
  });
});

describe('generated config — deterministic and owner-scoped', () => {
  before(enableFeature);

  it('two consecutive generations for the same caller are byte-identical', () => {
    const first = serializeOpenCodeConfig(buildOpenCodeConfig(MCP_OVERLAY, owner.id));
    const second = serializeOpenCodeConfig(buildOpenCodeConfig(MCP_OVERLAY, owner.id));
    assert.equal(first.toString('utf8'), second.toString('utf8'));
    const parsed = JSON.parse(first.toString('utf8'));
    assert.ok(parsed.provider.glm, 'carrier block present');
    assert.ok(parsed.mcp?.demo, 'mcp overlay preserved');
    assert.equal(parsed.provider[ownerServer.providerId].options.baseURL, OWNER_ENDPOINT);
    assert.equal(parsed.provider[ownerServer.providerId].options.apiKey, OWNER_KEY);
  });

  it('the block set matches the authorized rows exactly', () => {
    const blocks = localModelProviderBlocks(owner.id);
    assert.deepEqual(Object.keys(blocks), [ownerServer.providerId]);
    assert.ok(hasRunnableLocalServers(owner.id));
  });
});

describe('activation gate — off means inert', () => {
  before(disableFeature);
  after(enableFeature);

  it('nothing local is generated while the feature is off', () => {
    assert.equal(localModelsEnabled(), false);
    assert.deepEqual(authorizedLocalModelServers(owner.id), []);
    assert.deepEqual(localModelProviderBlocks(owner.id), {});
    assert.equal(hasRunnableLocalServers(owner.id), false);
    const generated = serializeOpenCodeConfig(buildOpenCodeConfig(undefined, owner.id)).toString('utf8');
    assert.ok(!generated.includes('nassaj_local_'));
    assert.ok(!generated.includes(OWNER_KEY));
  });
});

describe('routes /api/local-models — gate and manager-only activation', () => {
  let server: Server;
  let baseUrl = '';
  let currentUser: { id: number; role: string } | null = null;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user?: unknown }).user = currentUser ?? undefined;
      next();
    });
    app.use('/api/local-models', localModelsRouter);
    app.use((error: Error & { statusCode?: number; code?: string }, _req: express.Request,
      res: express.Response, _next: express.NextFunction) => {
      res.status(error.statusCode ?? 500).json({ error: error.message, code: error.code });
    });
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const call = async (method: string, url: string, user: { id: number; role: string } | null, body?: unknown) => {
    currentUser = user;
    const response = await fetch(`${baseUrl}/api/local-models${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as { code?: string } };
  };

  it('refuses every write while the feature is off', async () => {
    disableFeature();
    const member = { id: owner.id, role: 'user' };
    assert.equal((await call('POST', '/servers', member, { name: 'x', baseUrl: OWNER_ENDPOINT })).status, 403);
    assert.equal((await call('POST', `/servers/${ownerServer.id}/catalog`, member)).status, 403);
    assert.equal((await call('POST', `/servers/${ownerServer.id}/test`, member)).status, 403);
    // The settings card stays readable so a manager can turn the feature on.
    const settings = await call('GET', '/settings', member);
    assert.equal(settings.status, 200);
  });

  it('refuses activation for a non-manager role and accepts it from an admin', async () => {
    const forbidden = await call('PUT', '/settings', { id: owner.id, role: 'user' }, { enabled: true, consentVersion: '1' });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.code, 'FORBIDDEN');
    assert.equal(localModelsEnabled(), false, 'a refused request must not flip the gate');
    const allowed = await call('PUT', '/settings', { id: owner.id, role: 'admin' }, { enabled: true, consentVersion: '1' });
    assert.equal(allowed.status, 200);
    assert.equal(localModelsEnabled(), true);
  });

  it('refuses an unauthenticated caller', async () => {
    assert.equal((await call('GET', '/servers', null)).status, 401);
  });
});
