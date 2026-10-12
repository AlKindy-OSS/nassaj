/**
 * harness-link-mode.scope — ADR-200 S4 / B-1546: the light, read-only half of
 * the link-mode production wiring — the flag, the record and inventory readers
 * and the tree-scope resolution. Shared by the full service wiring
 * (harness-link-mode.runtime) and the run gate, so the scope rules exist once
 * and the run gate never pulls the provider registry into a spawn path.
 */

import {
  isUnifiedVendorKeysEnabled,
  readLinkModeRecordState,
} from '@/services/isolation/provider-secrets-store.js';
import { credentialPrincipalId } from '@/services/isolation/credential-principal.js';
import { isProviderIsolated } from '@/services/provider-sharing.js';

import { readHarnessCredentialInventory, type LinkHarness } from './harness-credential-inventory.js';
import { normalizeLinkModeRecord } from './harness-link-mode.policy.js';
import {
  assertLinkModeRunAllowed as assertRunAllowedWith,
  isLinkModeHarness,
  type LinkModeRecordState,
  type LinkModeRunDeps,
  type LinkModeRunOptions,
} from './harness-link-mode.service.js';

/**
 * G1 H-1: on a SHARED harness every member's writer lands in the operator's
 * ~/.claude or ~/.codex, so the link mode, its lock and its grantee count
 * belong to the operator tree, not to whoever is calling.
 */
function treeOwner(userId: string | number | null | undefined, harness: LinkHarness): string | number | null {
  if (userId === null || userId === undefined || userId === '') return null;
  return isProviderIsolated(harness) ? userId : null;
}

/** A run honours credential grants (T-1675): a grantee runs on the grantor's tree. */
function runPrincipal(userId: string | number | null | undefined, harness: LinkHarness): string | number | null | undefined {
  return credentialPrincipalId(userId, harness);
}

/**
 * B-1547: the stored record with its read state. A decrypted payload that is
 * not a valid record is `unreadable` too, never "absent".
 */
function readRecordState(userId: string | number | null | undefined, harness: LinkHarness): LinkModeRecordState {
  const read = readLinkModeRecordState(userId, harness);
  if (read.state === 'absent') return { state: 'absent' };
  if (read.state === 'unreadable') return read.store === true ? { state: 'unreadable', store: true } : { state: 'unreadable' };
  const record = normalizeLinkModeRecord(read.record);
  return record ? { state: 'ok', record } : { state: 'unreadable' };
}

/** The read-only link-mode dependencies, production-bound. */
export const linkModeScopeDeps: LinkModeRunDeps = {
  isEnabled: () => isUnifiedVendorKeysEnabled(),
  readInventory: readHarnessCredentialInventory,
  readRecordState,
  treeOwner,
  runPrincipal,
};

/**
 * B-1546: refuses a Claude/Codex spawn whose tree is in `api_key` mode with no
 * key behind it (409 `LINK_MODE_KEY_MISSING`) or whose record is unreadable
 * (409 `LINK_MODE_RECORD_UNREADABLE`, B-1547). Any other provider, and the flag
 * off, pass through untouched. Synchronous and read-only. Pass
 * `honorGrants: false` only for a spawn whose env was built with grants off.
 */
export function assertLinkModeRunAllowed(
  userId: string | number | null | undefined,
  provider: string,
  options: LinkModeRunOptions = {},
): void {
  if (!isLinkModeHarness(provider)) return;
  assertRunAllowedWith(linkModeScopeDeps, userId, provider, options);
}
