import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  CONNECTOR_POLICY_V2_ADAPTER_PATHS,
  CONNECTOR_POLICY_V2_INTEGRATION_ENABLED,
  ConnectorPolicyV2InertAdapters,
  ConnectorPolicyV2RemovalRunner,
  ConnectorPolicyV2RemovalWorker,
} from './connector-policy-v2-adapters.js';
import {
  ConnectorPolicyOperation,
  type ConnectorCertificationBinding,
  type ConnectorKillRules,
  type ConnectorPolicyBinding,
  type ConnectorPolicyState,
} from './connector-policy-v2.js';
import {
  ConnectorKillRevisionWatcher,
  ConnectorKillRevisionWatchRunner,
  SqliteConnectorPolicyV2Store,
} from './connector-policy-v2-store.js';

const MANIFEST = 'm'.repeat(86);
const NOW = Date.parse('2026-08-26T00:00:00.000Z');
const state = (): ConnectorPolicyState => ({
  policySchemaVersion: 2, policyEpoch: 1, registryRevision: 'registry-1',
  certificationManifestDigest: MANIFEST, installationMode: 'portable_default',
  originRevision: 1, killRevision: 0, writerEpoch: 1,
  kills: { global: false, providers: [], serviceOperations: [] },
});
const binding = (operation: ConnectorPolicyOperation, mutation: Partial<ConnectorPolicyBinding> = {}) => ({
  installationId: 'install-1', userId: 7, ownership: 'personal' as const,
  providerId: 'google', serviceId: 'gmail', accountId: 'account-1', grantId: 'grant-1',
  consumerBody: 'codex', operation, ...mutation,
});
const certification = (operation: ConnectorPolicyOperation): ConnectorCertificationBinding => ({
  certified: true, providerId: 'google', serviceId: 'gmail', operation,
  manifestSequence: 1, manifestDigest: MANIFEST, originRevision: 1,
  registryRevision: 'registry-1', registryDigest: 'r'.repeat(43),
  operationsRevision: 'operations-1', operationsDigest: 'o'.repeat(43),
  capabilityRevision: 'capability-1', capabilityDigest: 'c'.repeat(43),
  shapeRevision: 1, shapeDigest: 's'.repeat(43), contractRevision: 1,
  contractDigest: 'd'.repeat(43),
});

const fixture = () => {
  const database = new Database(':memory:');
  const store = new SqliteConnectorPolicyV2Store(database, 'install-1', state());
  let nowMs = NOW;
  const adapters = new ConnectorPolicyV2InertAdapters(store, () => new Date(nowMs));
  return { database, store, adapters, setNow: (value: number) => { nowMs = value; }, now: () => nowMs };
};

const globalKill = (): ConnectorKillRules => ({ global: true, providers: [], serviceOperations: [] });

test('M3 remains statically OFF and exposes every exact cutover boundary', () => {
  assert.equal(CONNECTOR_POLICY_V2_INTEGRATION_ENABLED, false);
  assert.deepEqual(Object.keys(CONNECTOR_POLICY_V2_ADAPTER_PATHS), [
    'profileConfigure', 'grantCreate', 'oauthStart', 'oauthCallback',
    'credentialVerify', 'credentialPromote', 'credentialDecrypt',
    'outboundRequest', 'tokenRefresh', 'placementWrite', 'grantList', 'grantRemove',
    'tokenRevoke', 'credentialDelete', 'placementRemove',
  ]);
});

test('global kill blocks every guarded start/verify/promote/use/refresh/place effect with zero I/O', async () => {
  const f = fixture();
  try {
    f.store.applyKills('install-1', globalKill(), f.now());
    let effects = 0;
    const effect = async () => { effects += 1; return 'provider-I/O'; };
    const cases = [
      [f.adapters.profileConfigure.bind(f.adapters), ConnectorPolicyOperation.ProfileConfigure, {}],
      [f.adapters.grantCreate.bind(f.adapters), ConnectorPolicyOperation.GrantCreate, {}],
      [f.adapters.oauthStart.bind(f.adapters), ConnectorPolicyOperation.OauthStart,
        { transactionId: 'tx-1' }],
      [f.adapters.credentialVerify.bind(f.adapters), ConnectorPolicyOperation.CredentialVerify, {}],
      [f.adapters.credentialPromote.bind(f.adapters), ConnectorPolicyOperation.CredentialStoreUnverified, {}],
      [f.adapters.credentialDecrypt.bind(f.adapters), ConnectorPolicyOperation.CredentialUse, {}],
      [f.adapters.outboundRequest.bind(f.adapters), ConnectorPolicyOperation.CredentialUse, {}],
      [f.adapters.tokenRefresh.bind(f.adapters), ConnectorPolicyOperation.TokenRefresh, {}],
      [f.adapters.placementWrite.bind(f.adapters), ConnectorPolicyOperation.PlacementWrite,
        { opaqueGrantRef: 'grantref:one' }],
    ] as const;
    for (const [method, operation, extra] of cases) {
      await assert.rejects(method({ binding: binding(operation), certification: certification(operation),
        effect, ...extra } as never), /capability_rejected/u);
    }
    assert.equal(effects, 0);
  } finally { f.database.close(); }
});

