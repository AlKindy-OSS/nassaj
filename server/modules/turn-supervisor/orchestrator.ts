import { createHash } from 'node:crypto';

import type { AdmissionVerdict } from './resource-admission.js';
import type { RunRecord, TerminalOutcome, TurnRecord } from './types.js';
import { createFencedCaptureOnlyWriter } from './adapters/capture-only-writer.js';
import type {
  TurnProvider,
  TurnAdapterInvoke,
  TurnAdapterResult,
  TurnCapabilityToken,
} from './adapters/types.js';
import {
  parsePlannerPlan,
  parseReviewVerdict,
  PlannerSchemaError,
  type PlannerPlan,
  type ReviewVerdict,
} from './planner-schema.js';

export type CoordinationLevel = 'direct' | 'delegate' | 'delegate_review';
export type OrchestratorTarget = {
  readonly provider: TurnProvider;
  readonly model: string;
};
export type WorkerTarget = OrchestratorTarget & { readonly id: string };

export type OrchestratorInput = {
  readonly coordinationLevel: CoordinationLevel;
  readonly prompt: string;
  readonly userId: number;
  readonly turn: TurnRecord;
  readonly run: RunRecord;
  readonly writerEpoch: number;
  readonly signal?: AbortSignal;
  readonly hostedResultContext?: Readonly<{
    provider: TurnProvider; model: string; sessionId: string; isNewSession: boolean;
    projectPath?: string;
    transcriptState?: 'pending' | 'written';
  }>;
  readonly cancellationEpoch?: number;
};

export type OrchestratorOutput = {
  readonly text: string;
  readonly plan?: PlannerPlan;
  readonly workerResults: readonly { workerId: string; text: string; hash: string; review?: ReviewVerdict }[];
  readonly synthesisReview?: ReviewVerdict;
};

type Registry = {
  probe(input: { provider: string; userId: string | number }): Promise<{
    available: boolean;
    capability?: TurnCapabilityToken;
  }>;
  invoke(input: TurnAdapterInvoke): Promise<TurnAdapterResult>;
};

type Repository = {
  startExecution(input: {
    turnId: string; runId: string; expectedTurnEpoch: number; expectedRunEpoch: number;
  }): { turn: TurnRecord; run: RunRecord };
  finishExecution(input: {
    turnId: string; runId: string; expectedTurnEpoch: number; expectedRunEpoch: number;
    terminalOutcome: TerminalOutcome;
    hostedResult?: {
      provider: TurnProvider; model: string; sessionId: string; isNewSession: boolean; text: string;
      projectPath?: string;
      transcriptState?: 'pending' | 'written';
    };
    cancellationEpoch?: number;
  }): { turn: TurnRecord; run: RunRecord };
};

export type OrchestratorDependencies = {
  readonly registry: Registry;
  readonly repository: Repository;
  /** Must atomically reserve resources for this run. There is no unreserved execution path. */
  readonly admitRun: (input: OrchestratorInput) => Promise<AdmissionVerdict>;
  /** Must retain capacity unless every launched adapter has settled/reaped. */
  readonly releaseRun: (
    input: OrchestratorInput,
    admission: Extract<AdmissionVerdict, { admitted: true }>,
    outcome: 'not_started' | TerminalOutcome,
  ) => void | Promise<void>;
  readonly writerFence: { accepts(runId: string, writerEpoch: number): boolean };
};

export type OrchestratorConfig = {
  readonly root: OrchestratorTarget;
  readonly planner: OrchestratorTarget;
  readonly synthesis: OrchestratorTarget;
  readonly reviewer?: OrchestratorTarget;
  readonly workers: readonly WorkerTarget[];
  readonly maxWorkers?: number;
};

export class TurnOrchestratorError extends Error {
  constructor(readonly code:
    | 'RESOURCE_DENIED' | 'PROVIDER_UNAVAILABLE' | 'INVALID_CONFIG'
    | 'PLAN_FAILED' | 'REVIEW_FAILED' | 'ABORTED' | 'STALE_WRITER', options?: ErrorOptions) {
    super(code, options);
    this.name = 'TurnOrchestratorError';
  }
}

