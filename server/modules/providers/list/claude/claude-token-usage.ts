import { cacheObservationMetadata, type CacheSnapshot, nativeContextId, nativeTokenCount } from '../codex/codex-token-budget.js';
import { readPinnedTail } from '../../shared/pinned-tail.js';
import { isTranscriptHandle, openRecordedTranscript } from '../../shared/session-transcript-reader.js';

type RecordValue = Record<string, unknown>;

export type ClaudeTokenUsage = {
  cacheSnapshot?: CacheSnapshot | null;
  inputTokens: number;
  outputTokens: number;
  modelName: string | null;
  breakdown: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
};

type ClaudeSessionSource = {
  session_id: string;
  provider?: unknown;
  project_path?: string | null;
  jsonl_path?: string | null;
};

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null;

const tokenCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/**
 * Reads the tail of the session's transcript (ADR-201 A1): at most
 * TRANSCRIPT_TAIL_MAX_BYTES from the end, starting at a record (B-954, B-1599
 * L8) — the latest usage is what the route reports. The row's recorded path,
 * tree-confined, pinned and bound to the session id by name and header; read
 * only from the pinned descriptor. Authorization-free core: the token-usage
 * route has already checked that the caller sees the project and that this
 * session belongs to it (`session.project_path === projectPath`).
 */
export async function readClaudeTranscriptForSession(
  session: ClaudeSessionSource | null,
  projectPath: string,
): Promise<string | null> {
  if (session?.provider !== 'claude' || session.project_path !== projectPath) return null;
  const opened = await openRecordedTranscript(
    { session_id: session.session_id, provider: 'claude', jsonl_path: session.jsonl_path ?? null }, 'token-usage',
  );
  if (!isTranscriptHandle(opened)) return null;
  try {
    return await readPinnedTail(opened.fd);
  } catch {
    return null;
  } finally {
    await opened.fd.close().catch(() => undefined);
  }
}

/** Prompt-cache lifetime Anthropic reported for one request, in minutes. */
export type ClaudeCacheTtlMinutes = 60 | 5;

/**
 * Reads the cache lifetime straight from an Anthropic `usage` payload: the
 * `cache_creation` split names the bucket the request wrote to (T-1765).
 * Returns null when the request wrote nothing, so no lifetime is invented.
 */
export function claudeCacheTtlMinutes(usage: unknown): ClaudeCacheTtlMinutes | null {
  if (!isRecord(usage) || !isRecord(usage.cache_creation)) return null;
  if (tokenCount(usage.cache_creation.ephemeral_1h_input_tokens) > 0) return 60;
  if (tokenCount(usage.cache_creation.ephemeral_5m_input_tokens) > 0) return 5;
  return null;
}

/** Cache lifetime of the latest main-chain assistant request that wrote to the cache. */
export function latestClaudeCacheTtlMinutes(jsonl: string): ClaudeCacheTtlMinutes | null {
  const lines = jsonl.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.type !== 'assistant' || entry.isSidechain === true) continue;
    if (!isRecord(entry.message)) continue;
    const ttl = claudeCacheTtlMinutes(entry.message.usage);
    if (ttl !== null) return ttl;
  }
  return null;
}

/** Reads the latest Claude context snapshot, including both prompt-cache buckets. */
export function latestClaudeTokenUsage(jsonl: string, sessionId: string | null = null): ClaudeTokenUsage {
  const lines = jsonl.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: RecordValue;
    try {
      const parsed: unknown = JSON.parse(lines[index]);
      if (!isRecord(parsed)) continue;
      entry = parsed;
    } catch {
      continue;
    }

    if (entry.type === 'system' && entry.subtype === 'compact_boundary' && entry.isSidechain !== true) break;
    if (entry.type !== 'assistant' || entry.isSidechain === true || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (!isRecord(message.usage)) continue;
    const usage = message.usage;
    const cacheSnapshot = claudeCacheSnapshot(entry, sessionId, 'history');
    const rawInput = tokenCount(usage.input_tokens);
    const cacheRead = tokenCount(usage.cache_read_input_tokens);
    const cacheCreation = tokenCount(usage.cache_creation_input_tokens);
    const outputTokens = tokenCount(usage.output_tokens);
    const inputTokens = rawInput + cacheRead + cacheCreation;

    return {
      cacheSnapshot,
      inputTokens,
      outputTokens,
      modelName: typeof message.model === 'string' && message.model ? message.model : null,
      breakdown: { input: inputTokens, output: outputTokens, cacheRead, cacheCreation },
    };
  }

  return {
    cacheSnapshot: null,
    inputTokens: 0,
    outputTokens: 0,
    modelName: null,
    breakdown: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  };
}

