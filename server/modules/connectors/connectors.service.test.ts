import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { AppError } from '@/shared/utils.js';

import { catalogEntryFor } from '../../../shared/connector-catalog.js';

/**
 * Covers the one piece of connector logic that cannot be read off the types: WHO
 * gets written where. A connector must reach a per-user engine once PER MEMBER
 * and an operator-homed engine exactly ONCE — and the results must say which
 * happened, because a shared write reported as three per-member writes is how a
 * half-distributed connector looks fully distributed.
 */

const upsertCalls: Array<{
  provider: string;
  userId: unknown;
  name: string;
  args?: unknown;
  env?: unknown;
  headers?: unknown;
}> = [];
const removeCalls: Array<{ provider: string; userId: unknown; name: string }> = [];
let cleanupError: string | null = null;
let cleanupFailureUserId: number | null = null;
let cleanupUnverified = false;
let upsertFailureProvider: string | null = null;
let cleanupReturnsEmpty = false;
let targetsReturnEmpty = false;
let connectorRow: Record<string, unknown> | null = null;

// Preserve the real grant identity verifier for transitive OAuth imports.
const actualGrantService = await import('./connector-user-grant.service.js');
mock.module('@/modules/connectors/connector-user-grant.service.js', {
  namedExports: {
    ...actualGrantService,
    isAuthorizedConnectorGrantMaterialReference: () => true,
  },
});

mock.module('@/modules/connectors/connector-user-grant.production.js', {
  namedExports: {
    withProductionConnectorGrantCapability: async (
      _connectorId: string,
      userId: number,
      _serviceId: string,
      consume: (input: { reference: Record<string, unknown>; credential: Buffer | null }) => unknown,
    ) => {
      if (!connectorRow) return null;
      const secretStore = await import('@/services/isolation/provider-secrets-store.js');
      const scope = connectorRow.credentialMode === 'per_member'
        ? userId
        : secretStore.SYSTEM_SECRET_SCOPE;
      const stored = connectorRow.authMode === 'oauth'
        ? null
        : secretStore.getNamespacedSecret(scope, 'connector', String(connectorRow.id));
      if (connectorRow.authMode === 'oauth') {
        const { grantFilePath } = await import('@/modules/connectors/connector-oauth-flow.js');
        const { hasOAuthTokens } = await import('@/modules/connectors/connector-oauth.js');
        const builtIn = catalogEntryFor(String(connectorRow.service))?.args?.some(value =>
          value.includes('{{NASSAJ_MCP_SERVERS}}'),
        ) ?? false;
        const ready = builtIn
          ? fs.statSync(grantFilePath(userId, String(connectorRow.id)), { throwIfNoEntry: false })?.isFile() ?? false
          : hasOAuthTokens(userId, String(connectorRow.id));
        if (!ready) return null;
      }
      if (connectorRow.authMode !== 'oauth' && stored === null) return null;
      const credential = stored === null ? null : Buffer.from(stored);
      try {
        return consume({
          reference: {
            kind: 'v2', ownership: 'personal', userId,
            serviceId: _serviceId, grantId: 'test', secretRef: 'test', provenance: 'test',
          },
          credential,
        });
      } finally { credential?.fill(0); }
    },
  },
});

mock.module('@/modules/providers/services/mcp.service.js', {
  namedExports: {
    providerMcpService: {
      listMcpTargets: () => targetsReturnEmpty
        ? []
        : [
            { provider: 'claude', writesPerUserConfig: true },
            { provider: 'codex', writesPerUserConfig: true },
          ],
      upsertProviderMcpServer: async (provider: string, input: Record<string, unknown>) => {
        if (provider === upsertFailureProvider) throw new Error('writer unavailable');
        upsertCalls.push({
          provider,
          userId: input.userId,
          name: input.name as string,
          args: input.args,
          env: input.env,
          headers: input.headers,
        });
        return {};
      },
      removeMcpServerFromAllProviders: async (input: Record<string, unknown>) => {
        removeCalls.push({
          provider: 'all',
          userId: input.userId,
          name: input.name as string,
        });
        const cleanupFailsHere = cleanupError !== null && (
          cleanupFailureUserId === null || input.userId === cleanupFailureUserId
        );
        return cleanupReturnsEmpty
          ? []
          : cleanupUnverified
          ? [{ provider: 'cursor', removed: false, verified: false, state: 'unverified' }]
          : cleanupFailsHere
          ? [{ provider: 'codex', removed: false, verified: false, state: 'failed', error: cleanupError }]
            : [
              { provider: 'claude', removed: true, verified: true, state: 'removed' },
              { provider: 'codex', removed: false, verified: true, state: 'absent' },
              { provider: 'opencode', removed: false, verified: true, state: 'absent' },
            ];
      },
    },
  },
});

mock.module('@/modules/database/repositories/users.js', {
  namedExports: {
    userDb: { listUsers: () => [{ id: 1 }, { id: 2 }] },
  },
});

let placementRows: Array<Record<string, unknown>> = [];
mock.module('@/modules/database/repositories/connector-placements.db.js', {
  namedExports: {
    connectorPlacementsDb: { listPublicStatuses: () => placementRows },
    createConnectorPlacementsDb: () => ({ listPublicStatuses: () => placementRows }),
  },
});

/**
 * Rows the mocked table currently holds, so the DUPLICATE paths can be
 * exercised. Cleared per test by `sandbox()`.
 *
 * The two refusals below reproduce SQLite's own sentences verbatim — the primary
 * key on `id`, and the partial index on (service, account_label, owner_user_id).
 * They are copied from a real database rather than invented:
 * connectors.db.integration.test.ts asserts those exact strings against the real
 * migration, so a future SQLite that words them differently fails there instead
 * of quietly making this file's classification test meaningless.
 */
const storedRows = new Map<string, Record<string, unknown>>();

mock.module('@/modules/database/repositories/connectors.db.js', {
  namedExports: {
    connectorsDb: {
      get: () => connectorRow,
      list: () => (connectorRow ? [connectorRow] : []),
      listEnabled: () => (connectorRow && connectorRow.enabled ? [connectorRow] : []),
      listVisibleTo: () => (connectorRow ? [connectorRow] : []),
      listEnabledForUser: (userId: number) =>
        connectorRow &&
        connectorRow.enabled &&
        (connectorRow.credentialMode === 'org_shared' || connectorRow.ownerUserId === userId)
          ? [connectorRow]
          : [],
      create: (row: Record<string, unknown>) => {
        const id = String(row.id);
        const clashesOnPlatform = [...storedRows.values()].some(
          (held) =>
            held.credentialMode === row.credentialMode &&
            held.service === row.service &&
            (held.accountLabel ?? '') === (row.accountLabel ?? '') &&
            (row.credentialMode !== 'per_member' || held.ownerUserId === row.ownerUserId),
        );
        // Index before primary key, in that order, because that is the order the
        // real engine answers in — measured: a personal duplicate reports the
        // index even when the id collides too.
        if (clashesOnPlatform) {
          throw new Error(
            row.credentialMode === 'per_member'
              ? 'UNIQUE constraint failed: connectors.service, connectors.account_label, connectors.owner_user_id'
              : 'UNIQUE constraint failed: connectors.service, connectors.account_label',
          );
        }
        if (storedRows.has(id)) {
          throw new Error('UNIQUE constraint failed: connectors.id');
        }
        connectorRow = { ...stdioConnector(), ...row };
        storedRows.set(id, connectorRow);
        return connectorRow;
      },
      beginSourceMutation: (_id: string, expected?: number) => {
        if (!connectorRow) return null;
        const revision = Number(connectorRow.sourceRevision);
        if (revision % 2 !== 0 || (expected !== undefined && revision !== expected)) return null;
        connectorRow.sourceRevision = revision + 1;
        return revision + 1;
      },
      finishSourceMutation: (_id: string, odd: number) => {
        if (!connectorRow || connectorRow.sourceRevision !== odd || odd % 2 !== 1) return null;
        connectorRow.sourceRevision = odd + 1;
        return odd + 1;
      },
      setEnabled: (_id: string, enabled: boolean) => {
        if (connectorRow) connectorRow.enabled = enabled;
        return true;
      },
      setCredentialMode: (_id: string, mode: string, ownerUserId?: number | null) => {
        if (connectorRow) {
          connectorRow.credentialMode = mode;
          connectorRow.ownerUserId = mode === 'org_shared' ? null : (ownerUserId ?? connectorRow.ownerUserId);
        }
        return true;
      },
      setExtraEnv: (_id: string, extraEnv: Record<string, string>) => {
        if (connectorRow) connectorRow.extraEnv = extraEnv;
        return true;
      },
      remove: (id: string) => {
        storedRows.delete(String(id));
        if (connectorRow?.id === id) connectorRow = null;
        return true;
      },
    },
  },
});

