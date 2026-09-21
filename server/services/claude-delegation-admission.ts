/** T-1601: reviewed native depth admission restricted to the measured executable. */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';

import { resolveExecutableForHashing } from './isolation/vendor-binary-integrity.js';
import { SystemResourceSampler, type SystemResourceSample } from './system-resource-sampler.service.js';

export const REVIEWED_CLAUDE_SHA256 = '26d020351e8112f4006790f3cfce43b4c9df0c1bb1d0e542364d64151b81d5ba';
const MAX_SAMPLE_AGE_MS = 1000;
const sampleFresh = () => new SystemResourceSampler({}, { cacheMaxAgeMs: 0 }).sample();
type Input = { tool_name?: string; tool_input?: unknown };
type HookResult = { hookSpecificOutput?: {
  hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string;
} };

/** Keep current limits until native coverage is proven; never trust caller readiness. */
export function claudeDelegationProfile(level: unknown) {
  const review = level === 'delegate_review';
  return {
    depth: review ? '2' : '1',
    concurrent: '20', // Native omission also defaults to 20; unlimited semantics unproved.
    expandedDepthEnabled: false,
  };
}

function denied(reason = 'DELEGATION_RESOURCE_ADMISSION_DENIED: fresh CPU and memory measurements below 80% are required.'): HookResult {
  return { hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: reason,
  } };
}

function acceptable(sample: SystemResourceSample, now: number): boolean {
  const age = now - sample?.measuredAt;
  return Number.isFinite(now) && Number.isFinite(age) && age >= 0 && age <= MAX_SAMPLE_AGE_MS
    && [sample?.cpuPercent, sample?.memoryPercent].every(
      value => Number.isFinite(value) && value >= 0 && value < 80,
    );
}

/** Serialize fresh observations; this is not a reservation of future resource usage. */
export function createClaudeDelegationResourceHook(deps: {
  sample?: () => Promise<SystemResourceSample>; now?: () => number;
} = {}) {
  let pending: Promise<unknown> = Promise.resolve();
  return async (input: Input, _toolUseId?: string, context?: { signal?: AbortSignal }): Promise<HookResult> => {
    if (input?.tool_name === 'TeamCreate') return denied('DELEGATION_TEAM_UNVERIFIED: team delegation is not verified for this execution path.');
    if (input?.tool_name !== 'Agent' && input?.tool_name !== 'Task') return {};
    const payload = input.tool_input;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.hasOwn(payload, 'team_name') || Object.hasOwn(payload, 'name')) {
      return denied('DELEGATION_INPUT_UNVERIFIED: provide a standard agent request without team fields.');
    }
    const result = pending.then(async (): Promise<HookResult> => {
      try {
        if (context?.signal?.aborted) return denied();
        const sample = await (deps.sample ?? sampleFresh)();
        if (context?.signal?.aborted || !acceptable(sample, (deps.now ?? Date.now)())) return denied();
        return {}; // Never override canUseTool or an existing permission denial.
      } catch { return denied(); }
    });
    pending = result.catch(() => undefined);
    return result;
  };
}

async function hashExecutable(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Verify bytes and stable file identity without a cache or loading the binary into RAM. */
export async function verifiedClaudeExecutable(binary: string, env: NodeJS.ProcessEnv, deps: {
  hash?: (file: string) => Promise<string>;
} = {}): Promise<string | null> {
  try {
    const found = resolveExecutableForHashing(binary, env);
    if (!found) return null;
    const file = await fs.realpath(found);
    const before = await fs.stat(file, { bigint: true });
    if (!before.isFile()) return null;
    const digest = await (deps.hash ?? hashExecutable)(file);
    const after = await fs.stat(file, { bigint: true });
    const stable = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const;
    if (digest !== REVIEWED_CLAUDE_SHA256 || stable.some(key => before[key] !== after[key])) return null;
    return file;
  } catch { return null; }
}

type LaunchOptions = {
  env: NodeJS.ProcessEnv; pathToClaudeCodeExecutable?: string;
  hooks?: Record<string, unknown>;
};

/** Bind measured native behavior to this launch only; unknown builds retain baseline depth. */
export async function prepareClaudeReviewedDelegation(options: LaunchOptions, level: unknown, deps: {
  sample?: () => Promise<SystemResourceSample>; now?: () => number;
  verify?: typeof verifiedClaudeExecutable;
} = {}): Promise<boolean> {
  if (level !== 'delegate_review') return false;
  try {
    const sample = await (deps.sample ?? sampleFresh)();
    if (!acceptable(sample, (deps.now ?? Date.now)())) return false;
    const file = await (deps.verify ?? verifiedClaudeExecutable)(options.pathToClaudeCodeExecutable ?? 'claude', options.env);
    if (!file) return false;
    options.pathToClaudeCodeExecutable = file;
    options.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = '10';
    delete options.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS;
    const hooks = options.hooks ?? {};
    const existing = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
    options.hooks = { ...hooks, PreToolUse: [...existing, {
      matcher: '^(Agent|Task|TeamCreate)$', hooks: [createClaudeDelegationResourceHook()],
    }] };
    return true;
  } catch { return false; }
}
