import fs from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { cacheObservationMetadata, type CacheSnapshot, nativeContextId, nativeTokenCount } from '../codex/codex-token-budget.js';

import {
  claudeProjectRoots,
  resolveClaudeTranscriptPath,
  type ClaudeTranscriptRow,
} from './claude-transcript-path.js';

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

type ClaudeSessionSource = ClaudeTranscriptRow & { provider?: unknown };

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null;

const tokenCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

const isInsideRoot = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
};

/**
 * Reads the transcript selected by the shared resolver from the same descriptor
 * that is containment-checked. O_NOFOLLOW plus /proc/self/fd closes the
 * validate-path/read-path race without losing overlay and legacy fallbacks.
 */
export async function readClaudeTranscriptForSession(
  session: ClaudeSessionSource | null,
  projectPath: string,
  userId: string | number | null,
): Promise<string | null> {
  if (session?.provider !== 'claude' || session.project_path !== projectPath) return null;

  const indexedPath = await resolveClaudeTranscriptPath(session, userId);
  if (!indexedPath) return null;

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const roots = (
      await Promise.all(claudeProjectRoots(userId).map(async (root) => {
        try { return await realpath(root); } catch { return null; }
      }))
    ).filter((root): root is string => root !== null);
    handle = await open(
      indexedPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    if (!(await handle.stat()).isFile()) return null;

    const descriptorPath = await realpath(`/proc/self/fd/${handle.fd}`);
    if (!roots.some((root) => isInsideRoot(descriptorPath, root))) return null;
    return await handle.readFile('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close();
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
  if (measured) identity.modelId = nativeContextId(control.model);
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
