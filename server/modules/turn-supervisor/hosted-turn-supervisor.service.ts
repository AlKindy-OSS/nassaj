import { randomUUID } from 'node:crypto';

import { readVendorReceiptInvocation,
  appendVendorTranscriptTurnIdempotent,
  VENDOR_RUNTIME,
  writeVendorTranscriptMeta } from '@/modules/providers/index.js';
import { getConnection } from '@/modules/database/index.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';

// eslint-disable-next-line boundaries/no-unknown -- root-verified process context is a builtins-only leaf outside feature barrels.
import { requireStartupAdmission } from '../../bootstrap-startup-context.js';

import { createHostedVendorAdapter } from './adapters/hosted-vendor-adapter.js';
import {
  createClaudeSdkTurnAdapter,
  isClaudeSdkMechanicalEnabled,
} from './adapters/claude-sdk-adapter.js';
import { TurnAdapterRegistry } from './adapters/registry.js';
import type { HostedTurnProvider } from './adapters/types.js';
import {
  type CoordinationLevel, type OrchestratorConfig, type OrchestratorDependencies,
  type OrchestratorTarget,
} from './orchestrator.js';
import { executeConformantTurn, getServerHarnessConformance } from './conformance.js';
import {
  AdapterTerminalProofAuthority,
  admitResources,
  releaseUndispatchedLease,
  releaseWithExitProof,
} from './resource-admission.js';
import { turnSupervisorRepository } from './repository.js';
import { RECOVERY_SCHEMA_SQL, reconcileOnStartup, SqliteRecoveryStore, WriterEpochFence } from './recovery.js';
import {
  CANCELLATION_SCHEMA_SQL, CancellationCascade, releaseRecoveredCancellationLease,
  resumePendingCancellations,
  SqliteCancellationStore,
} from './cancel-cascade.js';
import { HOSTED_RESULT_SCHEMA_SQL, HostedResultStore, type DurableHostedResult } from './hosted-result-store.js';
import { probeProcess } from './watchdog.js';

export type HostedHarnessMode = 'chat' | 'agent';
export type SupervisedChatProvider = HostedTurnProvider | 'claude';

export const HOSTED_TURN_SUPERVISOR_OWNER_ID = `hosted-turn-supervisor:${process.pid}:${randomUUID()}`;
const FLAG_PREFIX = 'NASSAJ_TURN_SUPERVISOR';

function enabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

/** Server-authoritative provider×mode gate. Agent stays hard-disabled: this
 * adapter is an external completion endpoint, not a native agent harness. */
export function isHostedTurnSupervisorEnabled(
  provider: HostedTurnProvider,
  mode: HostedHarnessMode,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (mode !== 'chat') return false;
  return enabled(env[`${FLAG_PREFIX}_${provider.toUpperCase()}_${mode.toUpperCase()}`]);
}

export class HostedTurnSupervisorError extends Error {
  constructor(readonly code:
    | 'CAPABILITY_UNAVAILABLE'
    | 'IDENTITY_UNAVAILABLE'
    | 'RECOVERY_AMBIGUOUS'
    | 'RECOVERY_REPLAY_UNAVAILABLE'
    | 'CONFORMANCE_FAILED',
  options?: ErrorOptions) {
    super(code, options);
    this.name = 'HostedTurnSupervisorError';
  }
}

export type HostedSupervisorExecuteInput = {
  readonly provider: SupervisedChatProvider;
  readonly mode: HostedHarnessMode;
  readonly coordinationLevel: CoordinationLevel;
  readonly model?: string;
  readonly prompt: string;
  readonly userId: number;
  readonly clientMsgId: string;
  readonly vendorReceiptInvocation?: object;
  readonly sessionId: string | null;
  readonly projectPath?: string;
  readonly onSession: (sessionId: string, isNew: boolean) => void;
};

type ActiveTurn = {
  readonly provider: SupervisedChatProvider;
  readonly userId: number;
  readonly controller: AbortController;
  readonly runId: string;
  readonly rootId: string;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
};

function resolveModel(provider: SupervisedChatProvider, requested?: string): string {
  return requested?.trim() || (provider === 'claude'
    ? 'default'
    : VENDOR_RUNTIME[provider].fallbackModels.DEFAULT);
}