const PLAN_SYSTEM = 'Return only strict JSON: {"version":1,"workers":[{"workerId":"allowlisted id","task":"bounded task"}],"synthesisInstructions":"text"}. Select at least one worker. No markdown.';
const REVIEW_SYSTEM = 'Return only strict JSON: {"verdict":"pass|changes_required|veto","artifactHash":"the supplied sha256","feedback":"text"}. Judge only the current artifact and copy its exact hash. No markdown.';

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sameTarget(a: OrchestratorTarget, b: OrchestratorTarget): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/** External, capture-only mechanical coordination. It owns no websocket/transcript surface. */
export class TurnOrchestrator {
  readonly #workers: ReadonlyMap<string, WorkerTarget>;

  constructor(readonly deps: OrchestratorDependencies, readonly config: OrchestratorConfig) {
    this.#workers = new Map(config.workers.map((worker) => [worker.id, Object.freeze({ ...worker })]));
    if (
      this.#workers.size !== config.workers.length
      || config.workers.length < 1
      || (config.reviewer && [config.root, config.planner, config.synthesis, ...config.workers]
        .some((target) => sameTarget(target, config.reviewer!)))
    ) {
      throw new TurnOrchestratorError('INVALID_CONFIG');
    }
  }

  async execute(input: OrchestratorInput): Promise<OrchestratorOutput> {
    let run = input.run;
    let turn = input.turn;
    let started = false;
    let finished = false;
    let admission: Extract<AdmissionVerdict, { admitted: true }> | undefined;
    let outcome: 'not_started' | TerminalOutcome = 'not_started';
    try {
      const verdict = await this.deps.admitRun(input);
      if (!verdict.admitted) throw new TurnOrchestratorError('RESOURCE_DENIED');
      admission = verdict;
      ({ run, turn } = this.deps.repository.startExecution({
        runId: run.runId, turnId: turn.turnId,
        expectedRunEpoch: run.epoch, expectedTurnEpoch: turn.epoch,
      }));
      started = true;

      const output = input.coordinationLevel === 'direct'
        ? await this.#direct(input)
        : await this.#delegated(input);
      if (input.signal?.aborted) {
        throw new TurnOrchestratorError('ABORTED');
      }
      outcome = 'succeeded';
      this.deps.repository.finishExecution({
        runId: run.runId, turnId: turn.turnId,
        expectedRunEpoch: run.epoch, expectedTurnEpoch: turn.epoch,
        terminalOutcome: outcome,
        ...(input.hostedResultContext ? {
          hostedResult: { ...input.hostedResultContext, text: output.text },
        } : {}),
        cancellationEpoch: input.cancellationEpoch,
      });
      finished = true;
      return output;
    } catch (error) {
      if (started && !finished) {
        outcome = input.signal?.aborted ? 'cancelled' : 'failed';
        try {
          this.deps.repository.finishExecution({
            runId: run.runId, turnId: turn.turnId,
            expectedRunEpoch: run.epoch, expectedTurnEpoch: turn.epoch,
            terminalOutcome: outcome,
            cancellationEpoch: input.cancellationEpoch,
          });
          finished = true;
        } catch (terminalError) {
          throw new AggregateError([error, terminalError], 'execution and terminalization failed');
        }
      }
      if (input.signal?.aborted) throw new TurnOrchestratorError('ABORTED', { cause: error });
      throw error;
    } finally {
      if (admission) await this.deps.releaseRun(input, admission, outcome);
    }
  }

