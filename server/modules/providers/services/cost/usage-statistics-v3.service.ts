import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, stat } from 'node:fs/promises';

import {
  participantsDb,
  usageStatisticsV3Db,
  usageStatisticsV3ReaderMode,
  usageStatisticsV3WriterMode,
  responseTurnMetricsDb,
  type UsageV3AuthorityTuple,
  type UsageStatisticsV3Fact,
} from '@/modules/database/index.js';
import {
  resolveCodexLinkedRollouts,
  type CodexRolloutManifest,
} from '@/modules/providers/list/codex/codex-rollout-links.js';

import { emptyTotals, WorkDurationAccumulator, type SessionUsage } from './usage-extractors.js';

/** ADR-169 framing: reads are 1 MiB; an individual JSONL record is at most 4 MiB. */
export const V3_STREAM_CHUNK_BYTES = 1024 * 1024;
export const V3_MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = V3_MAX_RECORD_BYTES;
const MAX_FACTS_PER_SOURCE = 100_000;
const MAX_FACTS_PER_RUN = 500_000;
const MAX_SOURCES = 256;
const MAX_RUN_BYTES = 256 * 1024 * 1024;
const MAX_PENDING_FACT_BYTES = 64 * 1024 * 1024;
const LEASE_MS = 60_000;
const OPERATION_MS = 45_000;
const LIFECYCLE_WAIT_MS = 5_000;
const CLEANUP_INTERVAL_NS = 15n * 60n * 1_000_000_000n;
const RETRY_WINDOW_MS = 15 * 60 * 1_000;
const RETRY_BACKOFF_MS = Object.freeze([1_000, 4_000] as const);
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_ATTEMPT_IO_BYTES = 256 * 1024 * 1024;
const HEX_256 = /^[a-f0-9]{64}$/;
type UsageStatisticsFailureCode =
  | 'manifest_incomplete' | 'lineage_incomplete' | 'source_changed' | 'source_invalid'
  | 'vector_reset_unmarked' | 'fact_rejected' | 'snapshot_rejected'
  | 'finalize_validation_failed' | 'writer_failed';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const nonNegative = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
const digest = (domain: string, value: string | Buffer): string => createHash('sha256').update(`usage-v3:${domain}\0`).update(value).digest('hex');
const sourceKeyFor = (canonicalPath: string): string => `codex:${digest('source', canonicalPath)}`;

export type WriterAttemptProcessIdentity = {
  hostBootId: string;
  pid: number;
  procStartTicks: string;
};

/** Stable identifier for retries made by the same Linux process identity. */
export function writerProcessIdentityId(identity: WriterAttemptProcessIdentity): string {
  return digest('process-identity', `${identity.hostBootId}\0${identity.pid}\0${identity.procStartTicks}`);
}

/** Canonical source locators deliberately exist only in this in-memory object. */
export type WriterAttemptContext = {
  rootSessionId: string;
  rootSourceIdentityHash: string;
  process: WriterAttemptProcessIdentity;
  sources: ReadonlyMap<string, string>;
};

export type V3SourceDescriptor = {
  contentSha256: string;
  ctimeNs: number;
  device: number;
  generation: number;
  inode: number;
  mode: number;
  mtimeNs: number;
  sizeBytes: number;
  sourceIdentityHash: string;
};

export type V3TopologyEdge = {
  childSourceIdentityHash: string;
  edgeType: 'spawn';
  parentSourceIdentityHash: string;
};

export type V3PreflightManifest = {
  descriptors: V3SourceDescriptor[];
  edges: V3TopologyEdge[];
  envelope: string;
};

const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const canonicalJson = (value: Record<string, string | number>): string => JSON.stringify(value);
const leafHash = (domain: string, bytes: string): Buffer => createHash('sha256').update(domain).update(bytes, 'utf8').digest();

/** Returns Linux's unambiguous `(boot id, pid, start ticks)` process identity. */
export async function readWriterAttemptProcessIdentity(): Promise<WriterAttemptProcessIdentity> {
  if (process.platform !== 'linux') throw new Error('usage-v3 requires Linux /proc process identity');
  const [boot, stat] = await Promise.all([
    readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    readFile(`/proc/${process.pid}/stat`, 'utf8'),
  ]);
  const hostBootId = boot.trim().toLowerCase();
  const close = stat.lastIndexOf(')');
  const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/);
  // `/proc/<pid>/stat` starttime is field 22; fields starts at field 3.
  const procStartTicks = fields[19] ?? '';
  if (!/^[a-f0-9-]{36}$/.test(hostBootId) || !/^\d+$/.test(procStartTicks)) {
    throw new Error('usage-v3 cannot prove Linux process identity');
  }
  return { hostBootId, pid: process.pid, procStartTicks };
}

/** Builds the path-confined context; callers must never persist or log it. */
export async function createWriterAttemptContext(
  rootSessionId: string,
  rootTranscriptPath: string,
  manifest: CodexRolloutManifest,
): Promise<WriterAttemptContext> {
  if (!rootSessionId || manifest.files.length === 0 || manifest.files.length > MAX_SOURCES) {
    throw new Error('usage-v3 source allowlist is invalid');
  }
  const root = await realpath(rootTranscriptPath);
  const sources = new Map<string, string>();
  for (const file of manifest.files) {
    const canonical = await realpath(file.rolloutPath);
    const identity = sha256(canonical);
    if (sources.has(identity)) throw new Error('usage-v3 duplicate source identity');
    sources.set(identity, canonical);
  }
  const rootSourceIdentityHash = sha256(root);
  if (sources.get(rootSourceIdentityHash) !== root) throw new Error('usage-v3 root is not in allowlist');
  return { rootSessionId, rootSourceIdentityHash, process: await readWriterAttemptProcessIdentity(), sources };
}

function descriptorJson(descriptor: V3SourceDescriptor): string {
  if (!HEX_256.test(descriptor.contentSha256) || !HEX_256.test(descriptor.sourceIdentityHash)
    || ![descriptor.ctimeNs, descriptor.device, descriptor.generation, descriptor.inode, descriptor.mode,
      descriptor.mtimeNs, descriptor.sizeBytes].every(Number.isSafeInteger)) {
    throw new Error('usage-v3 descriptor is non-canonical');
  }
  return canonicalJson({ contentSha256: descriptor.contentSha256, ctimeNs: descriptor.ctimeNs,
    device: descriptor.device, generation: descriptor.generation, inode: descriptor.inode, mode: descriptor.mode,
    mtimeNs: descriptor.mtimeNs, sizeBytes: descriptor.sizeBytes, sourceIdentityHash: descriptor.sourceIdentityHash });
}

/** RFC-8785-compatible for this schema: ASCII keys, finite safe integers, and strings only. */
export function usageV3MerkleRoot(domain: 'manifest' | 'topology', items: string[]): string {
  const prefix = `usage-v3:${domain}`;
  if (items.length === 0) return createHash('sha256').update(`${prefix}-empty:v1\0`).digest('hex');
  let level = items.map(item => leafHash(`${prefix}-leaf:v1\0`, item));
  while (level.length > 1) {
    if (level.length % 2) level.push(level[level.length - 1]!);
    const next: Buffer[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(createHash('sha256').update(`${prefix}-node:v1\0`).update(level[index]!).update(level[index + 1]!).digest());
    }
    level = next;
  }
  return level[0]!.toString('hex');
}

