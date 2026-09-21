import { createHash, createHmac, randomUUID } from 'node:crypto';
import path from 'node:path';

import type Database from 'better-sqlite3';

import {
  ConversationFoundationRepository,
  ConversationRepositoryError,
  type AcceptedRunCommand,
} from './repository.js';
import {
  ShadowContentIntegrityAccumulator,
  ShadowLightweightLegacyObserver,
  type ShadowContentIntegrityState,
  type ShadowContentIntegritySummary,
  type ShadowContentObservation,
  type ShadowLegacyEnvelopeSnapshot,
} from './shadow-content-integrity.js';
import { ShadowConversationRecoveryService, type ShadowRecoveryReport } from './shadow-recovery.js';
import {
  initializeConversationFoundationSchema,
  type ConversationDatabaseInitialization,
} from './schema.js';
import { UNIVERSAL_CONVERSATION_SHADOW_FLAG } from './shadow-orchestrator.js';
import {
  acquireConversationWriterLock,
  type ConversationWriterLock,
} from './writer-lock.js';

export interface ShadowLegacyTurnInput {
  /** JWT-derived principal; never a client payload field. */
  principalId: string | number | null;
  clientMsgId: string | null;
  requestedProvider: string;
  requestedModel: string | null;
  /** Used only to calculate requestDigest, then discarded. */
  command: string;
  /** Server-issued authorization; client fields can never manufacture it. */
  authorization: TrustedShadowAuthorization | null;
}

export interface ShadowLegacyTurnHandle {
  readonly conversationId: string;
  readonly runId: string;
  readonly reused: boolean;
  observeLegacyPayload(
    payload: unknown,
    attestation?: TrustedLegacySessionAttestation | null,
    context?: ShadowLegacyObservationContext,
  ): void;
  markLegacyDispatchStarted(): void;
  finishLegacyDispatch?(): void;
  recordLegacyFailure(code: string): void;
}

export interface ShadowLegacyObservationContext {
  readonly preInspectionFailed?: boolean;
}

declare const trustedShadowAuthorizationBrand: unique symbol;
export interface TrustedShadowAuthorization {
  readonly authorizationId: string;
  readonly kind: 'fresh' | 'resume';
  readonly projectId: string;
  readonly principalId: string;
  readonly clientMsgId: string;
  readonly canSubmit: true;
  readonly authorizationProvenance: string;
  readonly legacyProvider: string | null;
  readonly legacySessionId: string | null;
  readonly [trustedShadowAuthorizationBrand]: true;
}

declare const trustedLegacyAttestationBrand: unique symbol;
export interface TrustedLegacySessionAttestation {
  readonly authorizationId: string;
  readonly principalId: string;
  readonly clientMsgId: string;
  readonly provider: string;
  readonly legacySessionId: string;
  readonly projectId: string;
  readonly [trustedLegacyAttestationBrand]: true;
}

const trustedAuthorizations = new WeakSet<object>();
const trustedAttestations = new WeakSet<object>();
export const SHADOW_CONTENT_ACCUMULATOR_CAPACITY = 128;
const SHADOW_CONTENT_ACCUMULATOR_ESTIMATED_BYTES = 340 * 1024;

/** Core-only constructor used after authoritative project/session checks. */
export function issueTrustedShadowAuthorization(input: {
  kind: 'fresh' | 'resume';
  projectId: string;
  principalId: string | number;
  clientMsgId: string;
  canSubmit: true;
  authorizationProvenance: string;
  legacyProvider?: string | null;
  legacySessionId?: string | null;
}): TrustedShadowAuthorization {
  const projectId = normalizeOptionalString(input.projectId);
  const principalId = normalizeOptionalString(String(input.principalId));
  const clientMsgId = normalizeClientMsgId(input.clientMsgId);
  const provenance = normalizeOptionalString(input.authorizationProvenance);
  const legacyProvider = normalizeOptionalString(input.legacyProvider);
  const legacySessionId = normalizeLegacySessionRef(input.legacySessionId);
  if (!projectId || !principalId || !clientMsgId || !provenance || input.canSubmit !== true) {
    throw new Error('INVALID_SHADOW_AUTHORIZATION_INPUT');
  }
  if (input.kind === 'resume' && (!legacyProvider || !legacySessionId)) {
    throw new Error('INVALID_SHADOW_RESUME_AUTHORIZATION');
  }
  if (input.kind === 'fresh' && (legacyProvider || legacySessionId)) {
    throw new Error('INVALID_SHADOW_FRESH_AUTHORIZATION');
  }
  const authorization = Object.freeze({
    authorizationId: randomUUID(),
    kind: input.kind,
    projectId,
    principalId,
    clientMsgId,
    canSubmit: input.canSubmit,
    authorizationProvenance: provenance,
    legacyProvider,
    legacySessionId,
  }) as TrustedShadowAuthorization;
  trustedAuthorizations.add(authorization);
  return authorization;
}

/** Core-only attestation after the emitted physical id is found in server state. */
export function issueTrustedLegacySessionAttestation(input: {
  authorization: TrustedShadowAuthorization;
  provider: string;
  legacySessionId: string;
  projectId: string;
}): TrustedLegacySessionAttestation {
  if (!trustedAuthorizations.has(input.authorization)) {
    throw new Error('UNTRUSTED_SHADOW_AUTHORIZATION');
  }
  const provider = normalizeOptionalString(input.provider);
  const legacySessionId = normalizeOptionalString(input.legacySessionId);
  const projectId = normalizeOptionalString(input.projectId);
  if (
    input.authorization.kind !== 'resume'
    || provider !== input.authorization.legacyProvider
    || legacySessionId !== input.authorization.legacySessionId
    || projectId !== input.authorization.projectId
  ) {
    throw new Error('INVALID_LEGACY_SESSION_ATTESTATION');
  }
  const attestation = Object.freeze({
    authorizationId: input.authorization.authorizationId,
    principalId: input.authorization.principalId,
    clientMsgId: input.authorization.clientMsgId,
    provider,
    legacySessionId,
    projectId,
  }) as TrustedLegacySessionAttestation;
  trustedAttestations.add(attestation);
  return attestation;
}

export interface UniversalConversationShadowHook {
  isEnabled(): boolean;
  beginLegacyTurn(input: ShadowLegacyTurnInput): ShadowLegacyTurnHandle | null;
  recordHookFailure(input: {
    principalId: string | number | null;
    phase: 'accept' | 'observe';
    code: string;
    conversationId?: string;
    runId?: string;
  }): void;
}

export interface ShadowParityRow {
  runId: string;
  conversationId: string;
  principalId: string;
  clientMsgId: string;
  requestedProvider: string;
  expectedLegacyRefDigest: string | null;
  observedLegacyRefDigest: string | null;
  identityState: 'pending' | 'match' | 'diverged' | 'unknown';
  authorshipState: 'pending' | 'match' | 'diverged' | 'unknown';
  orderState: 'pending' | 'match' | 'diverged' | 'unknown';
  shadowAcceptOutcome: 'accepted' | 'failed';
  legacyAcceptOutcome: 'pending' | 'accepted' | 'rejected' | 'unknown';
  legacyTerminalOutcome: 'pending' | 'success' | 'error' | 'not_started' | 'unknown';
  contentIntegrityState: 'pending' | ShadowContentIntegrityState;
  contentComparisonState: 'pending' | 'match' | 'unknown' | 'diverged';
  divergenceCodes: string[];
  legacyDispatchCount: number;
  duplicateCount: number;
  lastObservationSeq: number;
  terminalObserved: boolean;
}

export interface ShadowParityMetrics {
  totalRuns: number;
  completedComparisons: number;
  identityDivergences: number;
  authorshipDivergences: number;
  orderDivergences: number;
  acceptanceDivergences: number;
  runtimeDivergences: number;
  isolatedHookFailures: number;
}

export interface UniversalConversationShadowRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  lockPath: string;
  instanceId?: string;
  acquireLock?: (lockPath: string) => ConversationWriterLock | null;
  /** HMAC key for protected physical references. Required whenever enabled. */
  referenceKey?: string | Buffer;
  referenceKeyVersion?: number;
  /** Read keyring; the active version is used for new protected references. */
  referenceKeys?: Readonly<Record<number, string | Buffer>>;
  /** Version of the core authorization/attestation resolver bound at ingress. */
  authorizationResolverVersion?: string;
}

type StoredParityRow = {
  run_id: string;
  conversation_id: string;
  principal_id: string;
  client_msg_id: string;
  requested_provider: string;
  reference_key_version: number;
  expected_legacy_ref_digest: string | null;
  observed_legacy_ref_digest: string | null;
  identity_state: ShadowParityRow['identityState'];
  authorship_state: ShadowParityRow['authorshipState'];
  order_state: ShadowParityRow['orderState'];
  shadow_accept_outcome: ShadowParityRow['shadowAcceptOutcome'];
  legacy_accept_outcome: ShadowParityRow['legacyAcceptOutcome'];
  legacy_terminal_outcome: ShadowParityRow['legacyTerminalOutcome'];
  content_integrity_state: ShadowParityRow['contentIntegrityState'];
  content_comparison_state: ShadowParityRow['contentComparisonState'];
  divergence_codes_json: string;
  last_observation_seq: number;
  terminal_observed: number;
  duplicate_count: number;
  legacy_dispatch_count: number;
  writer_epoch: number;
};

