/**
 * connectors.routes.test.ts — what a client is allowed to SAY when registering a
 * connector (B-542).
 *
 * The service layer is deliberately permissive: a CLI or a migration may hand it
 * a fully specified row, because whoever runs those already has the box. The HTTP
 * boundary is where that stops, and this file is the proof it does. It runs the
 * real router over the real service, with only the storage and the engines
 * mocked, so what is asserted is what the row would actually have received.
 *
 * The measured attack it pins: a member holding an ordinary `user` token posted
 *
 *   { service: 'sec-probe', command: '/bin/echo',
 *     args: ['{{NASSAJ_MCP_SERVERS}}/probe.js'], keyEnvVar: 'JWT_SECRET' }
 *
 * and got 201, a stored row carrying every one of those values, and a connector
 * reported as configured from `operator_env` — that is, nassaj offering to launch
 * a command of their choosing with its own signing secret in the environment.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test, mock } from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { catalogEntryFor, CONNECTOR_CATALOG } from '../../../shared/connector-catalog.js';

const createCalls: Array<Record<string, unknown>> = [];
const auditCalls: Array<{ action: string; options: Record<string, unknown> }> = [];
const reconcileCalls: Array<{ connectorId: string; memberUserId: number }> = [];
let placementRows: Array<Record<string, unknown>> = [];
let publishHealthyPlacements = true;
let reconcileError: Error | null = null;
let auditError: Error | null = null;
let authBootstrap: unknown = null;
const pendingStateCalls = { put: 0, consume: 0, count: 0, sweep: 0 };

function unexpectedPendingStateIo(method: keyof typeof pendingStateCalls): never {
  pendingStateCalls[method] += 1;
  throw new Error(`legacy OAuth must not call pending state ${method}`);
}

mock.module('@/modules/connectors/oauth-pending-state.store.js', {
  namedExports: {
    oauthPendingStateStore: () => ({
      put: () => unexpectedPendingStateIo('put'),
      consume: () => unexpectedPendingStateIo('consume'),
      count: () => unexpectedPendingStateIo('count'),
      sweep: () => unexpectedPendingStateIo('sweep'),
    }),
  },
});

mock.module('@/modules/connectors/connector-placement-composition.js', {
  namedExports: {
    reconcileConnectorPlacements: async (connectorId: string, memberUserId: number) => {
      reconcileCalls.push({ connectorId, memberUserId });
      if (reconcileError) throw reconcileError;
      if (publishHealthyPlacements) {
        placementRows = (['claude', 'codex'] as const).map((bodyProvider) => ({
          connectorId,
          memberUserId,
          bodyProvider,
          contractVersion: 'mcp-user-v1',
          desiredGeneration: 1,
          appliedGeneration: 1,
          state: 'healthy',
          attemptCount: 0,
          nextRetryAt: null,
          lastErrorCode: null,
          desiredAppliedMatch: true,
        }));
      }
      return {
        enabled: true,
        policy: 'all-verified-or-explicit-partial',
        state: 'verified',
        metrics: {
          targetsPlanned: 2,
          targetsVerified: 2,
          targetsBlocked: 0,
          targetsFailed: 0,
          convergeForwardAttempts: 0,
          errorsByCode: {},
        },
      };
    },
  },
});

mock.module('@/modules/providers/services/mcp.service.js', {
  namedExports: {
    providerMcpService: {
      listMcpTargets: () => [{ provider: 'claude', writesPerUserConfig: true }],
      upsertProviderMcpServer: async () => ({}),
      removeMcpServerFromAllProviders: async () => [],
    },
  },
});

mock.module('@/modules/database/repositories/users.js', {
  namedExports: { userDb: { listUsers: () => [{ id: 4 }] } },
});

mock.module('@/modules/database/repositories/audit-log.js', {
  namedExports: {
    auditLogDb: {
      record: (action: string, options: Record<string, unknown>) => {
        if (auditError) throw auditError;
        auditCalls.push({ action, options });
      },
    },
  },
});

mock.module('@/modules/database/repositories/connector-placements.db.js', {
  namedExports: {
    connectorPlacementsDb: { listPublicStatuses: () => placementRows },
    createConnectorPlacementsDb: () => ({ listPublicStatuses: () => placementRows }),
  },
});

/** The row the mocked table would hold — whatever the service actually sent it. */
let storedRow: Record<string, unknown> | null = null;
let connectorGetCalls = 0;

