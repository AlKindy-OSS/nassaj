import { createHash } from 'node:crypto';

import { assertParserContract, resolveRequestEvidence, resolveObservedRole, resolveContextModel, strictEvidenceObject } from './codex-actor-resolvers.js';
import { assertPinnedActorSource, type ActorSource, type NativeRecord } from './codex-actor-source.js';

type RecordValue = Record<string, unknown>;
/**
 * One native spawn edge. v1 (`multi_agent_v1`): the output carries `agent_id`. v2
 * (`collaboration`, codex 0.160, B-1616): the output carries only the child's
 * `task_name` path; the child thread id comes from the parent's single
 * `item_completed {SubAgentActivity, kind:"started", id:<call_id>}` whose
 * `agent_path` equals that path, and the child's first session_meta must
 * declare the same `agent_path`.
 */
export type NativeLaunch = Readonly<{ callId: string; childThreadId: string; callRecordOrdinal: number; outputRecordOrdinal: number; rawArguments: unknown;
  engine: 'v1' | 'v2'; agentPath: string | null; activityRecordOrdinal: number | null }>;
export type OwnContextCandidate = Readonly<{ turnId: string; sourceRecordOrdinal: number; model: unknown }>;
const object = (v: unknown): v is RecordValue => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v);
const fail = (code: string): never => { throw new Error(code); };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const payload = (row: NativeRecord) => object(row.value.payload) ? row.value.payload : {};

/** First physical record only. A later convenient metadata line can never replace it. */
export function nativeSourceIdentity(source: ActorSource) {
  assertPinnedActorSource(source);
  const row = source.records[0], p = row && payload(row);
  if (!row || row.value.type !== 'session_meta' || !p || !id(p.id) || !id(p.session_id)) return fail('child_binding_invalid');
  if (p.parent_thread_id !== undefined && p.parent_thread_id !== null && !id(p.parent_thread_id)) return fail('child_binding_invalid');
  const parentThreadId = typeof p.parent_thread_id === 'string' ? p.parent_thread_id : null;
  const subagent = p.thread_source === 'subagent' && object(p.source) && Object.hasOwn(p.source, 'subagent');
  if (parentThreadId ? !subagent : p.thread_source !== 'user') return fail('child_binding_invalid');
  return Object.freeze({ threadId: p.id, rootSessionId: p.session_id, parentThreadId, subagent });
}

/** Later metadata must be byte-digest-proven first metadata of an admitted ancestor in the actual chain. */
export function childOwnedBoundary(source: ActorSource, ancestors: readonly ActorSource[]): number {
  const own = nativeSourceIdentity(source);
  let expected = own.parentThreadId;
  const allowed = new Map<string, string>();
  for (const ancestor of [...ancestors].reverse()) {
    const identity = nativeSourceIdentity(ancestor);
    if (identity.threadId !== expected || identity.rootSessionId !== own.rootSessionId) return fail('child_lineage_invalid');
    allowed.set(identity.threadId, ancestor.records[0].lineSha256); expected = identity.parentThreadId;
  }
  if (expected !== null) return fail('child_lineage_invalid');
  const historyStart = historyStartOrdinal(source);
  if (historyStart !== null) return replayedHistoryBoundary(source, own.threadId, allowed, historyStart);
  let boundary = 0;
  for (const row of source.records.slice(1)) {
    if (row.value.type !== 'session_meta') continue;
    const p = payload(row);
    if (!id(p.id) || p.id === own.threadId || allowed.get(p.id) !== row.lineSha256) return fail('child_lineage_invalid');
    boundary = row.ordinal;
  }
  return boundary;
}