test('kill during OAuth invalidates the pending transaction before callback, promotion, or replay', async () => {
  const f = fixture();
  try {
    const oauth = binding(ConnectorPolicyOperation.OauthStart);
    let starts = 0; let callbacks = 0;
    await f.adapters.oauthStart({ binding: oauth, certification: certification(oauth.operation),
      transactionId: 'tx-oauth', effect: async () => { starts += 1; } });
    f.store.applyKills('install-1', globalKill(), f.now() + 1);
    const callback = () => f.adapters.oauthCallback({ binding: oauth,
      certification: certification(oauth.operation), transactionId: 'tx-oauth',
      effect: async () => { callbacks += 1; } });
    await assert.rejects(callback(), /capability_rejected/u);
    await assert.rejects(callback(), /capability_rejected/u);
    assert.deepEqual({ starts, callbacks }, { starts: 1, callbacks: 0 });
    const row = f.database.prepare(`SELECT state FROM connector_policy_v2_oauth_pending
      WHERE transaction_id = 'tx-oauth'`).get() as { state: string };
    assert.equal(row.state, 'invalidated');
  } finally { f.database.close(); }
});

test('OAuth pending is durable before provider start and is invalidated when start fails', async () => {
  const f = fixture();
  try {
    const oauth = binding(ConnectorPolicyOperation.OauthStart);
    await assert.rejects(f.adapters.oauthStart({ binding: oauth,
      certification: certification(oauth.operation), transactionId: 'tx-failed',
      effect: async () => {
        const row = f.database.prepare(`SELECT state FROM connector_policy_v2_oauth_pending
          WHERE transaction_id = 'tx-failed'`).get() as { state: string };
        assert.equal(row.state, 'pending');
        throw new Error('provider_start_failed');
      } }), /provider_start_failed/u);
    const final = f.database.prepare(`SELECT state FROM connector_policy_v2_oauth_pending
      WHERE transaction_id = 'tx-failed'`).get() as { state: string };
    assert.equal(final.state, 'invalidated');
  } finally { f.database.close(); }
});

test('OAuth callback claims durable cleanup ownership before effect and rejects replay', async () => {
  const f = fixture();
  try {
    const oauth = binding(ConnectorPolicyOperation.OauthStart);
    await f.adapters.oauthStart({ binding: oauth, certification: certification(oauth.operation),
      transactionId: 'tx-owner', effect: async () => undefined });
    let callbacks = 0;
    await f.adapters.oauthCallback({ binding: oauth, certification: certification(oauth.operation),
      transactionId: 'tx-owner', effect: async () => { callbacks += 1; } });
    await assert.rejects(f.adapters.oauthCallback({ binding: oauth,
      certification: certification(oauth.operation), transactionId: 'tx-owner',
      effect: async () => { callbacks += 100; } }), /transaction_missing/u);
    await f.adapters.tokenRevoke(binding(ConnectorPolicyOperation.TokenRevoke), async () => undefined);
    assert.equal(callbacks, 1);
  } finally { f.database.close(); }
});

test('OAuth/grant partial effects retain exact pending-cleanup lifecycle authority', async () => {
  for (const path of ['oauth', 'grant'] as const) {
    const f = fixture();
    try {
      if (path === 'oauth') {
        const oauth = binding(ConnectorPolicyOperation.OauthStart);
        await f.adapters.oauthStart({ binding: oauth, certification: certification(oauth.operation),
          transactionId: 'tx-partial', effect: async () => undefined });
        await assert.rejects(f.adapters.oauthCallback({ binding: oauth,
          certification: certification(oauth.operation), transactionId: 'tx-partial',
          effect: async () => { throw new Error('partial'); } }), /partial/u);
      } else {
        const create = binding(ConnectorPolicyOperation.GrantCreate);
        await assert.rejects(f.adapters.grantCreate({ binding: create,
          certification: certification(create.operation), effect: async () => {
            throw new Error('partial');
          } }), /partial/u);
      }
      await f.adapters.credentialDelete(binding(ConnectorPolicyOperation.CredentialDelete),
        async () => undefined);
      const owner = f.database.prepare(`SELECT state FROM connector_policy_v2_grant_owner`).get() as {
        state: string;
      };
      assert.equal(owner.state, 'pending_cleanup');
    } finally { f.database.close(); }
  }
});