mock.module('@/modules/database/repositories/connectors.db.js', {
  namedExports: {
    connectorsDb: {
      get: () => {
        connectorGetCalls += 1;
        return storedRow;
      },
      list: () => (storedRow ? [storedRow] : []),
      listEnabled: () => (storedRow ? [storedRow] : []),
      listVisibleTo: () => (storedRow ? [storedRow] : []),
      listEnabledForUser: () => (storedRow ? [storedRow] : []),
      create: (row: Record<string, unknown>) => {
        if (storedRow
          && storedRow.service === row.service
          && storedRow.accountLabel === (row.accountLabel ?? '')
          && storedRow.ownerUserId === row.ownerUserId) {
          throw new Error('UNIQUE constraint failed: connectors.service, connectors.account_label, connectors.owner_user_id');
        }
        createCalls.push(row);
        storedRow = {
          accountLabel: '',
          allowsSharing: true,
          enabled: true,
          transport: 'stdio',
          command: null,
          args: [],
          url: null,
          keyEnvVar: null,
          keyHeader: null,
          keyHeaderPrefix: '',
          extraEnv: {},
          authMode: 'key',
          ownerUserId: null,
          createdBy: null,
          createdAt: '',
          updatedAt: '',
          sourceRevision: 0,
          ...row,
        };
        return storedRow;
      },
      beginSourceMutation: (_id: string, expected?: number) => {
        if (!storedRow) return null;
        const revision = Number(storedRow.sourceRevision);
        if (revision % 2 !== 0 || (expected !== undefined && revision !== expected)) return null;
        storedRow.sourceRevision = revision + 1;
        return revision + 1;
      },
      finishSourceMutation: (_id: string, odd: number) => {
        if (!storedRow || storedRow.sourceRevision !== odd || odd % 2 !== 1) return null;
        storedRow.sourceRevision = odd + 1;
        return odd + 1;
      },
      releaseSourceMutationUnchanged: (_id: string, odd: number) => {
        if (!storedRow || storedRow.sourceRevision !== odd || odd % 2 !== 1) return null;
        storedRow.sourceRevision = odd - 1;
        return odd - 1;
      },
      setExtraEnv: (_id: string, extraEnv: Record<string, string>) => {
        if (storedRow) storedRow.extraEnv = extraEnv;
        return true;
      },
      setEnabled: (_id: string, enabled: boolean) => {
        if (storedRow) storedRow.enabled = enabled;
        return true;
      },
      removeExactClaimedNewbornPersonalOAuth: (
        id: string, owner: number, odd: number, prior: number,
      ) => {
        if (!storedRow
          || storedRow.id !== id
          || storedRow.ownerUserId !== owner
          || storedRow.credentialMode !== 'per_member'
          || storedRow.authMode !== 'oauth'
          || storedRow.sourceRevision !== odd
          || odd !== prior + 1) return false;
        storedRow = null;
        return true;
      },
      remove: () => true,
    },
  },
});

const routeTestHome = fs.mkdtempSync('/var/tmp/connectors-routes-');
const originalHomedir = os.homedir;
const originalSecretsKey = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
const originalPublicOrigin = process.env.NASSAJ_PUBLIC_ORIGIN;
(os as unknown as { homedir: () => string }).homedir = () => routeTestHome;
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
process.env.NASSAJ_PUBLIC_ORIGIN = 'https://nassaj.example';

const connectorRoutesModule = await import('@/modules/connectors/connectors.routes.js');
const connectorRoutes = connectorRoutesModule.default;
const secrets = await import('@/services/isolation/provider-secrets-store.js');

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';

/**
 * The app as index.js mounts it, except authenticateToken is a header stub: the
 * routes only ever read `req.user.id` and `req.user.role`, and this preserves
 * that contract exactly while keeping JWT and the users table out of the test.
 */
function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.app.locals.connectorAuthBootstrapCapability = authBootstrap;
    (req as Request & { user?: { id: number; role: string } }).user = {
      id: Number(req.header('x-test-user') ?? 4),
      role: req.header('x-test-role') ?? 'user',
    };
    next();
  });
  app.use('/api/connectors', connectorRoutes);
  app.use('/connectors/oauth', connectorRoutesModule.connectorsOAuthCallbackRoutes);
  return app;
}

type ApiResponse = {
  status: number;
  retryAfter?: string | null;
  body: Record<string, unknown> & {
    code?: string;
    error?: string;
    connector?: Record<string, unknown>;
  };
};

async function post(body: unknown, role = 'user'): Promise<ApiResponse> {
  const res = await fetch(`${baseUrl}/api/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-role': role },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

async function getCatalog(): Promise<ApiResponse> {
  const res = await fetch(`${baseUrl}/api/connectors/catalog`);
  return { status: res.status, body: JSON.parse(await res.text()) };
}

async function getAuthProfiles(role = 'owner'): Promise<ApiResponse> {
  const res = await fetch(`${baseUrl}/api/connectors/auth-profiles`, {
    headers: { 'x-test-role': role },
  });
  return { status: res.status, body: JSON.parse(await res.text()) };
}

async function startOAuth(
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<ApiResponse> {
  const res = await fetch(`${baseUrl}/api/connectors/oauth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    body: JSON.parse(await res.text()),
  };
}

