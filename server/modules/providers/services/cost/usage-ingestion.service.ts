import { createHash } from 'node:crypto';
import { open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import {
  conversationUsageSnapshotsDb,
  getConnection,
  usageIngestionDb,
  type ConversationUsageSnapshot,
  type UsageAttributionKind,
  type UsageAttributionScope,
  type UsageDurationEventInput,
  type UsageRequestEventInput,
  type UsageSourceCheckpoint,
} from '@/modules/database/index.js';
import {
  resolveCodexLinkedRollouts,
  type CodexRolloutManifest,
} from '@/modules/providers/list/codex/codex-rollout-links.js';

import { calculateSessionCost, type SessionCost } from './cost-calculator.js';
import { emptyTotals, type ModelUsage, type SessionUsage } from './usage-extractors.js';
import { buildCodexStatisticsV3 } from './usage-statistics-v3.service.js';

const PARSER_VERSION = 1;
const MAX_READ_BYTES = 4 * 1024 * 1024;
// A JSONL record larger than one bounded read cannot make cursor progress.
// Fail explicitly instead of retaining an unbounded tail or spinning forever.
const MAX_JSONL_RECORD_BYTES = MAX_READ_BYTES;
const FINGERPRINT_CHUNK_BYTES = 1024 * 1024;

export type UsageIngestWriterMode = 'off' | 'shadow' | 'on';
export type ConversationSnapshotReaderMode = 'legacy' | 'compare' | 'ledger';

export const usageIngestWriterMode = (): UsageIngestWriterMode => {
  const value = process.env.USAGE_INGEST_WRITER;
  return value === 'shadow' || value === 'on' ? value : 'off';
};

export const conversationSnapshotReaderMode = (): ConversationSnapshotReaderMode => {
  const value = process.env.CONVERSATION_SNAPSHOT_READER;
  return value === 'compare' || value === 'ledger' ? value : 'legacy';
};

export type IngestContext = {
  sessionId: string;
  /** Trusted scheduler-supplied owner-spawn identity for ADR-169 only. */
  ownerUserId?: number;
  provider: 'claude' | 'codex';
  transcriptPath: string;
  projectPath?: string | null;
  manifest?: CodexRolloutManifest;
  signal?: AbortSignal;
  parserVersion?: number;
};

export type ConversationIngestOutcome = {
  skipped: boolean;
  caughtUp: boolean;
  ingestComplete: boolean;
  eventsWritten: number;
  /** At least one complete JSONL record advanced a durable source cursor. */
  madeProgress: boolean;
};

type SourceIdentity = {
  sourceKey: string;
  sourcePath: string;
  deviceId: string;
  inode: string;
};

type ParsedLine = { text: string; byteStart: number; byteEnd: number };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const positive = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
};

const eventId = (...parts: Array<string | number>): string =>
  createHash('sha256').update(parts.join('|')).digest('hex');
const durableSessionId = (value: string): boolean => /^[a-f0-9-]{20,}$/i.test(value);

async function assertRootSessionIdentity(context: IngestContext): Promise<void> {
  if (!durableSessionId(context.sessionId)) return;
  if (context.provider === 'codex') {
    const observed = context.manifest?.root.sessionId ?? context.manifest?.root.threadId;
    if (!observed) throw new Error(`Cannot prove transcript session identity for ${context.sessionId}`);
    if (observed !== context.sessionId) {
      throw new Error(`Transcript session identity ${observed} does not match ${context.sessionId}`);
    }
    return;
  }
  const handle = await open(context.transcriptPath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(MAX_READ_BYTES);
    let offset = 0;
    let tail = '';
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      const text = tail + chunk.subarray(0, bytesRead).toString('utf8');
      const lines = text.split('\n');
      tail = lines.pop() ?? '';
      if (Buffer.byteLength(tail) > MAX_JSONL_RECORD_BYTES) throw new Error('Identity record exceeds JSONL limit');
      for (const line of lines) {
        let value: unknown;
        try { value = JSON.parse(line); } catch { continue; }
        if (!record(value)) continue;
        const observed = typeof value.sessionId === 'string' ? value.sessionId
          : typeof value.session_id === 'string' ? value.session_id : null;
        if (!observed) continue;
        if (!durableSessionId(observed) || observed !== context.sessionId) {
          throw new Error(`Transcript session identity ${observed} does not match ${context.sessionId}`);
        }
        return;
      }
    }
    throw new Error(`Cannot prove transcript session identity for ${context.sessionId}`);
  } finally {
    await handle.close();
  }
}