const { connectorsService } = await import('@/modules/connectors/connectors.service.js');
const secrets = await import('@/services/isolation/provider-secrets-store.js');

function sandbox(): () => void {
  storedRows.clear();
  removeCalls.length = 0;
  cleanupError = null;
  cleanupFailureUserId = null;
  cleanupUnverified = false;
  upsertFailureProvider = null;
  cleanupReturnsEmpty = false;
  targetsReturnEmpty = false;
  placementRows = [];
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'connectors-svc-'));
  const originalHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => homeDir;
  const originalKey = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  const originalReconcilerFlag = process.env.NASSAJ_CONNECTOR_RECONCILER_WRITE;
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  secrets._resetProviderSecretsServerKeyCache();

  return () => {
    (os as unknown as { homedir: () => string }).homedir = originalHomedir;
    if (originalKey === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
    else process.env.NASSAJ_PROVIDER_SECRETS_KEY = originalKey;
    if (originalReconcilerFlag === undefined) delete process.env.NASSAJ_CONNECTOR_RECONCILER_WRITE;
    else process.env.NASSAJ_CONNECTOR_RECONCILER_WRITE = originalReconcilerFlag;
    secrets._resetProviderSecretsServerKeyCache();
    fs.rmSync(homeDir, { recursive: true, force: true });
  };
}

function stdioConnector(overrides: Record<string, unknown> = {}) {
  return {
    id: 'canva',
    service: 'canva',
    displayName: 'Canva',
    accountLabel: '',
    credentialMode: 'org_shared',
    ownerUserId: null,
    allowsSharing: true,
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'canva-mcp'],
    url: null,
    keyEnvVar: 'CANVA_API_KEY',
    keyHeader: null,
    keyHeaderPrefix: '',
    createdBy: null,
    createdAt: '',
    updatedAt: '',
    sourceRevision: 0,
    ...overrides,
  };
}

test('only proven connector targets are written once per member', async () => {
  const restore = sandbox();
  upsertCalls.length = 0;
  connectorRow = stdioConnector();
  try {
    secrets.setNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'canva', 'sk-live');
    const results = await connectorsService.distribute('canva');

    assert.equal(upsertCalls.length, 4, 'two members × two proven per-user engines');
    assert.deepEqual(
      upsertCalls.map((c) => `${c.provider}:${c.userId}`).sort(),
      ['claude:1', 'claude:2', 'codex:1', 'codex:2'],
    );
    assert.equal(results.filter((r) => r.ok).length, 4);
    assert.equal(results.filter((r) => r.userId === null).length, 0);
  } finally {
    restore();
  }
});

test('armed store-only policy degrades an unpinned catalog connector without npx fallback', async () => {
  const restore = sandbox();
  const originalFlag = process.env.NASSAJ_CONNECTOR_STORE_ONLY;
  upsertCalls.length = 0;
  connectorRow = stdioConnector({
    id: 'figma-u1',
    service: 'figma',
    credentialMode: 'per_member',
    ownerUserId: 1,
    args: ['-y', 'figma-developer-mcp'],
    keyEnvVar: 'FIGMA_API_KEY',
  });
  process.env.NASSAJ_CONNECTOR_STORE_ONLY = '1';
  try {
    secrets.setNamespacedSecret(1, 'connector', 'figma-u1', 'sk-live');
    const results = await connectorsService.distribute('figma-u1');
    assert.equal(upsertCalls.length, 0, 'no provider receives npx or a latest fallback');
    assert.deepEqual(results.map((result) => result.error), ['CONNECTOR_PACKAGE_PIN_MISSING']);
    assert.equal(connectorRow.enabled, false, 'policy failure is visibly degraded/disabled');
  } finally {
    if (originalFlag === undefined) delete process.env.NASSAJ_CONNECTOR_STORE_ONLY;
    else process.env.NASSAJ_CONNECTOR_STORE_ONLY = originalFlag;
    restore();
  }
});

test('store filesystem races compensate placements and disable without any upsert', async () => {
  const restore = sandbox();
  const figma = catalogEntryFor('figma')!;
  const originalPin = figma.npmPackage;
  const originalArgs = figma.args;
  const originalFlag = process.env.NASSAJ_CONNECTOR_STORE_ONLY;
  const originalStore = process.env.NASSAJ_CONNECTOR_SERVERS_DIR;
  const originalLstat = fs.lstatSync;
  figma.npmPackage = {
    name: 'figma-developer-mcp',
    version: '1.2.3',
    integrity: 'sha512-YWJjZA==',
    bin: { name: 'figma-developer-mcp', path: 'dist/server.js' },
  };
  figma.args = ['-y', 'figma-developer-mcp@1.2.3', '--stdio'];
  process.env.NASSAJ_CONNECTOR_STORE_ONLY = '1';
  process.env.NASSAJ_CONNECTOR_SERVERS_DIR = '/var/tmp/nassaj-policy-race-store';
  connectorRow = stdioConnector({
    id: 'figma-u1', service: 'figma', credentialMode: 'per_member', ownerUserId: 1,
    args: figma.args, keyEnvVar: 'FIGMA_API_KEY',
  });
  secrets.setNamespacedSecret(1, 'connector', 'figma-u1', 'sk-live');

  try {
    for (const code of ['ENOENT', 'EACCES']) {
      connectorRow.enabled = true;
      upsertCalls.length = 0;
      removeCalls.length = 0;
      const lstatMock = mock.method(fs, 'lstatSync', ((target: fs.PathLike, ...args: unknown[]) => {
        if (String(target) === process.env.NASSAJ_CONNECTOR_SERVERS_DIR) {
          const error = new Error('injected filesystem race') as NodeJS.ErrnoException;
          error.code = code;
          throw error;
        }
        return Reflect.apply(originalLstat, fs, [target, ...args]);
      }) as typeof fs.lstatSync);
      try {
        const results = await connectorsService.distribute('figma-u1');
        assert.deepEqual(results.map((result) => result.error), ['CONNECTOR_PACKAGE_FS_ERROR']);
        assert.equal(upsertCalls.length, 0);
        assert.ok(removeCalls.length > 0, 'compensation cleanup is attempted');
        assert.equal(connectorRow.enabled, false);
      } finally {
        lstatMock.mock.restore();
      }
    }
  } finally {
    figma.npmPackage = originalPin;
    figma.args = originalArgs;
    if (originalFlag === undefined) delete process.env.NASSAJ_CONNECTOR_STORE_ONLY;
    else process.env.NASSAJ_CONNECTOR_STORE_ONLY = originalFlag;
    if (originalStore === undefined) delete process.env.NASSAJ_CONNECTOR_SERVERS_DIR;
    else process.env.NASSAJ_CONNECTOR_SERVERS_DIR = originalStore;
    restore();
  }
});