async function restartOAuth(
  id: string,
  headers: Readonly<Record<string, string>> = {},
): Promise<ApiResponse> {
  const res = await fetch(`${baseUrl}/api/connectors/${id}/oauth/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}',
  });
  return { status: res.status, body: JSON.parse(await res.text()) };
}

async function patch(id: string, body: unknown, role = 'user'): Promise<ApiResponse> {
  const res = await fetch(`${baseUrl}/api/connectors/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-test-role': role },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

async function remove(id: string, role = 'owner'): Promise<ApiResponse> {
  const res = await fetch(`${baseUrl}/api/connectors/${id}`, {
    method: 'DELETE', headers: { 'x-test-role': role },
  });
  return {
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    body: JSON.parse(await res.text()),
  };
}

async function reconcile(
  id: string,
  body: unknown = {},
  userId = 4,
  role = 'user',
): Promise<ApiResponse> {
  const res = await fetch(`${baseUrl}/api/connectors/${id}/reconcile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-test-user': String(userId),
      'x-test-role': role,
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    body: JSON.parse(await res.text()),
  };
}

before(async () => {
  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  (os as unknown as { homedir: () => string }).homedir = originalHomedir;
  if (originalSecretsKey === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  else process.env.NASSAJ_PROVIDER_SECRETS_KEY = originalSecretsKey;
  if (originalPublicOrigin === undefined) delete process.env.NASSAJ_PUBLIC_ORIGIN;
  else process.env.NASSAJ_PUBLIC_ORIGIN = originalPublicOrigin;
  secrets._resetProviderSecretsServerKeyCache();
  fs.rmSync(routeTestHome, { recursive: true, force: true });
});

beforeEach(() => {
  createCalls.length = 0;
  auditCalls.length = 0;
  reconcileCalls.length = 0;
  connectorGetCalls = 0;
  pendingStateCalls.put = 0;
  pendingStateCalls.consume = 0;
  pendingStateCalls.count = 0;
  pendingStateCalls.sweep = 0;
  storedRow = null;
  placementRows = [];
  publishHealthyPlacements = true;
  reconcileError = null;
  auditError = null;
  authBootstrap = null;
  delete process.env.NASSAJ_CONNECTOR_RECONCILER_WRITE;
  delete process.env.NASSAJ_CONNECTOR_AUTH_REGISTRY_V1;
});

test('manual reconcile is disabled inside the router before rate, connector, secret, or provider reads', async () => {
  storedRow = {
    id: 'drive-u4', service: 'google-drive', displayName: 'Drive', accountLabel: '',
    credentialMode: 'per_member', ownerUserId: 4, allowsSharing: false,
    enabled: true, transport: 'stdio', command: 'node', args: [], url: null,
    keyEnvVar: 'DRIVE_KEY', keyHeader: null, keyHeaderPrefix: '', extraEnv: {},
    authMode: 'key', createdBy: 4, createdAt: '', updatedAt: '', sourceRevision: 2,
  };
  const response = await reconcile('drive-u4', { memberUserId: 999 }, 999);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'CONNECTOR_RECONCILER_DISABLED');
  assert.equal(connectorGetCalls, 0);
  assert.deepEqual(reconcileCalls, []);
  assert.deepEqual(auditCalls, []);
});

test('manual reconcile uses session ownership, emits sanitized audit, and returns verified status', async () => {
  process.env.NASSAJ_CONNECTOR_RECONCILER_WRITE = '1';
  storedRow = {
    id: 'drive-u4', service: 'google-drive', displayName: 'Drive', accountLabel: '',
    credentialMode: 'per_member', ownerUserId: 4, allowsSharing: false,
    enabled: true, transport: 'stdio', command: 'node', args: [], url: null,
    keyEnvVar: 'DRIVE_KEY', keyHeader: null, keyHeaderPrefix: '', extraEnv: {},
    authMode: 'key', createdBy: 4, createdAt: '', updatedAt: '', sourceRevision: 2,
  };
  secrets.setNamespacedSecret(4, 'connector', 'drive-u4', 'sentinel-secret-value');
  try {
    const response = await reconcile('drive-u4', { memberUserId: 999 }, 4);
    assert.equal(response.status, 200);
    assert.deepEqual(reconcileCalls, [{ connectorId: 'drive-u4', memberUserId: 4 }]);
    assert.deepEqual(auditCalls, [{
      action: 'connector_reconcile_requested',
      options: { userId: 4, metadata: { connectorId: 'drive-u4' } },
    }]);
    const rendered = JSON.stringify(response.body);
    assert.equal((response.body.connector as { retryAvailable?: boolean }).retryAvailable, false);
    assert.equal(rendered.includes('fingerprint'), false);
    assert.equal(rendered.includes('sentinel-secret-value'), false);
    assert.equal(rendered.includes('/private/grant'), false);
    assert.equal(rendered.includes('memberUserId\":999'), false);
  } finally {
    secrets.deleteNamespacedSecret(4, 'connector', 'drive-u4');
  }
});

test('verified writer still returns 207 when the fresh status is not an exact healthy pair', async () => {
  process.env.NASSAJ_CONNECTOR_RECONCILER_WRITE = '1';
  publishHealthyPlacements = false;
  storedRow = {
    ...storedRow,
    id: 'race-u4', service: 'race', displayName: 'Race', accountLabel: '',
    credentialMode: 'per_member', ownerUserId: 4, allowsSharing: false,
    enabled: true, transport: 'stdio', command: 'node', args: [], url: null,
    keyEnvVar: 'RACE_KEY', keyHeader: null, keyHeaderPrefix: '', extraEnv: {},
    authMode: 'key', createdBy: 4, createdAt: '', updatedAt: '', sourceRevision: 2,
  };
  placementRows = [{
    connectorId: 'race-u4', memberUserId: 4, bodyProvider: 'claude',
    contractVersion: 'mcp-user-v1', desiredGeneration: 1, appliedGeneration: 1,
    state: 'healthy', attemptCount: 0, nextRetryAt: null, lastErrorCode: null,
    desiredAppliedMatch: true,
  }];
  secrets.setNamespacedSecret(4, 'connector', 'race-u4', 'race-secret');
  try {
    const response = await reconcile('race-u4');
    assert.equal(response.status, 207);
    assert.equal((response.body.connector as { retryAvailable?: boolean }).retryAvailable, true);
  } finally {
    secrets.deleteNamespacedSecret(4, 'connector', 'race-u4');
  }
});

test('unknown reconcile failures are fixed 500 responses without path or material disclosure', async () => {
  process.env.NASSAJ_CONNECTOR_RECONCILER_WRITE = '1';
  reconcileError = new Error('/private/grant.json contained sentinel-secret-value');
  storedRow = {
    id: 'failure-u4', service: 'failure', displayName: 'Failure', accountLabel: '',
    credentialMode: 'per_member', ownerUserId: 4, allowsSharing: false,
    enabled: true, transport: 'stdio', command: 'node', args: [], url: null,
    keyEnvVar: 'FAILURE_KEY', keyHeader: null, keyHeaderPrefix: '', extraEnv: {},
    authMode: 'key', createdBy: 4, createdAt: '', updatedAt: '', sourceRevision: 2,
  };
  const response = await reconcile('failure-u4');
  assert.equal(response.status, 500);
  assert.equal(response.body.code, 'CONNECTOR_RECONCILE_FAILED');
  assert.equal(JSON.stringify(response.body).includes('/private/grant'), false);
  assert.equal(JSON.stringify(response.body).includes('sentinel-secret-value'), false);
});

test('audit failure returns a fixed 500 and never starts the writer', async () => {
  process.env.NASSAJ_CONNECTOR_RECONCILER_WRITE = '1';
  auditError = new Error('/private/audit-path sentinel-secret-value');
  storedRow = {
    id: 'audit-failure-u4', service: 'audit', displayName: 'Audit', accountLabel: '',
    credentialMode: 'per_member', ownerUserId: 4, allowsSharing: false,
    enabled: true, transport: 'stdio', command: 'node', args: [], url: null,
    keyEnvVar: 'AUDIT_KEY', keyHeader: null, keyHeaderPrefix: '', extraEnv: {},
    authMode: 'key', createdBy: 4, createdAt: '', updatedAt: '', sourceRevision: 2,
  };
  const response = await reconcile('audit-failure-u4');
  assert.equal(response.status, 500);
  assert.equal(response.body.code, 'CONNECTOR_RECONCILE_FAILED');
  assert.deepEqual(reconcileCalls, []);
  assert.equal(JSON.stringify(response.body).includes('/private'), false);
  assert.equal(JSON.stringify(response.body).includes('sentinel-secret-value'), false);
});

test('manual reconcile rate limit is keyed by session user and connector', async () => {
  process.env.NASSAJ_CONNECTOR_RECONCILER_WRITE = '1';
  storedRow = {
    id: 'limited-u4', service: 'limited', displayName: 'Limited', accountLabel: '',
    credentialMode: 'per_member', ownerUserId: 4, allowsSharing: false,
    enabled: true, transport: 'stdio', command: 'node', args: [], url: null,
    keyEnvVar: 'LIMITED_KEY', keyHeader: null, keyHeaderPrefix: '', extraEnv: {},
    authMode: 'key', createdBy: 4, createdAt: '', updatedAt: '', sourceRevision: 2,
  };
  let response: ApiResponse | null = null;
  for (let attempt = 0; attempt < 6; attempt += 1) response = await reconcile('limited-u4');
  assert.equal(response?.status, 429);
  assert.equal(response?.body.code, 'CONNECTOR_RECONCILE_RATE_LIMITED');
  assert.ok(Number(response?.retryAfter) > 0);

  storedRow = { ...storedRow, id: 'limited-other-u4' };
  const isolated = await reconcile('limited-other-u4');
  assert.equal(isolated.status, 207);
});

test('OAuth DELETE returns 202 pending, preserves the row, and never audits removed', async () => {
  const id = 'route-revoke-u4';
  storedRow = {
    id, service: 'notion', displayName: 'Notion', accountLabel: '',
    credentialMode: 'per_member', ownerUserId: 4, allowsSharing: false,
    enabled: true, transport: 'stdio', command: 'node', args: [], url: null,
    keyEnvVar: null, keyHeader: null, keyHeaderPrefix: '', extraEnv: {},
    authMode: 'oauth', createdBy: 4, createdAt: '', updatedAt: '', sourceRevision: 0,
  };
  const response = await remove(id);
  assert.equal(response.status, 202);
  assert.deepEqual(response.body, {
    removed: false, revocationPending: true, cleanupRequired: true,
  });
  assert.equal(storedRow?.enabled, false);
  assert.equal(auditCalls.some((call) => call.action === 'connector_removed'), false);
  fs.rmSync(path.join(process.env.HOME ?? '', '.nassaj-users', '4', '.mcp-auth', id), {
    recursive: true, force: true,
  });
});

test('OAuth DELETE returns explicit 503, never 202, when a revocation marker cannot persist', async () => {
  const id = 'route-marker-failure-u4';
  storedRow = {
    id, service: 'notion', displayName: 'Notion', accountLabel: '',
    credentialMode: 'per_member', ownerUserId: 4, allowsSharing: false,
    enabled: true, transport: 'stdio', command: 'node', args: [], url: null,
    keyEnvVar: null, keyHeader: null, keyHeaderPrefix: '', extraEnv: {},
    authMode: 'oauth', createdBy: 4, createdAt: '', updatedAt: '', sourceRevision: 0,
  };
  const originalMkdir = fs.mkdirSync;
  const mkdirMock = mock.method(fs, 'mkdirSync', ((target: fs.PathLike, ...args: unknown[]) => {
    if (String(target).includes(id)) {
      const error = new Error('injected marker persistence failure') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    }
    return Reflect.apply(originalMkdir, fs, [target, ...args]);
  }) as typeof fs.mkdirSync);
  try {
    const response = await remove(id);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'CONNECTOR_OAUTH_REVOCATION_MARKER_FAILED');
    assert.notEqual(response.status, 202);
    assert.equal(response.body.revocationPending, undefined);
    assert.equal(storedRow?.enabled, false, 'DB containment remains fail-closed');
    assert.equal(auditCalls.some((call) => call.action === 'connector_removed'), false);
  } finally {
    mkdirMock.mock.restore();
  }
});

/**
 * The headline of B-542, in the exact body that was posted live. Whether it is
 * refused for naming an unknown platform or for carrying packaging matters less
 * than the fact that NOTHING reaches the table — the row is where the damage
 * would live.
 */
test('the proved payload is refused and nothing reaches the table', async () => {
  const response = await post({
    service: 'sec-probe',
    command: '/bin/echo',
    args: ['{{NASSAJ_MCP_SERVERS}}/probe.js'],
    keyEnvVar: 'JWT_SECRET',
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'CONNECTOR_UNKNOWN_FIELD');
  assert.deepEqual(createCalls, [], 'no row was written');
});

/**
 * The same fields against a platform that DOES exist — the harder case, because
 * here the request would otherwise have succeeded and merely carried the
 * caller's packaging into a legitimate row.
 */
test('packaging fields are refused even for a catalog platform', async () => {
  for (const field of [
    { command: '/bin/echo' },
    { args: ['/etc/shadow'] },
    { keyEnvVar: 'JWT_SECRET' },
    { transport: 'http' },
    { url: 'https://attacker.example' },
    { keyHeader: 'Authorization' },
    { authMode: 'key' },
    { allowsSharing: true },
    { displayName: 'Anything' },
    { id: 'chosen-by-the-caller' },
  ]) {
    const response = await post({ service: 'figma', ...field });
    assert.equal(response.status, 400, `${Object.keys(field)[0]} must be refused`);
    assert.equal(response.body.code, 'CONNECTOR_UNKNOWN_FIELD');
  }
  assert.deepEqual(createCalls, [], 'not one of them wrote a row');
});

test('a platform the catalog does not list is refused by name', async () => {
  const response = await post({ service: 'sec-probe' });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'CONNECTOR_UNKNOWN_SERVICE');
  assert.deepEqual(createCalls, []);
});

test('new org_shared creation is blocked for every role with a stable code and no row mutation', async () => {
  for (const role of ['user', 'admin', 'owner']) {
    const response = await post({ service: 'figma', credentialMode: 'org_shared' }, role);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'CONNECTOR_ORG_SHARED_CREATION_DISABLED');
  }
  assert.deepEqual(createCalls, []);
  assert.equal(storedRow, null);
});

/**
 * The other half of the guarantee: what a client MAY send still works, and every
 * value the row receives comes from the catalog rather than from the request.
 */
test('a catalog platform is created with the catalog\'s own packaging', async () => {
  const response = await post({ service: 'figma' });

  assert.equal(response.status, 201);
  assert.equal(createCalls.length, 1);
  const row = createCalls[0];
  assert.equal(row.service, 'figma');
  assert.equal(row.command, 'npx');
  assert.deepEqual(row.args, ['-y', 'figma-developer-mcp', '--stdio']);
  assert.equal(row.keyEnvVar, 'FIGMA_API_KEY');
  assert.equal(row.displayName, 'Figma');
  assert.equal(row.credentialMode, 'per_member');
  assert.equal(row.ownerUserId, 4, 'ownership is the token holder, never the body');
  assert.equal(row.id, 'figma-u4');
});

test('catalog v2 recursively exposes only the public DTO and public additional field ids', async () => {
  const response = await getCatalog();
  assert.equal(response.status, 200);
  assert.equal(response.body.schemaVersion, 2);
  const catalog = response.body.catalog as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(catalog));
  const forbiddenKeys = new Set([
    'command', 'args', 'transport', 'url', 'oauthClient', 'oauthSetup', 'redirectUri',
    'registerAppUrl', 'envVars', 'envVar', 'clientEnvPrefix', 'authorizeUrl', 'tokenUrl',
  ]);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      assert.equal(forbiddenKeys.has(key), false, `forbidden catalog key: ${key}`);
      walk(nested);
    }
  };
  walk(response.body);
  const rendered = JSON.stringify(response.body);
  for (const forbiddenValue of [
    'SLACK_TEAM_ID', 'GEIDEA_PUBLIC_KEY', 'NASSAJ_OAUTH_GOOGLE',
    '/connectors/oauth/callback', 'oauth2.googleapis.com/token', '{{NASSAJ_MCP_SERVERS}}',
  ]) assert.equal(rendered.includes(forbiddenValue), false, forbiddenValue);
  const slack = catalog.find((entry) => entry.service === 'slack');
  assert.deepEqual(slack?.additionalFields, [{
    id: 'workspaceId', label: 'Workspace ID', hint: 'T01234567',
  }]);
  for (const entry of catalog.filter((item) => item.authMode === 'oauth')) {
    assert.ok(['ready', 'server_not_configured'].includes(String(entry.oauthAvailability)));
  }
  for (const trusted of CONNECTOR_CATALOG) {
    const ids = (trusted.extraEnv ?? []).map((field) => field.id);
    assert.equal(ids.every((id) => /^[a-z][A-Za-z0-9]*$/.test(id)), true, trusted.service);
    assert.equal(new Set(ids).size, ids.length, `${trusted.service} additional field ids`);
    const publicEntry = catalog.find((entry) => entry.service === trusted.service);
    assert.deepEqual(
      (publicEntry?.additionalFields as Array<{ id: string }> | undefined)?.map((field) => field.id) ?? [],
      ids,
    );
  }
});

test('auth profile API is flag-closed and cannot be enabled lazily after router boot', async () => {
  const disabled = await getAuthProfiles('owner');
  assert.equal(disabled.status, 404);
  assert.equal(disabled.body.code, 'CONNECTOR_AUTH_REGISTRY_DISABLED');

  process.env.NASSAJ_CONNECTOR_AUTH_REGISTRY_V1 = '1';
  const admin = await getAuthProfiles('admin');
  assert.equal(admin.status, 503);
  assert.equal(admin.body.code, 'CONNECTOR_AUTH_BOOTSTRAP_UNAVAILABLE');

  const owner = await getAuthProfiles('owner');
  assert.equal(owner.status, 503);
  assert.equal(owner.body.code, 'CONNECTOR_AUTH_BOOTSTRAP_UNAVAILABLE');
});

test('legacy OAuth start rejects missing public origin before row access or provider I/O', async () => {
  const configuredOrigin = process.env.NASSAJ_PUBLIC_ORIGIN;
  delete process.env.NASSAJ_PUBLIC_ORIGIN;
  try {
    const first = await startOAuth(
      { service: 'notion' },
      { 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https' },
    );
    assert.equal(first.status, 503);
    assert.deepEqual(first.body, {
      error: 'Connector authentication is unavailable.',
      code: 'CONNECTOR_AUTH_BOOTSTRAP_UNAVAILABLE',
    });
    assert.deepEqual(createCalls, []);
    assert.equal(connectorGetCalls, 0);

    const created = await post({ service: 'notion' });
    assert.equal(created.status, 201);
    connectorGetCalls = 0;
    const existing = await restartOAuth(String(created.body.connector?.id), {
      'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https',
    });
    assert.equal(existing.status, 503);
    assert.equal(existing.body.code, 'CONNECTOR_AUTH_BOOTSTRAP_UNAVAILABLE');
    assert.equal(connectorGetCalls, 0, 'preflight runs before connector lookup or row claim');
  } finally {
    if (configuredOrigin === undefined) delete process.env.NASSAJ_PUBLIC_ORIGIN;
    else process.env.NASSAJ_PUBLIC_ORIGIN = configuredOrigin;
  }
});

test('additionalFields maps public ids to catalog-owned environment names', async () => {
  const response = await post({
    service: 'slack',
    additionalFields: { workspaceId: 'T76543210' },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(createCalls.at(-1)?.extraEnv, { SLACK_TEAM_ID: 'T76543210' });
  const id = String(response.body.connector?.id);
  const updated = await patch(id, { additionalFields: { workspaceId: 'T00000001' } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.connector?.extraEnv, { SLACK_TEAM_ID: 'T00000001' });

  const patchRefused = await patch(id, { additionalFields: { processPath: '/private' } });
  assert.equal(patchRefused.status, 400);
  assert.equal(patchRefused.body.code, 'CONNECTOR_BAD_ADDITIONAL_FIELDS');

  const refused = await post({
    service: 'slack',
    additionalFields: { SLACK_TEAM_ID: 'T76543210' },
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'CONNECTOR_BAD_ADDITIONAL_FIELDS');
});

test('first legacy OAuth start is DB-origin-only and creates zero rows', async () => {
  const oldId = process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_ID;
  const oldSecret = process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_SECRET;
  delete process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_ID;
  delete process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_SECRET;
  try {
    const response = await startOAuth({ service: 'google-calendar' });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      error: 'Connector authentication is unavailable.',
      code: 'CONNECTOR_AUTH_BOOTSTRAP_UNAVAILABLE',
    });
    assert.deepEqual(createCalls, []);
    const rendered = JSON.stringify(response.body);
    assert.equal(rendered.includes('CLIENT_ID'), false);
    assert.equal(rendered.includes('callback'), false);
    assert.equal(rendered.includes('console.cloud.google.com'), false);
    process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_ID = 'id-without-secret';
    const catalog = await getCatalog();
    const googleDrive = (catalog.body.catalog as Array<Record<string, unknown>>)
      .find((entry) => entry.service === 'google-drive');
    assert.equal(googleDrive?.oauthAvailability, 'server_not_configured');
    const missingSecret = await startOAuth({ service: 'google-drive' });
    assert.equal(missingSecret.status, 503);
    assert.equal(missingSecret.body.code, 'CONNECTOR_AUTH_BOOTSTRAP_UNAVAILABLE');
    assert.deepEqual(createCalls, [], 'client id alone is never ready');
  } finally {
    if (oldId === undefined) delete process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_ID;
    else process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_ID = oldId;
    if (oldSecret === undefined) delete process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_SECRET;
    else process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_SECRET = oldSecret;
  }
});

test('legacy OAuth shortcut and retry cannot bypass the DB-origin V2 flow', async () => {
  const injected = await startOAuth({ service: 'notion', credentialMode: 'org_shared' });
  assert.equal(injected.status, 503);
  assert.equal(injected.body.code, 'CONNECTOR_AUTH_BOOTSTRAP_UNAVAILABLE');
  assert.deepEqual(createCalls, []);

  const created = await post({ service: 'google-calendar' });
  assert.equal(created.status, 201);
  const id = String(created.body.connector?.id);
  const before = createCalls.length;
  const oldGoogleClient = process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_ID;
  const oldGoogleSecret = process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_SECRET;
  process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_ID = 'test-client';
  process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_SECRET = 'test-secret';
  const duplicate = await startOAuth({ service: 'google-calendar' }).finally(() => {
    if (oldGoogleClient === undefined) delete process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_ID;
    else process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_ID = oldGoogleClient;
    if (oldGoogleSecret === undefined) delete process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_SECRET;
    else process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_SECRET = oldGoogleSecret;
  });
  assert.equal(duplicate.status, 503);
  assert.equal(duplicate.body.code, 'CONNECTOR_AUTH_BOOTSTRAP_UNAVAILABLE');
  assert.equal(createCalls.length, before, 'duplicate never creates a second row');

  // The existing-row endpoint remains the retry path and reports missing app
  // setup without exposing operator configuration details.
  const retry = await restartOAuth(id);
  assert.equal(retry.status, 503);
  assert.deepEqual(retry.body, {
    error: 'Connector authentication is unavailable.',
    code: 'CONNECTOR_AUTH_BOOTSTRAP_UNAVAILABLE',
  });
});

test('legacy first-account discovery performs no provider I/O without DB origin', async () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(baseUrl)) return originalFetch(input, init);
    throw new Error('/private/oauth sentinel-provider-detail');
  }) as typeof fetch);
  try {
    const response = await startOAuth({ service: 'notion' });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      error: 'Connector authentication is unavailable.',
      code: 'CONNECTOR_AUTH_BOOTSTRAP_UNAVAILABLE',
    });
    assert.equal(storedRow, null);
    const rendered = JSON.stringify(response.body);
    assert.equal(rendered.includes('/private'), false);
    assert.equal(rendered.includes('sentinel'), false);
  } finally {
    fetchMock.mock.restore();
  }
});

test('legacy double tap remains inert without DB origin', async () => {
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  const fetchMock = mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(baseUrl)) return originalFetch(input, init);
    externalCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (url.endsWith('/.well-known/oauth-protected-resource')) {
      return new Response(JSON.stringify({ authorization_servers: ['https://auth.example'] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === 'https://auth.example/.well-known/oauth-authorization-server') {
      return new Response(JSON.stringify({
        authorization_endpoint: 'https://auth.example/authorize',
        token_endpoint: 'https://auth.example/token',
        registration_endpoint: 'https://auth.example/register',
        scopes_supported: ['read'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === 'https://auth.example/register') {
      return new Response(JSON.stringify({ client_id: 'public-client' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected external test URL: ${url}`);
  }) as typeof fetch);
  try {
    const [first, second] = await Promise.all([
      startOAuth({ service: 'notion', accountLabel: ' Work ' }),
      startOAuth({ service: 'NOTION', accountLabel: 'Work' }),
    ]);
    assert.equal(first.status, 503);
    assert.equal(second.status, 503);
    assert.equal(createCalls.length, 0);
    assert.equal(externalCalls, 0);
    assert.equal(storedRow, null);
  } finally {
    fetchMock.mock.restore();
  }
});