function decodeFingerprint(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch { return []; }
}

async function extendFingerprint(
  handle: FileHandle,
  previous: string | null,
  previousBytes: number,
  committedBytes: number,
): Promise<string> {
  const startChunk = Math.floor(previousBytes / FINGERPRINT_CHUNK_BYTES);
  const hashes = decodeFingerprint(previous).slice(0, startChunk);
  const buffer = Buffer.allocUnsafe(FINGERPRINT_CHUNK_BYTES);
  let offset = startChunk * FINGERPRINT_CHUNK_BYTES;
  while (offset < committedBytes) {
    const wanted = Math.min(FINGERPRINT_CHUNK_BYTES, committedBytes - offset);
    const { bytesRead } = await handle.read(buffer, 0, wanted, offset);
    if (bytesRead === 0) throw new Error('Source ended while computing committed-prefix fingerprint');
    hashes.push(createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex'));
    offset += bytesRead;
  }
  return JSON.stringify(hashes);
}

async function sourceIdentity(provider: string, sourcePath: string): Promise<SourceIdentity> {
  const canonical = await realpath(sourcePath);
  const handle = await open(canonical, 'r');
  try {
    const fileStat = await handle.stat();
    return {
      sourceKey: `${provider}:${canonical}`,
      sourcePath: canonical,
      deviceId: String(fileStat.dev),
      inode: String(fileStat.ino),
    };
  } finally {
    await handle.close();
  }
}

function ensureCheckpoint(identity: SourceIdentity, provider: string, parserVersion: number): UsageSourceCheckpoint {
  usageIngestionDb.createCheckpoint({ ...identity, provider, parserVersion });
  let checkpoint = usageIngestionDb.getCheckpoint(identity.sourceKey);
  if (!checkpoint) throw new Error(`Usage checkpoint was not created for ${identity.sourceKey}`);
  const replaced = checkpoint.deviceId !== identity.deviceId || checkpoint.inode !== identity.inode;
  const rebuild = replaced || checkpoint.parserVersion !== parserVersion;
  if (rebuild) {
    checkpoint = resetCheckpoint(identity, provider, checkpoint.generation, parserVersion);
  }
  return checkpoint;
}

function resetCheckpoint(
  identity: SourceIdentity,
  provider: string,
  expectedGeneration: number,
  parserVersion: number,
): UsageSourceCheckpoint {
  return getConnection().transaction(() => {
    const reset = usageIngestionDb.resetCheckpointCas({
      ...identity, provider, parserVersion, expectedGeneration,
    });
    if (!reset) throw new Error(`Usage checkpoint CAS reset lost for ${identity.sourceKey}`);
    const checkpoint = usageIngestionDb.getCheckpoint(identity.sourceKey)!;
    usageIngestionDb.invalidateSnapshotsForSource(
      identity.sourceKey,
      'The source identity, size, or parser generation changed; background rebuild is required.',
    );
    usageIngestionDb.purgeSourceGenerationsBefore(identity.sourceKey, checkpoint.generation);
    return checkpoint;
  })();
}

function splitLines(checkpoint: UsageSourceCheckpoint, chunk: Buffer): {
  lines: ParsedLine[];
  committedBytes: number;
} {
  let cursor = checkpoint.offsetBytes;
  let lineStart = 0;
  const lines: ParsedLine[] = [];
  for (let index = 0; index < chunk.length; index += 1) {
    if (chunk[index] !== 10) continue;
    const line = chunk.subarray(lineStart, index);
    const byteStart = cursor;
    cursor += line.length + 1;
    lines.push({ text: line.toString('utf8'), byteStart, byteEnd: cursor });
    lineStart = index + 1;
  }
  return { lines, committedBytes: lineStart };
}

function baseRequest(
  context: IngestContext,
  checkpoint: UsageSourceCheckpoint,
  line: ParsedLine,
  requestKey: string,
  occurredAt: string,
  attribution: { kind: UsageAttributionKind; id: string; subagent: boolean },
): Omit<UsageRequestEventInput, 'model'> {
  return {
    eventId: eventId(checkpoint.sourceKey, checkpoint.generation, line.byteStart, line.byteEnd),
    sourceKey: checkpoint.sourceKey,
    sourceGeneration: checkpoint.generation,
    byteStart: line.byteStart,
    byteEnd: line.byteEnd,
    occurredAt,
    provider: context.provider,
    harness: context.provider,
    sessionId: context.sessionId,
    projectPath: context.projectPath,
    requestKey,
    isSubagent: attribution.subagent,
    attributionScope: attribution.kind === 'agent' ? 'agent' : 'conversation',
    attributionKind: attribution.kind,
    attributionId: attribution.id,
    attributionConfidence: attribution.kind === 'agent' ? 1 : null,
  };
}

function parseClaude(
  context: IngestContext,
  checkpoint: UsageSourceCheckpoint,
  lines: ParsedLine[],
  attribution: { kind: UsageAttributionKind; id: string; subagent: boolean },
): UsageRequestEventInput[] {
  const events: UsageRequestEventInput[] = [];
  for (const line of lines) {
    let entry: unknown;
    try { entry = JSON.parse(line.text); } catch { continue; }
    if (!record(entry) || entry.type !== 'assistant') continue;
    const message = record(entry.message) ? entry.message : null;
    const usage = message && record(message.usage) ? message.usage : null;
    const model = typeof message?.model === 'string' ? message.model : '';
    if (!usage || !model || model === '<synthetic>') continue;
    const messageId = typeof message?.id === 'string' ? message.id : '';
    const requestId = typeof entry.requestId === 'string' ? entry.requestId : '';
    const requestKey = messageId || requestId ? `${messageId}|${requestId}` : `physical:${line.byteStart}`;
    const cacheCreation = record(usage.cache_creation) ? usage.cache_creation : null;
    const split5m = positive(cacheCreation?.ephemeral_5m_input_tokens);
    const split1h = positive(cacheCreation?.ephemeral_1h_input_tokens);
    events.push({
      ...baseRequest(context, checkpoint, line, requestKey, String(entry.timestamp ?? new Date().toISOString()), attribution),
      model,
      inputTokens: positive(usage.input_tokens),
      outputTokens: positive(usage.output_tokens),
      cacheWrite5mTokens: split5m + split1h > 0 ? split5m : positive(usage.cache_creation_input_tokens),
      cacheWrite1hTokens: split1h,
      cacheReadTokens: positive(usage.cache_read_input_tokens),
      outputMax: true,
    });
  }
  return events;
}

function parseCodex(
  context: IngestContext,
  checkpoint: UsageSourceCheckpoint,
  lines: ParsedLine[],
  attribution: { kind: UsageAttributionKind; id: string; subagent: boolean },
  modelHint?: string | null,
): UsageRequestEventInput[] {
  const events: UsageRequestEventInput[] = [];
  let model = modelHint || 'unknown';
  for (const line of lines) {
    let entry: unknown;
    try { entry = JSON.parse(line.text); } catch { continue; }
    if (!record(entry)) continue;
    const payload = record(entry.payload) ? entry.payload : null;
    if (!payload) continue;
    if (typeof payload.model === 'string' && payload.model) model = payload.model;
    if (payload.type !== 'token_count') continue;
    const info = record(payload.info) ? payload.info : null;
    const total = info && record(info.total_token_usage) ? info.total_token_usage : null;
    if (!total) continue;
    const input = positive(total.input_tokens);
    const cached = positive(total.cached_input_tokens);
    events.push({
      ...baseRequest(
        context,
        checkpoint,
        line,
        `codex-total:${checkpoint.sourceKey}`,
        String(entry.timestamp ?? new Date().toISOString()),
        attribution,
      ),
      model,
      inputTokens: Math.max(0, input - cached),
      outputTokens: positive(total.output_tokens),
      cacheReadTokens: cached,
      outputMax: true,
    });
  }
  return events;
}

function parseDurationEvents(
  context: IngestContext,
  checkpoint: UsageSourceCheckpoint,
  lines: ParsedLine[],
  attribution: { kind: UsageAttributionKind; id: string },
): UsageDurationEventInput[] {
  const events: UsageDurationEventInput[] = [];
  for (const line of lines) {
    let entry: unknown;
    try { entry = JSON.parse(line.text); } catch { continue; }
    const timestamp = record(entry) && typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
    if (!Number.isFinite(timestamp)) continue;
    const visit = (value: unknown, location: string): void => {
      if (typeof value === 'string') {
        if (!/(?:\.content|\.output|\.input_text|\.result)(?::\d+)?$/.test(location)) return;
        const trimmed = value.trim();
        if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return;
        try { visit(JSON.parse(trimmed), `${location}:json`); } catch { /* Non-JSON tool text is not data. */ }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((nested, index) => visit(nested, `${location}:${index}`));
        return;
      }
      if (!record(value)) return;
      if ('totalDurationMs' in value) {
        const durationMs = Number(value.totalDurationMs);
        const agentId = typeof value.agentId === 'string' ? value.agentId : '';
        const eventIdentity = typeof value.id === 'string' ? value.id
          : typeof value.call_id === 'string' ? value.call_id : '';
        const trustedType = value.type === 'tool_result' || value.type === 'function_call_output'
          || value.type === 'agent_result';
        const stableId = trustedType ? (agentId || eventIdentity) : '';
        // Only documented agent/tool result objects have a stable identity.
        // A random nested payload containing the same property is not timing data.
        if (stableId && Number.isSafeInteger(durationMs) && durationMs >= 0) {
          events.push({
            eventId: eventId(agentId ? 'duration-agent' : 'duration', context.sessionId, stableId),
            sourceKey: checkpoint.sourceKey,
            sourceGeneration: checkpoint.generation,
            sessionId: context.sessionId,
            projectPath: context.projectPath,
            kind: agentId ? 'agent' : 'tool',
            startedAt: new Date(timestamp - durationMs).toISOString(),
            endedAt: new Date(timestamp).toISOString(),
            durationMs,
            attributionKind: agentId ? 'agent' : attribution.kind,
            attributionId: agentId || attribution.id,
          });
        }
      }
      for (const [key, nested] of Object.entries(value)) visit(nested, `${location}.${key}`);
    };
    visit(entry, 'root');
  }
  return events;
}

async function ingestSource(
  context: IngestContext,
  sourcePath: string,
  attribution: { kind: UsageAttributionKind; id: string; subagent: boolean },
  modelHint?: string | null,
): Promise<{ complete: boolean; sourceKey: string; generation: number; eventsWritten: number; committedBytes: number }> {
  context.signal?.throwIfAborted();
  const identity = await sourceIdentity(context.provider, sourcePath);
  const parserVersion = context.parserVersion ?? PARSER_VERSION;
  let checkpoint = ensureCheckpoint(identity, context.provider, parserVersion);
  const handle = await open(identity.sourcePath, 'r');
  try {
    let before = await handle.stat();
    if (String(before.dev) !== identity.deviceId || String(before.ino) !== identity.inode) {
      return { complete: false, sourceKey: identity.sourceKey, generation: checkpoint.generation, eventsWritten: 0, committedBytes: 0 };
    }
    if (before.size < checkpoint.offsetBytes) {
      checkpoint = resetCheckpoint(identity, context.provider, checkpoint.generation, parserVersion);
      before = await handle.stat();
    }
    if (checkpoint.offsetBytes > 0 && checkpoint.boundaryHash
      && checkpoint.offsetBytes === checkpoint.observedSizeBytes
      && before.size === checkpoint.observedSizeBytes) {
      // Same-size mutations cannot be append-only. Recheck all fixed chunks;
      // normal growth updates only the appended chunks below.
      const currentHash = await extendFingerprint(handle, null, 0, checkpoint.offsetBytes);
      if (currentHash !== checkpoint.boundaryHash) {
        checkpoint = resetCheckpoint(identity, context.provider, checkpoint.generation, parserVersion);
        before = await handle.stat();
      }
    }
    const remaining = Math.max(0, before.size - checkpoint.offsetBytes);
    const wanted = Math.min(remaining, MAX_READ_BYTES);
    const buffer = Buffer.allocUnsafe(wanted);
    const { bytesRead } = wanted > 0
      ? await handle.read(buffer, 0, wanted, checkpoint.offsetBytes)
      : { bytesRead: 0 };
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
      return { complete: false, sourceKey: identity.sourceKey, generation: checkpoint.generation, eventsWritten: 0, committedBytes: 0 };
    }
    const parsed = splitLines(checkpoint, buffer.subarray(0, bytesRead));
    const events = context.provider === 'claude'
      ? parseClaude(context, checkpoint, parsed.lines, attribution)
      : parseCodex(context, checkpoint, parsed.lines, attribution, modelHint);
    const durationEvents = parseDurationEvents(context, checkpoint, parsed.lines, attribution);
    if (bytesRead === MAX_JSONL_RECORD_BYTES && parsed.committedBytes === 0) {
      throw new Error(`JSONL record exceeds ${MAX_JSONL_RECORD_BYTES} bytes for ${identity.sourceKey}`);
    }
    // Commit only through the final newline. A partial UTF-8/JSON record stays
    // in the source file and is reread from its exact byte boundary next time.
    const nextOffset = checkpoint.offsetBytes + parsed.committedBytes;
    const nextBoundaryHash = await extendFingerprint(
      handle, checkpoint.boundaryHash, checkpoint.offsetBytes, nextOffset,
    );
    const transaction = getConnection().transaction(() => {
      let eventsWritten = 0;
      for (const event of events) {
        if (usageIngestionDb.mergeRequestEvent(event)) eventsWritten += 1;
      }
      for (const event of durationEvents) usageIngestionDb.insertDurationEvent(event);
      const advanced = usageIngestionDb.advanceCheckpointCas({
        sourceKey: identity.sourceKey,
        expectedGeneration: checkpoint.generation,
        expectedOffsetBytes: checkpoint.offsetBytes,
        nextOffsetBytes: nextOffset,
        partialTail: '',
        deviceId: identity.deviceId,
        inode: identity.inode,
        observedSizeBytes: after.size,
        observedMtimeMs: after.mtimeMs,
        boundaryHash: nextBoundaryHash,
      });
      if (!advanced) throw new Error(`Usage checkpoint advance CAS lost for ${identity.sourceKey}`);
      return eventsWritten;
    });
    const eventsWritten = transaction();
    return {
      complete: nextOffset === after.size,
      sourceKey: identity.sourceKey,
      generation: checkpoint.generation,
      eventsWritten,
      committedBytes: parsed.committedBytes,
    };
  } catch (error) {
    usageIngestionDb.setCheckpointStatusCas({
      sourceKey: identity.sourceKey,
      expectedGeneration: checkpoint.generation,
      expectedStatus: checkpoint.status,
      nextStatus: 'error',
      lastError: error instanceof Error ? error.message : String(error),
    });
    console.error('[usage-ingestion-writer-error]', {
      sessionId: context.sessionId,
      sourceKey: identity.sourceKey,
      generation: checkpoint.generation,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await handle.close();
  }
}

async function claudeSources(
  rootPath: string,
  signal?: AbortSignal,
): Promise<{ sources: string[]; stable: boolean }> {
  const sources = [rootPath];
  const directory = rootPath.replace(/\.jsonl$/, '');
  let directoryHandle;
  try { directoryHandle = await open(directory, 'r'); } catch { return { sources, stable: true }; }
  const before = await directoryHandle.stat();
  const walk = async (current: string): Promise<void> => {
    signal?.throwIfAborted();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      signal?.throwIfAborted();
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) sources.push(full);
    }
  };
  try {
    await walk(directory);
    const after = await directoryHandle.stat();
    return { sources, stable: before.mtimeMs === after.mtimeMs && before.size === after.size };
  } finally {
    await directoryHandle.close();
  }
}

