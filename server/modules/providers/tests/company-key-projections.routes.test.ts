/**
 * company-key-projections.routes.test.ts — ADR-200 S9, `projections` on
 * GET /api/providers/company/:companyId/key:
 *   - flag OFF: the field is absent (T-1201 response unchanged);
 *   - flag ON: ledger states (adopted, failed), the shared-tree refusal and the
 *     link-mode classification (subscription, unset) per harness;
 *   - member isolation: one member's ledger never shows in another's view;
 *   - the response never carries a key value or a ledger fingerprint.
 *
 * Nothing is mocked: real database, sharing policy, AES store and harness
 * files, all inside the hermetic sandbox (B-1544).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { type AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

// B-1544: must stay the first app-side import; it sandboxes HOME, CLAUDE_CONFIG_DIR, DATABASE_PATH.
import { assertInsideSandbox, removeSandbox } from './helpers/hermetic-sandbox.js';

const KEY_A = 'sk' + '-ant-api03-PROJECTION-A-DO-NOT-LEAK';
const KEY_O = 'sk' + '-proj-PROJECTION-OPENAI-DO-NOT-LEAK';

process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';

const { initializeDatabase, closeConnection, userDb } = await import('@/modules/database/index.js');
const { setProviderSharingConfig, _resetProviderSharingCache } = await import('@/services/provider-sharing.js');
const { userConfigDir } = await import('@/services/isolation/provision-user-dirs.js');
const store = await import('@/services/isolation/provider-secrets-store.js');
const { default: providerRoutes } = await import('../provider.routes.js');
const { AppError } = await import('@/shared/utils.js');

await initializeDatabase();
_resetProviderSharingCache();
setProviderSharingConfig({ claude: 'isolated', codex: 'isolated', opencode: 'shared' });
store._resetProviderSecretsServerKeyCache();

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const id = req.header('x-test-user');
    if (id) {
      (req as Request & { user?: Record<string, unknown> }).user = {
        id: Number(id), role: 'user', status: 'active', is_active: 1,
        authenticationKind: 'session', authorizationGeneration: 1,
      };
    }
    next();
  });
  app.use('/api/providers', providerRoutes);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ success: false, error: { code: err instanceof AppError ? err.code : 'INTERNAL_ERROR' } });
  });
  return app;
}

type Projection = { vendorId: string; provider: string; target?: string; state: string };

/** GET the company status as `user`; asserts no key or fingerprint is in the body. */
async function status(user: number, companyId: string, secrets: string[] = []) {
  const res = await fetch(`${baseUrl}/api/providers/company/${companyId}/key`, { headers: { 'x-test-user': String(user) } });
  const text = await res.text();
  for (const secret of [KEY_A, KEY_O, ...secrets]) assert.equal(text.includes(secret), false, 'no credential or fingerprint in the response');
  assert.equal(res.status, 200, text);
  return (JSON.parse(text) as { data: { slots: unknown[]; projections?: Projection[] } }).data;
}

function newMember(name: string): number {
  return (userDb.createUser(name, 'hash', 'user') as { id: number }).id;
}

/** Seeds one ledger entry with the real fingerprint of `key`; returns that fingerprint. */
function seedLedger(userId: number, vendorId: string, harness: 'claude' | 'codex', state: string, origin: string, key: string): string {
  const fingerprint = store.projectionFingerprint(key, store.PROJECTION_FINGERPRINT_KEY_VERSION);
  store.setVendorLedger(userId, vendorId, { v: 1, entries: [{
    harness, target: null, fingerprint, keyVersion: store.PROJECTION_FINGERPRINT_KEY_VERSION,
    state, origin, updatedAt: new Date().toISOString(),
  }] });
  return fingerprint;
}

function claudeOauth(id: number): void {
  const file = assertInsideSandbox(path.join(userConfigDir(id, '.claude'), '.credentials.json'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'at', refreshToken: 'rt' } }));
}

const byProvider = (list: Projection[] | undefined, provider: string) => list?.find((p) => p.provider === provider);

before(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  removeSandbox();
});

test('flag OFF: the status carries no projections field', async () => {
  const member = newMember('proj-flag-off');
  seedLedger(member, 'anthropic', 'claude', 'synced', 'fanout', KEY_A);
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
  try {
    const data = await status(member, 'anthropic');
    assert.equal('projections' in data, false);
    assert.equal(Array.isArray(data.slots), true);
  } finally {
    process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
  }
});

test('flag ON: ledger states and the shared-tree refusal, with no fingerprint in the body', async () => {
  const member = newMember('proj-ledger');
  const fpA = seedLedger(member, 'anthropic', 'claude', 'synced', 'adopted', KEY_A);
  const fpO = seedLedger(member, 'openai', 'codex', 'failed', 'fanout', KEY_O);
  const anthropic = await status(member, 'anthropic', [fpA, fpO]);
  assert.deepEqual(byProvider(anthropic.projections, 'claude'), { vendorId: 'anthropic', provider: 'claude', state: 'adopted' });
  assert.deepEqual(byProvider(anthropic.projections, 'opencode'),
    { vendorId: 'anthropic-opencode', provider: 'opencode', target: 'anthropic', state: 'shared_scope_refused' });
  const openai = await status(member, 'openai', [fpA, fpO]);
  assert.deepEqual(byProvider(openai.projections, 'codex'), { vendorId: 'openai', provider: 'codex', state: 'failed' });
});

test('flag ON, no ledger entry: a subscription login is kept_on_subscription, nothing is mode_unset', async () => {
  const subscribed = newMember('proj-subscribed');
  claudeOauth(subscribed);
  assert.equal(byProvider((await status(subscribed, 'anthropic')).projections, 'claude')?.state, 'kept_on_subscription');
  const empty = newMember('proj-empty');
  assert.equal(byProvider((await status(empty, 'anthropic')).projections, 'claude')?.state, 'mode_unset');
  assert.equal(store.readLinkModeRecordState(empty, 'claude').state, 'absent', 'the status GET never persists a mode');
});

test('member isolation: member B never sees member A\'s ledger', async () => {
  const a = newMember('proj-iso-a');
  const b = newMember('proj-iso-b');
  const fp = seedLedger(a, 'anthropic', 'claude', 'tombstone', 'fanout', KEY_A);
  assert.equal(byProvider((await status(a, 'anthropic', [fp])).projections, 'claude')?.state, 'tombstone');
  assert.equal(byProvider((await status(b, 'anthropic', [fp])).projections, 'claude')?.state, 'mode_unset');
});