type ReferenceKeyring = {
  activeVersion: number;
  keys: ReadonlyMap<number, Buffer>;
  fingerprint: string;
};

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u001f')).digest('hex');
}

function ownedId(prefix: string, parts: readonly string[]): string {
  return `${prefix}_${digest([`nassaj-${prefix}-v1`, ...parts]).slice(0, 40)}`;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const CLIENT_MSG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUESTED_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,127}$/;
const MAX_LEGACY_SESSION_REF_LENGTH = 512;

function normalizeClientMsgId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
  const normalized = normalizeOptionalString(value);
  return normalized && CLIENT_MSG_ID_PATTERN.test(normalized) ? normalized : null;
}

function normalizeRequestedModel(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 128) return undefined;
  const normalized = normalizeOptionalString(value);
  return normalized && REQUESTED_MODEL_PATTERN.test(normalized) ? normalized : undefined;
}

function normalizeLegacySessionRef(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_LEGACY_SESSION_REF_LENGTH
  ) return null;
  const normalized = normalizeOptionalString(value);
  return normalized
    && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : null;
}

function parseCodes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function withCode(codes: readonly string[], code: string): string[] {
  return codes.includes(code) ? [...codes] : [...codes, code];
}

function terminalOutcomeFromEnvelope(
  envelope: ShadowLegacyEnvelopeSnapshot,
): {
  outcome: Exclude<ShadowParityRow['legacyTerminalOutcome'], 'pending'>;
  signalConflict: boolean;
} {
  if (
    envelope.invalidSuccessClaim
    || envelope.invalidExitCodeClaim
    || envelope.invalidNotStartedClaim
  ) return { outcome: 'unknown', signalConflict: false };
  if (envelope.notStarted) {
    const signalConflict = envelope.success === true || envelope.exitCode === 0;
    return { outcome: signalConflict ? 'unknown' : 'not_started', signalConflict };
  }
  if (envelope.kind === 'error') {
    const signalConflict = envelope.success === true || envelope.exitCode === 0;
    return { outcome: signalConflict ? 'unknown' : 'error', signalConflict };
  }
  const successConflict =
    (envelope.success === true && envelope.exitCode !== null && envelope.exitCode !== 0)
    || (envelope.success === false && envelope.exitCode === 0);
  if (successConflict) return { outcome: 'unknown', signalConflict: true };
  if (envelope.success === true || envelope.exitCode === 0) {
    return { outcome: 'success', signalConflict: false };
  }
  if (envelope.success === false || (envelope.exitCode !== null && envelope.exitCode !== 0)) {
    return { outcome: 'error', signalConflict: false };
  }
  return { outcome: 'unknown', signalConflict: false };
}

function mergeContentIntegrityState(
  current: ShadowParityRow['contentIntegrityState'],
  next: ShadowContentIntegrityState,
): ShadowParityRow['contentIntegrityState'] {
  if (current === 'diverged' || next === 'diverged') return 'diverged';
  if (current === 'unknown' || next === 'unknown') return 'unknown';
  return 'verified';
}

function referenceKeyFingerprint(version: number, key: Buffer): string {
  return digest(['reference-key-fingerprint-v1', String(version), key.toString('base64')]);
}

function resolveReferenceKeyring(
  options: UniversalConversationShadowRuntimeOptions,
  env: NodeJS.ProcessEnv,
): ReferenceKeyring {
  const activeVersion = options.referenceKeyVersion
    ?? Number(env.NASSAJ_UNIVERSAL_CONVERSATIONS_REFERENCE_KEY_VERSION ?? 1);
  if (!Number.isSafeInteger(activeVersion) || activeVersion < 1 || activeVersion > 0xffff_ffff) {
    throw new Error('UNIVERSAL_CONVERSATION_REFERENCE_KEY_VERSION_INVALID');
  }

  const entries = new Map<number, Buffer>();
  const add = (rawVersion: string | number, rawKey: string | Buffer): void => {
    const version = Number(rawVersion);
    if (!Number.isSafeInteger(version) || version < 1 || version > 0xffff_ffff) {
      throw new Error('UNIVERSAL_CONVERSATION_REFERENCE_KEY_VERSION_INVALID');
    }
    const key = Buffer.isBuffer(rawKey) ? Buffer.from(rawKey) : Buffer.from(rawKey, 'utf8');
    if (key.byteLength < 32) throw new Error('UNIVERSAL_CONVERSATION_REFERENCE_KEY_REQUIRED');
    const existing = entries.get(version);
    if (existing && !existing.equals(key)) {
      throw new Error(`UNIVERSAL_CONVERSATION_REFERENCE_KEY_CONFLICT:${version}`);
    }
    entries.set(version, key);
  };

  const rawJson = env.NASSAJ_UNIVERSAL_CONVERSATIONS_REFERENCE_KEYS_JSON;
  if (rawJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      throw new Error('UNIVERSAL_CONVERSATION_REFERENCE_KEYRING_INVALID');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('UNIVERSAL_CONVERSATION_REFERENCE_KEYRING_INVALID');
    }
    for (const [version, key] of Object.entries(parsed)) {
      if (typeof key !== 'string') {
        throw new Error('UNIVERSAL_CONVERSATION_REFERENCE_KEYRING_INVALID');
      }
      add(version, key);
    }
  }
  for (const [version, key] of Object.entries(options.referenceKeys ?? {})) {
    add(version, key);
  }
  const singleKey = options.referenceKey ?? env.NASSAJ_UNIVERSAL_CONVERSATIONS_REFERENCE_KEY;
  if (singleKey) add(activeVersion, singleKey);
  if (!entries.has(activeVersion)) {
    throw new Error('UNIVERSAL_CONVERSATION_REFERENCE_KEY_REQUIRED');
  }
  const fingerprint = digest([
    'reference-keyring-v1',
    ...[...entries.entries()]
      .sort(([left], [right]) => left - right)
      .map(([version, key]) => referenceKeyFingerprint(version, key)),
  ]);
  return { activeVersion, keys: entries, fingerprint };
}

/**
 * Phase-0 runtime. It cannot call a harness or publish a client event: its only
 * responsibilities are fenced shadow acceptance, safe observation, and durable
 * parity/recovery evidence while the legacy path remains authoritative.
 */
export class UniversalConversationShadowRuntime implements UniversalConversationShadowHook {
  readonly enabled = true;
  readonly databaseInitialization: ConversationDatabaseInitialization;
  readonly instanceId: string;

  private readonly repository: ConversationFoundationRepository;
  private readonly recovery: ShadowConversationRecoveryService;
  private readonly writerEpochs = new Map<string, number>();
  private readonly recoveryReports: ShadowRecoveryReport[] = [];
  private readonly bootTrace: string[] = [];
  private isolatedHookFailures = 0;
  private closed = false;
  private activeContentAccumulators = 0;
  private readonly referenceKeyringFingerprint: string;

  private constructor(
    private readonly db: Database.Database,
    private readonly processLock: ConversationWriterLock,
    private readonly lockPath: string,
    private readonly referenceKeys: ReadonlyMap<number, Buffer>,
    private readonly referenceKeyVersion: number,
    referenceKeyringFingerprint: string,
    private readonly authorizationResolverVersion: string,
    instanceId: string,
  ) {
    this.instanceId = instanceId;
    this.referenceKeyringFingerprint = referenceKeyringFingerprint;
    this.bootTrace.push('lock_acquired');
    this.databaseInitialization = initializeConversationFoundationSchema(db);
    this.bootTrace.push('schema_applied');
    this.validateAndRegisterReferenceKeys();
    this.bootTrace.push('reference_keys_verified');
    this.repository = new ConversationFoundationRepository(db);
    this.recovery = new ShadowConversationRecoveryService(db);
    this.recoverExistingConversations();
  }

  static boot(
    db: Database.Database,
    options: UniversalConversationShadowRuntimeOptions,
  ): UniversalConversationShadowRuntime | null {
    const env = options.env ?? process.env;
    if (env[UNIVERSAL_CONVERSATION_SHADOW_FLAG] !== '1') return null;

    const keyring = resolveReferenceKeyring(options, env);
    const authorizationResolverVersion = normalizeOptionalString(
      options.authorizationResolverVersion
      ?? env.NASSAJ_UNIVERSAL_CONVERSATIONS_RESOLVER_VERSION
      ?? 'core-v1',
    );
    if (!authorizationResolverVersion) {
      throw new Error('UNIVERSAL_CONVERSATION_RESOLVER_VERSION_REQUIRED');
    }

    const normalizedLockPath = path.resolve(options.lockPath);
    const processLock = (options.acquireLock ?? acquireConversationWriterLock)(normalizedLockPath);
    if (!processLock) throw new Error('UNIVERSAL_CONVERSATION_NOT_WRITER');
    try {
      return new UniversalConversationShadowRuntime(
        db,
        processLock,
        normalizedLockPath,
        keyring.keys,
        keyring.activeVersion,
        keyring.fingerprint,
        authorizationResolverVersion,
        options.instanceId ?? `nassaj-${process.pid}-${randomUUID()}`,
      );
    } catch (error) {
      processLock.release();
      throw error;
    }
  }

