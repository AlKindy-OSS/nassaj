/** Durable CAS repository for ADR-134 permission decisions and leases. */

import crypto from 'node:crypto';

import type { Database } from 'better-sqlite3';

export type PermissionPurpose =
  | 'spawn'
  | 'sdk_thread'
  | 'sdk_turn'
  | 'catalog'
  | 'quota'
  | 'balance'
  | 'mcp'
  | 'delegation'
  | 'external_agent_dispatch';

export type PermissionTerminalOutcome =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'spawn_failed'
  | 'revoked'
  | 'not_started'
  | 'reconciled_unknown';

/** Where a permitted effect can reach: a local child process, or a provider that outlives the host. */
export type PermissionEffectFootprint = 'local' | 'external';

/** Exact kernel identity of the child process that carries a local effect. */
export type PermissionChildIdentity = Readonly<{ pid: number; bootId: string; startTicks: string }>;

export type PermissionEffectFenceScope = Readonly<{
  scopeKind: 'session' | 'user_provider_purpose';
  scopeKey: string;
}>;

/** Scope key for effects that carry no session: one user, one provider, one purpose. */
export const permissionUserProviderPurposeKey = (
  userId: number, provider: string, purpose: string,
): string => {
  if (!Number.isSafeInteger(userId) || userId <= 0
    || !/^[A-Za-z0-9._-]{1,128}$/.test(provider)
    || !/^[A-Za-z0-9._-]{1,128}$/.test(purpose)) {
    throw new PermissionStateConflictError('INVALID_EFFECT_SCOPE');
  }
  return `${userId}:${provider}:${purpose}`;
};

export type PermissionRolloutProfile = 'legacy' | 'shadow' | 'enforce';
export type PermissionRolloutState = Readonly<{
  profile: PermissionRolloutProfile;
  generation: number;
  manifestDigest: string | null;
  contractVersion: string | null;
  profileDigest: string | null;
  capabilityDigest: string | null;
}>;

export type CreatePermissionAdmission = Readonly<{
  decisionId: string;
  leaseId: string;
  userId: number;
  principalId: string;
  authenticationKind: 'session' | 'ck' | 'verified_proxy' | 'internal_service';
  authorizationGeneration: number;
  authenticationCredentialId?: string;
  deviceSessionId?: string;
  slotId?: string;
  deviceGeneration?: number;
  launchId: string;
  sessionId?: string;
  projectId: string;
  workspaceDigest: string;
  provider: string;
  body: string;
  engine: string;
  entrypoint: string;
  purpose: PermissionPurpose;
  effectFootprint?: PermissionEffectFootprint;
  requestedProfile: string;
  contractVersion: string;
  profileDigest: string;
  capabilityDigest: string;
  releaseBuild: string;
  protocolGeneration: number;
  ownerId: string;
  ownerPid: number;
  ownerBootId: string;
  ownerStartTicks: string;
  effectIdentity: string;
  expiresAtMs: number;
  nowMs: number;
  reasonCodes?: readonly string[];
}>;

/**
 * Scope that refused an admission. Carries only the scope kind and the recorded reason code;
 * scope keys, decision ids and generations stay inside the database.
 */
export type PermissionAdmissionFenceHint = Readonly<{
  scopeKind: 'session' | 'user_provider_purpose' | 'generation';
  reasonCode: string;
}>;

export class PermissionStateConflictError extends Error {
  constructor(
    public readonly code: string,
    public readonly fence?: PermissionAdmissionFenceHint,
  ) {
    super(code);
    this.name = 'PermissionStateConflictError';
  }
}

const assertToken = (value: string, name: string, maxLength = 256): void => {
  if (!value || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new PermissionStateConflictError(`INVALID_${name.toUpperCase()}`);
  }
};

const assertAdmissionInput = (input: CreatePermissionAdmission): void => {
  for (const [name, value] of Object.entries({
    decisionId: input.decisionId,
    leaseId: input.leaseId,
    principalId: input.principalId,
    launchId: input.launchId,
    projectId: input.projectId,
    provider: input.provider,
    body: input.body,
    engine: input.engine,
    entrypoint: input.entrypoint,
    ownerId: input.ownerId,
    effectIdentity: input.effectIdentity,
  })) {
    assertToken(value, name);
  }
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) {
    throw new PermissionStateConflictError('INVALID_USER_ID');
  }
  if (!Number.isSafeInteger(input.authorizationGeneration) || input.authorizationGeneration <= 0) {
    throw new PermissionStateConflictError('INVALID_AUTHORIZATION_GENERATION');
  }
  const deviceFields = [input.deviceSessionId, input.slotId, input.deviceGeneration];
  const hasDeviceBinding = deviceFields.some((value) => value !== undefined);
  if (hasDeviceBinding && (
    typeof input.deviceSessionId !== 'string' || !input.deviceSessionId
    || typeof input.slotId !== 'string' || !input.slotId
    || !Number.isSafeInteger(input.deviceGeneration) || Number(input.deviceGeneration) <= 0
  )) {
    throw new PermissionStateConflictError('INVALID_DEVICE_BINDING');
  }
  if (!Number.isSafeInteger(input.protocolGeneration) || input.protocolGeneration <= 0) {
    throw new PermissionStateConflictError('INVALID_PROTOCOL_GENERATION');
  }
  if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= input.nowMs) {
    throw new PermissionStateConflictError('INVALID_LEASE_EXPIRY');
  }
};

