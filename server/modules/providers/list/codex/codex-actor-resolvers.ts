import { assertEvidenceManifest, evidenceContractHash, R3_RESOLVER_MANIFEST, R3_RESOLVER_MANIFEST_SHA256,
  validEvidenceModel, validEvidenceRole } from '../../../../shared/r3-evidence-lexical.js';

export const R3_PARSER_CONTRACT = Object.freeze({
  schema: 'nassaj-r3-parser-contract/v3', nativeRecordShapeRevision: 'nassaj-r3-native-record-shape/v1',
  resolverManifest: R3_RESOLVER_MANIFEST, resolverManifestCanonicalSha256: R3_RESOLVER_MANIFEST_SHA256,
  modelForbiddenScalars: R3_RESOLVER_MANIFEST.modelForbiddenScalars, nativePayloadCaps: R3_RESOLVER_MANIFEST.nativePayloadCaps,
  limits: Object.freeze({ roleUtf8Bytes: 128, modelUtf8Bytes: 128, effortUtf8Bytes: 32, sessionUtf8Bytes: 256,
    actors: 256, observationsPerActor: 256, launchEdges: 512, sources: 256, depth: 8, readSemaphore: 4, sourcePrefixBytes: 67108864 }),
  actorEvidencePriority: Object.freeze(['requested_invalid','role_mismatch','model_mismatch','observed_role_missing','turn_evidence_conflict','model_missing','complete']),
  collectionEvidencePriority: Object.freeze(['authorization_revoked','source_drift','evidence_cap_exceeded','child_lineage_invalid','child_binding_invalid','child_binding_absent']),
  traversalVersion: 'breadth-first-call-output-child-bytewise/v1', canonicalizationRevision: 'utf8-json-recursive-bytewise-keys/v1',
});
export const R3_PARSER_CONTRACT_SHA256 = evidenceContractHash(R3_PARSER_CONTRACT);
type JsonObject = Record<string, unknown>;
const object = (v: unknown): v is JsonObject => Boolean(v && typeof v === 'object' && !Array.isArray(v));

/** Scan JSON grammar before materializing objects, retaining duplicates even for escaped key spellings. */
export function strictEvidenceObject(raw: unknown, cap: number, guardedPaths: readonly string[]): JsonObject {
  if (typeof raw !== 'string' || Buffer.byteLength(raw,'utf8') > cap) throw new Error('actor_json_invalid');
  for (const scalar of raw) { const point = scalar.codePointAt(0)!; if (point >= 0xD800 && point <= 0xDFFF) throw new Error('actor_json_invalid'); }
  let at = 0;
  const duplicates = new Set<string>();
  const skip = () => { while (/[\x20\t\r\n]/.test(raw[at] ?? '') && at < raw.length) at++; };
  const string = () => {
    const start = at++;
    while (at < raw.length) { const c = raw[at++]; if (c === '\\') at++; else if (c === '"') return JSON.parse(raw.slice(start,at)) as string; }
    throw new Error('actor_json_invalid');
  };
  const parse = (parent: string, depth: number): void => {
    if (depth > 64) throw new Error('actor_json_invalid');
    skip(); const c = raw[at];
    if (c === '"') { string(); return; }
    if (c !== '{' && c !== '[') {
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(at));
      if (!match) throw new Error('actor_json_invalid'); at += match[0].length; return;
    }
    at++; skip(); const end = c === '{' ? '}' : ']'; const keys = new Set<string>();
    if (raw[at] === end) { at++; return; }
    while (at < raw.length) {
      skip(); let child = parent+'[]';
      if (c === '{') {
        if (raw[at] !== '"') throw new Error('actor_json_invalid');
        const key = string(); child = parent ? parent+'.'+key : key;
        if (keys.has(key) && guardedPaths.includes(child)) duplicates.add(child); keys.add(key);
        skip(); if (raw[at++] !== ':') throw new Error('actor_json_invalid');
      }
      parse(child,depth+1); skip(); const next = raw[at++];
      if (next === end) return; if (next !== ',') throw new Error('actor_json_invalid');
    }
    throw new Error('actor_json_invalid');
  };
  parse('',0); skip();
  if (at !== raw.length || duplicates.size) throw new Error('actor_json_invalid');
  const value: unknown = JSON.parse(raw);
  if (!object(value)) throw new Error('actor_json_invalid');
  return value;
}

