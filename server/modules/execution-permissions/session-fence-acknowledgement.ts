/**
 * T-1910 S4: "continue here" acknowledgement of a SESSION permission fence.
 *
 * Owner decision 2026-10-04: any user who can write to the session may acknowledge-and-continue a
 * fence whose scope is exactly that session; every other scope stays owner-only (Settings >
 * System). The acknowledgement is never proof of the unknown effect's outcome
 * (acknowledgementIsProof stays false in the journal). What IS proven, at request time and
 * again inside the lift's immediate transaction, is containment:
 *   - every unresolved unknown decision of the scope (qa C1), not only the fence row's own;
 *   - no live process of this service's uid carries CCUI_PROCESS_TAG=pe-<decisionId>;
 *   - every recorded effect child is proven dead (processAlive, exact identity);
 *   - no open lease or claim in the scope (the lift never passes force).
 * The lift itself is a CAS on the fence row that was inspected (qa C3).
 *
 * Refusal reasons (409): `leases_open` (an open lease/claim; clears when it settles),
 * `not_contained` (a live tagged process or recorded child, or a transient read failure;
 * may clear), `not_provable` (the proof can never be completed here: an env-hidden process
 * of our uid that may descend from the run, an untrustworthy journal, a missing lease, a
 * fence without a decision; only the owner's Settings > System lift remains),
 * `fence_changed` (CAS lost: a different fence now holds the scope), `not_session_scope`.
 *
 * Residual risk (qa M6, accepted, documented): the tag scan only sees processes that still
 * carry CCUI_PROCESS_TAG in their environ. A descendant that dropped or never inherited it
 * escapes the proof, e.g. work handed to a tmux server, systemd-run, `env -i`, docker, ssh
 * to another host, pm2, at/cron, or sudo (another uid). Recorded children are checked by
 * exact identity, but such hand-offs are not; this is why the lift stays an acknowledgement
 * (acknowledgementIsProof: false) and never a proof of the effect's outcome.
 */

import fs from 'node:fs';

import type { Database } from 'better-sqlite3';

import { liftFence, listScopedFences, readCommittedScopeLifts } from './permission-fence.js';
import { permissionProcessTag, scanServiceProcessesForTags, type ServiceTagScan } from './process-tag-identity.js';

export type ContainmentVerdict = 'contained' | 'leases_open' | 'not_contained' | 'not_provable';

export type SessionFenceRefusalReason = Exclude<ContainmentVerdict, 'contained'> | 'fence_changed' | 'not_session_scope';

/** A refusal the route maps to 409 with `reason`; never carries paths or secrets. */
export class SessionFenceRefusal extends Error {
  readonly reason: SessionFenceRefusalReason;

  constructor(reason: SessionFenceRefusalReason) {
    super(`session fence acknowledgement refused: ${reason}`);
    this.name = 'SessionFenceRefusal';
    this.reason = reason;
  }
}

export type SessionFenceView = Readonly<{
  fenced: boolean;
  scope?: 'session';
  reason?: string;
  decisionUserId?: number;
  canAcknowledge: boolean;
  contained?: boolean;
  /** Present with a session fence: why `contained` is false, or 'contained'. */
  containment?: ContainmentVerdict;
}>;

export type SessionFenceAcknowledgement =
  | Readonly<{ lifted: true; operationId: string; decisionOwnerUserId: number | null; completionAuditRecorded: boolean }>
  | Readonly<{ lifted: false; reason: 'not_fenced' }>;

type ChildIdentity = Readonly<{ pid: number; bootId: string; startTicks: string }>;

export type ContainmentDependencies = Readonly<{
  scanTags(tags: readonly string[], notBeforeMs: number): ServiceTagScan;
  childAlive(child: ChildIdentity): boolean;
}>;

const readBootId = (): string => {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return ''; }
};

/**
 * Host containment for production. `processAlive` is runtime-gateway's exact-identity check,
 * injected by the composition root so this module stays free of the gateway's boot-time state.
 */
export const createHostContainment = (
  processAlive: (currentBootId: string, child: ChildIdentity) => boolean,
): ContainmentDependencies => ({
  scanTags: (tags, notBeforeMs) => scanServiceProcessesForTags(tags, notBeforeMs),
  childAlive: child => processAlive(readBootId(), child),
});

const MAX_UNRESOLVED = 1000;
const ACK_REASON = 'session writer acknowledged unknown effects and continued here (T-1910 S4)';
const DEVICE_SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