/** Redacts a workspace path into the stable digest persisted with a decision. */
export const digestPermissionWorkspace = (canonicalWorkspace: string): string => {
  assertToken(canonicalWorkspace, 'workspace', 16_384);
  return crypto.createHash('sha256').update(canonicalWorkspace).digest('hex');
};

/**
 * Refuses an admission for a stale actor, a closing or blocked generation, or a fenced scope.
 * Permanent refusals carry the refusing scope kind and reason so callers can explain them.
 */
const assertAdmissionScopeOpen = (database: Database, input: CreatePermissionAdmission): void => {
  const actor = database.prepare(`SELECT authorization_generation AS generation
    FROM users WHERE id = ? AND is_active = 1 AND status = 'active'`).get(input.userId) as
    | { generation: number }
    | undefined;
  if (!actor || actor.generation !== input.authorizationGeneration) {
    throw new PermissionStateConflictError('ACTOR_REVOKED_OR_STALE');
  }
  const closing = database.prepare(`SELECT 1 FROM permission_rollout_transitions
    WHERE state IN ('prepared', 'closing', 'failed_closed')
      AND (from_generation = ? OR to_generation = ?) LIMIT 1`)
    .get(input.protocolGeneration, input.protocolGeneration);
  if (closing) throw new PermissionStateConflictError('GENERATION_TRANSITIONING');
  const blocked = database.prepare(`SELECT reason_code AS reasonCode
    FROM permission_generation_blocks
    WHERE protocol_generation = ? LIMIT 1`).get(input.protocolGeneration) as
    | { reasonCode: string }
    | undefined;
  if (blocked) {
    throw new PermissionStateConflictError('GENERATION_BLOCKED', {
      scopeKind: 'generation', reasonCode: blocked.reasonCode,
    });
  }
  const fenced = database.prepare(`SELECT scope_kind AS scopeKind, reason_code AS reasonCode
    FROM permission_effect_fences
    WHERE (scope_kind = 'session' AND scope_key = ?)
       OR (scope_kind = 'user_provider_purpose' AND scope_key = ?)
    ORDER BY CASE scope_kind WHEN 'session' THEN 0 ELSE 1 END LIMIT 1`)
    .get(input.sessionId ?? '', permissionUserProviderPurposeKey(input.userId, input.provider, input.purpose)) as
    | { scopeKind: 'session' | 'user_provider_purpose'; reasonCode: string }
    | undefined;
  if (fenced) {
    throw new PermissionStateConflictError('EFFECT_SCOPE_FENCED', {
      scopeKind: fenced.scopeKind, reasonCode: fenced.reasonCode,
    });
  }
};

/**
 * Creates one authorized decision and one issued lease atomically. Duplicate identities,
 * stale actors, and a closing generation fail without leaving a partial decision.
 */
export const createPermissionAdmission = (
  database: Database,
  input: CreatePermissionAdmission,
): void => {
  assertAdmissionInput(input);
  database.transaction(() => {
    assertAdmissionScopeOpen(database, input);

    const reasonCodesJson = JSON.stringify(input.reasonCodes ?? []);
    database.prepare(`INSERT INTO permission_launch_decisions (
      decision_id, user_id, principal_id, authentication_kind, authorization_generation,
      authentication_credential_id, device_session_id, device_slot_id, device_generation,
      launch_id, session_id, project_id, workspace_digest,
      provider, body, engine, entrypoint, purpose, requested_profile,
      contract_version, profile_digest, capability_digest, release_build,
      protocol_generation, verdict, reason_codes_json, state, revision, created_at_ms,
      updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'authorized', ?,
      'authorized', 1, ?, ?)`)
      .run(input.decisionId, input.userId, input.principalId, input.authenticationKind,
        input.authorizationGeneration, input.authenticationCredentialId ?? null,
        input.deviceSessionId ?? null, input.slotId ?? null, input.deviceGeneration ?? null,
        input.launchId, input.sessionId ?? null, input.projectId, input.workspaceDigest,
        input.provider, input.body, input.engine, input.entrypoint, input.purpose, input.requestedProfile,
        input.contractVersion, input.profileDigest, input.capabilityDigest,
        input.releaseBuild, input.protocolGeneration, reasonCodesJson, input.nowMs, input.nowMs);

    database.prepare(`INSERT INTO permission_admission_leases (
      lease_id, decision_id, purpose, protocol_generation, owner_id, owner_pid,
      owner_boot_id, owner_start_ticks, effect_identity, status, expires_at_ms, revision, created_at_ms,
      updated_at_ms, effect_footprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, 1, ?, ?, ?)`)
      .run(input.leaseId, input.decisionId, input.purpose, input.protocolGeneration,
        input.ownerId, input.ownerPid, input.ownerBootId, input.ownerStartTicks, input.effectIdentity,
        input.expiresAtMs, input.nowMs, input.nowMs, input.effectFootprint ?? 'external');
  }).immediate();
};