  matchesBootstrapTarget(
    db: Database.Database,
    options: UniversalConversationShadowRuntimeOptions,
  ): boolean {
    const env = options.env ?? process.env;
    const keyring = resolveReferenceKeyring(options, env);
    const authorizationResolverVersion = options.authorizationResolverVersion
      ?? env.NASSAJ_UNIVERSAL_CONVERSATIONS_RESOLVER_VERSION
      ?? 'core-v1';
    return this.db === db
      && this.lockPath === path.resolve(options.lockPath)
      && this.referenceKeyVersion === keyring.activeVersion
      && this.authorizationResolverVersion === authorizationResolverVersion
      && this.referenceKeyringFingerprint === keyring.fingerprint;
  }

  isEnabled(): boolean {
    return !this.closed;
  }

  beginLegacyTurn(input: ShadowLegacyTurnInput): ShadowLegacyTurnHandle | null {
    this.assertOpen();
    if (input.principalId === null || input.principalId === undefined) {
      this.recordHookFailure({ principalId: null, phase: 'accept', code: 'SHADOW_PRINCIPAL_REQUIRED' });
      return null;
    }

    const principalId = String(input.principalId);
    const clientMsgId = normalizeClientMsgId(input.clientMsgId);
    if (!clientMsgId) {
      this.recordHookFailure({
        principalId,
        phase: 'accept',
        code: input.clientMsgId ? 'INVALID_CLIENT_MSG_ID' : 'MISSING_CLIENT_MSG_ID',
      });
      return null;
    }
    const requestedModel = normalizeRequestedModel(input.requestedModel);
    if (requestedModel === undefined) {
      this.recordHookFailure({ principalId, phase: 'accept', code: 'INVALID_REQUESTED_MODEL' });
      return null;
    }
    const authorization = input.authorization;
    if (
      !authorization
      || !trustedAuthorizations.has(authorization)
      || authorization.principalId !== principalId
      || authorization.clientMsgId !== clientMsgId
      || authorization.canSubmit !== true
      || !authorization.projectId
      || (authorization.kind === 'resume' && authorization.legacyProvider !== input.requestedProvider)
    ) {
      this.recordHookFailure({ principalId, phase: 'accept', code: 'UNVERIFIED_SHADOW_AUTHORIZATION' });
      return null;
    }
    const resolved = this.resolveTurnIdentity({
      authorization,
      principalId,
      clientMsgId,
      requestedProvider: input.requestedProvider,
      requestedModel,
      command: input.command,
    });
    const {
      conversationId,
      legacyRefDigest,
      referenceKeyVersion,
      requestDigest,
    } = resolved;
    const runId = ownedId('run', [conversationId, principalId, clientMsgId]);
    const commandId = ownedId('command', [conversationId, principalId, clientMsgId]);
    const activationWasKnown = this.writerEpochs.has(conversationId);
    const recoveryReportCount = this.recoveryReports.length;
    const bootTraceCount = this.bootTrace.length;
    let acceptedResult: { accepted: AcceptedRunCommand; writerEpoch: number };
    try {
      acceptedResult = this.db.transaction(() => {
        const writerEpoch = this.ensureConversationActive({
          conversationId,
          principalId,
          projectId: authorization.projectId,
        });
        const acceptInput = {
          commandId,
          runId,
          conversationId,
          principalId,
          clientMsgId,
          requestDigest,
          requestedHarness: input.requestedProvider,
          requestedModel,
          inputEventId: ownedId('event', [runId, 'user-accepted']),
          writerEpoch,
        };
        this.ensurePrincipalAuthorized({
          conversationId,
          principalId,
          authorization,
          writerEpoch,
        });
        this.recordAuthorizationEvidence(conversationId, authorization, writerEpoch);
        if (authorization.kind === 'resume' && legacyRefDigest) {
          this.recordLegacyLink({
            provider: input.requestedProvider,
            referenceKeyVersion,
            legacyRefDigest,
            conversationId,
            principalId,
            writerEpoch,
            linkKind: 'resume_verified',
          });
        }
        const accepted = this.repository.acceptRunCommandWithRelated(acceptInput, (result) => {
          this.recordParityAcceptance({
            runId: result.runId,
            conversationId,
            principalId,
            clientMsgId,
            requestDigest,
            requestedProvider: input.requestedProvider,
            expectedLegacyRefDigest: legacyRefDigest,
            referenceKeyVersion,
            writerEpoch,
          });
          this.recordIngress({
            principalId,
            clientMsgId,
            conversationId,
            requestDigest,
            writerEpoch,
          });
        });
        return { accepted, writerEpoch };
      })();
    } catch (error) {
      if (!activationWasKnown) {
        this.writerEpochs.delete(conversationId);
        this.recoveryReports.splice(recoveryReportCount);
        this.bootTrace.splice(bootTraceCount);
      }
      throw error;
    }
    const { accepted, writerEpoch } = acceptedResult;
    const referenceKey = this.referenceKeys.get(referenceKeyVersion);
    if (!referenceKey) {
      throw new Error(`UNIVERSAL_CONVERSATION_REFERENCE_KEY_VERSION_UNAVAILABLE:${referenceKeyVersion}`);
    }
    let contentAccumulator: ShadowContentIntegrityAccumulator | null = null;
    let contentObserver: ShadowContentIntegrityAccumulator | ShadowLightweightLegacyObserver | null = null;
    let dispatchGeneration: number | null = null;
    let contentSlotReserved = false;
    let dispatchFinished = false;
    let terminalDurablyRecorded = false;
    let failureDurablyRecorded = false;
    let payloadAfterFinishRecorded = false;
    let contentAfterTerminal = false;
    const releaseContentSlot = (): void => {
      if (!contentSlotReserved) return;
      contentSlotReserved = false;
      this.activeContentAccumulators = Math.max(0, this.activeContentAccumulators - 1);
    };
    const disposeDispatchEvidence = (): void => {
      contentAccumulator?.dispose();
      contentAccumulator = null;
      contentObserver = null;
      releaseContentSlot();
    };

    return {
      conversationId,
      runId: accepted.runId,
      reused: accepted.reused,
      observeLegacyPayload: (
        payload: unknown,
        attestation?: TrustedLegacySessionAttestation | null,
        context?: ShadowLegacyObservationContext,
      ): void => {
        if (dispatchFinished) {
          if (!payloadAfterFinishRecorded) {
            payloadAfterFinishRecorded = true;
            try {
              this.recordLegacyPayloadAfterFinish(accepted.runId);
            } catch {
              this.recordHookFailure({
                principalId,
                phase: 'observe',
                code: 'SHADOW_POST_FINISH_ANOMALY_RECORDING_FAILED',
                conversationId,
                runId: accepted.runId,
              });
            }
          }
          return;
        }
        if (!contentObserver || dispatchGeneration === null) return;
        try {
          if (context?.preInspectionFailed) contentAccumulator?.markExternalSchemaGap();
          const observation = contentObserver.observe(payload);
          if (terminalDurablyRecorded && observation.type === 'content') {
            contentAfterTerminal = true;
          }
          if (observation.type !== 'durable' || !observation.envelope) return;
          const terminalRecorded = this.observeLegacyPayload(
            accepted.runId,
            authorization,
            observation,
            attestation ?? null,
            dispatchGeneration,
            contentAccumulator,
          );
          if (terminalRecorded) terminalDurablyRecorded = true;
        } catch {
          this.recordHookFailure({
            principalId,
            phase: 'observe',
            code: 'SHADOW_OBSERVER_FAILED',
            conversationId,
            runId: accepted.runId,
          });
        }
      },
      markLegacyDispatchStarted: (): void => {
        if (dispatchGeneration !== null || contentObserver || contentSlotReserved) {
          this.recordHookFailure({
            principalId,
            phase: 'observe',
            code: 'SHADOW_DISPATCH_ALREADY_MARKED',
            conversationId,
            runId: accepted.runId,
          });
          return;
        }
        try {
          contentSlotReserved = this.tryAcquireContentAccumulatorSlot();
          dispatchGeneration = this.markLegacyDispatchStarted(
            commandId,
            accepted.runId,
            conversationId,
            writerEpoch,
            !contentSlotReserved,
          );
          if (contentSlotReserved) {
            contentAccumulator = new ShadowContentIntegrityAccumulator({
              runId: accepted.runId,
              dispatchGeneration,
              referenceKeyVersion,
              referenceKey,
            });
            contentObserver = contentAccumulator;
          } else {
            contentObserver = new ShadowLightweightLegacyObserver({
              runId: accepted.runId,
              dispatchGeneration,
              referenceKey,
            });
          }
        } catch {
          dispatchGeneration = null;
          contentObserver = null;
          contentAccumulator?.dispose();
          contentAccumulator = null;
          releaseContentSlot();
          this.recordHookFailure({
            principalId,
            phase: 'observe',
            code: 'SHADOW_DISPATCH_MARK_FAILED',
            conversationId,
            runId: accepted.runId,
          });
        }
      },
      finishLegacyDispatch: (): void => {
        if (dispatchFinished) return;
        dispatchFinished = true;
        try {
          if (contentAfterTerminal || contentAccumulator?.consumeLateContentAfterTerminal()) {
            this.recordLateContentAfterTerminal(accepted.runId);
          }
        } catch {
          this.recordHookFailure({
            principalId,
            phase: 'observe',
            code: 'SHADOW_LATE_CONTENT_FLUSH_FAILED',
            conversationId,
            runId: accepted.runId,
          });
        }
        try {
          if (
            dispatchGeneration !== null
            && !terminalDurablyRecorded
            && !failureDurablyRecorded
          ) {
            if (contentAccumulator?.hasFinalizedSummary()) {
              this.recordHookFailure({
                principalId,
                phase: 'observe',
                code: 'SHADOW_TERMINAL_COMMIT_UNCERTAIN',
                conversationId,
                runId: accepted.runId,
              });
            } else {
              this.recordLegacyFailure(
                accepted.runId,
                'LEGACY_PROVIDER_RETURNED_WITHOUT_VERDICT',
                contentAccumulator,
                dispatchGeneration,
              );
              failureDurablyRecorded = true;
            }
          }
        } catch {
          this.recordHookFailure({
            principalId,
            phase: 'observe',
            code: 'SHADOW_PROVIDER_RETURN_WITHOUT_VERDICT_RECORDING_FAILED',
            conversationId,
            runId: accepted.runId,
          });
        } finally {
          disposeDispatchEvidence();
        }
      },
      recordLegacyFailure: (code: string): void => {
        try {
          this.recordLegacyFailure(
            accepted.runId,
            code,
            contentAccumulator,
            dispatchGeneration,
          );
          failureDurablyRecorded = true;
        } catch {
          this.recordHookFailure({
            principalId,
            phase: 'observe',
            code: 'SHADOW_PROVIDER_FAILURE_RECORDING_FAILED',
            conversationId,
            runId: accepted.runId,
          });
        } finally {
          disposeDispatchEvidence();
        }
      },
    };
  }

