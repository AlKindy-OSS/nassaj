import type { Database } from 'better-sqlite3';

import {
  blockPermissionGeneration,
  type PermissionChildIdentity,
  claimPermissionLease,
  createPermissionAdmission,
  digestPermissionWorkspace,
  markPermissionEffectStarted,
  attachPermissionEffectChild,
  PermissionStateConflictError,
  readPermissionRolloutState,
  recordPermissionDenial,
  settlePermissionEffect,
  settlePermissionNotStarted,
  type PermissionTerminalOutcome,
  deviceAccountSessionsDb,
} from '@/modules/database/index.js';

import type { AuthenticatedLaunchActor } from './actor.js';
import {
  computePermissionReleaseCapabilityDigest,
  PERMISSION_CAPABILITY_ARTIFACT_DIGEST,
} from './capability-registry.js';
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
  consume(): LaunchPermitBinding;
  markStarted(child?: PermissionChildIdentity): void;
  attachChildIdentity(child: PermissionChildIdentity): void;
  settle(outcome: PermissionTerminalOutcome): void;
  notStarted(): void;
}>;

export type PermissionGatewayResult =
  | Readonly<{ kind: 'authorized'; execution: PermissionExecutionHandle }>
  | Readonly<{ kind: 'denied'; decisionId: string; reasonCodes: readonly string[] }>;

type GatewayDependencies = Readonly<{
  database: Database;
  authority: SealedPermissionPolicy;
  reference: ClaudeReferenceVector;
  candidateFor(context: CanonicalLaunchContext): PermissionCandidateVector | null;
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

/** Creates the local ADR-134 gateway. It performs no provider effect itself. */
export const createExecutionPermissionGateway = (dependencies: GatewayDependencies) => {
  const assertActorCurrent = (actor: AuthenticatedLaunchActor): void => {
    const userCurrent = dependencies.database.prepare(`SELECT 1 FROM users
      WHERE id = ? AND authorization_generation = ?
        AND is_active = 1 AND status = 'active'`).get(actor.userId, actor.authorizationGeneration);
    if (!userCurrent) throw new PermissionStateConflictError('IDENTITY_STALE');
    if (actor.authenticationKind === 'ck') {
      const match = /^api-key:(\d+)$/u.exec(actor.authenticationCredentialId ?? '');
      const keyCurrent = match && dependencies.database.prepare(`SELECT 1 FROM api_keys
        WHERE id = ? AND user_id = ? AND is_active = 1`).get(Number(match[1]), actor.userId);
      if (!keyCurrent) throw new PermissionStateConflictError('IDENTITY_STALE');
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
    const candidate = dependencies.candidateFor(context);
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
    const markStarted = (child?: PermissionChildIdentity): void => {
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
    const notStarted = (): void => {
      if (consumed || settled) throw new PermissionStateConflictError('DECISION_NOT_SETTLEABLE');
      settlePermissionNotStarted(dependencies.database, decisionId, dependencies.nowMs());
      settled = true;
    };
    return Object.freeze({
      kind: 'authorized',
      execution: Object.freeze({
        decisionId,
        leaseId,
        mode: rollout.profile,
        effectivePolicy: policy.kind === 'resolved' ? policy.policy : null,
        consume,
        markStarted,
        attachChildIdentity,
        settle,
        notStarted,
      }),
    });
  };
  return Object.freeze({ authorize });
};
