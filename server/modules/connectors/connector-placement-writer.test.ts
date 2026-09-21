import assert from 'node:assert/strict';
import test from 'node:test';

import type { ConnectorPlacementKey, ConnectorPlacementLease } from '@/modules/database/index.js';
import type { ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';

import {
  fingerprintConnectorPlacementAbsence,
  fingerprintConnectorPlacementMaterial,
  verifyConnectorPlacementFingerprint,
  type ConnectorPlacementFingerprint,
  type ConnectorPlacementMaterial,
} from './connector-placement-material.js';
import {
  runConnectorPlacementWriter,
  type ConnectorPlacementTargetAdapter,
  type ConnectorPlacementWriterLedger,
  type ConnectorPlacementWriterPlan,
} from './connector-placement-writer.js';

const MASTER_KEY = Buffer.alloc(32, 29);
const ENABLED = { NASSAJ_CONNECTOR_RECONCILER_WRITE: '1' };

const fingerprint = (material: ConnectorPlacementMaterial): ConnectorPlacementFingerprint =>
  fingerprintConnectorPlacementMaterial(material, { masterKey: MASTER_KEY });

const keyOf = (key: ConnectorPlacementKey): string =>
  `${key.connectorId}:${key.memberUserId}:${key.bodyProvider}:${key.contractVersion}`;

function normalized(plan: ConnectorPlacementWriterPlan, token: string): ProviderMcpServer {
  return {
    provider: plan.key.bodyProvider,
    name: `nassaj-connector-${plan.key.connectorId}`,
    scope: 'user',
    transport: 'stdio',
    command: 'node',
    args: ['connector.js'],
    env: { CONNECTOR_TOKEN: token },
  };
}

function plan(
  provider: 'claude' | 'codex',
  token: string,
  connectorId = 'drive-u7',
): ConnectorPlacementWriterPlan {
  const key: ConnectorPlacementKey = {
    connectorId, memberUserId: 7, bodyProvider: provider, contractVersion: 'mcp-user-v1',
  };
  const desiredEntry: UpsertProviderMcpServerInput = {
    name: `nassaj-connector-${connectorId}`,
    scope: 'user',
    userId: 7,
    transport: 'stdio',
    command: 'node',
    args: ['connector.js'],
    env: { CONNECTOR_TOKEN: token },
  };
  const draft = {
    key, credentialMode: 'per_member' as const, ownerUserId: 7, scope: 'user' as const,
    desiredEntry,
    desiredMaterial: {} as ConnectorPlacementMaterial,
    sourceRevision: [...token].reduce((sum, character) => sum + character.charCodeAt(0), 0) * 2,
  };
  draft.desiredMaterial = {
    connectorId, memberUserId: 7, bodyProvider: provider, contractVersion: 'mcp-user-v1',
    body: normalized(draft, token), credential: token,
  };
  return draft;
}

type LedgerRecord = {
  desired: ConnectorPlacementFingerprint;
  applied: ConnectorPlacementFingerprint | null;
  generation: number;
  token: number;
  lease: ConnectorPlacementLease | null;
};

class MemoryLedger implements ConnectorPlacementWriterLedger {
  records = new Map<string, LedgerRecord>();
  healthyCalls = 0;
  failNextHealthy = false;
  failNextFailure = false;
  onHealthyCasLoss?: () => void;

  seedApplied(target: ConnectorPlacementWriterPlan, proof: ConnectorPlacementFingerprint): void {
    this.records.set(keyOf(target.key), {
      desired: proof, applied: proof, generation: 1, token: 0, lease: null,
    });
  }

  upsertDesired(key: ConnectorPlacementKey, proof: ConnectorPlacementFingerprint): void {
    const id = keyOf(key);
    const current = this.records.get(id);
    if (!current) {
      this.records.set(id, { desired: proof, applied: null, generation: 1, token: 0, lease: null });
      return;
    }
    if (current.desired.version !== proof.version || current.desired.fingerprint !== proof.fingerprint) {
      current.desired = proof;
      current.generation += 1;
      current.lease = null;
    }
  }

  acquireLease(
    key: ConnectorPlacementKey,
    input: { ownerId: string; nowMs: number; leaseMs: number },
  ): ConnectorPlacementLease | null {
    const record = this.records.get(keyOf(key));
    if (!record || (record.lease && record.lease.expiresAtMs > input.nowMs)) return null;
    record.token += 1;
    record.lease = {
      ...key, ownerId: input.ownerId, desiredGeneration: record.generation,
      sourceRevision: 0, fencingToken: record.token, expiresAtMs: input.nowMs + input.leaseMs,
    };
    return { ...record.lease };
  }

  getConfigWriteProof(lease: ConnectorPlacementLease, nowMs: number) {
    const record = this.records.get(keyOf(lease));
    const current = record?.lease;
    if (
      !record || !current || current.ownerId !== lease.ownerId
      || current.fencingToken !== lease.fencingToken
      || record.generation !== lease.desiredGeneration
      || current.expiresAtMs <= nowMs
    ) return null;
    return { desiredProof: record.desired, priorAppliedProof: record.applied };
  }

  markHealthy(
    lease: ConnectorPlacementLease,
    proof: ConnectorPlacementFingerprint,
    nowMs: number,
  ): boolean {
    this.healthyCalls += 1;
    const record = this.records.get(keyOf(lease));
    if (this.failNextHealthy) {
      this.failNextHealthy = false;
      if (record) record.lease = null;
      this.onHealthyCasLoss?.();
      return false;
    }
    if (!record || !this.getConfigWriteProof(lease, nowMs)) return false;
    record.applied = proof;
    record.lease = null;
    return true;
  }

  markFailure(lease: ConnectorPlacementLease): boolean {
    const record = this.records.get(keyOf(lease));
    if (!record) return false;
    if (record.lease?.fencingToken === lease.fencingToken) record.lease = null;
    if (this.failNextFailure) {
      this.failNextFailure = false;
      return false;
    }
    return true;
  }
}

class MemoryTarget implements ConnectorPlacementTargetAdapter {
  entries = new Map<string, ProviderMcpServer>();
  active = new Map<string, number>();
  maxActive = new Map<string, number>();
  failProvider: 'claude' | 'codex' | null = null;
  afterFirstFence?: () => void;

  async reconcile(
    target: ConnectorPlacementWriterPlan,
    input: Parameters<ConnectorPlacementTargetAdapter['reconcile']>[1],
  ): Promise<{ applied: boolean; after: { present: boolean; raw: unknown | null } }> {
    const id = keyOf(target.key);
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(id, previous.then(() => current));
    await previous;
    const active = (this.active.get(id) ?? 0) + 1;
    this.active.set(id, active);
    this.maxActive.set(id, Math.max(this.maxActive.get(id) ?? 0, active));
    try {
      if (this.failProvider === target.key.bodyProvider) throw new Error('provider failed');
      await input.assertFenceCurrent();
      this.afterFirstFence?.();
      this.afterFirstFence = undefined;
      const before = this.entries.get(id);
      const decision = await input.decide({ present: before !== undefined, raw: before ?? null });
      let applied = false;
      if (decision === 'apply') {
        await input.assertFenceCurrent();
        applied = true;
        if (target.desiredEntry === null) this.entries.delete(id);
        else {
          const token = target.desiredEntry.env?.CONNECTOR_TOKEN ?? '';
          this.entries.set(id, normalized(target, token));
        }
      }
      await Promise.resolve();
      const after = this.entries.get(id);
      const observation = { present: after !== undefined, raw: after ?? null };
      await input.assertAfter(observation);
      await input.assertFenceCurrent();
      return { applied, after: observation };
    } finally {
      this.active.set(id, (this.active.get(id) ?? 1) - 1);
      release();
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }

  materialForObserved(target: ConnectorPlacementWriterPlan, rawEntry: unknown) {
    const entry = rawEntry as ProviderMcpServer;
    const credential = entry.env?.CONNECTOR_TOKEN ?? '';
    return {
      connectorId: target.key.connectorId,
      memberUserId: target.key.memberUserId,
      bodyProvider: target.key.bodyProvider,
      contractVersion: target.key.contractVersion,
      body: entry,
      credential,
    };
  }

  private readonly locks = new Map<string, Promise<void>>();
}

function deps(plans: ConnectorPlacementWriterPlan[], ledger = new MemoryLedger(), target = new MemoryTarget()) {
  let clock = 1_000;
  let owner = 0;
  return {
    deps: {
      loadPlans: async () => plans,
      reloadPlan: async (key: ConnectorPlacementKey) =>
        plans.find((candidate) => keyOf(candidate.key) === keyOf(key)) ?? null,
      stageDesiredIfSourceCurrent: (current: ConnectorPlacementWriterPlan, proof: ConnectorPlacementFingerprint) => {
        const latest = plans.find((candidate) => keyOf(candidate.key) === keyOf(current.key));
        if (latest?.sourceRevision !== current.sourceRevision) return false;
        ledger.upsertDesired(current.key, proof);
        return true;
      },
      ledger,
      target,
      now: () => clock,
      ownerId: () => `019c7f6e-92fd-7000-8000-${String(++owner).padStart(12, '0')}`,
      fingerprint,
      fingerprintAbsence: (key: Omit<ConnectorPlacementMaterial, 'body' | 'credential'>) =>
        fingerprintConnectorPlacementAbsence(key, { masterKey: MASTER_KEY }),
      verify: (material: ConnectorPlacementMaterial, proof: ConnectorPlacementFingerprint) =>
        verifyConnectorPlacementFingerprint(material, proof, { masterKey: MASTER_KEY }).valid,
    },
    ledger,
    target,
    setClock: (value: number) => { clock = value; },
  };
}

test('disabled writer has zero dependency, secret, DB, provider, path, or clock effects', async () => {
  let effects = 0;
  const harness = deps([]);
  const guarded = new Proxy(harness.deps, {
    get() { effects += 1; throw new Error('disabled dependency access'); },
  });
  const result = await runConnectorPlacementWriter({ env: {}, deps: guarded });
  assert.equal(effects, 0);
  assert.equal(result.state, 'disabled');
});

test('collision is blocked without mutation or fingerprint disclosure', async () => {
  const targetPlan = plan('claude', 'desired-secret');
  const companion = plan('codex', 'desired-secret');
  companion.sourceRevision = targetPlan.sourceRevision;
  const harness = deps([targetPlan, companion]);
  const unknownRaw = Object.assign(normalized(targetPlan, 'desired-secret'), { unknown: true });
  harness.target.entries.set(keyOf(targetPlan.key), unknownRaw);
  const result = await runConnectorPlacementWriter({ env: ENABLED, deps: harness.deps });
  assert.equal(result.state, 'partial');
  assert.equal(result.metrics.targetsBlocked, 1);
  assert.equal(harness.target.entries.get(keyOf(targetPlan.key)), unknownRaw);
  assert.equal(JSON.stringify(result).includes('desired-secret'), false);
  assert.equal(/[0-9a-f]{64}/.test(JSON.stringify(result)), false);
});

test('rotation adopts exact prior-applied ownership and deletion removes only owned entry', async () => {
  const oldPlan = plan('codex', 'old-secret');
  const nextPlan = plan('codex', 'new-secret');
  const oldClaude = plan('claude', 'old-secret');
  const nextClaude = plan('claude', 'new-secret');
  nextClaude.sourceRevision = nextPlan.sourceRevision;
  oldClaude.sourceRevision = oldPlan.sourceRevision;
  const harness = deps([nextClaude, nextPlan]);
  const oldProof = fingerprintConnectorPlacementMaterial(oldPlan.desiredMaterial!, {
    version: 1,
    masterKey: MASTER_KEY,
  });
  const oldClaudeProof = fingerprintConnectorPlacementMaterial(oldClaude.desiredMaterial!, {
    version: 1,
    masterKey: MASTER_KEY,
  });
  harness.ledger.seedApplied(oldPlan, oldProof);
  harness.ledger.seedApplied(oldClaude, oldClaudeProof);
  harness.target.entries.set(keyOf(nextPlan.key), normalized(oldPlan, 'old-secret'));
  harness.target.entries.set(keyOf(nextClaude.key), normalized(oldClaude, 'old-secret'));
  const rotated = await runConnectorPlacementWriter({ env: ENABLED, deps: harness.deps });
  assert.equal(rotated.state, 'verified');
  assert.equal(harness.target.entries.get(keyOf(nextPlan.key))?.env?.CONNECTOR_TOKEN, 'new-secret');

  const deletePlan = {
    ...nextPlan,
    desiredEntry: null,
    desiredMaterial: null,
    sourceRevision: 2_000,
  };
  const deleteClaude = {
    ...nextClaude,
    desiredEntry: null,
    desiredMaterial: null,
    sourceRevision: 2_000,
  };
  const removed = await runConnectorPlacementWriter({
    env: ENABLED,
    deps: deps([deleteClaude, deletePlan], harness.ledger, harness.target).deps,
  });
  assert.equal(removed.state, 'verified');
  assert.equal(harness.target.entries.has(keyOf(nextPlan.key)), false);
});

test('expired lease during locked transaction converges forward in the same invocation', async () => {
  const targetPlan = plan('claude', 'secret');
  const companion = plan('codex', 'secret');
  companion.sourceRevision = targetPlan.sourceRevision;
  const harness = deps([targetPlan, companion]);
  harness.target.afterFirstFence = () => harness.setClock(40_000);
  const result = await runConnectorPlacementWriter({ env: ENABLED, deps: harness.deps });
  assert.equal(result.state, 'verified', JSON.stringify(result));
  assert.equal(result.metrics.convergeForwardAttempts, 1);
});

test('same target serializes while split targets preserve explicit partial success', async () => {
  const claude = plan('claude', 'a');
  const codexPair = plan('codex', 'a');
  codexPair.sourceRevision = claude.sourceRevision;
  const sharedTarget = new MemoryTarget();
  const first = deps([claude, codexPair], new MemoryLedger(), sharedTarget);
  const second = deps([claude, codexPair], new MemoryLedger(), sharedTarget);
  const [one, two] = await Promise.all([
    runConnectorPlacementWriter({ env: ENABLED, deps: first.deps }),
    runConnectorPlacementWriter({ env: ENABLED, deps: second.deps }),
  ]);
  assert.equal(one.state, 'verified');
  assert.equal(two.state, 'verified');
  assert.equal(sharedTarget.maxActive.get(keyOf(claude.key)), 1);

  const codex = plan('codex', 'a');
  codex.sourceRevision = claude.sourceRevision;
  const split = deps([claude, codex]);
  split.target.failProvider = 'codex';
  const partial = await runConnectorPlacementWriter({ env: ENABLED, deps: split.deps });
  assert.equal(partial.state, 'partial');
  assert.equal(partial.metrics.targetsVerified, 1);
  assert.equal(partial.metrics.targetsFailed, 1);
  assert.equal(split.target.entries.has(keyOf(claude.key)), true);
});

test('CAS loss after verified write converges by adopting the saved target', async () => {
  const targetPlan = plan('codex', 'secret');
  const companion = plan('claude', 'secret');
  companion.sourceRevision = targetPlan.sourceRevision;
  const harness = deps([companion, targetPlan]);
  harness.ledger.failNextHealthy = true;
  const result = await runConnectorPlacementWriter({ env: ENABLED, deps: harness.deps });
  assert.equal(result.state, 'verified');
  assert.equal(result.metrics.convergeForwardAttempts, 1);
  assert.equal(harness.ledger.healthyCalls, 3, 'two targets plus one CAS-loss retry');
});

test('CAS loss reloads exact current source and never restages the stale credential', async () => {
  const claude = plan('claude', 'old');
  const codex = plan('codex', 'old');
  codex.sourceRevision = claude.sourceRevision;
  const plans = [claude, codex];
  const harness = deps(plans);
  harness.ledger.failNextHealthy = true;
  harness.ledger.onHealthyCasLoss = () => {
    const nextClaude = plan('claude', 'new');
    const nextCodex = plan('codex', 'new');
    nextCodex.sourceRevision = nextClaude.sourceRevision;
    plans.splice(0, plans.length, nextClaude, nextCodex);
  };
  const result = await runConnectorPlacementWriter({ env: ENABLED, deps: harness.deps });
  assert.equal(result.state, 'verified', JSON.stringify(result));
  assert.equal(harness.target.entries.get(keyOf(claude.key))?.env?.CONNECTOR_TOKEN, 'new');
  assert.equal(harness.target.entries.get(keyOf(codex.key))?.env?.CONNECTOR_TOKEN, 'new');
});

test('failed collision CAS converges before reporting the durable blocked outcome', async () => {
  const claude = plan('claude', 'desired');
  const codex = plan('codex', 'desired');
  codex.sourceRevision = claude.sourceRevision;
  const harness = deps([claude, codex]);
  harness.ledger.failNextFailure = true;
  harness.target.entries.set(
    keyOf(claude.key),
    Object.assign(normalized(claude, 'desired'), { unmanaged: true }),
  );
  const result = await runConnectorPlacementWriter({ env: ENABLED, deps: harness.deps });
  assert.equal(result.metrics.targetsBlocked, 1);
  assert.ok(result.metrics.convergeForwardAttempts >= 1);
});

test('empty, single, or duplicate target plans are explicit partial failures', async () => {
  const claude = plan('claude', 'secret');
  const mixedCodex = plan('codex', 'newer-secret');
  for (const plans of [[], [claude], [claude, { ...claude }], [claude, mixedCodex]]) {
    const harness = deps(plans);
    const result = await runConnectorPlacementWriter({ env: ENABLED, deps: harness.deps });
    assert.equal(result.state, 'partial');
    assert.equal(result.metrics.targetsVerified, 0);
    assert.ok(result.metrics.targetsFailed > 0);
  }
});
