import type { Database } from 'better-sqlite3';

import {
  blockPermissionGeneration,
  type PermissionChildIdentity,
  claimPermissionLease,
  createPermissionAdmission,
  digestPermissionWorkspace,
  markPermissionEffectStarted,
  attachPermissionEffectChild,
  bindPermissionDecisionSession,
  PermissionStateConflictError,
  readPermissionRolloutState,
  recordPermissionDenial,
  settlePermissionEffect,
  settlePermissionNotStarted,
  type PermissionTerminalOutcome,
  deviceAccountSessionsDb,
  apiKeyCredentialState,
  parseApiKeyCredentialId,
} from '@/modules/database/index.js';

import type { AuthenticatedLaunchActor } from './actor.js';
import {
  computePermissionReleaseCapabilityDigest,
  PERMISSION_CAPABILITY_ARTIFACT_DIGEST,
} from './capability-registry.js';
import { isInProcessReadCapability } from './in-process-read-capability.js';
import { evaluateParity } from './parity.js';
import { createLaunchPermitBroker, type LaunchPermitBinding } from './permit.js';
import { resolveEffectivePolicy } from './policy.js';
import type {
  CanonicalLaunchContext,
  ClaudeReferenceVector,
  PermissionCandidateVector,
  EffectivePolicy,
  SealedPermissionPolicy,
} from './types.js';

export type PermissionExecutionHandle = Readonly<{
  decisionId: string;
  leaseId: string;
  mode: 'legacy' | 'shadow' | 'enforce';
  effectivePolicy: EffectivePolicy | null;
  /**
   * T-1872: the frozen harness identity this decision was fingerprinted against
   * (Codex: the machine release). The launch executes exactly this object.
   */
  launchIdentity: PermissionLaunchIdentity | null;
  /**
   * Why the gateway could not acquire that identity (e.g. CODEX_MACHINE_CLI_MISSING).
   * A launch site holding this handle rethrows it; it never re-acquires.
   */
  launchIdentityError: Error | null;
  consume(): LaunchPermitBinding;
  markStarted(child?: PermissionChildIdentity): void;
  /**
   * T-1910: start a local-footprint effect carried by this server process itself. Requires
   * the in-process read capability; records the owner identity as the child atomically.
   */
  markStartedInProcessRead(capability: unknown): void;
  attachChildIdentity(child: PermissionChildIdentity): void;
  /**
   * T-1910 S2: one-shot bind of a new-chat sdk_turn decision to its provider session. Until it
   * commits, the decision fences user-wide on death, so callers refuse tools before it.
   */
  bindSession(sessionId: string): void;
  /** True once the decision names a session: admitted with one, or after `bindSession` committed. */
  isSessionBound(): boolean;
  settle(outcome: PermissionTerminalOutcome): void;
  notStarted(): void;
}>;

/** Opaque frozen per-launch harness identity (see server/shared/codex-executable.js). */
export type PermissionLaunchIdentity = Readonly<Record<string, unknown>>;

/** Reason code for a failed identity acquisition: the error's own code, else a generic one. */
const launchIdentityReasonCode = (error: Error): string => {
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(code) ? code : 'LAUNCH_IDENTITY_UNAVAILABLE';
};

export type PermissionGatewayResult =
  | Readonly<{ kind: 'authorized'; execution: PermissionExecutionHandle }>
  | Readonly<{ kind: 'denied'; decisionId: string; reasonCodes: readonly string[] }>;

type GatewayDependencies = Readonly<{
  database: Database;
  authority: SealedPermissionPolicy;
  reference: ClaudeReferenceVector;
  candidateFor(
    context: CanonicalLaunchContext,
    launchIdentity: PermissionLaunchIdentity | null,
  ): PermissionCandidateVector | null;
  /** Acquire the per-launch harness identity once; null when the body has none. */
  acquireLaunchIdentity?(context: CanonicalLaunchContext): PermissionLaunchIdentity | null;
  capabilityArtifactDigest: string;
  releaseBuild: string;
  manifestDigest: string | null;
  processIdentity: Readonly<{
    ownerId: string;
    ownerPid: number;
    ownerBootId: string;
    ownerStartTicks: string;
  }>;
  randomId(): string;
  nowMs(): number;
  leaseTtlMs?: number;
  isDevicePrincipalCurrent?: (principal: {
    deviceSessionId: string;
    slotId: string;
    generation: number;
    userId: number;
    authorizationGeneration: number;
  }) => boolean;
}>;

const broker = createLaunchPermitBroker();

/** T-1910: every handle this module minted; the in-process capability goes to no other object. */
const issuedExecutions = new WeakSet<object>();

/** True only for an execution handle minted by a gateway in this module (not a look-alike). */
export const isGatewayIssuedExecution = (value: unknown): value is PermissionExecutionHandle =>
  typeof value === 'object' && value !== null && issuedExecutions.has(value);