/** Strictly records a denied/not-started decision without creating a lease. */
export const recordPermissionDenial = (
  database: Database,
  input: Omit<CreatePermissionAdmission, 'leaseId' | 'ownerId' | 'ownerPid' | 'ownerBootId'
    | 'ownerStartTicks' | 'effectIdentity' | 'expiresAtMs'>
    & Readonly<{ reasonCodes: readonly string[] }>,
): void => {
  assertToken(input.decisionId, 'decision_id');
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0 || input.reasonCodes.length === 0) {
    throw new PermissionStateConflictError('INVALID_DENIAL');
  }
  database.prepare(`INSERT INTO permission_launch_decisions (
    decision_id, user_id, principal_id, authentication_kind, authorization_generation,
    authentication_credential_id, device_session_id, device_slot_id, device_generation,
    launch_id, session_id, project_id, workspace_digest,
    provider, body, engine, entrypoint, purpose, requested_profile,
    contract_version, profile_digest, capability_digest, release_build,
    protocol_generation, verdict, reason_codes_json, state, revision, created_at_ms,
    updated_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'denied', ?,
    'not_started', 1, ?, ?)`)
    .run(input.decisionId, input.userId, input.principalId, input.authenticationKind,
      input.authorizationGeneration, input.authenticationCredentialId ?? null,
      input.deviceSessionId ?? null, input.slotId ?? null, input.deviceGeneration ?? null,
      input.launchId, input.sessionId ?? null, input.projectId, input.workspaceDigest,
      input.provider, input.body, input.engine, input.entrypoint, input.purpose, input.requestedProfile,
      input.contractVersion, input.profileDigest, input.capabilityDigest,
      input.releaseBuild, input.protocolGeneration, JSON.stringify(input.reasonCodes),
      input.nowMs, input.nowMs);
};

/** Claims an issued lease exactly once after rechecking actor generation and expiry. */
export const claimPermissionLease = (
  database: Database,
  leaseId: string,
  expectedRevision: number,
  nowMs: number,
): number => database.transaction(() => {
  const result = database.prepare(`UPDATE permission_admission_leases AS lease
    SET status = 'active', claimed_at_ms = ?, updated_at_ms = ?, revision = revision + 1
    WHERE lease_id = ? AND status = 'issued' AND revision = ? AND expires_at_ms > ?
      AND NOT EXISTS (
        SELECT 1 FROM permission_rollout_transitions transition
        WHERE transition.state IN ('prepared', 'closing', 'failed_closed')
          AND (transition.from_generation = lease.protocol_generation
            OR transition.to_generation = lease.protocol_generation)
      )
      AND NOT EXISTS (
        SELECT 1 FROM permission_generation_blocks blocked
        WHERE blocked.protocol_generation = lease.protocol_generation
      )
      AND NOT EXISTS (
        SELECT 1 FROM permission_effect_fences fence
        JOIN permission_launch_decisions scoped ON scoped.decision_id = lease.decision_id
        WHERE (fence.scope_kind = 'session' AND fence.scope_key = scoped.session_id)
           OR (fence.scope_kind = 'user_provider_purpose'
             AND fence.scope_key = scoped.user_id || ':' || scoped.provider || ':' || scoped.purpose)
      )
      AND EXISTS (
        SELECT 1 FROM permission_launch_decisions decision
        JOIN users actor ON actor.id = decision.user_id
        WHERE decision.decision_id = lease.decision_id
          AND decision.state = 'authorized'
          AND actor.is_active = 1 AND actor.status = 'active'
          AND actor.authorization_generation = decision.authorization_generation
      )`).run(nowMs, nowMs, leaseId, expectedRevision, nowMs);
  if (result.changes !== 1) throw new PermissionStateConflictError('LEASE_NOT_CLAIMABLE');
  const revision = database.prepare(
    'SELECT revision FROM permission_admission_leases WHERE lease_id = ?',
  ).get(leaseId) as { revision: number };
  database.prepare(`UPDATE permission_launch_decisions
    SET state = 'effect_claimed', revision = revision + 1, updated_at_ms = ?
    WHERE decision_id = (SELECT decision_id FROM permission_admission_leases WHERE lease_id = ?)
      AND state = 'authorized'`).run(nowMs, leaseId);
  return revision.revision;
}).immediate();

const assertChildIdentity = (child: PermissionChildIdentity): void => {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw new PermissionStateConflictError('INVALID_CHILD_IDENTITY');
  }
  assertToken(child.bootId, 'child_boot_id');
  assertToken(child.startTicks, 'child_start_ticks');
};