/** Rejects malformed rooted spawn topology before any receipt can be passed. */
export function validateWriterAttemptTopology(root: string, descriptors: V3SourceDescriptor[], edges: V3TopologyEdge[]): void {
  if (!HEX_256.test(root) || descriptors.length === 0 || descriptors.length > MAX_SOURCES || edges.length > 512) {
    throw new Error('usage-v3 topology bounds failed');
  }
  const nodes = new Set(descriptors.map(value => value.sourceIdentityHash));
  if (nodes.size !== descriptors.length || !nodes.has(root)) throw new Error('usage-v3 topology source identity failed');
  const inbound = new Map<string, number>([...nodes].map(node => [node, 0]));
  const outbound = new Map<string, string[]>(); const seen = new Set<string>();
  for (const edge of edges) {
    const id = `${edge.parentSourceIdentityHash}\0${edge.childSourceIdentityHash}\0${edge.edgeType}`;
    if (edge.edgeType !== 'spawn' || !nodes.has(edge.parentSourceIdentityHash) || !nodes.has(edge.childSourceIdentityHash)
      || edge.parentSourceIdentityHash === edge.childSourceIdentityHash || seen.has(id)) throw new Error('usage-v3 topology edge failed');
    seen.add(id); inbound.set(edge.childSourceIdentityHash, inbound.get(edge.childSourceIdentityHash)! + 1);
    outbound.set(edge.parentSourceIdentityHash, [...(outbound.get(edge.parentSourceIdentityHash) ?? []), edge.childSourceIdentityHash]);
  }
  if (inbound.get(root) !== 0 || [...nodes].some(node => node !== root && inbound.get(node) !== 1)) throw new Error('usage-v3 topology indegree failed');
  const visited = new Set<string>();
  const walk = (node: string, depth: number): void => {
    if (depth > 8 || visited.has(node)) { if (visited.has(node)) throw new Error('usage-v3 topology cycle'); throw new Error('usage-v3 topology depth'); }
    visited.add(node); for (const child of outbound.get(node) ?? []) walk(child, depth + 1);
  };
  walk(root, 0); if (visited.size !== nodes.size) throw new Error('usage-v3 topology disconnected');
}

/**
 * First content pass. The locator is accepted only from WriterAttemptContext,
 * and never escapes in its return value. Every descriptor is path-free.
 */
type PreflightSourceScan = V3SourceDescriptor;
type ArenaFact = ParsedFact & { sourceIdentityHash: string; generation: number };

/** Bounded byte arena: facts are retained as framed canonical JSON, never objects. */
export class FactArena {
  private readonly chunks: Buffer[] = [];
  private used = 0;
  private count = 0;

  constructor(private readonly maxBytes = MAX_PENDING_FACT_BYTES, private readonly chunkBytes = 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(chunkBytes)
      || chunkBytes < 1 || maxBytes % chunkBytes !== 0) throw new RangeError('usage-v3 invalid fact arena bounds');
  }

  get usedBytes(): number { return this.used; }
  get allocatedBytes(): number { return this.chunks.length * this.chunkBytes; }

  append(fact: ArenaFact): void {
    if (this.count >= MAX_FACTS_PER_RUN) throw new V3WriterError('source_invalid', 'quarantined');
    const payload = Buffer.from(JSON.stringify({ byteEnd: fact.byteEnd, byteStart: fact.byteStart,
      cachedInputTokens: fact.cachedInputTokens, generation: fact.generation, inputTokens: fact.inputTokens,
      isSubagent: fact.isSubagent, model: fact.model, occurredAt: fact.occurredAt,
      outputTokens: fact.outputTokens, requestCount: fact.requestCount,
      sourceIdentityHash: fact.sourceIdentityHash }), 'utf8');
    if (payload.length > 0xffff_ffff || this.used + 4 + payload.length > this.maxBytes) {
      throw new V3WriterError('source_invalid', 'quarantined');
    }
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(payload.length);
    this.write(header); this.write(payload); this.count += 1;
  }

  *values(): IterableIterator<ArenaFact> {
    let offset = 0;
    while (offset < this.used) {
      const header = this.read(offset, 4); offset += 4;
      const length = header.readUInt32BE();
      const value: unknown = JSON.parse(this.read(offset, length).toString('utf8')); offset += length;
      if (!record(value)) throw new V3WriterError('source_invalid', 'quarantined');
      const generation = nonNegative(value.generation); const byteStart = nonNegative(value.byteStart);
      const byteEnd = nonNegative(value.byteEnd); const inputTokens = nonNegative(value.inputTokens);
      const outputTokens = nonNegative(value.outputTokens); const cachedInputTokens = nonNegative(value.cachedInputTokens);
      const requestCount = nonNegative(value.requestCount);
      if (typeof value.sourceIdentityHash !== 'string' || !HEX_256.test(value.sourceIdentityHash)
        || generation === null || byteStart === null || byteEnd === null || typeof value.occurredAt !== 'string'
        || typeof value.model !== 'string' || inputTokens === null || outputTokens === null
        || cachedInputTokens === null || requestCount === null || typeof value.isSubagent !== 'boolean') {
        throw new V3WriterError('source_invalid', 'quarantined');
      }
      yield { sourceIdentityHash: value.sourceIdentityHash, generation, byteStart, byteEnd,
        occurredAt: value.occurredAt, model: value.model, inputTokens, outputTokens, cachedInputTokens,
        requestCount, isSubagent: value.isSubagent };
    }
  }

  private write(bytes: Buffer): void {
    let sourceOffset = 0;
    while (sourceOffset < bytes.length) {
      const chunkIndex = Math.floor(this.used / this.chunkBytes);
      const chunkOffset = this.used % this.chunkBytes;
      if (!this.chunks[chunkIndex]) {
        if (this.allocatedBytes + this.chunkBytes > this.maxBytes) throw new V3WriterError('source_invalid', 'quarantined');
        this.chunks.push(Buffer.allocUnsafe(this.chunkBytes));
      }
      const length = Math.min(bytes.length - sourceOffset, this.chunkBytes - chunkOffset);
      bytes.copy(this.chunks[chunkIndex]!, chunkOffset, sourceOffset, sourceOffset + length);
      sourceOffset += length; this.used += length;
    }
  }

  private read(offset: number, length: number): Buffer {
    const output = Buffer.allocUnsafe(length);
    let copied = 0;
    while (copied < length) {
      const absolute = offset + copied;
      const chunkIndex = Math.floor(absolute / this.chunkBytes);
      const chunkOffset = absolute % this.chunkBytes;
      const size = Math.min(length - copied, this.chunkBytes - chunkOffset);
      this.chunks[chunkIndex]!.copy(output, copied, chunkOffset, chunkOffset + size); copied += size;
    }
    return output;
  }
}