test('legacy existing-row starts remain inert without DB origin', async () => {
  const created = await post({ service: 'notion' });
  const id = String(created.body.connector?.id);
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  const fetchMock = mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(baseUrl)) return originalFetch(input, init);
    externalCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    if (url.endsWith('/.well-known/oauth-protected-resource')) {
      return new Response(JSON.stringify({ authorization_servers: ['https://claim.example'] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return new Response(JSON.stringify({
        authorization_endpoint: 'https://claim.example/authorize',
        token_endpoint: 'https://claim.example/token',
        registration_endpoint: 'https://claim.example/register',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ client_id: 'claim-client' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch);
  try {
    const [one, two] = await Promise.all([restartOAuth(id), restartOAuth(id)]);
    assert.deepEqual([one.status, two.status], [503, 503]);
    assert.equal(externalCalls, 0);
    assert.equal(storedRow?.sourceRevision, 0);
  } finally {
    fetchMock.mock.restore();
  }
});

test('legacy first-account and existing-row race remains inert without DB origin', async () => {
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  const fetchMock = mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(baseUrl)) return originalFetch(input, init);
    externalCalls += 1;
    throw new Error('legacy provider I/O must remain unreachable');
  }) as typeof fetch);
  try {
    const [first, existing] = await Promise.all([
      startOAuth({ service: 'atlassian', accountLabel: 'race' }), restartOAuth('missing-row'),
    ]);
    assert.deepEqual([first.status, existing.status], [503, 503]);
    assert.equal(storedRow, null);
    assert.deepEqual(pendingStateCalls, { put: 0, consume: 0, count: 0, sweep: 0 });
    assert.equal(externalCalls, 0);
  } finally {
    fetchMock.mock.restore();
  }
});

test('legacy OAuth start fails at DB-origin preflight before rate or external I/O', async () => {
  const originalFetch = globalThis.fetch;
  let externalCalls = 0;
  const fetchMock = mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(baseUrl)) return originalFetch(input, init);
    externalCalls += 1;
    throw new Error('offline');
  }) as typeof fetch);
  try {
    let response: ApiResponse | null = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      response = await startOAuth({ service: 'linear', accountLabel: `rate-${attempt}` });
    }
    assert.equal(response?.status, 503);
    assert.equal(response?.body.code, 'CONNECTOR_AUTH_BOOTSTRAP_UNAVAILABLE');
    assert.equal(response?.retryAfter, null);
    assert.equal(externalCalls, 0);
  } finally {
    fetchMock.mock.restore();
  }
});