type LeaseIdentityRow = Readonly<{
  footprint: PermissionEffectFootprint;
  ownerPid: number;
  ownerBootId: string;
  ownerStartTicks: string;
  childPid: number | null;
  childBootId: string | null;
  childStartTicks: string | null;
}>;

const sameProcess = (
  child: Readonly<{ pid: number | null; bootId: string | null; startTicks: string | null }>,
  row: Pick<LeaseIdentityRow, 'ownerPid' | 'ownerBootId' | 'ownerStartTicks'>,
): boolean => child.pid === row.ownerPid && child.bootId === row.ownerBootId
  && child.startTicks === row.ownerStartTicks;

/**
 * T-1910: an in-process read lease is a local effect whose recorded carrier is the owning
 * server process itself. Only the gateway's in-process read helper can mint one, and both
 * fence sites (in-process settlement and boot reconciliation) classify it with this predicate.
 */
export const isInProcessReadLease = (row: LeaseIdentityRow): boolean => row.footprint === 'local'
  && sameProcess({ pid: row.childPid, bootId: row.childBootId, startTicks: row.childStartTicks }, row);

const readLeaseIdentity = (database: Database, decisionId: string): LeaseIdentityRow | undefined =>
  database.prepare(`SELECT effect_footprint AS footprint, owner_pid AS ownerPid,
    owner_boot_id AS ownerBootId, owner_start_ticks AS ownerStartTicks,
    effect_child_pid AS childPid, effect_child_boot_id AS childBootId,
    effect_child_start_ticks AS childStartTicks
    FROM permission_admission_leases WHERE decision_id = ? AND status = 'active'`)
    .get(decisionId) as LeaseIdentityRow | undefined;

/**
 * Marks provider evidence as started using a compare-and-swap transition. A child equal to
 * the lease owner is refused unless `selfEffect` is set, which the gateway allows only for
 * its in-process read helper and only on a local-footprint lease (T-1910).
 */
export const markPermissionEffectStarted = (
  database: Database,
  decisionId: string,
  expectedRevision: number,
  nowMs: number,
  child?: PermissionChildIdentity,
  options: Readonly<{ selfEffect?: boolean }> = {},
): number => database.transaction(() => {
  const result = database.prepare(`UPDATE permission_launch_decisions
    SET state = 'started', revision = revision + 1, updated_at_ms = ?
    WHERE decision_id = ? AND state = 'effect_claimed' AND revision = ?`)
    .run(nowMs, decisionId, expectedRevision);
  if (result.changes !== 1) throw new PermissionStateConflictError('DECISION_NOT_STARTABLE');
  if (options.selfEffect && !child) throw new PermissionStateConflictError('INVALID_CHILD_IDENTITY');
  if (child) {
    assertChildIdentity(child);
    const lease = readLeaseIdentity(database, decisionId);
    if (!lease) throw new PermissionStateConflictError('CHILD_IDENTITY_NOT_RECORDABLE');
    if (sameProcess(child, lease) !== Boolean(options.selfEffect)
      || (options.selfEffect && lease.footprint !== 'local')) {
      throw new PermissionStateConflictError('SELF_EFFECT_IDENTITY_REFUSED');
    }
    // Same CAS as the decision: the child identity is the only proof a local effect ended.
    const updated = database.prepare(`UPDATE permission_admission_leases
      SET effect_child_pid = ?, effect_child_boot_id = ?, effect_child_start_ticks = ?,
        revision = revision + 1, updated_at_ms = ?
      WHERE decision_id = ? AND status = 'active'`)
      .run(child.pid, child.bootId, child.startTicks, nowMs, decisionId);
    if (updated.changes !== 1) throw new PermissionStateConflictError('CHILD_IDENTITY_NOT_RECORDABLE');
  }
  return expectedRevision + 1;
}).immediate();

/** Attaches a child minted at the effect seam after the durable start CAS. */
export const attachPermissionEffectChild = (
  database: Database,
  decisionId: string,
  child: PermissionChildIdentity,
  nowMs: number,
): void => database.transaction(() => {
  assertChildIdentity(child);
  // T-1910: the owner itself is never attachable; only the atomic start may record it.
  const result = database.prepare(`UPDATE permission_admission_leases
    SET effect_child_pid = ?, effect_child_boot_id = ?, effect_child_start_ticks = ?,
      revision = revision + 1, updated_at_ms = ?
    WHERE decision_id = ? AND status = 'active'
      AND effect_child_pid IS NULL AND effect_child_boot_id IS NULL
      AND effect_child_start_ticks IS NULL
      AND NOT (owner_pid = ? AND owner_boot_id = ? AND owner_start_ticks = ?)
      AND EXISTS (SELECT 1 FROM permission_launch_decisions decision
        WHERE decision.decision_id = permission_admission_leases.decision_id
          AND decision.state = 'started')`)
    .run(child.pid, child.bootId, child.startTicks, nowMs, decisionId,
      child.pid, child.bootId, child.startTicks);
  if (result.changes !== 1) {
    throw new PermissionStateConflictError('CHILD_IDENTITY_NOT_RECORDABLE');
  }
}).immediate();