export async function preflightWriterAttemptSource(
  context: WriterAttemptContext,
  sourceIdentityHash: string,
  generation: number,
  signal?: AbortSignal,
  options: { parseFacts?: boolean; modelHint?: string | null; isSubagent?: boolean;
    duration?: WorkDurationAccumulator; factArena?: FactArena; beforeChunk?: () => void } = {},
): Promise<PreflightSourceScan> {
  const sourcePath = context.sources.get(sourceIdentityHash);
  if (!sourcePath || !HEX_256.test(sourceIdentityHash) || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('usage-v3 context source is unavailable');
  }
  // Re-resolve on every open: replacing a file with a symlink or a different
  // canonical locator invalidates the attempt before a DB write.
  if (await realpath(sourcePath) !== sourcePath || sha256(sourcePath) !== sourceIdentityHash) {
    throw new Error('usage-v3 canonical locator drift');
  }
  const handle = await open(sourcePath, 'r');
  const content = createHash('sha256');
  const chunk = Buffer.allocUnsafe(V3_STREAM_CHUNK_BYTES);
  let tail = Buffer.alloc(0);
  let records = 0;
  let model = options.modelHint ?? '';
  let vector = { input: 0, cached: 0, output: 0 };
  try {
    const before = await handle.stat({ bigint: true });
    let offset = 0;
    for (;;) {
      signal?.throwIfAborted();
      options.beforeChunk?.();
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      content.update(chunk.subarray(0, bytesRead));
      const joined = Buffer.concat([tail, chunk.subarray(0, bytesRead)]);
      let start = 0;
      for (;;) {
        const end = joined.indexOf(10, start);
        if (end < 0) break;
        if (end - start > V3_MAX_RECORD_BYTES) throw new V3WriterError('source_invalid', 'quarantined');
        records += 1;
        if (records > MAX_FACTS_PER_SOURCE) throw new V3WriterError('source_invalid', 'quarantined');
        if (options.parseFacts) {
          const line = joined.subarray(start, end);
          const byteStart = offset - joined.length + start;
          let entry: unknown;
          try { entry = JSON.parse(line.toString('utf8')); } catch { throw new V3WriterError('source_invalid', 'quarantined'); }
          options.duration?.addEntry(entry, sourceIdentityHash);
          const parsed = parseFact(line, byteStart, byteStart + line.length + 1, model, vector);
          model = parsed.model; vector = parsed.vector;
          if (parsed.fact) {
            parsed.fact.isSubagent = options.isSubagent === true;
            if (!options.factArena) throw new V3WriterError('writer_failed');
            options.factArena.append({ ...parsed.fact, sourceIdentityHash, generation });
          }
        }
        start = end + 1;
      }
      tail = Buffer.from(joined.subarray(start));
      if (tail.length > V3_MAX_RECORD_BYTES) throw new V3WriterError('source_invalid', 'quarantined');
    }
    if (tail.length !== 0) throw new V3WriterError('source_invalid', 'quarantined');
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error('usage-v3 source changed during preflight');
    }
    // Epoch nanoseconds cannot be represented as JCS safe integers. The
    // receipt normalizes them to microsecond ticks for both passes.
    const ctimeNs = before.ctimeNs / 1_000n;
    const mtimeNs = before.mtimeNs / 1_000n;
    const numbers = [ctimeNs, before.dev, before.ino, before.mode, mtimeNs, before.size];
    if (numbers.some(value => value > BigInt(Number.MAX_SAFE_INTEGER))) throw new Error('usage-v3 stat exceeds JCS safe integer');
    return { contentSha256: content.digest('hex'), ctimeNs: Number(ctimeNs), device: Number(before.dev),
      generation, inode: Number(before.ino), mode: Number(before.mode), mtimeNs: Number(mtimeNs),
      sizeBytes: Number(before.size), sourceIdentityHash };
  } finally {
    await handle.close();
  }
}

/** Builds the path-free, bounded JCS/Merkle v1 receipt body after first pass. */
export function buildWriterAttemptManifest(
  context: WriterAttemptContext,
  descriptors: V3SourceDescriptor[],
  edges: V3TopologyEdge[],
): V3PreflightManifest {
  validateWriterAttemptTopology(context.rootSourceIdentityHash, descriptors, edges);
  const compareUtf8 = (left: string, right: string): number => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
  const sortedDescriptors = [...descriptors].sort((left, right) => compareUtf8(left.sourceIdentityHash, right.sourceIdentityHash)
    || left.generation - right.generation);
  const sourceRootHex = usageV3MerkleRoot('manifest', sortedDescriptors.map(descriptorJson));
  const sortedEdges = [...edges].sort((left, right) => compareUtf8(left.parentSourceIdentityHash, right.parentSourceIdentityHash)
    || compareUtf8(left.childSourceIdentityHash, right.childSourceIdentityHash) || compareUtf8(left.edgeType, right.edgeType));
  const edgeJson = sortedEdges.map(edge => canonicalJson({ childSourceIdentityHash: edge.childSourceIdentityHash,
    edgeType: edge.edgeType, parentSourceIdentityHash: edge.parentSourceIdentityHash }));
  const topologyRootHex = usageV3MerkleRoot('topology', edgeJson);
  const envelope = canonicalJson({ manifestVersion: 1, rootSourceIdentityHash: context.rootSourceIdentityHash,
    sourceCount: sortedDescriptors.length, sourceRootHex, topologyEdgeCount: sortedEdges.length, topologyRootHex });
  if (Buffer.byteLength(envelope, 'utf8') > 4 * 1024) throw new Error('usage-v3 manifest envelope exceeds 4KiB');
  return { descriptors: sortedDescriptors, edges: sortedEdges, envelope };
}

const monotonicNowNs = (): bigint => process.hrtime.bigint();
const RETAIN_THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const RETAIN_NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

async function metadataMatchesDescriptor(context: WriterAttemptContext, descriptor: V3SourceDescriptor): Promise<boolean> {
  const sourcePath = context.sources.get(descriptor.sourceIdentityHash);
  if (!sourcePath || await realpath(sourcePath) !== sourcePath) return false;
  const handle = await open(sourcePath, 'r');
  try {
    const value = await handle.stat({ bigint: true });
    return value.dev === BigInt(descriptor.device) && value.ino === BigInt(descriptor.inode)
      && value.mode === BigInt(descriptor.mode) && value.size === BigInt(descriptor.sizeBytes)
      && value.mtimeNs / 1_000n === BigInt(descriptor.mtimeNs)
      && value.ctimeNs / 1_000n === BigInt(descriptor.ctimeNs);
  } finally { await handle.close(); }
}

async function proveDeadProcess(processProof: UsageV3AuthorityTuple['proof']): Promise<{
  kind: 'process_missing' | 'process_reused' | 'host_rebooted'; observedHostBootId: string;
  observedPid: number; observedProcStartTicks: string | null;
} | null> {
  let observedHostBootId: string;
  try { observedHostBootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim().toLowerCase(); }
  catch { return null; }
  if (observedHostBootId !== processProof.hostBootId) {
    return { kind: 'host_rebooted', observedHostBootId, observedPid: processProof.pid, observedProcStartTicks: null };
  }
  let processStat: string;
  try { processStat = await readFile(`/proc/${processProof.pid}/stat`, 'utf8'); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? { kind: 'process_missing', observedHostBootId, observedPid: processProof.pid, observedProcStartTicks: null }
      : null;
  }
  const close = processStat.lastIndexOf(')');
  const observedProcStartTicks = close < 0 ? null : processStat.slice(close + 2).trim().split(/\s+/)[19] ?? null;
  if (!observedProcStartTicks) return null;
  return observedProcStartTicks !== processProof.procStartTicks
    ? { kind: 'process_reused', observedHostBootId, observedPid: processProof.pid, observedProcStartTicks }
    : null;
}

