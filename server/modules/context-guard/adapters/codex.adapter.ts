/* eslint-disable boundaries/dependencies -- ADR-223: read-only usage leaves (transcript reader, token parsers, opencode home), not the providers barrel (routes/SDK graph). */
/**
 * Codex usage adapter of the context guard (T-2087, ADR-223).
 *
 * Fill: `last_token_usage.total_tokens` of the rollout's last `token_count`
 * (the native context occupancy). A `compacted` record (or a
 * `context_compacted` event) after it makes the fill unknown until the next
 * count. Window: the `model_context_window` the rollout itself reported for
 * the same model; a model never seen in this rollout → unknown.
 */

import { nativeTokenCount } from '@/modules/providers/list/codex/codex-token-budget.js';

import type { ContextFitAdapter, GuardSession, Observation } from '../types.js';

export type CodexAdapterDeps = {
  rolloutKey: (session: GuardSession) => Promise<string | null>;
  readRolloutTail: (session: GuardSession) => Promise<string | null>;
};

type RolloutEntry = { type?: unknown; payload?: Record<string, any> | null };

const parse = (line: string): RolloutEntry | null => {
  try {
    const entry: unknown = JSON.parse(line);
    return typeof entry === 'object' && entry !== null ? entry as RolloutEntry : null;
  } catch {
    return null;
  }
};

const isCompaction = (entry: RolloutEntry): boolean =>
  entry.type === 'compacted' || entry.payload?.type === 'context_compacted';

/** Last fill, the model in effect and every window the rollout reported, in one pass. */
export function scanCodexRollout(text: string): Observation {
  let model: string | null = null;
  let used: number | null = null;
  const windows: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const entry = parse(line);
    if (!entry) continue;
    if (entry.type === 'turn_context' && typeof entry.payload?.model === 'string') model = entry.payload.model;
    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
      const info = entry.payload.info;
      const window = nativeTokenCount(info?.model_context_window);
      if (model !== null && window !== null && window > 0) windows[model] = window;
      used = window !== null && window > 0 ? nativeTokenCount(info?.last_token_usage?.total_tokens) : null;
    }
    if (isCompaction(entry)) used = null;
  }
  return { usedTokens: used, modelId: model, windowsByModel: windows };
}

/** Builds the Codex adapter over an injected rollout reader. */
export function createCodexContextAdapter(deps: CodexAdapterDeps): ContextFitAdapter {
  return {
    async normalizeModel(model) {
      return model.trim() || null;
    },
    observationKey: deps.rolloutKey,
    async observe(session) {
      const text = await deps.readRolloutTail(session);
      return text === null ? { usedTokens: null, modelId: null } : scanCodexRollout(text);
    },
    async windowFor(modelId, _session, observation) {
      return { windowTokens: observation.windowsByModel?.[modelId] ?? null, reserveTokens: null };
    },
  };
}
