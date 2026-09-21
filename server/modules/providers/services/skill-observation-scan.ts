import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { SkillCoverageReason, SkillObservation } from '../../../../shared/skillObservations.js';

import { classifySkillCall, nativeSkillEvents, record, safeNativeId, skillHash } from './skill-observation-parser.js';

export type SkillSource = {
  path: string; identity: string; actorKind: SkillObservation['actorKind']; actorToolCallId: string | null;
  expectedParent?: string; offset: number; tail: Buffer; discarding: boolean; fingerprint: string;
  size: number; mtime: number; complete: boolean; valid: boolean; metaSeen: boolean;
  ambiguous: boolean; calls: Map<string, { id: string; shell: boolean }>; spawns: Map<string, string | null>;
};
export type SkillScanState = {
  provider: 'claude' | 'codex'; sessionId: string; principal: number; owner: number;
  sourceRoot: string; skillRoots: string[]; sources: Map<string, SkillSource>;
  observations: Map<string, SkillObservation>; reasons: Set<SkillCoverageReason>;
  generation: number; updatedAt: number; discoveryComplete: boolean;
  definitions: Map<string, { key: string; name: string }>;
  invocationDefinitions: Map<string, { key: string; name: string } | null>;
  catalogLoaded: boolean;
  registryScope: string;
  skillBoundaries: Map<string, string>;
};
export type ScanBudget = { deadline: number; bytes: number; operations: number; entries: number; signal?: AbortSignal };

/** Cooperative budget checkpoint; native I/O is not claimed to be preemptible. */
export function canScan(budget: ScanBudget): boolean {
  return !budget.signal?.aborted && Date.now() < budget.deadline && budget.bytes < 8 * 1024 * 1024
    && budget.operations < 504 && budget.entries < 256;
}
/** Fresh bounded source cursor; no raw result bodies are retained. */
export function newSkillSource(file: string, identity: string, actorKind: SkillObservation['actorKind'],
  actorToolCallId: string | null = null): SkillSource {
  return { path: file, identity, actorKind, actorToolCallId, offset: 0, tail: Buffer.alloc(0),
    discarding: false, fingerprint: '', size: 0, mtime: 0, complete: false,
    valid: false, metaSeen: false, ambiguous: false, calls: new Map(), spawns: new Map() };
}

/** Path identities preserve full provider/root/package scope, including deleted historical definitions. */
function resolveDefinition(state: SkillScanState, target: string) {
  if (!path.isAbsolute(target) || target.length > 4096 || target !== path.normalize(target)) return null;
  const resolved = state.definitions.get(target);
  if (resolved) return resolved;
  const root = state.skillRoots.find((candidate) => target.startsWith(`${candidate}${path.sep}`));
  if (!root || path.basename(target) !== 'SKILL.md') return null;
  const relative = path.relative(root, target);
  const segments = relative.split(path.sep);
  if (segments.length < 2) return null;
  const name = segments.at(-2)!;
  return { key: skillHash('definition', state.provider, state.owner, root, relative),
    name: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(name) ? name : 'Unresolved skill' };
}

function removeSourceObservations(state: SkillScanState, source: SkillSource): void {
  const identity = skillHash('source', state.provider, state.owner, source.identity);
  for (const [id, item] of state.observations) if (item.sourceSessionId === identity) state.observations.delete(id);
}

function verifyMetadata(state: SkillScanState, source: SkillSource, entry: Record<string, unknown>): boolean {
  if (state.provider === 'claude') {
    if ('forkedFrom' in entry) { state.reasons.add('ambiguous_origin'); return false; }
    if (typeof entry.sessionId === 'string' && entry.sessionId !== state.sessionId) {
      source.ambiguous = true;
      state.reasons.add('ambiguous_origin');
    }
    source.valid = !source.ambiguous;
    return source.valid;
  }
  if (entry.type !== 'session_meta') return source.valid && !source.ambiguous;
  const meta = record(entry.payload);
  if ('forked_from_id' in meta || 'forked_from' in meta) {
    source.ambiguous = true; state.reasons.add('ambiguous_origin'); return false;
  }
  if (source.metaSeen) {
    source.ambiguous = true;
    removeSourceObservations(state, source);
    state.reasons.add('ambiguous_origin');
    return false;
  }
  source.metaSeen = true;
  source.valid = meta.id === source.identity && (source.actorKind === 'root'
    ? meta.thread_source !== 'subagent' && !('subagent' in record(meta.source))
    : meta.parent_thread_id === source.expectedParent && meta.session_id === state.sessionId
      && meta.thread_source === 'subagent');
  if (!source.valid) state.reasons.add('source_unavailable');
  return false;
}

function trackSpawn(source: SkillSource, entry: Record<string, unknown>, provider: 'claude' | 'codex'): void {
  const payload = record(entry.payload);
  if (provider !== 'codex' || entry.type !== 'response_item' || payload.type !== 'function_call_output') return;
  let result: Record<string, unknown>;
  try { result = record(JSON.parse(String(payload.output))); } catch { return; }
  if (safeNativeId(result.agent_id) && safeNativeId(payload.call_id) && source.spawns.has(payload.call_id)) {
    source.spawns.set(payload.call_id, result.agent_id);
  }
}

