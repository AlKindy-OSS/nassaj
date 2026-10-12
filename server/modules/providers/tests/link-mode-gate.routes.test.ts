/**
 * link-mode-gate.routes.test.ts — ADR-200 S4, the 409 gate at the single choke
 * point (`providerCredentialsService.setKey`), reached from all three paths:
 *   1. fan-out (the service called directly);
 *   2. the company route (`/company/:id/key`, even with includeSubscription);
 *   3. the legacy route (`/:provider/api-key`), which becomes read-only for keys.
 * Plus the link-mode API S9 consumes, and flag-off parity.
 *
 * Hermetic: the provider registry is mocked (fake writers record every call),
 * and so is the credential inventory (a per-harness fixture). The encrypted
 * store is REAL, under the runner's sandboxed HOME.
 */

import assert from 'node:assert/strict';
import { type AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, beforeEach, mock, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import express, { type NextFunction, type Request, type Response } from 'express';

// B-1544: must stay the first app-side import; it sandboxes HOME, CLAUDE_CONFIG_DIR, DATABASE_PATH.
import { removeSandbox } from './helpers/hermetic-sandbox.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;

const KEY = 'sk' + '-ant-api03-GATE-DO-NOT-LEAK';
const OPENAI = 'sk' + '-proj-GATE-DO-NOT-LEAK';
process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';

type Inventory = {
  harness: 'claude' | 'codex';
  managedKey: string | null;
  unmanagedKeySource: string | null;
  hasSubscription: boolean;
  subscriptionIdentity: string | null;
  effective: 'api_key' | 'subscription' | 'none';
};
const subscribed = (harness: 'claude' | 'codex'): Inventory => ({
  harness, managedKey: null, unmanagedKeySource: null, hasSubscription: true, subscriptionIdentity: 'login-1', effective: 'subscription',
});
let inventories: Record<string, Inventory> = {};
const writes: string[] = [];

/** ADR-200 S6: what each fake file holds now, so the fan-out can read and verify it. */
const stored = new Map<string, string>();

function fakeWriter(provider: string) {
  const slot = (userId: unknown, target?: string) => `${String(userId)}:${provider}/${target ?? ''}`;
  return {
    getWriterCapability: () => ({ method: 'native_file' }),
    readApiKey: async (userId: unknown, target?: string) => stored.get(slot(userId, target)) ?? null,
    async setApiKey(userId: unknown, key: string, target?: string) {
      stored.set(slot(userId, target), key);
      writes.push(`${provider}${target ? `/${target}` : ''}:set`);
      const inv = inventories[provider];
      if (inv) inventories[provider] = { ...inv, managedKey: key, effective: 'api_key' };
      return { provider, configured: true };
    },
    async deleteApiKey(userId: unknown, target?: string) {
      stored.delete(slot(userId, target));
      writes.push(`${provider}${target ? `/${target}` : ''}:delete`);
      const inv = inventories[provider];
      if (inv) inventories[provider] = { ...inv, managedKey: null, effective: inv.hasSubscription ? 'subscription' : 'none' };
      return { provider, configured: false };
    },
    isConfigured: async () => false,
  };
}

const fakeProviders: Record<string, unknown> = {
  claude: { credentials: fakeWriter('claude'), auth: { getStatus: async () => ({ authenticated: true, authMode: 'subscription_oauth' }) } },
  codex: { credentials: fakeWriter('codex'), auth: { getStatus: async () => ({ authenticated: true, authMode: 'subscription_oauth' }) } },
  opencode: { credentials: fakeWriter('opencode'), auth: { getStatus: async () => ({ authenticated: false }) } },
};

mock.module(url('../provider.registry.js'), {
  namedExports: {
    providerRegistry: {
      listProviders: () => Object.values(fakeProviders),
      resolveProvider: (provider: string) => {
        const found = fakeProviders[provider];
        if (!found) throw Object.assign(new Error(`Unsupported provider "${provider}".`), { code: 'UNSUPPORTED_PROVIDER' });
        return found;
      },
      resolveHistorySessions: () => { throw new Error('not used'); },
    },
  },
});

mock.module(url('../services/harness-credential-inventory.js'), {
  namedExports: {
    readHarnessCredentialInventory: (_userId: unknown, harness: string) => inventories[harness],
  },
});

const { providerCredentialsService } = await import('../services/provider-credentials.service.js');
const { companyCredentialsService } = await import('../services/company-credentials.service.js');
const { default: providerRoutes } = await import('../provider.routes.js');
const { AppError } = await import('@/shared/utils.js');
const store = await import('@/services/isolation/provider-secrets-store.js');

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let nextUser = 100;
let user = '';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: Record<string, unknown> }).user = {
      id: req.header('x-test-user'), role: 'owner', status: 'active', is_active: 1,
      authenticationKind: 'session', authorizationGeneration: 1,
    };
    (req as Request & { assertCurrentIdentity?: () => boolean }).assertCurrentIdentity = () => true;
    next();
  });
  app.use('/api/providers', providerRoutes);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code, details: err.details } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  return app;
}