/** Native control response, or last-request input when control telemetry is unavailable. */
export function claudeContextSnapshot(
  response: unknown,
  identity: { sessionId: string | null; modelId: string | null },
  inputTokens: number | null = null,
): import('../codex/codex-token-budget.js').ContextSnapshot {
  const control = isRecord(response) ? response : {};
  const count = nativeTokenCount;
  identity = { sessionId: nativeContextId(identity.sessionId), modelId: nativeContextId(identity.modelId) };
  inputTokens = count(inputTokens);
  const used = count(control.totalTokens);
  const window = count(control.maxTokens);
  const measured = used !== null && window !== null && window > 0 && nativeContextId(control.model) !== null;
  // B-1295: do NOT override a caller-supplied identity with the control's
  // reported model. The caller carries the authoritative picker alias
  // (e.g. 'opus[1m]') which must survive so that client validation can match
  // it against sessionCurrentModel (same source: resolveResumeModel).
  // control.model is still required for measured=true — it confirms the SDK
  // produced a valid native reading — but it does not own the identity.
  // Only populate modelId from control when the caller left it empty.
  if (measured && !identity.modelId) identity.modelId = nativeContextId(control.model);
  return {
    version: 1, provider: 'claude', ...identity,
    usedTokens: measured ? used : inputTokens,
    windowTokens: measured ? window : null,
    usageKind: measured ? 'native_reported_context' : inputTokens === null ? 'unknown' : 'last_request_input',
    source: measured ? 'claude.getContextUsage' : 'claude.message.usage',
    observedAt: new Date().toISOString(),
    nativeCompactTokens: measured ? count(control.autoCompactThreshold) : null,
    proposedCompactTokens: measured && identity.sessionId && identity.modelId ? 150000 : null,
    newSessionTokens: measured && identity.sessionId && identity.modelId ? 200000 : null,
  };
}

const ONE_MILLION_CONTEXT = 1_000_000;
const STANDARD_CONTEXT = 200_000;

/**
 * B-1356: context window for a model id read back from a transcript, or null
 * when the id does not name it unambiguously enough to state one.
 *
 * No model catalog in this codebase (live `supportedModels()`, the degraded
 * CLAUDE_FALLBACK_MODELS) carries a numeric window, so this applies the family
 * rules already documented by `resolveContextWindow` in claude-sdk.js, with one
 * deliberate difference: a transcript records the BASE id (`claude-sonnet-4-6`)
 * even when the run used the `sonnet[1m]` variant, and the catalog lists the
 * base Sonnet as a separate, non-1M option. Ambiguity resolves to the smaller
 * window, so the ring can over-state fullness but never under-state it.
 *  - explicit `[1m]` suffix → 1M;
 *  - Fable, and Opus 4.6 or later → 1M (the catalog's default Opus is 1M);
 *  - every other recognised Claude id (Sonnet, Haiku, older Opus, claude-3*) → 200K;
 *  - anything unrecognised (`<synthetic>`, non-Claude, empty) → null, never a guess.
 */
export function claudeTranscriptWindowTokens(modelId: string | null): number | null {
  const id = typeof modelId === 'string' ? modelId.trim().toLowerCase() : '';
  if (!id.startsWith('claude-')) return null;
  if (id.endsWith('[1m]')) return ONE_MILLION_CONTEXT;
  if (/^claude-\d+(?:-\d{1,2})?-(?:opus|sonnet|haiku)(?:-|$)/.test(id)) return STANDARD_CONTEXT;
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(id);
  if (!match) return null;
  const [, family, majorText, minorText] = match;
  if (family === 'fable') return ONE_MILLION_CONTEXT;
  const major = Number(majorText);
  const minor = Number(minorText ?? 0);
  if (family === 'opus' && (major > 4 || (major === 4 && minor >= 6))) return ONE_MILLION_CONTEXT;
  return STANDARD_CONTEXT;
}

/**
 * Snapshot for a transcript-restored session: last-request input against the
 * model's known window. Not a runtime observation, so `observedAt` stays null
 * and usageKind stays `last_request_input`.
 */
export function claudeTranscriptContextSnapshot(
  sessionId: string | null,
  modelId: string | null,
  inputTokens: number,
): import('../codex/codex-token-budget.js').ContextSnapshot {
  const snapshot = claudeContextSnapshot(null, { sessionId, modelId }, modelId ? inputTokens : null);
  snapshot.observedAt = null;
  snapshot.windowTokens = snapshot.usageKind === 'last_request_input' ? claudeTranscriptWindowTokens(modelId) : null;
  return snapshot;
}

/** One bounded control request; telemetry failure must never fail a conversation. */
export async function readClaudeContextSnapshot(
  query: { getContextUsage?: () => Promise<unknown> } | null,
  identity: { sessionId: string | null; modelId: string | null },
): Promise<import('../codex/codex-token-budget.js').ContextSnapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (typeof query?.getContextUsage !== 'function') return claudeContextSnapshot(null, identity);
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1000); });
    const response = await Promise.race([Promise.resolve().then(() => query.getContextUsage!()), timeout]);
    return claudeContextSnapshot(response, identity);
  } catch {
    return claudeContextSnapshot(null, identity);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Extract raw disjoint Claude fields before legacy normalization inserts zeros. */
export function claudeCacheSnapshot(
  event: any, sessionId: string | null, transport: CacheSnapshot['transport'] = 'live',
): CacheSnapshot | null {
  if (event?.type !== 'assistant' || event?.parent_tool_use_id || event?.isSidechain === true) return null;
  const usage = event?.message?.usage;
  if (!isRecord(usage)) return null;
  const input = nativeTokenCount(usage.input_tokens);
  const read = nativeTokenCount(usage.cache_read_input_tokens);
  const write = nativeTokenCount(usage.cache_creation_input_tokens);
  const total = input === null || read === null || write === null ? null : nativeTokenCount(input + read + write);
  return {
    version: 1, provider: 'claude', sessionId: nativeContextId(sessionId),
    modelId: nativeContextId(event.message.model), source: 'claude.message.usage', scope: 'last_request',
    ...cacheObservationMetadata(event, transport), inputTokens: total, cacheReadTokens: read, cacheWriteTokens: write,
  };
}