function renewOwnedLease(
  key: Parameters<typeof usageStatisticsV3Db.renewPreflightLease>[0],
  tuple: UsageV3AuthorityTuple,
  operationDeadlineNs: bigint,
): UsageV3AuthorityTuple {
  const now = monotonicNowNs();
  if (now >= operationDeadlineNs) throw new V3WriterError('writer_failed');
  const next = now + BigInt(LEASE_MS) * 1_000_000n;
  if (!usageStatisticsV3Db.renewPreflightLease(key, tuple, now, next)) throw new V3WriterError('writer_failed');
  return { ...tuple, leaseDeadlineMonotonicNs: next };
}

function releasePassedContext(
  key: Parameters<typeof usageStatisticsV3Db.recoverMissingWriterContext>[0],
  tuple: UsageV3AuthorityTuple,
): boolean {
  const now = monotonicNowNs();
  return now >= tuple.leaseDeadlineMonotonicNs
    ? usageStatisticsV3Db.expireOwnedPassedContext(key, tuple, now)
    : usageStatisticsV3Db.recoverMissingWriterContext(key, tuple, now, true);
}

/** ADR-169 writer lifecycle. Claim validates metadata only; finalize performs content pass two. */
async function runFencedWriterLifecycle(input: BuildCodexStatisticsV3Input, manifest: CodexRolloutManifest): Promise<'ready' | 'incomplete' | 'failed'> {
  const operationStartedNs = monotonicNowNs();
  const operationDeadlineNs = operationStartedNs + BigInt(OPERATION_MS) * 1_000_000n;
  const rootSessionId = manifest.root.sessionId ?? manifest.root.threadId;
  const ownerUserId = input.ownerUserId;
  if (!rootSessionId || typeof ownerUserId !== 'number' || !Number.isInteger(ownerUserId) || ownerUserId < 1) return 'incomplete';
  const context = await createWriterAttemptContext(rootSessionId, input.transcriptPath, manifest);
  let sourceBytes = 0;
  for (const sourcePath of context.sources.values()) {
    const metadata = await stat(sourcePath);
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) return 'incomplete';
    sourceBytes += metadata.size;
    if (sourceBytes > MAX_SOURCE_BYTES || sourceBytes * 2 > MAX_ATTEMPT_IO_BYTES) return 'incomplete';
  }
  const proof = { ...context.process, processIdentityId: writerProcessIdentityId(context.process) };
  const key = { ownerUserId, provider: 'codex', rootSessionId, scopeFingerprint: input.scopeFingerprint,
    attributionFingerprint: input.attributionFingerprint };
  const receiptId = randomUUID(); const authorityId = randomUUID();
  let deadline = operationStartedNs + BigInt(LEASE_MS) * 1_000_000n;
  let begun = usageStatisticsV3Db.beginPreflight({ ...key, authorityId, receiptId, proof,
    nowMonotonicNs: operationStartedNs, leaseDeadlineMonotonicNs: deadline, wallNowMs: Date.now() });
  if (!begun) {
    const recovery = usageStatisticsV3Db.getAuthorityRecoveryView(key);
    if (recovery?.process && recovery.activePreflightId && recovery.leaseDeadlineMonotonicNs !== null
      && (recovery.status === 'preflighting' || recovery.status === 'preflight_passed' || recovery.status === 'running')) {
      const stale: UsageV3AuthorityTuple = { status: recovery.status, activePreflightId: recovery.activePreflightId,
        activeRunId: recovery.activeRunId, token: recovery.token, proof: recovery.process,
        leaseDeadlineMonotonicNs: recovery.leaseDeadlineMonotonicNs };
      const sameProcess = recovery.process.processIdentityId === proof.processIdentityId
        && recovery.process.hostBootId === proof.hostBootId && recovery.process.pid === proof.pid
        && recovery.process.procStartTicks === proof.procStartTicks;
      const recoveryNow = monotonicNowNs();
      let recovered = recovery.status === 'preflight_passed' && sameProcess
        && recoveryNow >= recovery.leaseDeadlineMonotonicNs
        && usageStatisticsV3Db.expireOwnedPassedContext(key, stale, recoveryNow);
      if (!sameProcess) {
        const initialDeath = await proveDeadProcess(recovery.process);
        if (!initialDeath) return 'incomplete';
        const death = await proveDeadProcess(recovery.process);
        if (!death) return 'incomplete';
        recovered = recovery.status === 'running'
          ? usageStatisticsV3Db.recoverDeadCanonicalRun(key, stale, death, Date.now() + RETAIN_THIRTY_DAYS_MS)
          : recovery.status === 'preflight_passed'
            ? usageStatisticsV3Db.recoverDeadPassedContext(key, stale, death, Date.now() + RETAIN_THIRTY_DAYS_MS)
            : usageStatisticsV3Db.supersedeDeadOwner(key, stale, death);
      }
      if (recovered) {
        const retryNow = monotonicNowNs();
        if (retryNow >= operationDeadlineNs) return 'incomplete';
        deadline = retryNow + BigInt(LEASE_MS) * 1_000_000n;
        begun = usageStatisticsV3Db.beginPreflight({ ...key, authorityId: randomUUID(), receiptId,
          parentReceiptId: recovery.activePreflightId, proof, nowMonotonicNs: retryNow,
          leaseDeadlineMonotonicNs: deadline, wallNowMs: Date.now() });
      }
    }
  }
  if (!begun) return 'incomplete';
  let tuple: UsageV3AuthorityTuple = { status: 'preflighting', activePreflightId: receiptId, activeRunId: null,
    token: begun.token, proof, leaseDeadlineMonotonicNs: deadline };
  const retainUntilMs = Date.now() + RETAIN_THIRTY_DAYS_MS;
  try {
    tuple = renewOwnedLease(key, tuple, operationDeadlineNs);
    if (!usageStatisticsV3Db.reserveAttemptIoBudget(key, tuple, sourceBytes * 2, Date.now())) {
      throw new V3WriterError('writer_failed', 'incomplete');
    }
    const threadSources = new Map<string, string>([[manifest.root.threadId!, context.rootSourceIdentityHash]]);
    for (const link of manifest.linked) {
      tuple = renewOwnedLease(key, tuple, operationDeadlineNs);
      threadSources.set(link.spawn.agentThreadId!, sha256(await realpath(link.rolloutPath)));
    }
    const edges: V3TopologyEdge[] = manifest.linked.map(link => ({ edgeType: 'spawn',
      parentSourceIdentityHash: threadSources.get(link.parentThreadId) ?? '', childSourceIdentityHash: threadSources.get(link.spawn.agentThreadId!) ?? '' }));
    const parentByChild = new Map(edges.map(edge => [edge.childSourceIdentityHash, edge.parentSourceIdentityHash]));
    const descriptors: PreflightSourceScan[] = [];
    const duration = new WorkDurationAccumulator();
    const factArena = new FactArena();
    for (const identity of context.sources.keys()) {
      tuple = renewOwnedLease(key, tuple, operationDeadlineNs);
      const file = manifest.files.find(value => sha256(context.sources.get(identity)!) === identity);
      const descriptor = await preflightWriterAttemptSource(context, identity, 0, input.signal, {
        parseFacts: true, modelHint: file?.model, isSubagent: identity !== context.rootSourceIdentityHash,
        duration, factArena, beforeChunk: () => { tuple = renewOwnedLease(key, tuple, operationDeadlineNs); },
      });
      descriptors.push(descriptor);
      if (!usageStatisticsV3Db.recordPreflightSource(key, tuple, monotonicNowNs(), {
        receiptId, sourceIdentityHash: identity, generation: descriptor.generation, descriptorJson: descriptorJson(descriptor),
        parentSourceIdentityHash: parentByChild.get(identity) ?? null, edgeType: parentByChild.has(identity) ? 'spawn' : null,
      })) throw new V3WriterError('snapshot_rejected', 'failed');
    }
    tuple = renewOwnedLease(key, tuple, operationDeadlineNs);
    const receipt = buildWriterAttemptManifest(context, descriptors, edges);
    const envelope = JSON.parse(receipt.envelope) as { sourceRootHex: string; topologyRootHex: string };
    if (!usageStatisticsV3Db.recordPreflightMerkle(key, tuple, monotonicNowNs(), { receiptId,
      sourceRootHex: envelope.sourceRootHex, topologyRootHex: envelope.topologyRootHex,
      rootSourceIdentityHash: context.rootSourceIdentityHash, envelopeJson: receipt.envelope })) throw new V3WriterError('snapshot_rejected', 'failed');
    if (!usageStatisticsV3Db.passPreflight(key, receiptId, tuple.token, proof,
      tuple.leaseDeadlineMonotonicNs, monotonicNowNs(), retainUntilMs)) throw new V3WriterError('writer_failed');
    tuple = { ...tuple, status: 'preflight_passed', token: tuple.token + 1 };
    // Claim is metadata-only: no source bytes are read between receipt and claim.
    for (const descriptor of receipt.descriptors) {
      if (!(await metadataMatchesDescriptor(context, descriptor))) {
        return releasePassedContext(key, tuple) ? 'incomplete' : 'failed';
      }
    }
    const claimNow = monotonicNowNs();
    if (claimNow >= operationDeadlineNs) throw new V3WriterError('writer_failed');
    const claimDeadline = claimNow + BigInt(LEASE_MS) * 1_000_000n;
    const runId = randomUUID();
    if (!usageStatisticsV3Db.claimCanonicalRun({ ...key, receiptId, runId, token: tuple.token, proof,
      nowMonotonicNs: claimNow, expectedLeaseDeadlineMonotonicNs: tuple.leaseDeadlineMonotonicNs,
      leaseDeadlineMonotonicNs: claimDeadline, retainUntilMs,
      metricsFingerprint: input.metricsFingerprint ?? metricsFingerprintFor(input.sessionId), pricingVersion: input.pricingVersion })) {
      releasePassedContext(key, tuple);
      return 'failed';
    }
    tuple = { ...tuple, status: 'running', activeRunId: runId, token: tuple.token + 1,
      leaseDeadlineMonotonicNs: claimDeadline };
    for (const edge of receipt.edges) {
      tuple = renewOwnedLease(key, tuple, operationDeadlineNs);
      if (!usageStatisticsV3Db.recordCanonicalLineage(key, tuple, monotonicNowNs(), edge)) throw new V3WriterError('lineage_incomplete');
    }
    for (const fact of factArena.values()) {
      tuple = renewOwnedLease(key, tuple, operationDeadlineNs);
      if (!usageStatisticsV3Db.recordCanonicalFact(key, tuple, monotonicNowNs(), {
        eventKey: sha256(`${fact.sourceIdentityHash}+${fact.generation}+${fact.byteStart}`),
        sourceIdentityHash: fact.sourceIdentityHash, sourceGeneration: fact.generation, byteStart: fact.byteStart,
        occurredAt: fact.occurredAt, model: fact.model, inputTokens: fact.inputTokens, outputTokens: fact.outputTokens,
        cachedInputTokens: fact.cachedInputTokens, requestCount: fact.requestCount, isSubagent: fact.isSubagent,
        evidence: { sourceKey: fact.sourceIdentityHash, generation: fact.generation,
          byteStart: fact.byteStart, byteEnd: fact.byteEnd },
      })) throw new V3WriterError('fact_rejected');
    }
    const workDurationMs = duration.result();
    tuple = renewOwnedLease(key, tuple, operationDeadlineNs);
    if (workDurationMs === null || !usageStatisticsV3Db.setCanonicalWorkDuration(key, tuple, monotonicNowNs(), workDurationMs)) {
      throw new V3WriterError('writer_failed');
    }
    // Second and only second content pass: rehash and rebuild exactly the first receipt.
    const finalized: PreflightSourceScan[] = [];
    for (const value of receipt.descriptors) {
      tuple = renewOwnedLease(key, tuple, operationDeadlineNs);
      finalized.push(await preflightWriterAttemptSource(context, value.sourceIdentityHash, value.generation,
        input.signal, { parseFacts: false, beforeChunk: () => {
          tuple = renewOwnedLease(key, tuple, operationDeadlineNs);
        } }));
    }
    tuple = renewOwnedLease(key, tuple, operationDeadlineNs);
    const finalReceipt = buildWriterAttemptManifest(context, finalized, receipt.edges);
    if (finalReceipt.envelope !== receipt.envelope) throw new V3WriterError('source_changed', 'incomplete');
    if (!usageStatisticsV3Db.finalizeCanonicalRun(key, tuple, monotonicNowNs(), { receiptId,
      sourceRootHex: envelope.sourceRootHex, topologyRootHex: envelope.topologyRootHex,
      rootSourceIdentityHash: context.rootSourceIdentityHash, envelopeJson: receipt.envelope })) {
      throw new V3WriterError('finalize_validation_failed');
    }
    return 'ready';
  } catch (error) {
    const failure = error instanceof V3WriterError ? error : new V3WriterError('writer_failed');
    const terminalStatus = failure.status === 'quarantined' ? 'quarantined' : 'failed';
    const terminalRetainUntil = Date.now() + (terminalStatus === 'quarantined' ? RETAIN_NINETY_DAYS_MS : RETAIN_THIRTY_DAYS_MS);
    const now = monotonicNowNs();
    let closed = false;
    if (now >= tuple.leaseDeadlineMonotonicNs) {
      if (tuple.status === 'running') closed = usageStatisticsV3Db.expireOwnedCanonical(key, tuple, now, terminalRetainUntil);
      else if (tuple.status === 'preflighting') closed = usageStatisticsV3Db.expireOwnedPreflight(key, tuple, now, terminalRetainUntil);
      else if (tuple.status === 'preflight_passed') closed = usageStatisticsV3Db.expireOwnedPassedContext(key, tuple, now);
    } else if (tuple.status === 'running') {
      closed = usageStatisticsV3Db.terminateCanonicalRun(key, tuple, now, terminalStatus,
        failure.code === 'source_changed' ? 'canonical_source_changed' : 'canonical_finalize_mismatch', terminalRetainUntil);
    } else if (tuple.status === 'preflighting') {
      closed = usageStatisticsV3Db.terminatePreflight(key, tuple, now, terminalStatus, terminalRetainUntil);
    } else if (tuple.status === 'preflight_passed') {
      closed = usageStatisticsV3Db.recoverMissingWriterContext(key, tuple, now, true);
    }
    if (!closed) return 'failed';
    return failure.status === 'incomplete' ? 'incomplete' : 'failed';
  }
}