async function call(method: string, route: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  assert.equal(text.includes(KEY) || text.includes(OPENAI), false, 'no response ever carries a key');
  return { status: res.status, body: JSON.parse(text) as { data?: Record<string, unknown>; error?: { code?: string } } };
}

before(async () => {
  store._resetProviderSecretsServerKeyCache();
  await new Promise<void>((resolve) => { server = buildApp().listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  removeSandbox();
});

beforeEach(() => {
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
  user = String(nextUser++);
  inventories = { claude: subscribed('claude'), codex: subscribed('codex') };
  writes.length = 0;
});

test('fan-out: the choke point refuses claude and codex keys in subscription mode', async () => {
  for (const [provider, key] of [['claude', KEY], ['codex', OPENAI]] as const) {
    await assert.rejects(
      providerCredentialsService.setKey(user, provider, key),
      (err: { code?: string; statusCode?: number }) => err.code === 'LINK_MODE_SUBSCRIPTION' && err.statusCode === 409,
    );
  }
  assert.deepEqual(writes, []);
});

test('company route: includeSubscription cannot bypass the gate; other slots still write', async () => {
  const res = await call('POST', '/api/providers/company/anthropic/key', { apiKey: KEY, includeSubscription: true });
  assert.equal(res.status, 200);
  const slots = res.body.data?.slots as Array<{ provider: string; outcome: string; code?: string }>;
  const claude = slots.find((slot) => slot.provider === 'claude');
  assert.deepEqual({ outcome: claude?.outcome, code: claude?.code }, { outcome: 'kept_on_subscription', code: 'LINK_MODE_SUBSCRIPTION' });
  // ADR-200 S6: in-flag the company route is the unified fan-out, which reports `linked`.
  assert.ok(slots.some((slot) => slot.provider === 'opencode' && slot.outcome === 'linked'));
  assert.deepEqual(writes, ['opencode/anthropic:set']);
});

test('company service (fan-out loop) reports the same refusal for codex', async () => {
  const result = await companyCredentialsService.setKey(user, 'openai', OPENAI, {
    isElevated: true, includeSubscription: true, authenticatedPrincipal: { id: user },
  });
  const codex = result.slots.find((slot) => slot.provider === 'codex');
  assert.equal(codex?.outcome, 'kept_on_subscription');
  assert.equal(writes.includes('codex:set'), false);
});

test('legacy route: 409 LINK_MODE_SUBSCRIPTION for claude and codex', async () => {
  for (const [provider, key] of [['claude', KEY], ['codex', OPENAI]] as const) {
    for (const method of ['POST', 'PUT']) {
      const res = await call(method, `/api/providers/${provider}/api-key`, { apiKey: key });
      assert.equal(res.status, 409);
      assert.equal(res.body.error?.code, 'LINK_MODE_SUBSCRIPTION');
    }
  }
  assert.deepEqual(writes, []);
});

test('after a switch to api_key the legacy route is read-only and the company route writes', async () => {
  store.setCanonicalVendorKey(user, 'anthropic', KEY);
  const refused = await call('PUT', '/api/providers/claude/link-mode', { mode: 'api_key' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error?.code, 'LINK_MODE_CONFIRM_REQUIRED');
  const switched = await call('PUT', '/api/providers/claude/link-mode', { mode: 'api_key', confirm: true });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.data?.outcome, 'linked');
  assert.deepEqual(writes, ['claude:set'], 'the canonical key reached the harness through the switch');

  const legacy = await call('POST', '/api/providers/claude/api-key', { apiKey: KEY });
  assert.equal(legacy.body.error?.code, 'LEGACY_KEY_ROUTE_READ_ONLY');
  const company = await call('POST', '/api/providers/company/anthropic/key', { apiKey: KEY });
  const claude = (company.body.data?.slots as Array<{ provider: string; outcome: string }>).find((s) => s.provider === 'claude');
  assert.equal(claude?.outcome, 'linked', 'ADR-200 S6: the fan-out projects into the key-mode harness');
});

test('GET link-mode returns chosen and effective mode; unsupported harnesses are a 400', async () => {
  const res = await call('GET', '/api/providers/codex/link-mode');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.data ?? {}).sort(), [
    'chosenMode', 'chosenModeSource', 'credentials', 'effectiveMode', 'enabled', 'granteeCount', 'linkState', 'provider', 'warnings',
  ]);
  assert.equal(res.body.data?.chosenMode, 'subscription');
  assert.equal(res.body.data?.chosenModeSource, 'derived');
  for (const provider of ['opencode', 'antigravity']) {
    const refused = await call('GET', `/api/providers/${provider}/link-mode`);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error?.code, 'LINK_MODE_UNSUPPORTED');
  }
});