type ScopedFence = Readonly<{
  scopeKind: 'session'; scopeKey: string; decisionId: string | null; reasonCode: string;
  createdAtMs: number; openLeases: number;
}>;

const readSessionFence = (database: Database, sessionId: string): ScopedFence | null => (
  (listScopedFences(database, { scopeKind: 'session', scopeKey: sessionId })[0] as ScopedFence | undefined) ?? null
);

/** A non-session fence that would also refuse this requester's launches in the session. */
const hasOtherScopeFence = (database: Database, requesterUserId: number): boolean => {
  const prefix = `${requesterUserId}:`;
  return Boolean(database.prepare(`SELECT 1 FROM permission_generation_blocks
    UNION ALL SELECT 1 FROM permission_effect_fences
      WHERE scope_kind = 'user_provider_purpose' AND substr(scope_key, 1, ?) = ?
    LIMIT 1`).get(prefix.length, prefix));
};

const decisionOwnerOf = (database: Database, decisionId: string | null): number | null => {
  if (!decisionId) return null;
  const row = database.prepare('SELECT user_id AS userId FROM permission_launch_decisions WHERE decision_id = ?')
    .get(decisionId) as { userId: number } | undefined;
  return row?.userId ?? null;
};

type UnresolvedDecision = Readonly<{
  decisionId: string; createdAtMs: number; leaseId: string | null;
  childPid: number | null; childBootId: string | null; childStartTicks: string | null;
}>;

type UnresolvedSet = Readonly<{ decisions: UnresolvedDecision[] }> | Readonly<{ unprovable: true }>;

/**
 * qa C1: every reconciled_unknown decision of the session not covered by a COMMITTED lift of
 * this scope, plus the fence's own decision. `unprovable` when the set cannot be trusted.
 */
const unresolvedDecisions = (database: Database, fence: ScopedFence): UnresolvedSet => {
  if (!fence.decisionId) return { unprovable: true };
  const journal = readCommittedScopeLifts(database, { scopeKind: 'session', scopeKey: fence.scopeKey });
  if (!journal.certain) return { unprovable: true };
  const rows = database.prepare(`SELECT d.decision_id AS decisionId, d.created_at_ms AS createdAtMs,
      l.lease_id AS leaseId, l.effect_child_pid AS childPid, l.effect_child_boot_id AS childBootId,
      l.effect_child_start_ticks AS childStartTicks
    FROM permission_launch_decisions d
    LEFT JOIN permission_admission_leases l ON l.decision_id = d.decision_id
    WHERE (d.session_id = ? AND d.terminal_outcome = 'reconciled_unknown') OR d.decision_id = ?
    ORDER BY d.decision_id LIMIT ?`)
    .all(fence.scopeKey, fence.decisionId, MAX_UNRESOLVED + 1) as UnresolvedDecision[];
  if (rows.length > MAX_UNRESOLVED || !rows.some(row => row.decisionId === fence.decisionId)) return { unprovable: true };
  return {
    decisions: rows.filter(row => row.decisionId === fence.decisionId || !journal.decisionIds.has(row.decisionId)),
  };
};

const hasOpenScopeWork = (database: Database, fence: ScopedFence): boolean => {
  const fresh = readSessionFence(database, fence.scopeKey);
  if ((fresh?.openLeases ?? 0) > 0) return true;
  return Boolean(database.prepare(`SELECT 1 FROM permission_launch_decisions
    WHERE session_id = ? AND state IN ('effect_claimed', 'started') LIMIT 1`).get(fence.scopeKey));
};

/** Static per-decision evidence: a tag-able id, a lease, and a complete child identity if any. */
const decisionEvidence = (decision: UnresolvedDecision, dependencies: ContainmentDependencies): ContainmentVerdict => {
  const recorded = [decision.childPid, decision.childBootId, decision.childStartTicks];
  if (!permissionProcessTag(decision.decisionId) || !Number.isSafeInteger(decision.createdAtMs)
    || decision.leaseId === null || (recorded.some(value => value !== null) && recorded.some(value => value === null))) {
    return 'not_provable';
  }
  if (decision.childPid !== null && dependencies.childAlive({
    pid: decision.childPid, bootId: decision.childBootId as string, startTicks: decision.childStartTicks as string,
  })) return 'not_contained';
  return 'contained';
};

const SCAN_VERDICT: Readonly<Record<ServiceTagScan, ContainmentVerdict>> = {
  absent: 'contained', present: 'not_contained', uncertain: 'not_contained', hidden: 'not_provable',
};

