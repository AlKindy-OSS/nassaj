import { createHash } from 'node:crypto';

// Exact QA-accepted lexical manifest. No support, entitlement or launch authority.
export const R3_RESOLVER_MANIFEST = {
  "schema": "nassaj-r3-resolver-manifest/v2",
  "semantics": "native-evidence-identifiers-not-support-catalog",
  "roleResolver": {
    "id": "native-role-evidence/v2",
    "choiceTable": null,
    "requestedSource": "exact spawn_agent/multi_agent_v1 arguments member agent_type",
    "observedSources": [
      "child first session_meta.payload.agent_role",
      "child first session_meta.payload.source.subagent.thread_spawn.agent_role"
    ],
    "absence": "canonical member absent -> null",
    "presentValidation": "JSON string; ASCII bytes; ^[A-Za-z][A-Za-z0-9_-]{0,127}$; exact bytes; no trim/case-fold/normalization",
    "presentNullOrOtherType": "requested_invalid for request; invalid loaded-role evidence for observation",
    "duplicateCanonicalMember": "invalid",
    "conflict": "when both observed sources are present they must be individually valid and byte-identical",
    "meaning": "opaque role identifier requested or emitted by the bound native record; never proof that the release, host or account supports it"
  },
  "modelResolver": {
    "id": "native-model-evidence/v2",
    "choiceTable": null,
    "requestedSource": "exact spawn_agent/multi_agent_v1 arguments member model",
    "observedSource": "exact model member of the single valid own turn_context inside a completed child-owned epoch",
    "absence": "canonical request member absent -> null; an own completed epoch without valid model produces no model observation",
    "presentValidation": "JSON string containing only Unicode scalar values; UTF-8 byte length 1..128; reject every scalar in modelForbiddenScalars; exact scalar/byte sequence; no trim/case-fold/normalization",
    "presentNullOrOtherType": "requested_invalid for request; invalid turn evidence for observation",
    "duplicateCanonicalMember": "invalid",
    "meaning": "opaque model identifier requested or emitted by the bound native record; never proof of availability, entitlement, pricing, launch acceptance or current catalog membership"
  },
  "reasoningResolver": {
    "id": "native-request-effort/v1",
    "choiceTable": [
      "high",
      "low",
      "medium",
      "minimal",
      "xhigh"
    ],
    "requestedSource": "exact spawn_agent/multi_agent_v1 arguments member reasoning_effort",
    "absence": "canonical member absent -> null",
    "normalization": "ASCII lowercase only",
    "aliases": {
      "max": "xhigh",
      "none": null,
      "ultracode": "xhigh"
    },
    "presentValidation": "after ASCII lowercase, exact member or exact alias; every other value/type is requested_invalid",
    "duplicateCanonicalMember": "invalid",
    "meaning": "normalized requested effort evidence only; never proof of model support"
  },
  "requestObject": {
    "maxUtf8Bytes": 64000,
    "parse": "strict JSON object after the exact nativePayloadCaps.spawnArgumentsUtf8Bytes gate; reject invalid UTF-8/JSON and duplicate agent_type, model or reasoning_effort members before ordinary object materialization",
    "aliases": "agentType, role, requestedRole, model_id, requestedModel, reasoningEffort and other names never substitute for canonical members",
    "unknownMembers": "ignored for resolver output but remain covered by the pinned raw source prefix and launch evidence"
  },
  "canonicalization": {
    "algorithm": "UTF-8 JSON; object keys recursively sorted by unsigned UTF-8 byte order; arrays preserve declared order; no whitespace; JSON string escaping; integers base-10 safe integers only; null is literal null; undefined/nonfinite values forbidden",
    "manifestHash": "lowercase SHA-256 over these canonical manifest bytes excluding no field"
  },
  "modelForbiddenScalars": {
    "policyId": "nassaj-r3-model-forbidden-scalars/ucd-15.1.0-v1",
    "source": "Unicode Character Database 15.1.0 DerivedGeneralCategory.txt General_Category=Cf copied into this manifest, plus the Unicode noncharacter definition and explicit local Cc/Zl/Zp rules; runtime Unicode category/property APIs are forbidden",
    "format": "Each inclusive U+XXXX or U+XXXX-U+YYYY range is parsed as uppercase hexadecimal scalar bounds with at least four digits; ranges in each array are strictly ascending by numeric scalar, nonoverlapping and immutable",
    "Cc": [
      "U+0000-U+001F",
      "U+007F-U+009F"
    ],
    "Cf": [
      "U+00AD",
      "U+0600-U+0605",
      "U+061C",
      "U+06DD",
      "U+070F",
      "U+0890-U+0891",
      "U+08E2",
      "U+180E",
      "U+200B-U+200F",
      "U+202A-U+202E",
      "U+2060-U+2064",
      "U+2066-U+206F",
      "U+FEFF",
      "U+FFF9-U+FFFB",
      "U+110BD",
      "U+110CD",
      "U+13430-U+1343F",
      "U+1BCA0-U+1BCA3",
      "U+1D173-U+1D17A",
      "U+E0001",
      "U+E0020-U+E007F"
    ],
    "bidiControls": [
      "U+061C",
      "U+200E-U+200F",
      "U+202A-U+202E",
      "U+2066-U+2069"
    ],
    "lineAndParagraphSeparators": [
      "U+2028",
      "U+2029"
    ],
    "noncharacters": [
      "U+FDD0-U+FDEF",
      "U+FFFE-U+FFFF",
      "U+1FFFE-U+1FFFF",
      "U+2FFFE-U+2FFFF",
      "U+3FFFE-U+3FFFF",
      "U+4FFFE-U+4FFFF",
      "U+5FFFE-U+5FFFF",
      "U+6FFFE-U+6FFFF",
      "U+7FFFE-U+7FFFF",
      "U+8FFFE-U+8FFFF",
      "U+9FFFE-U+9FFFF",
      "U+AFFFE-U+AFFFF",
      "U+BFFFE-U+BFFFF",
      "U+CFFFE-U+CFFFF",
      "U+DFFFE-U+DFFFF",
      "U+EFFFE-U+EFFFF",
      "U+FFFFE-U+FFFFF",
      "U+10FFFE-U+10FFFF"
    ],
    "evaluation": "Reject when the scalar is a member of the union. bidiControls are an explicit audited subset of Cf and do not change union membership. No host ICU/Unicode version, regular-expression Unicode property or locale participates.",
    "revisionRule": "Changing UCD version, any range, union semantics or parser requires a new policyId, resolver id, manifest hash and parserContractSha256."
  },
  "nativePayloadCaps": {
    "spawnArgumentsUtf8Bytes": 64000,
    "functionCallOutputUtf8Bytes": 64000,
    "comparison": "Buffer byte length of the exact native string; values <=64000 may proceed to strict JSON parsing and values >=64001 reject before parsing",
    "terminology": "64000 decimal bytes exactly; never 64 KiB, 65536 bytes or a character count",
    "outputShape": "The bounded function_call_output JSON must be one object with the exact usable agent_id evidence required by the accepted native-link contract; the cap is part of parserContractSha256."
  }
} as const;