test('durable epoch and exact account/body are rechecked and mismatch burns one-use capability', async () => {
  const f = fixture();
  try {
    const use = binding(ConnectorPolicyOperation.CredentialUse);
    const issued = await f.adapters.issue({ binding: use, certification: certification(use.operation) });
    assert.ok(issued);
    let decrypts = 0;
    await assert.rejects(f.adapters.consume(issued, { ...use, accountId: 'account-2' },
      async () => { decrypts += 1; }), /capability_rejected/u);
    await assert.rejects(f.adapters.consume(issued, use, async () => { decrypts += 1; }),
      /capability_rejected/u);
    const staleBindings = [use, { ...use, consumerBody: 'claude' },
      binding(ConnectorPolicyOperation.PlacementWrite)];
    const staleCapabilities = await Promise.all(staleBindings.map(item => f.adapters.issue({
      binding: item, certification: certification(item.operation),
    })));
    assert.equal(staleCapabilities.every(Boolean), true);
    f.store.applyKills('install-1', globalKill(), f.now() + 1);
    for (const [index, item] of staleBindings.entries()) {
      await assert.rejects(f.adapters.consume(staleCapabilities[index]!, item,
        async () => { decrypts += 1; }), /capability_rejected/u);
    }
    assert.equal(decrypts, 0);
  } finally { f.database.close(); }
});

test('kill arriving after nonce consumption but before effect still produces zero provider I/O', async () => {
  const f = fixture();
  try {
    const use = binding(ConnectorPolicyOperation.CredentialUse);
    const capability = await f.adapters.issue({ binding: use, certification: certification(use.operation) });
    assert.ok(capability);
    let effects = 0;
    const pending = f.adapters.consume(capability, use, async () => { effects += 1; });
    f.store.applyKills('install-1', globalKill(), f.now() + 1);
    await assert.rejects(pending, /capability_rejected/u);
    assert.equal(effects, 0);
  } finally { f.database.close(); }
});

test('lifecycle revoke/delete/remove bypass kill but enforce exact durable ownership', async () => {
  const f = fixture();
  try {
    const place = binding(ConnectorPolicyOperation.PlacementWrite);
    await f.adapters.placementWrite({ binding: place, certification: certification(place.operation),
      opaqueGrantRef: 'grantref:opaque-1', effect: async () => undefined });
    f.store.applyKills('install-1', globalKill(), f.now() + 1);
    let effects = 0;
    for (const operation of [ConnectorPolicyOperation.GrantList, ConnectorPolicyOperation.GrantRemove,
      ConnectorPolicyOperation.TokenRevoke, ConnectorPolicyOperation.CredentialDelete,
      ConnectorPolicyOperation.PlacementRemove]) {
      const method = operation === ConnectorPolicyOperation.GrantList ? f.adapters.grantList.bind(f.adapters)
        : operation === ConnectorPolicyOperation.GrantRemove ? f.adapters.grantRemove.bind(f.adapters)
          : operation === ConnectorPolicyOperation.TokenRevoke ? f.adapters.tokenRevoke.bind(f.adapters)
            : operation === ConnectorPolicyOperation.CredentialDelete
              ? f.adapters.credentialDelete.bind(f.adapters) : f.adapters.placementRemove.bind(f.adapters);
      await method(binding(operation), async () => { effects += 1; });
      await assert.rejects(method(binding(operation, { accountId: 'other' }), async () => {
        effects += 100;
      }), /ownership_rejected/u);
    }
    assert.equal(effects, 5);
  } finally { f.database.close(); }
});

test('grant creation records exact owner before any placement exists', async () => {
  const f = fixture();
  try {
    const create = binding(ConnectorPolicyOperation.GrantCreate);
    await f.adapters.grantCreate({ binding: create, certification: certification(create.operation),
      effect: async () => undefined });
    f.store.applyKills('install-1', globalKill(), f.now());
    let revoked = 0;
    await f.adapters.tokenRevoke(binding(ConnectorPolicyOperation.TokenRevoke),
      async () => { revoked += 1; });
    assert.equal(revoked, 1);
  } finally { f.database.close(); }
});