/** Containment verdict for one session fence; any doubt is a refusal, never `contained`. */
export const proveSessionFenceContainment = (
  database: Database,
  fence: ScopedFence,
  dependencies: ContainmentDependencies,
): ContainmentVerdict => {
  if (hasOpenScopeWork(database, fence)) return 'leases_open';
  const set = unresolvedDecisions(database, fence);
  if ('unprovable' in set || set.decisions.length === 0) return 'not_provable';
  const verdicts = set.decisions.map(decision => decisionEvidence(decision, dependencies));
  if (verdicts.includes('not_provable')) return 'not_provable';
  if (verdicts.includes('not_contained')) return 'not_contained';
  const tags = set.decisions.map(decision => permissionProcessTag(decision.decisionId) as string);
  const notBeforeMs = Math.min(...set.decisions.map(decision => decision.createdAtMs));
  return SCAN_VERDICT[dependencies.scanTags(tags, notBeforeMs)];
};

/** GET view: fence metadata only (no paths, payloads or secrets). */
export const describeSessionFence = (
  database: Database,
  input: Readonly<{ sessionId: string; requesterUserId: number; canWrite: boolean }>,
  dependencies: ContainmentDependencies,
): SessionFenceView => {
  const fence = readSessionFence(database, input.sessionId);
  if (!fence) {
    return hasOtherScopeFence(database, input.requesterUserId)
      ? { fenced: true, canAcknowledge: false }
      : { fenced: false, canAcknowledge: false };
  }
  const decisionUserId = decisionOwnerOf(database, fence.decisionId);
  const containment = proveSessionFenceContainment(database, fence, dependencies);
  return {
    fenced: true,
    scope: 'session',
    reason: fence.reasonCode,
    ...(decisionUserId !== null ? { decisionUserId } : {}),
    canAcknowledge: input.canWrite,
    contained: containment === 'contained',
    containment,
  };
};

/**
 * POST: proves containment, then lifts through the audited core with a CAS on the inspected
 * row and the same proof re-run inside the immediate transaction. Throws SessionFenceRefusal.
 */
export const acknowledgeSessionFence = (
  database: Database,
  input: Readonly<{ sessionId: string; actorUserId: number; actorDeviceSessionId: string | null }>,
  dependencies: ContainmentDependencies,
): SessionFenceAcknowledgement => {
  const fence = readSessionFence(database, input.sessionId);
  if (!fence) {
    if (hasOtherScopeFence(database, input.actorUserId)) throw new SessionFenceRefusal('not_session_scope');
    return { lifted: false, reason: 'not_fenced' };
  }
  const verdict = proveSessionFenceContainment(database, fence, dependencies);
  if (verdict !== 'contained') throw new SessionFenceRefusal(verdict);
  const decisionOwnerUserId = decisionOwnerOf(database, fence.decisionId);
  const device = input.actorDeviceSessionId && DEVICE_SESSION_ID.test(input.actorDeviceSessionId)
    ? input.actorDeviceSessionId : null;
  let result;
  try {
    result = liftFence(database, {
      generation: undefined,
      scopeKind: 'session',
      scopeKey: fence.scopeKey,
      reason: ACK_REASON,
      force: false,
      forceExternal: true,
      actor: `nassaj-user:${input.actorUserId}:device:${device ?? 'none'}`,
      expectedDecisionId: fence.decisionId,
      expectedCreatedAtMs: fence.createdAtMs,
      attribution: {
        path: 'session_acknowledge',
        actorUserId: input.actorUserId,
        actorDeviceSessionId: device,
        decisionOwnerUserId,
      },
      assertBeforeDelete: (transactionDatabase: Database, snapshot: { uncertainty: string[] }) => {
        if (snapshot.uncertainty.length > 0) throw new SessionFenceRefusal('not_provable');
        const recheck = proveSessionFenceContainment(transactionDatabase, fence, dependencies);
        if (recheck !== 'contained') throw new SessionFenceRefusal(recheck);
      },
    });
  } catch (error) {
    if (error instanceof SessionFenceRefusal) throw error;
    const message = error instanceof Error ? error.message : '';
    if (/^no fence/u.test(message)) return { lifted: false, reason: 'not_fenced' };
    if (/open leases or claims/u.test(message)) throw new SessionFenceRefusal('leases_open');
    // CAS lost: a different fence now holds the scope; its effects are not the ones proven.
    if (/fence changed since it was inspected/u.test(message)) throw new SessionFenceRefusal('fence_changed');
    throw error;
  }
  return {
    lifted: true,
    operationId: result.operationId,
    decisionOwnerUserId,
    completionAuditRecorded: result.completionAuditRecorded,
  };
};