  async #direct(input: OrchestratorInput): Promise<OrchestratorOutput> {
    const result = await this.#invoke(this.config.root, input, input.prompt, []);
    return Object.freeze({ text: result.text, workerResults: Object.freeze([]) });
  }

  async #delegated(input: OrchestratorInput): Promise<OrchestratorOutput> {
    if (input.coordinationLevel === 'delegate_review' && !this.config.reviewer) {
      throw new TurnOrchestratorError('INVALID_CONFIG');
    }
    const allowed = Object.freeze([...this.#workers.keys()]);
    let plan: PlannerPlan | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const correction = attempt === 1 ? '\nYour previous response was invalid. Retry once with exact JSON only.' : '';
      const response = await this.#invoke(
        this.config.planner,
        input,
        `USER REQUEST:\n${input.prompt}\n\nALLOWLISTED WORKER IDS:\n${JSON.stringify(allowed)}${correction}`,
        [PLAN_SYSTEM],
      );
      try {
        plan = parsePlannerPlan(response.text, {
          allowedWorkerIds: new Set(allowed), maxWorkers: this.config.maxWorkers,
        });
        break;
      } catch (error) {
        if (
          !(error instanceof PlannerSchemaError)
          || error.code !== 'MALFORMED_PLAN'
          || attempt === 1
        ) {
          throw new TurnOrchestratorError('PLAN_FAILED', { cause: error });
        }
      }
    }
    if (!plan) throw new TurnOrchestratorError('PLAN_FAILED');

    const results = [] as Array<{ workerId: string; text: string; hash: string; review?: ReviewVerdict }>;
    for (const assignment of plan.workers) {
      const target = this.#workers.get(assignment.workerId)!;
      const worker = await this.#invoke(target, input, assignment.task, []);
      const artifactHash = hash(worker.text);
      const item: { workerId: string; text: string; hash: string; review?: ReviewVerdict } = {
        workerId: assignment.workerId, text: worker.text, hash: artifactHash,
      };
      if (input.coordinationLevel === 'delegate_review') {
        item.review = await this.#review(input, `WORKER ${assignment.workerId}`, worker.text, artifactHash);
        if (item.review.verdict !== 'pass') throw new TurnOrchestratorError('REVIEW_FAILED');
      }
      results.push(Object.freeze(item));
    }

    const synthesis = await this.#invoke(
      this.config.synthesis,
      input,
      `USER REQUEST:\n${input.prompt}\n\nSYNTHESIS INSTRUCTIONS:\n${plan.synthesisInstructions}\n\nWORKER RESULTS:\n${JSON.stringify(results.map(({ workerId, text, hash: artifactHash }) => ({ workerId, artifactHash, text })))}`,
      [],
    );
    let synthesisReview: ReviewVerdict | undefined;
    if (input.coordinationLevel === 'delegate_review') {
      synthesisReview = await this.#review(input, 'SYNTHESIS', synthesis.text, hash(synthesis.text));
      if (synthesisReview.verdict !== 'pass') throw new TurnOrchestratorError('REVIEW_FAILED');
    }
    return Object.freeze({
      text: synthesis.text,
      plan,
      workerResults: Object.freeze(results),
      ...(synthesisReview ? { synthesisReview } : {}),
    });
  }

  async #review(
    input: OrchestratorInput,
    label: string,
    artifact: string,
    artifactHash: string,
  ): Promise<ReviewVerdict> {
    const result = await this.#invoke(
      this.config.reviewer!, input,
      `${label}\nCURRENT ARTIFACT SHA256: ${artifactHash}\nCURRENT ARTIFACT:\n${artifact}`,
      [REVIEW_SYSTEM],
    );
    try {
      return parseReviewVerdict(result.text, artifactHash);
    } catch (error) {
      throw new TurnOrchestratorError('REVIEW_FAILED', { cause: error });
    }
  }

  async #invoke(
    target: OrchestratorTarget,
    input: OrchestratorInput,
    prompt: string,
    hiddenContext: readonly string[],
  ): Promise<TurnAdapterResult> {
    const accepts = () => this.deps.writerFence.accepts(input.run.runId, input.writerEpoch);
    if (!accepts()) throw new TurnOrchestratorError('STALE_WRITER');
    const probe = await this.deps.registry.probe({ provider: target.provider, userId: input.userId });
    if (!probe.available || !probe.capability) throw new TurnOrchestratorError('PROVIDER_UNAVAILABLE');
    const writer = createFencedCaptureOnlyWriter(accepts);
    const result = await this.deps.registry.invoke({
      capability: probe.capability,
      model: target.model,
      prompt,
      hiddenContext,
      persist: false,
      effects: Object.freeze([]),
      signal: input.signal,
      writer,
      executionIdentity: { runId: input.run.runId, writerEpoch: input.writerEpoch },
    });
    if (!accepts()) throw new TurnOrchestratorError('STALE_WRITER');
    return result;
  }
}
