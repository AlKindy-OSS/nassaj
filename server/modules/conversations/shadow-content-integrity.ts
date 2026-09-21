import { createHmac, type Hmac } from 'node:crypto';

export const SHADOW_CONTENT_LIMITS = Object.freeze({
  maxChunkBytes: 1024 * 1024,
  maxGenerationBytes: 64 * 1024 * 1024,
  maxSourceChunks: 100_000,
  maxStructuredDepth: 16,
  maxStructuredNodes: 4_096,
  maxStructuredBytes: 256 * 1024,
  maxEventIds: 2_048,
  maxEventIdLength: 256,
  maxToolIdLength: 256,
});

export type ShadowContentIntegrityState = 'verified' | 'unknown' | 'diverged';

export type ShadowContentIntegrityCode =
  | 'CONTENT_INTEGRITY_OVERFLOW'
  | 'CONTENT_INTEGRITY_SCHEMA_GAP'
  | 'CONTENT_INTEGRITY_REENTRANT'
  | 'CONTENT_DEDUPE_HORIZON_EXCEEDED'
  | 'CONTENT_SOURCE_EVENT_SUBSTITUTION'
  | 'CONTENT_SOURCE_SEQUENCE_GAP'
  | 'CONTENT_SOURCE_SEQUENCE_REORDERED';

export interface ShadowLegacyEnvelopeSnapshot {
  kind: 'session_created' | 'complete' | 'error';
  provider: string | null;
  sessionId: string | null;
  clientMsgId: string | null;
  success: boolean | null;
  exitCode: number | null;
  notStarted: boolean;
  invalidProviderClaim: boolean;
  invalidClientMsgIdClaim: boolean;
  invalidSessionRef: boolean;
  conflictingSessionRefs: boolean;
  invalidSuccessClaim: boolean;
  invalidExitCodeClaim: boolean;
  invalidNotStartedClaim: boolean;
  terminalControlDigest: string | null;
  invalidTerminalControlClaim: boolean;
}

export interface ShadowContentObservation {
  type: 'content' | 'durable' | 'ignored';
  envelope: ShadowLegacyEnvelopeSnapshot | null;
  contentSeenBefore: boolean;
  contentBeforeSessionCreated: boolean;
  terminalControlConflict: boolean;
}

export interface ShadowContentIntegritySummary {
  integrityState: ShadowContentIntegrityState;
  contentDigest: string;
  summaryDigest: string;
  segmentCount: number;
  sourceChunkCount: number;
  canonicalBytes: number;
  duplicateEventCount: number;
  overflow: boolean;
  schemaGap: boolean;
  reentrant: boolean;
  substitutionCount: number;
  sequenceGapCount: number;
  sequenceReorderCount: number;
  terminalOutcome: ShadowTerminalOutcome;
  codes: ShadowContentIntegrityCode[];
}

export type ShadowTerminalOutcome = 'success' | 'error' | 'not_started' | 'unknown';

declare const trustedSourceEventIdCapabilityBrand: unique symbol;
export interface TrustedSourceEventIdCapability {
  readonly stableEventIds: true;
  readonly [trustedSourceEventIdCapabilityBrand]: true;
}

const trustedSourceEventIdCapabilities = new WeakSet<object>();

/** Core-only issuer after an adapter contract proves event IDs stable within one dispatch. */
export function issueTrustedSourceEventIdCapability(): TrustedSourceEventIdCapability {
  const capability = Object.freeze({ stableEventIds: true });
  trustedSourceEventIdCapabilities.add(capability);
  return capability as TrustedSourceEventIdCapability;
}

export interface ShadowContentIntegrityAccumulatorOptions {
  runId: string;
  dispatchGeneration: number;
  referenceKeyVersion: number;
  referenceKey: Buffer;
  trustedSourceSequence?: boolean;
  trustedSourceEventIdCapability?: TrustedSourceEventIdCapability;
}

export class BoundedJcsError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'BoundedJcsError';
  }
}

type JcsLimits = {
  maxDepth: number;
  maxNodes: number;
  maxBytes: number;
};

const DEFAULT_JCS_LIMITS: JcsLimits = {
  maxDepth: SHADOW_CONTENT_LIMITS.maxStructuredDepth,
  maxNodes: SHADOW_CONTENT_LIMITS.maxStructuredNodes,
  maxBytes: SHADOW_CONTENT_LIMITS.maxStructuredBytes,
};

const MAX_SUMMARY_COUNTER = SHADOW_CONTENT_LIMITS.maxSourceChunks + 1;

