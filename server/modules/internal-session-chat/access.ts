/**
 * ADR-187 access gate. Room membership NARROWS session access; it never widens it.
 *
 * Every read, send, broadcast and membership grant must also pass the platform's
 * own session predicate (ADR-089 read / isProjectWritableByUser write, ADR-172
 * membership under PROJECT_MEMBERSHIP_ENFORCE) for an active account. The
 * predicate is injected at the composition root so this module never imports the
 * provider layer; until it is configured every check fails closed.
 */
import {
  getConnection, isInternalSessionChatFlagOn, isInternalSessionChatSchemaBlocked,
} from '@/modules/database/index.js';

export type InternalChatAccessMode = 'read' | 'write';

/** Same contract as the platform session predicate (isSessionAccessibleByUser). */
export type SessionAccessPredicate = (
  sessionId: string,
  projectPath: string | null,
  userId: number,
  mode: InternalChatAccessMode,
) => boolean;

const denyAll: SessionAccessPredicate = () => false;
let sessionAccess: SessionAccessPredicate = denyAll;

/**
 * The feature serves requests only when the flag is on AND its startup migration
 * created the tables (the flag was on at boot). Toggling the flag on without a
 * restart therefore stays unavailable instead of failing with SQL errors.
 */
export function isInternalChatReady(): boolean {
  if (!isInternalSessionChatFlagOn() || isInternalSessionChatSchemaBlocked()) return false;
  return Boolean(getConnection()
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_internal_message_mentions'`)
    .get());
}

/** Installs the platform session predicate; `null` restores the fail-closed default. */
export function configureInternalChatSessionAccess(predicate: SessionAccessPredicate | null): void {
  sessionAccess = predicate ?? denyAll;
}

/**
 * True only for an ACTIVE account that the platform predicate admits to the
 * session in `mode`. Unknown sessions, disabled/deleted users and predicate
 * errors all answer false.
 */
export function canUseSession(sessionId: string, userId: number, mode: InternalChatAccessMode): boolean {
  if (!Number.isInteger(userId) || typeof sessionId !== 'string' || sessionId === '') return false;
  const row = getConnection().prepare(`SELECT s.project_path AS projectPath
    FROM sessions s JOIN users u ON u.id = ?
    WHERE s.session_id = ? AND u.is_active = 1 AND u.status = 'active'`)
    .get(userId, sessionId) as { projectPath: string | null } | undefined;
  if (!row) return false;
  try {
    return sessionAccess(sessionId, row.projectPath, userId, mode) === true;
  } catch {
    return false;
  }
}