/** Provider session ids (Claude and Codex) are canonical UUIDs; nothing else is bindable. */
const BINDABLE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * T-1910 S2 (B-1202): binds a new-chat sdk_turn decision to its provider session exactly once.
 * The CAS moves `session_id` from NULL to the id, so a crash after it fences `session:<id>`
 * instead of the user-wide key. Refused when the id is malformed, the decision is already
 * bound, settled, or not an sdk_turn, or the session is attributable to another user or project
 * (an existing session row of another project, a participant row of another user, or another
 * decision of another user/project already naming it). The decision revision is not bumped: the
 * gateway's claim/start/settle CAS chain keeps its expected revisions.
 */
export const bindPermissionDecisionSession = (
  database: Database,
  decisionId: string,
  sessionId: string,
  nowMs: number,
): void => database.transaction(() => {
  if (typeof sessionId !== 'string' || !BINDABLE_SESSION_ID.test(sessionId)) {
    throw new PermissionStateConflictError('INVALID_SESSION_ID');
  }
  const decision = database.prepare(`SELECT user_id AS userId, project_id AS projectId,
    session_id AS sessionId, purpose, state FROM permission_launch_decisions
    WHERE decision_id = ?`).get(decisionId) as
    | { userId: number; projectId: string; sessionId: string | null; purpose: string; state: string }
    | undefined;
  if (!decision) throw new PermissionStateConflictError('DECISION_MISSING');
  if (decision.sessionId !== null) throw new PermissionStateConflictError('SESSION_ALREADY_BOUND');
  if (decision.purpose !== 'sdk_turn') throw new PermissionStateConflictError('SESSION_BIND_PURPOSE_REFUSED');
  if (!['authorized', 'effect_claimed', 'started'].includes(decision.state)) {
    throw new PermissionStateConflictError('DECISION_NOT_BINDABLE');
  }
  const foreign = database.prepare(`SELECT 1 FROM sessions session
      JOIN projects project ON project.project_path = session.project_path
      WHERE session.session_id = @sessionId AND project.project_id != @projectId
    UNION ALL SELECT 1 FROM session_participants participant
      WHERE participant.session_id = @sessionId AND participant.user_id != @userId
    UNION ALL SELECT 1 FROM permission_launch_decisions other
      WHERE other.session_id = @sessionId AND other.decision_id != @decisionId
        AND (other.user_id != @userId OR other.project_id != @projectId)
    LIMIT 1`).get({ sessionId, projectId: decision.projectId, userId: decision.userId, decisionId });
  if (foreign) throw new PermissionStateConflictError('SESSION_FOREIGN');
  const bound = database.prepare(`UPDATE permission_launch_decisions
    SET session_id = ?, updated_at_ms = ?
    WHERE decision_id = ? AND session_id IS NULL
      AND state IN ('authorized', 'effect_claimed', 'started')`).run(sessionId, nowMs, decisionId);
  if (bound.changes !== 1) throw new PermissionStateConflictError('SESSION_BIND_CAS_LOST');
}).immediate();

/** Terminates an issued permit which provably never reached the provider boundary. */
export const settlePermissionNotStarted = (
  database: Database,
  decisionId: string,
  nowMs: number,
): void => {
  database.transaction(() => {
    const decision = database.prepare(`UPDATE permission_launch_decisions
      SET state = 'terminal', terminal_outcome = 'not_started', revision = revision + 1,
        updated_at_ms = ?
      WHERE decision_id = ? AND state = 'authorized'`).run(nowMs, decisionId);
    if (decision.changes !== 1) {
      throw new PermissionStateConflictError('DECISION_NOT_SETTLEABLE');
    }
    const lease = database.prepare(`UPDATE permission_admission_leases
      SET status = 'revoked', terminal_at_ms = ?, revision = revision + 1, updated_at_ms = ?
      WHERE decision_id = ? AND status = 'issued'`).run(nowMs, nowMs, decisionId);
    if (lease.changes !== 1) throw new PermissionStateConflictError('LEASE_NOT_SETTLEABLE');
  }).immediate();
};

/** Durably fences a generation when terminal effect state cannot be established. */
export const blockPermissionGeneration = (
  database: Database,
  input: Readonly<{
    protocolGeneration: number;
    reasonCode: string;
    decisionId?: string;
    effectIdentity?: string;
    nowMs: number;
  }>,
): void => {
  assertToken(input.reasonCode, 'reason_code', 128);
  database.prepare(`INSERT INTO permission_generation_blocks (
    protocol_generation, reason_code, decision_id, effect_identity, created_at_ms
  ) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(protocol_generation) DO NOTHING`).run(
    input.protocolGeneration, input.reasonCode, input.decisionId ?? null,
    input.effectIdentity ?? null, input.nowMs,
  );
};

/** Returns durable generation fences that must prevent readiness and admission. */
export const countPermissionGenerationBlocks = (database: Database): number => {
  const row = database.prepare(
    'SELECT COUNT(*) AS count FROM permission_generation_blocks',
  ).get() as { count: number };
  return row.count;
};

