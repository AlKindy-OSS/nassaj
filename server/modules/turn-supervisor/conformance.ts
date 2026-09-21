import { createHash } from 'node:crypto';

import {
  TurnOrchestrator,
  TurnOrchestratorError,
  type CoordinationLevel,
  type OrchestratorConfig,
  type OrchestratorDependencies,
  type OrchestratorInput,
} from './orchestrator.js';
import { isClaudeSdkMechanicalEnabled } from './adapters/claude-sdk-adapter.js';
import {
  installedMechanicalCliProbe, isCliTurnSupervisorEnabled,
  type MechanicalCliCapabilityProbe,
} from './cli-capability.js';
import type { TurnProvider } from './adapters/types.js';
import type { ReviewVerdict } from './planner-schema.js';

export type HarnessMode = 'chat';
export type HarnessRuntime =
  | 'hosted_vendor_ephemeral' | 'claude_agent_sdk_ephemeral' | 'codex_cli_ephemeral'
  | 'qwen_cli_ephemeral' | 'opencode_cli_ephemeral' | 'hermes_cli_ephemeral';

export type HarnessCoordinates = {
  readonly provider: string;
  readonly mode: string;
  readonly runtime: string;
};

export type HostedHarnessConformance = HarnessCoordinates & {
  readonly provider: TurnProvider;
  readonly mode: HarnessMode;
  readonly runtime: HarnessRuntime;
  readonly enforcement: 'mechanical';
  readonly execution: 'capture_only';
  readonly spawnAuthority: 'supervisor_only';
  readonly rootEffects: 'denied';
  readonly supportedLevels: readonly CoordinationLevel[];
};

const SUPPORTED_LEVELS = Object.freeze<readonly CoordinationLevel[]>([
  'direct', 'delegate', 'delegate_review',
]);

/** Server-owned matrix. Browser/provider claims cannot add supported cells. */
export const HOSTED_HARNESS_CONFORMANCE: readonly HostedHarnessConformance[] = Object.freeze(
  (['kimi', 'deepseek', 'glm'] as const).map((provider) => Object.freeze({
    provider,
    mode: 'chat' as const,
    runtime: 'hosted_vendor_ephemeral' as const,
    enforcement: 'mechanical' as const,
    execution: 'capture_only' as const,
    spawnAuthority: 'supervisor_only' as const,
    rootEffects: 'denied' as const,
    supportedLevels: SUPPORTED_LEVELS,
  })),
);

const CLAUDE_SDK_HARNESS_CONFORMANCE: HostedHarnessConformance = Object.freeze({
  provider: 'claude',
  mode: 'chat',
  runtime: 'claude_agent_sdk_ephemeral',
  enforcement: 'mechanical',
  execution: 'capture_only',
  spawnAuthority: 'supervisor_only',
  rootEffects: 'denied',
  supportedLevels: SUPPORTED_LEVELS,
});

const CODEX_CLI_HARNESS_CONFORMANCE: HostedHarnessConformance = Object.freeze({
  provider: 'codex', mode: 'chat', runtime: 'codex_cli_ephemeral',
  enforcement: 'mechanical', execution: 'capture_only',
  spawnAuthority: 'supervisor_only', rootEffects: 'denied',
  supportedLevels: SUPPORTED_LEVELS,
});

const EXTENDED_CLI_HARNESS_CONFORMANCE: readonly HostedHarnessConformance[] = Object.freeze(
  (['qwen', 'opencode', 'hermes'] as const).map((provider) => Object.freeze({
    provider, mode: 'chat' as const, runtime: `${provider}_cli_ephemeral` as HarnessRuntime,
    enforcement: 'mechanical' as const, execution: 'capture_only' as const,
    spawnAuthority: 'supervisor_only' as const, rootEffects: 'denied' as const,
    supportedLevels: SUPPORTED_LEVELS,
  })),
);