class V3WriterError extends Error {
  constructor(readonly code: UsageStatisticsFailureCode, readonly status: 'incomplete' | 'quarantined' | 'failed' = 'failed') { super(code); }
}

type ParsedFact = Omit<UsageStatisticsV3Fact, 'eventKey' | 'evidence'> & { byteStart: number; byteEnd: number };
type SourceScan = { contentSha256: string; sizeBytes: number; terminalVectorSha256: string; facts: ParsedFact[] };

export type BuildCodexStatisticsV3Input = {
  sessionId: string; transcriptPath: string; scopeFingerprint: string; attributionFingerprint: string;
  /** Must originate from the scheduler's owner-spawn DB proof; never infer it from transcript metadata. */
  ownerUserId?: number;
  metricsFingerprint?: string; pricingVersion: string;
  /** Retained for callers that also use this snapshot; retries deliberately resolve their own fresh manifest. */
  manifest?: CodexRolloutManifest;
  signal?: AbortSignal;
  /** Resolve a fresh rollout tree for every retry attempt. Production uses the canonical resolver. */
  manifestResolver?: (transcriptPath: string, signal?: AbortSignal) => Promise<CodexRolloutManifest>;
  /** Testable wall-clock/backoff seam; repository attempt and aggregate I/O budgets remain authoritative. */
  retryPolicy?: UsageV3RetryPolicyDeps;
};

