/**
 * T-2107 stage 5 (ADR-227) — acceptance test of the per-body local switches, in
 * the owner's terms: "as admin, in the existing Local Models settings card, I can
 * turn local models on per body (Claude, Codex), each off by default, with the
 * existing warning and consent".
 *
 * Proves:
 *  - both body switches read off on a fresh installation;
 *  - only an owner/admin may flip one, and only after the local models consent;
 *  - each flip is audited and touches its own key only;
 *  - turning Codex off or on never changes the OpenCode local models (GLM keeps
 *    its carrier block, the member's servers keep their generated block).
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
const { _resetProviderSecretsServerKeyCache } = await import('@/services/isolation/provider-secrets-store.js');
const config = await import('@/services/isolation/local-model-config.js');
const { buildOpenCodeConfig, serializeOpenCodeConfig } = await import('@/services/isolation/opencode-config-material.js');
await import('./services/local-models.service.js');
const { default: localModelsRouter } = await import('./local-models.routes.js');

await db.initializeDatabase();
_resetProviderSecretsServerKeyCache();

const admin = db.userDb.createUser('local-switch-admin', 'hash', 'admin');
const member = db.userDb.createUser('local-switch-member', 'hash', 'user');

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
  app.use('/api/providers/local', localModelsRouter);
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

type Feature = { enabled: boolean; canManage: boolean; bodies: { claude: boolean; codex: boolean; dsh: boolean } };
async function call(method: string, url: string, user: { id: number; role: string } | null, body?: unknown) {
  currentUser = user;
  const response = await fetch(`${baseUrl}/api/providers/local${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as { data?: Feature; code?: string } };
}
const asAdmin = { id: Number(admin.id), role: 'admin' };
const asMember = { id: Number(member.id), role: 'user' };
const setBody = (user: typeof asAdmin, body: unknown) => call('PUT', '/settings/body', user, body);
const bodyAudits = () => db.auditLogDb.recent(100)
  .filter((row) => row.action === 'local_models_settings_updated' && String(row.metadata ?? '').includes('"body"'));

describe('per-body local switches', () => {
  it('reads both bodies off on a fresh installation', async () => {
    const settings = await call('GET', '/settings', asAdmin);
    assert.equal(settings.status, 200);
    assert.deepEqual(settings.body.data?.bodies, { claude: false, codex: false, dsh: false });
  });

  it('refuses a body switch before the local models consent', async () => {
    const refused = await setBody(asAdmin, { body: 'codex', enabled: true });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'LOCAL_MODELS_DISABLED');
    assert.equal(db.appConfigDb.get('local_models.codex_enabled'), null);
  });

  it('refuses a member and leaves the switch untouched', async () => {
    await call('PUT', '/settings', asAdmin, { enabled: true, consentVersion: '1' });
    const refused = await setBody(asMember, { body: 'claude', enabled: true });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'FORBIDDEN');
    assert.equal(config.claudeLocalEngineEnabled(), false);
  });

  it('refuses an unknown body or a malformed request', async () => {
    for (const body of [{ body: 'agy', enabled: true }, { body: 'opencode', enabled: true },
      { body: 'codex', enabled: 'yes' }, { body: 'codex', enabled: true, extra: 1 }]) {
      assert.equal((await setBody(asAdmin, body)).status, 400, JSON.stringify(body));
    }
  });

  it('turns each body on and off on its own key, audited', async () => {
    const before = bodyAudits().length;
    const on = await setBody(asAdmin, { body: 'codex', enabled: true });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body.data?.bodies, { claude: false, codex: true, dsh: false });
    assert.equal(config.codexLocalEngineEnabled(), true);
    assert.equal(config.claudeLocalEngineEnabled(), false);
    const claude = await setBody(asAdmin, { body: 'claude', enabled: true });
    assert.deepEqual(claude.body.data?.bodies, { claude: true, codex: true, dsh: false });
    const off = await setBody(asAdmin, { body: 'codex', enabled: false });
    assert.deepEqual(off.body.data?.bodies, { claude: true, codex: false, dsh: false });
    assert.equal(config.claudeLocalEngineEnabled(), true);
    assert.equal(bodyAudits().length, before + 3);
  });

  it('T-2108: DeepSeek Harness has its own switch, default off, touched by no other body', async () => {
    // A second manager: the switch route is rate-limited per caller.
    const asOwner = { id: Number(db.userDb.createUser('local-switch-owner', 'hash', 'owner').id), role: 'owner' };
    const before = bodyAudits().length;
    assert.equal(config.dshLocalEngineEnabled(), false);
    const dsh = await setBody(asOwner, { body: 'dsh', enabled: true });
    assert.deepEqual(dsh.body.data?.bodies, { claude: true, codex: false, dsh: true });
    assert.equal(config.dshLocalEngineEnabled(), true);
    assert.equal(config.codexLocalEngineEnabled(), false);
    const off = await setBody(asOwner, { body: 'dsh', enabled: false });
    assert.deepEqual(off.body.data?.bodies, { claude: true, codex: false, dsh: false });
    assert.equal(config.claudeLocalEngineEnabled(), true);
    assert.equal(bodyAudits().length, before + 2);
  });

  it('never changes the OpenCode local models or the GLM carrier', async () => {
    db.localModelServersDb.save({
      id: crypto.randomUUID(), ownerId: Number(admin.id), providerId: `nassaj_local_${'a'.repeat(32)}`,
      name: 'Desk', baseUrl: 'http://127.0.0.1:8080/v1', runtime: 'custom', models: [{ id: 'm', contextWindow: 65536 }],
    });
    const generate = () => serializeOpenCodeConfig(buildOpenCodeConfig(undefined, Number(admin.id))).toString('utf8');
    const reference = generate();
    assert.ok(reference.includes('"glm"') && reference.includes('nassaj_local_'));
    for (const enabled of [true, false]) {
      await setBody(asAdmin, { body: 'codex', enabled });
      assert.equal(config.localModelsEnabled(), true);
      assert.equal(generate(), reference, `codex ${enabled ? 'on' : 'off'} changed opencode.json`);
    }
  });
});