function usageFromFacts(
  sessionId: string,
  attribution?: { kind: UsageAttributionKind; id: string; scope: UsageAttributionScope },
): SessionUsage {
  const facts = usageIngestionDb.listConversationFacts(sessionId, attribution);
  const perModel: ModelUsage[] = facts.map((fact) => ({
    model: fact.model,
    requests: fact.requests,
    totals: {
      ...emptyTotals(),
      input: fact.inputTokens,
      output: fact.outputTokens,
      cacheWrite5m: fact.cacheWrite5mTokens,
      cacheWrite1h: fact.cacheWrite1hTokens,
      cacheRead: fact.cacheReadTokens,
    },
  }));
  return {
    provider: '',
    perModel,
    subagentRequests: facts.reduce((sum, fact) => sum + fact.subagentRequests, 0),
    workDurationMs: usageIngestionDb.sumConversationDuration(sessionId),
    skipped: { synthetic: 0, duplicates: 0 },
  };
}

function writeSnapshot(
  context: IngestContext,
  ingestComplete: boolean,
  generation: number,
  attribution: { kind: UsageAttributionKind; id: string; scope: UsageAttributionScope },
): void {
  const usage = usageFromFacts(context.sessionId, attribution.kind === 'coordinator' ? undefined : attribution);
  usage.provider = context.provider;
  const cost = calculateSessionCost(usage);
  const totals = cost.perModel.reduce((sum, row) => ({
    input: sum.input + row.tokens.input,
    output: sum.output + row.tokens.output,
    cacheWrite5m: sum.cacheWrite5m + row.tokens.cacheWrite5m,
    cacheWrite1h: sum.cacheWrite1h + row.tokens.cacheWrite1h,
    cacheRead: sum.cacheRead + row.tokens.cacheRead,
  }), emptyTotals());
  const input = {
    sessionId: context.sessionId,
    attributionKind: attribution.kind,
    attributionId: attribution.id,
    attributionScope: attribution.scope,
    provider: context.provider,
    harness: context.provider,
    projectPath: context.projectPath,
    generation,
    snapshotStatus: ingestComplete ? 'ready' as const : 'stale' as const,
    asOf: new Date().toISOString(),
    measured: cost.perModel.length > 0,
    ingestComplete,
    pricingComplete: cost.complete,
    requestCount: cost.perModel.reduce((sum, row) => sum + row.requests, 0),
    outputMaxCount: usageIngestionDb.listConversationFacts(
      context.sessionId,
      attribution.kind === 'coordinator' ? undefined : attribution,
    ).reduce((sum, row) => sum + row.outputMaxCount, 0),
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheWrite5mTokens: totals.cacheWrite5m,
    cacheWrite1hTokens: totals.cacheWrite1h,
    cacheReadTokens: totals.cacheRead,
    costUsd: cost.totalUsd,
    reportedWorkDurationMs: usage.workDurationMs,
    breakdown: {
      schemaVersion: 1,
      perModel: cost.perModel,
      unpricedModels: cost.unpricedModels,
      assumedModels: cost.assumedModels,
      subagentRequests: cost.subagentRequests,
      pricesAsOf: cost.pricesAsOf,
    },
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = conversationUsageSnapshotsDb.get(input);
    if (conversationUsageSnapshotsDb.upsertCas(input, current?.revision ?? null)) return;
  }
  throw new Error(`Conversation snapshot CAS retries exhausted for ${context.sessionId}`);
}

