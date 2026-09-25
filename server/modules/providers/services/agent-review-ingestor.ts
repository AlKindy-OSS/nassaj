import path from 'node:path';

import type { Database } from 'better-sqlite3';

import { AgentReviewError, AgentReviewIngestionContextRepository, AgentReviewIngestionRepository, AgentReviewResultRepository,
  type ReviewHead, type ReviewIncident, type ReviewResultFold, hashReviewTuple, readIncidentObservationChain } from '../../database/index.js';

import { AgentReviewFileReader, ReviewFileReadError, type ReviewReadFailure, type StableReviewSnapshot,
  assertStableReviewSnapshot } from './agent-review-file-reader.js';
import { type ReviewRawSource, reviewBytesSha, reviewRawContainer } from './agent-review-raw-evidence.js';

const RETRYABLE = new Set(['unstable_read', 'source_grew', 'read_timeout']);
const STRUCTURAL = new Set(['conflicting_binding', 'invalid_sequence', 'reused_launch', 'prefix_changed']);
const EMPTY = reviewBytesSha('');
type FoldResult = { bindings: number; completions: number; headAdvanced: boolean };

function nextHead(snapshot: StableReviewSnapshot, expected: ReviewHead | null): ReviewHead {
  const evidence = snapshot.evidence;
  if (expected && evidence.lastCompleteOffset === expected.lastCompleteOffset) return expected;
  return Object.freeze({ ...evidence.container, fileDev: snapshot.fileDev, fileIno: snapshot.fileIno,
    lastCompleteOrdinal: evidence.lastCompleteOrdinal, lastCompleteOffset: evidence.lastCompleteOffset,
    stableSize: snapshot.capturedSize, rollingPrefixSha256: evidence.rollingPrefixSha256,
    lastResultSequence: evidence.completions.at(-1)?.sourceSequence ?? expected?.lastResultSequence ?? 0,
    revision: expected ? expected.revision + 1 : 0 });
}

function relationHash(snapshot: StableReviewSnapshot): string {
  // Hash bounded individual tuples rather than embedding a whole file's relations in a 64 KiB identity tuple.
  return hashReviewTuple({ schema: 'nassaj-agent-review-proved-relations/v1', fullSha256: snapshot.fullSha256,
    bindingsSha256: reviewBytesSha(snapshot.evidence.bindings.map(value => hashReviewTuple(value)).join('')),
    completionsSha256: reviewBytesSha(snapshot.evidence.completions.map(value => hashReviewTuple(value)).join('')) });
}

/** Internal, explicit-DB ingestion only. It neither activates watchers nor opens/migrates a database. */
export class AgentReviewIngestor {
  readonly #context: AgentReviewIngestionContextRepository;
  readonly #ingestion: AgentReviewIngestionRepository;
  readonly #results: AgentReviewResultRepository;
  readonly #roots: readonly string[];
  #authorized: { fold: ReviewResultFold; snapshot: StableReviewSnapshot; sessionPath: string } | null = null;