/** Server-only flags; all extended CLI cells are OFF unless explicitly armed. */
export function isExtendedCliMechanicalEnabled(
  provider: string, env: NodeJS.ProcessEnv = process.env,
  probe: MechanicalCliCapabilityProbe = installedMechanicalCliProbe,
): provider is 'qwen' | 'opencode' | 'hermes' {
  return (provider === 'qwen' || provider === 'opencode' || provider === 'hermes')
    && isCliTurnSupervisorEnabled(provider, 'chat', env, probe);
}

/** Capability output is server-owned and omits Claude unless its reviewed cell is enabled. */
export function getServerHarnessConformance(
  env: NodeJS.ProcessEnv = process.env,
  cliProbe: MechanicalCliCapabilityProbe = installedMechanicalCliProbe,
): readonly HostedHarnessConformance[] {
  const codexReviewer = env.NASSAJ_TURN_SUPERVISOR_CODEX_REVIEW_MODEL?.trim();
  const codexCell = Object.freeze({
    ...CODEX_CLI_HARNESS_CONFORMANCE,
    supportedLevels: Object.freeze<readonly CoordinationLevel[]>([
      'direct', 'delegate', ...(codexReviewer ? ['delegate_review' as const] : []),
    ]),
  });
  return Object.freeze([
    ...HOSTED_HARNESS_CONFORMANCE,
    ...(isClaudeSdkMechanicalEnabled(env) ? [CLAUDE_SDK_HARNESS_CONFORMANCE] : []),
    ...(isCliTurnSupervisorEnabled('codex', 'chat', env, cliProbe) ? [codexCell] : []),
    ...EXTENDED_CLI_HARNESS_CONFORMANCE.filter(({ provider }) => (
      isExtendedCliMechanicalEnabled(provider, env, cliProbe)
    )),
  ]);
}

export type WorkerEvidence = {
  readonly workerId: string;
  readonly artifactHash: string;
  readonly review?: ReviewVerdict & {
    readonly reviewer: Readonly<{ provider: TurnProvider; model: string }>;
  };
};

export type ServerAuthoritativeTurnResult = {
  readonly schemaVersion: 1;
  readonly source: 'turn_supervisor';
  readonly coordinates: Readonly<HarnessCoordinates>;
  readonly coordinationLevel: CoordinationLevel;
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly reason?:
    | 'unsupported_harness' | 'invalid_harness_config' | 'resource_denied'
    | 'provider_unavailable' | 'plan_failed' | 'review_failed' | 'aborted'
    | 'stale_writer' | 'internal_error';
  readonly enforcement: 'mechanical' | 'none';
  readonly execution: 'capture_only';
  readonly fallbackUsed: false;
  readonly root: Readonly<{
    effects: 'denied';
    spawn: 'denied' | 'supervisor_only';
  }>;
  readonly childCount: number;
  readonly workers: readonly WorkerEvidence[];
  readonly responseHash?: string;
  readonly synthesis?: Readonly<{
    artifactHash: string;
    review?: ReviewVerdict & {
      readonly reviewer: Readonly<{ provider: TurnProvider; model: string }>;
    };
  }>;
  /** Ephemeral response for a future transport; this module never publishes it. */
  readonly text?: string;
};

function findHarness(
  coordinates: HarnessCoordinates,
  env: NodeJS.ProcessEnv = process.env,
  cliProbe: MechanicalCliCapabilityProbe = installedMechanicalCliProbe,
): HostedHarnessConformance | undefined {
  return getServerHarnessConformance(env, cliProbe).find((candidate) => (
    candidate.provider === coordinates.provider
    && candidate.mode === coordinates.mode
    && candidate.runtime === coordinates.runtime
  ));
}

function baseResult(
  coordinates: HarnessCoordinates,
  coordinationLevel: CoordinationLevel,
): Omit<ServerAuthoritativeTurnResult, 'status'> {
  return {
    schemaVersion: 1,
    source: 'turn_supervisor',
    coordinates: Object.freeze({ ...coordinates }),
    coordinationLevel,
    enforcement: 'mechanical',
    execution: 'capture_only',
    fallbackUsed: false,
    root: Object.freeze({
      effects: 'denied',
      spawn: coordinationLevel === 'direct' ? 'denied' : 'supervisor_only',
    }),
    childCount: 0,
    workers: Object.freeze([]),
  };
}

