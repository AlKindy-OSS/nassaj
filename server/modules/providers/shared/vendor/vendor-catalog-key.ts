import { credentialPrincipalId } from '@/services/isolation/credential-principal.js';
import { resolveSlotKey } from '@/services/isolation/provider-slot-key.js';
import {
  ANONYMOUS_CATALOG_IDENTITY,
  type CatalogIdentity,
} from '@/modules/providers/shared/vendor/vendor-catalog.client.js';

/**
 * Resolves the key a vendor's LIVE model catalog should be fetched with: the
 * asking member's own key, or their grantor's (ADR-152). A key that is good
 * enough to SPEND is good enough to ENUMERATE, so this answers exactly what the
 * run path answers (B-436).
 *
 * ADR-152 A1 §3.8 (D1): the install-wide slot is inert. A member with no key and
 * no grant gets `null`, and so does a caller with no member; the caller then
 * serves its built-in fallback flagged `degraded`.
 *
 * Fail-soft by construction: any throw from the store degrades to `null`.
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
    if (member === null) return null;
    return resolveSlotKey(credentialPrincipalId(member, provider), provider)?.key ?? null;
  } catch {
    // Fail-soft is this site's own contract, not the resolver's: a bad scope
    // must degrade to the built-in fallback catalog, never surface as a 500.
    return null;
  }
}
