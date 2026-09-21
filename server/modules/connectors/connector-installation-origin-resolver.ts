/** Canonical installation-origin authority. Runtime resolution is database-only. */

import { randomUUID } from 'node:crypto';

import type { Database } from 'better-sqlite3';

import type { ConnectorSetupStore } from './connector-setup-store.js';

const CONNECTOR_OAUTH_CALLBACK_PATH = '/connectors/oauth/callback';

export type ConnectorResolvedInstallationOrigin = Readonly<{
  source: 'database';
  installationId: string;
  canonicalOrigin: string;
  callbackUrl: string;
  originRevision: number;
}>;

export type ConnectorEnvironmentOriginProposal = Readonly<{
  source: 'environment_proposal';
  canonicalOrigin: string;
  callbackUrl: string;
}>;

type OriginRow = { canonicalOrigin: string };
type PolicyRow = { stateJson: string; killRevision: number };
type OriginPolicyState = {
  policySchemaVersion: number; policyEpoch: number; originRevision: number;
  writerEpoch: number; killRevision: number;
  kills: { global: boolean; providers: readonly string[]; serviceOperations: readonly unknown[] };
  [key: string]: unknown;
};

const validId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);

const loopback = (hostname: string): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
const canonicalizeOrigin = (raw: string, allowLoopbackDevelopment: boolean): string => {
  if (typeof raw !== 'string' || raw.length > 2048 || raw.trim() !== raw) {
    throw new Error('connector_installation_origin_invalid');
  }
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('connector_installation_origin_invalid'); }
  const onlyOrigin = !parsed.username && !parsed.password && !parsed.search && !parsed.hash
    && parsed.pathname === '/' && Boolean(parsed.hostname) && raw === parsed.origin;
  const allowed = parsed.protocol === 'https:'
    || (allowLoopbackDevelopment && parsed.protocol === 'http:' && loopback(parsed.hostname));
  if (!onlyOrigin || !allowed) throw new Error('connector_installation_origin_invalid');
  return parsed.origin;
};

const parsePolicy = (row: PolicyRow | undefined): OriginPolicyState => {
  if (!row) throw new Error('connector_origin_policy_missing');
  let policy: OriginPolicyState;
  try { policy = JSON.parse(row.stateJson) as OriginPolicyState; }
  catch { throw new Error('connector_origin_policy_corrupt'); }
  if (policy.policySchemaVersion !== 2 || policy.killRevision !== row.killRevision
    || !Number.isSafeInteger(policy.originRevision) || policy.originRevision < 1
    || !Number.isSafeInteger(policy.policyEpoch) || policy.policyEpoch < 1
    || !Number.isSafeInteger(policy.writerEpoch) || policy.writerEpoch < 1) {
    throw new Error('connector_origin_policy_corrupt');
  }
  return policy;
};

/** Parses an operator-supplied environment value as a proposal only; it is never runtime authority. */
export const connectorEnvironmentOriginProposal = (
  raw: string | undefined,
  allowLoopbackDevelopment = false,
): ConnectorEnvironmentOriginProposal | null => {
  if (raw === undefined || raw === '') return null;
  const canonicalOrigin = canonicalizeOrigin(raw, allowLoopbackDevelopment);
  return Object.freeze({ source: 'environment_proposal' as const, canonicalOrigin,
    callbackUrl: `${canonicalOrigin}${CONNECTOR_OAUTH_CALLBACK_PATH}` });
};

export type ConnectorOriginRotationFence = Readonly<{
  runFencedMutation: (effect: () => void, advanceWriterEpoch: boolean) => boolean;
}>;

export type ConnectorOriginRotationHooks = Readonly<{
  /** Runs inside the SQLite transaction; throwing rolls the rotation back. */
  enqueueRemovals?: (input: Readonly<{ installationId: string; nowMs: number }>) => void;
  /** Runs inside the SQLite transaction and must be a local durable audit write. */
  audit?: (input: Readonly<{ installationId: string; actorUserId: number;
    priorOrigin: string; nextOrigin: string; priorRevision: number; nextRevision: number;
    policyEpoch: number; writerEpoch: number; nowMs: number }>) => void;
}>;

