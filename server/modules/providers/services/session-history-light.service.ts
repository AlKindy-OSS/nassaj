import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveOpenCodeDatabasePathForUser } from '@/modules/providers/list/opencode/opencode-home.js';
import { resolveVendorTranscriptForRead } from '@/modules/providers/shared/vendor/vendor-transcript.js';
import type { FetchHistoryResult, LLMProvider, NormalizedMessage } from '@/shared/types.js';
import { AppError, sanitizeLeafDirectoryName } from '@/shared/utils.js';

import { copyVendorHistoryReceipts } from '../shared/vendor/vendor-receipt-identity.js';
import { copyClaudeHistoryReceipts } from '../list/claude/claude-receipt-identity.js';
import { copyCodexHistoryIdentities } from '../list/codex/codex-receipt-identity.js';

export const LIGHT_HISTORY_SCHEMA = 1 as const;
export const LIGHT_HISTORY_FEATURE_FLAG = 'NASSAJ_LIGHT_HISTORY_ENABLED' as const;
const CACHE_TTL_MS = 15_000;
const CACHE_MAX_ENTRIES = 48;
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
const MESSAGE_TEXT_MAX_BYTES = 512 * 1024;
const LIGHT_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const SMALL_NESTED_MAX_BYTES = 64 * 1024;
const SCALAR_METADATA_MAX_BYTES = 16 * 1024;

export type HistoryPayloadMode = 'full' | 'light';
export type DeferredPayload = { fields: string[] };
export type HistoryResponse = FetchHistoryResult & {
  historySchema: typeof LIGHT_HISTORY_SCHEMA;
  payloadMode: HistoryPayloadMode;
  revision: string;
  messages: Array<NormalizedMessage & { deferredPayload?: DeferredPayload }>;
};

type SessionSource = {
  provider: LLMProvider;
  projectPath: string | null;
  jsonlPath: string | null;
  updatedAt: string;
};

type CacheEntry = { expiresAt: number; bytes: number; result: FetchHistoryResult };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<{ result: FetchHistoryResult; fingerprint: string }>>();
let cachedBytes = 0;

/** The rollout is deliberately opt-in until the compatible client is active. */
export function isLightHistoryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LIGHT_HISTORY_FEATURE_FLAG] === '1';
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function looksLikeStandaloneDataUri(value: string): boolean {
  const comma = value.indexOf(',');
  if (comma < 5 || comma > 160) return false;
  const header = value.slice(0, comma).trim().toLowerCase();
  return header.startsWith('data:') && header.endsWith(';base64');
}

function copySmallKnownValue(value: unknown): unknown | undefined {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (looksLikeStandaloneDataUri(value) || Buffer.byteLength(value, 'utf8') > SMALL_NESTED_MAX_BYTES) return undefined;
    return value;
  }
  if (!Array.isArray(value) && (typeof value !== 'object' || value === null)) return undefined;
  try {
    if (utf8Bytes(value) > SMALL_NESTED_MAX_BYTES) return undefined;
    const encoded = JSON.stringify(value);
    if (encoded.includes('"data:') && encoded.includes(';base64,')) return undefined;
    return JSON.parse(encoded) as unknown;
  } catch {
    return undefined;
  }
}

const SAFE_SCALAR_FIELDS = [
  'id', 'sessionId', 'timestamp', 'provider', 'kind', 'role', 'userId', 'coordinatorId',
  'clientMsgId', 'displayClientMsgId', 'responseToMessageId', 'sameClientMsgIdRetryable', 'isFinalAnswer',
  'coordinationLevel', 'originKind', 'originAgentId', 'originSessionId', 'wfId',
  'agentsDone', 'agentsTotal', 'toolName', 'toolId', 'isError', 'elapsedMs', 'tokens',
  'canInterrupt', 'requestId', 'reason', 'newSessionId', 'parentSessionId', 'status',
  'summary', 'sequence', 'rowid', 'isTaskNotification', 'taskStatus', 'model',
  'transcriptMessageId', 'commandName', 'commandMessage', 'commandArgs',
  'isLocalCommand', 'isLocalCommandStdout', 'isCompactSummary', 'imagesOmitted',
  'code', 'staleSessionId', 'command', 'exitCode', 'actualSessionId',
  'parentToolUseId', 'isFinal', 'forked',
] as const;

const HEAVY_FIELDS = new Set([
  'images', 'input', 'context', 'toolInput', 'toolUseResult', 'subagentTools', 'tokenBudget',
]);