test('the stored key is injected into the payload under the connector env var', async () => {
  const restore = sandbox();
  upsertCalls.length = 0;
  connectorRow = stdioConnector();
  try {
    secrets.setNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'canva', 'sk-live');
    await connectorsService.distribute('canva');
    assert.deepEqual(upsertCalls[0].env, { CANVA_API_KEY: 'sk-live' });
    assert.equal(upsertCalls[0].name, 'nassaj-connector-canva');
  } finally {
    restore();
  }
});

/**
 * A connector with no key must register NOTHING. Writing it would install a
 * server that fails every call, which a member reads as "this tool is broken"
 * rather than "nobody has pasted the key yet".
 */
test('a connector without a stored key distributes nowhere', async () => {
  const restore = sandbox();
  upsertCalls.length = 0;
  connectorRow = stdioConnector();
  try {
    const results = await connectorsService.distribute('canva');
    assert.deepEqual(results, []);
    assert.equal(upsertCalls.length, 0);
  } finally {
    restore();
  }
});

test('a disabled connector distributes nowhere', async () => {
  const restore = sandbox();
  upsertCalls.length = 0;
  connectorRow = stdioConnector({ enabled: false });
  try {
    secrets.setNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'canva', 'sk-live');
    assert.deepEqual(await connectorsService.distribute('canva'), []);
    assert.equal(upsertCalls.length, 0);
  } finally {
    restore();
  }
});

/**
 * A new member must inherit every connector. Without this the fan-out is
 * one-time and everyone who joins later is silently missing every platform —
 * the failure shape that cost B-384.
 */
test('a newly provisioned member receives every enabled connector', async () => {
  const restore = sandbox();
  upsertCalls.length = 0;
  connectorRow = stdioConnector();
  try {
    secrets.setNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'canva', 'sk-live');
    const results = await connectorsService.distributeAllToUser(7);

    assert.equal(upsertCalls.length, 2, 'the two proven per-user engines only');
    assert.ok(upsertCalls.every((c) => c.userId === 7));
    assert.ok(
      !upsertCalls.some((c) => ['opencode', 'cursor'].includes(c.provider)),
      'unproven runtime targets are not advertised or written',
    );
    assert.equal(results.length, 2);
  } finally {
    restore();
  }
});

test('partial new-member distribution compensates every possible placement', async () => {
  const restore = sandbox();
  connectorRow = stdioConnector();
  try {
    secrets.setNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'canva', 'sk-live');
    upsertFailureProvider = 'codex';
    const results = await connectorsService.distributeAllToUser(7);
    assert.ok(results.some((result) => !result.ok));
    assert.equal(connectorsService.get('canva').enabled, false);
    assert.deepEqual(
      removeCalls.map((call) => call.userId).sort(),
      [1, 2],
      'compensation does not assume the writer failed before committing',
    );
  } finally {
    restore();
  }
});

test('an http connector carries the key in its header with the configured prefix', async () => {
  const restore = sandbox();
  upsertCalls.length = 0;
  connectorRow = stdioConnector({
    transport: 'http',
    command: null,
    url: 'https://mcp.example.com',
    keyEnvVar: null,
    keyHeader: 'Authorization',
    keyHeaderPrefix: 'Bearer ',
  });
  try {
    secrets.setNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'canva', 'sk-live');
    await connectorsService.distribute('canva');
    assert.equal(upsertCalls.length, 4, 'two members × two proven per-user engines');
    assert.deepEqual(upsertCalls[0].headers, { Authorization: 'Bearer sk-live' });
    assert.equal(upsertCalls[0].env, undefined, 'http payloads carry no env');
  } finally {
    restore();
  }
});

test('deletion proceeds only after every placement has a verified read-back', async () => {
  const restore = sandbox();
  removeCalls.length = 0;
  connectorRow = stdioConnector();
  try {
    secrets.setNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'canva', 'sk-live');
    assert.deepEqual(await connectorsService.remove('canva'), { removed: true });

    assert.deepEqual(
      removeCalls.map((c) => c.userId).sort(),
      [1, 2],
      'both members are swept',
    );
    assert.ok(removeCalls.every((c) => c.name === 'nassaj-connector-canva'));
    assert.equal(
      secrets.getNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'canva'),
      null,
      'the key is destroyed only after verified cleanup',
    );
    assert.equal(connectorRow, null);
  } finally {
    restore();
  }
});

test('legacy cleanup with no read-back proof blocks deletion as unverified', async () => {
  const restore = sandbox();
  connectorRow = stdioConnector();
  try {
    secrets.setNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'canva', 'sk-live');
    cleanupUnverified = true;
    await assert.rejects(
      () => connectorsService.remove('canva'),
      (error: unknown) => error instanceof AppError && error.code === 'CONNECTOR_CLEANUP_FAILED',
    );
    assert.equal(connectorsService.get('canva').configured, true);
    assert.equal(connectorsService.get('canva').enabled, false);
    assert.equal(connectorsService.get('canva').degraded, true);
    assert.equal(connectorsService.get('canva').availability, 'degraded');
  } finally {
    restore();
  }
});

test('cleanup failure keeps the connector row and credential for a safe retry', async () => {
  const restore = sandbox();
  connectorRow = stdioConnector();
  try {
    secrets.setNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'canva', 'sk-live');
    cleanupError = 'config is read-only';
    cleanupFailureUserId = 2;

    await assert.rejects(
      () => connectorsService.remove('canva'),
      (error: unknown) => error instanceof AppError && error.code === 'CONNECTOR_CLEANUP_FAILED',
    );
    assert.equal(connectorsService.get('canva').id, 'canva', 'the row remains addressable');
    assert.equal(connectorsService.get('canva').enabled, false, 'delete contains before cleanup');
    assert.equal(connectorsService.get('canva').degraded, true);
    assert.equal(connectorsService.get('canva').availableNextSession, false);
    assert.deepEqual(
      removeCalls.map((call) => call.userId),
      [1, 2],
      'the first member may be swept before the later failure, but the row stays contained',
    );
    assert.equal(
      secrets.getNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'canva'),
      'sk-live',
      'the credential is not destroyed before cleanup can be retried',
    );
  } finally {
    restore();
  }
});

test('distribution failure is surfaced instead of returning configured success', async () => {
  const restore = sandbox();
  connectorRow = stdioConnector();
  try {
    upsertFailureProvider = 'codex';
    await assert.rejects(
      () => connectorsService.setKey('canva', 'sk-live'),
      (error: unknown) => error instanceof AppError && error.code === 'CONNECTOR_DISTRIBUTION_FAILED',
    );
    const afterRefresh = connectorsService.get('canva');
    assert.equal(afterRefresh.enabled, false);
    assert.equal(afterRefresh.configured, true, 'configured means only that the credential exists');
    assert.equal(afterRefresh.degraded, true, 'the failed placement stays visibly degraded');
    assert.equal(afterRefresh.availableNextSession, false);
    assert.equal(afterRefresh.availability, 'degraded');
    assert.equal(afterRefresh.credentialSource, 'stored', 'the credential remains recoverable');
    assert.deepEqual(
      removeCalls.map((call) => call.userId).sort(),
      [1, 2],
      'partial fan-out compensates across every possible member placement',
    );

    upsertFailureProvider = null;
    const retried = await connectorsService.setKey('canva', 'sk-live');
    assert.equal(retried.configured, true, 'the pending card can retry by submitting the key again');
    assert.equal(connectorsService.get('canva').enabled, true);
    assert.equal(
      connectorsService.get('canva').availableNextSession,
      false,
      'credential storage alone is not reported healthy before both placements are verified',
    );
    assert.equal(
      connectorsService.get('canva').placementStatus,
      'paused',
      'legacy shared rows remain fail-closed until shared isolation is supported',
    );
  } finally {
    restore();
  }
});

