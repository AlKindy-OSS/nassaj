export type PlannerWorker = {
  readonly workerId: string;
  readonly task: string;
};

export type PlannerPlan = {
  readonly version: 1;
  readonly workers: readonly PlannerWorker[];
  readonly synthesisInstructions: string;
};

export type ReviewVerdict = {
  readonly verdict: 'pass' | 'changes_required' | 'veto';
  readonly artifactHash: string;
  readonly feedback: string;
};

export class PlannerSchemaError extends Error {
  constructor(readonly code: 'MALFORMED_PLAN' | 'PLAN_NOT_ALLOWLISTED' | 'MALFORMED_VERDICT') {
    super(code);
    this.name = 'PlannerSchemaError';
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** Parses the planner's entire response. Markdown fences and trailing prose fail closed. */
export function parsePlannerPlan(
  text: string,
  options: { readonly allowedWorkerIds: ReadonlySet<string>; readonly maxWorkers?: number },
): PlannerPlan {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PlannerSchemaError('MALFORMED_PLAN');
  }
  const maxWorkers = options.maxWorkers ?? 8;
  if (
    !object(value)
    || !exactKeys(value, ['version', 'workers', 'synthesisInstructions'])
    || value.version !== 1
    || !Array.isArray(value.workers)
    || value.workers.length < 1
    || value.workers.length > maxWorkers
    || !boundedText(value.synthesisInstructions, 8_000)
  ) {
    throw new PlannerSchemaError('MALFORMED_PLAN');
  }
  const seen = new Set<string>();
  const workers = value.workers.map((candidate): PlannerWorker => {
    if (
      !object(candidate)
      || !exactKeys(candidate, ['workerId', 'task'])
      || !boundedText(candidate.workerId, 128)
      || !boundedText(candidate.task, 16_000)
    ) {
      throw new PlannerSchemaError('MALFORMED_PLAN');
    }
    if (!options.allowedWorkerIds.has(candidate.workerId) || seen.has(candidate.workerId)) {
      throw new PlannerSchemaError('PLAN_NOT_ALLOWLISTED');
    }
    seen.add(candidate.workerId);
    return Object.freeze({ workerId: candidate.workerId, task: candidate.task });
  });
  return Object.freeze({
    version: 1,
    workers: Object.freeze(workers),
    synthesisInstructions: value.synthesisInstructions,
  });
}

/** A review only applies when it names the SHA-256 hash of the current artifact. */
export function parseReviewVerdict(text: string, expectedArtifactHash: string): ReviewVerdict {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PlannerSchemaError('MALFORMED_VERDICT');
  }
  if (
    !object(value)
    || !exactKeys(value, ['verdict', 'artifactHash', 'feedback'])
    || !['pass', 'changes_required', 'veto'].includes(String(value.verdict))
    || value.artifactHash !== expectedArtifactHash
    || typeof value.feedback !== 'string'
    || value.feedback.length > 16_000
  ) {
    throw new PlannerSchemaError('MALFORMED_VERDICT');
  }
  return Object.freeze({
    verdict: value.verdict as ReviewVerdict['verdict'],
    artifactHash: value.artifactHash,
    feedback: value.feedback,
  });
}