export type ReadyUsageV3 = {
  facts: UsageStatisticsV3Fact[];
  /** Exact caller-supplied filter, never inferred from the observed facts. */
  window: { since: string | null; until: string | null };
  attribution: { scopeFingerprint: string; attributionFingerprint: string };
  counts: { facts: number; requests: number; rolloutCount: number; subagentSpawnCount: number;
    subagentRolloutCount: number; subagentRequestCount: number; subagentRequests: number };
  durations: { workDurationMs: number };
  workDurationMs: number;
  usage: SessionUsage;
};

/** Projects a ready v3 run with exact window filtering; no unbacked turn projection is emitted. */
export function readReadyUsageV3(input: Pick<BuildCodexStatisticsV3Input, 'sessionId' | 'scopeFingerprint' | 'attributionFingerprint'> & {
  since?: string; until?: string; metricsFingerprint: string;
}): ReadyUsageV3 | null {
  const ownerUserId = participantsDb.resolveStrictSpawnOwnerUserId(input.sessionId);
  if (ownerUserId === null || !input.metricsFingerprint) return null;
  const run = usageStatisticsV3Db.getReadyCanonicalRun({ ownerUserId, provider: 'codex', rootSessionId: input.sessionId,
    scopeFingerprint: input.scopeFingerprint, attributionFingerprint: input.attributionFingerprint,
    metricsFingerprint: input.metricsFingerprint });
  if (!run) return null;
  const meta = usageStatisticsV3Db.getCanonicalProjectionMeta(run.runId);
  if (!meta || meta.workDurationMs === null) return null;
  const since = input.since === undefined ? null : Date.parse(input.since);
  const until = input.until === undefined ? null : Date.parse(input.until);
  if ((since !== null && !Number.isFinite(since)) || (until !== null && !Number.isFinite(until))
    || (since !== null && until !== null && since >= until)) return null;
  const facts = usageStatisticsV3Db.listCanonicalFacts(run.runId).filter((fact) => {
    const occurredAt = Date.parse(fact.occurredAt);
    return Number.isFinite(occurredAt) && (since === null || occurredAt >= since) && (until === null || occurredAt < until);
  });
  const byModel = new Map<string, { model: string; totals: ReturnType<typeof emptyTotals>; requests: number }>();
  let requests = 0;
  let subagentRequests = 0;
  for (const fact of facts) {
    const row = byModel.get(fact.model) ?? { model: fact.model, totals: emptyTotals(), requests: 0 };
    row.totals.input += fact.inputTokens - fact.cachedInputTokens;
    row.totals.cacheRead += fact.cachedInputTokens;
    row.totals.output += fact.outputTokens;
    row.requests += fact.requestCount;
    requests += fact.requestCount;
    if (fact.isSubagent) subagentRequests += fact.requestCount;
    byModel.set(fact.model, row);
  }
  const usage: SessionUsage = { provider: 'codex', perModel: [...byModel.values()], subagentRequests, workDurationMs: meta.workDurationMs,
    skipped: { synthetic: 0, duplicates: 0 }, snapshotStatus: 'complete' };
  return { facts, window: { since: input.since ?? null, until: input.until ?? null },
    attribution: { scopeFingerprint: input.scopeFingerprint, attributionFingerprint: input.attributionFingerprint },
    counts: { facts: facts.length, requests, rolloutCount: meta.sourceCount, subagentSpawnCount: meta.lineageCount,
      subagentRolloutCount: new Set(facts.filter(fact => fact.isSubagent).map(fact => fact.sourceIdentityHash)).size,
      subagentRequestCount: subagentRequests, subagentRequests },
    durations: { workDurationMs: meta.workDurationMs }, workDurationMs: meta.workDurationMs, usage };
}

/** Compatibility reader for the existing session-cost integration. */
export function readCodexStatisticsV3(input: Pick<BuildCodexStatisticsV3Input, 'sessionId' | 'scopeFingerprint' | 'attributionFingerprint'>): SessionUsage | null {
  return readReadyUsageV3({ ...input, metricsFingerprint: metricsFingerprintFor(input.sessionId) })?.usage ?? null;
}

function parseFact(line: Buffer, byteStart: number, byteEnd: number, model: string, previous: { input: number; cached: number; output: number }): { fact: ParsedFact | null; model: string; vector: { input: number; cached: number; output: number } } {
  let entry: unknown;
  try { entry = JSON.parse(line.toString('utf8')); } catch { throw new V3WriterError('source_invalid', 'quarantined'); }
  if (!record(entry) || !record(entry.payload)) return { fact: null, model, vector: previous };
  const payload = entry.payload;
  const nextModel = typeof payload.model === 'string' && payload.model.trim() ? payload.model : model;
  if (payload.type !== 'token_count') return { fact: null, model: nextModel, vector: previous };
  const info = record(payload.info) && record(payload.info.total_token_usage) ? payload.info.total_token_usage : null;
  const timestamp = typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp)) ? entry.timestamp : null;
  if (!info || !timestamp || !nextModel) throw new V3WriterError('source_invalid', 'quarantined');
  const input = nonNegative(info.input_tokens); const cached = nonNegative(info.cached_input_tokens); const output = nonNegative(info.output_tokens);
  if (input === null || cached === null || output === null || cached > input) throw new V3WriterError('source_invalid', 'quarantined');
  if (input < previous.input || cached < previous.cached || output < previous.output) throw new V3WriterError('vector_reset_unmarked', 'quarantined');
  const vector = { input, cached, output };
  return { fact: { occurredAt: timestamp, model: nextModel, inputTokens: input - previous.input,
    cachedInputTokens: cached - previous.cached, outputTokens: output - previous.output,
    requestCount: 1, isSubagent: false, byteStart, byteEnd }, model: nextModel, vector };
}

