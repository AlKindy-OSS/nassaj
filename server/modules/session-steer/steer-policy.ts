/**
 * Steering policy (T-1903 / ADR-190): one global app_config value plus a
 * per-starter consent. Both are read at INJECTION time. Anything unreadable
 * resolves to "no steering" (fail-closed).
 */

// Namespace import: the realtime tests mock the database barrel partially, and a
// named import of a member such a mock omits fails ESM linking (see chat-websocket.service.ts).
import * as databaseModule from '@/modules/database/index.js';

import type { SteerPolicy, SteerPolicyMode } from '../../../shared/session-steer.contract.js';

const CONFIG_KEY = 'session_steer_policy';
const MODES: ReadonlySet<SteerPolicyMode> = new Set(['off', 'per_user']);
const DEFAULT_POLICY: SteerPolicy = { mode: 'per_user' };

/** Missing → default per_user; present but corrupt → off. */
export function getSteerPolicy(): SteerPolicy {
  let raw: string | null | undefined;
  try {
    raw = databaseModule.appConfigDb.get(CONFIG_KEY);
  } catch {
    return { mode: 'off' };
  }
  if (!raw) return { ...DEFAULT_POLICY };
  try {
    const parsed = JSON.parse(raw) as Partial<SteerPolicy> | null;
    return parsed && MODES.has(parsed.mode as SteerPolicyMode) ? { mode: parsed.mode as SteerPolicyMode } : { mode: 'off' };
  } catch {
    return { mode: 'off' };
  }
}

/** Strictly validated owner/admin write; audited with the actor and the new mode. */
export function setSteerPolicy(body: unknown, actorUserId: number | null):
  { ok: true; policy: SteerPolicy } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => key !== 'mode')
    || !MODES.has((body as SteerPolicy).mode)) {
    return { ok: false, error: "mode must be 'off' or 'per_user'" };
  }
  const policy: SteerPolicy = { mode: (body as SteerPolicy).mode };
  databaseModule.auditLogDb.recordStrict('session_steer_policy_updated', { userId: actorUserId, metadata: { mode: policy.mode } });
  databaseModule.appConfigDb.set(CONFIG_KEY, JSON.stringify(policy));
  return { ok: true, policy };
}

/** Starter consent, read fresh; any failure reads as false. */
export function getSteerConsent(userId: number | null): boolean {
  if (!Number.isSafeInteger(userId) || (userId as number) <= 0) return false;
  try {
    return databaseModule.uiPreferencesDb.getSteerConsent(userId as number);
  } catch {
    return false;
  }
}

/** Dedicated consent write: body must be exactly `{ allowSteerOnMyRuns: boolean }`. */
export function setSteerConsent(userId: number, body: unknown):
  { ok: true; allowSteerOnMyRuns: boolean } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => key !== 'allowSteerOnMyRuns')
    || typeof (body as { allowSteerOnMyRuns?: unknown }).allowSteerOnMyRuns !== 'boolean') {
    return { ok: false, error: 'allowSteerOnMyRuns must be a boolean' };
  }
  const allow = (body as { allowSteerOnMyRuns: boolean }).allowSteerOnMyRuns;
  databaseModule.auditLogDb.recordStrict('session_steer_consent_updated', { userId, metadata: { allowSteerOnMyRuns: allow } });
  databaseModule.uiPreferencesDb.setSteerConsent(userId, allow);
  return { ok: true, allowSteerOnMyRuns: allow };
}

/**
 * Policy AND consent — the single predicate every injection must pass.
 * Consent governs OTHER members steering the starter's runs; when the sender
 * IS the starter (a self-steer) only the admin policy applies.
 */
export function isSteeringAllowedFor(starterUserId: number | null, senderUserId: number | null = null):
  { allowed: true } | { allowed: false; code: 'steer_disabled' | 'steer_not_consented' } {
  if (getSteerPolicy().mode === 'off') return { allowed: false, code: 'steer_disabled' };
  const selfSteer = Number.isSafeInteger(starterUserId) && (starterUserId as number) > 0
    && senderUserId === starterUserId;
  if (!selfSteer && !getSteerConsent(starterUserId)) return { allowed: false, code: 'steer_not_consented' };
  return { allowed: true };
}