/** Sentinel written when the kernel boot id cannot be read; it proves nothing. */
export const BOOT_ID_UNAVAILABLE = 'boot-unavailable';

/** Resolves the fence scope of a decision: its session, else its user+provider+purpose. */
export const resolvePermissionEffectScope = (
  database: Database,
  decisionId: string,
): PermissionEffectFenceScope & { protocolGeneration: number } => {
  const decision = database.prepare(`SELECT session_id AS sessionId, user_id AS userId,
    provider, purpose, protocol_generation AS protocolGeneration
    FROM permission_launch_decisions WHERE decision_id = ?`).get(decisionId) as
    | { sessionId: string | null; userId: number; provider: string; purpose: string; protocolGeneration: number }
    | undefined;
  if (!decision) throw new PermissionStateConflictError('DECISION_MISSING');
  return decision.sessionId
    ? { scopeKind: 'session', scopeKey: decision.sessionId, protocolGeneration: decision.protocolGeneration }
    : {
      scopeKind: 'user_provider_purpose',
      scopeKey: permissionUserProviderPurposeKey(decision.userId, decision.provider, decision.purpose),
      protocolGeneration: decision.protocolGeneration,
    };
};

/** Durably fences one scope; an existing fence on the scope is kept (first evidence wins). */
export const fencePermissionEffectScopeForDecision = (
  database: Database,
  decisionId: string,
  reasonCode: string,
  nowMs: number,
): PermissionEffectFenceScope => {
  assertToken(reasonCode, 'reason_code', 128);
  const scope = resolvePermissionEffectScope(database, decisionId);
  const written = database.prepare(`INSERT INTO permission_effect_fences (
    scope_kind, scope_key, protocol_generation, decision_id, reason_code, created_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(scope_kind, scope_key) DO NOTHING`)
    .run(scope.scopeKind, scope.scopeKey, scope.protocolGeneration, decisionId, reasonCode, nowMs);
  if (written.changes !== 1) {
    const existing = database.prepare(`SELECT 1 FROM permission_effect_fences
      WHERE scope_kind = ? AND scope_key = ?`).get(scope.scopeKind, scope.scopeKey);
    if (!existing) throw new PermissionStateConflictError('EFFECT_FENCE_WRITE_FAILED');
  }
  return { scopeKind: scope.scopeKind, scopeKey: scope.scopeKey };
};

/** Scoped fences never gate readiness; they refuse admission and claims in their scope only. */
export const listPermissionEffectFences = (database: Database): Array<PermissionEffectFenceScope & {
  protocolGeneration: number; decisionId: string | null; reasonCode: string; createdAtMs: number;
}> => database.prepare(`SELECT scope_kind AS scopeKind, scope_key AS scopeKey,
  protocol_generation AS protocolGeneration, decision_id AS decisionId, reason_code AS reasonCode,
  created_at_ms AS createdAtMs FROM permission_effect_fences ORDER BY created_at_ms`).all() as never;

/** Writes the single terminal fact and closes the active lease in one transaction. */
export const settlePermissionEffect = (
  database: Database,
  decisionId: string,
  outcome: PermissionTerminalOutcome,
  expectedDecisionRevision: number,
  nowMs: number,
): void => {
  database.transaction(() => {
    const decision = database.prepare(`UPDATE permission_launch_decisions
      SET state = 'terminal', terminal_outcome = ?, revision = revision + 1, updated_at_ms = ?
      WHERE decision_id = ? AND state IN ('effect_claimed', 'started') AND revision = ?`)
      .run(outcome, nowMs, decisionId, expectedDecisionRevision);
    if (decision.changes !== 1) {
      throw new PermissionStateConflictError('DECISION_NOT_SETTLEABLE');
    }
    const identity = readLeaseIdentity(database, decisionId);
    const lease = database.prepare(`UPDATE permission_admission_leases
      SET status = 'terminal', terminal_at_ms = ?, revision = revision + 1, updated_at_ms = ?
      WHERE decision_id = ? AND status = 'active'`).run(nowMs, nowMs, decisionId);
    if (lease.changes !== 1 || !identity) throw new PermissionStateConflictError('LEASE_NOT_SETTLEABLE');
    if (outcome === 'reconciled_unknown' && !isInProcessReadLease(identity)) {
      // T-1593: an unknown settled in-process cannot prove its child died, so it fences
      // its own scope (session, or user+provider+purpose), never the whole generation.
      // T-1910: an in-process read is carried by this process alone and is classified
      // exactly as boot reconciliation classifies it: never fenced.
      fencePermissionEffectScopeForDecision(database, decisionId, 'RECONCILED_EFFECT_UNKNOWN', nowMs);
    }
  }).immediate();
};

