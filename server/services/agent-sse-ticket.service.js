import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 45_000;
const MAX_TTL_MS = 60_000;
const ticketsByDigest = new Map();

function digestTicket(rawTicket) {
  return crypto.createHash('sha256').update(rawTicket, 'utf8').digest('hex');
}

function removeExpiredTickets(now) {
  for (const [digest, ticket] of ticketsByDigest) {
    if (ticket.expiresAt <= now) ticketsByDigest.delete(digest);
  }
}

/**
 * Mint a short-lived, one-shot credential for the agent SSE endpoint.
 * Only its SHA-256 digest is retained; the bearer value is returned once.
 */
export function mintAgentSseTicket({
  userId,
  role,
  authorizationGeneration,
  authenticationCredentialId,
  path,
  method = 'POST',
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
}) {
  if (!Number.isInteger(userId) || userId <= 0) throw new TypeError('A valid user is required');
  if (!['owner', 'admin', 'user'].includes(role)
    || !Number.isSafeInteger(authorizationGeneration) || authorizationGeneration <= 0
    || typeof authenticationCredentialId !== 'string' || !authenticationCredentialId) {
    throw new TypeError('A canonical API-key actor is required');
  }
  if (typeof path !== 'string' || !path.startsWith('/')) throw new TypeError('A valid path is required');

  const boundedTtlMs = Math.min(Math.max(Number(ttlMs) || DEFAULT_TTL_MS, 1), MAX_TTL_MS);
  const rawTicket = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + boundedTtlMs;
  removeExpiredTickets(now);
  ticketsByDigest.set(digestTicket(rawTicket), {
    userId,
    role,
    authorizationGeneration,
    authenticationCredentialId,
    path,
    method: String(method).toUpperCase(),
    expiresAt,
  });
  return { ticket: rawTicket, expiresAt };
}

/**
 * Atomically consume an SSE ticket. Every presented valid digest is removed
 * before its bindings are checked, so replay and concurrent reuse fail closed.
 */
export function consumeAgentSseTicket(rawTicket, {
  path,
  method = 'POST',
  userId,
  now = Date.now(),
}) {
  if (typeof rawTicket !== 'string' || rawTicket.length < 32 || rawTicket.length > 256) {
    return { ok: false, code: 'invalid' };
  }

  const digest = digestTicket(rawTicket);
  const ticket = ticketsByDigest.get(digest);
  ticketsByDigest.delete(digest);
  removeExpiredTickets(now);
  if (!ticket) return { ok: false, code: 'invalid' };
  if (ticket.expiresAt <= now) return { ok: false, code: 'expired' };
  if (ticket.path !== path || ticket.method !== String(method).toUpperCase()) {
    return { ok: false, code: 'wrong_target' };
  }
  if (userId !== undefined && ticket.userId !== userId) {
    return { ok: false, code: 'wrong_user' };
  }
  return {
    ok: true,
    userId: ticket.userId,
    role: ticket.role,
    authorizationGeneration: ticket.authorizationGeneration,
    authenticationCredentialId: ticket.authenticationCredentialId,
  };
}

/** Test-only reset; never exposes bearer values. */
export function resetAgentSseTicketsForTests() {
  ticketsByDigest.clear();
}

/** Test-only metadata snapshot proving only digests are retained. */
export function getAgentSseTicketSnapshotForTests() {
  return [...ticketsByDigest.entries()].map(([digest, ticket]) => ({ digest, ...ticket }));
}
