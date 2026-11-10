/**
 * link-mode-own-tree.routes.test.ts — ADR-200 S4, G1 fixes H-1 and M-4, with a
 * REAL database, the REAL Claude writer and the REAL credential inventory.
 * Claude is always isolated (ADR-152 A1), so every caller's link mode and
 * credential writes live in the caller's OWN tree, whatever the role:
 *
 *  H-1: admin A's link mode is A's own; it neither lands in operator scope nor
 *       blocks admin B, and nothing reaches the operator's settings.json.
 *  M-4: out of flag, `DELETE /claude/api-key?target=setup_token` removes the
 *       caller's stored setup token only (never `.credentials.json`), is audited,
 *       and a member may do it in their own tree.
 *
 * Only the registry is mocked, to keep Codex and OpenCode off disk.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { type AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, beforeEach, mock, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import express, { type NextFunction, type Request, type Response } from 'express';

// B-1544: must stay the first app-side import; it sandboxes HOME, CLAUDE_CONFIG_DIR, DATABASE_PATH.
import { assertInsideSandbox, removeSandbox, sandboxClaudeDir } from './helpers/hermetic-sandbox.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;

const KEY = 'sk' + '-ant-api03-SHARED-DO-NOT-LEAK';
const SETUP = 'sk' + '-ant-oat01-SHARED-SETUP-DO-NOT-LEAK';
process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 5).toString('base64');

const { ClaudeCredentialsWriter } = await import('../list/claude/claude-credentials.writer.js');
const passive = (provider: string) => ({
  credentials: {
    getWriterCapability: () => ({ method: 'native_file' }),
    setApiKey: async () => ({ provider, configured: true }),
    deleteApiKey: async () => ({ provider, configured: false }),
    isConfigured: async () => false,
  },
  auth: { getStatus: async () => ({ authenticated: false }) },
});
const fakeProviders: Record<string, unknown> = {
  claude: { credentials: new ClaudeCredentialsWriter(), auth: { getStatus: async () => ({ authenticated: true }) } },
  codex: passive('codex'),
  opencode: passive('opencode'),
};
mock.module(url('../provider.registry.js'), {
  namedExports: {
    providerRegistry: {
      listProviders: () => Object.values(fakeProviders),
      resolveProvider: (provider: string) => {
        const found = fakeProviders[provider];
        if (!found) throw Object.assign(new Error('unsupported'), { code: 'UNSUPPORTED_PROVIDER' });
        return found;
      },
      resolveHistorySessions: () => { throw new Error('not used'); },
    },
  },
});

const { initializeDatabase, closeConnection, getConnection, userDb } = await import('@/modules/database/index.js');
const { default: providerRoutes } = await import('../provider.routes.js');
const { AppError } = await import('@/shared/utils.js');
const store = await import('@/services/isolation/provider-secrets-store.js');
const { userConfigDir } = await import('@/services/isolation/provision-user-dirs.js');

await initializeDatabase();

const operatorDir = sandboxClaudeDir;
assert.equal(process.env.CLAUDE_CONFIG_DIR, operatorDir, 'the operator tree is the sandboxed one');
const operatorSettingsPath = path.join(operatorDir, 'settings.json');
const CREDENTIALS = '{"claudeAiOauth":{"accessToken":"at","refreshToken":"rt"}}';

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: Record<string, unknown> }).user = {
      id: req.header('x-test-user'), role: req.header('x-test-role'), status: 'active', is_active: 1,
      authenticationKind: 'session', authorizationGeneration: 1,
    };
    (req as Request & { assertCurrentIdentity?: () => boolean }).assertCurrentIdentity = () => true;
    next();
  });
  app.use('/api/providers', providerRoutes);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  return app;
}

async function call(method: string, route: string, as: { id: string; role: string }, body?: unknown) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': as.id, 'x-test-role': as.role },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  assert.equal(text.includes(KEY) || text.includes(SETUP), false, 'no response carries a secret');
  return { status: res.status, body: JSON.parse(text) as { data?: Record<string, unknown>; error?: { code?: string } } };
}

const adminA = { id: String(userDb.createUser('admin-a', 'hash', 'admin').id), role: 'admin' };
const adminB = { id: String(userDb.createUser('admin-b', 'hash', 'admin').id), role: 'admin' };
const member = { id: String(userDb.createUser('member-c', 'hash', 'user').id), role: 'user' };
const ownDir = (user: { id: string }) => userConfigDir(user.id, '.claude');
const settingsOf = (user: { id: string }) => path.join(ownDir(user), 'settings.json');
const credentialsOf = (user: { id: string }) => path.join(ownDir(user), '.credentials.json');
const readEnv = (user: { id: string }) => (JSON.parse(fs.readFileSync(settingsOf(user), 'utf8')).env ?? {}) as Record<string, string>;

before(async () => {
  store._resetProviderSecretsServerKeyCache();
  await new Promise<void>((resolve) => { server = buildApp().listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  removeSandbox();
});

beforeEach(() => {
  fs.rmSync(assertInsideSandbox(operatorDir), { recursive: true, force: true });
  fs.mkdirSync(operatorDir, { recursive: true });
  for (const user of [adminA, adminB, member]) {
    fs.mkdirSync(ownDir(user), { recursive: true });
    fs.rmSync(settingsOf(user), { force: true });
    fs.writeFileSync(credentialsOf(user), CREDENTIALS);
  }
});

test('H-1: admin A\'s link mode is A\'s own; it neither reaches operator scope nor blocks admin B', async () => {
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
  const switched = await call('PUT', '/api/providers/claude/link-mode', adminA, { mode: 'subscription', confirm: true });
  assert.equal(switched.status, 200);
  assert.equal(store.getLinkModeRecord(adminA.id, 'claude')?.mode, 'subscription', 'stored in the caller\'s own scope');
  assert.equal(store.getLinkModeRecord(null, 'claude'), null, 'never in operator scope');

  assert.equal(store.getLinkModeRecord(adminB.id, 'claude'), null, 'A\'s switch never writes B\'s scope');

  // B (no subscription login in their own tree) saves a key: it lands in B's tree,
  // never in the operator's settings.json, and A's subscription mode does not refuse it.
  fs.rmSync(credentialsOf(adminB), { force: true });
  const switchedB = await call('PUT', '/api/providers/claude/link-mode', adminB, { mode: 'api_key', confirm: true });
  assert.equal(switchedB.status, 200);
  const company = await call('POST', '/api/providers/company/anthropic/key', adminB, { apiKey: KEY, includeSubscription: true });
  assert.equal(company.status, 200, JSON.stringify(company.body));
  const claude = (company.body.data?.slots as Array<{ provider: string; outcome: string }>).find((slot) => slot.provider === 'claude');
  assert.equal(claude?.outcome, 'linked', 'B\'s own tree takes the key; no shared-scope refusal exists');
  assert.equal(readEnv(adminB).ANTHROPIC_API_KEY, KEY, 'the key is in B\'s own tree');
  assert.equal(fs.existsSync(operatorSettingsPath), false, 'nothing reached the operator settings.json');
  assert.equal(fs.existsSync(settingsOf(adminA)), false, 'nothing reached A\'s tree');
});

test('M-4: out of flag, target=setup_token removes only the caller\'s setup token, audited', async () => {
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
  fs.writeFileSync(settingsOf(member), JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: SETUP, ANTHROPIC_API_KEY: KEY } }));
  fs.writeFileSync(operatorSettingsPath, JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: SETUP } }));

  const res = await call('DELETE', '/api/providers/claude/api-key?target=setup_token', member);
  assert.equal(res.status, 200, 'a member may clear their own tree');
  assert.deepEqual(readEnv(member), { ANTHROPIC_API_KEY: KEY }, 'the API key stays');
  assert.equal(fs.readFileSync(credentialsOf(member), 'utf8'), CREDENTIALS, '.credentials.json untouched');
  assert.equal(
    JSON.parse(fs.readFileSync(operatorSettingsPath, 'utf8')).env.CLAUDE_CODE_OAUTH_TOKEN,
    SETUP,
    'the operator tree is never touched',
  );
  const rows = getConnection().prepare("SELECT user_id, metadata FROM audit_log WHERE action = 'claude_setup_token_deleted'").all() as
    Array<{ user_id: number; metadata: string }>;
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0].user_id), member.id);
  assert.equal(rows[0].metadata.includes('oat01'), false, 'no token in the audit row');

  const plain = await call('DELETE', '/api/providers/claude/api-key', member);
  assert.equal(plain.status, 200);
  assert.equal(fs.readFileSync(credentialsOf(member), 'utf8'), CREDENTIALS);
  const codex = await call('DELETE', '/api/providers/codex/api-key?target=setup_token', member);
  assert.equal(codex.status, 400);
});