/** Positive `subagent_history_start_ordinal` of the first record (0.160 child), else null. */
function historyStartOrdinal(source: ActorSource): number | null {
  const value = payload(source.records[0]).subagent_history_start_ordinal;
  if (value === undefined || value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fail('child_lineage_invalid');
}

/**
 * B-1616: a 0.160 child replays its parent's history (records 1..start-1, the
 * parent's own session_meta included, re-serialized so not byte-equal) before
 * its own. Every replayed session_meta must name an admitted ancestor; none may
 * follow the declared start. The boundary is the last replayed record.
 */
function replayedHistoryBoundary(source: ActorSource, ownThreadId: string, allowed: ReadonlyMap<string, string>, start: number): number {
  if (start > source.records.length) return fail('child_lineage_invalid');
  for (const row of source.records.slice(1)) {
    if (row.value.type !== 'session_meta') continue;
    const p = payload(row);
    if (row.ordinal >= start || !id(p.id) || p.id === ownThreadId || !allowed.has(p.id)) return fail('child_lineage_invalid');
  }
  return start - 1;
}

type PendingCall = { ordinal: number; rawArguments: unknown; engine: 'v1' | 'v2' };

/** The single `started` SubAgentActivity of a v2 call, keyed by its call id. */
function activityStart(row: NativeRecord): { callId: string; childThreadId: unknown; agentPath: unknown } | null {
  const p = payload(row);
  if (row.value.type !== 'event_msg' || p.type !== 'item_completed' || !object(p.item) || p.item.type !== 'SubAgentActivity') return null;
  if (p.item.kind !== 'started') return null;
  return id(p.item.id) ? { callId: p.item.id, childThreadId: p.item.agent_thread_id, agentPath: p.item.agent_path } : fail('child_binding_invalid');
}

function bindLaunch(callId: string, call: PendingCall, outputs: NativeRecord[], starts: NativeRecord[]): NativeLaunch | null {
  // A v2 spawn Codex refused (e.g. "agent thread limit reached") never starts a
  // child: no activity record, so no edge. It confers nothing and is not fatal.
  if (call.engine === 'v2' && !starts.length) return null;
  if (!outputs.length) return fail('child_binding_absent');
  if (outputs.length !== 1 || outputs[0].ordinal <= call.ordinal) return fail('child_binding_invalid');
  let output: unknown;
  try { output = strictEvidenceObject(payload(outputs[0]).output, 64000, [call.engine === 'v1' ? 'agent_id' : 'task_name']); }
  catch { return fail('child_binding_invalid'); }
  if (!object(output)) return fail('child_binding_invalid');
  const base = { callId, callRecordOrdinal: call.ordinal, outputRecordOrdinal: outputs[0].ordinal, rawArguments: call.rawArguments };
  if (call.engine === 'v1') {
    if (!id(output.agent_id) || starts.length) return fail('child_binding_invalid');
    return Object.freeze({ ...base, childThreadId: output.agent_id, engine: 'v1', agentPath: null, activityRecordOrdinal: null });
  }
  const started = activityStart(starts[0]);
  const agentPath = output.task_name;
  if (starts.length !== 1 || starts[0].ordinal <= call.ordinal || !started || !id(started.childThreadId)
    || typeof agentPath !== 'string' || !agentPath || started.agentPath !== agentPath) return fail('child_binding_invalid');
  return Object.freeze({ ...base, childThreadId: started.childThreadId, engine: 'v2', agentPath, activityRecordOrdinal: starts[0].ordinal });
}

/**
 * Native call/output linkage only; task labels, legacy activity records and custom
 * outputs confer no identity. v2 (B-1616) additionally needs its exact
 * call-id-keyed `started` activity record, bound to the output's path.
 */
export function nativeLaunches(source: ActorSource, boundary: number): readonly NativeLaunch[] {
  assertPinnedActorSource(source);
  if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary >= source.records.length) return fail('child_lineage_invalid');
  const calls = new Map<string, PendingCall>();
  const outputs = new Map<string, NativeRecord[]>();
  const starts = new Map<string, NativeRecord[]>();
  const push = (map: Map<string, NativeRecord[]>, key: string, row: NativeRecord) => {
    const previous = map.get(key) ?? []; previous.push(row); map.set(key, previous);
  };
  for (const row of source.records.slice(boundary + 1)) {
    const p = payload(row);
    if (row.value.type === 'sub_agent_activity' || (row.value.type === 'event_msg' && p.type === 'sub_agent_activity')) return fail('child_binding_invalid');
    const started = activityStart(row);
    if (started) push(starts, started.callId, row);
    if (row.value.type !== 'response_item') continue;
    if (p.type === 'function_call' && (p.name === 'spawn_agent' || p.name === 'collaboration.spawn_agent')) {
      const engine = p.namespace === 'multi_agent_v1' ? 'v1' : p.namespace === 'collaboration' ? 'v2' : null;
      if (p.name !== 'spawn_agent' || !engine || !id(p.call_id) || calls.has(p.call_id)) return fail('child_binding_invalid');
      calls.set(p.call_id, { ordinal: row.ordinal, rawArguments: p.arguments, engine });
      if (calls.size > 512) return fail('evidence_cap_exceeded');
    }
    if (p.type === 'function_call_output' && id(p.call_id)) push(outputs, p.call_id, row);
  }
  for (const callId of starts.keys()) if (!calls.has(callId)) return fail('child_binding_invalid');
  return Object.freeze([...calls].flatMap(([callId, call]) => {
    const launch = bindLaunch(callId, call, outputs.get(callId) ?? [], starts.get(callId) ?? []);
    return launch ? [launch] : [];
  }));
}

/** Prove one direct native edge; output remains internal unresolved evidence, never an actor DTO. */
export function bindNativeChild(parent: ActorSource, child: ActorSource, launch: NativeLaunch, boundary: number) {
  const p = nativeSourceIdentity(parent), c = nativeSourceIdentity(child);
  const actual = nativeLaunches(parent, boundary).find(row => row.callId === launch.callId);
  if (!actual || JSON.stringify(actual) !== JSON.stringify(launch) || c.threadId !== launch.childThreadId
    || c.parentThreadId !== p.threadId || c.rootSessionId !== p.rootSessionId || !c.subagent) return fail('child_binding_invalid');
  // v2: the child's own first record must declare the path the parent bound.
  if (launch.engine === 'v2' && payload(child.records[0]).agent_path !== launch.agentPath) return fail('child_binding_invalid');
  const launchLinkSha256 = hash({ schema: 'nassaj-r3-native-link/v1', rootSessionId: p.rootSessionId,
    parentThreadId: p.threadId, callId: launch.callId, childThreadId: c.threadId });
  return Object.freeze({ launchLinkSha256, actorId: `act_${launchLinkSha256}` });
}