test('status is green only for the exact current Claude/Codex pair and exposes no proof material', () => {
  const restore = sandbox();
  connectorRow = stdioConnector({ credentialMode: 'per_member', ownerUserId: 1 });
  try {
    secrets.setNamespacedSecret(1, 'connector', 'canva', 'status-secret');
    process.env.NASSAJ_CONNECTOR_RECONCILER_WRITE = '1';
    const target = (bodyProvider: 'claude' | 'codex') => ({
      connectorId: 'canva',
      memberUserId: 1,
      bodyProvider,
      contractVersion: 'mcp-user-v1',
      desiredGeneration: 3,
      appliedGeneration: 3,
      state: 'healthy',
      attemptCount: 0,
      nextRetryAt: null,
      lastErrorCode: null,
      desiredAppliedMatch: true,
    });
    placementRows = [target('claude'), target('codex')];
    const healthy = connectorsService.get('canva', 1);
    assert.equal(healthy.placementStatus, 'healthy');
    assert.equal(healthy.availableNextSession, true);
    assert.equal(healthy.retryAvailable, false);
    assert.equal(healthy.targets.every((item) => item.healthy), true);
    const rendered = JSON.stringify(healthy);
    assert.equal(rendered.includes('fingerprint'), false);
    assert.equal(rendered.includes('status-secret'), false);
    assert.equal(rendered.includes('sourceRevision'), false);

    placementRows = [target('claude')];
    const partial = connectorsService.get('canva', 1);
    assert.equal(partial.placementStatus, 'partial');
    assert.equal(partial.availableNextSession, false);
    assert.equal(partial.retryAvailable, true);

    placementRows = [
      { ...target('claude'), desiredAppliedMatch: false },
      { ...target('codex'), desiredAppliedMatch: false },
    ];
    const pending = connectorsService.get('canva', 1);
    assert.equal(pending.placementStatus, 'pending');
    assert.equal(pending.retryAvailable, true);

    placementRows = [
      { ...target('claude'), state: 'degraded', desiredAppliedMatch: false },
      { ...target('codex'), state: 'degraded', desiredAppliedMatch: false },
    ];
    assert.equal(connectorsService.get('canva', 1).retryAvailable, true);

    placementRows = [
      { ...target('claude'), state: 'blocked', desiredAppliedMatch: false },
      { ...target('codex'), state: 'blocked', desiredAppliedMatch: false },
    ];
    assert.equal(connectorsService.get('canva', 1).retryAvailable, false);

    placementRows = [];
    assert.equal(
      connectorsService.get('canva', 1).retryAvailable,
      true,
      'untracked has no recovery path other than manual reconciliation',
    );

    connectorRow = stdioConnector({ credentialMode: 'per_member', ownerUserId: 1, enabled: false });
    assert.equal(connectorsService.get('canva', 1).retryAvailable, false);

    connectorRow = stdioConnector({ credentialMode: 'org_shared', ownerUserId: null });
    assert.equal(connectorsService.get('canva', 1).retryAvailable, false);

    connectorRow = stdioConnector({ credentialMode: 'per_member', ownerUserId: 2 });
    assert.equal(connectorsService.get('canva', 1).retryAvailable, false);

    connectorRow = stdioConnector({ credentialMode: 'per_member', ownerUserId: 1 });
    secrets.deleteNamespacedSecret(1, 'connector', 'canva');
    assert.equal(connectorsService.get('canva', 1).retryAvailable, false);

    secrets.setNamespacedSecret(1, 'connector', 'canva', 'status-secret');
    placementRows = [target('claude')];
    delete process.env.NASSAJ_CONNECTOR_RECONCILER_WRITE;
    assert.equal(connectorsService.get('canva', 1).retryAvailable, false);
  } finally {
    restore();
  }
});

test('setKey write failure keeps durable old material and closes the source revision', async () => {
  const restore = sandbox();
  connectorRow = stdioConnector({ credentialMode: 'per_member', ownerUserId: 1 });
  try {
    secrets.setNamespacedSecret(1, 'connector', 'canva', 'old-key');
    const rename = mock.method(fs, 'renameSync', () => {
      throw new Error('injected atomic promotion failure');
    });
    try {
      await assert.rejects(
        () => connectorsService.setKey('canva', 'new-key'),
        /injected atomic promotion failure/,
      );
    } finally {
      rename.mock.restore();
    }
    assert.equal(connectorRow?.sourceRevision, 2);
    assert.equal(secrets.getNamespacedSecret(1, 'connector', 'canva'), 'old-key');
  } finally {
    restore();
  }
});

test('create-with-key promotion failure leaves its new row on an even revision', async () => {
  const restore = sandbox();
  connectorRow = null;
  try {
    const rename = mock.method(fs, 'renameSync', () => {
      throw new Error('injected create promotion failure');
    });
    try {
      await assert.rejects(
        () => connectorsService.create({
          service: 'canva', credentialMode: 'per_member', ownerUserId: 1,
          command: 'npx', apiKey: 'new-key',
        }),
        /injected create promotion failure/,
      );
    } finally {
      rename.mock.restore();
    }
    assert.equal(connectorRow?.sourceRevision, 2);
    assert.equal(secrets.getNamespacedSecret(1, 'connector', 'canva-u1'), null);
  } finally {
    restore();
  }
});

test('direct OAuth-style distribution failure is contained before refresh', async () => {
  const restore = sandbox();
  connectorRow = stdioConnector();
  try {
    secrets.setNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'canva', 'grant-value');
    upsertFailureProvider = 'codex';
    const results = await connectorsService.distribute('canva');
    assert.ok(results.some((result) => !result.ok));
    assert.equal(connectorsService.get('canva').enabled, false);
    assert.equal(connectorsService.get('canva').configured, true);
    assert.equal(connectorsService.get('canva').degraded, true);
    assert.equal(connectorsService.get('canva').credentialSource, 'stored');
  } finally {
    restore();
  }
});

test('an empty distribution is a contained failure, never vacuous success', async () => {
  const restore = sandbox();
  connectorRow = stdioConnector();
  try {
    targetsReturnEmpty = true;
    await assert.rejects(
      () => connectorsService.setKey('canva', 'sk-live'),
      (error: unknown) => error instanceof AppError && error.code === 'CONNECTOR_DISTRIBUTION_FAILED',
    );
    assert.equal(connectorsService.get('canva').configured, true);
    assert.equal(connectorsService.get('canva').availableNextSession, false);
    assert.equal(connectorsService.get('canva').credentialSource, 'stored');
  } finally {
    restore();
  }
});

test('create with partial distribution persists a disabled non-green retry state', async () => {
  const restore = sandbox();
  try {
    upsertFailureProvider = 'codex';
    await assert.rejects(
      () => connectorsService.create({
        service: 'stripe',
        credentialMode: 'per_member',
        ownerUserId: 1,
        apiKey: 'rk-live',
      }),
      (error: unknown) => error instanceof AppError && error.code === 'CONNECTOR_DISTRIBUTION_FAILED',
    );
    const retained = connectorsService.get('stripe');
    assert.equal(retained.enabled, false);
    assert.equal(retained.configured, true);
    assert.equal(retained.degraded, true);
    assert.equal(retained.credentialSource, 'stored');
  } finally {
    restore();
  }
});