/** Reads the latest applied local rollout; absence is the backward-compatible legacy state. */
export const readPermissionRolloutState = (database: Database): PermissionRolloutState => {
  const row = database.prepare(`SELECT to_profile AS profile, to_generation AS generation,
    manifest_digest AS manifestDigest, contract_version AS contractVersion,
    profile_digest AS profileDigest, capability_digest AS capabilityDigest
    FROM permission_rollout_transitions
    WHERE state = 'applied' ORDER BY to_generation DESC LIMIT 1`).get() as
    | {
      profile: PermissionRolloutProfile;
      generation: number;
      manifestDigest: string;
      contractVersion: string;
      profileDigest: string;
      capabilityDigest: string;
    }
    | undefined;
  return row
    ? Object.freeze(row)
    : Object.freeze({
      profile: 'legacy', generation: 1, manifestDigest: null, contractVersion: null,
      profileDigest: null, capabilityDigest: null,
    });
};

/** Creates the sole prepared local transition after checking the current applied state. */
export const preparePermissionTransition = (
  database: Database,
  input: Readonly<{
    transitionId: string;
    fromProfile: PermissionRolloutProfile;
    toProfile: PermissionRolloutProfile;
    fromGeneration: number;
    toGeneration: number;
    manifestDigest: string;
    contractVersion: string;
    profileDigest: string;
    capabilityDigest: string;
    nowMs: number;
  }>,
): void => {
  assertToken(input.transitionId, 'transition_id');
  assertToken(input.manifestDigest, 'manifest_digest');
  assertToken(input.contractVersion, 'contract_version');
  assertToken(input.profileDigest, 'profile_digest');
  assertToken(input.capabilityDigest, 'capability_digest');
  database.transaction(() => {
    const current = readPermissionRolloutState(database);
    if (current.profile !== input.fromProfile || current.generation !== input.fromGeneration
      || input.toGeneration !== input.fromGeneration + 1 || input.toProfile === input.fromProfile) {
      throw new PermissionStateConflictError('TRANSITION_SOURCE_MISMATCH');
    }
    database.prepare(`INSERT INTO permission_rollout_transitions (
      transition_id, from_profile, to_profile, from_generation, to_generation,
      manifest_digest, contract_version, profile_digest, capability_digest,
      state, revision, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 1, ?, ?)`)
      .run(input.transitionId, input.fromProfile, input.toProfile, input.fromGeneration,
        input.toGeneration, input.manifestDigest, input.contractVersion, input.profileDigest,
        input.capabilityDigest, input.nowMs, input.nowMs);
  }).immediate();
};

/** Moves the prepared transition to closing using CAS; admission is fenced immediately. */
export const beginPermissionTransitionClosing = (
  database: Database,
  transitionId: string,
  expectedRevision: number,
  nowMs: number,
): number => {
  const result = database.prepare(`UPDATE permission_rollout_transitions
    SET state = 'closing', revision = revision + 1, updated_at_ms = ?
    WHERE transition_id = ? AND state = 'prepared' AND revision = ?`)
    .run(nowMs, transitionId, expectedRevision);
  if (result.changes !== 1) throw new PermissionStateConflictError('TRANSITION_NOT_CLOSABLE');
  return expectedRevision + 1;
};

/**
 * Applies or rolls back a closing transition only after its old-generation leases drain.
 * `failed_closed` is allowed with active leases because it does not expose a new generation.
 */
export const finishPermissionTransition = (
  database: Database,
  transitionId: string,
  outcome: 'applied' | 'rolled_back' | 'failed_closed',
  expectedRevision: number,
  nowMs: number,
): void => {
  database.transaction(() => {
    const transition = database.prepare(`SELECT from_generation AS fromGeneration,
      to_generation AS toGeneration FROM permission_rollout_transitions
      WHERE transition_id = ? AND state = 'closing' AND revision = ?`)
      .get(transitionId, expectedRevision) as
      | { fromGeneration: number; toGeneration: number }
      | undefined;
    if (!transition) throw new PermissionStateConflictError('TRANSITION_NOT_FINISHABLE');
    if (outcome === 'applied') {
      const active = database.prepare(`SELECT 1 FROM permission_admission_leases
        WHERE protocol_generation = ? AND status IN ('issued', 'active') LIMIT 1`)
        .get(transition.fromGeneration);
      if (active) throw new PermissionStateConflictError('GENERATION_NOT_DRAINED');
    }
    const result = database.prepare(`UPDATE permission_rollout_transitions
      SET state = ?, terminal_at_ms = ?, revision = revision + 1, updated_at_ms = ?
      WHERE transition_id = ? AND state = 'closing' AND revision = ?`)
      .run(outcome, nowMs, nowMs, transitionId, expectedRevision);
    if (result.changes !== 1) throw new PermissionStateConflictError('TRANSITION_NOT_FINISHABLE');
  }).immediate();
};

export type PermissionReconciliationSummary = Readonly<{
  notStarted: number;
  /** Dead owner, local footprint, child proven dead: recorded, never fenced, never fatal. */
  unknownLocal: number;
  /** Dead owner with a possibly surviving effect: scoped fence written; fatal once at boot. */
  unknownExternal: number;
  /** unknownLocal + unknownExternal, kept for log readers of the pre-T-1593 shape. */
  unknown: number;
  stillActive: number;
  blocked: number;
  /** Child processes of local effects that outlived their dead owner (pm2 treekill:false). */
  orphans: readonly number[];
}>;