function reviewerTarget(
  provider: SupervisedChatProvider,
  model: string,
  env: NodeJS.ProcessEnv,
): OrchestratorTarget | null {
  const configuredProvider = env.NASSAJ_TURN_SUPERVISOR_REVIEW_PROVIDER;
  const configuredModel = env.NASSAJ_TURN_SUPERVISOR_REVIEW_MODEL?.trim();
  if (
    (configuredProvider === 'kimi' || configuredProvider === 'deepseek'
      || configuredProvider === 'glm' || configuredProvider === 'claude')
    && configuredModel
    && (configuredProvider === 'claude'
      ? isClaudeSdkMechanicalEnabled(env)
      : isHostedTurnSupervisorEnabled(configuredProvider, 'chat', env))
  ) {
    return configuredProvider === provider && configuredModel === model
      ? null
      : { provider: configuredProvider, model: configuredModel };
  }
  const alternate = provider === 'claude'
    ? (model === 'haiku' ? 'sonnet' : 'haiku')
    : VENDOR_RUNTIME[provider].fallbackModels.OPTIONS
      .find((option) => option.value !== model)?.value;
  return alternate ? { provider, model: alternate } : null;
}

/**
 * Live bridge from WS dispatch to the capture-only orchestrator. The only
 * transcript records are the outer user request and final synthesis; planner,
 * worker and reviewer prompts/results never cross this boundary.
 */
