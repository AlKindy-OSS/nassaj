import { runLocalUpdateBackground } from '../../services/update-writer-lease.js';
/** Named M3 integration adapters. OFF by construction and absent from production imports. */

import {
  captureConnectorPolicySnapshot,
  consumeConnectorPolicyCapability,
  ConnectorPolicyOperation,
  issueConnectorPolicyCapability,
  resolveConnectorPolicy,
  type ConnectorCertificationBinding,
  type ConnectorPolicyBinding,
  type ConnectorPolicyCapability,
} from './connector-policy-v2.js';
import {
  type RemovalTask,
  SqliteConnectorPolicyV2Store,
} from './connector-policy-v2-store.js';

export const CONNECTOR_POLICY_V2_INTEGRATION_ENABLED = false as const;
export const CONNECTOR_KILL_DISCOVERY_SLA_MS = 30_000 as const;
export const CONNECTOR_REMOVAL_SLA_MS = 30_000 as const;
export const CONNECTOR_KILL_TO_REMOVAL_SLA_MS = 60_000 as const;
export const CONNECTOR_POLICY_V2_CUTOVER_EXIT_CONDITIONS = Object.freeze([
  'add_every_connector_policy_v2_table_to_the_M2_guarded_canonical_schema',
  'pass_runtime_fence_preflight_before_enabling_any_adapter',
  'activate_provider_manifests_and_runtime_floor_only_in_one_atomic_cutover',
]);

/** Complete named boundary inventory for the later atomic cutover. */
export const CONNECTOR_POLICY_V2_ADAPTER_PATHS = Object.freeze({
  profileConfigure: ConnectorPolicyOperation.ProfileConfigure,
  grantCreate: ConnectorPolicyOperation.GrantCreate,
  oauthStart: ConnectorPolicyOperation.OauthStart,
  oauthCallback: ConnectorPolicyOperation.OauthStart,
  credentialVerify: ConnectorPolicyOperation.CredentialVerify,
  credentialPromote: ConnectorPolicyOperation.CredentialStoreUnverified,
  credentialDecrypt: ConnectorPolicyOperation.CredentialUse,
  outboundRequest: ConnectorPolicyOperation.CredentialUse,
  tokenRefresh: ConnectorPolicyOperation.TokenRefresh,
  placementWrite: ConnectorPolicyOperation.PlacementWrite,
  grantList: ConnectorPolicyOperation.GrantList,
  grantRemove: ConnectorPolicyOperation.GrantRemove,
  tokenRevoke: ConnectorPolicyOperation.TokenRevoke,
  credentialDelete: ConnectorPolicyOperation.CredentialDelete,
  placementRemove: ConnectorPolicyOperation.PlacementRemove,
} as const);

type Clock = () => Date;
type GuardedInput<T> = Readonly<{ binding: ConnectorPolicyBinding;
  certification: ConnectorCertificationBinding; effect: () => Promise<T> }>;

export class ConnectorPolicyV2InertAdapters {
  readonly #store: SqliteConnectorPolicyV2Store;
  readonly #now: Clock;

  constructor(store: SqliteConnectorPolicyV2Store, now: Clock) {
    this.#store = store;
    this.#now = now;
  }

