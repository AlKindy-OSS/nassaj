import type { ReviewBindingEvidence, ReviewCompletionEvidence } from '../../database/index.js';

import { type ParsedReviewEvidence, type RawReviewLine, type ReviewRawSource, ReviewEvidenceError,
  decodeReviewLine, reviewBytesSha, reviewEvidenceToken, reviewPayloadSha, reviewRawContainer } from './agent-review-raw-evidence.js';

type FoldState = { bindings: ReviewBindingEvidence[]; completions: ReviewCompletionEvidence[];
  launches: Map<string, RawReviewLine>; bound: Map<string, ReviewBindingEvidence> };

function workflowLine(line: RawReviewLine, state: FoldState): void {
  const row = line.value;
  if (row.type !== 'started' && row.type !== 'result') throw new ReviewEvidenceError('invalid_shape');
  const agentId = reviewEvidenceToken(row.agentId, 'agent');
  if (typeof row.key !== 'string' || !row.key || Buffer.byteLength(row.key) > 65_536) throw new ReviewEvidenceError('invalid_shape', agentId);
  const key = JSON.stringify([agentId, row.key]);
  const launch = state.launches.get(key);
  if (row.type === 'started') {
    if (launch) throw new ReviewEvidenceError('ambiguous_launch', agentId);
    state.launches.set(key, line); return;
  }
  if (!launch) throw new ReviewEvidenceError('reused_launch', agentId);
  if (!Object.hasOwn(row, 'result')) throw new ReviewEvidenceError('invalid_shape', agentId);
  const resultPayloadSha256 = reviewPayloadSha(row.result);
  state.launches.delete(key);
  state.completions.push({ agentId, toolUseId: null, taskId: null, sourceSequence: line.ordinal,
    launchEvidenceSha256: launch.evidenceSha256, completionEvidenceSha256: line.evidenceSha256, resultPayloadSha256 });
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function messageBlocks(row: Record<string, unknown>): Record<string, unknown>[] {
  const message = object(row.message);
  return Array.isArray(message?.content) ? message.content.map(object).filter((block): block is Record<string, unknown> => block !== null) : [];
}

function agentLaunch(line: RawReviewLine, state: FoldState): void {
  const row = line.value;
  if (object(row.message)?.role !== 'assistant') throw new ReviewEvidenceError('invalid_shape');
  const blocks = messageBlocks(row).filter(block => block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task'));
  if (blocks.length !== 1) throw new ReviewEvidenceError('ambiguous_launch');
  for (const block of blocks) {
    const toolUseId = reviewEvidenceToken(block.id, 'key');
    if (state.launches.has(toolUseId)) throw new ReviewEvidenceError('ambiguous_launch');
    state.launches.set(toolUseId, line);
  }
}

function agentBinding(line: RawReviewLine, state: FoldState): void {
  const row = line.value;
  const result = object(row.toolUseResult);
  if (!result || !Object.hasOwn(result, 'agentId')) return;
  const agentId = reviewEvidenceToken(result.agentId, 'agent');
  const matches = messageBlocks(row).filter(block => block.type === 'tool_result'
    && typeof block.tool_use_id === 'string' && state.launches.has(block.tool_use_id));
  if (matches.length !== 1) throw new ReviewEvidenceError('conflicting_binding', agentId);
  const toolUseId = reviewEvidenceToken(matches[0].tool_use_id, 'key');
  const launch = state.launches.get(toolUseId) as RawReviewLine;
  if (state.bound.has(toolUseId) || launch.ordinal >= line.ordinal) throw new ReviewEvidenceError('conflicting_binding', agentId);
  const binding = { toolUseId, agentId, launchSequence: launch.ordinal, bindingSequence: line.ordinal,
    launchEvidenceSha256: launch.evidenceSha256, bindingEvidenceSha256: line.evidenceSha256 };
  state.bound.set(toolUseId, binding); state.bindings.push(binding);
}

function oneTag(control: string, name: string): string {
  const values = [...control.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))];
  if (values.length !== 1) throw new ReviewEvidenceError('invalid_shape');
  return values[0][1];
}