function incrementSummaryCounter(value: number): number {
  return Math.min(value + 1, MAX_SUMMARY_COUNTER);
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Detects JSON.stringify transformation hooks without invoking accessors. */
function hasJsonWireSerializationHook(value: object): boolean {
  try {
    let current: object | null = value;
    for (let depth = 0; current && depth < 64; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'toJSON');
      if (descriptor) {
        return 'value' in descriptor
          ? typeof descriptor.value === 'function'
          : typeof descriptor.get === 'function';
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    return current !== null;
  } catch {
    return true;
  }
}

/**
 * Bounded deterministic JSON canonicalizer for the RFC 8785-compatible subset
 * used by Phase-0 tool evidence. It is intentionally not advertised as a full
 * JCS implementation: unsupported JavaScript values fail closed.
 */
export function canonicalizeBoundedJcs(
  value: unknown,
  limits: Partial<JcsLimits> = {},
): string {
  const resolved = { ...DEFAULT_JCS_LIMITS, ...limits };
  for (const [key, hardMaximum] of Object.entries(DEFAULT_JCS_LIMITS)) {
    const candidate = resolved[key as keyof JcsLimits];
    if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > hardMaximum) {
      throw new BoundedJcsError('JCS_INVALID_LIMITS');
    }
  }
  let nodes = 0;
  let bytes = 0;
  const ancestors = new WeakSet<object>();
  const parts: string[] = [];

  const append = (part: string): void => {
    bytes += Buffer.byteLength(part, 'utf8');
    if (bytes > resolved.maxBytes) throw new BoundedJcsError('JCS_BYTES_EXCEEDED');
    parts.push(part);
  };
  const visit = (current: unknown, depth: number): void => {
    if (depth > resolved.maxDepth) throw new BoundedJcsError('JCS_DEPTH_EXCEEDED');
    nodes += 1;
    if (nodes > resolved.maxNodes) throw new BoundedJcsError('JCS_NODES_EXCEEDED');

    if (current === null) {
      append('null');
      return;
    }
    if (typeof current === 'boolean') {
      append(current ? 'true' : 'false');
      return;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new BoundedJcsError('JCS_NON_FINITE_NUMBER');
      append(JSON.stringify(current));
      return;
    }
    if (typeof current === 'string') {
      // Reject on the raw code-unit length before JSON.stringify can allocate
      // an escaped copy many times larger than the configured evidence bound.
      if (current.length > resolved.maxBytes) {
        throw new BoundedJcsError('JCS_BYTES_EXCEEDED');
      }
      if (hasLoneSurrogate(current)) throw new BoundedJcsError('JCS_LONE_SURROGATE');
      append(JSON.stringify(current));
      return;
    }
    if (typeof current !== 'object') throw new BoundedJcsError('JCS_UNSUPPORTED_VALUE');
    if (ancestors.has(current)) throw new BoundedJcsError('JCS_CYCLE');
    if (hasJsonWireSerializationHook(current)) {
      throw new BoundedJcsError('JCS_TO_JSON_HOOK');
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > resolved.maxNodes - nodes) {
          throw new BoundedJcsError('JCS_NODES_EXCEEDED');
        }
        let enumeratedKeys = 0;
        for (const key in current) {
          enumeratedKeys += 1;
          if (enumeratedKeys > resolved.maxNodes) {
            throw new BoundedJcsError('JCS_NODES_EXCEEDED');
          }
          if (
            Object.prototype.hasOwnProperty.call(current, key)
            && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length)
          ) {
            throw new BoundedJcsError('JCS_UNSUPPORTED_ARRAY_SHAPE');
          }
        }
        append('[');
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor) {
            throw new BoundedJcsError('JCS_ARRAY_HOLE');
          }
          if (!('value' in descriptor)) throw new BoundedJcsError('JCS_ACCESSOR_PROPERTY');
          if (index > 0) append(',');
          visit(descriptor.value, depth + 1);
        }
        append(']');
        return;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new BoundedJcsError('JCS_CUSTOM_PROTOTYPE');
      }
      const keys: string[] = [];
      let enumeratedKeys = 0;
      let cumulativeKeyBytes = 0;
      for (const key in current) {
        enumeratedKeys += 1;
        if (enumeratedKeys > resolved.maxNodes) {
          throw new BoundedJcsError('JCS_NODES_EXCEEDED');
        }
        if (key.length > resolved.maxBytes) throw new BoundedJcsError('JCS_BYTES_EXCEEDED');
        cumulativeKeyBytes += Buffer.byteLength(key, 'utf8');
        if (cumulativeKeyBytes > resolved.maxBytes) {
          throw new BoundedJcsError('JCS_BYTES_EXCEEDED');
        }
        if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
        if (keys.length >= resolved.maxNodes - nodes) {
          throw new BoundedJcsError('JCS_NODES_EXCEEDED');
        }
        keys.push(key);
      }
      keys.sort();
      append('{');
      keys.forEach((key, index) => {
        if (hasLoneSurrogate(key)) throw new BoundedJcsError('JCS_LONE_SURROGATE');
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !('value' in descriptor)) {
          throw new BoundedJcsError('JCS_ACCESSOR_PROPERTY');
        }
        if (index > 0) append(',');
        append(JSON.stringify(key));
        append(':');
        visit(descriptor.value, depth + 1);
      });
      append('}');
    } finally {
      ancestors.delete(current);
    }
  };

  visit(value, 0);
  return parts.join('');
}

function boundedText(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

const LEGACY_PAYLOAD_FIELDS = [
  'kind',
  'content',
  'text',
  'input',
  'toolInput',
  'result',
  'toolResult',
  'toolUseResult',
  'subagentTools',
  'images',
  'displayText',
  'parentToolUseId',
  'provider',
  'clientMsgId',
  'sessionId',
  'newSessionId',
  'success',
  'exitCode',
  'notStarted',
  'role',
  'toolId',
  'tool_use_id',
  'toolName',
  'name',
  'isError',
  'is_error',
  'sourceEventId',
  'eventId',
  'id',
  'sourceSequence',
  'sequence',
  'seq',
  'error',
  'reason',
  'code',
  'aborted',
  'abortFailed',
  'pendingWorkflows',
  'actualSessionId',
  'forked',
  'parentSessionId',
  'timestamp',
  'model',
  'cwd',
] as const;

type LegacyPayloadField = (typeof LEGACY_PAYLOAD_FIELDS)[number];
type InspectedLegacyPayload = {
  values: Partial<Record<LegacyPayloadField, unknown>>;
  present: ReadonlySet<LegacyPayloadField>;
  accessors: ReadonlySet<LegacyPayloadField>;
  extras: Readonly<Record<string, unknown>>;
  extraAccessors: readonly string[];
  inspectionTruncated: boolean;
  wireSerializationHook: boolean;
};

const LEGACY_PAYLOAD_FIELD_SET = new Set<string>(LEGACY_PAYLOAD_FIELDS);
const NON_SEMANTIC_PAYLOAD_FIELDS = new Set<LegacyPayloadField>([
  'id',
  'timestamp',
  'model',
  'cwd',
]);
const UNSUPPORTED_VISIBLE_PAYLOAD_FIELDS = new Set<LegacyPayloadField>([
  'toolResult',
  'toolUseResult',
  'subagentTools',
  'images',
  'displayText',
  'parentToolUseId',
]);
const MAX_EXTRA_PAYLOAD_FIELDS = 64;
const MAX_PAYLOAD_ENUMERATION_STEPS = 128;
const MAX_EXTRA_FIELD_NAME_BYTES = 4_096;

/** Fixed-field inspection that never invokes a top-level payload accessor. */
function inspectLegacyPayload(row: object): InspectedLegacyPayload {
  const values: Partial<Record<LegacyPayloadField, unknown>> = {};
  const present = new Set<LegacyPayloadField>();
  const accessors = new Set<LegacyPayloadField>();
  for (const field of LEGACY_PAYLOAD_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(row, field);
    if (!descriptor?.enumerable) continue;
    present.add(field);
    if ('value' in descriptor) values[field] = descriptor.value;
    else accessors.add(field);
  }
  const extras: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const extraAccessors: string[] = [];
  let inspectionTruncated = false;
  let enumerationSteps = 0;
  let extraNameBytes = 0;
  let extraCount = 0;
  for (const key in row) {
    enumerationSteps += 1;
    if (enumerationSteps > MAX_PAYLOAD_ENUMERATION_STEPS) {
      inspectionTruncated = true;
      break;
    }
    if (LEGACY_PAYLOAD_FIELD_SET.has(key) || !Object.prototype.hasOwnProperty.call(row, key)) {
      continue;
    }
    if (key.length > MAX_EXTRA_FIELD_NAME_BYTES) {
      inspectionTruncated = true;
      break;
    }
    extraNameBytes += Buffer.byteLength(key, 'utf8');
    if (
      extraCount >= MAX_EXTRA_PAYLOAD_FIELDS
      || extraNameBytes > MAX_EXTRA_FIELD_NAME_BYTES
    ) {
      inspectionTruncated = true;
      break;
    }
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!descriptor?.enumerable) continue;
    extraCount += 1;
    if ('value' in descriptor) extras[key] = descriptor.value;
    else extraAccessors.push(key);
  }
  return {
    values,
    present,
    accessors,
    extras,
    extraAccessors,
    inspectionTruncated,
    wireSerializationHook: hasJsonWireSerializationHook(row),
  };
}