export type RequestEvidence = Readonly<{ requestedRole: string | null; requestedModel: string | null;
  requestedReasoningEffort: string | null; invalidRole: boolean; invalidModel: boolean; invalidEffort: boolean }>;
function effort(value: unknown): string | null | false {
  if (typeof value !== 'string' || !/^[A-Za-z]+$/.test(value)) return false;
  const lower = value.replace(/[A-Z]/g,c => String.fromCharCode(c.charCodeAt(0)+32));
  if (lower === 'none') return null;
  if (lower === 'max' || lower === 'ultracode') return 'xhigh';
  return ['minimal','low','medium','high','xhigh'].includes(lower) ? lower : false;
}
/** Requested values come solely from exact native raw argument members. */
export function resolveRequestEvidence(raw: unknown): RequestEvidence {
  assertEvidenceManifest();
  let args: JsonObject;
  try { args = strictEvidenceObject(raw,64000,['agent_type','model','reasoning_effort']); }
  catch { return Object.freeze({requestedRole:null,requestedModel:null,requestedReasoningEffort:null,invalidRole:true,invalidModel:true,invalidEffort:true}); }
  const rolePresent = Object.hasOwn(args,'agent_type'), modelPresent = Object.hasOwn(args,'model'), effortPresent = Object.hasOwn(args,'reasoning_effort');
  const role = validEvidenceRole(args.agent_type) ? args.agent_type : null;
  const model = validEvidenceModel(args.model) ? args.model : null;
  const reasoning = effortPresent ? effort(args.reasoning_effort) : null;
  return Object.freeze({requestedRole:role,requestedModel:model,requestedReasoningEffort:reasoning === false ? null : reasoning,
    invalidRole:rolePresent && role === null,invalidModel:modelPresent && model === null,invalidEffort:effortPresent && reasoning === false});
}
/** Both first-child metadata role sources must agree; missing/invalid never falls back to request. */
export function resolveObservedRole(rawFirstMeta: string): { role: string | null; invalid: boolean } {
  assertEvidenceManifest();
  let row: JsonObject;
  try { row = strictEvidenceObject(rawFirstMeta,67108864,['payload','payload.agent_role','payload.source','payload.source.subagent','payload.source.subagent.thread_spawn','payload.source.subagent.thread_spawn.agent_role']); }
  catch { return {role:null,invalid:true}; }
  if (row.type !== 'session_meta' || !object(row.payload)) return {role:null,invalid:true};
  const p = row.payload, source = object(p.source) ? p.source : {}, sub = object(source.subagent) ? source.subagent : {}, nested = object(sub.thread_spawn) ? sub.thread_spawn : {};
  const values = [p,nested].filter(obj => Object.hasOwn(obj,'agent_role')).map(obj => obj.agent_role);
  if (values.some(v=>!validEvidenceRole(v)) || (values.length === 2 && values[0] !== values[1])) return {role:null,invalid:true};
  return {role: values.length ? values[0] as string : null,invalid:false};
}
/** Model is taken from a proven completed-own context only; caller proves the epoch and child binding. */
export function resolveContextModel(raw: string): string | null {
  assertEvidenceManifest();
  try { const row = strictEvidenceObject(raw,67108864,['payload','payload.model']);
    return row.type === 'turn_context' && object(row.payload) && validEvidenceModel(row.payload.model) ? row.payload.model : null;
  } catch { return null; }
}

/** Reject a compiled parser constant that drifted from its reviewed canonical payload. */
export function assertParserContract(): void {
  assertEvidenceManifest();
  if (R3_PARSER_CONTRACT_SHA256 !== '5b4114b10a8d9e070a97be193edec12857af13d7c23976011be7e01ede220516'
    || evidenceContractHash(R3_PARSER_CONTRACT) !== R3_PARSER_CONTRACT_SHA256) throw new Error('actor_contract_invalid');
}
