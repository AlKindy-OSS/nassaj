import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  claimPermissionLease,
  countPermissionGenerationBlocks,
  createPermissionAdmission,
  digestPermissionWorkspace,
  listPermissionEffectFences,
  markPermissionEffectStarted,
  migratePermissionExecution,
  PermissionStateConflictError,
  reconcileExpiredPermissionExecutions,
  settlePermissionEffect,
} from '@/modules/database/index.js';

import { createAuthenticatedLaunchActor } from './actor.js';
import { computePermissionReleaseCapabilityDigest, PERMISSION_CAPABILITY_ARTIFACT_DIGEST } from './capability-registry.js';
import { createExecutionPermissionGateway } from './execution-gateway.service.js';
import { CLAUDE_REFERENCE_VECTOR_V1 } from './fixtures/claude-reference-v1.js';
import { issueInProcessReadCapability } from './in-process-read-capability.js';
import {
  InProcessReadRefusedError,
  validateInProcessReadDescriptor,
} from './in-process-read-descriptor.js';
import {
  IN_PROCESS_READ_MAX_BODY_BYTES,
  runAuthorizedInProcessRead,
  type InProcessReadScope,
} from './in-process-read.js';
import { isPermissionReconciliationFatal, processAlive } from './runtime-gateway.js';

const RELEASE = 'c'.repeat(64);
const PROFILE = `sha256:${'a'.repeat(64)}`;
const BOOT_ID = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
// A pid that has exited: the "old server" whose read was interrupted by a restart.
const DEAD_PID = spawnSync(process.execPath, ['-e', '']).pid as number;
const OWNER = Object.freeze({ ownerId: 'server:old', ownerPid: DEAD_PID, ownerBootId: BOOT_ID, ownerStartTicks: '1' });
const SCOPE: InProcessReadScope = Object.freeze({ authenticatedPrincipal: {}, provider: 'codex', purpose: 'quota' });
const URL_OK = 'https://chatgpt.com/backend-api/wham/usage';
const descriptor = (overrides: Record<string, unknown> = {}) => ({
  url: URL_OK, method: 'GET', headers: { Accept: 'application/json' }, deadlineMs: 2_000, ...overrides,
});

