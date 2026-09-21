import { credentialPrincipalId } from '@/services/isolation/credential-principal.js';
import { resolveSlotKey } from '@/services/isolation/provider-slot-key.js';
import {
  ANONYMOUS_CATALOG_IDENTITY,
  type CatalogIdentity,
} from '@/modules/providers/shared/vendor/vendor-catalog.client.js';

/**
 * Resolves the key a vendor's LIVE model catalog should be fetched with — the
 * asking member's own key first, the org key second.
 *
 * WHY THE ORG FALLBACK BELONGS HERE (B-436). It already exists on the RUN path:
 * `apply-claude-engine-provider-env.js` resolves the member's key then the org's
 * (T-1208). The catalog path did not, and the two paths disagreeing produced a
 * failure that reads as a missing feature rather than a missing key:
 *
 *   member WITH a personal key   → 8 GLM models listed
 *   member WITHOUT one           → 1 (the built-in fallback), yet their turns
 *                                  still RUN on glm via the org key
 *
 * So the picker offered exactly one model — the one already selected — and every
 * other row in it belonged to a different engine. The member could not change
 * model without also changing vendor, and nothing on screen explained why.
 * Measured 2026-08-05 on the live store: user 1 → 8, user 2 → 1, no identity → 1.
 *
 * The two paths must answer the same question the same way: a key that is good
 * enough to SPEND is good enough to ENUMERATE. Diverging is what made a listing
 * bug look like a vendor limitation.
 *
 * Fail-soft by construction: any throw from the store degrades to the org key,
 * and a missing org key degrades to `null` — the caller then serves its built-in
 * fallback flagged `degraded`, exactly as before.
 */
export function resolveVendorCatalogKey(
  identity: CatalogIdentity | null | undefined,
  // The store types this as its own VendorProvider union; the catalog clients
  // pass their literal provider id, so the cast stays at this single seam rather
  // than at each of the three call sites.
  provider: Parameters<typeof resolveSlotKey>[1],
): string | null {
  // '' and the anonymous bucket are both "no member asked" — neither is a member
  // id, and neither may reach the store, which throws on an implicit scope by
  // design (B-342).
  const member =
    identity === null
    || identity === undefined
    || identity === ''
    || identity === ANONYMOUS_CATALOG_IDENTITY
      ? null
      : identity;

  try {
    return resolveSlotKey(credentialPrincipalId(member, provider), provider, { sharedFallback: true })?.key ?? null;
  } catch {
    // Fail-soft is this site's own contract, not the resolver's: a bad scope
    // must degrade to the built-in fallback catalog, never surface as a 500.
    return null;
  }
}
