/**
 * Member self-link to the IdP (T-1939 slice 5).
 *
 * A signed-in member proves their local password, is sent to the IdP with
 * prompt=login&max_age=0, and the callback attaches the verified subject to
 * THEIR OWN account only. Nobody can link an identity to somebody else's
 * account (B-1410). This module holds the pieces of that flow that are not
 * HTTP wiring: the auth_time freshness rule, the atomic link-and-stamp write,
 * and the owner alerts. Routes live in routes/oidc.js.
 */
// Namespace import: route tests replace the database module with partial
// mocks, and a named import of an absent binding would fail at link time.
import * as databaseModule from '../modules/database/index.js';

/** A self-link sign-in must have happened at the IdP within this window. */
export const SELF_LINK_MAX_AUTH_AGE_MS = 5 * 60_000;
/** Clock skew tolerated between this server and the IdP. */
export const SELF_LINK_CLOCK_SKEW_MS = 60_000;

/**
 * Why an id_token's auth_time cannot prove a fresh sign-in for this link, or
 * null when it can. The IdP sign-in must postdate the link request (minus
 * skew) — so an existing IdP session cannot be replayed silently — and be at
 * most 5 minutes old (plus skew). A missing auth_time is always refused.
 * @param {{ authTimeMs: number | null, requestedAtMs: number, nowMs: number }} input
 * @returns {'auth_time_missing' | 'auth_time_before_request' | 'auth_time_stale' | null}
 */
export function selfLinkAuthTimeFailure({ authTimeMs, requestedAtMs, nowMs }) {
  if (!Number.isFinite(authTimeMs)) return 'auth_time_missing';
  if (authTimeMs < requestedAtMs - SELF_LINK_CLOCK_SKEW_MS) return 'auth_time_before_request';
  if (nowMs - authTimeMs > SELF_LINK_MAX_AUTH_AGE_MS + SELF_LINK_CLOCK_SKEW_MS) return 'auth_time_stale';
  return null;
}

/**
 * Inserts the link and stamps its attestation in ONE transaction, so a link
 * never exists without a fresh attestation (which the slice 3 gate would
 * otherwise treat as stale on first use). Throws on any failure, including a
 * UNIQUE violation from a concurrent link; nothing is written in that case.
 * @param {{ userId: number, issuer: string, subject: string, attestedAtMs: number }} link
 * @returns {number} the new link id
 */
export function linkIdentityWithAttestation({ userId, issuer, subject, attestedAtMs }) {
  const { getConnection, userIdentitiesDb } = databaseModule;
  return getConnection().transaction(() => {
    const identityId = userIdentitiesDb.link(userId, issuer, subject);
    if (!userIdentitiesDb.markAttested(identityId, userId, attestedAtMs)) {
      throw new Error('attestation_stamp_failed');
    }
    return identityId;
  })();
}

/** True when a thrown database error is a uniqueness conflict. */
export function isUniqueConflict(error) {
  return typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT');
}

/** Owner-alert texts by event kind (T-1939 slices 4–5). */
const OWNER_ALERT_MESSAGES = Object.freeze({
  owner_account_linked: () => 'An SSO identity was linked to your owner account. '
    + 'If this was not you, remove it in Settings → Users.',
  member_linked: (userId) => `A member (user #${userId}) linked their account to SSO. `
    + 'If this was not expected, remove the link in Settings → Users.',
  user_provisioned: (userId) => `A new account (user #${userId}) was created from an SSO sign-in. `
    + 'Review it in Settings → Users.',
});

/**
 * Direct owner alert for an SSO account event (web push when the owner
 * enabled it), beside the WARN log / audit row the caller writes. Kinds:
 * `owner_account_linked` (the owner linked their own break-glass account),
 * `member_linked` (a member self-linked) and `user_provisioned` (a JIT
 * account). Best effort; never throws or rejects. The push module is loaded
 * on demand: it is only needed on these rare paths, and loading it eagerly
 * would pull web-push into every auth import.
 * @param {number} ownerId owner to alert
 * @param {'owner_account_linked' | 'member_linked' | 'user_provisioned'} kind
 * @param {number} subjectUserId the account the event is about
 * @returns {Promise<void>}
 */
export async function notifyOwnerOfSsoEvent(ownerId, kind, subjectUserId) {
  try {
    const { createNotificationEvent, notifyUserIfEnabled } = await import('./notification-orchestrator.js');
    notifyUserIfEnabled({
      userId: ownerId,
      event: createNotificationEvent({
        provider: 'system',
        code: 'agent.notification',
        severity: 'warning',
        meta: { message: OWNER_ALERT_MESSAGES[kind](subjectUserId) },
        dedupeKey: `oidc:${kind}:${subjectUserId}`,
      }),
    });
  } catch {
    process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'oidc', code: 'owner_link_notify_failed' })}\n`);
  }
}