function hasSemanticAccessor(inspected: InspectedLegacyPayload): boolean {
  for (const field of inspected.accessors) {
    if (!NON_SEMANTIC_PAYLOAD_FIELDS.has(field)) return true;
  }
  return false;
}

function hasUnsupportedVisibleClaim(inspected: InspectedLegacyPayload): boolean {
  for (const field of UNSUPPORTED_VISIBLE_PAYLOAD_FIELDS) {
    if (inspected.present.has(field) || inspected.accessors.has(field)) return true;
  }
  return inspected.inspectionTruncated
    || inspected.wireSerializationHook
    || inspected.extraAccessors.length > 0
    || Object.keys(inspected.extras).length > 0;
}

function normalizeSessionRef(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  const normalized = value.trim();
  return normalized
    && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

function utf16Be(value: string): Buffer {
  const output = Buffer.allocUnsafe(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    output.writeUInt16BE(value.charCodeAt(index), index * 2);
  }
  return output;
}

function u32(value: number): Buffer {
  const output = Buffer.allocUnsafe(4);
  output.writeUInt32BE(value, 0);
  return output;
}

function u64(value: number): Buffer {
  const output = Buffer.allocUnsafe(8);
  output.writeBigUInt64BE(BigInt(value), 0);
  return output;
}

function updateField(hmac: Hmac, value: Buffer): void {
  hmac.update(u32(value.byteLength));
  hmac.update(value);
}

function updateUtf8Field(hmac: Hmac, value: string): void {
  updateField(hmac, Buffer.from(value, 'utf8'));
}

function updateUtf16Field(hmac: Hmac, value: string): void {
  updateField(hmac, utf16Be(value));
}

type TerminalControlFingerprintOptions = Pick<
  ShadowContentIntegrityAccumulatorOptions,
  'runId' | 'dispatchGeneration' | 'referenceKey'
>;

const VERDICT_CONTROL_FIELDS = [
  'provider',
  'clientMsgId',
  'success',
  'exitCode',
  'notStarted',
  'content',
  'error',
  'reason',
  'code',
  'aborted',
  'abortFailed',
  'pendingWorkflows',
  'actualSessionId',
  'sessionId',
  'newSessionId',
  'forked',
  'parentSessionId',
] as const satisfies readonly LegacyPayloadField[];

const STRING_CONTROL_FIELDS = new Set<LegacyPayloadField>([
  'provider',
  'clientMsgId',
  'content',
  'reason',
  'code',
  'actualSessionId',
  'sessionId',
  'newSessionId',
  'parentSessionId',
]);
const BOOLEAN_CONTROL_FIELDS = new Set<LegacyPayloadField>([
  'success',
  'notStarted',
  'aborted',
  'abortFailed',
  'forked',
]);

type InvalidCoreVerdictClaims = {
  invalidProviderClaim: boolean;
  invalidClientMsgIdClaim: boolean;
  invalidSessionRef: boolean;
  invalidSuccessClaim: boolean;
  invalidExitCodeClaim: boolean;
  invalidNotStartedClaim: boolean;
};

function invalidOptionalTextClaim(
  inspected: InspectedLegacyPayload,
  field: 'provider' | 'clientMsgId',
  maxLength: number,
): boolean {
  if (inspected.accessors.has(field)) return true;
  if (!inspected.present.has(field)) return false;
  const value = inspected.values[field];
  if (value === null) return false;
  return typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value.trim().length === 0;
}

function invalidOptionalSessionClaim(
  inspected: InspectedLegacyPayload,
  field: 'sessionId' | 'newSessionId',
): boolean {
  if (inspected.accessors.has(field)) return true;
  if (!inspected.present.has(field)) return false;
  const value = inspected.values[field];
  return value !== null && normalizeSessionRef(value) === null;
}

function inspectInvalidCoreVerdictClaims(
  inspected: InspectedLegacyPayload,
): InvalidCoreVerdictClaims {
  const success = inspected.values.success;
  const exitCode = inspected.values.exitCode;
  const notStarted = inspected.values.notStarted;
  return {
    invalidProviderClaim: invalidOptionalTextClaim(inspected, 'provider', 128),
    invalidClientMsgIdClaim: invalidOptionalTextClaim(inspected, 'clientMsgId', 128),
    invalidSessionRef: invalidOptionalSessionClaim(inspected, 'sessionId')
      || invalidOptionalSessionClaim(inspected, 'newSessionId'),
    invalidSuccessClaim: inspected.accessors.has('success') || (
      inspected.present.has('success')
      && success !== null
      && typeof success !== 'boolean'
    ),
    invalidExitCodeClaim: inspected.accessors.has('exitCode') || (
      inspected.present.has('exitCode')
      && exitCode !== null
      && !(
        typeof exitCode === 'number'
        && Number.isSafeInteger(exitCode)
        && exitCode >= -2_147_483_648
        && exitCode <= 2_147_483_647
      )
    ),
    invalidNotStartedClaim: inspected.accessors.has('notStarted') || (
      inspected.present.has('notStarted') && typeof notStarted !== 'boolean'
    ),
  };
}

function fingerprintVerdictControl(
  options: TerminalControlFingerprintOptions,
  kind: ShadowLegacyEnvelopeSnapshot['kind'],
  inspected: InspectedLegacyPayload,
  invalidCoreClaims: InvalidCoreVerdictClaims,
): { digest: string | null; invalid: boolean } {
  const terminalMac = createHmac('sha256', options.referenceKey);
  updateUtf8Field(terminalMac, 'nassaj-shadow-verdict-control-v1');
  updateUtf8Field(terminalMac, options.runId);
  updateField(terminalMac, u64(options.dispatchGeneration));
  updateUtf8Field(terminalMac, kind);
  const projection: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let invalid = inspected.inspectionTruncated
    || inspected.extraAccessors.length > 0
    || Object.keys(inspected.extras).length > 0
    || hasUnsupportedVisibleClaim(inspected)
    || Object.values(invalidCoreClaims).some(Boolean);
  for (const field of VERDICT_CONTROL_FIELDS) {
    if (inspected.accessors.has(field)) {
      projection[field] = { state: 'accessor' };
      invalid = true;
      continue;
    }
    if (!inspected.present.has(field)) {
      projection[field] = { state: 'absent' };
      continue;
    }
    const value = inspected.values[field];
    if (value === undefined) {
      projection[field] = { state: 'undefined' };
      invalid = true;
      continue;
    }
    if (value === null) {
      projection[field] = { state: 'null' };
      continue;
    }
    if (STRING_CONTROL_FIELDS.has(field) && typeof value !== 'string') invalid = true;
    if (BOOLEAN_CONTROL_FIELDS.has(field) && typeof value !== 'boolean') invalid = true;
    if (
      field === 'pendingWorkflows'
      && !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    ) {
      invalid = true;
    }
    if (
      field === 'exitCode'
      && !(
        typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= -2_147_483_648
        && value <= 2_147_483_647
      )
    ) {
      invalid = true;
    }
    if (field === 'error' && typeof value !== 'string' && typeof value !== 'object') {
      invalid = true;
    }
    projection[field] = { state: 'value', value };
  }
  projection.extras = inspected.extras;
  projection.extraAccessors = inspected.extraAccessors;
  projection.inspectionTruncated = inspected.inspectionTruncated;
  try {
    updateUtf8Field(terminalMac, canonicalizeBoundedJcs(projection));
  } catch {
    updateUtf8Field(terminalMac, 'invalid-or-oversized-control-projection');
    invalid = true;
  }
  return { digest: terminalMac.digest('hex'), invalid };
}

/** Small fallback used only when the process-wide heavy-accumulator cap is full. */
export class ShadowLightweightLegacyObserver {
  private contentSeen = false;
  private contentBeforeSessionCreated = false;
  private sessionCreatedObserved = false;
  private observing = false;
  private terminalObserved = false;
  private terminalControlDigest: string | null = null;
  private terminalControlValid = true;
  private sessionControlObserved = false;
  private sessionControlDigest: string | null = null;
  private sessionControlValid = true;

  constructor(private readonly options: TerminalControlFingerprintOptions) {}

  observe(payload: unknown): ShadowContentObservation {
    if (this.observing) return this.contentObservation('ignored', null);
    this.observing = true;
    try {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return this.contentObservation('ignored', null);
      }
      const inspected = inspectLegacyPayload(payload);
      const row = inspected.values;
      const rawKind = row.kind;
      const kind = typeof rawKind === 'string' && rawKind.length <= 64 ? rawKind : null;
      const contentSeenBefore = this.contentSeen;
      if (kind !== 'session_created' && kind !== 'complete' && kind !== 'error') {
        if (
          hasSemanticAccessor(inspected)
          || kind !== null
          || inspected.present.has('content')
          || inspected.present.has('text')
          || inspected.present.has('input')
          || inspected.present.has('result')
        ) {
          this.contentSeen = true;
          if (!this.sessionCreatedObserved) this.contentBeforeSessionCreated = true;
          return this.contentObservation('content', null);
        }
        return this.contentObservation('ignored', null);
      }

      const rawProvider = row.provider;
      const provider = typeof rawProvider === 'string'
        && rawProvider.length <= 128
        && rawProvider.trim()
        ? rawProvider.trim()
        : null;
      const rawClientMsgId = row.clientMsgId;
      const clientMsgId = typeof rawClientMsgId === 'string'
        && rawClientMsgId.length <= 128
        && rawClientMsgId.trim()
        ? rawClientMsgId.trim()
        : null;
      const sessionIdValue = row.sessionId;
      const rawSessionId = typeof sessionIdValue === 'string'
        && (sessionIdValue.length > 512 || (sessionIdValue.length > 0 && sessionIdValue.trim()))
        ? sessionIdValue
        : row.newSessionId;
      const sessionId = normalizeSessionRef(rawSessionId);
      const directSessionId = normalizeSessionRef(row.sessionId);
      const newSessionId = normalizeSessionRef(row.newSessionId);
      const conflictingSessionRefs = Boolean(
        directSessionId && newSessionId && directSessionId !== newSessionId,
      );
      const rawExitCode = row.exitCode;
      const exitCode = typeof rawExitCode === 'number'
        && Number.isSafeInteger(rawExitCode)
        && rawExitCode >= -2_147_483_648
        && rawExitCode <= 2_147_483_647
        ? rawExitCode
        : null;
      const invalidCoreClaims = inspectInvalidCoreVerdictClaims(inspected);
      const terminalClaim = fingerprintVerdictControl(
        this.options,
        kind,
        inspected,
        invalidCoreClaims,
      );
      const terminalControlConflict = kind === 'session_created'
        ? this.sessionControlObserved && (
          terminalClaim.invalid
          || conflictingSessionRefs
          || !this.sessionControlValid
          || terminalClaim.digest !== this.sessionControlDigest
        )
        : this.terminalObserved && (
          terminalClaim.invalid
          || !this.terminalControlValid
          || terminalClaim.digest !== this.terminalControlDigest
        );
      const envelope: ShadowLegacyEnvelopeSnapshot = {
        kind,
        provider,
        sessionId,
        clientMsgId,
        success: typeof row.success === 'boolean' ? row.success : null,
        exitCode,
        notStarted: row.notStarted === true,
        invalidProviderClaim: invalidCoreClaims.invalidProviderClaim,
        invalidClientMsgIdClaim: invalidCoreClaims.invalidClientMsgIdClaim,
        invalidSessionRef: invalidCoreClaims.invalidSessionRef,
        conflictingSessionRefs,
        invalidSuccessClaim: invalidCoreClaims.invalidSuccessClaim,
        invalidExitCodeClaim: invalidCoreClaims.invalidExitCodeClaim,
        invalidNotStartedClaim: invalidCoreClaims.invalidNotStartedClaim,
        terminalControlDigest: terminalClaim.digest,
        invalidTerminalControlClaim: terminalClaim.invalid || conflictingSessionRefs,
      };
      if (kind === 'session_created') this.sessionCreatedObserved = true;
      if (kind === 'session_created' && !this.sessionControlObserved) {
        this.sessionControlObserved = true;
        this.sessionControlDigest = terminalClaim.digest;
        this.sessionControlValid = !terminalClaim.invalid && !conflictingSessionRefs;
      }
      if ((kind === 'complete' || kind === 'error') && !this.terminalObserved) {
        this.terminalObserved = true;
        this.terminalControlDigest = terminalClaim.digest;
        this.terminalControlValid = !terminalClaim.invalid;
      }
      return {
        type: 'durable',
        envelope,
        contentSeenBefore,
        contentBeforeSessionCreated: this.contentBeforeSessionCreated,
        terminalControlConflict,
      };
    } catch {
      this.contentSeen = true;
      if (!this.sessionCreatedObserved) this.contentBeforeSessionCreated = true;
      return this.contentObservation('ignored', null);
    } finally {
      this.observing = false;
    }
  }

  private contentObservation(
    type: ShadowContentObservation['type'],
    envelope: ShadowLegacyEnvelopeSnapshot | null,
  ): ShadowContentObservation {
    return {
      type,
      envelope,
      contentSeenBefore: this.contentSeen,
      contentBeforeSessionCreated: this.contentBeforeSessionCreated,
      terminalControlConflict: false,
    };
  }
}

