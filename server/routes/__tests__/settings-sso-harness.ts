/**
 * Shared harness for the owner SSO settings API tests (ADR-194 D8/D9, T-1962
 * S4). The REAL settings router, OIDC callback, step-up verifier (password
 * evidence), services and database run against an in-process mock OpenID
 * Provider (a pinnedFetchJson transport; no socket to the IdP, no Docker).
 *
 * Mocked: the per-user step-up quota (always allows; its own suite covers it),
 * live revocation (counted), notifications and the client IP. The real rate
 * limiter is wrapped so each test gets fresh buckets (`nextRateEpoch`).
 * Must be imported before anything else in a test file.
 */
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

import { createMockOpenIdProvider } from '../../services/__tests__/mock-openid-provider.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;

process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
for (const key of Object.keys(process.env)) if (key.startsWith('OIDC_')) delete process.env[key];
delete process.env.NASSAJ_SSO_FORCE_OFF;
process.env.DATABASE_PATH = path.join(mkdtempSync(path.join(os.tmpdir(), 'sso-settings-')), 'db.sqlite');

let rateEpoch = 0;
/** Fresh rate-limit buckets for the next requests. */
export function nextRateEpoch() {
  rateEpoch += 1;
}

type Limiter = (req: unknown, res: unknown, next: () => void) => void;
type LimiterOptions = { key?: (req: unknown) => string } & Record<string, unknown>;
const realRateLimit = await import(url('../../middleware/rate-limit.js')) as {
  createRateLimiter: (options: LimiterOptions) => Limiter;
};
mock.module(url('../../middleware/rate-limit.js'), {
  namedExports: {
    createRateLimiter: (options: LimiterOptions) => realRateLimit.createRateLimiter({
      ...options, key: (req: unknown) => `${rateEpoch}:${options.key ? options.key(req) : 'ip'}`,
    }),
  },
});
mock.module(url('../../services/step-up-quota.js'), {
  namedExports: { consumeStepUpAttempt: () => ({ allowed: true, retryAfterSeconds: 0 }), refundStepUpAttempt: () => {} },
});
export const liveRevocations: number[] = [];
mock.module(url('../../modules/account-wallet/user-identity-revocation.js'), {
  namedExports: {
    revokeUserIdentity: (userId: number) => {
      liveRevocations.push(userId);
      return { abortedRuns: 0, closedSockets: 0, endedInteractiveSessions: 0 };
    },
  },
});
mock.module(url('../../services/notification-orchestrator.js'), {
  namedExports: { createNotificationEvent: (event: unknown) => event, notifyUserIfEnabled: () => {} },
});
mock.module(url('../../utils/client-ip.js'), { namedExports: { clientIp: () => '127.0.0.1' } });

const { initializeDatabase } = await import('../../modules/database/init-db.js');
const { stopReconcileScheduler } = await import('../../modules/database/project-reconcile.service.js');
const { getConnection } = await import('../../modules/database/connection.js');
const { userDb } = await import('../../modules/database/repositories/users.js');
const { hashPassword } = await import('../../services/password.service.js');
const { setSsoNetworkOverridesForTests } = await import('../../services/sso-oidc-runtime.service.js');
const { resetSsoConfigCacheForTests } = await import('../../services/sso-config.service.js');
const { INSTALLATION_ORIGIN_CONFIG_KEY } = await import('../../services/installation-origin.service.js');
await initializeDatabase();
stopReconcileScheduler();

const { default: oidcRouter } = await import('../oidc.js');
const { default: ssoRouter } = await import('../settings-sso.js');

export const db = getConnection();
export const OWNER_PASSWORD = 'owner-local-password-1';
export const ORIGIN = 'https://nassaj.example';
const ownerHash = await hashPassword(OWNER_PASSWORD);
export const owner = userDb.createUser('settings_owner', ownerHash, 'owner');
export const admin = userDb.createUser('settings_admin', 'hash-admin', 'admin');
export const member = userDb.createUser('settings_member', 'hash-member', 'user');
export const STEP_UP = Object.freeze({ method: 'password', password: OWNER_PASSWORD });

