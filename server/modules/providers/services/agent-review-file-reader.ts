import { constants, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ReviewContainer } from '../../database/index.js';

import { type ParsedReviewEvidence, type ReviewRawSource, ReviewEvidenceError, reviewBytesSha, reviewRawContainer } from './agent-review-raw-evidence.js';
import { parseAgentReviewRawEvidence } from './agent-review-raw-parser.js';

type FileHandle = Awaited<ReturnType<typeof fs.open>>;
type Observation = { phase: 'preopen'; failure: 'nofollow' | 'symlink' | 'open_failed' | 'read_timeout' }
  | { phase: 'postopen'; fileDev: string; fileIno: string; capturedSize: number };
export type ReviewReadFailure = { reason: ReviewEvidenceError['reason']; observation: Observation; agentId: string | null; closureFailed?: true };
export type TrustedReviewLocation = ReviewContainer & { projectDirectory: string };
export type ReviewCommittedPrefix = { offset: number; sha256: string; fileDev: string; fileIno: string };
export type StableReviewSnapshot = {
  evidence: ParsedReviewEvidence; fileDev: string; fileIno: string; capturedSize: number;
  fullSha256: string; committedPrefixSha256: string; failedAttempts: readonly ReviewReadFailure[];
};

/** Only bounded reason and actual observed identity escape a failed read, never OS paths. */
export class ReviewFileReadError extends Error {
  constructor(readonly failures: readonly ReviewReadFailure[]) { super(failures.at(-1)?.reason ?? 'invalid_shape'); }
}

const CLOEXEC = 0x80000; // Linux O_CLOEXEC; procfs descriptor traversal is Linux-specific.
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | CLOEXEC;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | CLOEXEC;
const RETRYABLE = new Set(['unstable_read', 'source_grew', 'read_timeout']);
const acceptedSnapshots = new WeakSet<object>();
const EMPTY_SHA = reviewBytesSha('');

function checkDeadline(deadline: number): void {
  if (performance.now() >= deadline) throw new ReviewEvidenceError('read_timeout');
}

function exactIdentity(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size
    && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
}

function components(location: TrustedReviewLocation, source: ReviewRawSource): string[] {
  const root = location.projectDirectory;
  if (process.platform !== 'linux' || !path.isAbsolute(root) || path.resolve(root) !== root
    || source.sessionId.includes('/') || source.sessionId.includes('\\') || ['.', '..'].includes(source.sessionId)) {
    throw new ReviewEvidenceError('invalid_shape');
  }
  const relative = source.source === 'agent' ? [`${source.sessionId}.jsonl`]
    : [source.sessionId, 'subagents', 'workflows', source.workflowId, 'journal.jsonl'];
  const all = [...root.split('/').filter(Boolean), ...relative];
  if (all.some(part => !part || part === '.' || part === '..' || part.includes('\0'))) throw new ReviewEvidenceError('invalid_shape');
  return all;
}

function failure(error: unknown, observation: Observation): ReviewReadFailure {
  const code = (error as NodeJS.ErrnoException)?.code;
  const reason = error instanceof ReviewEvidenceError ? error.reason : 'unstable_read';
  const preopen: Observation = { phase: 'preopen', failure: reason === 'read_timeout' ? 'read_timeout'
    : code === 'ELOOP' || code === 'ENOTDIR' ? 'nofollow' : 'open_failed' };
  return Object.freeze({ reason: code === 'ELOOP' || code === 'ENOTDIR' ? 'invalid_shape' : reason,
    observation: Object.freeze(observation.phase === 'postopen' ? observation : preopen),
    agentId: error instanceof ReviewEvidenceError ? error.agentId : null });
}

async function closeAll(handles: FileHandle[]): Promise<void> {
  const closed = await Promise.allSettled(handles.reverse().map(async handle => handle.close()));
  if (closed.some(value => value.status === 'rejected')) throw new ReviewEvidenceError('invalid_shape');
}

async function pinDirectories(names: string[], handles: FileHandle[], deadline: number): Promise<Array<{ lookup: string; stat: BigIntStats }>> {
  let directory = await fs.open('/', DIRECTORY_FLAGS); handles.push(directory); checkDeadline(deadline);
  const pinned: Array<{ lookup: string; stat: BigIntStats }> = [];
  for (const name of names.slice(0, -1)) {
    checkDeadline(deadline);
    const lookup = `/proc/self/fd/${directory.fd}/${name}`;
    directory = await fs.open(lookup, DIRECTORY_FLAGS); handles.push(directory); checkDeadline(deadline);
    const stat = await directory.stat({ bigint: true }); checkDeadline(deadline);
    pinned.push({ lookup, stat });
  }
  return pinned;
}

async function readCaptured(file: FileHandle, size: number, deadline: number): Promise<Buffer> {
  const output = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    checkDeadline(deadline);
    const { bytesRead } = await file.read({ buffer: output, offset, length: Math.min(65_536, size - offset), position: offset });
    checkDeadline(deadline);
    if (bytesRead === 0) throw new ReviewEvidenceError('unstable_read');
    offset += bytesRead;
  }
  return output;
}

function checkPrefix(prefix: ReviewCommittedPrefix | null, bytes: Buffer, before: BigIntStats): string {
  if (!prefix) return EMPTY_SHA;
  if (!Number.isSafeInteger(prefix.offset) || prefix.offset < 0 || !/^[0-9a-f]{64}$/.test(prefix.sha256)
    || !/^[0-9]{1,32}$/.test(prefix.fileDev) || !/^[0-9]{1,32}$/.test(prefix.fileIno)) throw new ReviewEvidenceError('invalid_shape');
  if (prefix.fileDev !== String(before.dev) || prefix.fileIno !== String(before.ino)) throw new ReviewEvidenceError('inode_replaced');
  if (prefix.offset > bytes.length) throw new ReviewEvidenceError('truncated_source');
  const observed = reviewBytesSha(bytes.subarray(0, prefix.offset));
  if (observed !== prefix.sha256) throw new ReviewEvidenceError('prefix_changed');
  return observed;
}