type ActiveTextSegment = {
  hmac: Hmac;
  kind: 'text' | 'thinking' | 'complete' | 'error';
  role: string;
  ordinal: number;
};

type EventEvidence = { digest: string };

const TEXT_KINDS = new Set(['stream_delta', 'text', 'thinking']);
const STRUCTURED_TOOL_KINDS = new Set(['tool_use', 'tool_result']);
const KNOWN_VISIBLE_UNSUPPORTED_KINDS = new Set([
  'status',
  'permission_request',
  'permission_cancelled',
  'interactive_prompt',
  'task_notification',
  'task_reconcile',
  'workflow_reconciled',
]);

/** O(1)-space, synchronous content evidence for one run dispatch generation. */
export class ShadowContentIntegrityAccumulator {
  private readonly finalMac: Hmac;
  private readonly eventIds = new Map<string, EventEvidence>();
  private activeText: ActiveTextSegment | null = null;
  private sourceChunkCount = 0;
  private canonicalBytes = 0;
  private segmentCount = 0;
  private duplicateEventCount = 0;
  private substitutionCount = 0;
  private sequenceGapCount = 0;
  private sequenceReorderCount = 0;
  private dedupeHorizonExceeded = false;
  private lastTrustedSequence: number | null = null;
  private overflow = false;
  private schemaGap = false;
  private reentrant = false;
  private hashingStopped = false;
  private observing = false;
  private sessionCreatedObserved = false;
  private contentSeen = false;
  private contentBeforeSessionCreated = false;
  private finalized: ShadowContentIntegritySummary | null = null;
  private finalizedTerminalOutcome: ShadowTerminalOutcome | null = null;
  private pendingTerminalControlDigest: string | null | undefined;
  private finalizedTerminalControlDigest: string | null = null;
  private pendingTerminalControlValid = true;
  private finalizedTerminalControlValid = true;
  private terminalClaimConflict = false;
  private sessionControlObserved = false;
  private sessionControlDigest: string | null = null;
  private sessionControlValid = true;
  private lateContentAfterTerminal = false;
  private readonly trustsSourceEventIds: boolean;