/** Extras are the one configuration a client may send, so their shape is checked. */
test('extraEnv must be environment variable names with string values', async () => {
  for (const extraEnv of [
    { 'not a var name': 'x' },
    { SLACK_TEAM_ID: 42 },
    { 'PATH=/evil': 'x' },
    ['SLACK_TEAM_ID'],
  ]) {
    const response = await post({ service: 'slack', extraEnv });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'CONNECTOR_BAD_EXTRA_ENV');
  }

  const ok = await post({ service: 'slack', extraEnv: { SLACK_TEAM_ID: 'T01234567' } });
  assert.equal(ok.status, 201);
  assert.deepEqual(createCalls.at(-1)?.extraEnv, { SLACK_TEAM_ID: 'T01234567' });
});

test('extraEnv accepts only names declared by that catalog service on POST and PATCH', async () => {
  for (const payload of [
    { NODE_OPTIONS: '--import=/tmp/probe.js' },
    { PATH: '/attacker' },
    { GEIDEA_PUBLIC_KEY: 'wrong-service' },
  ]) {
    const response = await post({ service: 'slack', extraEnv: payload });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'CONNECTOR_BAD_EXTRA_ENV');
  }
  assert.deepEqual(createCalls, []);

  const created = await post({ service: 'slack', extraEnv: { SLACK_TEAM_ID: 'T01234567' } });
  assert.equal(created.status, 201);
  const id = String(created.body.connector?.id);

  const injected = await patch(id, { extraEnv: { NODE_OPTIONS: '--require=/tmp/probe.js' } });
  assert.equal(injected.status, 400);
  assert.equal(injected.body.code, 'CONNECTOR_BAD_EXTRA_ENV');

  const updated = await patch(id, { extraEnv: { SLACK_TEAM_ID: 'T76543210' } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.connector?.extraEnv, { SLACK_TEAM_ID: 'T76543210' });
});

