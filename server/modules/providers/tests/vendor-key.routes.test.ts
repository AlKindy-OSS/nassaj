/**
 * vendor-key.routes.test.ts — ADR-200 G2 (B-1570), the two vendor-key routes:
 *   - POST /company/:companyId/key/conflict (D9 choice);
 *   - POST /vendor-keys/backups/:harness/restore (§3 rollback).
 * Covered: body validation (400), the :harness allowlist (traversal and unknown
 * names), the credential-write gate (403 for a shared tree), no signed-in
 * member (400), the shared rate limit (429), and that one member can never
 * restore into another member's tree.
 *
 * Nothing is mocked: real database and sharing policy, real migration runtime,
 * real AES store and real harness files, all inside the hermetic sandbox.
 * Each test sends its own client address (`cf-connecting-ip`, trusted from a
 * loopback peer) so the per-IP limiter is exercised only where intended.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { type AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

// B-1544: must stay the first app-side import; it sandboxes HOME, CLAUDE_CONFIG_DIR, DATABASE_PATH.
import { assertInsideSandbox, removeSandbox } from './helpers/hermetic-sandbox.js';

const KEY_A = 'sk' + '-ant-api03-ROUTE-A-DO-NOT-LEAK';
const KEY_B = 'sk' + '-ant-api03-ROUTE-B-DO-NOT-LEAK';
const OAUTH = 'sk' + '-ant-oat01-ROUTE-OAUTH-DO-NOT-LEAK';

process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 4).toString('base64');
process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
delete process.env.NASSAJ_TRUSTED_PROXY_HOPS;

const { initializeDatabase, closeConnection, userDb } = await import('@/modules/database/index.js');
const { setProviderSharingConfig, _resetProviderSharingCache } = await import('@/services/provider-sharing.js');
const { userConfigDir } = await import('@/services/isolation/provision-user-dirs.js');
const store = await import('@/services/isolation/provider-secrets-store.js');
const { vendorKeyMigrationService } = await import('../services/vendor-key-migration.runtime.js');
const { default: providerRoutes } = await import('../provider.routes.js');
const { AppError } = await import('@/shared/utils.js');

await initializeDatabase();
_resetProviderSharingCache();
setProviderSharingConfig({ claude: 'isolated', codex: 'isolated', opencode: 'shared' });
store._resetProviderSecretsServerKeyCache();

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let ipSeq = 1;

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const id = req.header('x-test-user');
    if (id) {
      (req as Request & { user?: Record<string, unknown> }).user = {
        id: Number(id), role: req.header('x-test-role') ?? 'user', status: 'active', is_active: 1,
        authenticationKind: 'session', authorizationGeneration: 1,
      };
    }
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

type Caller = { user?: number; role?: string; ip: string };

/** A fresh client address per caller, so each test owns its limiter bucket. */
function caller(user?: number, role?: string): Caller {
  return { user, role, ip: `198.51.100.${ipSeq++}` };
}