/** Ordered syntactic own-turn candidates only. Fixed compiled model resolver is still required before observation. */
export function ownContextCandidates(source: ActorSource, boundary: number) {
  assertPinnedActorSource(source);
  if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary >= source.records.length) return fail('child_lineage_invalid');
  const epochs = new Map<string, { active: boolean; complete: boolean; invalid: boolean; contexts: OwnContextCandidate[] }>();
  let conflict = false;
  for (const row of source.records.slice(boundary + 1)) {
    const p = payload(row), event = row.value.type === 'event_msg' ? p.type : row.value.type;
    if (!['task_started', 'turn_context', 'task_complete', 'turn_aborted'].includes(String(event))) continue;
    if (!id(p.turn_id)) { conflict = true; continue; }
    let epoch = epochs.get(p.turn_id);
    if (event === 'task_started') {
      if (epoch) { epoch.invalid = true; conflict = true; }
      else epochs.set(p.turn_id, { active: true, complete: false, invalid: false, contexts: [] });
      continue;
    }
    if (!epoch) { epoch = { active: false, complete: false, invalid: true, contexts: [] }; epochs.set(p.turn_id, epoch); }
    if (!epoch.active || epoch.complete || event === 'turn_aborted') { epoch.invalid = true; conflict = true; }
    if (event === 'turn_context') {
      epoch.contexts.push(Object.freeze({ turnId: p.turn_id, sourceRecordOrdinal: row.ordinal, model: p.model }));
      if (epoch.contexts.length !== 1) { epoch.invalid = true; conflict = true; }
    } else { epoch.active = false; epoch.complete = event === 'task_complete'; }
  }
  const contexts: OwnContextCandidate[] = [];
  for (const epoch of epochs.values()) {
    if (epoch.invalid || !epoch.complete || epoch.contexts.length !== 1) conflict = true;
    else contexts.push(epoch.contexts[0]);
  }
  contexts.sort((a, b) => a.sourceRecordOrdinal - b.sourceRecordOrdinal);
  if (contexts.length > 256) return fail('evidence_cap_exceeded');
  return Object.freeze({ contexts: Object.freeze(contexts), turnEvidenceConflict: conflict });
}

/** Map exact bound native evidence to internal fields only; BFS/source revision and publication remain separate. */
export async function resolveNativeActorFields(parent: ActorSource, child: ActorSource, launch: NativeLaunch, ancestors: readonly ActorSource[]) {
  assertParserContract();
  for (const source of [...ancestors,parent,child]) await source.verify();
  const parentBoundary = childOwnedBoundary(parent,ancestors);
  bindNativeChild(parent,child,launch,parentBoundary);
  const boundary = childOwnedBoundary(child,[...ancestors,parent]);
  const requested = resolveRequestEvidence(launch.rawArguments);
  const observed = resolveObservedRole(child.records[0].rawLine);
  if (observed.invalid) return fail('child_binding_invalid');
  const own = ownContextCandidates(child,boundary);
  let conflict = own.turnEvidenceConflict;
  const observations = own.contexts.flatMap(context => {
    const model = resolveContextModel(child.records[context.sourceRecordOrdinal].rawLine);
    if (model === null) { conflict = true; return []; }
    return [{ source_record_ordinal: context.sourceRecordOrdinal, turn_id_sha256: hash(context.turnId), model,
      evidence_sha256: hash({ sourcePrefixSha256:child.prefixSha256,recordOrdinal:context.sourceRecordOrdinal,lineSha256:child.records[context.sourceRecordOrdinal].lineSha256 }) }];
  }).map((row,observation_ordinal)=>({...row,observation_ordinal}));
  const roleMismatch = requested.requestedRole !== null && observed.role !== null && requested.requestedRole !== observed.role;
  const modelMismatch = requested.requestedModel !== null && observations.length > 0 && requested.requestedModel !== observations[0].model;
  const invalid = requested.invalidRole || requested.invalidModel || requested.invalidEffort;
  const code = invalid ? 'requested_invalid' : roleMismatch ? 'role_mismatch' : modelMismatch ? 'model_mismatch'
    : observed.role === null ? 'observed_role_missing' : conflict ? 'turn_evidence_conflict' : !observations.length ? 'model_missing' : 'complete';
  for (const source of [...ancestors,parent,child]) await source.verify();
  return Object.freeze({ requested_role:requested.requestedRole,requested_model:requested.requestedModel,
    requested_reasoning_effort:requested.requestedReasoningEffort,observed_role:observed.role,
    role_mismatch:Number(roleMismatch),model_mismatch:Number(modelMismatch),evidence_code:code,
    evidence_status:code === 'complete' ? 'complete' : !invalid && (roleMismatch || modelMismatch) ? 'mismatch' : 'partial',
    observations:Object.freeze(observations.map(Object.freeze)) });
}