test('owner/account identity fields are refused rather than accepted or ignored', async () => {
  for (const field of [
    { ownerUserId: 99 },
    { createdBy: 99 },
    { accountId: 'victim' },
  ]) {
    const response = await post({ service: 'slack', ...field });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'CONNECTOR_UNKNOWN_FIELD');
  }

  const created = await post({ service: 'slack' });
  const id = String(created.body.connector?.id);
  const changed = await patch(id, { ownerUserId: 99 });
  assert.equal(changed.status, 400);
  assert.equal(changed.body.code, 'CONNECTOR_UNKNOWN_FIELD');
});

test('a body that is not an object, or names no platform, is refused', async () => {
  assert.equal((await post([{ service: 'figma' }])).body.code, 'CONNECTOR_BAD_BODY');
  assert.equal((await post({})).body.code, 'CONNECTOR_BAD_SERVICE');
  assert.equal((await post({ service: '   ' })).body.code, 'CONNECTOR_BAD_SERVICE');
  assert.equal((await post({ service: 'figma', credentialMode: 'nonsense' })).body.code, 'CONNECTOR_BAD_MODE');
  assert.deepEqual(createCalls, []);
});

test('OAuth completion is green only for a non-empty, wholly successful distribution', () => {
  assert.equal(connectorRoutesModule.oauthDistributionReady([]), false);
  assert.equal(connectorRoutesModule.oauthDistributionReady([{ ok: true }, { ok: false }]), false);
  assert.equal(connectorRoutesModule.oauthDistributionReady([{ ok: true }, { ok: true }]), true);
});