/** Resolves only persisted origin and performs fenced, atomic origin rotation. */
export class ConnectorInstallationOriginResolver {
  readonly #database: Database;
  readonly #setupStore: ConnectorSetupStore;
  readonly #allowLoopbackDevelopment: boolean;

  constructor(database: Database, setupStore: ConnectorSetupStore,
    allowLoopbackDevelopment = false) {
    this.#database = database;
    this.#setupStore = setupStore;
    this.#allowLoopbackDevelopment = allowLoopbackDevelopment;
  }

  resolve(installationId: string): ConnectorResolvedInstallationOrigin | null {
    if (!validId(installationId)) throw new Error('connector_installation_id_invalid');
    const row = this.#database.prepare(`SELECT canonical_origin AS canonicalOrigin
      FROM connector_m5_installation_origin WHERE installation_id=?`).get(installationId) as OriginRow | undefined;
    if (!row) return null;
    const canonicalOrigin = canonicalizeOrigin(
      row.canonicalOrigin, this.#allowLoopbackDevelopment,
    );
    if (canonicalOrigin !== row.canonicalOrigin) throw new Error('connector_origin_database_tampered');
    const policy = this.#readPolicy(installationId);
    return Object.freeze({ source: 'database' as const, installationId, canonicalOrigin,
      callbackUrl: `${canonicalOrigin}${CONNECTOR_OAUTH_CALLBACK_PATH}`,
      originRevision: policy.originRevision });
  }

  /**
   * Rotates origin under the caller's live M2 fence. CAS, global kill,
   * invalidations, downgrades, removal intents, authority intent, and audit
   * commit together or not at all.
   */
  rotate(input: Readonly<{ installationId: string; actorUserId: number; proposedOrigin: string;
    expectedOriginRevision: number; nowMs: number; fence: ConnectorOriginRotationFence;
    hooks?: ConnectorOriginRotationHooks }>): ConnectorResolvedInstallationOrigin {
    if (!validId(input.installationId) || !Number.isSafeInteger(input.actorUserId) || input.actorUserId < 1
      || !Number.isSafeInteger(input.expectedOriginRevision) || input.expectedOriginRevision < 1
      || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) throw new Error('connector_origin_rotation_input_invalid');
    const proposedOrigin = canonicalizeOrigin(
      input.proposedOrigin, this.#allowLoopbackDevelopment,
    );
    let resolved: ConnectorResolvedInstallationOrigin | null = null;
    const executed = input.fence.runFencedMutation(() => {
      const current = this.resolve(input.installationId);
      if (!current || current.originRevision !== input.expectedOriginRevision) {
        throw new Error('connector_origin_revision_conflict');
      }
      if (current.canonicalOrigin === proposedOrigin) { resolved = current; return; }
      const policyRow = this.#database.prepare(`SELECT state_json AS stateJson,kill_revision AS killRevision
        FROM connector_policy_v2_state WHERE installation_id=?`).get(input.installationId) as PolicyRow | undefined;
      const policy = parsePolicy(policyRow);
      if (policy.originRevision !== input.expectedOriginRevision) throw new Error('connector_origin_revision_conflict');
      const nextPolicy: OriginPolicyState = Object.freeze({ ...policy,
        policyEpoch: policy.policyEpoch + 1, writerEpoch: policy.writerEpoch + 1,
        originRevision: policy.originRevision + 1, killRevision: policy.killRevision + 1,
        kills: Object.freeze({ ...policy.kills, global: true }) });
      this.#database.prepare(`UPDATE connector_m5_installation_origin SET canonical_origin=?,updated_at_ms=?
        WHERE installation_id=? AND canonical_origin=?`).run(proposedOrigin, input.nowMs,
        input.installationId, current.canonicalOrigin);
      const policyUpdated = this.#database.prepare(`UPDATE connector_policy_v2_state SET state_json=?,kill_revision=?
        WHERE installation_id=? AND state_json=? AND kill_revision=?`).run(JSON.stringify(nextPolicy),
        nextPolicy.killRevision, input.installationId, policyRow!.stateJson, policy.killRevision);
      if (policyUpdated.changes !== 1) throw new Error('connector_origin_revision_conflict');
      this.#database.prepare(`UPDATE connector_setup_local_activation SET valid=0
        WHERE installation_id=?`).run(input.installationId);
      this.#database.prepare(`UPDATE connector_policy_v2_oauth_pending SET state='invalidated',invalidated_at_ms=?
        WHERE installation_id=? AND state='pending'`).run(input.nowMs, input.installationId);
      this.#database.prepare(`UPDATE connector_policy_v2_capability_nonce SET consumed_at=?
        WHERE installation_id=? AND consumed_at IS NULL`).run(String(input.nowMs), input.installationId);
      this.#database.prepare(`UPDATE connector_m5_profile_readiness SET ready=0,valid_origin_revision=NULL
        WHERE installation_id=?`).run(input.installationId);
      this.#setupStore.downgradeForOriginRotation(input.installationId, nextPolicy.policyEpoch,
        nextPolicy.writerEpoch, input.nowMs);
      this.#enqueuePlacementRemovals(input.installationId, input.nowMs);
      input.hooks?.enqueueRemovals?.({ installationId: input.installationId, nowMs: input.nowMs });
      this.#setupStore.createAuthorityIntent({ installationId: input.installationId,
        intentType: 'origin_rotation', expectedWriterEpoch: nextPolicy.writerEpoch,
        minimumPolicyEpoch: nextPolicy.policyEpoch, minimumOriginRevision: nextPolicy.originRevision,
        minimumTrustRevision: this.#trustRevision(input.installationId), evidenceDigest: null,
        nowMs: input.nowMs });
      input.hooks?.audit?.({ installationId: input.installationId, actorUserId: input.actorUserId,
        priorOrigin: current.canonicalOrigin, nextOrigin: proposedOrigin,
        priorRevision: current.originRevision, nextRevision: nextPolicy.originRevision,
        policyEpoch: nextPolicy.policyEpoch, writerEpoch: nextPolicy.writerEpoch, nowMs: input.nowMs });
      resolved = Object.freeze({ source: 'database' as const, installationId: input.installationId,
        canonicalOrigin: proposedOrigin, callbackUrl: `${proposedOrigin}${CONNECTOR_OAUTH_CALLBACK_PATH}`,
        originRevision: nextPolicy.originRevision });
    }, true);
    if (!executed || !resolved) throw new Error('connector_origin_rotation_fence_rejected');
    return resolved;
  }

  #readPolicy(installationId: string): OriginPolicyState {
    return parsePolicy(this.#database.prepare(`SELECT state_json AS stateJson,kill_revision AS killRevision
      FROM connector_policy_v2_state WHERE installation_id=?`).get(installationId) as PolicyRow | undefined);
  }

  #trustRevision(installationId: string): number {
    const row = this.#database.prepare(`SELECT revision FROM connector_setup_trust_bundle
      WHERE installation_id=?`).get(installationId) as { revision: number } | undefined;
    return row?.revision ?? 0;
  }

  #enqueuePlacementRemovals(installationId: string, nowMs: number): void {
    const rows = this.#database.prepare(`SELECT installation_id AS installationId,user_id AS userId,ownership,
      provider_id AS providerId,service_id AS serviceId,account_id AS accountId,grant_id AS grantId,
      consumer_body AS consumerBody FROM connector_policy_v2_placement WHERE installation_id=?`)
      .all(installationId) as Array<Record<string, string|number>>;
    const insert = this.#database.prepare(`INSERT INTO connector_setup_removal_intent
      (intent_id,installation_id,user_id,ownership,provider_id,service_id,account_id,grant_id,
       consumer_body,operation,state,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?)`);
    for (const row of rows) insert.run(randomUUID(), row.installationId, row.userId, row.ownership,
      row.providerId, row.serviceId, row.accountId, row.grantId, row.consumerBody,
      'placement.remove', nowMs, nowMs);
  }
}
