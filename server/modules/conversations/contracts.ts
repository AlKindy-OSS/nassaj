/**
 * Provider-neutral contracts for the Universal Conversation Contract.
 *
 * Harness adapters are deliberately typed as untrusted translators. They
 * receive a core-issued execution envelope and return observations; they never
 * receive a database handle or an authority-bearing approval object.
 */

declare const opaqueIdBrand: unique symbol;

export type OpaqueId<Kind extends string> = string & {
  readonly [opaqueIdBrand]: Kind;
};

export type ConversationId = OpaqueId<'conversation'>;
export type RunId = OpaqueId<'run'>;
export type AttemptId = OpaqueId<'attempt'>;
export type SegmentId = OpaqueId<'segment'>;
export type ProjectionId = OpaqueId<'projection'>;
export type PrincipalId = OpaqueId<'principal'>;
export type CredentialBindingId = OpaqueId<'credential-binding'>;
export type WriterEpoch = number & { readonly [opaqueIdBrand]: 'writer-epoch' };

export type CanonicalPosition = Readonly<{
  runSeq: number;
  eventSeq: number;
}>;

export type ContextWatermarks = Readonly<{
  projectedThrough: CanonicalPosition;
  submittedThrough: CanonicalPosition;
  confirmedThrough: CanonicalPosition;
}>;

export type ConversationStatus = 'active' | 'archived' | 'deleted';
export type RunStatus =
  | 'accepted'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'uncertain';
export type AttemptState = 'scheduled' | 'starting' | 'running' | 'recovering' | 'terminal';
export type TerminalOutcome = 'completed' | 'failed' | 'aborted' | 'uncertain';
export type SegmentState = 'active' | 'sealed' | 'quarantined';

export interface LogicalConversation {
  conversationId: ConversationId;
  projectId: string;
  createdBy: PrincipalId;
  status: ConversationStatus;
  nextRunSeq: number;
  writerEpoch: WriterEpoch;
  schemaVersion: number;
}

export interface ConversationRun {
  runId: RunId;
  conversationId: ConversationId;
  runSeq: number;
  principalId: PrincipalId;
  clientMsgId: string;
  status: RunStatus;
  requestedHarness: string;
  requestedModel: string | null;
  terminalOutcome: TerminalOutcome | null;
}

export interface ConversationAttempt {
  attemptId: AttemptId;
  runId: RunId;
  conversationId: ConversationId;
  attemptNo: number;
  segmentId: SegmentId;
  harnessId: string;
  adapterVersion: string;
  runtimeVersion: string;
  modelId: string;
  destinationEndpoint: string;
  credentialBindingId: CredentialBindingId;
  credentialEpoch: number;
  writerEpoch: WriterEpoch;
  state: AttemptState;
  terminalOutcome: TerminalOutcome | null;
  watermarks: ContextWatermarks;
}

export interface HarnessSegment {
  segmentId: SegmentId;
  conversationId: ConversationId;
  harnessId: string;
  userId: PrincipalId;
  credentialScopeId: string;
  credentialBindingId: CredentialBindingId;
  compatibilityGeneration: string;
  credentialEpoch: number;
  state: SegmentState;
  watermarks: ContextWatermarks;
}

export type CapabilitySupport = 'native' | 'emulated' | 'conditional' | 'unsupported';

export interface HarnessCapability {
  name: string;
  support: CapabilitySupport;
  limits?: Readonly<Record<string, number | string | boolean>>;
  evidenceAt: string;
}

export interface HarnessCapabilityProfile {
  harnessId: string;
  adapterVersion: string;
  runtimeVersion: string;
  credentialScopeId: string;
  modelId: string;
  capabilities: readonly HarnessCapability[];
}

export interface HarnessIdentity {
  contractVersion: '1';
  harnessId: string;
  adapterVersion: string;
}

/**
 * An opaque legal identity issued by trusted core code.
 *
 * The symbol brand prevents normal adapter code from manufacturing the value.
 * Runtime validation and writer fencing remain mandatory; TypeScript is only a
 * first boundary, not the authorization mechanism.
 */
declare const legalIdentityBrand: unique symbol;
export interface LegalExecutionIdentity {
  readonly conversationId: ConversationId;
  readonly runId: RunId;
  readonly attemptId: AttemptId;
  readonly segmentId: SegmentId;
  readonly principalId: PrincipalId;
  readonly writerEpoch: WriterEpoch;
  readonly credentialBindingId: CredentialBindingId;
  readonly credentialEpoch: number;
  readonly [legalIdentityBrand]: true;
}

export interface ProjectionEnvelope {
  projectionId: ProjectionId;
  schemaVersion: number;
  projectedFrom: CanonicalPosition;
  projectedThrough: CanonicalPosition;
  projectionDigest: string;
  policyVersion: string;
  policyEpoch: number;
  credentialEpoch: number;
  content: readonly unknown[];
}

export interface AdapterExecutionEnvelope {
  legalIdentity: LegalExecutionIdentity;
  projection: ProjectionEnvelope;
  modelId: string;
  capabilityToken: string;
}

export type ProviderObservationKind =
  | 'assistant_delta'
  | 'assistant_completed'
  | 'proposed_tool_call'
  | 'usage'
  | 'citation'
  | 'checkpoint'
  | 'terminal'
  | 'error';

/**
 * Untrusted adapter output. Legal actor, visibility, approvals and canonical
 * IDs are intentionally absent; trusted core derives them from the attempt.
 */