test('legacy OAuth services are managed from catalog truth, including Atlassian evidence endpoint', () => {
  for (const service of ['notion', 'sentry', 'linear', 'atlassian']) {
    assert.equal(connectorRoutesModule.catalogUsesManagedOAuthBridge(service), true, service);
    assert.equal(catalogEntryFor(service)?.args?.includes('mcp-remote'), false, service);
  }
  assert.ok(
    catalogEntryFor('atlassian')?.args?.includes('https://mcp.atlassian.com/v1/mcp/authv2'),
  );
});

test('OAuth callback never reflects provider errors, scripts, or quotes into HTML', async () => {
  const payload = `<script>globalThis.pwned=true</script>"'&provider_detail`;
  const response = await fetch(
    `${baseUrl}/connectors/oauth/callback?error=${encodeURIComponent(payload)}&error_description=${encodeURIComponent(payload)}`,
    { headers: { 'Accept-Language': 'en' } },
  );
  const html = await response.text();

  assert.equal(response.status, 400);
  assert.equal(html.includes(payload), false);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('provider_detail'), false);
  assert.match(html, /platform did not approve the link/i);
});

test('OAuth success copy promises next-session configuration, not untested live health', () => {
  const en = connectorRoutesModule.oauthCallbackSuccessMessage('en');
  const ar = connectorRoutesModule.oauthCallbackSuccessMessage('ar');

  assert.match(en, /new sessions/i);
  assert.match(en, /next session/i);
  assert.match(en, /has not been tested/i);
  assert.doesNotMatch(en, /available .* now/i);
  assert.match(ar, /للجلسات الجديدة/);
  assert.match(ar, /جلستك التالية/);
  assert.match(ar, /لم يُختبر وصول المنصّة/);
  assert.doesNotMatch(ar, /متاحة في جلساتك/);
});

test('OAuth relink retries a contained disabled row once through setEnabled', async () => {
  let enabled = true;
  let directDistributions = 0;
  let enableRetries = 0;
  const service = {
    get: () => ({ enabled }),
    distribute: async () => {
      directDistributions += 1;
      // Mirrors service containment after the first partial placement.
      enabled = false;
      return [{ ok: false }];
    },
    setEnabled: async (_id: string, next: boolean) => {
      assert.equal(next, true);
      enableRetries += 1;
      // setEnabled owns the retry distribution and returns only after it passed.
      enabled = true;
      return { enabled: true };
    },
  };

  assert.equal(
    await connectorRoutesModule.ensureOAuthConnectorDistributed('google-u4', 4, service as never),
    false,
  );
  assert.equal(enabled, false);

  assert.equal(
    await connectorRoutesModule.ensureOAuthConnectorDistributed('google-u4', 4, service as never),
    true,
  );
  assert.equal(enableRetries, 1, 'the contained row is explicitly re-armed once');
  assert.equal(directDistributions, 1, 'callback does not distribute again after setEnabled');
});
