/**
 * ADR-219 S1 policy — pure decisions over server-derived facts.
 *
 * S1 relays only between sessions of the SAME user in the SAME permission-mode
 * category; P2a-min (decideIntake) holds a cross-member send whose modes match
 * for the target owner's approval, and refuses everything else with explicit text. Hop is a run property capped at 4; sends are throttled
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

/** ADR-219 P2a-min: a held row (and an approved, undelivered one) lives 72 h. */
export const PEER_HOLD_TTL_MS = 72 * 60 * 60 * 1000;

/** م-7 overflow caps: held rows per target user, per sender within it, per session pair. */
export const PEER_HOLD_LIMITS = { perTargetUser: 50, perSenderWithinTarget: 10, perSessionPair: 10 } as const;

export type IntakeFacts = AclFacts & {
  /** IS_PLATFORM: every session authenticates as the first user, so a target owner cannot be told apart. */
  platform: boolean;
};

export type IntakeVerdict =
  | { kind: 'queue' }
  | { kind: 'hold'; causes: 'cross_member' }
  | { kind: 'refuse'; cause: 'unwritable' | 'owner_unknown' | 'cross_user' | 'mode_unknown' | 'mode_mismatch' };

/**
 * P2a-min intake (§4): same user keeps the S1 rule; a cross-member send whose
 * modes match is HELD for the target owner; a mode mismatch stays refused (P2c
 * holds it); a null owner is `owner_unknown`; under IS_PLATFORM cross-member keeps
 * the S1 refusal.
 */
export function decideIntake(facts: IntakeFacts): IntakeVerdict {
  if (!facts.senderCanWriteTarget) return { kind: 'refuse', cause: 'unwritable' };
  if (facts.targetUserId === null) return { kind: 'refuse', cause: 'owner_unknown' };
  const crossMember = facts.targetUserId !== facts.senderUserId;
  if (crossMember && facts.platform) return { kind: 'refuse', cause: 'cross_user' };
  if (facts.targetMode === null) return { kind: 'refuse', cause: 'mode_unknown' };
  if (facts.targetMode !== facts.senderMode) return { kind: 'refuse', cause: 'mode_mismatch' };
  return crossMember ? { kind: 'hold', causes: 'cross_member' } : { kind: 'queue' };
}
