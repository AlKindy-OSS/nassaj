/**
 * JWT decoding utilities — client-side only, NO signature verification.
 *
 * These functions read non-secret timing claims (`exp`, `iat`) from the
 * payload segment so the client can make scheduling decisions (proactive
 * refresh, monotonic write). They NEVER throw; any malformed input yields
 * null so callers can safely use them in guard expressions.
 */

/**
 * Decode only the `exp` claim from a JWT's payload segment.
 *
 * Mirrors the decoding logic in AuthContext's `decodeTokenTimestamps`
 * (base64url → bytes → UTF-8 → JSON.parse) but returns a single number
 * (seconds since epoch) rather than the full payload. Kept in a separate
 * module so `api.js` can import it without creating a circular dependency
 * with AuthContext.
 *
 * @param {string} token
 * @returns {number | null} exp in seconds (Unix epoch), or null on any
 *   malformed / missing claim.
 */
export const decodeJwtExp = (token) => {
  try {
    const segment = token.split('.')[1];
    if (!segment) return null;
    const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4);
    const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object') return null;
    return typeof parsed.exp === 'number' ? parsed.exp : null;
  } catch {
    return null;
  }
};