  recordHookFailure(input: {
    principalId: string | number | null;
    phase: 'accept' | 'observe';
    code: string;
    conversationId?: string;
    runId?: string;
  }): void {
    this.isolatedHookFailures += 1;
    if (this.closed) return;
    try {
      const writerEpoch = input.conversationId
        ? this.writerEpochs.get(input.conversationId) ?? null
        : null;
      this.db
        .prepare(
          `INSERT INTO conversation_shadow_divergences
            (divergence_id, conversation_id, run_id, principal_id, code, phase, writer_epoch)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `divergence_${randomUUID()}`,
          input.conversationId ?? null,
          input.runId ?? null,
          input.principalId === null ? null : String(input.principalId),
          input.code,
          input.phase,
          writerEpoch,
        );
    } catch {
      // Failure isolation is stronger than metrics: legacy dispatch must survive
      // even when the parity database itself is unavailable.
    }
  }

  getParity(runId: string): ShadowParityRow | null {
    const row = this.readParity(runId);
    return row ? this.mapParity(row) : null;
  }

  getParityMetrics(): ShadowParityMetrics {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total_runs,
                SUM(CASE WHEN legacy_terminal_outcome IN ('success', 'error', 'not_started')
                               AND legacy_accept_outcome IN ('accepted', 'rejected')
                               AND identity_state IN ('match', 'diverged')
                               AND authorship_state IN ('match', 'diverged')
                               AND order_state IN ('match', 'diverged')
                               AND content_integrity_state IN ('verified', 'diverged')
                               AND content_comparison_state IN ('match', 'diverged')
                          THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN identity_state = 'diverged' THEN 1 ELSE 0 END) AS identity_diverged,
                SUM(CASE WHEN authorship_state = 'diverged' THEN 1 ELSE 0 END) AS authorship_diverged,
                SUM(CASE WHEN order_state = 'diverged' THEN 1 ELSE 0 END) AS order_diverged,
                SUM(CASE WHEN shadow_accept_outcome = 'accepted'
                           AND legacy_accept_outcome = 'rejected' THEN 1 ELSE 0 END) AS acceptance_diverged
           FROM conversation_shadow_parity`,
      )
      .get() as Record<string, number | null>;
    const divergences = this.db
      .prepare('SELECT COUNT(*) AS count FROM conversation_shadow_divergences')
      .get() as { count: number };
    return {
      totalRuns: row.total_runs ?? 0,
      completedComparisons: row.completed ?? 0,
      identityDivergences: row.identity_diverged ?? 0,
      authorshipDivergences: row.authorship_diverged ?? 0,
      orderDivergences: row.order_diverged ?? 0,
      acceptanceDivergences: row.acceptance_diverged ?? 0,
      runtimeDivergences: divergences.count,
      isolatedHookFailures: this.isolatedHookFailures,
    };
  }

  getRecoveryReports(): readonly ShadowRecoveryReport[] {
    return [...this.recoveryReports];
  }

  getBootTrace(): readonly string[] {
    return [...this.bootTrace];
  }

  getContentAccumulatorDiagnostics(): {
    active: number;
    capacity: number;
    estimatedMaximumBytes: number;
  } {
    return {
      active: this.activeContentAccumulators,
      capacity: SHADOW_CONTENT_ACCUMULATOR_CAPACITY,
      estimatedMaximumBytes:
        SHADOW_CONTENT_ACCUMULATOR_CAPACITY * SHADOW_CONTENT_ACCUMULATOR_ESTIMATED_BYTES,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [conversationId, writerEpoch] of this.writerEpochs) {
      try {
        this.repository.releaseWriter(conversationId, this.instanceId, writerEpoch);
      } catch {
        // Fencing still ends when the process lock is released.
      }
    }
    this.writerEpochs.clear();
    this.activeContentAccumulators = 0;
    this.processLock.release();
  }

  private tryAcquireContentAccumulatorSlot(): boolean {
    if (this.activeContentAccumulators >= SHADOW_CONTENT_ACCUMULATOR_CAPACITY) return false;
    this.activeContentAccumulators += 1;
    return true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('UNIVERSAL_CONVERSATION_RUNTIME_CLOSED');
  }

  private recoverExistingConversations(): void {
    const rows = this.db
      .prepare('SELECT conversation_id FROM conversations ORDER BY conversation_id')
      .all() as Array<{ conversation_id: string }>;
    for (const row of rows) this.activateConversation(row.conversation_id);
  }

  private validateAndRegisterReferenceKeys(): void {
    const registered = this.db
      .prepare('SELECT reference_key_version, key_fingerprint FROM conversation_reference_keys')
      .all() as Array<{ reference_key_version: number; key_fingerprint: string }>;
    const registeredByVersion = new Map(
      registered.map((row) => [row.reference_key_version, row.key_fingerprint]),
    );
    for (const row of registered) {
      const key = this.referenceKeys.get(row.reference_key_version);
      if (!key) {
        throw new Error(
          `UNIVERSAL_CONVERSATION_REFERENCE_KEY_VERSION_UNAVAILABLE:${row.reference_key_version}`,
        );
      }
      if (referenceKeyFingerprint(row.reference_key_version, key) !== row.key_fingerprint) {
        throw new Error(
          `UNIVERSAL_CONVERSATION_REFERENCE_KEY_FINGERPRINT_MISMATCH:${row.reference_key_version}`,
        );
      }
    }
    for (const [version, key] of this.referenceKeys) {
      const fingerprint = referenceKeyFingerprint(version, key);
      const existing = registeredByVersion.get(version);
      if (existing && existing !== fingerprint) {
        throw new Error(`UNIVERSAL_CONVERSATION_REFERENCE_KEY_FINGERPRINT_MISMATCH:${version}`);
      }
    }

    const referenced = this.db
      .prepare(
        `SELECT reference_key_version FROM conversation_legacy_links
         UNION
         SELECT reference_key_version FROM conversation_shadow_parity
         UNION
         SELECT reference_key_version FROM conversation_shadow_observations
         UNION
         SELECT reference_key_version FROM conversation_shadow_content_summaries`,
      )
      .all() as Array<{ reference_key_version: number }>;
    for (const row of referenced) {
      const key = this.referenceKeys.get(row.reference_key_version);
      if (!key) {
        throw new Error(
          `UNIVERSAL_CONVERSATION_REFERENCE_KEY_VERSION_UNAVAILABLE:${row.reference_key_version}`,
        );
      }
      const registeredFingerprint = registeredByVersion.get(row.reference_key_version);
      if (
        registeredFingerprint
        && registeredFingerprint !== referenceKeyFingerprint(row.reference_key_version, key)
      ) {
        throw new Error(
          `UNIVERSAL_CONVERSATION_REFERENCE_KEY_FINGERPRINT_MISMATCH:${row.reference_key_version}`,
        );
      }
    }

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO conversation_reference_keys
        (reference_key_version, key_fingerprint) VALUES (?, ?)`,
    );
    this.db.transaction(() => {
      for (const [version, key] of this.referenceKeys) {
        insert.run(version, referenceKeyFingerprint(version, key));
      }
    })();
  }

  private activateConversation(conversationId: string): number {
    const existing = this.writerEpochs.get(conversationId);
    if (existing !== undefined) return existing;
    const writerEpoch = this.repository.acquireWriterEpoch(conversationId, this.instanceId, {
      allowCrashTakeover: true,
    });
    this.bootTrace.push(`writer_epoch_acquired:${conversationId}`);
    const report = this.recovery.recoverConversation({
      conversationId,
      instanceId: this.instanceId,
      writerEpoch,
    });
    this.recoveryReports.push(report);
    this.bootTrace.push(`recovery_completed:${conversationId}`);
    this.repository.markWriterRecovered(conversationId, this.instanceId, writerEpoch);
    this.bootTrace.push(`writer_active:${conversationId}`);
    this.writerEpochs.set(conversationId, writerEpoch);
    return writerEpoch;
  }

  private protectLegacyRef(
    provider: string,
    legacySessionId: string,
    referenceKeyVersion = this.referenceKeyVersion,
  ): string {
    const key = this.referenceKeys.get(referenceKeyVersion);
    if (!key) {
      throw new Error(`UNIVERSAL_CONVERSATION_REFERENCE_KEY_VERSION_UNAVAILABLE:${referenceKeyVersion}`);
    }
    return createHmac('sha256', key)
      .update(['legacy-session-ref-v1', String(referenceKeyVersion), provider, legacySessionId].join('\u001f'))
      .digest('hex');
  }

  private requestDigest(input: {
    command: string;
    requestedProvider: string;
    requestedModel: string | null;
    legacyRefDigest: string | null;
  }): string {
    return digest([
      'shadow-request-v1',
      input.command,
      input.requestedProvider,
      input.requestedModel ?? '',
      input.legacyRefDigest ?? '',
    ]);
  }

  private resolveTurnIdentity(input: {
    authorization: TrustedShadowAuthorization;
    principalId: string;
    clientMsgId: string;
    requestedProvider: string;
    requestedModel: string | null;
    command: string;
  }): {
    conversationId: string;
    referenceKeyVersion: number;
    legacyRefDigest: string | null;
    requestDigest: string;
  } {
    const ingress = this.db
      .prepare(
        `SELECT i.conversation_id, i.request_digest, p.reference_key_version
           FROM conversation_shadow_ingress i
           JOIN conversation_shadow_parity p
             ON p.conversation_id = i.conversation_id
            AND p.principal_id = i.principal_id
            AND p.client_msg_id = i.client_msg_id
          WHERE i.principal_id = ? AND i.client_msg_id = ?`,
      )
      .get(input.principalId, input.clientMsgId) as
      | { conversation_id: string; request_digest: string; reference_key_version: number }
      | undefined;
    if (ingress) {
      const legacyRefDigest = input.authorization.legacySessionId
        ? this.protectLegacyRef(
          input.requestedProvider,
          input.authorization.legacySessionId,
          ingress.reference_key_version,
        )
        : null;
      const requestDigest = this.requestDigest({ ...input, legacyRefDigest });
      if (ingress.request_digest !== requestDigest) {
        throw new ConversationRepositoryError('IDEMPOTENCY_CONFLICT');
      }
      return {
        conversationId: ingress.conversation_id,
        referenceKeyVersion: ingress.reference_key_version,
        legacyRefDigest,
        requestDigest,
      };
    }

    let conversationId: string | null = null;
    let referenceKeyVersion = this.referenceKeyVersion;
    let legacyRefDigest = input.authorization.legacySessionId
      ? this.protectLegacyRef(input.requestedProvider, input.authorization.legacySessionId)
      : null;
    if (input.authorization.kind === 'resume' && input.authorization.legacySessionId) {
      const matches: Array<{
        conversationId: string;
        referenceKeyVersion: number;
        legacyRefDigest: string;
      }> = [];
      const select = this.db.prepare(
        `SELECT conversation_id FROM conversation_legacy_links
          WHERE legacy_provider = ? AND reference_key_version = ? AND legacy_ref_digest = ?`,
      );
      for (const version of [...this.referenceKeys.keys()].sort((left, right) => right - left)) {
        const candidateDigest = this.protectLegacyRef(
          input.requestedProvider,
          input.authorization.legacySessionId,
          version,
        );
        const linked = select.get(input.requestedProvider, version, candidateDigest) as
          | { conversation_id: string }
          | undefined;
        if (linked) {
          matches.push({
            conversationId: linked.conversation_id,
            referenceKeyVersion: version,
            legacyRefDigest: candidateDigest,
          });
        }
      }
      if (new Set(matches.map((match) => match.conversationId)).size > 1) {
        throw new ConversationRepositoryError('LEGACY_KEYRING_IDENTITY_CONFLICT');
      }
      const matched = matches[0];
      if (matched) {
        conversationId = matched.conversationId;
      }
    }
    const requestDigest = this.requestDigest({ ...input, legacyRefDigest });
    return {
      conversationId: conversationId ?? randomUUID(),
      referenceKeyVersion,
      legacyRefDigest,
      requestDigest,
    };
  }

  private ensureConversationActive(input: {
    conversationId: string;
    principalId: string;
    projectId: string;
  }): number {
    const exists = this.db
      .prepare('SELECT project_id FROM conversations WHERE conversation_id = ?')
      .get(input.conversationId) as { project_id: string } | undefined;
    if (!exists) {
      this.repository.createConversation({
        conversationId: input.conversationId,
        projectId: input.projectId,
        createdBy: input.principalId,
      });
    } else if (exists.project_id !== input.projectId) {
      throw new ConversationRepositoryError('SHADOW_PROJECT_SCOPE_MISMATCH');
    }
    return this.activateConversation(input.conversationId);
  }

  private ensurePrincipalAuthorized(input: {
    conversationId: string;
    principalId: string;
    authorization: TrustedShadowAuthorization;
    writerEpoch: number;
  }): void {
    const participant = this.db
      .prepare(
        `SELECT state, role FROM conversation_participants
          WHERE conversation_id = ? AND principal_id = ?`,
      )
      .get(input.conversationId, input.principalId) as
      | { state: string; role: string }
      | undefined;
    if (!participant) {
      if (!input.authorization.canSubmit) {
        throw new ConversationRepositoryError('SHADOW_PRINCIPAL_NOT_AUTHORIZED');
      }
      this.repository.addParticipant({
        conversationId: input.conversationId,
        principalId: input.principalId,
        writerEpoch: input.writerEpoch,
      });
    } else if (participant.state !== 'active' || participant.role === 'viewer') {
      throw new ConversationRepositoryError('SHADOW_PRINCIPAL_NOT_AUTHORIZED');
    }
  }

  private recordAuthorizationEvidence(
    conversationId: string,
    authorization: TrustedShadowAuthorization,
    writerEpoch: number,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO conversation_shadow_authorizations
          (authorization_id, conversation_id, principal_id, project_id,
           authorization_kind, provenance_digest, writer_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        authorization.authorizationId,
        conversationId,
        authorization.principalId,
        authorization.projectId,
        authorization.kind,
        digest(['shadow-authorization-provenance-v1', authorization.authorizationProvenance]),
        writerEpoch,
      );
  }

  private recordLegacyLink(input: {
    provider: string;
    referenceKeyVersion: number;
    legacyRefDigest: string;
    conversationId: string;
    principalId: string;
    writerEpoch: number;
    linkKind: 'resume_verified';
  }): void {
    const existing = this.db
      .prepare(
        `SELECT conversation_id FROM conversation_legacy_links
          WHERE legacy_provider = ? AND reference_key_version = ? AND legacy_ref_digest = ?`,
      )
      .get(input.provider, input.referenceKeyVersion, input.legacyRefDigest) as
      | { conversation_id: string }
      | undefined;
    if (existing && existing.conversation_id !== input.conversationId) {
      throw new ConversationRepositoryError('LEGACY_IDENTITY_CONFLICT');
    }
    this.db
      .prepare(
        `INSERT INTO conversation_legacy_links
          (legacy_provider, reference_key_version, legacy_ref_digest, conversation_id, link_kind,
           first_principal_id, writer_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(legacy_provider, reference_key_version, legacy_ref_digest) DO UPDATE SET
           writer_epoch = excluded.writer_epoch,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(
        input.provider,
        input.referenceKeyVersion,
        input.legacyRefDigest,
        input.conversationId,
        input.linkKind,
        input.principalId,
        input.writerEpoch,
      );
  }

  private recordParityAcceptance(input: {
    runId: string;
    conversationId: string;
    principalId: string;
    clientMsgId: string;
    requestDigest: string;
    requestedProvider: string;
    expectedLegacyRefDigest: string | null;
    referenceKeyVersion: number;
    writerEpoch: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO conversation_shadow_parity
          (run_id, conversation_id, principal_id, client_msg_id, request_digest,
           requested_provider, reference_key_version, expected_legacy_ref_digest,
           identity_state, writer_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           writer_epoch = excluded.writer_epoch,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(
        input.runId,
        input.conversationId,
        input.principalId,
        input.clientMsgId,
        input.requestDigest,
        input.requestedProvider,
        input.referenceKeyVersion,
        input.expectedLegacyRefDigest,
        input.expectedLegacyRefDigest ? 'match' : 'pending',
        input.writerEpoch,
      );
  }

  private recordIngress(input: {
    principalId: string;
    clientMsgId: string;
    conversationId: string;
    requestDigest: string;
    writerEpoch: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO conversation_shadow_ingress
          (principal_id, client_msg_id, conversation_id, request_digest, writer_epoch)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(principal_id, client_msg_id) DO UPDATE SET
           writer_epoch = excluded.writer_epoch`,
      )
      .run(
        input.principalId,
        input.clientMsgId,
        input.conversationId,
        input.requestDigest,
        input.writerEpoch,
      );
  }

  private recordContentSummary(input: {
    runId: string;
    conversationId: string;
    dispatchGeneration: number;
    referenceKeyVersion: number;
    terminalOutcome: Exclude<ShadowParityRow['legacyTerminalOutcome'], 'pending'>;
    writerEpoch: number;
    summary: ShadowContentIntegritySummary;
  }): void {
    if (input.summary.terminalOutcome !== input.terminalOutcome) {
      throw new Error('SHADOW_CONTENT_SUMMARY_TERMINAL_OUTCOME_MISMATCH');
    }
    this.db.prepare(
      `INSERT INTO conversation_shadow_content_summaries
        (run_id, conversation_id, dispatch_generation, reference_key_version,
         integrity_state, content_digest, summary_digest, segment_count,
         source_chunk_count, canonical_bytes, duplicate_event_count, overflow,
         schema_gap, reentrant, substitution_count, sequence_gap_count,
         sequence_reorder_count, terminal_outcome, writer_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.runId,
      input.conversationId,
      input.dispatchGeneration,
      input.referenceKeyVersion,
      input.summary.integrityState,
      input.summary.contentDigest,
      input.summary.summaryDigest,
      input.summary.segmentCount,
      input.summary.sourceChunkCount,
      input.summary.canonicalBytes,
      input.summary.duplicateEventCount,
      input.summary.overflow ? 1 : 0,
      input.summary.schemaGap ? 1 : 0,
      input.summary.reentrant ? 1 : 0,
      input.summary.substitutionCount,
      input.summary.sequenceGapCount,
      input.summary.sequenceReorderCount,
      input.terminalOutcome,
      input.writerEpoch,
    );
  }

  private observeLegacyPayload(
    runId: string,
    authorization: TrustedShadowAuthorization,
    observation: ShadowContentObservation,
    attestation: TrustedLegacySessionAttestation | null,
    dispatchGeneration: number,
    accumulator: ShadowContentIntegrityAccumulator | null,
  ): boolean {
    this.assertOpen();
    const envelope = observation.envelope;
    if (!envelope) return false;
    const parity = this.readParity(runId);
    if (!parity) throw new Error('SHADOW_PARITY_RUN_NOT_FOUND');
    return this.db.transaction((): boolean => {
      let codes = parseCodes(parity.divergence_codes_json);
      let identityState = parity.identity_state;
      let authorshipState = parity.authorship_state;
      let orderState = parity.order_state;
      let legacyAcceptOutcome = parity.legacy_accept_outcome;
      let legacyTerminalOutcome = parity.legacy_terminal_outcome;
      let contentIntegrityState = parity.content_integrity_state;
      let observedLegacyRefDigest = parity.observed_legacy_ref_digest;
      const isTerminal = envelope.kind === 'complete' || envelope.kind === 'error';
      const generationTerminalBefore = Boolean(this.db
        .prepare(
          `SELECT 1 FROM conversation_shadow_observations
            WHERE run_id = ? AND dispatch_generation = ? AND terminal = 1 LIMIT 1`,
        )
        .get(runId, dispatchGeneration));
      const isFirstGenerationTerminal = isTerminal && !generationTerminalBefore;
      const isFirstRunTerminal = isFirstGenerationTerminal && parity.terminal_observed !== 1;
      const legacyRefDigest = envelope.sessionId
        ? this.protectLegacyRef(
          parity.requested_provider,
          envelope.sessionId,
          parity.reference_key_version,
        )
        : null;
      const providerMatches = envelope.provider === null
        ? null
        : envelope.provider === parity.requested_provider;
      const clientMsgIdMatches = envelope.clientMsgId === null
        ? null
        : envelope.clientMsgId === parity.client_msg_id;
      const envelopeDigest = digest([
        'legacy-envelope-v2',
        JSON.stringify({
          kind: envelope.kind,
          providerMatches,
          clientMsgIdMatches,
          legacyRefDigest,
          success: envelope.success,
          exitCode: envelope.exitCode,
          notStarted: envelope.notStarted,
          invalidProviderClaim: envelope.invalidProviderClaim,
          invalidClientMsgIdClaim: envelope.invalidClientMsgIdClaim,
          invalidSessionRef: envelope.invalidSessionRef,
          conflictingSessionRefs: envelope.conflictingSessionRefs,
          invalidSuccessClaim: envelope.invalidSuccessClaim,
          invalidExitCodeClaim: envelope.invalidExitCodeClaim,
          invalidNotStartedClaim: envelope.invalidNotStartedClaim,
          terminalControlDigest: envelope.terminalControlDigest,
          invalidTerminalControlClaim: envelope.invalidTerminalControlClaim,
        }),
      ]);
      if (envelope.invalidProviderClaim) codes = withCode(codes, 'INVALID_LEGACY_PROVIDER_CLAIM');
      if (envelope.invalidClientMsgIdClaim) {
        codes = withCode(codes, 'INVALID_LEGACY_CLIENT_MSG_ID_CLAIM');
      }
      if (envelope.invalidSessionRef) codes = withCode(codes, 'INVALID_LEGACY_SESSION_REF');
      if (envelope.conflictingSessionRefs) {
        codes = withCode(codes, 'INVALID_LEGACY_SESSION_CONTROL_CLAIM');
      }
      if (envelope.invalidSuccessClaim) codes = withCode(codes, 'INVALID_LEGACY_SUCCESS_CLAIM');
      if (envelope.invalidExitCodeClaim) codes = withCode(codes, 'INVALID_LEGACY_EXIT_CODE');
      if (envelope.invalidNotStartedClaim) {
        codes = withCode(codes, 'INVALID_LEGACY_NOT_STARTED_CLAIM');
      }
      if (
        envelope.invalidProviderClaim
        || envelope.invalidClientMsgIdClaim
        || envelope.invalidSessionRef
        || envelope.conflictingSessionRefs
      ) {
        identityState = 'diverged';
      }
      let verificationState: 'pending' | 'verified' | 'rejected' | 'unavailable' = 'unavailable';
      if (envelope.kind === 'session_created' && envelope.sessionId && legacyRefDigest) {
        const attested = Boolean(
          authorization.kind === 'resume'
          && authorization.legacySessionId === envelope.sessionId
          && attestation
          && trustedAttestations.has(attestation)
          && attestation.authorizationId === authorization.authorizationId
          && attestation.principalId === authorization.principalId
          && attestation.clientMsgId === authorization.clientMsgId
          && attestation.projectId === authorization.projectId
          && attestation.provider === parity.requested_provider
          && attestation.legacySessionId === envelope.sessionId,
        );
        verificationState = attested ? 'verified' : attestation ? 'rejected' : 'pending';
        if (!attested) codes = withCode(codes, 'SESSION_CREATED_UNVERIFIED');
      }
      const sessionCreatedBefore = Boolean(this.db
        .prepare(
          `SELECT 1 FROM conversation_shadow_observations
            WHERE run_id = ? AND dispatch_generation = ?
              AND legacy_kind = 'session_created' LIMIT 1`,
        )
        .get(runId, dispatchGeneration));
      const priorSameVerdict = this.db
        .prepare(
          `SELECT verification_state FROM conversation_shadow_observations
            WHERE run_id = ? AND legacy_kind = ? AND envelope_digest = ?
              AND dispatch_generation = ?
            ORDER BY observation_seq DESC LIMIT 1`,
        )
        .get(runId, envelope.kind, envelopeDigest, dispatchGeneration) as
        | { verification_state: 'pending' | 'verified' | 'rejected' | 'unavailable' }
        | undefined;
      const isIdempotentVerdictReplay = Boolean(
        priorSameVerdict
        && !envelope.invalidTerminalControlClaim
        && (
          envelope.kind !== 'session_created'
          || priorSameVerdict.verification_state === 'verified'
          || priorSameVerdict.verification_state === verificationState
        ),
      );
      // Verdict replays are idempotent only inside the same provider dispatch.
      // Stream chunks never reach this durable path.
      if (isIdempotentVerdictReplay) {
        this.db
          .prepare(
            `UPDATE conversation_shadow_parity
                SET duplicate_count = duplicate_count + 1,
                    updated_at = CURRENT_TIMESTAMP
              WHERE run_id = ?`,
          )
          .run(runId);
        return isTerminal;
      }

      if (generationTerminalBefore) {
        orderState = 'diverged';
        codes = withCode(codes, 'LEGACY_EVENT_AFTER_TERMINAL');
      }

      if (providerMatches === false) {
        codes = withCode(codes, 'PROVIDER_MISMATCH');
        identityState = 'diverged';
      }
      if (clientMsgIdMatches === false) {
        codes = withCode(codes, 'CLIENT_MSG_ID_MISMATCH');
        identityState = 'diverged';
      }

      if (legacyRefDigest) {
        if (
          parity.observed_legacy_ref_digest
          && parity.observed_legacy_ref_digest !== legacyRefDigest
        ) {
          identityState = 'diverged';
          codes = withCode(codes, 'LEGACY_SESSION_CHANGED');
        }
        observedLegacyRefDigest = observedLegacyRefDigest ?? legacyRefDigest;
        const expected = parity.expected_legacy_ref_digest;
        if (expected && expected !== legacyRefDigest) {
          identityState = 'diverged';
          codes = withCode(codes, 'LEGACY_SESSION_ID_MISMATCH');
        } else if (verificationState === 'verified' && identityState !== 'diverged') {
          identityState = 'match';
        }
      }

      if (
        envelope.kind === 'session_created'
        && parity.expected_legacy_ref_digest === null
        && observation.contentSeenBefore
      ) {
        orderState = 'diverged';
        codes = withCode(codes, 'LEGACY_ACCEPT_AFTER_OUTPUT');
      }

      if (envelope.kind === 'session_created') legacyAcceptOutcome = 'accepted';
      const terminalSignals = terminalOutcomeFromEnvelope(envelope);
      const generationTerminalOutcome = terminalSignals.outcome;
      if (terminalSignals.signalConflict) {
        codes = withCode(codes, 'LEGACY_TERMINAL_SIGNAL_CONFLICT');
      }
      if (observation.terminalControlConflict) {
        orderState = 'diverged';
        if (envelope.kind === 'session_created') {
          identityState = 'diverged';
          codes = withCode(codes, 'LEGACY_SESSION_CONTROL_CHANGED');
        } else {
          codes = withCode(codes, 'LEGACY_TERMINAL_CONTROL_CHANGED');
        }
      }
      let contentSummary: ShadowContentIntegritySummary | null = null;
      if (isFirstGenerationTerminal && accumulator) {
        contentSummary = accumulator.finalize(generationTerminalOutcome);
        for (const code of contentSummary.codes) codes = withCode(codes, code);
        contentIntegrityState = mergeContentIntegrityState(
          contentIntegrityState,
          contentSummary.integrityState,
        );
        if (
          observation.contentBeforeSessionCreated
          && parity.expected_legacy_ref_digest === null
          && !sessionCreatedBefore
        ) {
          orderState = 'diverged';
          codes = withCode(codes, 'LEGACY_OUTPUT_BEFORE_SESSION_CREATED');
        }
      }
      if (isFirstRunTerminal) {
        legacyAcceptOutcome = envelope.notStarted ? 'rejected' : 'accepted';
        legacyTerminalOutcome = generationTerminalOutcome;
        if (identityState === 'pending') identityState = 'unknown';
        if (authorshipState === 'pending') authorshipState = 'unknown';
        if (orderState === 'pending') {
          orderState = parity.expected_legacy_ref_digest !== null || sessionCreatedBefore
            ? 'match'
            : 'unknown';
        }
        if (envelope.notStarted) codes = withCode(codes, 'LEGACY_REJECTED_SHADOW_ACCEPTED');
      }

      const nextSequence = parity.last_observation_seq + 1;
      this.db
        .prepare(
          `INSERT INTO conversation_shadow_observations
            (observation_id, run_id, conversation_id, observation_seq, legacy_kind,
             reference_key_version, legacy_ref_digest, verification_state,
             envelope_digest, dispatch_generation, terminal, writer_epoch)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ownedId('observation', [runId, String(nextSequence)]),
          runId,
          parity.conversation_id,
          nextSequence,
          envelope.kind,
          parity.reference_key_version,
          legacyRefDigest,
          verificationState,
          envelopeDigest,
          dispatchGeneration,
          isTerminal ? 1 : 0,
          parity.writer_epoch,
        );
      if (contentSummary) {
        this.recordContentSummary({
          runId,
          conversationId: parity.conversation_id,
          dispatchGeneration,
          referenceKeyVersion: parity.reference_key_version,
          terminalOutcome: generationTerminalOutcome,
          writerEpoch: parity.writer_epoch,
          summary: contentSummary,
        });
      }
      const parityUpdate = this.db
        .prepare(
          `UPDATE conversation_shadow_parity
              SET observed_legacy_ref_digest = ?, identity_state = ?, authorship_state = ?,
                  order_state = ?, legacy_accept_outcome = ?, legacy_terminal_outcome = ?,
                  content_integrity_state = ?,
                  last_observation_seq = ?,
                  terminal_observed = CASE WHEN ? THEN 1 ELSE terminal_observed END,
                  divergence_codes_json = ?, updated_at = CURRENT_TIMESTAMP
            WHERE run_id = ? AND last_observation_seq = ?`,
        )
        .run(
          observedLegacyRefDigest,
          identityState,
          authorshipState,
          orderState,
          legacyAcceptOutcome,
          legacyTerminalOutcome,
          contentIntegrityState,
          nextSequence,
          isFirstRunTerminal ? 1 : 0,
          JSON.stringify(codes),
          runId,
          parity.last_observation_seq,
        );
      if (parityUpdate.changes !== 1) throw new Error('SHADOW_PARITY_OBSERVATION_CAS_FAILED');
      if (isFirstRunTerminal) {
        this.settleCommandForTerminal(
          runId,
          parity.conversation_id,
          parity.writer_epoch,
          legacyTerminalOutcome,
        );
      }
      return isTerminal;
    })();
  }

  private recordLegacyFailure(
    runId: string,
    code: string,
    accumulator: ShadowContentIntegrityAccumulator | null,
    dispatchGeneration: number | null,
  ): void {
    this.assertOpen();
    const parity = this.readParity(runId);
    if (!parity) throw new Error('SHADOW_PARITY_RUN_NOT_FOUND');
    this.db.transaction(() => {
      let codes = withCode(parseCodes(parity.divergence_codes_json), code);
      const generationAlreadyTerminal = dispatchGeneration !== null && Boolean(this.db.prepare(
        `SELECT 1 FROM conversation_shadow_observations
          WHERE run_id = ? AND dispatch_generation = ? AND terminal = 1`,
      ).get(runId, dispatchGeneration));
      if (generationAlreadyTerminal) {
        codes = withCode(codes, 'LEGACY_FAILURE_AFTER_TERMINAL');
        this.db.prepare(
          `UPDATE conversation_shadow_parity
              SET order_state = 'diverged', divergence_codes_json = ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE run_id = ?`,
        ).run(JSON.stringify(codes), runId);
        return;
      }

      let contentIntegrityState = parity.content_integrity_state;
      if (accumulator) {
        const summary = accumulator.finalize('unknown');
        for (const summaryCode of summary.codes) codes = withCode(codes, summaryCode);
        contentIntegrityState = mergeContentIntegrityState(
          contentIntegrityState,
          summary.integrityState,
        );
        this.recordContentSummary({
          runId,
          conversationId: parity.conversation_id,
          dispatchGeneration: accumulator.dispatchGeneration,
          referenceKeyVersion: accumulator.referenceKeyVersion,
          terminalOutcome: 'unknown',
          writerEpoch: parity.writer_epoch,
          summary,
        });
      }
      const isFirstRunTerminal = parity.terminal_observed !== 1;
      this.db.prepare(
        `UPDATE conversation_shadow_parity
            SET identity_state = CASE
                  WHEN ? AND identity_state = 'pending' THEN 'unknown' ELSE identity_state END,
                authorship_state = CASE
                  WHEN ? AND authorship_state = 'pending' THEN 'unknown' ELSE authorship_state END,
                order_state = CASE
                  WHEN ? AND order_state = 'pending' THEN 'unknown' ELSE order_state END,
                legacy_accept_outcome = CASE WHEN ? THEN 'unknown' ELSE legacy_accept_outcome END,
                legacy_terminal_outcome = CASE WHEN ? THEN 'unknown' ELSE legacy_terminal_outcome END,
                terminal_observed = CASE WHEN ? THEN 1 ELSE terminal_observed END,
                content_integrity_state = ?, divergence_codes_json = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE run_id = ?`,
      ).run(
        isFirstRunTerminal ? 1 : 0,
        isFirstRunTerminal ? 1 : 0,
        isFirstRunTerminal ? 1 : 0,
        isFirstRunTerminal ? 1 : 0,
        isFirstRunTerminal ? 1 : 0,
        isFirstRunTerminal ? 1 : 0,
        contentIntegrityState,
        JSON.stringify(codes),
        runId,
      );
      if (isFirstRunTerminal) {
        this.settleCommandForTerminal(
          runId,
          parity.conversation_id,
          parity.writer_epoch,
          'unknown',
        );
      }
    })();
  }

  private recordLateContentAfterTerminal(runId: string): void {
    const parity = this.readParity(runId);
    if (!parity) throw new Error('SHADOW_PARITY_RUN_NOT_FOUND');
    const codes = withCode(parseCodes(parity.divergence_codes_json), 'LEGACY_CONTENT_AFTER_TERMINAL');
    this.db.prepare(
      `UPDATE conversation_shadow_parity
          SET order_state = 'diverged', divergence_codes_json = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ?`,
    ).run(JSON.stringify(codes), runId);
  }

  private recordLegacyPayloadAfterFinish(runId: string): void {
    const parity = this.readParity(runId);
    if (!parity) throw new Error('SHADOW_PARITY_RUN_NOT_FOUND');
    const codes = withCode(
      parseCodes(parity.divergence_codes_json),
      'LEGACY_PAYLOAD_AFTER_DISPATCH_FINISH',
    );
    this.db.prepare(
      `UPDATE conversation_shadow_parity
          SET order_state = 'diverged', divergence_codes_json = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ?`,
    ).run(JSON.stringify(codes), runId);
  }

  private markLegacyDispatchStarted(
    commandId: string,
    runId: string,
    conversationId: string,
    writerEpoch: number,
    contentCapacityExceeded: boolean,
  ): number {
    return this.db.transaction(() => {
      const parity = this.readParity(runId);
      if (!parity) throw new Error('SHADOW_PARITY_RUN_NOT_FOUND');
      const redispatched = parity.legacy_dispatch_count >= 1 || parity.terminal_observed === 1;
      let codes = redispatched
        ? withCode(parseCodes(parity.divergence_codes_json), 'LEGACY_REDISPATCH_OF_IDEMPOTENT_RUN')
        : parseCodes(parity.divergence_codes_json);
      if (contentCapacityExceeded) {
        codes = withCode(codes, 'CONTENT_ACCUMULATOR_CAPACITY_EXCEEDED');
      }
      if (parity.legacy_dispatch_count === 0) {
        const firstDispatch = this.db.prepare(
          `UPDATE conversation_commands SET state = 'dispatched', writer_epoch = ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE command_id = ? AND conversation_id = ? AND state = 'prepared'`,
        ).run(writerEpoch, commandId, conversationId);
        if (firstDispatch.changes !== 1) throw new Error('SHADOW_FIRST_DISPATCH_CAS_FAILED');
      } else {
        const commandExists = this.db.prepare(
          `SELECT 1 FROM conversation_commands
            WHERE command_id = ? AND run_id = ? AND conversation_id = ?
              AND operation = 'submit_run'`,
        ).get(commandId, runId, conversationId);
        if (!commandExists) throw new Error('SHADOW_REDISPATCH_COMMAND_NOT_FOUND');
      }
      const result = this.db
        .prepare(
          `UPDATE conversation_shadow_parity
              SET legacy_dispatch_count = legacy_dispatch_count + 1,
                  order_state = CASE WHEN ? THEN 'diverged' ELSE order_state END,
                  content_integrity_state = CASE WHEN ? THEN 'unknown' ELSE content_integrity_state END,
                  divergence_codes_json = ?, writer_epoch = ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE run_id = ? AND conversation_id = ? AND legacy_dispatch_count = ?`,
        )
        .run(
          redispatched ? 1 : 0,
          contentCapacityExceeded ? 1 : 0,
          JSON.stringify(codes),
          writerEpoch,
          runId,
          conversationId,
          parity.legacy_dispatch_count,
        );
      if (result.changes !== 1) throw new Error('SHADOW_DISPATCH_GENERATION_CAS_FAILED');
      return parity.legacy_dispatch_count + 1;
    })();
  }

  private settleCommandForTerminal(
    runId: string,
    conversationId: string,
    writerEpoch: number,
    outcome: ShadowParityRow['legacyTerminalOutcome'],
  ): void {
    const state = outcome === 'unknown' ? 'uncertain' : 'confirmed';
    const commandUpdate = this.db
      .prepare(
        `UPDATE conversation_commands
            SET state = ?, durable_outcome_json = ?, writer_epoch = ?,
                updated_at = CURRENT_TIMESTAMP
          WHERE run_id = ? AND conversation_id = ? AND operation = 'submit_run'
            AND state IN ('prepared', 'dispatched', 'uncertain')`,
      )
      .run(
        state,
        JSON.stringify({ terminalOutcome: outcome }),
        writerEpoch,
        runId,
        conversationId,
      );
    if (commandUpdate.changes !== 1) throw new Error('SHADOW_TERMINAL_COMMAND_CAS_FAILED');
  }

  private readParity(runId: string): StoredParityRow | undefined {
    return this.db
      .prepare(
        `SELECT run_id, conversation_id, principal_id, client_msg_id, requested_provider,
                reference_key_version, expected_legacy_ref_digest, observed_legacy_ref_digest,
                identity_state, authorship_state, order_state, shadow_accept_outcome,
                legacy_accept_outcome, legacy_terminal_outcome, content_integrity_state,
                content_comparison_state,
                divergence_codes_json,
                last_observation_seq, terminal_observed, legacy_dispatch_count,
                duplicate_count, writer_epoch
           FROM conversation_shadow_parity WHERE run_id = ?`,
      )
      .get(runId) as StoredParityRow | undefined;
  }

  private mapParity(row: StoredParityRow): ShadowParityRow {
    return {
      runId: row.run_id,
      conversationId: row.conversation_id,
      principalId: row.principal_id,
      clientMsgId: row.client_msg_id,
      requestedProvider: row.requested_provider,
      expectedLegacyRefDigest: row.expected_legacy_ref_digest,
      observedLegacyRefDigest: row.observed_legacy_ref_digest,
      identityState: row.identity_state,
      authorshipState: row.authorship_state,
      orderState: row.order_state,
      shadowAcceptOutcome: row.shadow_accept_outcome,
      legacyAcceptOutcome: row.legacy_accept_outcome,
      legacyTerminalOutcome: row.legacy_terminal_outcome,
      contentIntegrityState: row.content_integrity_state,
      contentComparisonState: row.content_comparison_state,
      divergenceCodes: parseCodes(row.divergence_codes_json),
      legacyDispatchCount: row.legacy_dispatch_count,
      duplicateCount: row.duplicate_count,
      lastObservationSeq: row.last_observation_seq,
      terminalObserved: row.terminal_observed === 1,
    };
  }
}

let singletonRuntime: UniversalConversationShadowRuntime | null = null;
let facadeRuntime: UniversalConversationShadowRuntime | null = null;
let facadeClosed = false;

/** Idempotent production bootstrap called after the legacy schema/migrations. */
export function initializeUniversalConversationShadowRuntime(
  db: Database.Database,
  options: UniversalConversationShadowRuntimeOptions,
): UniversalConversationShadowRuntime | null {
  const enabled = (options.env ?? process.env)[UNIVERSAL_CONVERSATION_SHADOW_FLAG] === '1';
  if (!enabled) return null;
  if (facadeClosed) {
    throw new Error('UNIVERSAL_CONVERSATION_SHADOW_FACADE_CLOSED');
  }
  if (singletonRuntime) {
    if (!singletonRuntime.matchesBootstrapTarget(db, options)) {
      throw new Error('UNIVERSAL_CONVERSATION_SINGLETON_TARGET_MISMATCH');
    }
    return singletonRuntime;
  }
  singletonRuntime = UniversalConversationShadowRuntime.boot(db, options);
  if (facadeRuntime && facadeRuntime !== singletonRuntime) {
    singletonRuntime?.close();
    singletonRuntime = null;
    throw new Error('UNIVERSAL_CONVERSATION_SHADOW_FACADE_REBIND');
  }
  facadeRuntime = singletonRuntime;
  return singletonRuntime;
}

export function getUniversalConversationShadowRuntime(): UniversalConversationShadowRuntime | null {
  return singletonRuntime;
}

export function closeUniversalConversationShadowRuntime(): void {
  const runtime = singletonRuntime;
  singletonRuntime = null;
  if (runtime) {
    facadeRuntime = null;
    facadeClosed = true;
    runtime.close();
  }
}

/**
 * Stable bind-once injectable façade. It is inert before boot and permanently
 * closed after its bound runtime closes; it never follows a replacement global.
 */
export const universalConversationShadowHook: UniversalConversationShadowHook = {
  isEnabled: () => Boolean(facadeRuntime?.isEnabled()),
  beginLegacyTurn: (input) => facadeRuntime?.beginLegacyTurn(input) ?? null,
  recordHookFailure: (input) => facadeRuntime?.recordHookFailure(input),
};