test('kill enqueues one idempotent cleanup per Claude/Codex/bridge and crash lease resumes', async () => {
  const f = fixture();
  try {
    for (const consumerBody of ['claude', 'codex']) {
      const place = binding(ConnectorPolicyOperation.PlacementWrite, { consumerBody });
      await f.adapters.placementWrite({ binding: place, certification: certification(place.operation),
        opaqueGrantRef: 'grantref:opaque-1', effect: async () => undefined });
    }
    const watcher = new ConnectorKillRevisionWatcher(f.store, 'install-1', 30_000);
    f.store.applyKills('install-1', globalKill(), f.now());
    assert.equal(watcher.poll(), true, 'revision is visible without restart within bounded poll');
    assert.equal(f.store.removalTelemetry(f.now()).pending, 3);
    const crashed = f.store.claimRemoval(f.now(), 100);
    assert.ok(crashed, 'worker crashed after durable lease');
    f.setNow(f.now() + 101);
    const calls = new Set<string>();
    const resumed = f.store.claimRemoval(f.now(), 100);
    assert.ok(resumed);
    assert.throws(() => f.store.completeRemoval(crashed, f.now()), /lease_stale/u);
    calls.add(resumed.taskKey);
    f.store.completeRemoval(resumed, f.now());
    const apply = async (_task: unknown, key: string) => { calls.add(key); };
    const worker = new ConnectorPolicyV2RemovalWorker(f.store,
      { removeClaude: apply, removeCodex: apply, closeBridge: apply }, f.now);
    while (await worker.runOne()) { /* drain */ }
    assert.equal(calls.size, 3);
    assert.deepEqual(f.store.removalTelemetry(f.now()),
      { pending: 0, overdue: 0, p99LatencyMs: 101, withinSla: true, slaMs: 30_000 });
    const remaining = f.database.prepare('SELECT count(*) AS count FROM connector_policy_v2_placement')
      .get() as { count: number };
    assert.equal(remaining.count, 0, 'current Claude and Codex placements are removed');
    f.store.applyKills('install-1', globalKill(), f.now() + 1);
    assert.equal(f.store.removalTelemetry(f.now() + 1).pending, 0, 'repeated kill is idempotent');
  } finally { f.database.close(); }
});

test('operation-scoped service kill also removes already placed body access', async () => {
  const f = fixture();
  try {
    const place = binding(ConnectorPolicyOperation.PlacementWrite);
    await f.adapters.placementWrite({ binding: place, certification: certification(place.operation),
      opaqueGrantRef: 'grantref:opaque-1', effect: async () => undefined });
    f.store.applyKills('install-1', { global: false, providers: [], serviceOperations: [{
      serviceId: 'gmail', operation: ConnectorPolicyOperation.CredentialUse,
    }] }, f.now());
    assert.equal(f.store.removalTelemetry(f.now()).pending, 2);
  } finally { f.database.close(); }
});

test('OAuth-only service kill does not remove unrelated existing body placement', async () => {
  const f = fixture();
  try {
    const place = binding(ConnectorPolicyOperation.PlacementWrite);
    await f.adapters.placementWrite({ binding: place, certification: certification(place.operation),
      opaqueGrantRef: 'grantref:opaque-1', effect: async () => undefined });
    f.store.applyKills('install-1', { global: false, providers: [], serviceOperations: [{
      serviceId: 'gmail', operation: ConnectorPolicyOperation.OauthStart,
    }] }, f.now());
    assert.equal(f.store.removalTelemetry(f.now()).pending, 0);
  } finally { f.database.close(); }
});

test('exact composite identity and hashed task keys resist shared grant and delimiter collisions', async () => {
  const f = fixture();
  try {
    const identities = [
      { accountId: 'a:b', grantId: 'c' },
      { accountId: 'a', grantId: 'b:c' },
      { accountId: 'second', grantId: 'c' },
    ];
    for (const identity of identities) {
      const place = binding(ConnectorPolicyOperation.PlacementWrite, identity);
      await f.adapters.placementWrite({ binding: place, certification: certification(place.operation),
        opaqueGrantRef: `grantref:${identity.accountId}:${identity.grantId}`,
        effect: async () => undefined });
    }
    const counts: { placements: number; owners: number } = f.database.prepare(`SELECT
      (SELECT count(*) FROM connector_policy_v2_placement) AS placements,
      (SELECT count(*) FROM connector_policy_v2_grant_owner) AS owners`).get() as {
        placements: number; owners: number;
      };
    assert.deepEqual(counts, { placements: 3, owners: 3 });
    f.store.applyKills('install-1', globalKill(), f.now());
    const tasks: Array<{ task_key: string }> = f.database
      .prepare(`SELECT task_key FROM connector_policy_v2_removal_queue`).all() as Array<{ task_key: string }>;
    assert.equal(tasks.length, 6, 'each exact account gets one body and one bridge task');
    assert.equal(new Set(tasks.map(task => task.task_key)).size, 6);
    assert.equal(tasks.every(task => /^[A-Za-z0-9_-]{43}$/u.test(task.task_key)), true);
  } finally { f.database.close(); }
});