/** Creates the local ADR-134 gateway. It performs no provider effect itself. */
export const createExecutionPermissionGateway = (dependencies: GatewayDependencies) => {
  const assertActorCurrent = (actor: AuthenticatedLaunchActor): void => {
    const userCurrent = dependencies.database.prepare(`SELECT 1 FROM users
      WHERE id = ? AND authorization_generation = ?
        AND is_active = 1 AND status = 'active'`).get(actor.userId, actor.authorizationGeneration);
    if (!userCurrent) throw new PermissionStateConflictError('IDENTITY_STALE');
    if (actor.authenticationKind === 'ck') {
      // T-1946: the same key predicate as authentication, SSO window included.
      const apiKeyId = parseApiKeyCredentialId(actor.authenticationCredentialId);
      if (apiKeyId === null || apiKeyCredentialState(dependencies.database, {
        apiKeyId, userId: actor.userId, nowMs: dependencies.nowMs(),
      }) !== 'current') {
        throw new PermissionStateConflictError('IDENTITY_STALE');
      }
    }
    if (!actor.deviceSessionId) {
      return;
    }
    const isCurrent = dependencies.isDevicePrincipalCurrent
      ?? ((principal) => deviceAccountSessionsDb.isPrincipalCurrent(principal));
    if (!actor.slotId || !actor.deviceGeneration
        || isCurrent({
          deviceSessionId: actor.deviceSessionId,
          slotId: actor.slotId,
          generation: actor.deviceGeneration,
          userId: actor.userId,
          authorizationGeneration: actor.authorizationGeneration,
        }) !== true) {
      throw new PermissionStateConflictError('DEVICE_IDENTITY_STALE');
    }
  };
  const authorize = (
    actor: AuthenticatedLaunchActor,
    context: CanonicalLaunchContext,
    requestedProfile: 'full_delegation',
  ): PermissionGatewayResult => {
    assertActorCurrent(actor);
    const decisionId = dependencies.randomId();
    const leaseId = dependencies.randomId();
    const nowMs = dependencies.nowMs();
    const rollout = readPermissionRolloutState(dependencies.database);
    if (rollout.profile !== 'legacy' && (
      rollout.manifestDigest !== dependencies.manifestDigest
      || rollout.contractVersion !== dependencies.authority.contractVersion
      || rollout.profileDigest !== dependencies.authority.profileDigest
      || rollout.capabilityDigest !== dependencies.authority.capabilityDigest
    )) {
      throw new PermissionStateConflictError('ROLLOUT_RELEASE_IDENTITY_MISMATCH');
    }
    let launchIdentity: PermissionLaunchIdentity | null = null;
    let launchIdentityError: Error | null = null;
    try {
      launchIdentity = dependencies.acquireLaunchIdentity?.(context) ?? null;
    } catch (error) {
      // An unresolvable harness yields no candidate (fail closed under enforce).
      // The cause rides on the handle so the launch refuses with it instead of
      // acquiring an identity this decision never fingerprinted.
      launchIdentityError = error instanceof Error ? error : new Error(String(error));
    }
    const candidate = dependencies.candidateFor(context, launchIdentity);
    const policy = resolveEffectivePolicy({
      context,
      requestedProfile,
      authority: dependencies.authority,
      reference: dependencies.reference,
    });
    const parity = evaluateParity(dependencies.reference, candidate);
    const reasonCodes: string[] = [
      ...(policy.kind === 'resolved' ? [] : policy.reasonCodes),
      ...(parity.kind === 'parity' ? [] : parity.reasonCodes),
      ...(launchIdentityError ? [launchIdentityReasonCode(launchIdentityError)] : []),
    ];
    const expectedCapabilitySeal = computePermissionReleaseCapabilityDigest(
      dependencies.releaseBuild,
      dependencies.authority.profileDigest,
      dependencies.authority.protocolGeneration,
    );
    if (dependencies.capabilityArtifactDigest !== PERMISSION_CAPABILITY_ARTIFACT_DIGEST
      || dependencies.authority.capabilityDigest !== expectedCapabilitySeal) {
      reasonCodes.push('CAPABILITY_ARTIFACT_MISMATCH');
    }
    const base = {
      decisionId,
      userId: actor.userId,
      principalId: actor.principalId,
      authenticationKind: actor.authenticationKind,
      authorizationGeneration: actor.authorizationGeneration,
      ...(actor.deviceSessionId ? {
        deviceSessionId: actor.deviceSessionId,
        slotId: actor.slotId,
        deviceGeneration: actor.deviceGeneration,
      } : {}),
      authenticationCredentialId: actor.authenticationCredentialId,
      launchId: context.launchId,
      sessionId: context.sessionId ?? undefined,
      projectId: context.projectId,
      workspaceDigest: digestPermissionWorkspace(context.workspacePath),
      provider: context.provider,
      body: context.body,
      engine: context.engine,
      entrypoint: context.entrypoint,
      purpose: context.purpose,
      effectFootprint: context.effectFootprint ?? 'external',
      requestedProfile,
      contractVersion: dependencies.authority.contractVersion,
      profileDigest: dependencies.authority.profileDigest,
      capabilityDigest: dependencies.authority.capabilityDigest,
      releaseBuild: dependencies.releaseBuild,
      protocolGeneration: rollout.generation,
      nowMs,
    } as const;

    if (dependencies.authority.protocolGeneration !== rollout.generation) {
      reasonCodes.push('PROTOCOL_GENERATION_MISMATCH');
    }
    const forbiddenPurpose = context.purpose === 'mcp'
      || context.purpose === 'delegation'
      || context.purpose === 'external_agent_dispatch';
    if (forbiddenPurpose) {
      reasonCodes.push(`FORBIDDEN_PURPOSE_${context.purpose.toUpperCase()}`);
    }
    if (rollout.profile === 'enforce' && forbiddenPurpose) {
      recordPermissionDenial(dependencies.database, { ...base, reasonCodes });
      return Object.freeze({
        kind: 'denied',
        decisionId,
        reasonCodes: Object.freeze([...new Set(reasonCodes)]),
      });
    }
    if (rollout.profile === 'enforce' && (policy.kind !== 'resolved' || parity.kind !== 'parity'
      || reasonCodes.length > 0)) {
      recordPermissionDenial(dependencies.database, { ...base, reasonCodes });
      return Object.freeze({
        kind: 'denied',
        decisionId,
        reasonCodes: Object.freeze([...new Set(reasonCodes)]),
      });
    }

    const expiresAtMs = nowMs + (dependencies.leaseTtlMs ?? 30_000);
    const effectIdentity = `permission-effect:${decisionId}`;
    createPermissionAdmission(dependencies.database, {
      ...base,
      leaseId,
      ...dependencies.processIdentity,
      expiresAtMs,
      effectIdentity,
      reasonCodes: rollout.profile === 'shadow'
        ? Object.freeze([...new Set(reasonCodes)])
        : undefined,
    });
    const binding: LaunchPermitBinding = Object.freeze({
      decisionId,
      leaseId,
      userId: actor.userId,
      authorizationGeneration: actor.authorizationGeneration,
      ...(actor.deviceSessionId ? {
        deviceSessionId: actor.deviceSessionId,
        slotId: actor.slotId,
        deviceGeneration: actor.deviceGeneration,
      } : {}),
      provider: context.provider,
      body: context.body,
      engine: context.engine,
      entrypoint: context.entrypoint,
      purpose: context.purpose,
      launchId: context.launchId,
      sessionId: context.sessionId,
      workspaceDigest: base.workspaceDigest,
      contractVersion: dependencies.authority.contractVersion,
      profileDigest: dependencies.authority.profileDigest,
      capabilityDigest: dependencies.authority.capabilityDigest,
      protocolGeneration: rollout.generation,
      expiresAtMs,
    });
    const permit = broker.issuer.issue(binding);
    let consumed = false;
    let decisionRevision = 1;
    let started = false;
    let settled = false;
    const consume = (): LaunchPermitBinding => {
      if (consumed) throw new PermissionStateConflictError('PERMIT_REPLAYED');
      assertActorCurrent(actor);
      consumed = true;
      const expectation = {
        userId: binding.userId,
        authorizationGeneration: binding.authorizationGeneration,
        ...(binding.deviceSessionId ? {
          deviceSessionId: binding.deviceSessionId,
          slotId: binding.slotId,
          deviceGeneration: binding.deviceGeneration,
        } : {}),
        provider: binding.provider,
        body: binding.body,
        engine: binding.engine,
        entrypoint: binding.entrypoint,
        purpose: binding.purpose,
        launchId: binding.launchId,
        sessionId: binding.sessionId,
        workspaceDigest: binding.workspaceDigest,
        contractVersion: binding.contractVersion,
        profileDigest: binding.profileDigest,
        capabilityDigest: binding.capabilityDigest,
        protocolGeneration: binding.protocolGeneration,
      } as const;
      const consumedBinding = broker.consumer.consume(permit, expectation, dependencies.nowMs());
      claimPermissionLease(dependencies.database, leaseId, 1, dependencies.nowMs());
      decisionRevision = 2;
      return consumedBinding;
    };
    const ownerAsChild: PermissionChildIdentity = Object.freeze({
      pid: dependencies.processIdentity.ownerPid,
      bootId: dependencies.processIdentity.ownerBootId,
      startTicks: dependencies.processIdentity.ownerStartTicks,
    });
    // T-1910: a child equal to this server is an in-process effect; only the capability
    // holder may claim it. Refused before any write, so a misuse never blocks the generation.
    const assertNotSelf = (child: PermissionChildIdentity | undefined): void => {
      if (child && child.pid === ownerAsChild.pid && child.bootId === ownerAsChild.bootId
        && child.startTicks === ownerAsChild.startTicks) {
        throw new PermissionStateConflictError('SELF_EFFECT_CAPABILITY_REQUIRED');
      }
    };
    const recordStart = (child: PermissionChildIdentity | undefined, selfEffect: boolean): void => {
      if (!consumed || started || settled) {
        throw new PermissionStateConflictError('DECISION_NOT_STARTABLE');
      }
      assertActorCurrent(actor);
      try {
        decisionRevision = markPermissionEffectStarted(
          dependencies.database,
          decisionId,
          decisionRevision,
          dependencies.nowMs(),
          child,
          { selfEffect },
        );
        started = true;
      } catch (error) {
        blockPermissionGeneration(dependencies.database, {
          protocolGeneration: rollout.generation,
          reasonCode: 'START_EVIDENCE_WRITE_FAILED',
          decisionId,
          effectIdentity,
          nowMs: dependencies.nowMs(),
        });
        throw error;
      }
    };
    const markStarted = (child?: PermissionChildIdentity): void => {
      assertNotSelf(child);
      recordStart(child, false);
    };
    const markStartedInProcessRead = (capability: unknown): void => {
      if (!isInProcessReadCapability(capability)) {
        throw new PermissionStateConflictError('SELF_EFFECT_CAPABILITY_REQUIRED');
      }
      if (base.effectFootprint !== 'local') {
        throw new PermissionStateConflictError('IN_PROCESS_READ_FOOTPRINT_REQUIRED');
      }
      recordStart(ownerAsChild, true);
    };
    const settle = (outcome: PermissionTerminalOutcome): void => {
      if (!consumed || settled) throw new PermissionStateConflictError('DECISION_NOT_SETTLEABLE');
      try {
        settlePermissionEffect(
          dependencies.database,
          decisionId,
          outcome,
          decisionRevision,
          dependencies.nowMs(),
        );
        settled = true;
        // T-1593: a reconciled_unknown settlement fences its own scope inside
        // settlePermissionEffect; only evidence-store failures below fence the generation.
      } catch (error) {
        blockPermissionGeneration(dependencies.database, {
          protocolGeneration: rollout.generation,
          reasonCode: 'TERMINAL_SETTLEMENT_FAILED',
          decisionId,
          effectIdentity,
          nowMs: dependencies.nowMs(),
        });
        throw error;
      }
    };
    const attachChildIdentity = (child: PermissionChildIdentity): void => {
      if (!started || settled) throw new PermissionStateConflictError('CHILD_IDENTITY_NOT_RECORDABLE');
      assertNotSelf(child);
      try {
        attachPermissionEffectChild(dependencies.database, decisionId, child, dependencies.nowMs());
      } catch (error) {
        blockPermissionGeneration(dependencies.database, {
          protocolGeneration: rollout.generation,
          reasonCode: 'START_EVIDENCE_WRITE_FAILED',
          decisionId,
          effectIdentity,
          nowMs: dependencies.nowMs(),
        });
        throw error;
      }
    };
    let boundSessionId: string | null = context.sessionId ?? null;
    const bindSession = (sessionId: string): void => {
      if (settled) throw new PermissionStateConflictError('DECISION_NOT_BINDABLE');
      if (boundSessionId !== null) throw new PermissionStateConflictError('SESSION_ALREADY_BOUND');
      bindPermissionDecisionSession(dependencies.database, decisionId, sessionId, dependencies.nowMs());
      // Set only after the CAS committed: the tool gate reads this flag.
      boundSessionId = sessionId;
    };
    const isSessionBound = (): boolean => boundSessionId !== null;
    const notStarted = (): void => {
      if (consumed || settled) throw new PermissionStateConflictError('DECISION_NOT_SETTLEABLE');
      settlePermissionNotStarted(dependencies.database, decisionId, dependencies.nowMs());
      settled = true;
    };
    const execution: PermissionExecutionHandle = Object.freeze({
      decisionId,
      leaseId,
      mode: rollout.profile,
      effectivePolicy: policy.kind === 'resolved' ? policy.policy : null,
      launchIdentity,
      launchIdentityError,
      consume,
      markStarted,
      markStartedInProcessRead,
      attachChildIdentity,
      bindSession,
      isSessionBound,
      settle,
      notStarted,
    });
    issuedExecutions.add(execution);
    return Object.freeze({ kind: 'authorized', execution });
  };
  return Object.freeze({ authorize });
};