/**
 * Schema-aware, pure projection used only after provider normalization and
 * server-owned attribution stamping. Unknown nested provider payloads are not
 * copied. Text is inspected only for an exact standalone data URI shape; prose
 * that merely mentions `data:` is never pattern-stripped.
 */
export function projectLightHistory(result: FetchHistoryResult): FetchHistoryResult {
  let remainingBytes = LIGHT_RESPONSE_MAX_BYTES;
  const messages = result.messages.map((message) => {
    const projected: Record<string, unknown> = {};
    const deferred = new Set<string>();

    for (const field of SAFE_SCALAR_FIELDS) {
      const value = message[field];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
        if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > SCALAR_METADATA_MAX_BYTES) {
          deferred.add(field);
        } else {
          projected[field] = value;
        }
      }
    }

    // `displayText` is the actual renderable body for Claude local-command
    // transcript rows, not optional decoration; keep it under the same text
    // budget as content instead of silently blanking those rows until full.
    for (const field of ['content', 'text', 'displayText'] as const) {
      const value = message[field];
      if (typeof value !== 'string') continue;
      const bytes = Buffer.byteLength(value, 'utf8');
      if (looksLikeStandaloneDataUri(value) || bytes > MESSAGE_TEXT_MAX_BYTES || bytes > remainingBytes) {
        deferred.add(field);
      } else {
        projected[field] = value;
        remainingBytes -= bytes;
      }
    }

    const responseTurnMetric = copySmallKnownValue(message.responseTurnMetric);
    if (responseTurnMetric !== undefined) projected.responseTurnMetric = responseTurnMetric;
    else if (message.responseTurnMetric !== undefined) deferred.add('responseTurnMetric');

    if (message.toolResult && typeof message.toolResult === 'object') {
      const toolResult: Record<string, unknown> = {};
      if (typeof message.toolResult.isError === 'boolean') toolResult.isError = message.toolResult.isError;
      const content = message.toolResult.content;
      if (typeof content === 'string' && !looksLikeStandaloneDataUri(content)
          && Buffer.byteLength(content, 'utf8') <= MESSAGE_TEXT_MAX_BYTES
          && Buffer.byteLength(content, 'utf8') <= remainingBytes) {
        toolResult.content = content;
        remainingBytes -= Buffer.byteLength(content, 'utf8');
      } else if (content !== undefined) {
        deferred.add('toolResult.content');
      }
      if (message.toolResult.toolUseResult !== undefined) deferred.add('toolResult.toolUseResult');
      projected.toolResult = toolResult;
    }

    for (const field of HEAVY_FIELDS) {
      if (message[field] !== undefined) deferred.add(field);
    }
    for (const field of Object.keys(message)) {
      if (!(field in projected) && field !== 'content' && field !== 'text' && field !== 'toolResult'
          && field !== 'responseTurnMetric' && field !== 'deferredPayload' && !HEAVY_FIELDS.has(field)) {
        const value = message[field];
        if (value !== undefined) deferred.add(field);
      }
    }
    if (deferred.size > 0) projected.deferredPayload = { fields: [...deferred].sort() };
    return projected as NormalizedMessage;
  });

  const tokenUsage = copySmallKnownValue(result.tokenUsage);
  const projectedResult: FetchHistoryResult = {
    messages,
    total: result.total,
    hasMore: result.hasMore,
    offset: result.offset,
    limit: result.limit,
    ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
    ...(tokenUsage !== undefined ? { tokenUsage } : {}),
    ...(result.responseTurnDurationTotalMs !== undefined
      ? { responseTurnDurationTotalMs: result.responseTurnDurationTotalMs } : {}),
  };
  if (utf8Bytes(projectedResult) > LIGHT_RESPONSE_MAX_BYTES) {
    throw new AppError('Lightweight session history exceeded its response budget.', {
      code: 'LIGHT_HISTORY_PAYLOAD_TOO_LARGE', statusCode: 413,
    });
  }
  return projectedResult;
}

function cursorDatabasePath(sessionId: string, projectPath: string | null): string {
  const cwdId = crypto.createHash('md5').update(projectPath || process.cwd()).digest('hex');
  const safeSessionId = sanitizeLeafDirectoryName(sessionId, 'cursor session id');
  return path.join(os.homedir(), '.cursor', 'chats', cwdId, safeSessionId, 'store.db');
}