async function verifyPinned(file: FileHandle, lookup: string, before: BigIntStats,
  directories: Array<{ lookup: string; stat: BigIntStats }>, deadline: number): Promise<void> {
  const after = await file.stat({ bigint: true }); checkDeadline(deadline);
  const entry = await fs.lstat(lookup, { bigint: true }); checkDeadline(deadline);
  if (entry.isSymbolicLink() || entry.dev !== before.dev || entry.ino !== before.ino) throw new ReviewEvidenceError('inode_replaced');
  if (!exactIdentity(before, after)) throw new ReviewEvidenceError(after.size > before.size ? 'source_grew' : 'unstable_read');
  for (const directory of directories) {
    const current = await fs.lstat(directory.lookup, { bigint: true }); checkDeadline(deadline);
    if (current.isSymbolicLink() || current.dev !== directory.stat.dev || current.ino !== directory.stat.ino) {
      throw new ReviewEvidenceError('inode_replaced');
    }
  }
}

async function attempt(location: TrustedReviewLocation, source: ReviewRawSource, prefix: ReviewCommittedPrefix | null): Promise<Omit<StableReviewSnapshot, 'failedAttempts'>> {
  const deadline = performance.now() + 5000;
  const handles: FileHandle[] = [];
  let observation: Observation = { phase: 'preopen', failure: 'open_failed' };
  let primaryFailure: ReviewFileReadError | undefined;
  try {
    const names = components(location, source);
    const directories = await pinDirectories(names, handles, deadline);
    const lookup = `/proc/self/fd/${handles.at(-1)?.fd}/${names.at(-1)}`;
    const file = await fs.open(lookup, FILE_FLAGS); handles.push(file); checkDeadline(deadline);
    const before = await file.stat({ bigint: true });
    if (before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new ReviewEvidenceError('invalid_shape');
    observation = { phase: 'postopen', fileDev: String(before.dev), fileIno: String(before.ino), capturedSize: Number(before.size) };
    checkDeadline(deadline);
    if (!before.isFile()) throw new ReviewEvidenceError('invalid_shape');
    if (before.size > 67_108_864n) throw new ReviewEvidenceError('artifact_too_large');
    const bytes = await readCaptured(file, Number(before.size), deadline);
    const committedPrefixSha256 = checkPrefix(prefix, bytes, before);
    const evidence = parseAgentReviewRawEvidence(source, bytes);
    const fullSha256 = reviewBytesSha(bytes); checkDeadline(deadline);
    await verifyPinned(file, lookup, before, directories, deadline);
    return { evidence, fileDev: String(before.dev), fileIno: String(before.ino), capturedSize: bytes.length, fullSha256, committedPrefixSha256 };
  } catch (error) {
    primaryFailure = new ReviewFileReadError([failure(error, observation)]);
    throw primaryFailure;
  } finally {
    try { await closeAll(handles); }
    catch (error) {
      const closureFailure = Object.freeze({ ...failure(error, observation), closureFailed: true as const });
      throw new ReviewFileReadError(Object.freeze([...(primaryFailure?.failures ?? []), closureFailure]));
    }
    try { checkDeadline(deadline); }
    catch (error) { if (!primaryFailure) throw new ReviewFileReadError([failure(error, observation)]); }
  }
}

/** Bind an internal reader to the server's canonical session/project resolver, never to a request-supplied filesystem path. */
export class AgentReviewFileReader {
  constructor(private readonly resolveTrustedLocation: (source: ReviewRawSource) => Promise<TrustedReviewLocation>) {}

  /**
   * At most two attempts, each with a fresh five-second admission deadline (ten seconds nominal).
   * Awaited I/O and close may exceed it; the resolver runs before it. This is not a hard wall-clock bound.
   * No late snapshot is accepted. Retries retain earlier failures; any close failure stops retries.
   */
  async read(source: ReviewRawSource, prefix: ReviewCommittedPrefix | null = null): Promise<StableReviewSnapshot> {
    const container = reviewRawContainer(source);
    source = Object.freeze({ ...source });
    prefix = prefix ? Object.freeze({ ...prefix }) : null;
    const location = Object.freeze({ ...await this.resolveTrustedLocation(source) });
    if (location.sessionId !== container.sessionId || location.source !== container.source
      || location.sourceContainerId !== container.sourceContainerId) throw new ReviewFileReadError([
        failure(new ReviewEvidenceError('invalid_shape'), { phase: 'preopen', failure: 'open_failed' }),
      ]);
    const failures: ReviewReadFailure[] = [];
    for (let count = 0; count < 2; count++) {
      try {
        const snapshot = Object.freeze({ ...await attempt(location, source, prefix), failedAttempts: Object.freeze([...failures]) });
        acceptedSnapshots.add(snapshot); return snapshot;
      } catch (error) {
        if (!(error instanceof ReviewFileReadError)) throw error;
        failures.push(...error.failures);
        if (!RETRYABLE.has(error.failures.at(-1)?.reason ?? '')) break;
      }
    }
    throw new ReviewFileReadError(Object.freeze(failures));
  }
}

/** Verify a reader-minted, closed-descriptor snapshot; a copied object or caller true flag is never evidence. */
export function assertStableReviewSnapshot(snapshot: StableReviewSnapshot): true {
  if (!acceptedSnapshots.has(snapshot)) throw new ReviewEvidenceError('invalid_shape');
  return true;
}