const setup = (): Database.Database => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
      is_active INTEGER NOT NULL DEFAULT 1, password_changed_at INTEGER
    );
    CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, key_digest TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO users (id, username, password_hash, role) VALUES (1, 'owner', 'hash', 'owner');
  `);
  migratePermissionExecution(database);
  return database;
};

const actor = createAuthenticatedLaunchActor({
  id: 1, role: 'owner', status: 'active', is_active: 1,
  authenticationKind: 'session', authorizationGeneration: 1,
}, '2030-01-01T00:00:00.000Z');

let sequence = 0;
const gatewayFor = (database: Database.Database, now = { value: 1_000 }) =>
   createExecutionPermissionGateway({
    database,
    authority: Object.freeze({
      source: 'sealed_release_manifest', profileId: 'full_delegation', contractVersion: 'permission-parity/v1',
      profileDigest: PROFILE, capabilityDigest: computePermissionReleaseCapabilityDigest(RELEASE, PROFILE, 1),
      protocolGeneration: 1,
    }),
    reference: CLAUDE_REFERENCE_VECTOR_V1,
    candidateFor: () => null,
    capabilityArtifactDigest: PERMISSION_CAPABILITY_ARTIFACT_DIGEST,
    releaseBuild: RELEASE,
    manifestDigest: null,
    processIdentity: OWNER,
    randomId: () => `id-${now.value}-${++sequence}`,
    nowMs: () => now.value,
    isDevicePrincipalCurrent: () => true,
  });

const authorizeOn = (
  database: Database.Database,
  overrides: Readonly<{ provider?: string; effectFootprint?: 'local' | 'external' }> = {},
) => {
  const result = gatewayFor(database).authorize(actor, {
    launchId: `launch-${sequence}`, principalId: 'user:1', sessionId: null, projectId: 'system:provider-quota',
    workspacePath: '/workspace', provider: overrides.provider ?? 'codex', body: overrides.provider ?? 'codex',
    engine: 'quota', entrypoint: 'provider.routes.quota', purpose: 'quota',
    effectFootprint: overrides.effectFootprint ?? 'local',
  }, 'full_delegation');
  assert.equal(result.kind, 'authorized');
  if (result.kind !== 'authorized') throw new Error('unreachable');
  return result.execution;
};

const okResponse = (body = '{"ok":true}', status = 200) => new Response(body, { status });

const outcomes = (database: Database.Database) => database.prepare(`SELECT decision.terminal_outcome AS outcome,
  lease.effect_footprint AS footprint, lease.effect_child_pid AS childPid
  FROM permission_launch_decisions decision JOIN permission_admission_leases lease
  ON lease.decision_id = decision.decision_id ORDER BY decision.created_at_ms, decision.decision_id`).all() as
  Array<{ outcome: string | null; footprint: string; childPid: number | null }>;

/** Boot reconciliation exactly as production runs it: exact kernel identity, this boot. */
const rebootReconcile = (database: Database.Database, nowMs: number) => {
  const alive = (identity: { pid: number; bootId: string; startTicks: string }) => processAlive(BOOT_ID, identity);
  return reconcileExpiredPermissionExecutions(database, nowMs, alive, alive);
};

const snapshot = (database: Database.Database) => new Database(database.serialize());

test('descriptor validation refuses foreign origins, writes, redirects and malformed input before admission', async () => {
  const refusals: Array<[Record<string, unknown>, string]> = [
    [descriptor({ url: 'https://evil.example/usage' }), 'IN_PROCESS_READ_ORIGIN_REFUSED'],
    [descriptor({ url: 'http://chatgpt.com/backend-api/wham/usage' }), 'IN_PROCESS_READ_ORIGIN_REFUSED'],
    [descriptor({ url: 'https://user:pw@chatgpt.com/x' }), 'IN_PROCESS_READ_ORIGIN_REFUSED'],
    [descriptor({ url: 'https://chatgpt.com.evil.example/x' }), 'IN_PROCESS_READ_ORIGIN_REFUSED'],
    [descriptor({ url: 'not a url' }), 'IN_PROCESS_READ_URL_INVALID'],
    [descriptor({ url: 42 }), 'IN_PROCESS_READ_URL_INVALID'],
    [descriptor({ method: 'POST' }), 'IN_PROCESS_READ_METHOD_REFUSED'],
    [descriptor({ method: 'get' }), 'IN_PROCESS_READ_METHOD_REFUSED'],
    [descriptor({ method: 'HEAD' }), 'IN_PROCESS_READ_METHOD_REFUSED'],
    [descriptor({ redirect: 'follow' }), 'IN_PROCESS_READ_DESCRIPTOR_INVALID'],
    [descriptor({ body: '{}' }), 'IN_PROCESS_READ_DESCRIPTOR_INVALID'],
    [descriptor({ deadlineMs: 0 }), 'IN_PROCESS_READ_DEADLINE_INVALID'],
    [descriptor({ deadlineMs: 15_001 }), 'IN_PROCESS_READ_DEADLINE_INVALID'],
    [descriptor({ deadlineMs: 1.5 }), 'IN_PROCESS_READ_DEADLINE_INVALID'],
    [descriptor({ headers: { 'X-A': 'a\r\nInjected: 1' } }), 'IN_PROCESS_READ_HEADERS_INVALID'],
    [descriptor({ headers: { Host: 'evil.example' } }), 'IN_PROCESS_READ_HEADERS_INVALID'],
    [descriptor({ headers: { 'bad name': 'x' } }), 'IN_PROCESS_READ_HEADERS_INVALID'],
    [descriptor({ headers: { 'X-A': 1 } }), 'IN_PROCESS_READ_HEADERS_INVALID'],
    [descriptor({ headers: [] }), 'IN_PROCESS_READ_HEADERS_INVALID'],
    [descriptor({ headers: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`X-${i}`, 'v'])) }),
      'IN_PROCESS_READ_HEADERS_INVALID'],
  ];
  for (const [raw, code] of refusals) {
    let authorized = 0;
    await assert.rejects(
      runAuthorizedInProcessRead(SCOPE, raw, { authorize: () => { authorized += 1; throw new Error('admitted'); } }),
      (error: unknown) => error instanceof InProcessReadRefusedError && error.code === code,
      JSON.stringify(raw),
    );
    assert.equal(authorized, 0, 'a refused descriptor never reaches admission');
  }
  assert.throws(() => validateInProcessReadDescriptor(null), InProcessReadRefusedError);
  assert.equal(validateInProcessReadDescriptor(descriptor()).method, 'GET');
});

test('a successful read records the server itself as the child in the start CAS and settles succeeded', async () => {
  const database = setup();
  try {
    let init: RequestInit | undefined;
    const result = await runAuthorizedInProcessRead(SCOPE, descriptor(), {
      authorize: () => authorizeOn(database),
      fetchImpl: async (_url, requestInit) => {
        init = requestInit;
        // Start evidence is durable before the request leaves the process.
        assert.deepEqual(database.prepare(`SELECT effect_child_pid AS pid, effect_child_boot_id AS boot,
          effect_child_start_ticks AS ticks FROM permission_admission_leases`).get(),
        { pid: OWNER.ownerPid, boot: OWNER.ownerBootId, ticks: OWNER.ownerStartTicks });
        return okResponse();
      },
    });
    assert.deepEqual(result, { kind: 'response', status: 200, body: '{"ok":true}' });
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
    assert.deepEqual(outcomes(database), [{ outcome: 'succeeded', footprint: 'local', childPid: OWNER.ownerPid }]);
  } finally { database.close(); }
});

test('owner dies mid-read: boot reconciliation counts unknownLocal, writes no fence, next read admitted', async () => {
  const database = setup();
  let afterRestart: Database.Database | null = null;
  try {
    await runAuthorizedInProcessRead(SCOPE, descriptor(), {
      authorize: () => authorizeOn(database),
      fetchImpl: async () => {
        // The server dies here: the durable state at this instant is what the next boot sees.
        afterRestart = snapshot(database);
        throw new Error('process killed');
      },
    });
    assert.ok(afterRestart);
    const restarted = afterRestart as Database.Database;
    const summary = rebootReconcile(restarted, 1_000 + 31_000);
    assert.equal(summary.unknownLocal, 1);
    assert.equal(summary.unknownExternal, 0);
    assert.equal(isPermissionReconciliationFatal(summary), false);
    assert.deepEqual(listPermissionEffectFences(restarted), []);
    assert.equal(countPermissionGenerationBlocks(restarted), 0);
    assert.equal(outcomes(restarted)[0]?.outcome, 'reconciled_unknown');
    const next = await runAuthorizedInProcessRead(SCOPE, descriptor(), {
      authorize: () => authorizeOn(restarted), fetchImpl: async () => okResponse(),
    });
    assert.equal(next.kind, 'response');
  } finally {
    database.close();
    (afterRestart as Database.Database | null)?.close();
  }
});

test('Claude quota stays external: the same restart fences its scope and is boot-fatal once', () => {
  const database = setup();
  try {
    const execution = authorizeOn(database, { provider: 'claude', effectFootprint: 'external' });
    execution.consume();
    execution.markStarted();
    const summary = rebootReconcile(database, 1_000 + 31_000);
    assert.equal(summary.unknownExternal, 1);
    assert.equal(isPermissionReconciliationFatal(summary), true);
    assert.deepEqual(listPermissionEffectFences(database).map(fence => fence.scopeKey), ['1:claude:quota']);
    assert.throws(() => authorizeOn(database, { provider: 'claude', effectFootprint: 'external' }),
      (error: unknown) => error instanceof PermissionStateConflictError && error.code === 'EFFECT_SCOPE_FENCED');
    // The codex quota scope of the same user is untouched.
    authorizeOn(database);
  } finally { database.close(); }
});

test('in-process deadline settles timed_out without a fence, for a stalled request and a stalled body', async () => {
  const database = setup();
  try {
    const stalledRequest: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const neverRespond: typeof fetch = () => new Promise(() => {});
    const stalledBody: typeof fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')); },
    }));
    for (const fetchImpl of [stalledRequest, neverRespond, stalledBody]) {
      const result = await runAuthorizedInProcessRead(SCOPE, descriptor({ deadlineMs: 25 }), {
        authorize: () => authorizeOn(database), fetchImpl,
      });
      assert.deepEqual(result, { kind: 'failed', reason: 'timeout' });
    }
    assert.deepEqual(outcomes(database).map(row => row.outcome), ['timed_out', 'timed_out', 'timed_out']);
    assert.deepEqual(listPermissionEffectFences(database), []);
    assert.equal(countPermissionGenerationBlocks(database), 0);
  } finally { database.close(); }
});

test('redirects, network errors, oversized bodies and non-2xx statuses settle failed, never unknown', async () => {
  const database = setup();
  try {
    const run = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) => runAuthorizedInProcessRead(
      SCOPE, descriptor(extra), { authorize: () => authorizeOn(database), fetchImpl });
    assert.deepEqual(await run(async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example' } })),
      { kind: 'failed', reason: 'redirect' });
    assert.deepEqual(await run(async () => { throw new TypeError('fetch failed: redirect mode is error'); }),
      { kind: 'failed', reason: 'network' });
    assert.deepEqual(await run(async () => okResponse('x'.repeat(IN_PROCESS_READ_MAX_BODY_BYTES + 1))),
      { kind: 'failed', reason: 'too_large' });
    assert.deepEqual(await run(async () => okResponse('{"error":"expired"}', 401)),
      { kind: 'response', status: 401, body: '{"error":"expired"}' });
    assert.deepEqual(await run(async () => new Response(null, { status: 204 })),
      { kind: 'response', status: 204, body: '' });
    assert.deepEqual(outcomes(database).map(row => row.outcome),
      ['failed', 'failed', 'failed', 'failed', 'succeeded']);
    assert.deepEqual(listPermissionEffectFences(database), []);
  } finally { database.close(); }
});

test('self-identity child is refused without the capability, at the gateway and the repository', async () => {
  const database = setup();
  try {
    const owner = { pid: OWNER.ownerPid, bootId: OWNER.ownerBootId, startTicks: OWNER.ownerStartTicks };
    const execution = authorizeOn(database);
    execution.consume();
    assert.throws(() => execution.markStarted(owner), /SELF_EFFECT_CAPABILITY_REQUIRED/);
    assert.throws(() => execution.markStartedInProcessRead(Symbol('nassaj.permission.in-process-read')),
      /SELF_EFFECT_CAPABILITY_REQUIRED/);
    assert.throws(() => execution.markStartedInProcessRead('nassaj.permission.in-process-read'),
      /SELF_EFFECT_CAPABILITY_REQUIRED/);
    // Refused before any write: still claimable as a normal start, generation not blocked.
    assert.equal(countPermissionGenerationBlocks(database), 0);
    execution.markStarted();
    assert.throws(() => execution.attachChildIdentity(owner), /SELF_EFFECT_CAPABILITY_REQUIRED/);
    execution.settle('succeeded');
    // The single capability cannot be issued a second time to another holder.
    assert.throws(() => issueInProcessReadCapability(), /IN_PROCESS_READ_CAPABILITY_ALREADY_ISSUED/);
    // An external-footprint handle cannot carry an in-process read even through the helper.
    await assert.rejects(runAuthorizedInProcessRead(SCOPE, descriptor(), {
      authorize: () => authorizeOn(database, { effectFootprint: 'external' }),
      fetchImpl: async () => assert.fail('nothing may be sent'),
    }), /IN_PROCESS_READ_FOOTPRINT_REQUIRED/);
    assert.equal(outcomes(database).at(-1)?.outcome, 'failed');
    assert.deepEqual(listPermissionEffectFences(database), []);
  } finally { database.close(); }

  // Repository: the owner as child needs selfEffect and a local footprint; never attachable.
  const repository = setup();
  try {
    const admit = (id: string, effectFootprint: 'local' | 'external') => {
      createPermissionAdmission(repository, {
        decisionId: id, leaseId: `lease-${id}`, userId: 1, principalId: 'user:1', authenticationKind: 'session',
        authorizationGeneration: 1, launchId: id, projectId: 'p', workspaceDigest: digestPermissionWorkspace('/w'),
        provider: 'codex', body: 'codex', engine: 'quota', entrypoint: 'e', purpose: 'quota', effectFootprint,
        requestedProfile: 'full_delegation', contractVersion: 'v1', profileDigest: 'p', capabilityDigest: 'c',
        releaseBuild: 'r', protocolGeneration: 1, ownerId: 'o', ownerPid: 7, ownerBootId: 'b', ownerStartTicks: '9',
        effectIdentity: `effect-${id}`, expiresAtMs: 100, nowMs: 10,
      });
      claimPermissionLease(repository, `lease-${id}`, 1, 11);
    };
    const self = { pid: 7, bootId: 'b', startTicks: '9' };
    admit('plain', 'local');
    assert.throws(() => markPermissionEffectStarted(repository, 'plain', 2, 12, self), /SELF_EFFECT_IDENTITY_REFUSED/);
    admit('external', 'external');
    assert.throws(() => markPermissionEffectStarted(repository, 'external', 2, 12, self, { selfEffect: true }),
      /SELF_EFFECT_IDENTITY_REFUSED/);
    admit('other', 'local');
    assert.throws(() => markPermissionEffectStarted(repository, 'other', 2, 12, { ...self, pid: 8 }, { selfEffect: true }),
      /SELF_EFFECT_IDENTITY_REFUSED/);
    assert.throws(() => markPermissionEffectStarted(repository, 'other', 2, 12, undefined, { selfEffect: true }),
      /INVALID_CHILD_IDENTITY/);
    // Every refusal rolled back its decision CAS.
    assert.deepEqual(repository.prepare('SELECT DISTINCT state FROM permission_launch_decisions').pluck().all(),
      ['effect_claimed']);
  } finally { repository.close(); }
});

test('the capability is never handed to an injected look-alike or a wrapper of a real handle', async () => {
  const database = setup();
  try {
    const received: unknown[] = [];
    const steal = { markStartedInProcessRead: (capability: unknown) => { received.push(capability); } };
    const fake = { consume: () => ({}), settle: () => {}, ...steal } as never;
    const real = authorizeOn(database);
    const derived = Object.create(real, { markStartedInProcessRead: { value: steal.markStartedInProcessRead } }) as never;
    const proxied = new Proxy(authorizeOn(database), {}) as never;
    for (const handle of [fake, derived, proxied]) {
      await assert.rejects(runAuthorizedInProcessRead(SCOPE, descriptor(), {
        authorize: () => handle, fetchImpl: async () => assert.fail('nothing may be sent'),
      }), (error: unknown) => error instanceof InProcessReadRefusedError
        && error.code === 'IN_PROCESS_READ_HANDLE_UNTRUSTED');
    }
    assert.deepEqual(received, []);
    // Refused before consume: the real handles behind the wrappers were never claimed.
    assert.deepEqual(database.prepare('SELECT DISTINCT state FROM permission_launch_decisions').pluck().all(),
      ['authorized']);
  } finally { database.close(); }
});

test('parity: both fence sites classify an in-process read lease identically (no fence) and an external one identically (fence)', () => {
  const owner = { pid: 7, bootId: 'b', startTicks: '9' };
  const prepare = (kind: 'in_process' | 'external') => {
    const database = setup();
    createPermissionAdmission(database, {
      decisionId: 'd', leaseId: 'l', userId: 1, principalId: 'user:1', authenticationKind: 'session',
      authorizationGeneration: 1, launchId: 'launch', projectId: 'p', workspaceDigest: digestPermissionWorkspace('/w'),
      provider: kind === 'external' ? 'claude' : 'codex', body: 'b', engine: 'quota', entrypoint: 'e', purpose: 'quota',
      effectFootprint: kind === 'external' ? 'external' : 'local', requestedProfile: 'full_delegation',
      contractVersion: 'v1', profileDigest: 'p', capabilityDigest: 'c', releaseBuild: 'r', protocolGeneration: 1,
      ownerId: 'o', ownerPid: owner.pid, ownerBootId: owner.bootId, ownerStartTicks: owner.startTicks,
      effectIdentity: 'effect', expiresAtMs: 100, nowMs: 10,
    });
    claimPermissionLease(database, 'l', 1, 11);
    const revision = kind === 'in_process'
      ? markPermissionEffectStarted(database, 'd', 2, 12, owner, { selfEffect: true })
      : markPermissionEffectStarted(database, 'd', 2, 12);
    return { database, revision };
  };
  for (const kind of ['in_process', 'external'] as const) {
    const settled = prepare(kind);
    const reconciled = prepare(kind);
    try {
      // Site 1: in-process unknown settlement. Site 2: boot reconciliation after owner death.
      settlePermissionEffect(settled.database, 'd', 'reconciled_unknown', settled.revision, 50);
      reconcileExpiredPermissionExecutions(reconciled.database, 200, () => false, () => false);
      const fenced = (database: Database.Database) => listPermissionEffectFences(database).map(fence => fence.scopeKey);
      assert.deepEqual(fenced(settled.database), fenced(reconciled.database), kind);
      assert.deepEqual(fenced(settled.database), kind === 'external' ? ['1:claude:quota'] : [], kind);
      for (const database of [settled.database, reconciled.database]) {
        assert.equal(database.prepare('SELECT terminal_outcome FROM permission_launch_decisions').pluck().get(),
          'reconciled_unknown');
      }
    } finally { settled.database.close(); reconciled.database.close(); }
  }
});