  constructor(private readonly options: ShadowContentIntegrityAccumulatorOptions) {
    if (!Number.isSafeInteger(options.dispatchGeneration) || options.dispatchGeneration < 1) {
      throw new Error('INVALID_SHADOW_DISPATCH_GENERATION');
    }
    if (
      !Number.isSafeInteger(options.referenceKeyVersion)
      || options.referenceKeyVersion < 1
      || options.referenceKeyVersion > 0xffff_ffff
    ) {
      throw new Error('INVALID_SHADOW_REFERENCE_KEY_VERSION');
    }
    this.finalMac = createHmac('sha256', options.referenceKey);
    updateUtf8Field(this.finalMac, 'nassaj-shadow-content-run-v1');
    updateUtf8Field(this.finalMac, options.runId);
    updateField(this.finalMac, u64(options.dispatchGeneration));
    updateField(this.finalMac, u32(options.referenceKeyVersion));
    this.trustsSourceEventIds = Boolean(
      options.trustedSourceEventIdCapability
      && trustedSourceEventIdCapabilities.has(options.trustedSourceEventIdCapability),
    );
  }

  get dispatchGeneration(): number {
    return this.options.dispatchGeneration;
  }

  get referenceKeyVersion(): number {
    return this.options.referenceKeyVersion;
  }

  observe(payload: unknown): ShadowContentObservation {
    if (this.observing) {
      this.reentrant = true;
      this.schemaGap = true;
      return this.contentObservation('ignored', null);
    }
    this.observing = true;
    try {
      return this.observeOnce(payload);
    } catch {
      this.schemaGap = true;
      this.stopHashing();
      return this.contentObservation('ignored', null);
    } finally {
      this.observing = false;
    }
  }

  finalize(terminalOutcome: unknown): ShadowContentIntegritySummary {
    const normalizedTerminalOutcome: ShadowTerminalOutcome =
      terminalOutcome === 'success'
      || terminalOutcome === 'error'
      || terminalOutcome === 'not_started'
      || terminalOutcome === 'unknown'
        ? terminalOutcome
        : 'unknown';
    if (normalizedTerminalOutcome !== terminalOutcome) this.schemaGap = true;
    if (this.finalized) {
      if (
        this.finalizedTerminalOutcome !== normalizedTerminalOutcome
        || this.terminalClaimConflict
      ) {
        throw new Error('SHADOW_CONTENT_TERMINAL_CLAIM_CONFLICT');
      }
      return this.finalized;
    }
    this.closeActiveText();
    updateUtf8Field(this.finalMac, 'terminal-summary-v1');
    updateField(this.finalMac, u64(this.segmentCount));
    updateField(this.finalMac, u64(this.canonicalBytes));
    updateUtf8Field(this.finalMac, normalizedTerminalOutcome);
    updateField(this.finalMac, u32(this.options.referenceKeyVersion));
    const codes = this.codes();
    const integrityState: ShadowContentIntegrityState =
      this.substitutionCount > 0 || this.sequenceGapCount > 0 || this.sequenceReorderCount > 0
        ? 'diverged'
        : normalizedTerminalOutcome === 'unknown'
          || this.overflow || this.schemaGap || this.reentrant
          ? 'unknown'
          : 'verified';
    const contentDigest = this.finalMac.digest();
    const summaryMac = createHmac('sha256', this.options.referenceKey);
    updateUtf8Field(summaryMac, 'nassaj-shadow-content-summary-v1');
    updateUtf8Field(summaryMac, this.options.runId);
    updateField(summaryMac, u64(this.options.dispatchGeneration));
    updateField(summaryMac, u32(this.options.referenceKeyVersion));
    updateField(summaryMac, contentDigest);
    updateUtf8Field(summaryMac, integrityState);
    updateField(summaryMac, u64(this.segmentCount));
    updateField(summaryMac, u64(this.sourceChunkCount));
    updateField(summaryMac, u64(this.canonicalBytes));
    updateField(summaryMac, u64(this.duplicateEventCount));
    updateField(summaryMac, u64(this.substitutionCount));
    updateField(summaryMac, u64(this.sequenceGapCount));
    updateField(summaryMac, u64(this.sequenceReorderCount));
    updateUtf8Field(summaryMac, normalizedTerminalOutcome);
    updateField(summaryMac, Buffer.from([
      this.overflow ? 1 : 0,
      this.schemaGap ? 1 : 0,
      this.reentrant ? 1 : 0,
    ]));
    this.finalized = Object.freeze({
      integrityState,
      contentDigest: contentDigest.toString('hex'),
      summaryDigest: summaryMac.digest('hex'),
      segmentCount: this.segmentCount,
      sourceChunkCount: this.sourceChunkCount,
      canonicalBytes: this.canonicalBytes,
      duplicateEventCount: this.duplicateEventCount,
      overflow: this.overflow,
      schemaGap: this.schemaGap,
      reentrant: this.reentrant,
      substitutionCount: this.substitutionCount,
      sequenceGapCount: this.sequenceGapCount,
      sequenceReorderCount: this.sequenceReorderCount,
      terminalOutcome: normalizedTerminalOutcome,
      codes,
    });
    this.finalizedTerminalOutcome = normalizedTerminalOutcome;
    this.finalizedTerminalControlDigest = this.pendingTerminalControlDigest ?? null;
    this.finalizedTerminalControlValid = this.pendingTerminalControlValid;
    return this.finalized;
  }

