
import { randomUUID } from 'node:crypto';

import { getConnection, messageAuthorsDb, participantsDb, sessionsDb } from '@/modules/database/index.js';
import {
  appendVendorTranscriptEventIdempotent,
  vendorTranscriptPath,
} from '@/modules/providers/index.js';

// eslint-disable-next-line boundaries/no-unknown -- root-verified process context is a builtins-only leaf outside feature barrels.
import { requireStartupAdmission } from '../../bootstrap-startup-context.js';

import { createCodexCliAdapter } from './adapters/codex-cli-adapter.js';
import { createExtendedCliAdapter } from './adapters/extended-cli-adapter.js';
import { TurnAdapterRegistry } from './adapters/registry.js';
import type { CliTurnProvider, TurnAdapterRegistration } from './adapters/types.js';
import {
  CANCELLATION_SCHEMA_SQL, CancellationCascade, releaseRecoveredCancellationLease,
  SqliteCancellationStore, resumePendingCancellations,
} from './cancel-cascade.js';
import { isCliTurnSupervisorArmed, isCliTurnSupervisorEnabled } from './cli-capability.js';
import {
  HOSTED_RESULT_SCHEMA_SQL, HostedResultStore, type DurableHostedResult,
} from './hosted-result-store.js';
import { executeConformantTurn } from './conformance.js';
import type { CoordinationLevel, OrchestratorDependencies } from './orchestrator.js';
import { RECOVERY_SCHEMA_SQL, reconcileOnStartup, SqliteRecoveryStore, WriterEpochFence } from './recovery.js';
import { AdapterTerminalProofAuthority, admitResources, releaseUndispatchedLease, releaseWithExitProof } from './resource-admission.js';
import { turnSupervisorRepository } from './repository.js';
import { probeProcess } from './watchdog.js';

export type CliHarnessProvider = Exclude<CliTurnProvider, 'claude'>;
export type CliHarnessMode = 'chat';

const SUPERVISED_PROVIDERS = Object.freeze(['codex', 'qwen', 'opencode', 'hermes'] as const);
const ADAPTER_IDS: Readonly<Record<CliHarnessProvider, string>> = Object.freeze({
  codex: 'codex-cli-ephemeral', qwen: 'qwen-cli-supervisor-ephemeral',
  opencode: 'opencode-cli-supervisor-ephemeral', hermes: 'hermes-cli-supervisor-ephemeral',
});
const RUNTIMES = Object.freeze({
  codex: 'codex_cli_ephemeral', qwen: 'qwen_cli_ephemeral',
  opencode: 'opencode_cli_ephemeral', hermes: 'hermes_cli_ephemeral',
} as const);
const DEFAULT_MODELS: Readonly<Record<CliHarnessProvider, string>> = Object.freeze({
  codex: 'gpt-5.3-codex', qwen: 'qwen3-coder-plus',
  opencode: 'opencode/default', hermes: 'qwen/qwen3.8-max',
});
export const CLI_TURN_SUPERVISOR_OWNER_ID = `cli-turn-supervisor:${process.pid}:${randomUUID()}`;

export const CLI_HARNESS_MATRIX = Object.freeze([
  ...(['codex', 'opencode'] as const).map((provider) => Object.freeze({ provider, mode: 'chat', runtime: 'ephemeral_cli', supported: true,
    levels: Object.freeze(['direct', 'delegate', 'delegate_review'] as const) })),
  ...(['qwen', 'hermes'] as const).map((provider) => Object.freeze({
    provider, mode: 'chat', runtime: 'ephemeral_cli', supported: false,
    levels: Object.freeze([]), reason: 'installed_binary_capability_probe_failed' as const,
  })),
  ...(['cursor', 'gemini', 'antigravity', 'kimi'] as const).map((provider) =>
    Object.freeze({ provider, mode: provider === 'kimi' ? 'agent' : 'chat', runtime: 'legacy_cli',
      supported: false, levels: Object.freeze([]),
      reason: 'runtime_persists_state_or_exposes_effectful_tools_without_supervisor_role_cage' as const })),
]);

