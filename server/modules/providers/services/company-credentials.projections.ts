/**
 * company-credentials.projections — ADR-200 S9 (in-flag `NASSAJ_UNIFIED_VENDOR_KEYS`):
 * the read-only per-harness state of one company key, for the badge row the
 * vendor card shows after a reload (`GET /company/:companyId/key` → `projections`).
 *
 * Sources, cheapest first, and nothing else:
 *   - the slot's scope: a shared tree is never written by a member's key (D6),
 *     so it reads `shared_scope_refused` (the fan-out's own precedence);
 *   - the caller's OWN ledger for the vendor (one sealed read per request):
 *     `synced` → `linked` (or `adopted` when the migration adopted it),
 *     `stale` / `failed` / `tombstone` as they are;
 *   - for Claude/Codex with no ledger entry, the stored link mode (one record
 *     read; derived from the harness files only when no record exists):
 *     subscription → `kept_on_subscription`, none → `mode_unset`;
 *   - an AES-only slot (kimi, glm, qwen, deepseek) that is configured → `linked`.
 * A slot with none of these is omitted; `login_present` and
 * `foreign_credential` need a harness-file comparison and come from a Save only.
 *
 * Never carries a key value or a fingerprint.
 */

import * as store from '@/services/isolation/provider-secrets-store.js';
import { isProviderIsolated } from '@/services/provider-sharing.js';

import type { LinkHarness } from './harness-credential-inventory.js';
import { deriveDefaultLinkMode, type LinkMode } from './harness-link-mode.policy.js';
import { linkModeScopeDeps } from './harness-link-mode.scope.js';
import { isLinkModeHarness } from './harness-link-mode.service.js';
import type { LedgerEntry } from './vendor-key-migration.service.js';

export type ProjectionState =
  | 'linked'
  | 'stale'
  | 'failed'
  | 'tombstone'
  | 'adopted'
  | 'foreign_credential'
  | 'kept_on_subscription'
  | 'login_present'
  | 'shared_scope_refused'
  | 'mode_unset';

export type CompanyProjection = { vendorId: string; provider: string; target?: string; state: ProjectionState };

/** One company slot as the status view knows it. */
export type ProjectionSlot = { vendorId: string; provider: string; target?: string; configured: boolean };

type Member = string | number;

/** What the derivation reads; production-bound below, fakes in tests. */
export type ProjectionReadDeps = {
  /** The member's ledger entries for a vendor; [] when absent, null when unreadable. */
  readLedger(userId: Member, vendorId: string): readonly LedgerEntry[] | null;
  /** True when the harness writes the member's own tree. */
  isOwnScope(provider: string): boolean;
  /** The effective stored-or-derived mode; 'unreadable' when the record cannot be read. */
  readLinkMode(userId: Member | null, harness: LinkHarness): LinkMode | null | 'unreadable';
};

const PROJECTION_PROVIDERS: readonly string[] = ['claude', 'codex', 'opencode'];

const LEDGER_STATE: Record<LedgerEntry['state'], ProjectionState> = {
  synced: 'linked',
  stale: 'stale',
  failed: 'failed',
  tombstone: 'tombstone',
};

function isMember(userId: unknown): userId is Member {
  return userId !== null && userId !== undefined && userId !== '';
}

function sameTarget(entry: LedgerEntry, provider: string, target: string | undefined): boolean {
  return entry.harness === provider && (entry.target ?? null) === (target ?? null);
}

function fromLedger(entry: LedgerEntry): ProjectionState {
  return entry.state === 'synced' && entry.origin === 'adopted' ? 'adopted' : LEDGER_STATE[entry.state];
}

function fromLinkMode(mode: LinkMode | null | 'unreadable'): ProjectionState | null {
  if (mode === 'subscription') return 'kept_on_subscription';
  return mode === null ? 'mode_unset' : null;
}

/** The state of one projection slot (claude/codex/opencode), or null when nothing is known. */
function projectionState(
  deps: ProjectionReadDeps,
  userId: Member | null,
  slot: ProjectionSlot,
  ledger: readonly LedgerEntry[],
): ProjectionState | null {
  if (!deps.isOwnScope(slot.provider)) return 'shared_scope_refused';
  const entry = ledger.find((candidate) => sameTarget(candidate, slot.provider, slot.target));
  if (entry) return fromLedger(entry);
  return isLinkModeHarness(slot.provider) ? fromLinkMode(deps.readLinkMode(userId, slot.provider)) : null;
}

function toProjection(vendorId: string, provider: string, target: string | null | undefined, state: ProjectionState): CompanyProjection {
  return { vendorId, provider, ...(target ? { target } : {}), state };
}

/**
 * The caller's projections for one company. Ledger entries with no matching
 * slot (a projection the catalogue lists beyond the company's slots) are kept,
 * named by the company id, so a tombstone is never hidden.
 */
export function deriveCompanyProjections(
  deps: ProjectionReadDeps,
  userId: Member | null | undefined,
  companyId: string,
  slots: readonly ProjectionSlot[],
): CompanyProjection[] {
  const member = isMember(userId) ? userId : null;
  const ledger = member === null ? [] : (deps.readLedger(member, companyId) ?? []);
  const projections: CompanyProjection[] = [];
  for (const slot of slots) {
    const state = PROJECTION_PROVIDERS.includes(slot.provider)
      ? projectionState(deps, member, slot, ledger)
      : (slot.configured ? 'linked' : null);
    if (state) projections.push(toProjection(slot.vendorId, slot.provider, slot.target, state));
  }
  for (const entry of ledger) {
    if (slots.some((slot) => sameTarget(entry, slot.provider, slot.target))) continue;
    projections.push(toProjection(companyId, entry.harness, entry.target, fromLedger(entry)));
  }
  return projections;
}

/** The record if readable, else the H1 derivation from the harness files when none exists. */
function readLinkMode(userId: Member | null, harness: LinkHarness): LinkMode | null | 'unreadable' {
  try {
    const stored = linkModeScopeDeps.readRecordState(linkModeScopeDeps.treeOwner(userId, harness), harness);
    if (stored.state === 'unreadable') return 'unreadable';
    if (stored.state === 'ok') return stored.record.mode;
    return deriveDefaultLinkMode(linkModeScopeDeps.readInventory(userId, harness));
  } catch {
    return 'unreadable';
  }
}

/** Production reads: the AES store, the sharing policy and the link-mode scope. */
export const projectionReadDeps: ProjectionReadDeps = {
  readLedger(userId, vendorId) {
    try {
      const read = store.readVendorLedgerState(userId, vendorId);
      if (read.state === 'unreadable') return null;
      return read.state === 'ok' ? read.ledger.entries as LedgerEntry[] : [];
    } catch {
      return null;
    }
  },
  isOwnScope: (provider) => isProviderIsolated(provider),
  readLinkMode,
};
