/**
 * The interactive-credential allowlist (ADR-219 P2 §2 ح-3, ش-1): the only
 * authentication kinds that may take a consent decision or lift a permission
 * fence. `session` is a verified bearer, `device_session` a wallet cookie (its
 * mutations already passed the Origin + CSRF guard in authenticateToken).
 * Everything else — `ck` API keys (the owner's own included), `verified_proxy`,
 * `internal_service`, `platform_unverified`, `password_change` — is refused.
 * One module: the fence routes and every P2 write route import it; no copies.
 */

export const VERIFIED_ACTOR_KINDS: ReadonlySet<string> = new Set(['session', 'device_session']);

/** True only for an interactive, verified credential kind. */
export function isVerifiedActorKind(kind: unknown): boolean {
  return typeof kind === 'string' && VERIFIED_ACTOR_KINDS.has(kind);
}
