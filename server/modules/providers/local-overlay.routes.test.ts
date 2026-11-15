/**
 * T-2098 stage 3b / T-2107 stage 5 (ADR-227 Decision 10) — acceptance test of the
 * local-model overlay route of the Claude and Codex bodies, in the owner's terms:
 *
 *  - a member sees HIS OWN local servers under the Claude body and under the Codex
 *    body, never another member's, never the address or key, and nothing at all
 *    while that body's local switch is off or while he works under a shared
 *    credential on it;
 *  - each model row says whether it can run, using that body's spawn vetting;
 *  - a body that does not run on local servers has no overlay.
 *
 * Owner option B (2026-11-10): a local chat has no permission mode of its own; it
 * resolves its mode exactly like every other Claude chat.
 */

// eslint-disable-next-line import-x/order -- must evaluate before every other import
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

process.env.DATABASE_PATH = path.join(SANDBOX_HOME, 'db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const db = await import('@/modules/database/index.js');
const { _resetProviderSecretsServerKeyCache, setLocalModelSecret } =
  await import('@/services/isolation/provider-secrets-store.js');
const { default: localOverlayRouter } = await import('./local-overlay.routes.js');

await db.initializeDatabase();
_resetProviderSecretsServerKeyCache();

const owner = db.userDb.createUser('local-owner-3b', 'hash', 'user');
const other = db.userDb.createUser('local-other-3b', 'hash', 'user');
const grantee = db.userDb.createUser('local-grantee-3b', 'hash', 'user');

const OWNER_ADDRESS = '192.168.77.10';
const OWNER_KEY = 'sk-owner-secret-3b';
const OTHER_ADDRESS = '10.9.8.7';

function enableClaudeLocal(on = true): void {
  db.appConfigDb.set('local_models.enabled', 'true');
  db.appConfigDb.set('local_models.consent_version', '1');
  db.appConfigDb.set('local_models.claude_enabled', on ? 'true' : 'false');
}

function enableCodexLocal(on = true): void {
  db.appConfigDb.set('local_models.codex_enabled', on ? 'true' : 'false');
}

function saveServer(ownerId: number, name: string, baseUrl: string, models: object[], verified: string[]) {
  const id = crypto.randomUUID();
  const server = {
    id, ownerId, providerId: `nassaj_local_${id.replaceAll('-', '')}`, name, baseUrl, runtime: 'custom', models,
  };
  db.localModelServersDb.save(server);
  db.localModelServersDb.setVerifiedAddresses(server, verified);
  return server;
}

enableClaudeLocal();
const ownerServer = saveServer(Number(owner.id), 'Desk box', `http://${OWNER_ADDRESS}:8080/v1`, [
  { id: 'big-model', name: 'Big', contextWindow: 65536 },
  { id: 'tiny-model', contextWindow: 8192 },
  { id: 'unknown-window' },
  { id: 'claude-shadow', contextWindow: 65536 },
], [OWNER_ADDRESS]);
setLocalModelSecret(Number(owner.id), ownerServer.id, OWNER_KEY);
const untested = saveServer(Number(owner.id), 'Untested', 'http://10.1.1.1:8080/v1',
  [{ id: 'big-model', contextWindow: 65536 }], []);
const otherServer = saveServer(Number(other.id), 'Other member box', `http://${OTHER_ADDRESS}:8080/v1`,
  [{ id: 'theirs', contextWindow: 65536 }], [OTHER_ADDRESS]);

let currentUser: { id: number; role: string } | null = null;
let server: Server;
let baseUrl = '';

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user?: unknown }).user = currentUser ?? undefined;
    next();
  });
  app.use('/api/providers', localOverlayRouter);
  app.use((error: Error & { statusCode?: number; code?: string }, _req: express.Request,
    res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message, code: error.code });
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.closeConnection();
});