function processLine(state: SkillScanState, source: SkillSource, line: Buffer): void {
  let entry: Record<string, unknown>;
  try { entry = record(JSON.parse(line.toString('utf8'))); } catch { return; }
  if (!verifyMetadata(state, source, entry)) return;
  if (state.provider === 'codex') {
    const payload = record(entry.payload);
    if (payload.type === 'custom_tool_call' || payload.type === 'custom_tool_call_output'
      || payload.type === 'sub_agent_activity') state.reasons.add('unresolved_attribution');
  }
  trackSpawn(source, entry, state.provider);
  for (const event of nativeSkillEvents(entry, state.provider)) {
    if (event.kind === 'result') {
      const match = source.calls.get(event.callId);
      const observation = match ? state.observations.get(match.id) : null;
      if (observation) observation.outcome = match!.shell ? event.shellOutcome : event.outcome;
      source.calls.delete(event.callId);
      continue;
    }
    if (['Agent', 'Task', 'collaboration.spawn_agent', 'multi_agent_v1.spawn_agent'].includes(event.name)) {
      const spawns = [...state.sources.values()].reduce((sum, value) => sum + value.spawns.size, 0);
      if (spawns < 128) source.spawns.set(event.callId, source.spawns.get(event.callId) ?? null);
      else state.reasons.add('lookup_limit');
    }
    const classified = classifySkillCall(event, state.provider, (target) => resolveDefinition(state, target),
      (name) => state.invocationDefinitions.get(name) ?? null, `${state.owner}:${source.identity}`);
    if (!classified) continue;
    const id = skillHash('event', state.provider, state.owner, source.identity, event.callId,
      classified.identity.key, classified.evidence);
    if (state.observations.has(id)) continue;
    if (state.observations.size >= 1000) { state.reasons.add('memory_limit'); continue; }
    const sourceId = skillHash('source', state.provider, state.owner, source.identity);
    state.observations.set(id, {
      id, provider: state.provider, sourceSessionId: sourceId,
      rootSessionId: skillHash('root', state.provider, state.owner, state.sessionId), turnId: null,
      actorId: skillHash('actor', state.provider, state.owner, source.identity),
      actorKind: source.actorKind, actorToolCallId: source.actorToolCallId,
      skillKey: classified.identity.key, skillName: classified.identity.name,
      evidence: classified.evidence, outcome: 'unknown', occurredAt: event.timestamp,
      source: 'transcript', attribution: source.actorKind === 'unknown' ? 'unknown' : 'exact',
    });
    // Stricter 256/session bound reserves space for catalog and spawn metadata.
    const matches = [...state.sources.values()].reduce((sum, value) => sum + value.calls.size, 0);
    if (source.calls.size < 256 && matches < 256) source.calls.set(event.callId,
      { id, shell: ['Bash', 'exec_command', 'functions.exec_command'].includes(event.name) });
    else state.reasons.add('lookup_limit');
  }
}

function consumeChunk(state: SkillScanState, source: SkillSource, chunk: Buffer): void {
  let start = 0;
  while (start < chunk.length) {
    const newline = chunk.indexOf(10, start);
    const end = newline < 0 ? chunk.length : newline;
    const segment = chunk.subarray(start, end);
    const tails = [...state.sources.values()].reduce((sum, item) => sum + item.tail.length, 0);
    if (!source.discarding && source.tail.length + segment.length <= 256 * 1024
      && tails + segment.length <= 512 * 1024) {
      source.tail = Buffer.concat([source.tail, segment]);
    } else {
      source.discarding = true; source.tail = Buffer.alloc(0); state.reasons.add('line_limit');
    }
    if (newline < 0) break;
    if (!source.discarding && source.tail.length) processLine(state, source, source.tail);
    source.tail = Buffer.alloc(0); source.discarding = false; start = newline + 1;
  }
}

/** Incrementally scan a confined descriptor with bounded lines, bytes, results, and cancellation. */
export async function scanSkillSource(state: SkillScanState, source: SkillSource, budget: ScanBudget): Promise<void> {
  if (!canScan(budget)) return;
  budget.operations += 3;
  const real = await realpath(source.path);
  if (!canScan(budget) || !real.startsWith(`${state.sourceRoot}${path.sep}`)) return;
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!canScan(budget) || !stats.isFile()) return;
    if (state.provider === 'claude' && stats.size === 0) source.valid = true;
    const fingerprint = `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
    if (source.fingerprint && (source.fingerprint !== fingerprint || stats.size < source.offset
      || stats.size === source.size && stats.mtimeMs !== source.mtime)) {
      removeSourceObservations(state, source);
      const replacement = newSkillSource(source.path, source.identity, source.actorKind, source.actorToolCallId);
      replacement.expectedParent = source.expectedParent;
      Object.assign(source, replacement); state.generation++; state.reasons.add('source_changed');
    }
    source.fingerprint = fingerprint; source.size = stats.size; source.mtime = stats.mtimeMs;
    let bytes = 0;
    while (source.offset < stats.size && bytes < 2 * 1024 * 1024 && canScan(budget)) {
      budget.operations++;
      const chunk = Buffer.alloc(Math.min(64 * 1024, stats.size - source.offset,
        2 * 1024 * 1024 - bytes, 8 * 1024 * 1024 - budget.bytes));
      const result = await handle.read(chunk, 0, chunk.length, source.offset);
      if (!canScan(budget) || !result.bytesRead) break;
      consumeChunk(state, source, chunk.subarray(0, result.bytesRead));
      source.offset += result.bytesRead; bytes += result.bytesRead; budget.bytes += result.bytesRead;
    }
    source.complete = source.offset === stats.size && !source.tail.length && !source.discarding;
    if (!source.complete) state.reasons.add('scan_budget');
  } finally { await handle.close(); }
}
