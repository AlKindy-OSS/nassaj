import { createHash } from 'node:crypto';

import { assertParserContract, resolveRequestEvidence, resolveObservedRole, resolveContextModel, strictEvidenceObject } from './codex-actor-resolvers.js';
import { assertPinnedActorSource, type ActorSource, type NativeRecord } from './codex-actor-source.js';

type RecordValue = Record<string, unknown>;
export type NativeLaunch = Readonly<{ callId: string; childThreadId: string; callRecordOrdinal: number; outputRecordOrdinal: number; rawArguments: unknown }>;
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
  let boundary = 0;
  for (const row of source.records.slice(1)) {
    if (row.value.type !== 'session_meta') continue;
    const p = payload(row);
    if (!id(p.id) || p.id === own.threadId || allowed.get(p.id) !== row.lineSha256) return fail('child_lineage_invalid');
    boundary = row.ordinal;
  }
  return boundary;
}

/** Native call/output linkage only; task labels, activity records and custom outputs confer no identity. */
export function nativeLaunches(source: ActorSource, boundary: number): readonly NativeLaunch[] {
  assertPinnedActorSource(source);
  if (!Number.isSafeInteger(boundary) || boundary < 0 || boundary >= source.records.length) return fail('child_lineage_invalid');
  const calls = new Map<string, { ordinal: number; rawArguments: unknown }>();
  const outputs = new Map<string, NativeRecord[]>();
  for (const row of source.records.slice(boundary + 1)) {
    const p = payload(row);
    if (row.value.type === 'sub_agent_activity' || (row.value.type === 'event_msg' && p.type === 'sub_agent_activity')) return fail('child_binding_invalid');
    if (row.value.type !== 'response_item') continue;
    if (p.type === 'function_call' && (p.name === 'spawn_agent' || p.name === 'collaboration.spawn_agent')) {
      if (p.name !== 'spawn_agent' || p.namespace !== 'multi_agent_v1' || !id(p.call_id) || calls.has(p.call_id)) return fail('child_binding_invalid');
      calls.set(p.call_id, { ordinal: row.ordinal, rawArguments: p.arguments });
      if (calls.size > 512) return fail('evidence_cap_exceeded');
    }
    if (p.type === 'function_call_output' && id(p.call_id)) {
      const previous = outputs.get(p.call_id) ?? []; previous.push(row); outputs.set(p.call_id, previous);
    }
  }
  return Object.freeze([...calls].map(([callId, call]) => {
    const matches = outputs.get(callId) ?? [];
    if (!matches.length) return fail('child_binding_absent');
    if (matches.length !== 1 || matches[0].ordinal <= call.ordinal) return fail('child_binding_invalid');
    const raw = payload(matches[0]).output;
    let output: unknown;
    try { output = strictEvidenceObject(raw,64000,['agent_id']); }
    catch { return fail('child_binding_invalid'); }
    if (!object(output) || !id(output.agent_id)) return fail('child_binding_invalid');
    return Object.freeze({ callId, childThreadId: output.agent_id, callRecordOrdinal: call.ordinal,
      outputRecordOrdinal: matches[0].ordinal, rawArguments: call.rawArguments });
  }));
}

/** Prove one direct native edge; output remains internal unresolved evidence, never an actor DTO. */
export function bindNativeChild(parent: ActorSource, child: ActorSource, launch: NativeLaunch, boundary: number) {
  const p = nativeSourceIdentity(parent), c = nativeSourceIdentity(child);
  const actual = nativeLaunches(parent, boundary).find(row => row.callId === launch.callId);
  if (!actual || JSON.stringify(actual) !== JSON.stringify(launch) || c.threadId !== launch.childThreadId
    || c.parentThreadId !== p.threadId || c.rootSessionId !== p.rootSessionId || !c.subagent) return fail('child_binding_invalid');
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
