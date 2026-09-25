import { createHash } from 'node:crypto';

import { type ReviewContainer, type ReviewIncidentReason, type ReviewBindingEvidence, type ReviewCompletionEvidence,
  assertReviewSession, assertReviewString, assertReviewToken, hashReviewTuple } from '../../database/index.js';

export type ReviewRawSource = { sessionId: string; source: 'agent' } | { sessionId: string; source: 'workflow'; workflowId: string };
export type RawReviewLine = { ordinal: number; byteStart: number; byteEnd: number; evidenceSha256: string; value: Record<string, unknown> };
export type ParsedReviewEvidence = {
  container: ReviewContainer; bindings: readonly ReviewBindingEvidence[]; completions: readonly ReviewCompletionEvidence[];
  lastCompleteOrdinal: number; lastCompleteOffset: number; rollingPrefixSha256: string; capturedByteLength: number;
};

/** A parser failure carries only bounded reason and optional proved identity, never provider text. */
export class ReviewEvidenceError extends Error {
  constructor(readonly reason: ReviewIncidentReason, readonly agentId: string | null = null) { super(reason); }
}

/** Hash original bytes; this alone does not attest their filesystem provenance. */
export function reviewBytesSha(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Derive the reviewed logical container identity without absolute paths, stat values or local time. */
export function reviewRawContainer(input: ReviewRawSource): ReviewContainer {
  assertReviewSession(input.sessionId);
  const fields = input.source === 'workflow' ? ['sessionId', 'source', 'workflowId'] : ['sessionId', 'source'];
  if (Object.keys(input).length !== fields.length || fields.some(key => !Object.hasOwn(input, key))) throw new ReviewEvidenceError('invalid_shape');
  if (input.source !== 'agent' && input.source !== 'workflow') throw new ReviewEvidenceError('invalid_shape');
  if (input.source === 'workflow' && !/^wf_[A-Za-z0-9_-]{1,125}$/.test(input.workflowId)) throw new ReviewEvidenceError('invalid_shape');
  const relativeArtifact = input.source === 'workflow' ? `subagents/workflows/${input.workflowId}/journal.jsonl` : `${input.sessionId}.jsonl`;
  const identity = { schema: 'nassaj-agent-review-container/v1', provider: 'claude', ...input, relativeArtifact };
  return { sessionId: input.sessionId, source: input.source, sourceContainerId: hashReviewTuple(identity) };
}

function rejectDuplicateKeys(text: string): void {
  const stack: Array<{ keys: Set<string> | null; keyExpected: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      const frame = stack.at(-1);
      if (frame?.keys && frame.keyExpected) {
        const key: unknown = JSON.parse(text.slice(start, i + 1));
        assertReviewString(key);
        if (frame.keys.has(key)) throw new ReviewEvidenceError('invalid_shape');
        frame.keys.add(key);
      }
    } else if (char === '{' || char === '[') stack.push({ keys: char === '{' ? new Set() : null, keyExpected: char === '{' });
    else if (char === '}' || char === ']') stack.pop();
    else if ((char === ',' || char === ':') && stack.length) stack[stack.length - 1].keyExpected = char === ',';
  }
}

/** Decode one original complete line and bind exact byte bounds and ordinal into its evidence digest. */
export function decodeReviewLine(bytes: Buffer, container: ReviewContainer, bounds: { ordinal: number; start: number; end: number }): RawReviewLine {
  if (bounds.end - bounds.start > 2_097_152) throw new ReviewEvidenceError('line_too_large');
  try {
    const raw = bytes.subarray(bounds.start, bounds.end);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    rejectDuplicateKeys(text);
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    const evidenceSha256 = hashReviewTuple({ schema: 'nassaj-agent-review-evidence/v1', sourceContainerId: container.sourceContainerId,
      ordinal: bounds.ordinal, byteStart: bounds.start, byteEnd: bounds.end, rawLineSha256: reviewBytesSha(raw) });
    return { ordinal: bounds.ordinal, byteStart: bounds.start, byteEnd: bounds.end, evidenceSha256, value: value as Record<string, unknown> };
  } catch (error) {
    if (error instanceof ReviewEvidenceError) throw error;
    throw new ReviewEvidenceError('invalid_shape');
  }
}

function canonicalPayload(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { assertReviewString(value); return JSON.stringify(value); }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPayload).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => {
      assertReviewString(key); return `${JSON.stringify(key)}:${canonicalPayload((value as Record<string, unknown>)[key])}`;
    }).join(',')}}`;
  }
  throw new ReviewEvidenceError('invalid_shape');
}

/** Canonical result payload has its own 1 MiB cap; it is never copied into the 64 KiB identity tuple. */
export function reviewPayloadSha(value: unknown): string {
  try {
    const canonical = canonicalPayload(value);
    if (Buffer.byteLength(canonical) > 1_048_576) throw new ReviewEvidenceError('invalid_shape');
    return reviewBytesSha(canonical);
  } catch (error) {
    if (error instanceof ReviewEvidenceError) throw error;
    throw new ReviewEvidenceError('invalid_shape');
  }
}

/** Reject malformed source identifiers using the existing fixed ASCII domains. */
export function reviewEvidenceToken(value: unknown, domain: 'agent' | 'key'): string {
  try { assertReviewToken(value, domain); return value; } catch { throw new ReviewEvidenceError('invalid_shape'); }
}
