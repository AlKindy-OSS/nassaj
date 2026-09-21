import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import type { ConnectorPlacementFingerprint, ConnectorPlacementMaterial } from './connector-placement-material.js';
import {
  reconcileConnectorPlacements,
  type ConnectorPlacementCompositionSources,
} from './connector-placement-composition.js';

const ENABLED = { NASSAJ_CONNECTOR_RECONCILER_WRITE: '1' };

const connector = (overrides: Record<string, unknown> = {}) => ({
  id: 'drive-u7',
  service: 'google-drive',
  displayName: 'Drive',
  accountLabel: '',
  credentialMode: 'per_member' as const,
  ownerUserId: 7,
  allowsSharing: false,
  enabled: true,
  transport: 'stdio' as const,
  command: 'node',
  args: ['server.js'],
  url: null,
  keyEnvVar: 'DRIVE_KEY',
  keyHeader: null,
  keyHeaderPrefix: '',
  extraEnv: {},
  authMode: 'key' as const,
  createdBy: 7,
  createdAt: '',
  updatedAt: '',
  sourceRevision: 2,
  ...overrides,
});

function proof(material: ConnectorPlacementMaterial): ConnectorPlacementFingerprint {
  return {
    version: 2,
    fingerprint: crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex'),
  };
}

function sources(row = connector()) {
  let connectorReads = 0;
  let materialReads = 0;
  let adapterReads = 0;
  const credentialOverrides: Array<string | undefined> = [];
  let rejectStages = false;
  const fingerprintedMaterials: ConnectorPlacementMaterial[] = [];
  const adapterProviders: Array<'claude' | 'codex'> = [];
  const providerReconciles: Array<'claude' | 'codex'> = [];
  const staged = new Map<string, { proof: ConnectorPlacementFingerprint; revision: number }>();
  const keyOf = (key: { bodyProvider: string }) => key.bodyProvider;
  const ledger: ConnectorPlacementCompositionSources['ledger'] = {
    upsertDesired: () => ({}),
    stageDesiredIfConnectorCurrent: (key, revision, desiredProof, desiredPresent) => {
      assert.equal(revision, row.sourceRevision);
      assert.equal(desiredPresent, row.enabled);
      if (rejectStages) return false;
      staged.set(keyOf(key), { proof: desiredProof, revision });
      return true;
    },
    acquireLease: (key, input) => ({
      ...key,
      ownerId: input.ownerId,
      fencingToken: 1,
      desiredGeneration: 1,
      sourceRevision: staged.get(keyOf(key))!.revision,
      expiresAtMs: input.nowMs + input.leaseMs,
    }),
    getConfigWriteProof: (lease) => ({
      desiredProof: staged.get(keyOf(lease))!.proof,
      priorAppliedProof: null,
    }),
    markHealthy: () => true,
    markFailure: () => true,
  };
  const value: ConnectorPlacementCompositionSources = {
    getConnector: () => {
      connectorReads += 1;
      return row;
    },
    buildInput: (_connector, memberUserId, credentialOverride) => {
      materialReads += 1;
      credentialOverrides.push(credentialOverride);
      return {
        name: 'nassaj-connector-drive-u7',
        scope: 'user',
        userId: memberUserId,
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: row.authMode === 'oauth'
          ? { NASSAJ_GRANT_FILE: '/private/grant.json' }
          : { DRIVE_KEY: credentialOverride ?? 'secret' },
      };
    },
    targetAdapter: (provider) => {
      adapterReads += 1;
      adapterProviders.push(provider);
      return {
        desiredRaw: (input) => ({
          command: input.command,
          args: input.args,
          env: input.env,
        }),
        reconcile: async (input) => {
          providerReconciles.push(provider);
          await input.assertFenceCurrent();
          const before = { present: false, raw: null, normalized: null };
          const decision = await input.decide(before);
          await input.assertFenceCurrent();
          const raw = decision === 'apply' && input.desired
            ? { command: input.desired.command, args: input.desired.args, env: input.desired.env }
            : null;
          const after = { present: raw !== null, raw, normalized: null };
          await input.assertAfter(after);
          await input.assertFenceCurrent();
          return { applied: decision === 'apply', after };
        },
      };
    },
    ledger,
    now: () => 1_000,
    ownerId: () => '11111111-2222-7333-8444-555555555555',
    fingerprint: (material) => {
      fingerprintedMaterials.push(material);
      return proof(material);
    },
    fingerprintAbsence: (key) => proof({ ...key, body: {}, credential: 'absence' }),
    verify: (material, expected) => proof(material).fingerprint === expected.fingerprint,
  };
  return {
    value,
    counts: () => ({ connectorReads, materialReads, adapterReads }),
    fingerprintedMaterials,
    adapterProviders,
    providerReconciles,
    credentialOverrides,
    rejectStages: () => { rejectStages = true; },
  };
}

