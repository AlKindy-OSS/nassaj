/* eslint-disable boundaries/dependencies -- ADR-223: read-only usage leaves (transcript reader, token parsers, opencode home), not the providers barrel (routes/SDK graph). */
/**
 * Claude usage adapter of the context guard (T-2087, ADR-223).
 *
 * Fill: the last main-chain request's input (fresh + cache read + cache write)
 * from the session transcript; a `compact_boundary` after it makes the fill
 * unknown. Window: {@link claudeTranscriptWindowTokens} on a full model id — a
 * picker alias (`haiku`, `default`, `opus[1m]`) is first mapped to a full id
 * through the catalog's own description of it. Never `resolveContextWindow`,
 * which assumes 1M for anything it does not know. A session driven by a vendor
 * engine is not measured.
 */

import {
  claudeTranscriptWindowTokens,
  latestClaudeTokenUsage,
} from '@/modules/providers/list/claude/claude-token-usage.js';

import type { ContextFitAdapter, GuardSession } from '../types.js';

export type ClaudeCatalogOption = { value: string; label?: string; description?: string };

export type ClaudeAdapterDeps = {
  /** Change marker of the session transcript (e.g. mtime + size), null when it cannot be opened. */
  transcriptKey: (session: GuardSession) => Promise<string | null>;
  readTranscriptTail: (session: GuardSession) => Promise<string | null>;
  catalogOptions: () => Promise<readonly ClaudeCatalogOption[]>;
};

const OFFICIAL_ENGINES = new Set([null, '', 'anthropic']);
const FAMILY_VERSION = /\b(Opus|Sonnet|Haiku|Fable)\s+(\d+)(?:\.(\d{1,2}))?/i;
const LONG_CONTEXT = /\b1M context\b/i;
const LONG_SUFFIX = '[1m]';
/** Families with a 1M-context variant; Haiku has none. */
const LONG_CONTEXT_FAMILY = /^claude-(?:sonnet|opus)-/;

/**
 * The model that actually served a recorded fill. A transcript records the base
 * id even for a `[1m]` run, so a fill the base window cannot hold proves the 1M
 * variant served it: the tag is restored for families that have one. The test
 * is the window itself, not the budget (window − reserve): a recorded request
 * between the two succeeded on the base model.
 */
export function claudeServedModel(modelId: string, usedTokens: number | null): string {
  const id = modelId.toLowerCase();
  if (usedTokens === null || id.endsWith(LONG_SUFFIX) || !LONG_CONTEXT_FAMILY.test(id)) return id;
  const windowTokens = claudeTranscriptWindowTokens(id);
  return windowTokens !== null && usedTokens > windowTokens ? `${id}${LONG_SUFFIX}` : id;
}

/** True when the session runs on Anthropic's own engine (no vendor engine pin). */
export function isOfficialClaudeEngine(session: GuardSession): boolean {
  return OFFICIAL_ENGINES.has(session.engineProvider);
}

/**
 * Full Claude id a catalog option names (`Haiku 5.5` → `claude-haiku-5-5`),
 * with `[1m]` when the option is the long-context variant. The live catalog
 * names the version in the label (`haiku` → "Haiku 5.5"); the fallback list
 * names it in the description ("currently Opus 5.5 (1M context)"). Null when
 * neither names a family and version.
 */
export function claudeIdFromCatalogOption(option: ClaudeCatalogOption): string | null {
  const text = `${option.label ?? ''} · ${option.description ?? ''}`;
  const match = FAMILY_VERSION.exec(text);
  if (!match) return null;
  const [, family, major, minor] = match;
  const base = `claude-${family.toLowerCase()}-${major}${minor ? `-${minor}` : ''}`;
  const long = option.value.toLowerCase().endsWith(LONG_SUFFIX) || LONG_CONTEXT.test(text);
  return long ? `${base}${LONG_SUFFIX}` : base;
}

/** Maps a pinned value to a comparable full id, or null when it is not a Claude model. */
export async function normalizeClaudeModel(
  model: string, catalogOptions: () => Promise<readonly ClaudeCatalogOption[]>,
): Promise<string | null> {
  const id = model.trim().toLowerCase();
  if (id.startsWith('claude-')) return claudeTranscriptWindowTokens(id) === null ? null : id;
  const options = await catalogOptions();
  const find = (value: string) => options.find((entry) => entry.value.trim().toLowerCase() === value);
  const option = find(id);
  if (option) return claudeIdFromCatalogOption(option);
  // `sonnet[1m]` when the catalog only lists `sonnet`: the base alias, long variant.
  const base = id.endsWith(LONG_SUFFIX) ? find(id.slice(0, -LONG_SUFFIX.length)) : undefined;
  const baseId = base ? claudeIdFromCatalogOption(base) : null;
  if (!baseId) return null;
  return baseId.endsWith(LONG_SUFFIX) ? baseId : `${baseId}${LONG_SUFFIX}`;
}

/** Builds the Claude adapter over injected transcript and catalog readers. */
export function createClaudeContextAdapter(deps: ClaudeAdapterDeps): ContextFitAdapter {
  return {
    compactsOnPreviousModel: true,
    async normalizeModel(model, session) {
      if (!isOfficialClaudeEngine(session)) return null;
      return normalizeClaudeModel(model, deps.catalogOptions);
    },
    async observationKey(session) {
      if (!isOfficialClaudeEngine(session)) return null;
      return deps.transcriptKey(session);
    },
    async observe(session) {
      const text = await deps.readTranscriptTail(session);
      if (text === null) return { usedTokens: null, modelId: null };
      const usage = latestClaudeTokenUsage(text, session.sessionId);
      if (usage.modelName === null) return { usedTokens: null, modelId: null };
      return { usedTokens: usage.inputTokens, modelId: claudeServedModel(usage.modelName, usage.inputTokens) };
    },
    async windowFor(modelId) {
      return { windowTokens: claudeTranscriptWindowTokens(modelId), reserveTokens: null };
    },
  };
}