async function scanSource(sourcePath: string, modelHint: string | null, isSubagent: boolean,
  duration: WorkDurationAccumulator, durationSource: string, signal?: AbortSignal): Promise<SourceScan> {
  const handle = await open(sourcePath, 'r');
  const hash = createHash('sha256').update('usage-v3:content\0');
  // Content passes are intentionally framed at 1 MiB.  `tail` carries only
  // the bounded current record, so a 4 MiB record never grows memory without
  // a hard cap.
  const chunk = Buffer.allocUnsafe(V3_STREAM_CHUNK_BYTES);
  const facts: ParsedFact[] = [];
  let tail = Buffer.alloc(0); let offset = 0; let pendingFactBytes = 0;
  let model = modelHint ?? ''; let vector = { input: 0, cached: 0, output: 0 };
  try {
    const before = await handle.stat();
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      const data = Buffer.concat([tail, chunk.subarray(0, bytesRead)]);
      let start = 0;
      for (;;) {
        const newline = data.indexOf(10, start);
        if (newline < 0) break;
        const line = data.subarray(start, newline);
        if (line.length > MAX_RECORD_BYTES) throw new V3WriterError('source_invalid', 'quarantined');
        const byteStart = offset - data.length + start;
        let entry: unknown;
        try { entry = JSON.parse(line.toString('utf8')); } catch { throw new V3WriterError('source_invalid', 'quarantined'); }
        duration.addEntry(entry, durationSource);
        const parsed = parseFact(line, byteStart, byteStart + line.length + 1, model, vector);
        model = parsed.model; vector = parsed.vector;
        if (parsed.fact) {
          parsed.fact.isSubagent = isSubagent;
          pendingFactBytes += Buffer.byteLength(JSON.stringify(parsed.fact));
          if (pendingFactBytes > MAX_PENDING_FACT_BYTES) throw new V3WriterError('source_invalid', 'quarantined');
          facts.push(parsed.fact);
        }
        if (facts.length > MAX_FACTS_PER_SOURCE) throw new V3WriterError('source_invalid', 'quarantined');
        start = newline + 1;
      }
      tail = Buffer.from(data.subarray(start));
      if (tail.length > MAX_RECORD_BYTES) throw new V3WriterError('source_invalid', 'quarantined');
      hash.update(chunk.subarray(0, bytesRead));
    }
    if (tail.length !== 0) throw new V3WriterError('source_invalid', 'incomplete');
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw new V3WriterError('source_changed', 'incomplete');
    return { contentSha256: hash.digest('hex'), sizeBytes: before.size, terminalVectorSha256: digest('vector', JSON.stringify(vector)), facts };
  } finally { await handle.close(); }
}

function metricsFingerprintFor(sessionId: string): string {
  return digest('response-turn-metrics', JSON.stringify(responseTurnMetricsDb.listSessionWindows(sessionId).map((metric) => [
    metric.assistantMessageId, metric.startedAt, metric.completedAt, metric.durationMs,
  ])));
}

function manifestFingerprint(manifest: CodexRolloutManifest, sourceKeys: Map<string, string>, content: Map<string, string>): string {
  const allowlist = manifest.files.map((file) => [sourceKeys.get(file.rolloutPath), content.get(file.rolloutPath)]);
  const links = manifest.linked.map((link) => [link.parentThreadId, link.spawn.callId, link.spawn.agentThreadId, sourceKeys.get(link.rolloutPath)]);
  const canonical = JSON.stringify({ allowlist, links });
  if (Buffer.byteLength(canonical, 'utf8') > 4 * 1024) throw new V3WriterError('manifest_incomplete', 'incomplete');
  return digest('manifest', canonical);
}

type LifecycleWaiter = {
  grant: (release: () => void) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
};

/** Creates the process-local lifecycle admission gate used by tests and production. */
export function createUsageV3LifecycleSemaphore(limit = 4, waitMs = LIFECYCLE_WAIT_MS): {
  acquire: (signal?: AbortSignal) => Promise<() => void>;
} {
  let active = 0;
  const waiters: LifecycleWaiter[] = [];
  const releaseSlot = (): void => {
    active -= 1;
    const waiter = waiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    if (waiter.abort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.abort);
    active += 1;
    waiter.grant(releaseOnce());
  };
  const releaseOnce = (): (() => void) => {
    let released = false;
    return () => { if (!released) { released = true; releaseSlot(); } };
  };
  return {
    acquire(signal?: AbortSignal): Promise<() => void> {
      if (signal?.aborted) return Promise.reject(new Error('usage-v3 lifecycle aborted'));
      if (active < limit) { active += 1; return Promise.resolve(releaseOnce()); }
      return new Promise((grant, reject) => {
        const waiter = {} as LifecycleWaiter;
        const remove = (error: Error): void => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          if (waiter.abort && signal) signal.removeEventListener('abort', waiter.abort);
          reject(error);
        };
        waiter.grant = grant; waiter.signal = signal;
        waiter.timer = setTimeout(() => remove(new Error('usage-v3 lifecycle admission timeout')), waitMs);
        waiter.abort = () => remove(new Error('usage-v3 lifecycle aborted'));
        signal?.addEventListener('abort', waiter.abort, { once: true });
        waiters.push(waiter);
      });
    },
  };
}

const lifecycleSemaphore = createUsageV3LifecycleSemaphore();

/** Creates lazy 15-minute cleanup maintenance without an interval or open handle. */
export function createUsageV3CleanupMaintenance(): (nowNs?: bigint, wallNowMs?: number) => number {
  let nextRunNs = 0n;
  return (nowNs = monotonicNowNs(), wallNowMs = Date.now()): number => {
    if (usageStatisticsV3WriterMode() !== 'on' || usageStatisticsV3ReaderMode() === 'rollback') return 0;
    if (nowNs < nextRunNs) return 0;
    let cleaned = 0;
    for (let call = 0; call < 5; call += 1) {
      const count = usageStatisticsV3Db.cleanupPreflightReceipts(wallNowMs, 100);
      cleaned += count;
      if (count < 100) break;
    }
    nextRunNs = nowNs + CLEANUP_INTERVAL_NS;
    return cleaned;
  };
}

export const runUsageV3CleanupMaintenance = createUsageV3CleanupMaintenance();