test('disabling first is durable and a disabled row retries cleanup', async () => {
  const restore = sandbox();
  connectorRow = stdioConnector();
  try {
    secrets.setNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'canva', 'sk-live');
    cleanupError = 'config is read-only';
    await assert.rejects(
      () => connectorsService.setEnabled('canva', false),
      (error: unknown) => error instanceof AppError && error.code === 'CONNECTOR_CLEANUP_FAILED',
    );
    assert.equal(connectorRow?.enabled, false, 'containment happens before cleanup');
    const callsAfterFailure = removeCalls.length;

    cleanupError = null;
    const retried = await connectorsService.setEnabled('canva', false);
    assert.ok(removeCalls.length > callsAfterFailure, 'disabled is a cleanup retry, not a no-op');
    assert.equal(retried.configured, true);
    assert.equal(retried.degraded, true);
    assert.equal(retried.availableNextSession, false);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// ADR-098 rev2 — personal vs shared ownership
// ---------------------------------------------------------------------------

/**
 * The promise a personal connector makes: the member's own key reaches their own
 * engines and nobody else's tree is touched. If this ever writes for another
 * member, one colleague's credential has been handed to another.
 */
test('a personal connector reaches only its owner', async () => {
  const restore = sandbox();
  upsertCalls.length = 0;
  connectorRow = stdioConnector({ credentialMode: 'per_member', ownerUserId: 2 });
  try {
    secrets.setNamespacedSecret(2, 'connector', 'canva', 'sk-owned-by-two');
    const results = await connectorsService.distribute('canva');

    const written = upsertCalls;
    assert.ok(written.length > 0, 'the owner does get it');
    assert.ok(written.every((c) => c.userId === 2), 'and only the owner');
    assert.ok(
      !results.some((r) => ['opencode', 'cursor'].includes(r.provider)),
      'unproven destinations are omitted rather than claimed',
    );
  } finally {
    restore();
  }
});

/** A personal key lives in its owner's own vault, not the operator-wide one. */
test('a personal key is read from the owner scope, not the system scope', async () => {
  const restore = sandbox();
  upsertCalls.length = 0;
  connectorRow = stdioConnector({ credentialMode: 'per_member', ownerUserId: 2 });
  try {
    // Deliberately place a DIFFERENT value in the shared store. If scoping is
    // wrong, this is the value that would be distributed.
    secrets.setNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'canva', 'sk-WRONG-shared');
    secrets.setNamespacedSecret(2, 'connector', 'canva', 'sk-right-personal');

    await connectorsService.distribute('canva');
    assert.deepEqual(upsertCalls[0].env, { CANVA_API_KEY: 'sk-right-personal' });
  } finally {
    restore();
  }
});

/** Another member's personal connector must not follow them into their tree. */
test('a new member inherits shared connectors, never a colleague\'s personal one', async () => {
  const restore = sandbox();
  upsertCalls.length = 0;
  connectorRow = stdioConnector({ credentialMode: 'per_member', ownerUserId: 2 });
  try {
    secrets.setNamespacedSecret(2, 'connector', 'canva', 'sk-two');
    const results = await connectorsService.distributeAllToUser(7);
    assert.deepEqual(results, []);
    assert.equal(upsertCalls.length, 0);
  } finally {
    restore();
  }
});

/** Sharing a platform whose terms forbid it is refused; personal is offered instead. */
test('new shared connectors are refused with a stable lifecycle code while personal remains available', async () => {
  const restore = sandbox();
  try {
    await assert.rejects(
      () =>
        connectorsService.create({
          service: 'github',
          credentialMode: 'org_shared',
          ownerUserId: null,
        }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'CONNECTOR_ORG_SHARED_CREATION_DISABLED' &&
        error.statusCode === 409,
    );

    const personal = await connectorsService.create({
      service: 'github',
      credentialMode: 'per_member',
      ownerUserId: 5,
    });
    assert.equal(personal.credentialMode, 'per_member');
  } finally {
    restore();
  }
});

/** The catalog supplies packaging so the caller sends a platform and a key. */
test('a catalog stdio platform fills in its own command, args and env var', async () => {
  const restore = sandbox();
  try {
    const created = await connectorsService.create({
      service: 'figma',
      credentialMode: 'per_member',
      ownerUserId: 5,
    });
    assert.equal(created.command, 'npx');
    assert.deepEqual(created.args, ['-y', 'figma-developer-mcp', '--stdio']);
    assert.equal(created.keyEnvVar, 'FIGMA_API_KEY');
    assert.equal(created.displayName, 'Figma');
    // The owner is in the id of a PERSONAL connector (B-556): the id is the
    // primary key, and the bare slug made one member's row the only one anybody
    // could have.
    assert.equal(created.id, 'figma-u5');
  } finally {
    restore();
  }
});

/**
 * The other half of the same guarantee. GitHub moved from a package to GitHub's
 * own remote endpoint (2026-08-07), and an http entry carries a URL and a header
 * instead of a command — so packaging still arrives from the catalog, in the
 * shape that transport needs. Pinned because the earlier test read `github` as
 * proof of the stdio path and silently described the wrong platform once it
 * changed.
 */
test('a catalog http platform fills in its own url and key header', async () => {
  const restore = sandbox();
  try {
    const created = await connectorsService.create({
      service: 'github',
      credentialMode: 'per_member',
      ownerUserId: 5,
    });
    assert.equal(created.transport, 'http');
    assert.equal(created.url, 'https://api.githubcopilot.com/mcp/');
    assert.equal(created.keyHeader, 'Authorization');
    assert.equal(created.keyHeaderPrefix, 'Bearer ');
    assert.equal(created.command, null);
  } finally {
    restore();
  }
});

/**
 * An OAuth platform must arrive with NO key variable and `authMode: 'oauth'`,
 * because those two facts are what make the page hide the key field and offer
 * the link button instead. A row that carried a key env var would silently ask a
 * member for a credential the platform does not issue (ADR-098 rev3).
 */
test('a catalog OAuth platform arrives with no key field', async () => {
  const restore = sandbox();
  try {
    const created = await connectorsService.create({
      service: 'notion',
      credentialMode: 'per_member',
      ownerUserId: 5,
    });
    assert.equal(created.authMode, 'oauth');
    assert.equal(created.keyEnvVar, null);
    assert.ok(created.args.includes('https://mcp.notion.com/mcp'));
  } finally {
    restore();
  }
});

/**
 * The operator-key case (ADR-098 rev4). A server nassaj ships may take its key
 * from nassaj's own environment, which means the connector serves EVERY member
 * with nothing pasted. Reporting that as "no key" — which a plain boolean did —
 * is the most confusing state the page can show: the tools work and the page
 * says they cannot.
 */
test('operator environment credentials cannot bypass the central grant gate', async () => {
  const restore = sandbox();
  const originalKey = process.env.WAFEQ_API_KEY;
  try {
    process.env.WAFEQ_API_KEY = 'operator-key-from-dotenv';
    connectorRow = stdioConnector({
      id: 'wafeq',
      service: 'wafeq',
      args: ['{{NASSAJ_MCP_SERVERS}}/wafeq.js'],
      keyEnvVar: 'WAFEQ_API_KEY',
    });
    const created = connectorsService.get('wafeq');

    assert.equal(created.configured, false, 'the .env key is not grant authorization');
    assert.equal(created.credentialSource, null);
    assert.ok(
      created.args.some((arg) => arg.includes('{{NASSAJ_MCP_SERVERS}}')),
      'the row stays portable: the path is substituted at distribution time',
    );

    delete process.env.WAFEQ_API_KEY;
    const withoutEnv = connectorsService.get('wafeq');
    assert.equal(withoutEnv.configured, false, 'without the variable there is no credential');
    assert.equal(withoutEnv.credentialSource, null);
  } finally {
    if (originalKey === undefined) delete process.env.WAFEQ_API_KEY;
    else process.env.WAFEQ_API_KEY = originalKey;
    restore();
  }
});

test('a built-in connector resolves to the shipped source server file', async () => {
  const restore = sandbox();
  upsertCalls.length = 0;
  try {
    connectorRow = stdioConnector({
      id: 'wafeq',
      service: 'wafeq',
      args: ['{{NASSAJ_MCP_SERVERS}}/wafeq.js'],
      keyEnvVar: 'WAFEQ_API_KEY',
    });
    secrets.setNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'wafeq', 'sk-live');
    await connectorsService.distribute('wafeq');

    const args = upsertCalls[0].args as string[];
    assert.deepEqual(args.slice(0, 2), ['--import', 'tsx']);
    assert.equal(args[2], path.resolve('server/mcp-servers/wafeq.ts'));
    assert.equal(fs.statSync(args[2]).isFile(), true);
  } finally {
    restore();
  }
});

test('a V2 Google bridge receives only opaque grant coordinates, never OAuth app secrets', async () => {
  const restore = sandbox();
  upsertCalls.length = 0;
  const originalClientId = process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_ID;
  const originalClientSecret = process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_SECRET;
  try {
    process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_ID = 'google-client';
    process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_SECRET = 'google-secret';
    connectorRow = stdioConnector({
      id: 'google-drive-u1',
      service: 'google-drive',
      authMode: 'oauth',
      credentialMode: 'per_member',
      ownerUserId: 1,
      args: [
        '{{NASSAJ_MCP_SERVERS}}/remote-bridge.js',
        'https://drivemcp.googleapis.com/mcp/v1',
      ],
      keyEnvVar: null,
    });
    const authDir = path.join(
      os.homedir(),
      '.nassaj-users',
      '1',
      '.mcp-auth',
      'google-drive-u1',
    );
    fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(authDir, 'grant.json'), '{"access_token":"linked"}', { mode: 0o600 });

    await connectorsService.distribute('google-drive-u1');
    const env = upsertCalls[0].env as Record<string, string>;
    assert.equal(env.NASSAJ_OAUTH_V2_CONNECTOR_ID, 'google-drive-u1');
    assert.equal(env.NASSAJ_OAUTH_CLIENT_ID, undefined);
    assert.equal(env.NASSAJ_OAUTH_CLIENT_SECRET, undefined);
    assert.equal(env.NASSAJ_OAUTH_GOOGLE_CLIENT_ID, undefined);
    assert.equal(env.NASSAJ_OAUTH_GOOGLE_CLIENT_SECRET, undefined);
    assert.equal(env.NASSAJ_OAUTH_TOKEN_AUTH_METHOD, undefined);
  } finally {
    if (originalClientId === undefined) delete process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_ID;
    else process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_SECRET;
    else process.env.NASSAJ_OAUTH_GOOGLE_CLIENT_SECRET = originalClientSecret;
    restore();
  }
});