/** Exact canonical UTF-8 JSON for immutable parser contracts. */
export function canonicalEvidenceJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value,i)) throw new Error('actor_contract_invalid');
    return '[' + value.map(canonicalEvidenceJson).join(',') + ']';
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('actor_contract_invalid');
  return '{' + Object.keys(value).sort((a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b)))
    .map(key => JSON.stringify(key) + ':' + canonicalEvidenceJson((value as Record<string, unknown>)[key])).join(',') + '}';
}
/** Hash only canonical manifest bytes, never host catalogs or environment. */
export function evidenceContractHash(value: unknown): string {
  return createHash('sha256').update(canonicalEvidenceJson(value)).digest('hex');
}
function freeze(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  Object.values(value).forEach(freeze); Object.freeze(value);
}
freeze(R3_RESOLVER_MANIFEST);
export const R3_RESOLVER_MANIFEST_SHA256 = '4938b4cc9cbb984e039470e29b0a9bac46d43091a91d97d06219b4df09f9874b';
const policy = R3_RESOLVER_MANIFEST.modelForbiddenScalars;
const ranges = [...policy.Cc, ...policy.Cf, ...policy.bidiControls, ...policy.lineAndParagraphSeparators, ...policy.noncharacters]
  .map(range => { const [lo,hi = lo] = range.split('-').map(value => parseInt(value.slice(2),16)); return [lo,hi] as const; });

/** Exact ASCII role evidence, not a supported-role catalog. */
export function validEvidenceRole(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value);
}
/** Frozen UCD15.1 policy: no normalization, locale, ICU or Unicode property lookup. */
export function validEvidenceModel(value: unknown): value is string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value,'utf8') > 128) return false;
  for (const scalar of value) {
    const point = scalar.codePointAt(0)!;
    if ((point >= 0xD800 && point <= 0xDFFF) || ranges.some(([lo,hi]) => point >= lo && point <= hi)) return false;
  }
  return true;
}
/** Manifest self-check must precede resolver use and future publication. */
export function assertEvidenceManifest(): void {
  if (evidenceContractHash(R3_RESOLVER_MANIFEST) !== R3_RESOLVER_MANIFEST_SHA256) throw new Error('actor_contract_invalid');
}