export class HostedTurnSupervisorRuntime {
  readonly #registry: TurnAdapterRegistry;
  readonly #active = new Map<string, ActiveTurn>();
  readonly #proofAuthority = new AdapterTerminalProofAuthority();
  readonly #writerFence = new WriterEpochFence();
  #ready: Promise<void> | null = null;
  #cancellationStore: SqliteCancellationStore | null = null;
  #resultStore: HostedResultStore | null = null;
  #recoveryStore: SqliteRecoveryStore | null = null;
  #cascade: CancellationCascade | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    adapter = createHostedVendorAdapter({
      resolveCredential(provider, userId): string | null {
        const resolved = resolveProviderEnv(userId, provider, process.env);
        return resolved[VENDOR_RUNTIME[provider].keyEnv] ?? null;
      },
    }),
    claudeAdapter = createClaudeSdkTurnAdapter({
      enabled: () => isClaudeSdkMechanicalEnabled(env),
    }),
  ) {
    this.#registry = new TurnAdapterRegistry([adapter, claudeAdapter], {
      issueTerminalProof: this.#proofAuthority.bindIssuer(),
    });
  }

  async #ensureReady(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#ready = (async () => {
      const db = getConnection();
      if (requireStartupAdmission()) {
        for (const table of ['turn_cancellation_roots', 'turn_cancellation_runs', 'turn_supervisor_recovery',
          'turn_supervisor_hosted_context', 'turn_supervisor_hosted_results']) {
          if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)) {
            throw new Error('existing_security_turn_supervisor_schema_missing');
          }
        }
      } else {
        db.exec(CANCELLATION_SCHEMA_SQL);
        db.exec(RECOVERY_SCHEMA_SQL);
        db.exec(HOSTED_RESULT_SCHEMA_SQL);
      }
      this.#cancellationStore = new SqliteCancellationStore(db);
      this.#resultStore = new HostedResultStore(db, {
        id: HOSTED_TURN_SUPERVISOR_OWNER_ID, pid: process.pid,
      });
      if (!requireStartupAdmission()) await this.#recoverTranscriptWrites();
      this.#recoveryStore = new SqliteRecoveryStore(
        db,
        ['hosted-vendor-ephemeral', 'claude-sdk-ephemeral'],
      );
      await reconcileOnStartup(this.#recoveryStore, (run) => (
        run.state === 'claimed' ? 'not_dispatched' : 'unknown'
      ));
      this.#cascade = new CancellationCascade(this.#cancellationStore, {
        adapters: new Map(['hosted-vendor-ephemeral', 'claude-sdk-ephemeral'].map((adapterId) => [adapterId, {
          cancel: (runId: string) => {
            for (const active of this.#active.values()) {
              if (active.runId === runId) active.controller.abort('durable_cancel');
            }
          },
          reap: async (runId: string) => {
            for (const active of this.#active.values()) {
              if (active.runId === runId) await active.settled;
            }
          },
        }])),
        releaseLease: async (rootId: string) => {
          releaseRecoveredCancellationLease(db, rootId, { probeProcess });
        },
      });
      await resumePendingCancellations(this.#cancellationStore, this.#cascade);
    })();
    return this.#ready;
  }

  /** Completes durable recovery before the listener accepts supervised turns. */
  /** Run transcript maintenance only after root confirmation and before local application admission. */
  async resumeDeferredStartupMaintenance(): Promise<void> {
    const admission = requireStartupAdmission();
    if (!admission) return;
    if (admission.phase !== 'serving' || !this.#resultStore) throw new Error('root_serving_confirmation_required');
    await this.#recoverTranscriptWrites();
  }

  async #recoverTranscriptWrites(): Promise<void> {
    this.#resultStore!.recoverInterruptedTranscriptWrites((pid) => probeProcess(pid) === 'dead');
    for (const pending of this.#resultStore!.listPending(['kimi', 'deepseek', 'glm'])) await this.#flushResult(pending);
  }

  initialize(): Promise<void> {
    return this.#ensureReady();
  }

  async #flushResult(result: DurableHostedResult): Promise<void> {
    const store = this.#resultStore!;
    if (result.transcriptState === 'written') return;
    if (result.transcriptState === 'writing') store.returnTranscriptPending(result.turnId);
    const claimed = store.claimTranscript(result.turnId);
    if (!claimed) return;
    try {
      // Claude's supervised SDK role is persistSession:false. Its outer message
      // is persisted by the universal conversation shadow at the WS boundary;
      // planner/worker/reviewer content must never enter a Claude transcript.
      if (claimed.provider !== 'claude') {
        await appendVendorTranscriptTurnIdempotent(
          claimed.provider, claimed.sessionId, claimed.projectPath, 'assistant', claimed.text,
          `${claimed.turnId}:assistant`,
        );
      }
      if (!store.markTranscriptWritten(result.turnId)) throw new Error('transcript outbox CAS failed');
    } catch (error) {
      store.returnTranscriptPending(result.turnId);
      throw error;
    }
  }

  supports(input: {
    provider: SupervisedChatProvider;
    mode: HostedHarnessMode;
    coordinationLevel: CoordinationLevel;
    model?: string;
  }): boolean {
    if (!this.enabled({ provider: input.provider, mode: input.mode })) return false;
    const runtime = input.provider === 'claude'
      ? 'claude_agent_sdk_ephemeral'
      : 'hosted_vendor_ephemeral';
    if (!getServerHarnessConformance(this.env).some((cell) => (
      cell.provider === input.provider
      && cell.mode === input.mode
      && cell.runtime === runtime
      && cell.supportedLevels.includes(input.coordinationLevel)
    ))) return false;
    if (input.coordinationLevel === 'delegate_review') {
      return reviewerTarget(input.provider, resolveModel(input.provider, input.model), this.env) !== null;
    }
    return true;
  }

  /** Distinguishes an OFF cell (legacy path untouched) from an armed but
   * unsupported request (explicit refusal, never textual fallback). */
  enabled(input: { provider: SupervisedChatProvider; mode: HostedHarnessMode }): boolean {
    if (input.mode !== 'chat') return false;
    return input.provider === 'claude'
      ? isClaudeSdkMechanicalEnabled(this.env)
      : isHostedTurnSupervisorEnabled(input.provider, input.mode, this.env);
  }

  async preflight(input: {
    provider: SupervisedChatProvider; mode: HostedHarnessMode;
    coordinationLevel: CoordinationLevel; model?: string; userId: number;
  }): Promise<boolean> {
    if (!this.supports(input) || !Number.isSafeInteger(input.userId) || input.userId < 1) return false;
    const model = resolveModel(input.provider, input.model);
    const review = input.coordinationLevel === 'delegate_review'
      ? reviewerTarget(input.provider, model, this.env)
      : null;
    const providers = new Set<SupervisedChatProvider>([input.provider]);
    if (review) {
      if (!['kimi', 'deepseek', 'glm', 'claude'].includes(review.provider)) return false;
      providers.add(review.provider as SupervisedChatProvider);
    }
    for (const provider of providers) {
      const result = await this.#registry.probe({ provider, userId: input.userId });
      if (!result.available || !result.capability) return false;
    }
    return true;
  }

  async execute(input: HostedSupervisorExecuteInput): Promise<{
    text: string;
    model: string;
    sessionId: string;
    isNewSession: boolean;
  }> {
    await this.#ensureReady();
    if (!this.supports(input)) throw new HostedTurnSupervisorError('CAPABILITY_UNAVAILABLE');
    if (!Number.isSafeInteger(input.userId) || input.userId < 1 || !input.clientMsgId.trim()) {
      throw new HostedTurnSupervisorError('IDENTITY_UNAVAILABLE');
    }
    if (!await this.preflight(input)) {
      throw new HostedTurnSupervisorError('CAPABILITY_UNAVAILABLE');
    }

    const adopted = turnSupervisorRepository.adoptMessageCoordinationIngress({
      userId: input.userId,
      clientMsgId: input.clientMsgId,
    });
    if (adopted.action === 'ambiguous' || adopted.action === 'replay_terminal') {
      const replay = this.#resultStore!.get(adopted.turn.turnId);
      if (replay) {
        await this.#flushResult(replay);
        input.onSession(replay.sessionId, replay.isNewSession);
        return {
          text: replay.text, model: replay.model, sessionId: replay.sessionId,
          isNewSession: replay.isNewSession,
        };
      }
    }
    if (adopted.action === 'fingerprint_mismatch' || adopted.action === 'ambiguous') {
      throw new HostedTurnSupervisorError('RECOVERY_AMBIGUOUS');
    }
    if (adopted.action === 'replay_terminal') {
      throw new HostedTurnSupervisorError('RECOVERY_REPLAY_UNAVAILABLE');
    }

    const requestedModel = resolveModel(input.provider, input.model);
    const context = this.#resultStore!.getOrCreateContext({
      turnId: adopted.turn.turnId, provider: input.provider, model: requestedModel,
      sessionId: input.sessionId ?? `${input.provider}_${randomUUID()}`,
      isNewSession: !input.sessionId,
      projectPath: input.projectPath,
    });
    const model = context.model;
    const isNewSession = context.isNewSession;
    const sessionId = context.sessionId;
    const reviewTarget = input.coordinationLevel === 'delegate_review'
      ? reviewerTarget(input.provider, model, this.env) ?? undefined
      : undefined;
    const controller = new AbortController();
    if (this.#active.has(sessionId)) throw new HostedTurnSupervisorError('RECOVERY_AMBIGUOUS');
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    this.#active.set(sessionId, {
      provider: input.provider, userId: input.userId, controller,
      runId: adopted.run.runId, rootId: adopted.turn.turnId, settled, resolveSettled,
    });
    const writerEpoch = this.#recoveryStore!.claimWriter(adopted.run.runId);
    let fenceOpened = false;
    let registryOpened = false;
    try {
      this.#cancellationStore!.createRoot(adopted.turn.turnId);
      this.#cancellationStore!.registerRun(
        adopted.turn.turnId,
        adopted.run.runId,
        input.provider === 'claude' ? 'claude-sdk-ephemeral' : 'hosted-vendor-ephemeral',
      );
      this.#writerFence.open(adopted.run.runId, writerEpoch);
      fenceOpened = true;
      this.#registry.beginExecution(adopted.run.runId, writerEpoch);
      registryOpened = true;
      input.onSession(sessionId, isNewSession);

      if (input.provider !== 'claude' && isNewSession) {
        await writeVendorTranscriptMeta(input.provider, sessionId, input.projectPath, input.prompt);
      }
      if (input.provider !== 'claude') {
        await appendVendorTranscriptTurnIdempotent(
          input.provider, sessionId, input.projectPath, 'user', input.prompt,
          `${adopted.turn.turnId}:user`,
          readVendorReceiptInvocation(input.vendorReceiptInvocation, input.prompt, input.userId),
        );
      }

    const target = Object.freeze({ provider: input.provider, model });
    const dependencies: OrchestratorDependencies = {
      registry: this.#registry,
      repository: turnSupervisorRepository,
      admitRun: async () => {
        return admitResources(getConnection(), {
          turnId: adopted.turn.turnId,
          userId: input.userId,
          ownerId: HOSTED_TURN_SUPERVISOR_OWNER_ID,
          ownerPid: process.pid,
          reservation: { cpuPercent: 5, memoryPercent: 5 },
        });
      },
      releaseRun: async (_orchestratorInput, admission, outcome) => {
        if (outcome === 'not_started') {
          if (!this.#registry.abandonUndispatchedExecution(adopted.run.runId, writerEpoch)) {
            throw new Error('registry refused undispatched execution abandonment');
          }
          if (!releaseUndispatchedLease(getConnection(), {
            leaseId: admission.lease.leaseId, ownerId: HOSTED_TURN_SUPERVISOR_OWNER_ID,
            runId: adopted.run.runId, expectedRunEpoch: adopted.run.epoch,
          })) throw new Error('undispatched hosted lease release was fenced');
          return;
        }
        const proof = this.#registry.closeExecution(adopted.run.runId, writerEpoch);
        if (!proof) throw new Error('registry terminal proof unavailable');
        if (!releaseWithExitProof(getConnection(), {
          leaseId: admission.lease.leaseId,
          ownerId: HOSTED_TURN_SUPERVISOR_OWNER_ID,
          proof,
          adapterProofAuthority: this.#proofAuthority,
        })) throw new Error('hosted turn resource lease release was fenced');
      },
      writerFence: this.#writerFence,
    };
    const config: OrchestratorConfig = {
      root: target,
      planner: target,
      synthesis: target,
      ...(reviewTarget ? { reviewer: reviewTarget } : {}),
      workers: [
        { id: 'worker-1', ...target },
        { id: 'worker-2', ...target },
        { id: 'worker-3', ...target },
      ],
      maxWorkers: 3,
    };

      const conformance = await executeConformantTurn({
        coordinates: {
          provider: input.provider,
          mode: input.mode,
          runtime: input.provider === 'claude'
            ? 'claude_agent_sdk_ephemeral'
            : 'hosted_vendor_ephemeral',
        },
        env: this.env,
        dependencies,
        config,
        turn: {
        coordinationLevel: input.coordinationLevel,
        prompt: input.prompt,
        userId: input.userId,
        turn: adopted.turn,
        run: adopted.run,
        writerEpoch,
        cancellationEpoch: 0,
        hostedResultContext: {
          provider: input.provider, model, sessionId, isNewSession, projectPath: context.projectPath,
        },
        signal: controller.signal,
        },
      });
      if (conformance.status !== 'succeeded' || typeof conformance.text !== 'string') {
        throw new HostedTurnSupervisorError('CONFORMANCE_FAILED');
      }
      const durable = this.#resultStore!.get(adopted.turn.turnId);
      if (!durable) throw new Error('durable hosted result missing after success');
      await this.#flushResult(durable);
      return { text: conformance.text, model, sessionId, isNewSession };
    } finally {
      this.#active.get(sessionId)?.resolveSettled();
      if (registryOpened) {
        this.#registry.abandonUndispatchedExecution(adopted.run.runId, writerEpoch);
      }
      if (fenceOpened) this.#writerFence.close(adopted.run.runId, writerEpoch);
      this.#active.delete(sessionId);
    }
  }

  cancel(input: {
    provider: SupervisedChatProvider;
    sessionId: string;
    userId: number | null;
  }): boolean {
    const active = this.#active.get(input.sessionId);
    if (
      !active
      || active.provider !== input.provider
      || input.userId == null
      || active.userId !== input.userId
    ) return false;
    void this.#cascade?.cancel(active.rootId, 'user_cancelled').catch((error) => {
      console.error('Durable hosted cancellation failed', { error });
    });
    return true;
  }
}

export const hostedTurnSupervisor = new HostedTurnSupervisorRuntime();