test('disabled composition has zero DB, secret, adapter, path, or clock dependency reads', async () => {
  let effects = 0;
  const blocked = new Proxy({} as ConnectorPlacementCompositionSources, {
    get() { effects += 1; throw new Error('disabled composition dependency access'); },
  });
  const result = await reconcileConnectorPlacements('drive-u7', 7, {}, blocked);
  assert.equal(result.state, 'disabled');
  assert.equal(effects, 0);
});

test('stable personal snapshot builds and verifies the exact Claude/Codex pair', async () => {
  const harness = sources();
  const result = await reconcileConnectorPlacements('drive-u7', 7, ENABLED, harness.value);
  assert.equal(result.state, 'verified');
  assert.equal(result.metrics.targetsPlanned, 2);
  assert.equal(result.metrics.targetsVerified, 2);
  assert.ok(harness.counts().connectorReads >= 4);
  assert.ok(harness.counts().materialReads >= 2);
  assert.ok(harness.counts().adapterReads >= 4);
  assert.deepEqual(new Set(harness.adapterProviders), new Set(['claude', 'codex']));
  assert.deepEqual(harness.providerReconciles, ['claude', 'codex']);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('actual placement plans for Claude and Codex carry the same opaque grant reference', async () => {
  const harness = sources(connector({ service: 'github' }));
  const grantRef = Object.freeze({
    kind: 'v2' as const, ownership: 'personal' as const, serviceId: 'github', userId: 7,
    grantId: '30000000-0000-4000-8000-000000000001',
    secretRef: '40000000-0000-4000-8000-000000000001', provenance: 'v2',
  });
  harness.value.resolveGrantFanout = async () => new Map([
    ['claude', grantRef], ['codex', grantRef],
  ]);
  harness.value.readGrantSecret = reference => reference === grantRef
    ? Buffer.from('v2-secret') : null;
  const result = await reconcileConnectorPlacements('drive-u7', 7, ENABLED, harness.value);
  assert.equal(result.state, 'verified');
  const refs = harness.fingerprintedMaterials.map(material => material.grantMaterialRef).filter(Boolean);
  assert.ok(refs.length >= 2);
  assert.equal(refs.every(reference => reference === grantRef), true);
  assert.equal(harness.credentialOverrides.includes('v2-secret'), true);
});

test('owner mismatch fails before credential material or provider access', async () => {
  const harness = sources(connector({ ownerUserId: 8 }));
  await assert.rejects(
    () => reconcileConnectorPlacements('drive-u7', 7, ENABLED, harness.value),
    (error: unknown) => (error as { code?: string }).code === 'CONNECTOR_NOT_FOUND',
  );
  assert.deepEqual(harness.counts(), { connectorReads: 1, materialReads: 0, adapterReads: 0 });
  assert.deepEqual(harness.providerReconciles, []);
});

test('source CAS rejection is bounded, fail-closed, and never mutates provider state', async () => {
  const harness = sources();
  harness.rejectStages();
  const result = await reconcileConnectorPlacements('drive-u7', 7, ENABLED, harness.value);
  assert.equal(result.state, 'partial');
  assert.equal(result.metrics.targetsFailed, 2);
  assert.equal(result.metrics.errorsByCode.STALE_WRITE, 2);
  assert.deepEqual(harness.providerReconciles, []);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('fingerprint'), false);
  assert.equal(JSON.stringify(result).includes('/private'), false);
});

test('OAuth placement binds to source revision without returning grant material', async () => {
  const harness = sources(connector({ authMode: 'oauth', sourceRevision: 8 }));
  const result = await reconcileConnectorPlacements('drive-u7', 7, ENABLED, harness.value);
  assert.equal(result.state, 'verified');
  assert.ok(harness.fingerprintedMaterials.some(
    (material) => material.credential === 'oauth-grant:drive-u7:8',
  ));
  assert.equal(JSON.stringify(result).includes('grant.json'), false);
  assert.equal(JSON.stringify(result).includes('oauth-grant'), false);
});

test('disabled connector stages authenticated absence for both targets', async () => {
  const harness = sources(connector({ enabled: false, sourceRevision: 6 }));
  const result = await reconcileConnectorPlacements('drive-u7', 7, ENABLED, harness.value);
  assert.equal(result.state, 'verified');
  assert.equal(result.metrics.targetsVerified, 2);
  assert.equal(harness.counts().materialReads, 0);
  assert.ok(harness.counts().adapterReads >= 2);
});

test('shared scope fails before credential or provider access', async () => {
  const harness = sources(connector({ credentialMode: 'org_shared', ownerUserId: null }));
  await assert.rejects(
    () => reconcileConnectorPlacements('drive-u7', 7, ENABLED, harness.value),
    (error: unknown) => (error as { code?: string }).code === 'CONNECTOR_ORG_SHARED_RECONCILE_DISABLED',
  );
  assert.equal(harness.counts().materialReads, 0);
  assert.equal(harness.counts().adapterReads, 0);
});

test('changing or odd source snapshots fail closed and never reach a provider', async () => {
  const harness = sources();
  let read = 0;
  harness.value.getConnector = () => connector({ sourceRevision: read++ % 2 === 0 ? 2 : 4 });
  await assert.rejects(
    () => reconcileConnectorPlacements('drive-u7', 7, ENABLED, harness.value),
    (error: unknown) => (error as { code?: string }).code === 'CONNECTOR_SOURCE_MUTATION_INCOMPLETE',
  );
  assert.equal(harness.counts().adapterReads, 0);

  const odd = sources(connector({ sourceRevision: 3 }));
  await assert.rejects(
    () => reconcileConnectorPlacements('drive-u7', 7, ENABLED, odd.value),
    (error: unknown) => (error as { code?: string }).code === 'CONNECTOR_SOURCE_MUTATION_INCOMPLETE',
  );
  assert.deepEqual(odd.counts(), { connectorReads: 3, materialReads: 0, adapterReads: 0 });
});

// T-1529 / ADR-138 C4: a present-distribution that only half-succeeds (claude
// written, codex failing) must not leave the verified body carrying the
// credential while the grant never reaches `available_next_session`. The
// composition reconciles to absence: it disables the source and re-runs, which
// sweeps the written body back to absent and returns `needs_reconciliation`.
function partialFailureSources(options: {
  claudePresentWritesFail?: boolean;
  codexPresentWritesFail?: boolean;
  codexAbsenceWritesFail?: boolean;
} = {}) {
  const row = connector({ service: 'github', enabled: true, sourceRevision: 2 });
  const configPresent: Record<'claude' | 'codex', boolean> = { claude: false, codex: false };
  const configRaw: Record<string, unknown> = {};
  const applies: Array<{ provider: 'claude' | 'codex'; present: boolean }> = [];
  const staged = new Map<string, { proof: ConnectorPlacementFingerprint; revision: number }>();
  const applied = new Map<string, ConnectorPlacementFingerprint>();
  let codexPresentWritesFail = options.codexPresentWritesFail ?? true;
  // B-851: a present-write failure only injects the PARTIAL that triggers the
  // rollback. An absence-write failure injects the SECOND fault — a rollback that
  // itself cannot sweep a body — which is the case the distinct state guards.
  let claudePresentWritesFail = options.claudePresentWritesFail ?? false;
  let codexAbsenceWritesFail = options.codexAbsenceWritesFail ?? false;
  const p = (material: ConnectorPlacementMaterial) => ({
    version: 2, fingerprint: crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex'),
  });
  const ledger: ConnectorPlacementCompositionSources['ledger'] = {
    upsertDesired: () => ({}),
    stageDesiredIfConnectorCurrent: (key, revision, desiredProof, desiredPresent) => {
      assert.equal(revision, row.sourceRevision);
      assert.equal(desiredPresent, row.enabled);
      staged.set(key.bodyProvider, { proof: desiredProof, revision });
      return true;
    },
    acquireLease: (key, input) => ({
      ...key, ownerId: input.ownerId, fencingToken: 1, desiredGeneration: 1,
      sourceRevision: staged.get(key.bodyProvider)!.revision,
      expiresAtMs: input.nowMs + input.leaseMs,
    }),
    getConfigWriteProof: (lease) => ({
      desiredProof: staged.get(lease.bodyProvider)!.proof,
      priorAppliedProof: applied.get(lease.bodyProvider) ?? null,
    }),
    markHealthy: (lease, proof) => { applied.set(lease.bodyProvider, proof); return true; },
    markFailure: () => true,
  };
  const targetAdapter = (provider: 'claude' | 'codex') => ({
    desiredRaw: (input: { command: string; args: string[]; env: Record<string, string> }) => ({
      command: input.command, args: input.args, env: input.env,
    }),
    reconcile: async (input: {
      desired: { command: string; args: string[]; env: Record<string, string> } | null;
      assertFenceCurrent(): void | Promise<void>;
      decide(observed: { present: boolean; raw: unknown | null }): 'keep' | 'apply' | Promise<'keep' | 'apply'>;
      assertAfter(after: { present: boolean; raw: unknown | null }): void | Promise<void>;
    }) => {
      if (provider === 'codex' && input.desired !== null && codexPresentWritesFail) {
        throw new Error('codex config unwritable');
      }
      if (provider === 'codex' && input.desired === null && codexAbsenceWritesFail) {
        throw new Error('codex absence unwritable');
      }
      if (provider === 'claude' && input.desired !== null && claudePresentWritesFail) {
        throw new Error('claude config unwritable');
      }
      const before = { present: configPresent[provider], raw: configPresent[provider] ? configRaw[provider] : null };
      await input.assertFenceCurrent();
      const decision = await input.decide(before);
      await input.assertFenceCurrent();
      if (decision === 'apply') {
        if (input.desired) {
          configPresent[provider] = true;
          configRaw[provider] = { command: input.desired.command, args: input.desired.args, env: input.desired.env };
        } else {
          configPresent[provider] = false;
          delete configRaw[provider];
        }
        applies.push({ provider, present: configPresent[provider] });
      }
      const after = { present: configPresent[provider], raw: configPresent[provider] ? configRaw[provider] : null };
      await input.assertAfter(after);
      return { applied: decision === 'apply', after };
    },
  });
  const value: ConnectorPlacementCompositionSources = {
    getConnector: () => row,
    buildInput: (_c, memberUserId, credentialOverride) => ({
      name: 'nassaj-connector-github-u7', scope: 'user', userId: memberUserId,
      transport: 'stdio', command: 'node', args: ['server.js'],
      env: { DRIVE_KEY: credentialOverride ?? 'secret' },
    }),
    targetAdapter,
    ledger,
    now: () => 1_000,
    ownerId: () => '11111111-2222-7333-8444-555555555555',
    fingerprint: p,
    fingerprintAbsence: (key) => p({ ...key, body: {}, credential: 'absence' }),
    verify: (material, expected) => p(material).fingerprint === expected.fingerprint,
    disableConnectorForReconciliation: () => {
      if (!row.enabled) return true;
      row.enabled = false;
      row.sourceRevision += 2;
      return true;
    },
  };
  return {
    value, row, configPresent, applies,
    stopCodexFailures: () => { codexPresentWritesFail = false; codexAbsenceWritesFail = false; },
  };
}

test('T-1529: a half-written present distribution rolls the successful body back to absence', async () => {
  const harness = partialFailureSources();
  const result = await reconcileConnectorPlacements('github-u7', 7, ENABLED, harness.value);

  // The grant must NOT be reported available: state is the rollback signal.
  assert.equal(result.state, 'needs_reconciliation');
  // Read-back: neither engine keeps the credential after the rollback.
  assert.equal(harness.configPresent.claude, false, 'the written Claude body was reconciled to absence');
  assert.equal(harness.configPresent.codex, false, 'the failed Codex body never held the credential');
  // The orphan really existed first, then was removed — not merely never written.
  assert.deepEqual(harness.applies, [
    { provider: 'claude', present: true },
    { provider: 'claude', present: false },
  ]);
  // The source was disabled so no future pass treats the row as distributable.
  assert.equal(harness.row.enabled, false);
  // No secret or private path leaks through the returned envelope.
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('DRIVE_KEY'), false);
});