  async issue(input: Omit<GuardedInput<never>, 'effect'>): Promise<ConnectorPolicyCapability | null> {
    const state = await this.#store.read(input.binding.installationId);
    const snapshot = captureConnectorPolicySnapshot(state, this.#now());
    if (!snapshot) return null;
    const decision = resolveConnectorPolicy({ snapshot, binding: input.binding,
      certification: input.certification, kills: state.kills });
    return issueConnectorPolicyCapability(decision, input.binding, input.certification, this.#store,
      { now: this.#now(), ttlMs: 60_000 });
  }

  async consume<T>(capability: ConnectorPolicyCapability, binding: ConnectorPolicyBinding,
    effect: () => Promise<T>): Promise<T> {
    if (!await consumeConnectorPolicyCapability(capability, binding, this.#store, this.#now())) {
      throw new Error('connector_policy_capability_rejected');
    }
    if (!this.#store.allows(binding)) throw new Error('connector_policy_capability_rejected');
    return effect();
  }

  profileConfigure<T>(input: GuardedInput<T>): Promise<T> { return this.#guard(input); }
  async grantCreate<T>(input: GuardedInput<T>): Promise<T> {
    return this.#guard({ ...input, effect: async () => {
      this.#store.claimGrantOwner(input.binding);
      const result = await input.effect();
      this.#store.finalizeGrantOwner(input.binding);
      return result;
    } });
  }

  async oauthStart<T>(input: GuardedInput<T> & { transactionId: string }): Promise<T> {
    const capability = await this.issue(input);
    if (!capability) throw new Error('connector_policy_capability_rejected');
    this.#store.createOauthPending(input.transactionId, input.binding, this.#now().getTime());
    try {
      return await this.consume(capability, input.binding, input.effect);
    } catch (error) {
      this.#store.invalidateOauthPending(input.transactionId, this.#now().getTime());
      throw error;
    }
  }

  async oauthCallback<T>(input: GuardedInput<T> & { transactionId: string }): Promise<T> {
    const capability = await this.issue(input);
    if (!capability) {
      this.#store.consumeOauthPending(input.transactionId, input.binding);
      throw new Error('connector_policy_capability_rejected');
    }
    const pending = this.#store.consumeOauthPending(input.transactionId, input.binding);
    if (pending !== 'consumed') throw new Error(`connector_oauth_transaction_${pending}`);
    this.#store.claimGrantOwner(input.binding);
    return this.consume(capability, input.binding, async () => {
      const result = await input.effect();
      this.#store.finalizeGrantOwner(input.binding);
      return result;
    });
  }

  credentialVerify<T>(input: GuardedInput<T>): Promise<T> { return this.#guard(input); }
  credentialPromote<T>(input: GuardedInput<T>): Promise<T> { return this.#guard(input); }
  credentialDecrypt<T>(input: GuardedInput<T>): Promise<T> { return this.#guard(input); }
  outboundRequest<T>(input: GuardedInput<T>): Promise<T> { return this.#guard(input); }
  tokenRefresh<T>(input: GuardedInput<T>): Promise<T> { return this.#guard(input); }

  async placementWrite<T>(input: GuardedInput<T> & { opaqueGrantRef: string }): Promise<T> {
    if (!/^grantref:[A-Za-z0-9._:-]+$/u.test(input.opaqueGrantRef)) {
      throw new Error('connector_opaque_grant_ref_invalid');
    }
    return this.#guard({ ...input, effect: async () => {
      const expected = await this.#store.read(input.binding.installationId);
      if (!this.#store.allows(input.binding)) throw new Error('connector_policy_capability_rejected');
      const intentId = this.#store.beginPlacementIntent(input.binding, input.opaqueGrantRef,
        expected, this.#now().getTime());
      let result: T;
      try { result = await input.effect(); }
      catch (error) {
        this.#store.compensatePlacementIntent(intentId);
        throw error;
      }
      if (!this.#store.commitPlacementIntent(intentId)) {
        throw new Error('connector_placement_commit_stale');
      }
      return result;
    } });
  }

  grantList<T>(binding: ConnectorPolicyBinding, effect: () => Promise<T>): Promise<T> {
    return this.#lifecycle(binding, ConnectorPolicyOperation.GrantList, effect);
  }

  grantRemove<T>(binding: ConnectorPolicyBinding, effect: () => Promise<T>): Promise<T> {
    return this.#lifecycle(binding, ConnectorPolicyOperation.GrantRemove, effect);
  }

  tokenRevoke<T>(binding: ConnectorPolicyBinding, effect: () => Promise<T>): Promise<T> {
    return this.#lifecycle(binding, ConnectorPolicyOperation.TokenRevoke, effect);
  }

  credentialDelete<T>(binding: ConnectorPolicyBinding, effect: () => Promise<T>): Promise<T> {
    return this.#lifecycle(binding, ConnectorPolicyOperation.CredentialDelete, effect);
  }

  placementRemove<T>(binding: ConnectorPolicyBinding, effect: () => Promise<T>): Promise<T> {
    return this.#lifecycle(binding, ConnectorPolicyOperation.PlacementRemove, effect);
  }

  async #guard<T>(input: GuardedInput<T>): Promise<T> {
    const capability = await this.issue(input);
    if (!capability) throw new Error('connector_policy_capability_rejected');
    return this.consume(capability, input.binding, input.effect);
  }

  async #lifecycle<T>(binding: ConnectorPolicyBinding, operation: ConnectorPolicyOperation,
    effect: () => Promise<T>): Promise<T> {
    if (binding.operation !== operation || !this.#store.owns(binding)) {
      throw new Error('connector_lifecycle_ownership_rejected');
    }
    return effect();
  }
}

export type RemovalEffects = Readonly<{
  removeClaude(task: RemovalTask, idempotencyKey: string): Promise<void>;
  removeCodex(task: RemovalTask, idempotencyKey: string): Promise<void>;
  closeBridge(task: RemovalTask, idempotencyKey: string): Promise<void>;
}>;

/** One-task durable worker. Expired leases are reclaimed by the store after a crash. */
export class ConnectorPolicyV2RemovalWorker {
  readonly #store: SqliteConnectorPolicyV2Store;
  readonly #effects: RemovalEffects;
  readonly #nowMs: () => number;

  constructor(store: SqliteConnectorPolicyV2Store, effects: RemovalEffects, nowMs: () => number) {
    this.#store = store; this.#effects = effects; this.#nowMs = nowMs;
  }

  async runOne(leaseMs = 15_000): Promise<boolean> {
    return (await runLocalUpdateBackground('connector-removal', () => this.runAdmitted(leaseMs))) ?? false;
  }

  private async runAdmitted(leaseMs: number): Promise<boolean> {
    const task = this.#store.claimRemoval(this.#nowMs(), leaseMs);
    if (!task) return false;
    const effect = task.target === 'claude' ? this.#effects.removeClaude
      : task.target === 'codex' ? this.#effects.removeCodex : this.#effects.closeBridge;
    await effect(task, task.taskKey);
    this.#store.completeRemoval(task, this.#nowMs());
    return true;
  }
}

/** Active queue scheduler; one serial drain prevents overlapping leases. */
export class ConnectorPolicyV2RemovalRunner {
  readonly #worker: ConnectorPolicyV2RemovalWorker;
  readonly #intervalMs: number;
  readonly #onError: (error: unknown) => void;
  #timer: NodeJS.Timeout | null = null;
  #drainPromise: Promise<void> | null = null;

  constructor(worker: ConnectorPolicyV2RemovalWorker, intervalMs: number,
    onError: (error: unknown) => void) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > CONNECTOR_REMOVAL_SLA_MS) {
      throw new Error('connector_removal_runner_interval_invalid');
    }
    this.#worker = worker; this.#intervalMs = intervalMs; this.#onError = onError;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { this.#scheduleDrain(); }, this.#intervalMs);
    this.#timer.unref();
    this.#scheduleDrain();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#drainPromise;
  }

  #scheduleDrain(): void {
    if (this.#drainPromise) return;
    this.#drainPromise = this.#drain().finally(() => { this.#drainPromise = null; });
  }

  async #drain(): Promise<void> {
    try { while (await this.#worker.runOne()) { /* serial durable drain */ } }
    catch (error) { this.#onError(error); }
  }
}