type Json = Record<string, unknown> & { data?: unknown; code?: string };
async function call(method: string, url: string, user: { id: number } | null, body?: unknown, path = 'claude') {
  currentUser = user ? { id: user.id, role: 'user' } : null;
  const response = await fetch(`${baseUrl}/api/providers/${path}${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Json };
}

type OverlayRow = { serverId: string; providerId: string; label: string;
  models: Array<{ value: string; label: string; contextWindow: number | null; minContextWindow: number;
    eligibility: string }> };

describe('GET /local-overlay', () => {
  it('requires a signed-in caller', async () => {
    assert.equal((await call('GET', '/local-overlay', null)).status, 401);
  });

  it("lists the caller's own servers only, with the spawn's eligibility per model", async () => {
    enableClaudeLocal();
    const response = await call('GET', '/local-overlay', { id: Number(owner.id) });
    assert.equal(response.status, 200);
    const rows = response.body.data as OverlayRow[];
    assert.deepEqual(rows.map((row) => row.serverId).sort(), [ownerServer.id, untested.id].sort());
    const desk = rows.find((row) => row.serverId === ownerServer.id)!;
    assert.equal(desk.label, 'Desk box');
    assert.equal(desk.providerId, ownerServer.providerId);
    assert.deepEqual(desk.models.map((model) => [model.value, model.eligibility]), [
      [`${ownerServer.providerId}/big-model`, 'ok'],
      [`${ownerServer.providerId}/tiny-model`, 'context_too_small'],
      [`${ownerServer.providerId}/unknown-window`, 'context_unknown'],
      [`${ownerServer.providerId}/claude-shadow`, 'model_id_reserved'],
    ]);
    assert.equal(desk.models[0].label, 'Big');
    assert.equal(desk.models[1].label, 'tiny-model');
    assert.equal(desk.models[0].contextWindow, 65536);
    assert.equal(desk.models[2].contextWindow, null);
    const notTested = rows.find((row) => row.serverId === untested.id)!;
    assert.equal(notTested.models[0].eligibility, 'address_untested');
  });

  it('never returns an address, a base URL or a key', async () => {
    const { text } = await call('GET', '/local-overlay', { id: Number(owner.id) });
    for (const secret of [OWNER_ADDRESS, OWNER_KEY, '8080', 'baseUrl', 'verified', 'ownerId', 'runtime']) {
      assert.equal(text.includes(secret), false, `response must not carry ${secret}`);
    }
  });

  it("never lists another member's server", async () => {
    const mine = await call('GET', '/local-overlay', { id: Number(other.id) });
    const ids = (mine.body.data as OverlayRow[]).map((row) => row.serverId);
    assert.deepEqual(ids, [otherServer.id]);
    const ownerView = await call('GET', '/local-overlay', { id: Number(owner.id) });
    assert.equal(ownerView.text.includes(otherServer.id), false);
    assert.equal(ownerView.text.includes(OTHER_ADDRESS), false);
  });

  it('is empty while the Claude local switch is off', async () => {
    enableClaudeLocal(false);
    try {
      const response = await call('GET', '/local-overlay', { id: Number(owner.id) });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.data, []);
    } finally {
      enableClaudeLocal();
    }
  });

  it('is empty under a credential grant, even when the granter has servers', async () => {
    db.credentialGrantsDb.grant(Number(owner.id), Number(grantee.id), 'claude');
    saveServer(Number(grantee.id), 'Grantee box', 'http://10.2.2.2:8080/v1',
      [{ id: 'g', contextWindow: 65536 }], ['10.2.2.2']);
    const response = await call('GET', '/local-overlay', { id: Number(grantee.id) });
    assert.deepEqual(response.body.data, []);
  });
});

describe('GET /codex/local-overlay', () => {
  const codex = (user: { id: number } | null) => call('GET', '/local-overlay', user, undefined, 'codex');

  it('is empty while the Codex local switch is off, even with the Claude one on', async () => {
    enableClaudeLocal();
    enableCodexLocal(false);
    const response = await codex({ id: Number(owner.id) });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data, []);
  });

  it("lists the caller's own servers with the Codex spawn's vetting and floor", async () => {
    enableClaudeLocal(false);
    enableCodexLocal();
    try {
      const response = await codex({ id: Number(owner.id) });
      const rows = response.body.data as OverlayRow[];
      assert.deepEqual(rows.map((row) => row.serverId).sort(), [ownerServer.id, untested.id].sort());
      const desk = rows.find((row) => row.serverId === ownerServer.id)!;
      assert.deepEqual(desk.models.map((model) => [model.value.split('/')[1], model.eligibility]), [
        ['big-model', 'ok'],
        ['tiny-model', 'context_too_small'],
        ['unknown-window', 'context_unknown'],
        // The reserved `claude-` id is a Claude CLI rule; Codex runs it.
        ['claude-shadow', 'ok'],
      ]);
      assert.equal(desk.models[0].minContextWindow, 22000 + 4096 + 2000);
      assert.equal(rows.find((row) => row.serverId === untested.id)!.models[0].eligibility, 'address_untested');
    } finally {
      enableClaudeLocal();
      enableCodexLocal(false);
    }
  });

  it('never returns an address, a base URL or a key', async () => {
    enableCodexLocal();
    try {
      const { text } = await codex({ id: Number(owner.id) });
      for (const secret of [OWNER_ADDRESS, OWNER_KEY, '8080', 'baseUrl', 'verified', 'ownerId', 'runtime', OTHER_ADDRESS]) {
        assert.equal(text.includes(secret), false, `response must not carry ${secret}`);
      }
      assert.equal(text.includes(otherServer.id), false);
    } finally {
      enableCodexLocal(false);
    }
  });

  it('is empty under a Codex credential grant', async () => {
    enableCodexLocal();
    try {
      db.credentialGrantsDb.grant(Number(owner.id), Number(grantee.id), 'codex');
      assert.deepEqual((await codex({ id: Number(grantee.id) })).body.data, []);
    } finally {
      enableCodexLocal(false);
    }
  });

  it('requires a signed-in caller', async () => {
    assert.equal((await codex(null)).status, 401);
  });
});

describe('GET /dsh/local-overlay (T-2108)', () => {
  const dsh = (user: { id: number } | null) => call('GET', '/local-overlay', user, undefined, 'dsh');
  const enableDshLocal = (on = true) => db.appConfigDb.set('local_models.dsh_enabled', on ? 'true' : 'false');

  it('is empty while the DSH local switch is off, even with the others on', async () => {
    enableClaudeLocal();
    enableCodexLocal();
    enableDshLocal(false);
    try {
      assert.deepEqual((await dsh({ id: Number(owner.id) })).body.data, []);
    } finally {
      enableCodexLocal(false);
    }
  });

  it("lists the caller's own servers with the DSH spawn's vetting and floor, and nothing secret", async () => {
    enableClaudeLocal(false);
    enableDshLocal();
    try {
      const response = await dsh({ id: Number(owner.id) });
      const rows = response.body.data as OverlayRow[];
      assert.deepEqual(rows.map((row) => row.serverId).sort(), [ownerServer.id, untested.id].sort());
      const desk = rows.find((row) => row.serverId === ownerServer.id)!;
      assert.deepEqual(desk.models.map((model) => [model.value.split('/')[1], model.eligibility]), [
        ['big-model', 'ok'], ['tiny-model', 'context_too_small'], ['unknown-window', 'context_unknown'], ['claude-shadow', 'ok'],
      ]);
      assert.equal(desk.models[0].minContextWindow, 16000 + 4096 + 2000);
      for (const secret of [OWNER_ADDRESS, OWNER_KEY, 'baseUrl', 'verified', 'ownerId']) assert.equal(response.text.includes(secret), false, secret);
    } finally {
      enableClaudeLocal();
      enableDshLocal(false);
    }
  });
});

describe('a body without local servers', () => {
  it('has no overlay', async () => {
    for (const body of ['opencode', 'agy', 'antigravity']) {
      const response = await call('GET', '/local-overlay', { id: Number(owner.id) }, undefined, body);
      assert.equal(response.status, 404, body);
    }
  });
});