function completionNotification(content: unknown): { taskId: string; toolUseId: string; result: string } | null {
  if (typeof content !== 'string' || !content.includes('<task-notification>')) return null;
  const resultStart = content.indexOf('<result>'); const resultEnd = content.lastIndexOf('</result>');
  const control = resultStart >= 0 && resultEnd > resultStart ? content.slice(0, resultStart) + content.slice(resultEnd + 9) : content;
  if (oneTag(control, 'status') !== 'completed') return null;
  if (!content.trim().startsWith('<task-notification>') || !content.trim().endsWith('</task-notification>')
    || resultStart < 0 || resultEnd <= resultStart) throw new ReviewEvidenceError('invalid_shape');
  const result = content.slice(resultStart + 8, resultEnd);
  if (!result.trim()) throw new ReviewEvidenceError('invalid_shape');
  return { taskId: reviewEvidenceToken(oneTag(control, 'task-id'), 'agent'),
    toolUseId: reviewEvidenceToken(oneTag(control, 'tool-use-id'), 'key'), result };
}

function agentCompletion(line: RawReviewLine, state: FoldState): void {
  const parsed = completionNotification(line.value.content);
  if (!parsed) return;
  const binding = state.bound.get(parsed.toolUseId);
  if (!binding || binding.agentId !== parsed.taskId || binding.bindingSequence >= line.ordinal) {
    throw new ReviewEvidenceError('conflicting_binding', binding?.agentId ?? null);
  }
  state.completions.push({ agentId: binding.agentId, taskId: parsed.taskId, toolUseId: parsed.toolUseId,
    sourceSequence: line.ordinal, launchEvidenceSha256: binding.launchEvidenceSha256,
    completionEvidenceSha256: line.evidenceSha256, resultPayloadSha256: reviewPayloadSha(parsed.result) });
}

function agentLine(line: RawReviewLine, source: ReviewRawSource, state: FoldState): void {
  const row = line.value;
  const relevant = (row.type === 'assistant' && messageBlocks(row).some(block => block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task')))
    || (row.type === 'user' && object(row.toolUseResult)?.agentId !== undefined)
    || (row.type === 'queue-operation' && row.operation === 'enqueue' && typeof row.content === 'string' && row.content.includes('<task-notification>'));
  if (!relevant) return;
  if (row.sessionId !== source.sessionId) throw new ReviewEvidenceError('invalid_shape');
  if (row.type === 'assistant') agentLaunch(line, state);
  else if (row.type === 'user') agentBinding(line, state);
  else agentCompletion(line, state);
}

/** Parse original JSONL bytes only. The caller must separately prove same-FD stability before trusting this output. */
export function parseAgentReviewRawEvidence(source: ReviewRawSource, input: Uint8Array): ParsedReviewEvidence {
  if (!(input instanceof Uint8Array)) throw new ReviewEvidenceError('invalid_shape');
  if (input.byteLength > 67_108_864) throw new ReviewEvidenceError('artifact_too_large');
  const bytes = Buffer.from(input);
  const container = reviewRawContainer(source);
  const state: FoldState = { bindings: [], completions: [], launches: new Map(), bound: new Map() };
  let offset = 0; let ordinal = 0;
  const deadline = performance.now() + 5000;
  for (let end = bytes.indexOf(10, offset); end !== -1; end = bytes.indexOf(10, offset)) {
    if (performance.now() >= deadline) throw new ReviewEvidenceError('read_timeout');
    ordinal++;
    if (ordinal > 200_000) throw new ReviewEvidenceError('line_cap');
    const line = decodeReviewLine(bytes, container, { ordinal, start: offset, end });
    if (source.source === 'workflow') workflowLine(line, state); else agentLine(line, source, state);
    if (state.completions.length > 4096) throw new ReviewEvidenceError('completion_cap');
    offset = end + 1;
  }
  if (bytes.length - offset > 2_097_152) throw new ReviewEvidenceError('line_too_large');
  if (performance.now() >= deadline) throw new ReviewEvidenceError('read_timeout');
  return Object.freeze({ container: Object.freeze(container), bindings: Object.freeze(state.bindings.map(value => Object.freeze(value))),
    completions: Object.freeze(state.completions.map(value => Object.freeze(value))), lastCompleteOrdinal: ordinal,
    lastCompleteOffset: offset, rollingPrefixSha256: reviewBytesSha(bytes.subarray(0, offset)), capturedByteLength: bytes.length });
}
