/**
 * ADR-219 S1 policy — pure decisions over server-derived facts.
 *
 * S1 relays only between sessions of the SAME user in the SAME permission-mode
 * category; everything else is refused with explicit text (P2 replaces those
 * refusals with holds). Hop is a run property capped at 4; sends are throttled
 * per sender session (20/h) and per sender user (60/h). All numbers are
 * provisional (ADR-219 "Estimate").
 */

export const PEER_HOP_MAX = 4;
export const PEER_SESSION_SENDS_PER_HOUR = 20;
export const PEER_USER_SENDS_PER_HOUR = 60;
export const PEER_QUOTA_DEFER_PERCENT = 90;
/** Provisional per-turn USD cap of a peer-woken resume turn (ح-1). */
export const PEER_TURN_MAX_BUDGET_USD = 1.5;

/** Tools a peer-woken turn may never call (ح-2 a). */
export const PEER_SCHEDULING_TOOLS = ['CronCreate', 'ScheduleWakeup', 'RemoteTrigger', 'Workflow'] as const;

/**
 * Permission-mode category (the `from-mode` attribute). `bypassPermissions`
 * runs tools without asking; `auto` lets a classifier decide; `plan` cannot act;
 * `acceptEdits` writes files without asking (qa م-1); the asking modes
 * (default, dontAsk) are `prompting`.
 */
export type PeerModeCategory = 'bypass' | 'auto' | 'plan' | 'acceptEdits' | 'prompting';

/** Maps a CLI permission mode to its relay category; unknown → prompting. */
export function modeCategory(mode: unknown): PeerModeCategory {
  if (mode === 'bypassPermissions') return 'bypass';
  if (mode === 'auto' || mode === 'plan' || mode === 'acceptEdits') return mode;
  return 'prompting';
}

export const S1_REFUSAL_TEXT = 'cross-member or mode-mismatch relay is not enabled on this node yet';

export type AclFacts = {
  senderUserId: number;
  senderMode: PeerModeCategory;
  /** Strict spawn owner of the target session, null when unresolved. */
  targetUserId: number | null;
  /** Category of the target's recorded effective mode; null when no spawn was recorded. */
  targetMode: PeerModeCategory | null;
  /** The sender may write the target's project (ADR-089 predicate). */
  senderCanWriteTarget: boolean;
};

export type AclVerdict = { ok: true } | { ok: false; cause: 'unwritable' | 'cross_user' | 'mode_unknown' | 'mode_mismatch' };

/** S1 ACL: unwritable → refused; unknown target mode → refused (fail closed); same user and category → queued. */
export function decideS1Acl(facts: AclFacts): AclVerdict {
  if (!facts.senderCanWriteTarget) return { ok: false, cause: 'unwritable' };
  if (facts.targetUserId === null || facts.targetUserId !== facts.senderUserId) return { ok: false, cause: 'cross_user' };
  if (facts.targetMode === null) return { ok: false, cause: 'mode_unknown' };
  if (facts.targetMode !== facts.senderMode) return { ok: false, cause: 'mode_mismatch' };
  return { ok: true };
}

/** The effective hop a send is computed from: max(agent origin hop, run hop) (ح-2 b, c). */
export function effectiveHop(runPeerHop: number, agentOriginHop: number): number {
  return Math.max(0, runPeerHop, agentOriginHop);
}

/** The hop a new send gets, or null when it would exceed the cap. */
export function nextHop(effective: number): number | null {
  const hop = effective + 1;
  return hop > PEER_HOP_MAX ? null : hop;
}

/** True while scheduling tools must be denied (a peer-woken run, or an agent born in one). */
export function schedulingDenied(effective: number): boolean {
  return effective > 0;
}

export type ThrottleCounts = { sessionLastHour: number; userLastHour: number };

/** True when another send would exceed a throttle. */
export function isThrottled(counts: ThrottleCounts): boolean {
  return counts.sessionLastHour >= PEER_SESSION_SENDS_PER_HOUR || counts.userLastHour >= PEER_USER_SENDS_PER_HOUR;
}

/** Highest utilization (percent) over the usage windows that gate a turn; null when unknown. */
export function quotaPercent(windows: ReadonlyArray<{ utilization: number } | null | undefined>): number | null {
  const values = windows.filter((w): w is { utilization: number } => Boolean(w) && Number.isFinite(w!.utilization))
    .map((w) => w.utilization);
  return values.length > 0 ? Math.max(...values) : null;
}

/** Charge of a peer turn: last total minus the baseline, clamped at ≥ 0; null when unmeasurable. */
export function chargeFromTotals(lastTotal: number | null, baseline: number | null): number | null {
  if (lastTotal === null || !Number.isFinite(lastTotal) || baseline === null || !Number.isFinite(baseline)) return null;
  const delta = lastTotal - baseline;
  return delta >= 0 ? delta : null;
}