export async function ingestConversationUsage(context: IngestContext): Promise<ConversationIngestOutcome> {
  if (usageIngestWriterMode() === 'off') {
    return { skipped: true, caughtUp: true, ingestComplete: false, eventsWritten: 0, madeProgress: false };
  }
  await assertRootSessionIdentity(context);
  const claude = context.provider === 'claude'
    ? await claudeSources(context.transcriptPath, context.signal)
    : null;
  const sources = context.provider === 'codex'
    ? context.manifest?.files.map((file) => file.rolloutPath) ?? [context.transcriptPath]
    : claude!.sources;
  const pinnedSources = await Promise.all(sources.map(async (source) => {
    const value = await stat(source);
    return { source, size: value.size, mtimeMs: value.mtimeMs, inode: value.ino };
  }));
  let complete = context.provider === 'codex'
    ? context.manifest?.complete === true
    : claude!.stable;
  if (context.provider === 'codex' && context.manifest) {
    for (const pinned of context.manifest.files) {
      const current = await stat(pinned.rolloutPath).catch(() => null);
      if (!current || current.size !== pinned.size || current.mtimeMs !== pinned.mtimeMs) complete = false;
    }
  }
  let generation = 0;
  let caughtUp = true;
  let eventsWritten = 0;
  let madeProgress = false;
  const rootKey = `${context.provider}:${await realpath(context.transcriptPath)}`;
  for (const source of sources) {
    const isRoot = path.resolve(source) === path.resolve(context.transcriptPath);
    const agentId = context.provider === 'codex'
      ? context.manifest?.linked.find((child) => child.rolloutPath === source)?.spawn.agentPath ?? ''
      : isRoot ? '' : path.basename(source, '.jsonl');
    const result = await ingestSource(context, source, {
      kind: isRoot ? 'coordinator' : 'agent', id: agentId, subagent: !isRoot,
    }, context.manifest?.files.find((file) => file.rolloutPath === source)?.model);
    generation = Math.max(generation, result.generation);
    caughtUp = caughtUp && result.complete;
    eventsWritten += result.eventsWritten;
    madeProgress = madeProgress || result.committedBytes > 0;
    complete = complete && result.complete;
    if (!isRoot) {
      usageIngestionDb.insertSourceLink({
        parentSourceKey: rootKey,
        childSourceKey: result.sourceKey,
        relation: 'subagent',
        sessionId: context.sessionId,
        agentId,
        generation: result.generation,
      });
    }
  }
  for (const pinned of pinnedSources) {
    const current = await stat(pinned.source).catch(() => null);
    if (!current || current.size !== pinned.size || current.mtimeMs !== pinned.mtimeMs
      || current.ino !== pinned.inode) complete = false;
  }
  if (context.provider === 'claude') {
    const finalTree = await claudeSources(context.transcriptPath, context.signal);
    complete = complete && finalTree.stable
      && finalTree.sources.map((source) => path.resolve(source)).sort().join('\0')
        === sources.map((source) => path.resolve(source)).sort().join('\0');
  } else if (context.manifest) {
    const refreshed = await resolveCodexLinkedRollouts(context.transcriptPath, context.signal);
    complete = complete && refreshed.complete
      && refreshed.files.map((file) => path.resolve(file.rolloutPath)).sort().join('\0')
        === sources.map((source) => path.resolve(source)).sort().join('\0');
  }
  writeSnapshot(context, complete, generation, { kind: 'coordinator', id: '', scope: 'conversation' });
  for (const attribution of usageIngestionDb.listConversationAttributions(context.sessionId)) {
    writeSnapshot(context, complete, generation, attribution);
  }
  // The watcher/scheduler owns this function, so v3 never runs on a summary
  // request. Its own flag remains off by default and rollback rejects writes.
  if (context.provider === 'codex' && complete && context.manifest) {
    await buildCodexStatisticsV3({
      sessionId: context.sessionId,
      transcriptPath: context.transcriptPath,
      scopeFingerprint: 'all',
      attributionFingerprint: 'none',
      ownerUserId: context.ownerUserId,
      pricingVersion: 'runtime-pricing-v1',
      manifest: context.manifest,
      signal: context.signal,
    });
  }
  return { skipped: false, caughtUp, ingestComplete: complete, eventsWritten, madeProgress };
}