/** The test app; a suite may mount further real routers on it (after the harness routers). */
export const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const id = Number(req.headers['x-test-user-id'] ?? owner.id);
  const user = userDb.getUserById(id);
  (req as { user?: unknown }).user = user ? { ...user, id: user.id } : undefined;
  if (req.headers['x-test-device'] === '1') {
    (req as { devicePrincipal?: unknown }).devicePrincipal = { deviceSessionId: 'd', slotId: 's', generation: 1 };
  }
  next();
});
app.use('/api/auth/oidc', oidcRouter);
app.use('/api/settings/sso', ssoRouter);
const server: Server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
export const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
// The listening port is the implicit trusted loopback origin for cookie mutations
// such as the forced password change (ADR-163 amendment 1, D1).
process.env.SERVER_PORT = String((server.address() as AddressInfo).port);
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

export let op = createMockOpenIdProvider();
/** Routes every IdP request to `provider`. */
export function useProvider(provider: ReturnType<typeof createMockOpenIdProvider>) {
  op = provider;
  setSsoNetworkOverridesForTests(provider.network);
}

/** Clean SSO state, a confirmed origin, fresh caches and rate buckets. */
export function resetSsoFixture() {
  db.exec(`DELETE FROM sso_oidc_config; DELETE FROM sso_test_results; DELETE FROM sso_apply_proofs;
    DELETE FROM user_identities; DELETE FROM api_keys; DELETE FROM audit_log;`);
  db.prepare("DELETE FROM app_config WHERE key = 'sso.disabled'").run();
  db.prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(INSTALLATION_ORIGIN_CONFIG_KEY, ORIGIN);
  db.prepare('UPDATE users SET must_change_password = 0, role = ? WHERE id = ?').run('owner', owner.id);
  for (const key of Object.keys(process.env)) if (key.startsWith('OIDC_')) delete process.env[key];
  delete process.env.NASSAJ_SSO_FORCE_OFF;
  resetSsoConfigCacheForTests();
  useProvider(createMockOpenIdProvider());
  liveRevocations.length = 0;
  nextRateEpoch();
}

export type ApiResult = { status: number; body: Record<string, unknown>; headers: Headers; text: string };

/** One API call as `userId` (default owner). */
export async function api(method: string, route: string, body?: unknown,
  options: { userId?: number; headers?: Record<string, string> } = {}): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}/api/settings/sso${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user-id': String(options.userId ?? owner.id),
      ...options.headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed, headers: response.headers, text };
}

/** A complete, valid PUT /draft body for the current mock provider. */
export function draftBody(overrides: Record<string, unknown> = {}) {
  return {
    issuer: op.issuer, clientId: op.clientId, clientAuth: 'none', extraScopes: '', roleClaimPath: 'roles',
    roleRules: [{ value: 'admin', role: 'admin' }, { value: 'member', role: 'user' }],
    tenantMode: 'claim', tenantClaimPath: 'org', tenantValues: ['org-1'], jitEnabled: false,
    attestationMaxAgeHours: 12, allowPrivateNetwork: false, issuerPort: null, ...overrides,
  };
}

export const OWNER_IDP_CLAIMS = Object.freeze({ sub: 'owner-at-idp', roles: ['member'], org: 'org-1' });

/** Starts a test sign-in and completes it at the mock IdP; returns the redirect target. */
export async function runTestSignIn(claims: Record<string, unknown> = OWNER_IDP_CLAIMS) {
  const started = await api('POST', '/draft/test-login/start');
  if (started.status !== 200) return { started, location: null };
  const cookie = (started.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  const { code, state } = op.authorize(String(started.body.authorizationUrl), claims);
  const callback = await fetch(`${baseUrl}/api/auth/oidc/callback?${new URLSearchParams({ state, code })}`,
    { headers: { cookie }, redirect: 'manual' });
  return { started, location: new URL(callback.headers.get('location') ?? '', ORIGIN) };
}

/** PUT draft → test-discovery → test sign-in; returns the binding apply needs. */
export async function proveDraft(body: Record<string, unknown> = draftBody(), claims?: Record<string, unknown>) {
  const saved = await api('PUT', '/draft', body);
  if (saved.status !== 200) throw new Error(`draft save failed: ${saved.text}`);
  const discovery = await api('POST', '/draft/test-discovery');
  if (discovery.body.passed !== true) throw new Error(`discovery failed: ${discovery.text}`);
  const signIn = await runTestSignIn(claims);
  const draft = (await api('GET', '/')).body.draft as { draftVersion: number; configHash: string };
  return { draftVersion: draft.draftVersion, configHash: draft.configHash, resultId: signIn.location?.searchParams.get('ssoTest') };
}

export const stamp = (userId: number) => (db.prepare('SELECT password_changed_at AS v FROM users WHERE id = ?')
  .get(userId) as { v: number | null }).v;