test('late placement writer fails revision commit and queues exact compensating cleanup', async () => {
  const f = fixture();
  try {
    const place = binding(ConnectorPolicyOperation.PlacementWrite);
    let releaseEffect!: () => void;
    let effectStarted!: () => void;
    const started = new Promise<void>(resolve => { effectStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseEffect = resolve; });
    const pending = f.adapters.placementWrite({ binding: place,
      certification: certification(place.operation), opaqueGrantRef: 'grantref:late',
      effect: async () => { effectStarted(); await release; } });
    await started;
    f.store.applyKills('install-1', globalKill(), f.now() + 1);
    releaseEffect();
    await assert.rejects(pending, /placement_commit_stale/u);
    const placements = f.database.prepare(`SELECT count(*) AS count
      FROM connector_policy_v2_placement`).get() as { count: number };
    assert.equal(placements.count, 0);
    assert.equal(f.store.removalTelemetry(f.now() + 1).pending, 4);
  } finally { f.database.close(); }
});

test('placement intent survives process crash and reopen schedules fail-safe compensation', async () => {
  const directory = mkdtempSync('/var/tmp/nassaj-m3-placement-');
  const path = join(directory, 'policy.sqlite');
  let database = new Database(path);
  try {
    let store = new SqliteConnectorPolicyV2Store(database, 'install-1', state());
    const place = binding(ConnectorPolicyOperation.PlacementWrite);
    const expected = await store.read('install-1');
    store.beginPlacementIntent(place, 'grantref:crash-window', expected, NOW);
    database.close();
    database = new Database(path);
    store = new SqliteConnectorPolicyV2Store(database, 'install-1', state());
    assert.equal(store.recoverPlacementIntents('install-1'), 0,
      'constructor boot recovery already claimed the orphan intent');
    assert.equal(store.removalTelemetry(Date.now()).pending, 2);
    const intent = database.prepare(`SELECT state FROM connector_policy_v2_placement_intent`)
      .get() as { state: string };
    assert.equal(intent.state, 'compensating');
  } finally {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cleanup completed before late external write is followed by a new post-effect generation', async () => {
  const f = fixture();
  try {
    const place = binding(ConnectorPolicyOperation.PlacementWrite);
    let releaseEffect!: () => void; let effectStarted!: () => void;
    const started = new Promise<void>(resolve => { effectStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseEffect = resolve; });
    const pending = f.adapters.placementWrite({ binding: place,
      certification: certification(place.operation), opaqueGrantRef: 'grantref:late-generation',
      effect: async () => { effectStarted(); await release; } });
    await started;
    f.store.applyKills('install-1', globalKill(), f.now() + 1);
    const noop = async () => undefined;
    const worker = new ConnectorPolicyV2RemovalWorker(f.store,
      { removeClaude: noop, removeCodex: noop, closeBridge: noop }, f.now);
    while (await worker.runOne()) { /* drain pre-effect generation */ }
    assert.equal(f.store.removalTelemetry(f.now() + 1).pending, 0);
    releaseEffect();
    await assert.rejects(pending, /placement_commit_stale/u);
    assert.equal(f.store.removalTelemetry(f.now() + 1).pending, 2,
      'post-effect generation cannot collide with completed pre-effect tasks');
  } finally { f.database.close(); }
});

test('partial placement effect failure durably schedules compensation immediately', async () => {
  const f = fixture();
  try {
    const place = binding(ConnectorPolicyOperation.PlacementWrite);
    await assert.rejects(f.adapters.placementWrite({ binding: place,
      certification: certification(place.operation), opaqueGrantRef: 'grantref:partial',
      effect: async () => { throw new Error('partial_external_failure'); } }),
    /partial_external_failure/u);
    assert.equal(f.store.removalTelemetry(f.now()).pending, 2);
  } finally { f.database.close(); }
});

test('post-effect cleanup preserves original kill time and reports >60s causal SLA breach', async () => {
  const f = fixture();
  try {
    const place = binding(ConnectorPolicyOperation.PlacementWrite);
    let releaseEffect!: () => void; let effectStarted!: () => void;
    const started = new Promise<void>(resolve => { effectStarted = resolve; });
    const release = new Promise<void>(resolve => { releaseEffect = resolve; });
    const pending = f.adapters.placementWrite({ binding: place,
      certification: certification(place.operation), opaqueGrantRef: 'grantref:sla',
      effect: async () => { effectStarted(); await release; } });
    await started;
    f.setNow(NOW + 1); f.store.applyKills('install-1', globalKill(), f.now());
    const noop = async () => undefined;
    const worker = new ConnectorPolicyV2RemovalWorker(f.store,
      { removeClaude: noop, removeCodex: noop, closeBridge: noop }, f.now);
    f.setNow(NOW + 2); while (await worker.runOne()) { /* drain early generation */ }
    f.setNow(NOW + 120_001); releaseEffect();
    await assert.rejects(pending, /placement_commit_stale/u);
    f.setNow(NOW + 121_001); while (await worker.runOne()) { /* drain post-effect generation */ }
    const telemetry = f.store.removalTelemetry(f.now(), 60_000);
    assert.equal(telemetry.withinSla, false);
    assert.ok(telemetry.p99LatencyMs >= 121_000);
  } finally { f.database.close(); }
});

test('M3 placement persistence has no raw secret column or value', async () => {
  const f = fixture();
  try {
    const place = binding(ConnectorPolicyOperation.PlacementWrite);
    await f.adapters.placementWrite({ binding: place, certification: certification(place.operation),
      opaqueGrantRef: 'grantref:opaque-only', effect: async () => undefined });
    const columns: Array<{ name: string }> = f.database
      .prepare('PRAGMA table_info(connector_policy_v2_placement)').all() as Array<{ name: string }>;
    assert.equal(columns.some(column => /secret|credential|token/u.test(column.name)), false);
    const serialized = JSON.stringify(f.database.prepare('SELECT * FROM connector_policy_v2_placement').all());
    assert.equal(serialized.includes('raw-secret'), false);
    assert.match(serialized, /grantref:opaque-only/u);
  } finally { f.database.close(); }
});

test('watcher reserves half the end-to-end SLA for discovery and rejects above 30 seconds', () => {
  const f = fixture();
  try {
    assert.throws(() => new ConnectorKillRevisionWatcher(f.store, 'install-1', 30_001),
      /watch_interval_invalid/u);
  } finally { f.database.close(); }
});

test('active watcher runner observes durable revision without restart and can be stopped', async () => {
  const f = fixture();
  let runner: ConnectorKillRevisionWatchRunner | undefined;
  try {
    const observed = new Promise<void>(resolve => {
      runner = new ConnectorKillRevisionWatchRunner(
        new ConnectorKillRevisionWatcher(f.store, 'install-1', 2), resolve);
    });
    runner!.start();
    f.store.applyKills('install-1', globalKill(), f.now());
    await Promise.race([observed, new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('watch_timeout')), 100).unref();
    })]);
  } finally { await runner?.stop(); f.database.close(); }
});

test('active removal runner serially drains durable tasks within its bounded schedule', async () => {
  const f = fixture();
  let runner: ConnectorPolicyV2RemovalRunner | undefined;
  try {
    const place = binding(ConnectorPolicyOperation.PlacementWrite);
    await f.adapters.placementWrite({ binding: place, certification: certification(place.operation),
      opaqueGrantRef: 'grantref:runner', effect: async () => undefined });
    f.store.applyKills('install-1', globalKill(), f.now());
    let calls = 0; let resolved!: () => void;
    const drained = new Promise<void>(resolve => { resolved = resolve; });
    const effect = async () => { calls += 1; if (calls === 2) resolved(); };
    const worker = new ConnectorPolicyV2RemovalWorker(f.store,
      { removeClaude: effect, removeCodex: effect, closeBridge: effect }, f.now);
    runner = new ConnectorPolicyV2RemovalRunner(worker, 2, error => { throw error; });
    runner.start();
    await Promise.race([drained, new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('removal_runner_timeout')), 100).unref();
    })]);
    assert.equal(f.store.removalTelemetry(f.now()).pending, 0);
  } finally { await runner?.stop(); f.database.close(); }
});