  hasFinalizedSummary(): boolean {
    return this.finalized !== null;
  }

  markExternalSchemaGap(): void {
    this.schemaGap = true;
  }

  dispose(): void {
    this.eventIds.clear();
    this.activeText = null;
    this.hashingStopped = true;
  }

  getRetainedEvidenceEstimate(): number {
    return this.eventIds.size * 160 + (this.activeText ? 512 : 0) + 2_048;
  }

  consumeLateContentAfterTerminal(): boolean {
    const observed = this.lateContentAfterTerminal;
    this.lateContentAfterTerminal = false;
    return observed;
  }

  private observeOnce(payload: unknown): ShadowContentObservation {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return this.contentObservation('ignored', null);
    }
    const inspected = inspectLegacyPayload(payload);
    const row = inspected.values;
    if (hasSemanticAccessor(inspected) || hasUnsupportedVisibleClaim(inspected)) {
      this.schemaGap = true;
    }
    const rawKind = row.kind;
    const kind = typeof rawKind === 'string' && rawKind.length <= 64 ? rawKind : null;
    const contentSeenBefore = this.contentSeen;
    if (
      this.finalized
      && kind !== 'session_created'
      && kind !== 'complete'
      && kind !== 'error'
    ) {
      if (
        kind !== null
        || hasSemanticAccessor(inspected)
        || inspected.present.has('content')
        || inspected.present.has('text')
        || inspected.present.has('input')
        || inspected.present.has('result')
      ) {
        this.lateContentAfterTerminal = true;
      }
      return this.contentObservation(kind ? 'content' : 'ignored', null);
    }
    if (kind === 'session_created' || kind === 'complete' || kind === 'error') {
      const rawProvider = row.provider;
      const providerText = typeof rawProvider === 'string'
        && rawProvider.length <= 128
        && rawProvider.trim()
        ? rawProvider.trim()
        : null;
      const rawClientMsgId = row.clientMsgId;
      const clientMsgIdText = typeof rawClientMsgId === 'string'
        && rawClientMsgId.length <= 128
        && rawClientMsgId.trim()
        ? rawClientMsgId.trim()
        : null;
      const sessionIdValue = row.sessionId;
      const newSessionIdValue = row.newSessionId;
      const rawSessionId = typeof sessionIdValue === 'string'
        && (sessionIdValue.length > 512 || (sessionIdValue.length > 0 && sessionIdValue.trim()))
        ? sessionIdValue
        : newSessionIdValue;
      const normalizedSessionId = normalizeSessionRef(rawSessionId);
      const normalizedDirectSessionId = normalizeSessionRef(row.sessionId);
      const normalizedNewSessionId = normalizeSessionRef(row.newSessionId);
      const conflictingSessionRefs = Boolean(
        normalizedDirectSessionId
        && normalizedNewSessionId
        && normalizedDirectSessionId !== normalizedNewSessionId,
      );
      const rawSuccess = row.success;
      const rawExitCode = row.exitCode;
      const rawNotStarted = row.notStarted;
      const exitCode = typeof rawExitCode === 'number'
        && Number.isSafeInteger(rawExitCode)
        && rawExitCode >= -2_147_483_648
        && rawExitCode <= 2_147_483_647
        ? rawExitCode
        : null;
      const invalidCoreClaims = inspectInvalidCoreVerdictClaims(inspected);
      const terminalClaim = fingerprintVerdictControl(
        this.options,
        kind,
        inspected,
        invalidCoreClaims,
      );
      let terminalControlConflict = false;
      if (kind === 'session_created') {
        terminalControlConflict = this.sessionControlObserved && (
          terminalClaim.invalid
          || conflictingSessionRefs
          || !this.sessionControlValid
          || terminalClaim.digest !== this.sessionControlDigest
        );
        if (!this.sessionControlObserved) {
          this.sessionControlObserved = true;
          this.sessionControlDigest = terminalClaim.digest;
          this.sessionControlValid = !terminalClaim.invalid && !conflictingSessionRefs;
        }
      } else {
        if (this.finalized) {
          terminalControlConflict = terminalClaim.invalid
            || !this.finalizedTerminalControlValid
            || terminalClaim.digest !== this.finalizedTerminalControlDigest;
          if (terminalControlConflict) this.terminalClaimConflict = true;
        } else {
          this.pendingTerminalControlDigest = terminalClaim.digest;
          this.pendingTerminalControlValid = !terminalClaim.invalid;
        }
      }
      const envelope: ShadowLegacyEnvelopeSnapshot = {
        kind,
        provider: providerText,
        sessionId: normalizedSessionId,
        clientMsgId: clientMsgIdText,
        success: typeof rawSuccess === 'boolean' ? rawSuccess : null,
        exitCode,
        notStarted: rawNotStarted === true,
        invalidProviderClaim: invalidCoreClaims.invalidProviderClaim,
        invalidClientMsgIdClaim: invalidCoreClaims.invalidClientMsgIdClaim,
        invalidSessionRef: invalidCoreClaims.invalidSessionRef,
        conflictingSessionRefs,
        invalidSuccessClaim: invalidCoreClaims.invalidSuccessClaim,
        invalidExitCodeClaim: invalidCoreClaims.invalidExitCodeClaim,
        invalidNotStartedClaim: invalidCoreClaims.invalidNotStartedClaim,
        terminalControlDigest: terminalClaim.digest,
        invalidTerminalControlClaim: terminalClaim.invalid || conflictingSessionRefs,
      };
      if (
        invalidCoreClaims.invalidProviderClaim
        || invalidCoreClaims.invalidClientMsgIdClaim
        || invalidCoreClaims.invalidSessionRef
        || conflictingSessionRefs
        || invalidCoreClaims.invalidSuccessClaim
        || invalidCoreClaims.invalidExitCodeClaim
        || invalidCoreClaims.invalidNotStartedClaim
        || terminalClaim.invalid
      ) {
        this.schemaGap = true;
      }
      if (kind === 'session_created') {
        this.sessionCreatedObserved = true;
      } else {
        if (!this.finalized) this.closeActiveText();
      }
      return {
        type: 'durable',
        envelope,
        contentSeenBefore,
        contentBeforeSessionCreated: this.contentBeforeSessionCreated,
        terminalControlConflict,
      };
    }