export type UsageV3RetryPolicyDeps = {
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** Applies ADR-184's three-attempt, 15-minute retry window and exact 1s/4s backoff. */
export async function runUsageV3RetryPolicy<T extends 'ready' | 'incomplete' | 'failed'>(
  attempt: () => Promise<T>,
  deps: UsageV3RetryPolicyDeps = {},
): Promise<T> {
  const nowMs = deps.nowMs ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const startedAt = nowMs();
  let result = await attempt();
  for (const delayMs of RETRY_BACKOFF_MS) {
    if (result !== 'incomplete' || nowMs() - startedAt + delayMs > RETRY_WINDOW_MS) return result;
    await sleep(delayMs);
    if (nowMs() - startedAt > RETRY_WINDOW_MS) return result;
    result = await attempt();
  }
  return result;
}

/** Full-generation writer; all input is streamed, bounded, and quarantined on ambiguity. */
export async function buildCodexStatisticsV3(input: BuildCodexStatisticsV3Input): Promise<'ready' | 'incomplete' | 'off' | 'failed'> {
  if (usageStatisticsV3WriterMode() === 'off' || usageStatisticsV3ReaderMode() === 'rollback') return 'off';
  // This is intentionally before any file/DB work. A background job without a
  // trusted spawn-owner is not eligible for v3, even in shadow mode.
  if (typeof input.ownerUserId !== 'number' || !Number.isInteger(input.ownerUserId) || input.ownerUserId < 1) return 'incomplete';
  let release: (() => void) | undefined;
  try { release = await lifecycleSemaphore.acquire(input.signal); } catch { return 'incomplete'; }
  try {
    const resolveManifest = input.manifestResolver ?? resolveCodexLinkedRollouts;
    return await runUsageV3RetryPolicy(async () => {
      const manifest = await resolveManifest(input.transcriptPath, input.signal);
      const rootId = manifest.root.sessionId ?? manifest.root.threadId;
      if (!manifest.complete || !rootId || !manifest.root.threadId
        || manifest.files.length > MAX_SOURCES || manifest.linked.length > 512) return 'incomplete';
      return runFencedWriterLifecycle(input, manifest);
    }, input.retryPolicy);
  } finally { release(); }
  /* Legacy ledger writes below remain temporarily retained only for the reader
   * migration; the fenced lifecycle above is the sole writer path. */
  /*
  const canonicalRoot = await realpath(input.transcriptPath);
  const sourceKeys = new Map<string, string>();
  for (const file of manifest.files) sourceKeys.set(file.rolloutPath, sourceKeyFor(await realpath(file.rolloutPath)));
  const duration = new WorkDurationAccumulator();
  const scans = new Map<string, SourceScan>();
  const content = new Map<string, string>();
  let scannedFacts = 0;
  let scannedBytes = 0;
  for (const file of manifest.files) {
    const sourcePath = await realpath(file.rolloutPath);
    const scan = await scanSource(sourcePath, file.model, sourcePath !== canonicalRoot, duration, sourceKeys.get(file.rolloutPath)!, input.signal);
    scans.set(file.rolloutPath, scan);
    content.set(file.rolloutPath, scan.contentSha256);
    scannedFacts += scan.facts.length;
    scannedBytes += scan.sizeBytes + scan.facts.reduce((sum, fact) => sum + Buffer.byteLength(JSON.stringify(fact)), 0);
    if (scannedFacts > MAX_FACTS_PER_RUN || scannedBytes > MAX_RUN_BYTES) throw new V3WriterError('source_invalid', 'quarantined');
  }
  const fingerprint = manifestFingerprint(manifest, sourceKeys, content);
  const generation = Number.parseInt(fingerprint.slice(0, 12), 16);
  const leaseOwner = randomUUID(); const runId = randomUUID();
  if (!usageStatisticsV3Db.claimRun({ runId, sessionId: input.sessionId, rootSessionId: rootId, provider: 'codex', status: 'building',
    manifestFingerprint: fingerprint, scopeFingerprint: input.scopeFingerprint, attributionFingerprint: input.attributionFingerprint,
    metricsFingerprint: input.metricsFingerprint ?? metricsFingerprintFor(input.sessionId), pricingVersion: input.pricingVersion, generation, leaseOwner,
    leaseExpiresAtMs: Date.now() + LEASE_MS, evidence: { manifestFingerprint: fingerprint, workDurationRequired: true } })) return 'failed';
  try {
    let runFacts = 0; let runBytes = 0;
    for (const link of manifest.linked) {
      if (!link.spawn.callId || !link.spawn.agentThreadId || !link.parentThreadId) throw new V3WriterError('lineage_incomplete', 'incomplete');
      const sourceKey = sourceKeys.get(link.rolloutPath);
      if (!sourceKey || !usageStatisticsV3Db.appendLineage(runId, leaseOwner, generation, { rootSessionId: rootId,
        parentThreadId: link.parentThreadId, spawnCallId: link.spawn.callId, agentThreadId: link.spawn.agentThreadId,
        childGeneration: generation, sourceKey })) throw new V3WriterError('lineage_incomplete', 'failed');
    }
    for (const file of manifest.files) {
      input.signal?.throwIfAborted();
      const scan = scans.get(file.rolloutPath)!;
      runFacts += scan.facts.length;
      runBytes += scan.sizeBytes + scan.facts.reduce((sum, fact) => sum + Buffer.byteLength(JSON.stringify(fact)), 0);
      if (runFacts > MAX_FACTS_PER_RUN || runBytes > MAX_RUN_BYTES) throw new V3WriterError('source_invalid', 'quarantined');
      const sourceKey = sourceKeys.get(file.rolloutPath)!;
      if (!usageStatisticsV3Db.recordSourceSnapshot(runId, leaseOwner, generation, { sourceKey, sourceGeneration: generation,
        contentSha256: scan.contentSha256, sizeBytes: scan.sizeBytes, factCount: scan.facts.length,
        terminalVectorSha256: scan.terminalVectorSha256, manifestFingerprint: fingerprint })) throw new V3WriterError('snapshot_rejected', 'failed');
      for (const fact of scan.facts) if (!usageStatisticsV3Db.appendFact(runId, leaseOwner, generation, {
        eventKey: `${sourceKey}+${generation}+${fact.byteStart}`, occurredAt: fact.occurredAt, model: fact.model,
        inputTokens: fact.inputTokens, cachedInputTokens: fact.cachedInputTokens, outputTokens: fact.outputTokens,
        requestCount: fact.requestCount, isSubagent: fact.isSubagent,
        evidence: { sourceKey, generation, byteStart: fact.byteStart, byteEnd: fact.byteEnd, manifestFingerprint: fingerprint },
      })) throw new V3WriterError('fact_rejected', 'failed');
    }
    const refreshed = await resolveCodexLinkedRollouts(input.transcriptPath, input.signal);
    const refreshedKeys = new Map<string, string>();
    const refreshedContent = new Map<string, string>();
    for (const file of refreshed.files) {
      refreshedKeys.set(file.rolloutPath, sourceKeyFor(await realpath(file.rolloutPath)));
      const scan = await scanSource(await realpath(file.rolloutPath), file.model, false, new WorkDurationAccumulator(),
        refreshedKeys.get(file.rolloutPath)!, input.signal);
      refreshedContent.set(file.rolloutPath, scan.contentSha256);
    }
    if (!refreshed.complete || manifestFingerprint(refreshed, refreshedKeys, refreshedContent) !== fingerprint) {
      throw new V3WriterError('source_changed', 'incomplete');
    }
    const workDurationMs = duration.result();
    if (workDurationMs === null || !usageStatisticsV3Db.setRunWorkDuration(runId, leaseOwner, generation, workDurationMs)) {
      throw new V3WriterError('writer_failed', 'incomplete');
    }
    if (!usageStatisticsV3Db.finalizeReady(runId, leaseOwner, generation)) throw new V3WriterError('finalize_validation_failed', 'failed');
    return 'ready';
  } catch (error) {
    const failure = error instanceof V3WriterError ? error : new V3WriterError('writer_failed');
    usageStatisticsV3Db.markRunTerminal(runId, leaseOwner, generation, failure.status, failure.code);
    return failure.status === 'incomplete' ? 'incomplete' : 'failed';
  }
  */
}