async function call(who: Caller, route: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'cf-connecting-ip': who.ip };
  if (who.user !== undefined) headers['x-test-user'] = String(who.user);
  if (who.role) headers['x-test-role'] = who.role;
  const res = await fetch(`${baseUrl}${route}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  const text = await res.text();
  for (const secret of [KEY_A, KEY_B, OAUTH]) assert.equal(text.includes(secret), false, 'no response carries a credential');
  return { status: res.status, body: JSON.parse(text) as { data?: Record<string, unknown>; error?: { code?: string }; code?: string } };
}

const claudeSettings = (id: number) => assertInsideSandbox(path.join(userConfigDir(id, '.claude'), 'settings.json'));

function writeClaude(id: number, env: Record<string, string>): void {
  const file = claudeSettings(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ env }));
}

const claudeKey = (id: number) => (JSON.parse(fs.readFileSync(claudeSettings(id), 'utf8')) as { env: Record<string, string> }).env.ANTHROPIC_API_KEY;

function newMember(name: string): number {
  return (userDb.createUser(name, 'hash', 'user') as { id: number }).id;
}

before(async () => {
  await new Promise<void>((resolve) => { server = buildApp().listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  removeSandbox();
});

const CONFLICT = '/api/providers/company/anthropic/key/conflict';
const restoreRoute = (harness: string) => `/api/providers/vendor-keys/backups/${harness}/restore`;

test('conflict: a malformed key source is a 400 and writes nothing', async () => {
  const member = newMember('route-conflict-400');
  const who = caller(member);
  for (const body of [{ harness: 'gemini' }, { harness: '../claude' }, { harness: 'claude', target: 7 }, {}]) {
    const res = await call(who, CONFLICT, body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error?.code, 'INVALID_KEY_SOURCE');
  }
  assert.equal(store.readVendorMigrationState(member).state, 'absent');
});

test('conflict: no signed-in member is a 400; an unknown vendor is a 404', async () => {
  const anonymous = await call(caller(), CONFLICT, { harness: 'claude' });
  assert.equal(anonymous.status, 400);
  assert.equal(anonymous.body.error?.code, 'MEMBER_REQUIRED');
  const unknown = await call(caller(newMember('route-conflict-404')), '/api/providers/company/nope/key/conflict', { harness: 'claude' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error?.code, 'UNKNOWN_MIGRATION_VENDOR');
});

test('conflict: the chosen source becomes the canonical key; the response carries no key', async () => {
  const member = newMember('route-conflict-ok');
  store.setCanonicalVendorKey(member, 'anthropic', KEY_A);
  writeClaude(member, { ANTHROPIC_API_KEY: KEY_B });
  const res = await call(caller(member), CONFLICT, { harness: 'claude', target: null });
  assert.equal(res.status, 200);
  assert.equal(store.getCanonicalVendorKey(member, 'anthropic'), KEY_B);
});

test('restore: the :harness allowlist refuses traversal and unknown names', async () => {
  const who = caller(newMember('route-restore-allowlist'));
  for (const harness of ['..%2Fclaude', '..%2F..%2F.claude', '%2E%2E%2Fcodex', 'gemini', 'store']) {
    const res = await call(who, restoreRoute(harness));
    assert.equal(res.status, 400, harness);
    assert.equal(res.body.error?.code, 'INVALID_HARNESS', harness);
  }
});

test('restore: a shared tree needs an elevated role (403); no member is a 400', async () => {
  const member = newMember('route-restore-403');
  const forbidden = await call(caller(member), restoreRoute('opencode'));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error?.code, 'CREDENTIAL_WRITE_FORBIDDEN');
  const anonymous = await call(caller(), restoreRoute('claude'));
  assert.equal(anonymous.status, 400);
  assert.equal(anonymous.body.error?.code, 'MEMBER_REQUIRED');
});

test('restore: member A can never restore into member B\'s tree', async () => {
  const memberA = newMember('route-restore-a');
  const memberB = newMember('route-restore-b');
  writeClaude(memberB, { ANTHROPIC_API_KEY: KEY_A, CLAUDE_CODE_OAUTH_TOKEN: OAUTH });
  await vendorKeyMigrationService.ensureBackups(memberB);
  writeClaude(memberB, { ANTHROPIC_API_KEY: KEY_B, CLAUDE_CODE_OAUTH_TOKEN: OAUTH });

  const asA = await call(caller(memberA), restoreRoute('claude'), { userId: memberB, mode: 'full', confirm: true });
  assert.equal(asA.status, 409);
  assert.equal(asA.body.error?.code, 'VENDOR_BACKUP_UNAVAILABLE', 'A has no backup of its own; B is never addressed');
  assert.equal(claudeKey(memberB), KEY_B, 'B\'s file is untouched');

  const asB = await call(caller(memberB), restoreRoute('claude'));
  assert.equal(asB.status, 200);
  assert.equal(asB.body.data?.mode, 'keys');
  assert.equal(claudeKey(memberB), KEY_A, 'B restores its own key field');
});

test('restore: full mode needs confirm (409); an unknown mode is a 400', async () => {
  const member = newMember('route-restore-mode');
  writeClaude(member, { ANTHROPIC_API_KEY: KEY_A });
  await vendorKeyMigrationService.ensureBackups(member);
  const who = caller(member);
  const unconfirmed = await call(who, restoreRoute('claude'), { mode: 'full' });
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.body.error?.code, 'VENDOR_RESTORE_CONFIRM_REQUIRED');
  const invalid = await call(who, restoreRoute('claude'), { mode: 'bytes' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error?.code, 'INVALID_RESTORE_MODE');
});

test('both routes share one rate limit: the 11th call in a minute is a 429', async () => {
  const who = caller(newMember('route-rate-limit'));
  for (let index = 0; index < 10; index += 1) {
    const route = index % 2 === 0 ? CONFLICT : restoreRoute('gemini');
    assert.equal((await call(who, route, { harness: 'nope' })).status, 400);
  }
  const limited = await call(who, CONFLICT, { harness: 'nope' });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'VENDOR_KEY_RATE_LIMITED');
});