export interface ProviderObservation<Payload = unknown> {
  observationId: string;
  attemptCorrelationToken: string;
  providerSequence: number;
  kind: ProviderObservationKind;
  payload: Payload;
  observedAt: string;
  evidenceDigest?: string;
}

const PROVIDER_OBSERVATION_KEYS = new Set([
  'observationId',
  'attemptCorrelationToken',
  'providerSequence',
  'kind',
  'payload',
  'observedAt',
  'evidenceDigest',
]);
const MAX_OBSERVATION_BYTES = 256 * 1024;
const MAX_OBSERVATION_DEPTH = 16;
const MAX_OBSERVATION_ITEMS = 10_000;
const AUTHORITATIVE_PAYLOAD_FIELDS = new Set([
  'conversationId',
  'runId',
  'attemptId',
  'segmentId',
  'principalId',
  'actorId',
  'actorType',
  'visibility',
  'approval',
  'approvalNonce',
  'legalIdentity',
  'writerEpoch',
  'credentialEpoch',
  'credentialBindingId',
]);

function isBoundedJson(value: unknown): boolean {
  const seen = new Set<object>();
  let items = 0;
  const visit = (current: unknown, depth: number): boolean => {
    items += 1;
    if (items > MAX_OBSERVATION_ITEMS || depth > MAX_OBSERVATION_DEPTH) return false;
    if (current === null || ['string', 'boolean'].includes(typeof current)) return true;
    if (typeof current === 'number') return Number.isFinite(current);
    if (typeof current !== 'object' || seen.has(current)) return false;
    seen.add(current);
    if (Array.isArray(current)) return current.every((item) => visit(item, depth + 1));
    if (Object.getPrototypeOf(current) !== Object.prototype) return false;
    return Object.values(current as Record<string, unknown>).every((item) => visit(item, depth + 1));
  };
  if (!visit(value, 0)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_OBSERVATION_BYTES;
  } catch {
    return false;
  }
}

function containsAuthoritativeField(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsAuthoritativeField);
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) => AUTHORITATIVE_PAYLOAD_FIELDS.has(key) || containsAuthoritativeField(nested),
  );
}

export interface CapabilityProbeRequest {
  credentialScopeId: string;
  modelId: string;
}

export interface SegmentPreparationRequest {
  legalIdentity: LegalExecutionIdentity;
  compatibilityGeneration: string;
}

export interface ControlRequest {
  legalIdentity: LegalExecutionIdentity;
  operation: 'stop';
  idempotencyKey: string;
}

export interface CheckpointEvidence {
  providerCheckpointRef: string;
  projectionId: ProjectionId;
  projectionDigest: string;
  confirmedThrough: CanonicalPosition;
  credentialEpoch: number;
}

export interface ReconciliationRequest {
  legalIdentity: LegalExecutionIdentity;
  expectedProjectionId: ProjectionId;
  expectedProjectionDigest: string;
}

export interface ReconciliationObservation {
  classification: 'confirmed' | 'missing' | 'contradictory' | 'uncertain';
  checkpoint?: CheckpointEvidence;
  evidenceDigest: string;
}

/** Universal adapter interface. No method grants tool-effect authority. */
export interface HarnessAdapterV1 {
  identify(): Promise<HarnessIdentity>;
  probe(request: CapabilityProbeRequest): Promise<HarnessCapabilityProfile>;
  prepareSegment(request: SegmentPreparationRequest): Promise<ProviderObservation>;
  startAttempt(envelope: AdapterExecutionEnvelope): Promise<ProviderObservation>;
  stream(envelope: AdapterExecutionEnvelope): AsyncIterable<ProviderObservation>;
  requestControl(request: ControlRequest): Promise<ProviderObservation>;
  checkpoint(envelope: AdapterExecutionEnvelope): Promise<CheckpointEvidence | null>;
  reconcile(request: ReconciliationRequest): Promise<ReconciliationObservation>;
  seal(request: SegmentPreparationRequest): Promise<ProviderObservation>;
  importLegacy?(sourceRef: string): AsyncIterable<ProviderObservation>;
}

/** Runtime validator used before trusted core interprets an adapter message. */
export function isProviderObservation(value: unknown): value is ProviderObservation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ProviderObservation> & Record<string, unknown>;
  const kinds = new Set<ProviderObservationKind>([
    'assistant_delta',
    'assistant_completed',
    'proposed_tool_call',
    'usage',
    'citation',
    'checkpoint',
    'terminal',
    'error',
  ]);
  const keys = Object.keys(candidate);
  return (
    keys.length >= 6 &&
    keys.every((key) => PROVIDER_OBSERVATION_KEYS.has(key)) &&
    typeof candidate.observationId === 'string' &&
    candidate.observationId.length > 0 && candidate.observationId.length <= 256 &&
    typeof candidate.attemptCorrelationToken === 'string' &&
    candidate.attemptCorrelationToken.length > 0 && candidate.attemptCorrelationToken.length <= 512 &&
    Number.isSafeInteger(candidate.providerSequence) &&
    Number(candidate.providerSequence) >= 0 &&
    typeof candidate.kind === 'string' &&
    kinds.has(candidate.kind as ProviderObservationKind) &&
    typeof candidate.observedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.observedAt)) &&
    (candidate.evidenceDigest === undefined ||
      (typeof candidate.evidenceDigest === 'string' && candidate.evidenceDigest.length <= 256)) &&
    isBoundedJson(candidate.payload) &&
    !containsAuthoritativeField(candidate.payload)
  );
}