export function readConversationUsageSnapshot(sessionId: string): {
  snapshot: ConversationUsageSnapshot;
  cost: SessionCost;
} | null {
  const snapshot = conversationUsageSnapshotsDb.get({
    sessionId, attributionKind: 'coordinator', attributionId: '', attributionScope: 'conversation',
  });
  if (!snapshot?.measured) return null;
  const breakdown = record(snapshot.breakdown) ? snapshot.breakdown : {};
  if (breakdown.schemaVersion !== 1 || !Array.isArray(breakdown.perModel)) return null;
  const validTokens = (value: unknown): value is ModelUsage['totals'] => record(value)
    && ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead']
      .every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0);
  const storedRows = breakdown.perModel;
  if (!storedRows.every((row): row is SessionCost['perModel'][number] => record(row)
    && typeof row.model === 'string'
    && Number.isSafeInteger(row.requests) && Number(row.requests) >= 0
    && validTokens(row.tokens))) return null;
  if (typeof breakdown.subagentRequests !== 'number'
    || !Number.isSafeInteger(breakdown.subagentRequests)
    || breakdown.subagentRequests < 0) return null;
  // Price at read time from pricing-free token facts. A pricing-table update
  // must not require reparsing transcripts or trust a historic stored amount.
  const cost = calculateSessionCost({
    provider: snapshot.provider,
    perModel: storedRows.map((row) => ({
      model: row.model,
      requests: row.requests,
      totals: { ...row.tokens },
    })),
    subagentRequests: typeof breakdown.subagentRequests === 'number' ? breakdown.subagentRequests : 0,
    workDurationMs: snapshot.reportedWorkDurationMs ?? null,
    skipped: { synthetic: 0, duplicates: 0 },
  });
  return {
    snapshot,
    cost,
  };
}

export function logSnapshotComparison(sessionId: string, legacy: SessionCost, ledger: SessionCost): void {
  const comparable = (cost: SessionCost) => ({
    perModel: [...cost.perModel].sort((a, b) => a.model.localeCompare(b.model)).map((row) => ({
      model: row.model, requests: row.requests, tokens: row.tokens, costUsd: row.costUsd,
    })),
    subagentRequests: cost.subagentRequests,
    workDurationMs: cost.workDurationMs,
    complete: cost.complete,
    unpricedModels: [...cost.unpricedModels].sort(),
    assumedModels: [...cost.assumedModels].sort(),
  });
  const legacyComparable = comparable(legacy);
  const ledgerComparable = comparable(ledger);
  if (JSON.stringify(legacyComparable) === JSON.stringify(ledgerComparable)) return;
  console.warn('[usage-snapshot-compare]', {
    sessionId,
    quarantined: true,
    legacy: legacyComparable,
    ledger: ledgerComparable,
    costDeltaUsd: ledger.totalUsd - legacy.totalUsd,
  });
}