/** Server-owned capability decision. No browser claim can add a CLI cell. */
export { isCliTurnSupervisorArmed, isCliTurnSupervisorEnabled } from './cli-capability.js';

export class CliTurnSupervisorError extends Error {
  constructor(readonly code:
    | 'CAPABILITY_UNAVAILABLE' | 'IDENTITY_UNAVAILABLE' | 'RECOVERY_AMBIGUOUS'
    | 'RECOVERY_REPLAY_UNAVAILABLE' | 'CONFORMANCE_FAILED', options?: ErrorOptions) {
    super(code, options);
    this.name = 'CliTurnSupervisorError';
  }
}

type Active = Readonly<{
  provider: CliHarnessProvider; userId: number; runId: string; rootId: string;
  controller: AbortController; settled: Promise<void>; resolveSettled(): void;
}>;

export class CliTurnSupervisorRuntime {
  readonly #proofAuthority = new AdapterTerminalProofAuthority();
  readonly #registry: TurnAdapterRegistry;
  readonly #writerFence = new WriterEpochFence();
  readonly #active = new Map<string, Active>();
  #ready: Promise<void> | null = null;
  #recoveryStore: SqliteRecoveryStore | null = null;
  #cancellationStore: SqliteCancellationStore | null = null;
  #resultStore: HostedResultStore | null = null;
  #cascade: CancellationCascade | null = null;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    adapterOrAdapters: TurnAdapterRegistration | readonly TurnAdapterRegistration[] = [
      createCodexCliAdapter(), createExtendedCliAdapter('qwen'),
      createExtendedCliAdapter('opencode'), createExtendedCliAdapter('hermes'),
    ],
  ) {
    const adapters = Array.isArray(adapterOrAdapters) ? adapterOrAdapters : [adapterOrAdapters];
    this.#registry = new TurnAdapterRegistry(adapters, {
      issueTerminalProof: this.#proofAuthority.bindIssuer(),
    });
  }

  supports(input: {
    provider: string; mode: string; coordinationLevel: CoordinationLevel; model?: string;
  }): boolean {
    if (!isCliTurnSupervisorEnabled(input.provider, input.mode, this.env)) return false;
    if (input.coordinationLevel === 'delegate_review') {
      const reviewer = this.env[`NASSAJ_TURN_SUPERVISOR_${input.provider.toUpperCase()}_REVIEW_MODEL`]?.trim();
      const root = input.model?.trim() || DEFAULT_MODELS[input.provider as CliHarnessProvider];
      return Boolean(reviewer && reviewer !== root);
    }
    return true;
  }

  enabledCell(input: { provider: string; mode: string }): boolean {
    return isCliTurnSupervisorArmed(input.provider, input.mode, this.env);
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
      this.#resultStore = new HostedResultStore(db);
      if (!requireStartupAdmission()) await this.#recoverTranscriptWrites();
      this.#recoveryStore = new SqliteRecoveryStore(db, Object.values(ADAPTER_IDS));
      await reconcileOnStartup(this.#recoveryStore, (run) => (
        run.state === 'claimed' ? 'not_dispatched' : 'unknown'
      ));
      this.#cascade = new CancellationCascade(this.#cancellationStore, {
        adapters: new Map(Object.values(ADAPTER_IDS).map((adapterId) => [adapterId, {
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
    for (const pending of this.#resultStore!.listPending(SUPERVISED_PROVIDERS)) await this.#flushResult(pending);
  }

  initialize(): Promise<void> {
    return this.#ensureReady();
  }

  async #flushResult(result: DurableHostedResult): Promise<void> {
    if (!SUPERVISED_PROVIDERS.includes(result.provider as CliHarnessProvider) || result.transcriptState === 'written') return;
    const claimed = this.#resultStore!.claimTranscript(result.turnId);
    if (!claimed) return;
    try {
      await appendVendorTranscriptEventIdempotent(claimed.provider, claimed.sessionId, claimed.projectPath, {
        timestamp: new Date().toISOString(), type: 'response_item',
        payload: {
          type: 'message', id: `${claimed.turnId}:assistant`, role: 'assistant',
          phase: 'final_answer', content: [{ type: 'output_text', text: claimed.text }],
        },
      }, `${claimed.turnId}:assistant`);
      if (!this.#resultStore!.markTranscriptWritten(result.turnId)) {
        throw new Error(`${claimed.provider} transcript outbox acknowledgement failed`);
      }
    } catch (error) {
      this.#resultStore!.returnTranscriptPending(result.turnId);
      throw error;
    }
  }

  async execute(input: {
    provider: CliHarnessProvider; mode: CliHarnessMode; coordinationLevel: CoordinationLevel;
    model?: string; prompt: string; userId: number; clientMsgId: string;
    sessionId: string | null; projectPath?: string;
    onSession(sessionId: string, isNew: boolean): void;
  }): Promise<{ text: string; model: string; sessionId: string; isNewSession: boolean }> {
    await this.#ensureReady();
    if (!this.supports(input)) throw new CliTurnSupervisorError('CAPABILITY_UNAVAILABLE');
    if (!Number.isSafeInteger(input.userId) || input.userId < 1 || !input.clientMsgId.trim()) {
      throw new CliTurnSupervisorError('IDENTITY_UNAVAILABLE');
    }
    const adopted = turnSupervisorRepository.adoptMessageCoordinationIngress({
      userId: input.userId, clientMsgId: input.clientMsgId,
    });
    if (adopted.action === 'fingerprint_mismatch' || adopted.action === 'ambiguous') {
      throw new CliTurnSupervisorError('RECOVERY_AMBIGUOUS');
    }
    if (adopted.action === 'replay_terminal') {
      const replay = this.#resultStore!.get(adopted.turn.turnId);
      if (!replay || replay.provider !== input.provider) {
        throw new CliTurnSupervisorError('RECOVERY_REPLAY_UNAVAILABLE');
      }
      await this.#flushResult(replay);
      input.onSession(replay.sessionId, replay.isNewSession);
      return { text: replay.text, model: replay.model, sessionId: replay.sessionId, isNewSession: replay.isNewSession };
    }
    const model = input.model?.trim() || DEFAULT_MODELS[input.provider];
    const sessionId = input.sessionId ?? `${input.provider}_supervised_${randomUUID()}`;
    const isNewSession = !input.sessionId;
    const controller = new AbortController();
    if (this.#active.has(sessionId)) throw new CliTurnSupervisorError('RECOVERY_AMBIGUOUS');
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    this.#active.set(sessionId, {
      provider: input.provider, userId: input.userId, runId: adopted.run.runId,
      rootId: adopted.turn.turnId, controller, settled, resolveSettled,
    });
    const writerEpoch = this.#recoveryStore!.claimWriter(adopted.run.runId);
    let fenceOpened = false;
    let registryOpened = false;
    try {
      this.#cancellationStore!.createRoot(adopted.turn.turnId);
      this.#cancellationStore!.registerRun(adopted.turn.turnId, adopted.run.runId, ADAPTER_IDS[input.provider]);
      this.#writerFence.open(adopted.run.runId, writerEpoch);
      fenceOpened = true;
      this.#registry.beginExecution(adopted.run.runId, writerEpoch);
      registryOpened = true;
      input.onSession(sessionId, isNewSession);
      const projectPath = input.projectPath ?? process.cwd();
      const transcriptPath = vendorTranscriptPath(input.provider, sessionId, projectPath);
      await appendVendorTranscriptEventIdempotent(input.provider, sessionId, projectPath, {
        timestamp: new Date().toISOString(), type: 'event_msg',
        payload: { type: 'user_message', kind: 'plain', message: input.prompt },
      }, `${adopted.turn.turnId}:user`);
      sessionsDb.createSession(sessionId, input.provider, projectPath, undefined, undefined, undefined, transcriptPath);
      participantsDb.recordSpawn(sessionId, input.userId, { provider: input.provider, projectPath });
      messageAuthorsDb.recordUserMessage(sessionId, input.userId, input.prompt);
      const target = Object.freeze({ provider: input.provider, model });
      const reviewerModel = this.env[`NASSAJ_TURN_SUPERVISOR_${input.provider.toUpperCase()}_REVIEW_MODEL`]?.trim();
      const dependencies: OrchestratorDependencies = {
        registry: this.#registry,
        repository: turnSupervisorRepository,
        admitRun: async () => admitResources(getConnection(), {
          turnId: adopted.turn.turnId, userId: input.userId, ownerId: CLI_TURN_SUPERVISOR_OWNER_ID,
          ownerPid: process.pid, reservation: { cpuPercent: 10, memoryPercent: 10 },
        }),
        releaseRun: async (_execution, admission, outcome) => {
          if (outcome === 'not_started') {
            if (!this.#registry.abandonUndispatchedExecution(adopted.run.runId, writerEpoch)) {
              throw new Error('registry refused undispatched execution abandonment');
            }
            if (!releaseUndispatchedLease(getConnection(), {
              leaseId: admission.lease.leaseId, ownerId: CLI_TURN_SUPERVISOR_OWNER_ID,
              runId: adopted.run.runId, expectedRunEpoch: adopted.run.epoch,
            })) throw new Error('undispatched CLI lease release was fenced');
            return;
          }
          const proof = this.#registry.closeExecution(adopted.run.runId, writerEpoch);
          if (!proof || !releaseWithExitProof(getConnection(), {
            leaseId: admission.lease.leaseId, ownerId: CLI_TURN_SUPERVISOR_OWNER_ID, proof,
            adapterProofAuthority: this.#proofAuthority,
          })) throw new Error('CLI resource lease release was fenced');
        },
        writerFence: this.#writerFence,
      };
      const config = {
        root: target, planner: target, synthesis: target,
        ...(reviewerModel ? { reviewer: { provider: input.provider, model: reviewerModel } } : {}),
        workers: [1, 2, 3].map((id) => ({ id: `${input.provider}-worker-${id}`, ...target })),
        maxWorkers: 3,
      };
      const result = await executeConformantTurn({
        coordinates: { provider: input.provider, mode: 'chat', runtime: RUNTIMES[input.provider] },
        dependencies, config, env: this.env,
        turn: {
          coordinationLevel: input.coordinationLevel, prompt: input.prompt, userId: input.userId,
          turn: adopted.turn, run: adopted.run, writerEpoch, cancellationEpoch: 0,
          hostedResultContext: {
            provider: input.provider, model, sessionId, isNewSession,
            projectPath: input.projectPath,
          },
          signal: controller.signal,
        },
      });
      if (result.status !== 'succeeded' || typeof result.text !== 'string') {
        throw new CliTurnSupervisorError('CONFORMANCE_FAILED', {
          cause: new Error(result.reason ?? result.status),
        });
      }
      const durable = this.#resultStore!.get(adopted.turn.turnId);
      if (!durable) throw new CliTurnSupervisorError('RECOVERY_REPLAY_UNAVAILABLE');
      await this.#flushResult(durable);
      return { text: result.text, model, sessionId, isNewSession };
    } finally {
      this.#active.get(sessionId)?.resolveSettled();
      if (registryOpened) this.#registry.abandonUndispatchedExecution(adopted.run.runId, writerEpoch);
      if (fenceOpened) this.#writerFence.close(adopted.run.runId, writerEpoch);
      this.#active.delete(sessionId);
    }
  }

  cancel(input: { provider: CliHarnessProvider; sessionId: string; userId: number | null }): boolean {
    const active = this.#active.get(input.sessionId);
    if (!active || active.provider !== input.provider || input.userId == null || active.userId !== input.userId) return false;
    void this.#cascade?.cancel(active.rootId, 'user_cancelled').catch((error) => {
      console.error('Durable CLI cancellation failed', { error });
    });
    return true;
  }
}

export const cliTurnSupervisor = new CliTurnSupervisorRuntime();