test('legacy mcp-remote OAuth rows migrate to the locked bridge only after relink', async () => {
  const restore = sandbox();
  upsertCalls.length = 0;
  try {
    connectorRow = stdioConnector({
      id: 'notion-u1',
      service: 'notion',
      authMode: 'oauth',
      credentialMode: 'per_member',
      ownerUserId: 1,
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://mcp.notion.com/mcp'],
      keyEnvVar: null,
    });
    const authDir = path.join(os.homedir(), '.nassaj-users', '1', '.mcp-auth', 'notion-u1');
    const legacyDir = path.join(authDir, 'mcp-remote-0.1.37');
    fs.mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(legacyDir, 'legacy_tokens.json'), '{"access_token":"unsafe"}');

    assert.equal(connectorsService.get('notion-u1', 1).configured, false);
    assert.deepEqual(await connectorsService.distribute('notion-u1'), []);
    assert.equal(upsertCalls.length, 0, 'legacy shared token stores are contained, never fanned out');

    fs.writeFileSync(path.join(authDir, 'grant.json'), JSON.stringify({
      access_token: 'safe',
      refresh_token: 'refresh',
      expires_at: Date.now() + 3600_000,
      token_url: 'https://example.test/token',
      client_id: 'dcr-client',
      token_auth_method: 'none',
    }), { mode: 0o600 });
    await connectorsService.setEnabled('notion-u1', true);

    assert.equal(upsertCalls.length, 2);
    const args = upsertCalls[0].args as string[];
    const env = upsertCalls[0].env as Record<string, string>;
    assert.equal(args.includes('mcp-remote'), false);
    assert.ok(args.some((arg) => arg.endsWith('/remote-bridge.ts')));
    assert.ok(args.includes('https://mcp.notion.com/mcp'));
    assert.equal(env.NASSAJ_GRANT_FILE, undefined);
    assert.equal(env.NASSAJ_OAUTH_V2_USER_ID, '1');
    assert.equal(env.NASSAJ_OAUTH_V2_SERVICE_ID, 'notion');
    assert.equal(env.NASSAJ_OAUTH_V2_GRANT_ID, 'test');
    assert.equal(env.NASSAJ_OAUTH_V2_SECRET_REF, 'test');
    assert.equal('MCP_REMOTE_CONFIG_DIR' in env, false);
  } finally {
    restore();
  }
});

test('a missing built-in server fails before any provider write is claimed', async () => {
  const restore = sandbox();
  upsertCalls.length = 0;
  try {
    connectorRow = stdioConnector({
      id: 'wafeq',
      service: 'wafeq',
      args: ['{{NASSAJ_MCP_SERVERS}}/does-not-exist.js'],
      keyEnvVar: 'WAFEQ_API_KEY',
    });
    secrets.setNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'wafeq', 'sk-live');
    await assert.rejects(
      () => connectorsService.distribute('wafeq'),
      (error: unknown) =>
        error instanceof AppError && error.code === 'CONNECTOR_BUILT_IN_SERVER_MISSING',
    );
    assert.equal(upsertCalls.length, 0);
  } finally {
    restore();
  }
});

/**
 * A third-party package must NOT be able to pick up an environment variable by
 * declaring its name — that is the difference between "nassaj ships this server"
 * and "npx fetches this server", and it is the whole reason the fallback is
 * narrow.
 */
test('a third-party connector ignores a matching environment variable', async () => {
  const restore = sandbox();
  const originalKey = process.env.SALLA_ACCESS_TOKEN;
  try {
    process.env.SALLA_ACCESS_TOKEN = 'should-not-be-picked-up';
    connectorRow = stdioConnector({
      id: 'salla',
      service: 'salla',
      credentialMode: 'org_shared',
      command: 'npx',
      args: ['-y', 'mcp-salla'],
      keyEnvVar: 'SALLA_ACCESS_TOKEN',
    });
    const created = connectorsService.get('salla');
    assert.equal(created.configured, false);
    assert.equal(created.credentialSource, null);
  } finally {
    if (originalKey === undefined) delete process.env.SALLA_ACCESS_TOKEN;
    else process.env.SALLA_ACCESS_TOKEN = originalKey;
    restore();
  }
});

/**
 * One-click add moved the isolation question to AFTER the row exists, so the
 * move itself became a real operation — and a move that only rewrote the column
 * would leave the key installed in the audience it just left.
 */
test('changing personal/shared mode is fail-closed until credential transfer is atomic', async () => {
  const restore = sandbox();
  try {
    const created = await connectorsService.create({
      service: 'stripe',
      credentialMode: 'per_member',
      ownerUserId: 5,
    });
    assert.equal(created.credentialMode, 'per_member');
    assert.equal(created.ownerUserId, 5);

    await assert.rejects(
      () => connectorsService.setCredentialMode(created.id, 'org_shared'),
      (error: unknown) => error instanceof AppError && error.code === 'CONNECTOR_MODE_CHANGE_DISABLED',
    );
    assert.equal(connectorsService.get(created.id).credentialMode, 'per_member');
    assert.equal(connectorsService.get(created.id).ownerUserId, 5);
  } finally {
    restore();
  }
});

