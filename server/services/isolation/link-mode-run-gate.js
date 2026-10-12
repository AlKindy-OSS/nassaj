/**
 * link-mode-run-gate — B-1546: the async entry to the link-mode run gate for
 * spawn paths. With NASSAJ_UNIFIED_VENDOR_KEYS off it returns at once and never
 * loads the gate's readers (database, sharing policy, grants), so a spawn path
 * outside the flag keeps its exact import graph. With the flag on it delegates
 * to the one read-only gate in harness-link-mode.scope.
 */

import { isUnifiedVendorKeysEnabled } from './provider-secrets-store.js';

/**
 * Refuses a Claude/Codex spawn whose tree is in `api_key` mode with no key
 * (409 `LINK_MODE_KEY_MISSING`) or whose link-mode record or keys file is
 * unreadable (409 `LINK_MODE_RECORD_UNREADABLE`, B-1547); any other provider
 * passes.
 * @param {string|number|null|undefined} userId the run's caller
 * @param {string} provider 'claude' | 'codex' (others pass)
 * @param {{ honorGrants?: boolean }} [options] `honorGrants: false` for an env built on the caller's own tree
 * @returns {Promise<void>}
 */
export async function assertLinkModeRunAllowed(userId, provider, options = {}) {
  if (!isUnifiedVendorKeysEnabled()) return;
  // eslint-disable-next-line boundaries/dependencies -- the read-only gate leaf; the providers barrel would load the registry into every spawn path.
  const gate = await import('../../modules/providers/services/harness-link-mode.scope.js');
  gate.assertLinkModeRunAllowed(userId, provider, options);
}