    if (kind === 'stream_end') {
      this.closeActiveText();
      return this.contentObservation('content', null);
    }
    if (kind && TEXT_KINDS.has(kind)) {
      const content = row.content;
      if (typeof content !== 'string') {
        this.markSchemaGap();
      } else {
        const rawRole = row.role;
        const trustedRole = rawRole === 'user' || rawRole === 'assistant' ? rawRole : null;
        const role = trustedRole ?? 'assistant';
        if (rawRole !== undefined && trustedRole === null) this.schemaGap = true;
        const semanticKind = kind === 'thinking' ? 'thinking' : 'text';
        this.addText(
          semanticKind,
          role,
          content,
          this.readEventId(inspected),
          this.readSequence(inspected),
        );
      }
      return this.contentObservation('content', null);
    }
    if (kind && STRUCTURED_TOOL_KINDS.has(kind)) {
      this.addStructuredTool(kind, inspected);
      return this.contentObservation('content', null);
    }
    if (
      (kind && KNOWN_VISIBLE_UNSUPPORTED_KINDS.has(kind))
      || hasSemanticAccessor(inspected)
      || inspected.present.has('content')
      || inspected.present.has('text')
      || inspected.present.has('input')
      || inspected.present.has('toolInput')
      || inspected.present.has('result')
      || inspected.present.has('kind')
    ) {
      this.markSchemaGap();
      return this.contentObservation('content', null);
    }
    return this.contentObservation('ignored', null);
  }

  private addText(
    kind: ActiveTextSegment['kind'],
    role: string,
    content: string,
    eventId: string | null,
    sequence: number | null,
  ): void {
    this.noteSourceContent();
    const bytes = content.length * 2;
    if (
      this.hashingStopped
      || bytes > SHADOW_CONTENT_LIMITS.maxChunkBytes
      || this.canonicalBytes + bytes > SHADOW_CONTENT_LIMITS.maxGenerationBytes
    ) {
      this.markOverflow();
      return;
    }
    const canonical = utf16Be(content);
    if (!this.checkSourceEvent(eventId, sequence, kind, role, '', canonical)) return;
    if (!this.reserveBytes(bytes)) return;
    if (
      !this.activeText
      || this.activeText.kind !== kind
      || this.activeText.role !== role
    ) {
      this.closeActiveText();
      this.activeText = {
        hmac: this.createSegmentMac(this.segmentCount + 1, kind, role, ''),
        kind,
        role,
        ordinal: this.segmentCount + 1,
      };
    }
    this.activeText.hmac.update(canonical);
  }

  private addStructuredTool(kind: string, inspected: InspectedLegacyPayload): void {
    this.noteSourceContent();
    if (this.hashingStopped) return;
    const row = inspected.values;
    const directToolId = boundedText(row.toolId, SHADOW_CONTENT_LIMITS.maxToolIdLength);
    const aliasToolId = boundedText(row.tool_use_id, SHADOW_CONTENT_LIMITS.maxToolIdLength);
    if (
      (inspected.present.has('toolId') && !directToolId)
      || (inspected.present.has('tool_use_id') && !aliasToolId)
      || (directToolId && aliasToolId && directToolId !== aliasToolId)
    ) {
      this.schemaGap = true;
    }
    const toolId = directToolId ?? aliasToolId ?? '';
    if (!toolId) this.schemaGap = true;
    let structured: unknown;
    if (kind === 'tool_use') {
      const hasToolInput = inspected.present.has('toolInput');
      const hasInput = inspected.present.has('input');
      const selectedInput = hasToolInput ? row.toolInput : hasInput ? row.input : null;
      if (hasToolInput && hasInput) {
        try {
          if (canonicalizeBoundedJcs(row.toolInput) !== canonicalizeBoundedJcs(row.input)) {
            this.schemaGap = true;
          }
        } catch {
          this.markSchemaGap();
          return;
        }
      }
      const directToolName = boundedText(row.toolName, 256);
      const aliasToolName = boundedText(row.name, 256);
      if (
        (inspected.present.has('toolName') && !directToolName)
        || (inspected.present.has('name') && !aliasToolName)
        || (directToolName && aliasToolName && directToolName !== aliasToolName)
      ) {
        this.schemaGap = true;
      }
      structured = {
        input: selectedInput,
        name: directToolName ?? aliasToolName,
      };
    } else {
      const hasContent = inspected.present.has('content');
      const hasResult = inspected.present.has('result');
      const selectedResult = hasContent ? row.content : hasResult ? row.result : null;
      if (hasContent && hasResult) {
        try {
          if (canonicalizeBoundedJcs(row.content) !== canonicalizeBoundedJcs(row.result)) {
            this.schemaGap = true;
          }
        } catch {
          this.markSchemaGap();
          return;
        }
      }
      const directIsError = typeof row.isError === 'boolean' ? row.isError : null;
      const aliasIsError = typeof row.is_error === 'boolean' ? row.is_error : null;
      if (
        (inspected.present.has('isError') && directIsError === null)
        || (inspected.present.has('is_error') && aliasIsError === null)
        || (
          directIsError !== null
          && aliasIsError !== null
          && directIsError !== aliasIsError
        )
      ) {
        this.schemaGap = true;
      }
      structured = {
        content: selectedResult,
        isError: directIsError ?? aliasIsError,
      };
    }
    let canonical: string;
    try {
      canonical = canonicalizeBoundedJcs(structured);
    } catch {
      this.markSchemaGap();
      return;
    }
    const bytes = Buffer.from(canonical, 'utf8');
    if (!this.checkSourceEvent(
      this.readEventId(inspected),
      this.readSequence(inspected),
      kind,
      'assistant',
      toolId,
      bytes,
    )) return;
    if (!this.reserveBytes(bytes.byteLength)) return;
    this.closeActiveText();
    const ordinal = this.segmentCount + 1;
    const segment = this.createSegmentMac(ordinal, kind, 'assistant', toolId);
    segment.update(bytes);
    this.closeSegmentDigest(segment.digest());
  }

  private createSegmentMac(ordinal: number, kind: string, role: string, toolId: string): Hmac {
    const segment = createHmac('sha256', this.options.referenceKey);
    updateUtf8Field(segment, 'nassaj-shadow-content-segment-v1');
    updateUtf8Field(segment, this.options.runId);
    updateField(segment, u64(this.options.dispatchGeneration));
    updateField(segment, u64(ordinal));
    updateUtf8Field(segment, kind);
    updateUtf8Field(segment, role);
    updateUtf16Field(segment, toolId);
    return segment;
  }

  private closeActiveText(): void {
    if (!this.activeText) return;
    this.closeSegmentDigest(this.activeText.hmac.digest());
    this.activeText = null;
  }

  private closeSegmentDigest(segmentDigest: Buffer): void {
    this.segmentCount = incrementSummaryCounter(this.segmentCount);
    updateField(this.finalMac, segmentDigest);
  }

  private noteSourceContent(): void {
    this.contentSeen = true;
    if (!this.sessionCreatedObserved) this.contentBeforeSessionCreated = true;
    this.sourceChunkCount = incrementSummaryCounter(this.sourceChunkCount);
    if (this.sourceChunkCount > SHADOW_CONTENT_LIMITS.maxSourceChunks) {
      this.markOverflow();
    }
  }

  private reserveBytes(bytes: number): boolean {
    if (
      this.hashingStopped
      || bytes > SHADOW_CONTENT_LIMITS.maxChunkBytes
      || this.canonicalBytes + bytes > SHADOW_CONTENT_LIMITS.maxGenerationBytes
    ) {
      this.markOverflow();
      return false;
    }
    this.canonicalBytes += bytes;
    return true;
  }

  private checkSourceEvent(
    eventId: string | null,
    sequence: number | null,
    kind: string,
    role: string,
    toolId: string,
    content: Buffer,
  ): boolean {
    let eventDigest: string | null = null;
    let eventKey: string | null = null;
    if (eventId && this.trustsSourceEventIds) {
      const keyMac = createHmac('sha256', this.options.referenceKey);
      updateUtf8Field(keyMac, 'nassaj-shadow-source-event-id-v1');
      updateUtf16Field(keyMac, eventId);
      eventKey = keyMac.digest('hex');
      const eventMac = createHmac('sha256', this.options.referenceKey);
      updateUtf8Field(eventMac, 'nassaj-shadow-source-event-v1');
      updateUtf8Field(eventMac, kind);
      updateUtf8Field(eventMac, role);
      updateUtf16Field(eventMac, toolId);
      updateField(eventMac, content);
      eventDigest = eventMac.digest('hex');
      const existing = this.eventIds.get(eventKey);
      if (existing) {
        this.eventIds.delete(eventKey);
        this.eventIds.set(eventKey, existing);
        if (existing.digest === eventDigest) {
          this.duplicateEventCount = incrementSummaryCounter(this.duplicateEventCount);
          return false;
        }
        this.substitutionCount = incrementSummaryCounter(this.substitutionCount);
      } else {
        this.eventIds.set(eventKey, { digest: eventDigest });
        if (this.eventIds.size > SHADOW_CONTENT_LIMITS.maxEventIds) {
          const oldest = this.eventIds.keys().next().value as string | undefined;
          if (oldest) this.eventIds.delete(oldest);
          this.dedupeHorizonExceeded = true;
          this.schemaGap = true;
        }
      }
    }

    if (this.options.trustedSourceSequence && sequence !== null) {
      if (this.lastTrustedSequence !== null) {
        if (sequence <= this.lastTrustedSequence) {
          this.sequenceReorderCount = incrementSummaryCounter(this.sequenceReorderCount);
        } else if (sequence > this.lastTrustedSequence + 1) {
          this.sequenceGapCount = incrementSummaryCounter(this.sequenceGapCount);
        }
      }
      if (this.lastTrustedSequence === null || sequence > this.lastTrustedSequence) {
        this.lastTrustedSequence = sequence;
      }
    }
    return true;
  }

  private readEventId(inspected: InspectedLegacyPayload): string | null {
    if (!this.trustsSourceEventIds) return null;
    const row = inspected.values;
    const sourceEventId = row.sourceEventId;
    const eventId = row.eventId;
    const normalizedId = row.id;
    const candidate = typeof sourceEventId === 'string'
      ? sourceEventId
      : typeof eventId === 'string'
        ? eventId
        : typeof normalizedId === 'string'
          ? normalizedId
          : null;
    if (!candidate) return null;
    if (candidate.length > SHADOW_CONTENT_LIMITS.maxEventIdLength || hasLoneSurrogate(candidate)) {
      this.schemaGap = true;
      return null;
    }
    return candidate;
  }

  private readSequence(inspected: InspectedLegacyPayload): number | null {
    if (!this.options.trustedSourceSequence) return null;
    const row = inspected.values;
    const sourceSequence = row.sourceSequence;
    const sequence = row.sequence;
    const seq = row.seq;
    const candidate = sourceSequence ?? sequence ?? seq;
    if (candidate === undefined || candidate === null) return null;
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0) {
      return candidate;
    }
    this.schemaGap = true;
    return null;
  }

  private contentObservation(
    type: ShadowContentObservation['type'],
    envelope: ShadowLegacyEnvelopeSnapshot | null,
  ): ShadowContentObservation {
    return {
      type,
      envelope,
      contentSeenBefore: this.contentSeen,
      contentBeforeSessionCreated: this.contentBeforeSessionCreated,
      terminalControlConflict: false,
    };
  }

  private markSchemaGap(): void {
    this.schemaGap = true;
    this.contentSeen = true;
    if (!this.sessionCreatedObserved) this.contentBeforeSessionCreated = true;
    this.closeActiveText();
  }

  private markOverflow(): void {
    this.overflow = true;
    this.stopHashing();
  }

  private stopHashing(): void {
    this.hashingStopped = true;
    this.activeText = null;
  }

  private codes(): ShadowContentIntegrityCode[] {
    const codes: ShadowContentIntegrityCode[] = [];
    if (this.overflow) codes.push('CONTENT_INTEGRITY_OVERFLOW');
    if (this.schemaGap) codes.push('CONTENT_INTEGRITY_SCHEMA_GAP');
    if (this.reentrant) codes.push('CONTENT_INTEGRITY_REENTRANT');
    if (this.dedupeHorizonExceeded) codes.push('CONTENT_DEDUPE_HORIZON_EXCEEDED');
    if (this.substitutionCount > 0) codes.push('CONTENT_SOURCE_EVENT_SUBSTITUTION');
    if (this.sequenceGapCount > 0) codes.push('CONTENT_SOURCE_SEQUENCE_GAP');
    if (this.sequenceReorderCount > 0) codes.push('CONTENT_SOURCE_SEQUENCE_REORDERED');
    return codes;
  }
}