test('flag off: the legacy route writes as before and link mode reports disabled', async () => {
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
  const res = await call('POST', '/api/providers/claude/api-key', { apiKey: KEY });
  assert.equal(res.status, 200);
  assert.deepEqual(writes, ['claude:set']);
  const status = await call('GET', '/api/providers/claude/link-mode');
  assert.deepEqual(status.body.data, { provider: 'claude', enabled: false });
  const put = await call('PUT', '/api/providers/claude/link-mode', { mode: 'api_key', confirm: true });
  assert.equal(put.body.error?.code, 'LINK_MODE_DISABLED');
  assert.equal(store.getLinkModeRecord(user, 'claude'), null, 'nothing persisted with the flag off');
});

test('G1: with no credential at all, a refused slot is mode_unset, not kept_on_subscription', async () => {
  inventories.claude = {
    harness: 'claude', managedKey: null, unmanagedKeySource: null, hasSubscription: false, subscriptionIdentity: null, effective: 'none',
  };
  const res = await call('POST', '/api/providers/company/anthropic/key', { apiKey: KEY });
  const claude = (res.body.data?.slots as Array<{ provider: string; outcome: string; code?: string }>).find((s) => s.provider === 'claude');
  assert.deepEqual({ outcome: claude?.outcome, code: claude?.code }, { outcome: 'mode_unset', code: 'LINK_MODE_UNSET' });
});

test('G1: the service default origin is the restrictive legacy one', async () => {
  inventories.claude = { ...inventories.claude, managedKey: null, hasSubscription: false, subscriptionIdentity: null, effective: 'none' };
  store.setCanonicalVendorKey(user, 'anthropic', KEY);
  await providerCredentialsService.deleteKey(user, 'claude');
  await call('PUT', '/api/providers/claude/link-mode', { mode: 'api_key', confirm: true });
  await assert.rejects(providerCredentialsService.setKey(user, 'claude', KEY), { code: 'LEGACY_KEY_ROUTE_READ_ONLY' });
});