function failureReason(error: unknown): ServerAuthoritativeTurnResult['reason'] {
  if (!(error instanceof TurnOrchestratorError)) return 'internal_error';
  return ({
    RESOURCE_DENIED: 'resource_denied',
    PROVIDER_UNAVAILABLE: 'provider_unavailable',
    INVALID_CONFIG: 'invalid_harness_config',
    PLAN_FAILED: 'plan_failed',
    REVIEW_FAILED: 'review_failed',
    ABORTED: 'aborted',
    STALE_WRITER: 'stale_writer',
  } as const)[error.code];
}

/**
 * Executes only a server-allowlisted harness cell and returns immutable,
 * transport-neutral evidence. Failure is data, never a cue to run a legacy
 * root fallback.
 */
export async function executeConformantTurn(input: {
  readonly coordinates: HarnessCoordinates;
  readonly turn: OrchestratorInput;
  readonly config: OrchestratorConfig;
  readonly dependencies: OrchestratorDependencies;
  readonly env?: NodeJS.ProcessEnv;
  /** Server-internal test/startup seam; never populated from a client request. */
  readonly cliProbe?: MechanicalCliCapabilityProbe;
}): Promise<ServerAuthoritativeTurnResult> {
  const base = baseResult(input.coordinates, input.turn.coordinationLevel);
  const harness = findHarness(input.coordinates, input.env, input.cliProbe);
  if (!harness || !harness.supportedLevels.includes(input.turn.coordinationLevel)) {
    return Object.freeze({
      ...base,
      status: 'failed',
      reason: 'unsupported_harness',
      enforcement: 'none',
    });
  }
  if (input.config.root.provider !== harness.provider) {
    return Object.freeze({ ...base, status: 'failed', reason: 'invalid_harness_config' });
  }

  try {
    const output = await new TurnOrchestrator(input.dependencies, input.config).execute(input.turn);
    const reviewer = input.config.reviewer
      ? Object.freeze({ ...input.config.reviewer })
      : undefined;
    const workers: readonly WorkerEvidence[] = Object.freeze(output.workerResults.map((worker) => Object.freeze({
      workerId: worker.workerId,
      artifactHash: worker.hash,
      ...(worker.review && reviewer
        ? { review: Object.freeze({ ...worker.review, reviewer }) }
        : {}),
    })));
    const synthesisHash = createHash('sha256').update(output.text).digest('hex');
    return Object.freeze({
      ...base,
      status: 'succeeded',
      childCount: workers.length,
      workers,
      responseHash: synthesisHash,
      ...(input.turn.coordinationLevel === 'direct' ? {} : {
        synthesis: Object.freeze({
          artifactHash: synthesisHash,
          ...(output.synthesisReview && reviewer
            ? { review: Object.freeze({ ...output.synthesisReview, reviewer }) }
            : {}),
        }),
      }),
      text: output.text,
    });
  } catch (error) {
    const reason = failureReason(error);
    return Object.freeze({
      ...base,
      status: reason === 'aborted' ? 'cancelled' : 'failed',
      reason,
    });
  }
}

/** One-shot epoch gate a future WS publisher can consume without trusting UI state. */
export class ServerAuthoritativeResultGate {
  readonly #runId: string;
  readonly #writerEpoch: number;
  #result: ServerAuthoritativeTurnResult | null = null;

  constructor(runId: string, writerEpoch: number) {
    if (!runId || !Number.isSafeInteger(writerEpoch) || writerEpoch < 0) {
      throw new TypeError('invalid result gate identity');
    }
    this.#runId = runId;
    this.#writerEpoch = writerEpoch;
  }

  accept(event: {
    readonly runId: string;
    readonly writerEpoch: number;
    readonly result: ServerAuthoritativeTurnResult;
  }): boolean {
    if (
      this.#result
      || event.runId !== this.#runId
      || event.writerEpoch !== this.#writerEpoch
    ) return false;
    this.#result = event.result;
    return true;
  }

  snapshot(): ServerAuthoritativeTurnResult | null {
    return this.#result;
  }
}