/**
 * Reconciles expired leases from durable evidence before readiness. An unclaimed lease is
 * provably not started; a claimed lease whose exact owner is dead becomes honest unknown.
 * A live exact owner remains active even after TTL because child lifetime is terminal-driven.
 */
export const reconcileExpiredPermissionExecutions = (
  database: Database,
  nowMs: number,
  ownerAlive: (owner: PermissionChildIdentity) => boolean,
  childAlive: (child: PermissionChildIdentity) => boolean = ownerAlive,
): PermissionReconciliationSummary => database.transaction(() => {
  const rows = database.prepare(`SELECT lease.lease_id AS leaseId,
    lease.decision_id AS decisionId, lease.status, lease.owner_pid AS ownerPid,
    lease.owner_boot_id AS ownerBootId, lease.owner_start_ticks AS ownerStartTicks,
    lease.effect_footprint AS footprint, lease.effect_child_pid AS childPid,
    lease.effect_child_boot_id AS childBootId, lease.effect_child_start_ticks AS childStartTicks,
    decision.revision AS decisionRevision
    FROM permission_admission_leases lease
    JOIN permission_launch_decisions decision ON decision.decision_id = lease.decision_id
    WHERE lease.status IN ('issued', 'active') AND lease.expires_at_ms <= ?
      AND decision.state != 'terminal'`).all(nowMs) as Array<{
        leaseId: string;
        decisionId: string;
        status: 'issued' | 'active';
        ownerPid: number;
        ownerBootId: string;
        ownerStartTicks: string;
        footprint: PermissionEffectFootprint;
        childPid: number | null;
        childBootId: string | null;
        childStartTicks: string | null;
        decisionRevision: number;
      }>;
  let notStarted = 0;
  let unknownLocal = 0;
  let unknownExternal = 0;
  let stillActive = 0;
  const orphans: number[] = [];
  for (const row of rows) {
    if (row.status === 'active' && ownerAlive({
      pid: row.ownerPid,
      bootId: row.ownerBootId,
      startTicks: row.ownerStartTicks,
    })) {
      stillActive += 1;
      continue;
    }
    const outcome = row.status === 'issued' ? 'not_started' : 'reconciled_unknown';
    const decision = database.prepare(`UPDATE permission_launch_decisions
      SET state = 'terminal', terminal_outcome = ?, revision = revision + 1, updated_at_ms = ?
      WHERE decision_id = ? AND revision = ? AND state != 'terminal'`)
      .run(outcome, nowMs, row.decisionId, row.decisionRevision);
    if (decision.changes !== 1) throw new PermissionStateConflictError('RECONCILIATION_CAS_LOST');
    const leaseStatus = row.status === 'issued' ? 'revoked' : 'terminal';
    database.prepare(`UPDATE permission_admission_leases
      SET status = ?, terminal_at_ms = ?, revision = revision + 1, updated_at_ms = ?
      WHERE lease_id = ? AND status = ?`).run(
        leaseStatus, nowMs, nowMs, row.leaseId, row.status,
      );
    database.prepare(`INSERT INTO permission_reconciliation_items (
      reconciliation_id, decision_id, effect_identity, status, terminal_outcome,
      attempts, revision, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, 'terminal', ?, 1, 1, ?, ?)
    ON CONFLICT(decision_id, effect_identity) DO NOTHING`).run(
      `reconcile:${row.decisionId}`,
      row.decisionId,
      `lease:${row.leaseId}`,
      outcome,
      nowMs,
      nowMs,
    );
    if (row.status === 'issued') {
      notStarted += 1;
      continue;
    }
    // T-1593: only a local effect whose exact child is proven dead is settled without a
    // fence. A missing child identity, or a child that outlived its owner (pm2 runs
    // treekill:false), is treated as external and fences its own scope, never the node.
    const child = row.childPid && row.childBootId && row.childStartTicks
      ? { pid: row.childPid, bootId: row.childBootId, startTicks: row.childStartTicks }
      : null;
    // T-1910: an in-process read lease's child is its owner, already proven dead above;
    // the shared predicate keeps this site and in-process settlement in parity.
    const childProvenDead = child !== null && (isInProcessReadLease(row) || !childAlive(child));
    if (row.footprint === 'local' && childProvenDead) {
      unknownLocal += 1;
      continue;
    }
    if (row.footprint === 'local' && child !== null) orphans.push(child.pid);
    unknownExternal += 1;
    fencePermissionEffectScopeForDecision(database, row.decisionId, 'RECONCILED_EFFECT_UNKNOWN', nowMs);
  }
  return Object.freeze({
    notStarted,
    unknownLocal,
    unknownExternal,
    unknown: unknownLocal + unknownExternal,
    stillActive,
    blocked: countPermissionGenerationBlocks(database),
    orphans: Object.freeze(orphans),
  });
}).immediate();