// B-851 / ADR-138: the compensating absence pass can itself only half-succeed.
// Here Claude's present write fails (so the distribution is PARTIAL and a
// rollback is triggered) while Codex's present write succeeds — so Codex is the
// body actually holding the credential. The rollback then fails to sweep Codex
// (its absence write is unwritable), so the secret genuinely remains in one
// body. The composition must NOT report the same `needs_reconciliation` it uses
// for a clean rollback: it returns `rollback_incomplete` so the caller can see
// residue is possible and retry, instead of trusting a tree it never cleaned.
test('B-851: a rollback that cannot sweep a body reports rollback_incomplete, not needs_reconciliation', async () => {
  const harness = partialFailureSources({
    claudePresentWritesFail: true, // fails the present pass → triggers the rollback
    codexPresentWritesFail: false, // Codex takes the credential during the present pass
    codexAbsenceWritesFail: true, // …and the rollback cannot sweep it back to absent
  });
  const result = await reconcileConnectorPlacements('github-u7', 7, ENABLED, harness.value);

  // The distinct state is the whole point: a partial rollback is NOT a clean one.
  assert.equal(result.state, 'rollback_incomplete');
  assert.notEqual(result.state, 'needs_reconciliation');
  // The preserved writer metrics name that a body was not swept.
  assert.ok(result.metrics.targetsFailed >= 1, 'the unswept body is counted as failed');
  // Read-back proves the residue is real: Codex still carries the credential,
  // Claude never received it (its present write failed).
  assert.equal(harness.configPresent.codex, true, 'the Codex body still holds the credential');
  assert.equal(harness.configPresent.claude, false, 'Claude never received the credential');
  // Codex was written during the present pass and never rolled back — no absence
  // apply reached it, so the orphan persists.
  assert.deepEqual(harness.applies, [{ provider: 'codex', present: true }]);
  // The source was still disabled so no future pass treats the row as distributable.
  assert.equal(harness.row.enabled, false);
  // No secret or private path leaks through the returned envelope.
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('DRIVE_KEY'), false);

  // Once Codex writes heal, re-running the manual reconcile sweeps the residue
  // to absence and the grant is provably clean again (state is no longer partial).
  harness.stopCodexFailures();
  const recovered = await reconcileConnectorPlacements('github-u7', 7, ENABLED, harness.value);
  assert.notEqual(recovered.state, 'rollback_incomplete');
  assert.equal(harness.configPresent.codex, false, 'the residual Codex body is now swept to absence');
  assert.deepEqual(harness.applies, [
    { provider: 'codex', present: true },
    { provider: 'codex', present: false },
  ]);
});