/** A platform that forbids sharing refuses the move, not just the create. */
test('a platform that forbids sharing cannot be switched to shared', async () => {
  const restore = sandbox();
  try {
    const created = await connectorsService.create({
      service: 'github',
      credentialMode: 'per_member',
      ownerUserId: 5,
    });
    await assert.rejects(
      () => connectorsService.setCredentialMode(created.id, 'org_shared'),
      (error: unknown) => error instanceof AppError && error.code === 'CONNECTOR_MODE_CHANGE_DISABLED',
    );
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// B-556 — a colleague's connection must not block yours
// ---------------------------------------------------------------------------

/**
 * The measured failure: one member owned `notion`, and the next member to ask
 * for it got a 400 reading `UNIQUE constraint failed: connectors.id`. The
 * derived id was the platform slug alone, so two DIFFERENT personal rows kept
 * arriving under one primary key — while the partial index that governs personal
 * rows would have admitted them both. The index permitted what the key forbade.
 */
test('two members connecting one platform derive distinct ids', async () => {
  const restore = sandbox();
  try {
    const mine = await connectorsService.create({
      service: 'figma',
      credentialMode: 'per_member',
      ownerUserId: 2,
    });
    const theirs = await connectorsService.create({
      service: 'figma',
      credentialMode: 'per_member',
      ownerUserId: 3,
    });

    assert.equal(mine.id, 'figma-u2');
    assert.equal(theirs.id, 'figma-u3');
    assert.notEqual(mine.id, theirs.id, 'a colleague connecting first cannot block you');
  } finally {
    restore();
  }
});

/** Existing shared rows remain readable; only creation is gated. */
test('a legacy shared connector remains readable without mutation', async () => {
  const restore = sandbox();
  try {
    connectorRow = stdioConnector({ id: 'stripe', service: 'stripe', credentialMode: 'org_shared' });
    const before = { ...connectorRow };
    assert.equal(connectorsService.get('stripe').id, 'stripe');
    assert.deepEqual(connectorRow, before);
  } finally {
    restore();
  }
});

test('user deletion precondition retains the user-owned connector and performs no cleanup', () => {
  const restore = sandbox();
  connectorRow = stdioConnector({ credentialMode: 'per_member', ownerUserId: 7 });
  try {
    assert.throws(
      () => connectorsService.assertUserDeletionAllowed(7),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'CONNECTOR_LIFECYCLE_REQUIRED' &&
        error.statusCode === 409,
    );
    assert.ok(connectorRow, 'the lifecycle handle remains present');
    assert.equal(removeCalls.length, 0, 'the precondition is read-only and never invokes cleanup');
    assert.doesNotThrow(() => connectorsService.assertUserDeletionAllowed(8));
  } finally {
    restore();
  }
});

/**
 * The refusal that IS legitimate — the same member adding the same platform
 * twice — must arrive as something the page can translate and the member can
 * act on, not as the storage engine's description of our column layout.
 */
test('adding the same platform twice answers with a code, not with SQL', async () => {
  const restore = sandbox();
  try {
    await connectorsService.create({
      service: 'figma',
      credentialMode: 'per_member',
      ownerUserId: 2,
    });

    await assert.rejects(
      () =>
        connectorsService.create({
          service: 'figma',
          credentialMode: 'per_member',
          ownerUserId: 2,
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppError, 'a classified error, not a raw driver throw');
        assert.equal(error.code, 'CONNECTOR_ALREADY_EXISTS');
        assert.equal(error.statusCode, 409);
        assert.ok(
          !/unique|constraint|sqlite|connectors\./i.test(error.message),
          'and the engine\'s own words never reach the member',
        );
        return true;
      },
    );
  } finally {
    restore();
  }
});

/** A label is what separates two accounts on one platform for one member. */
test('an account label separates two connections to the same platform', async () => {
  const restore = sandbox();
  try {
    const work = await connectorsService.create({
      service: 'figma',
      accountLabel: 'work',
      credentialMode: 'per_member',
      ownerUserId: 2,
    });
    const client = await connectorsService.create({
      service: 'figma',
      accountLabel: 'client',
      credentialMode: 'per_member',
      ownerUserId: 2,
    });
    assert.match(work.id, /^figma-work-[a-f0-9]{16}-u2$/);
    assert.match(client.id, /^figma-client-[a-f0-9]{16}-u2$/);
    assert.notEqual(work.id, client.id);
  } finally {
    restore();
  }
});

test('an Arabic account label is normalized and receives a distinct storage-safe id', async () => {
  const restore = sandbox();
  try {
    const primary = await connectorsService.create({
      service: 'figma',
      credentialMode: 'per_member',
      ownerUserId: 2,
    });
    const work = await connectorsService.create({
      service: 'figma',
      accountLabel: '  حساب   العمل  ',
      credentialMode: 'per_member',
      ownerUserId: 2,
    });

    assert.equal(primary.id, 'figma-u2');
    assert.equal(work.accountLabel, 'حساب العمل');
    assert.match(work.id, /^figma-account-[a-f0-9]{16}-u2$/);
    assert.notEqual(work.id, primary.id);
  } finally {
    restore();
  }
});

test('account ids retain full normalized-label identity beyond their readable slug', async () => {
  const restore = sandbox();
  try {
    const punctuationA = await connectorsService.create({
      service: 'figma',
      accountLabel: 'work!',
      credentialMode: 'per_member',
      ownerUserId: 2,
    });
    const punctuationB = await connectorsService.create({
      service: 'figma',
      accountLabel: 'work?',
      credentialMode: 'per_member',
      ownerUserId: 2,
    });
    const sharedPrefix = 'customer-account-with-a-prefix-that-is-much-longer-than-the-id-budget';
    const longA = await connectorsService.create({
      service: 'figma',
      accountLabel: `${sharedPrefix}-alpha`,
      credentialMode: 'per_member',
      ownerUserId: 2,
    });
    const longB = await connectorsService.create({
      service: 'figma',
      accountLabel: `${sharedPrefix}-beta`,
      credentialMode: 'per_member',
      ownerUserId: 2,
    });

    assert.notEqual(punctuationA.id, punctuationB.id);
    assert.notEqual(longA.id, longB.id);
    for (const connector of [punctuationA, punctuationB, longA, longB]) {
      assert.ok(connector.id.length <= 64);
      assert.match(connector.id, /-[a-f0-9]{16}-u2$/);
    }
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// B-542 — "built-in" is the catalog's word, not the caller's
// ---------------------------------------------------------------------------

/**
 * The privilege at stake: a built-in connector may take its key from nassaj's
 * OWN environment. While that was decided by looking for a token inside the
 * row's arguments, anyone who could write an argument could claim it — and then
 * name any variable nassaj runs with. The claim is now the catalog's to make.
 */
test('a row cannot make itself built-in by writing the token into its arguments', async () => {
  const restore = sandbox();
  const originalKey = process.env.JWT_SECRET;
  try {
    process.env.JWT_SECRET = 'the-signing-secret';
    connectorRow = stdioConnector({
      id: 'sec-probe',
      service: 'sec-probe',
      command: '/bin/echo',
      args: ['{{NASSAJ_MCP_SERVERS}}/probe.js'],
      keyEnvVar: 'JWT_SECRET',
    });

    const status = connectorsService.get('sec-probe');
    assert.equal(status.credentialSource, null, 'the operator env is not on offer');
    assert.equal(status.configured, false);

    upsertCalls.length = 0;
    assert.deepEqual(await connectorsService.distribute('sec-probe'), [], 'and nothing is launched');
    assert.equal(upsertCalls.length, 0);
  } finally {
    if (originalKey === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalKey;
    restore();
  }
});

/**
 * The token is substituted by a plain string replace, so an argument may spend
 * `..` on the way out of the directory. Containment is checked after resolution,
 * because that is the only form in which those segments have been spent.
 */
test('a built-in argument that climbs out of the servers directory is refused', async () => {
  const restore = sandbox();
  try {
    connectorRow = stdioConnector({
      id: 'wafeq',
      service: 'wafeq',
      command: 'node',
      args: ['{{NASSAJ_MCP_SERVERS}}/../../../../etc/passwd'],
      keyEnvVar: 'WAFEQ_API_KEY',
    });
    secrets.setNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'wafeq', 'sk-live');

    await assert.rejects(() => connectorsService.distribute('wafeq'), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'CONNECTOR_PATH_ESCAPE');
      return true;
    });

    // One poisoned row must not cost a joining member every OTHER connector.
    const results = await connectorsService.distributeAllToUser(1);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].provider, 'all');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// B-543 — deleting an OAuth connector is a withdrawal of access
// ---------------------------------------------------------------------------

/**
 * For an OAuth connector the tokens ARE the credential: there is no key to
 * rotate. A delete that swept the registrations and the secret store but left
 * the auth directory behind therefore revoked nothing — and because the id is
 * derived, adding the same platform back landed on the same directory and came
 * up already linked, as whoever approved it the first time.
 */
test('OAuth deletion tombstones before cleanup, retains its grant, and is idempotent', async () => {
  const restore = sandbox();
  try {
    const created = await connectorsService.create({
      service: 'notion',
      credentialMode: 'per_member',
      ownerUserId: 2,
    });
    assert.equal(created.id, 'notion-u2');
    assert.equal(created.authMode, 'oauth');
    assert.equal(created.configured, false, 'a fresh connector is not linked yet');

    // Stand in for a completed browser grant — the file the flow writes once the
    // member approves.
    const grantDir = path.join(os.homedir(), '.nassaj-users', '2', '.mcp-auth', 'notion-u2');
    fs.mkdirSync(grantDir, { recursive: true });
    fs.writeFileSync(path.join(grantDir, 'grant.json'), '{"access_token":"granted"}');

    assert.equal(connectorsService.get('notion-u2', 2).credentialSource, null);

    const first = await connectorsService.remove('notion-u2');
    assert.deepEqual(first, { removed: false, revocationPending: true, cleanupRequired: false });
    assert.equal(fs.existsSync(path.join(grantDir, 'grant.json.revocation-pending.json')), true);
    assert.equal(fs.existsSync(grantDir), true, 'grant remains available for upstream revoke');
    const second = await connectorsService.remove('notion-u2');
    assert.deepEqual(second, first, 'retry is idempotent');
    const retained = connectorsService.get('notion-u2', 2);
    assert.equal(retained.enabled, false);
    assert.equal(retained.degraded, false);
    assert.equal(retained.credentialSource, null);
  } finally {
    restore();
  }
});

test('multi-member tombstone failure is explicit and never claims revocationPending', async () => {
  const restore = sandbox();
  connectorRow = stdioConnector({
    id: 'notion', service: 'notion', authMode: 'oauth', credentialMode: 'org_shared',
    ownerUserId: null, command: 'node', args: [], keyEnvVar: null,
  });
  const originalMkdir = fs.mkdirSync;
  const mkdirMock = mock.method(fs, 'mkdirSync', ((target: fs.PathLike, ...args: unknown[]) => {
    if (String(target).includes(`${path.sep}.nassaj-users${path.sep}2${path.sep}.mcp-auth${path.sep}notion`)) {
      const error = new Error('injected tombstone failure') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    }
    return Reflect.apply(originalMkdir, fs, [target, ...args]);
  }) as typeof fs.mkdirSync);
  try {
    await assert.rejects(
      () => connectorsService.remove('notion'),
      (error: unknown) => error instanceof AppError
        && error.code === 'CONNECTOR_OAUTH_REVOCATION_MARKER_FAILED'
        && error.statusCode === 503,
    );
    assert.equal(connectorRow.enabled, false, 'DB containment precedes first filesystem await');
    assert.equal(removeCalls.length, 0, 'cleanup waits until every target has a durable marker');
    assert.equal(
      fs.existsSync(path.join(
        os.homedir(), '.nassaj-users', '1', '.mcp-auth', 'notion',
        'grant.json.revocation-pending.json',
      )),
      true,
      'a successful earlier target remains durably blocked for safe retry',
    );
  } finally {
    mkdirMock.mock.restore();
    restore();
  }
});

/**
 * The deliberate asymmetry. Disabling is a pause an operator expects to undo,
 * and the grant is the one credential nassaj cannot restore on its own — so
 * flicking the switch must not cost the member a second trip through consent.
 */
test('disabling a connector keeps the grant', async () => {
  const restore = sandbox();
  try {
    connectorRow = stdioConnector({
      id: 'notion-u2',
      service: 'notion',
      authMode: 'oauth',
      credentialMode: 'per_member',
      ownerUserId: 2,
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://mcp.notion.com/mcp'],
      keyEnvVar: null,
    });
    const grantDir = path.join(os.homedir(), '.nassaj-users', '2', '.mcp-auth', 'notion-u2');
    fs.mkdirSync(grantDir, { recursive: true });
    fs.writeFileSync(path.join(grantDir, 'grant.json'), '{"access_token":"granted"}');

    await connectorsService.setEnabled('notion-u2', false);

    assert.equal(fs.existsSync(grantDir), true, 'a pause is not a revocation');
    assert.equal(connectorsService.get('notion-u2', 2).credentialSource, null);
    assert.equal(connectorsService.get('notion-u2', 2).configured, false,
      'legacy files are not central authorization evidence');
    assert.equal(connectorsService.get('notion-u2', 2).degraded, false,
      'legacy files are not included in central health');
    assert.equal(connectorsService.get('notion-u2', 2).availableNextSession, false);
  } finally {
    restore();
  }
});

test('failed disable cleanup stays disabled and degraded', async () => {
  const restore = sandbox();
  connectorRow = stdioConnector({ enabled: true });
  try {
    cleanupError = 'config is read-only';
    await assert.rejects(
      () => connectorsService.setEnabled('canva', false),
      (error: unknown) => error instanceof AppError && error.code === 'CONNECTOR_CLEANUP_FAILED',
    );
    assert.equal(connectorsService.get('canva').enabled, false);
  } finally {
    restore();
  }
});

test('empty cleanup fails closed while containment stays disabled', async () => {
  const restore = sandbox();
  connectorRow = stdioConnector({ enabled: true });
  try {
    cleanupReturnsEmpty = true;
    await assert.rejects(
      () => connectorsService.setEnabled('canva', false),
      (error: unknown) => error instanceof AppError && error.code === 'CONNECTOR_CLEANUP_FAILED',
    );
    assert.equal(connectorsService.get('canva').enabled, false);
  } finally {
    restore();
  }
});

test('failed enable distribution rolls the enabled flag back', async () => {
  const restore = sandbox();
  connectorRow = stdioConnector({ enabled: false });
  try {
    secrets.setNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'canva', 'sk-live');
    upsertFailureProvider = 'codex';
    await assert.rejects(
      () => connectorsService.setEnabled('canva', true),
      (error: unknown) => error instanceof AppError && error.code === 'CONNECTOR_DISTRIBUTION_FAILED',
    );
    assert.equal(connectorsService.get('canva').enabled, false);
  } finally {
    restore();
  }
});

/** Extras travel in the server env like the key does, so they redistribute. */
test('setting extras keeps only non-empty values', async () => {
  const restore = sandbox();
  try {
    const created = await connectorsService.create({
      service: 'slack',
      credentialMode: 'per_member',
      ownerUserId: 2,
    });
    await connectorsService.setKey(created.id, 'xoxb-test');
    const updated = await connectorsService.setExtraEnv(created.id, {
      SLACK_TEAM_ID: '  T01234567  ',
      SLACK_EMPTY: '   ',
    });
    assert.deepEqual(updated.extraEnv, { SLACK_TEAM_ID: 'T01234567' });
  } finally {
    restore();
  }
});

test('failed extra-env redistribution leaves a disabled non-green retry state', async () => {
  const restore = sandbox();
  connectorRow = stdioConnector();
  try {
    secrets.setNamespacedSecret(secrets.SYSTEM_SECRET_SCOPE, 'connector', 'canva', 'sk-live');
    upsertFailureProvider = 'codex';
    await assert.rejects(
      () => connectorsService.setExtraEnv('canva', { TEAM_ID: 'new' }),
      (error: unknown) => error instanceof AppError && error.code === 'CONNECTOR_DISTRIBUTION_FAILED',
    );
    const retained = connectorsService.get('canva');
    assert.equal(retained.enabled, false);
    assert.equal(retained.configured, true);
    assert.equal(retained.degraded, true);
    assert.equal(retained.availableNextSession, false);
    assert.equal(retained.credentialSource, 'stored');
  } finally {
    restore();
  }
});