  constructor(private readonly db: Database, configuredProjectsRoots: readonly string[]) {
    this.#roots = Object.freeze(configuredProjectsRoots.map(root => {
      if (!path.isAbsolute(root) || path.resolve(root) !== root) throw new AgentReviewError('invalid_input');
      return root;
    }));
    this.#context = new AgentReviewIngestionContextRepository(db);
    this.#ingestion = new AgentReviewIngestionRepository(db);
    this.#results = new AgentReviewResultRepository(db, fold => this.assertProvenance(fold));
  }

  private sessionPath(source: ReviewRawSource): string {
    const file = this.#context.readSessionPath(source.sessionId);
    if (!file || path.resolve(file) !== file || path.basename(file) !== `${source.sessionId}.jsonl`
      || !this.#roots.some(root => path.dirname(path.dirname(file)) === root)) throw new AgentReviewError('untrusted_provenance');
    return file;
  }

  private assertProvenance(fold: ReviewResultFold): true {
    const trusted = this.#authorized;
    if (!this.db.inTransaction || !trusted || trusted.fold !== fold
      || this.#context.readSessionPath(fold.nextHead.sessionId) !== trusted.sessionPath) throw new AgentReviewError('untrusted_provenance');
    return assertStableReviewSnapshot(trusted.snapshot);
  }

  private recordFailures(source: ReviewRawSource, head: ReviewHead | null, failures: readonly ReviewReadFailure[], sessionPath: string): ReviewIncident {
    if (this.#context.readSessionPath(source.sessionId) !== sessionPath) throw new AgentReviewError('untrusted_provenance');
    const primary = failures.find(value => !RETRYABLE.has(value.reason)) ?? failures[0];
    if (!primary) throw new AgentReviewError('invalid_input');
    return this.#ingestion.recordBoundIncident({ ...reviewRawContainer(source), scope: primary.agentId ? 'identity' : 'container',
      scopeAgentId: primary.agentId ?? '', reason: primary.reason, lastCommittedOffset: head?.lastCompleteOffset ?? 0,
      lastCommittedPrefixSha256: head?.rollingPrefixSha256 ?? EMPTY, observation: primary.observation,
      attemptEvidenceSha256: hashReviewTuple({ schema: 'nassaj-agent-review-read-failures/v1', failures }) }, sessionPath);
  }

  private commit(snapshot: StableReviewSnapshot, head: ReviewHead | null, sessionPath: string, incident: ReviewIncident | null): FoldResult {
    const fold: ReviewResultFold = Object.freeze({ expectedHead: head, nextHead: nextHead(snapshot, head),
      committedPrefixSha256: snapshot.committedPrefixSha256,
      bindings: snapshot.evidence.bindings, completions: snapshot.evidence.completions });
    return this.db.transaction(() => {
      this.#authorized = { fold, snapshot, sessionPath };
      try {
        this.assertProvenance(fold); // Same transaction and before recovery's first effect, not merely before the result writes.
        if (incident) this.#ingestion.recoverIncident({
          observationCount: 0, observationChainSha256: readIncidentObservationChain(this.db, incident.incidentId).observationChainSha256,
          incidentId: incident.incidentId, incidentGeneration: incident.incidentGeneration,
          incidentEvidenceSha256: incident.evidenceSha256, expectedRevision: incident.revision,
          stableFileDev: snapshot.fileDev, stableFileIno: snapshot.fileIno, stableSize: snapshot.capturedSize,
          stablePrefixSha256: snapshot.fullSha256, committedPrefixSha256: snapshot.committedPrefixSha256,
          uniqueRelationEvidenceSha256: relationHash(snapshot) });
        return this.#results.applyFold(fold);
      } finally { this.#authorized = null; }
    }).immediate();
  }

  /** Accept only exact artifact topologies below configured server roots, never a client-selected container. */
  async ingestFile(filePath: string): Promise<string | null> {
    if (!path.isAbsolute(filePath) || path.resolve(filePath) !== filePath) return null;
    const root = this.#roots.find(value => filePath.startsWith(`${value}${path.sep}`));
    if (!root) return null;
    const parts = path.relative(root, filePath).split(path.sep);
    let source: ReviewRawSource;
    if (parts.length === 2 && parts[1].endsWith('.jsonl')) {
      source = { sessionId: parts[1].slice(0, -6), source: 'agent' };
    } else if (parts.length === 6 && parts[2] === 'subagents' && parts[3] === 'workflows'
      && /^wf_[A-Za-z0-9_-]{1,125}$/.test(parts[4]) && parts[5] === 'journal.jsonl') {
      source = { sessionId: parts[1], source: 'workflow', workflowId: parts[4] };
    } else return null;
    const transcript = path.join(root, parts[0], `${source.sessionId}.jsonl`);
    if (this.#context.readSessionPath(source.sessionId) !== transcript) throw new AgentReviewError('untrusted_provenance');
    await this.ingest(source);
    return source.sessionId;
  }

  /**
   * Ingest a server-derived session/container through a closed, stable FD snapshot and atomic storage.
   * Existing quarantine is deliberately fail-closed; this batch recovers only an incident created by this read's retry.
   * A stable snapshot without a proved completion cannot recover even that incident. No GET calls this method.
   */
  async ingest(source: ReviewRawSource): Promise<FoldResult> {
    source = Object.freeze({ ...source });
    const container = reviewRawContainer(source);
    if (this.db.inTransaction) throw new AgentReviewError('nested_transaction');
    if (this.#context.firstActive(container)) throw new AgentReviewError('unavailable');
    const sessionPath = this.sessionPath(source);
    const head = this.#ingestion.readHead(container);
    const reader = new AgentReviewFileReader(async () => ({ ...container, projectDirectory: path.dirname(sessionPath) }));
    let snapshot: StableReviewSnapshot;
    try { snapshot = await reader.read(source, head ? { offset: head.lastCompleteOffset, sha256: head.rollingPrefixSha256,
      fileDev: head.fileDev, fileIno: head.fileIno } : null); }
    catch (error) {
      if (error instanceof ReviewFileReadError) this.recordFailures(source, head, error.failures, sessionPath);
      throw error;
    }
    if (head && snapshot.capturedSize < head.stableSize) {
      const failures: ReviewReadFailure[] = [...snapshot.failedAttempts, { reason: 'truncated_source', agentId: null,
        observation: { phase: 'postopen', fileDev: snapshot.fileDev, fileIno: snapshot.fileIno, capturedSize: snapshot.capturedSize } }];
      this.recordFailures(source, head, failures, sessionPath);
      throw new ReviewFileReadError(failures);
    }
    const incident = snapshot.failedAttempts.length ? this.recordFailures(source, head, snapshot.failedAttempts, sessionPath) : null;
    if (incident && !snapshot.evidence.completions.length) throw new AgentReviewError('unavailable');
    try { return this.commit(snapshot, head, sessionPath, incident); }
    catch (error) {
      if (error instanceof AgentReviewError && STRUCTURAL.has(error.code)) this.recordFailures(source, head, [{
        reason: error.code as 'conflicting_binding' | 'invalid_sequence' | 'reused_launch' | 'prefix_changed',
        agentId: error.code === 'prefix_changed' ? null : error.agentId,
        observation: { phase: 'postopen', fileDev: snapshot.fileDev, fileIno: snapshot.fileIno, capturedSize: snapshot.capturedSize },
      }], sessionPath);
      throw error;
    }
  }
}