async function statFingerprint(filePath: string): Promise<string | null> {
  try {
    const stat = await fsp.stat(filePath, { bigint: true });
    return `file:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function sourceFingerprint(
  sessionId: string,
  requesterUserId: number | null,
  source: SessionSource,
): Promise<string> {
  let filePath = source.provider === 'cursor' || source.provider === 'opencode'
    ? null
    : source.jsonlPath;
  const sqliteBacked = source.provider === 'opencode' || source.provider === 'cursor';
  if (!filePath && source.provider === 'opencode') filePath = resolveOpenCodeDatabasePathForUser(requesterUserId);
  if (!filePath && source.provider === 'cursor') filePath = cursorDatabasePath(sessionId, source.projectPath);
  if (!filePath && ['kimi', 'deepseek', 'glm', 'hermes', 'qwen'].includes(source.provider)) {
    filePath = await resolveVendorTranscriptForRead(
      source.provider,
      sessionId,
      source.projectPath ?? undefined,
      source.jsonlPath,
    );
  }
  if (filePath) {
    const files = sqliteBacked ? [filePath, `${filePath}-wal`, `${filePath}-shm`] : [filePath];
    const fingerprints = await Promise.all(files.map(async (candidate) =>
      `${path.basename(candidate)}=${await statFingerprint(candidate) ?? 'missing'}`));
    if (!fingerprints[0].endsWith('=missing')) return fingerprints.join('|');
  }
  return `metadata:${source.provider}:${source.updatedAt}`;
}

function cloneResult(result: FetchHistoryResult): FetchHistoryResult {
  return copyCodexHistoryIdentities(result, copyClaudeHistoryReceipts(result, copyVendorHistoryReceipts(result, structuredClone(result))));
}

function evictExpired(now = Date.now()): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt > now) continue;
    cache.delete(key);
    cachedBytes -= entry.bytes;
  }
}

function putCache(key: string, result: FetchHistoryResult): void {
  const bytes = utf8Bytes(result);
  if (bytes > CACHE_MAX_BYTES) return;
  evictExpired();
  while (cache.size >= CACHE_MAX_ENTRIES || cachedBytes + bytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    const removed = cache.get(oldest);
    cache.delete(oldest);
    cachedBytes -= removed?.bytes ?? 0;
  }
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, bytes, result: cloneResult(result) });
  cachedBytes += bytes;
}

/** Loads one normalized snapshot, coalescing identical reads and rejecting torn sources. */
export async function loadStableHistorySnapshot(input: {
  sessionId: string;
  requesterUserId: number | null;
  source: SessionSource;
  pageKey: string;
  historyLease?: import('./history-budget.service.js').HistoryReadLease;
  load: () => Promise<FetchHistoryResult>;
}): Promise<{ result: FetchHistoryResult; revision: string }> {
  if (input.historyLease) {
    const before = await sourceFingerprint(input.sessionId, input.requesterUserId, input.source);
    const result = await input.load();
    input.historyLease.check();
    const after = await sourceFingerprint(input.sessionId, input.requesterUserId, input.source);
    if (before !== after) input.historyLease.fail('HISTORY_REVISION_CHANGED');
    return { result, revision: historyRevision(before) };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await sourceFingerprint(input.sessionId, input.requesterUserId, input.source);
    const key = `${input.source.provider}:${input.sessionId}:${input.pageKey}:${before}`;
    evictExpired();
    const hit = cache.get(key);
    if (hit) {
      return { result: cloneResult(hit.result), revision: historyRevision(before) };
    }
    let pending = inflight.get(key);
    if (!pending) {
      pending = (async () => {
        const result = await input.load();
        const after = await sourceFingerprint(input.sessionId, input.requesterUserId, input.source);
        return { result, fingerprint: after };
      })();
      inflight.set(key, pending);
      void pending.finally(() => inflight.delete(key)).catch(() => undefined);
    }
    const loaded = await pending;
    if (loaded.fingerprint === before) {
      putCache(key, loaded.result);
      return { result: cloneResult(loaded.result), revision: historyRevision(before) };
    }
  }
  throw new AppError('Session history changed while it was being read.', {
    code: 'HISTORY_REVISION_CHANGED', statusCode: 409,
  });
}

export function historyRevision(fingerprint: string): string {
  return crypto.createHash('sha256').update(`history-v1:${fingerprint}`).digest('base64url');
}

/** Test-only reset; no production caller should flush the shared snapshot cache. */
export function resetHistorySnapshotCacheForTests(): void {
  cache.clear();
  inflight.clear();
  cachedBytes = 0;
}
