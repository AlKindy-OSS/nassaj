/**
 * vendor-key-fanout.service — ADR-200 S6 (in-flag `NASSAJ_UNIFIED_VENDOR_KEYS`):
 * one vendor key, saved once, projected into every harness file its link mode
 * allows, and removed again by fingerprint only.
 *
 *   - **Save** (§3): refuse a Claude subscription token (L2); write the AES
 *     record; per `cli_file` consumer, under its (user, harness) gate (backup,
 *     link mode, lock): read, check ownership, write, re-read and verify (L4),
 *     then update the ledger. Every slot reports one outcome.
 *   - **Ownership** (§2): only a projection whose on-disk value matches its
 *     ledger fingerprint is replaced or removed. Any other value is
 *     `foreign_credential` and is touched only with an explicit confirm. An
 *     `adopted` projection may be replaced, but is removed only on confirm.
 *   - **Delete** (§6): the vendor is marked deleted (so the migration never
 *     adopts it back from a file a confirm-less delete left, G2), the removable
 *     projections become ledger tombstones, then the AES record goes, then the
 *     tombstones are drained. A removal that fails stays a tombstone, so the
 *     ledger outlives the key until the retry sweep drains it. A Save clears
 *     the deletion marker.
 *   - **Rotation** is the same Save. The sweep at server start retries `failed`
 *     and `stale` entries and drains tombstones; an AES record that does not
 *     decrypt is skipped, never read as a deleted key.
 *
 * Shared trees are never written (§3 outcome `shared_scope_refused`). No key
 * value is ever returned, logged, or put in an error or ledger entry.
 */

import { assertNotClaudeSubscriptionToken } from '@/modules/providers/shared/credentials/subscription-token-guard.js';
import { AppError } from '@/shared/utils.js';

import { VENDOR_KEY_CATALOGUE } from '../../../../shared/vendors.js';

import {
  clearVendorDeleted,
  findEntry,
  markVendorDeleted,
  readLedgerEntries,
  updateLedger,
  withEntry,
  withoutEntry,
} from './vendor-key-fanout.ledger.js';
import {
  MIGRATION_VENDORS,
  type FileConsumer,
  type ProjectionHarness,
} from './vendor-key-migration.inventory.js';
import type { LedgerEntry } from './vendor-key-migration.service.js';

type Member = string | number;

/** One company slot as the caller names it (the `VENDORS` slot of a vendor id). */
export type FanoutSlot = { vendorId: string; provider: string; target?: string };

/** §3 Save outcomes, plus S4's `mode_unset` (no mode chosen yet). */
export type ProjectionOutcome =
  | 'linked'
  | 'kept_on_subscription'
  | 'mode_unset'
  | 'login_present'
  | 'shared_scope_refused'
  | 'foreign_credential'
  | 'forbidden'
  | 'failed';

/** §6 Delete outcomes. `failed` = left as a tombstone for the retry sweep. */
export type RemovalOutcome =
  | 'removed'
  | 'absent'
  | 'adopted_credential'
  | 'foreign_credential'
  | 'shared_scope_refused'
  | 'forbidden'
  | 'failed';

export type FanoutSlotResult = FanoutSlot & {
  outcome: ProjectionOutcome | RemovalOutcome;
  /** The refusal code behind a decided outcome or a failure; never a key. */
  code?: string;
  /** Present only for `failed`: a key-free message. */
  error?: string;
};

export type FanoutAuditContext = { ipAddress?: string | null; userAgent?: string | null };

/** The harness side: gates and the raw writer, bound to production in the runtime. */
export type ProjectionPort = {
  /** Runs `work` under the write gate (backup, link-mode refusal, (user, harness) lock). */
  withWriteGate<T>(userId: Member, provider: string, key: string, work: () => Promise<T>): Promise<T>;
  /** Runs `work` under the delete gate (backup, (user, harness) lock; the mode is kept, D6). */
  withDeleteGate<T>(userId: Member, provider: string, work: () => Promise<T>): Promise<T>;
  /** The API key now at the target, or null. Throws when the file cannot be read. */
  read(userId: Member, provider: string, target: string | undefined): Promise<string | null>;
  write(userId: Member, provider: string, key: string, target: string | undefined, principal: unknown): Promise<void>;
  remove(userId: Member, provider: string, target: string | undefined): Promise<void>;
};

/** The canonical AES record of a vendor (`vendor:*` or a legacy slot id). */
export type CanonicalSecretPort = {
  /** Writes and verifies the record; throws when it cannot be verified. */
  write(userId: Member, secretId: string, key: string, auditContext?: FanoutAuditContext): void;
  remove(userId: Member, secretId: string, auditContext?: FanoutAuditContext): void;
  /** The record with its state: `unreadable` (does not decrypt) is never read as absent (G2). */
  readState(userId: Member, secretId: string): { state: 'absent' | 'unreadable' } | { state: 'ok'; value: string };
};

export type VendorKeyFanoutDeps = {
  isEnabled(): boolean;
  fingerprint(value: string, keyVersion: number): string;
  keyVersion: number;
  now(): Date;
  listMemberIds(): Member[];
  /** True when the harness writes the member's own tree (isolated), false for a shared tree. */
  isOwnScope(provider: string): boolean;
  /** The route's role rule: a shared-scoped provider needs owner/admin. */
  requiresElevatedRole(provider: string): boolean;
  projections: ProjectionPort;
  secrets: CanonicalSecretPort;
  /** One row per save and per delete: vendor and per-slot outcomes, never a key. */
  audit(
    userId: Member,
    action: 'vendor_key_saved' | 'vendor_key_deleted',
    metadata: Record<string, unknown>,
    context?: FanoutAuditContext,
  ): void;
};

export type FanoutSaveOptions = {
  isElevated: boolean;
  /** Explicit confirm to replace a value nassaj does not own. */
  replaceForeignKey?: boolean;
  authenticatedPrincipal?: unknown;
  auditContext?: FanoutAuditContext;
  /** The slots to report on; projections are written only for these. */
  slots: readonly FanoutSlot[];
};

export type FanoutRemoveOptions = {
  isElevated: boolean;
  /** Explicit confirm to remove adopted and foreign projections too. */
  removeForeignKey?: boolean;
  auditContext?: FanoutAuditContext;
  /** Every slot of the company, for the report; the removal itself is vendor-wide (§6). */
  slots: readonly FanoutSlot[];
};

/** A link-mode or writer refusal that is a decision, not a broken write. */
const DECIDED: Record<string, ProjectionOutcome> = {
  LINK_MODE_SUBSCRIPTION: 'kept_on_subscription',
  LINK_MODE_UNSET: 'mode_unset',
  CREDENTIAL_IS_LOGIN: 'login_present',
  CREDENTIAL_SHARED_SCOPE_REFUSED: 'shared_scope_refused',
};

const PROJECTION_PROVIDERS: readonly string[] = ['claude', 'codex', 'opencode'];

type SaveContext = {
  deps: VendorKeyFanoutDeps;
  userId: Member;
  vendorId: string;
  key: string;
  isElevated: boolean;
  replaceForeignKey: boolean;
  principal: unknown;
  /** B-1575: a background retry, where an empty target is not always nassaj's to fill. */
  sweepRetry?: boolean;
};

function fanoutError(code: string, message: string, statusCode = 409): AppError {
  return new AppError(message, { code, statusCode });
}

function codeOf(error: unknown): string | undefined {
  return error instanceof AppError ? error.code : undefined;
}

/** A key-free message: AppError messages are written for users; anything else is generic. */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback;
}

function isMember(userId: unknown): userId is Member {
  return userId !== null && userId !== undefined && userId !== '';
}

/** The projection a slot names, or null for an AES-only slot (kimi, glm, qwen, deepseek). */
export function slotPair(slot: FanoutSlot): FileConsumer | null {
  if (!PROJECTION_PROVIDERS.includes(slot.provider)) return null;
  return { harness: slot.provider as ProjectionHarness, target: slot.target ?? null };
}

function vendorRow(vendorId: string): { id: string; secretId: string } {
  const row = VENDOR_KEY_CATALOGUE.find((entry) => entry.id === vendorId);
  if (!row) throw fanoutError('UNKNOWN_VENDOR', `Unknown vendor "${vendorId}".`, 404);
  return row;
}

function matchesEntry(deps: VendorKeyFanoutDeps, entry: LedgerEntry | undefined, value: string): boolean {
  return Boolean(entry) && deps.fingerprint(value, entry!.keyVersion) === entry!.fingerprint;
}

function unverified(): AppError {
  return fanoutError('VENDOR_KEY_PROJECTION_UNVERIFIED', 'The harness file did not hold the expected key after the change.', 500);
}

/**
 * The role gate, then the shared-tree refusal (§3 outcome `shared_scope_refused`);
 * null when the slot may be written. Decided before the link mode, so a shared
 * tree reports `shared_scope_refused`, not `kept_on_subscription` (precedence
 * pending an owner decision; behaviour unchanged by G2).
 */
function scopeRefusal(
  deps: VendorKeyFanoutDeps,
  provider: string,
  isElevated: boolean,
): 'forbidden' | 'shared_scope_refused' | null {
  if (deps.requiresElevatedRole(provider) && !isElevated) return 'forbidden';
  return deps.isOwnScope(provider) ? null : 'shared_scope_refused';
}

function newEntry(ctx: SaveContext, pair: FileConsumer, state: LedgerEntry['state'], origin: LedgerEntry['origin']): LedgerEntry {
  return {
    harness: pair.harness,
    target: pair.target,
    fingerprint: ctx.deps.fingerprint(ctx.key, ctx.deps.keyVersion),
    keyVersion: ctx.deps.keyVersion,
    state,
    origin,
    updatedAt: ctx.deps.now().toISOString(),
  };
}

/**
 * B-1575: in a sweep retry an empty target is nassaj's to refill only when
 * nassaj's own write failed there. A `stale` or adopted entry whose file is now
 * empty means the user removed the key; the entry is released, not rewritten.
 */
function retryMayFillEmpty(entry: LedgerEntry | undefined): boolean {
  return entry?.state === 'failed' && entry.origin === 'fanout';
}

/**
 * Inside the write gate: ownership check, write, re-read, ledger. `current ===
 * key` writes nothing; an unledgered equal value is recorded as `adopted`
 * because nassaj did not write it.
 */
async function projectLocked(
  ctx: SaveContext,
  slot: FanoutSlot,
  pair: FileConsumer,
): Promise<ProjectionOutcome | 'absent'> {
  const { deps, userId, key } = ctx;
  const current = await deps.projections.read(userId, slot.provider, slot.target);
  const entry = findEntry(readLedgerEntries(userId, ctx.vendorId), pair);
  if (current === null && ctx.sweepRetry && !retryMayFillEmpty(entry)) {
    updateLedger(userId, ctx.vendorId, (entries) => withoutEntry(entries, pair));
    return 'absent';
  }
  const owned = current === null || current === key || matchesEntry(deps, entry, current);
  if (!owned && !ctx.replaceForeignKey) return 'foreign_credential';
  const wrote = current !== key;
  if (wrote) await deps.projections.write(userId, slot.provider, key, slot.target, ctx.principal);
  if (await deps.projections.read(userId, slot.provider, slot.target) !== key) throw unverified();
  let origin: LedgerEntry['origin'] = 'fanout';
  if (!wrote && entry?.state !== 'failed') origin = entry && matchesEntry(deps, entry, key) ? entry.origin : 'adopted';
  updateLedger(userId, ctx.vendorId, (entries) => withEntry(entries, newEntry(ctx, pair, 'synced', origin)));
  return 'linked';
}

/** A write that broke: the entry keeps its old fingerprint (still the owned value) and turns `failed`. */
function markFailed(ctx: SaveContext, pair: FileConsumer): void {
  try {
    updateLedger(ctx.userId, ctx.vendorId, (entries) => {
      const entry = findEntry(entries, pair);
      const failed = entry
        ? { ...entry, state: 'failed' as const, updatedAt: ctx.deps.now().toISOString() }
        : newEntry(ctx, pair, 'failed', 'fanout');
      return withEntry(entries, failed);
    });
  } catch {
    // An unreadable ledger cannot record the failure; the slot still reports `failed`.
  }
}

/** Projects the key into one slot; never throws. */
async function projectSlot(ctx: SaveContext, slot: FanoutSlot, pair: FileConsumer): Promise<FanoutSlotResult> {
  const refused = scopeRefusal(ctx.deps, slot.provider, ctx.isElevated);
  if (refused) return { ...slot, outcome: refused };
  try {
    const outcome = await ctx.deps.projections.withWriteGate(
      ctx.userId, slot.provider, ctx.key, () => projectLocked(ctx, slot, pair),
    );
    return { ...slot, outcome };
  } catch (error) {
    const code = codeOf(error);
    const decided = code ? DECIDED[code] : undefined;
    if (decided) return { ...slot, outcome: decided, code };
    markFailed(ctx, pair);
    const message = messageOf(error, 'The key could not be written to this harness.');
    return { ...slot, outcome: 'failed', error: message, ...(code ? { code } : {}) };
  }
}

type RemoveContext = {
  deps: VendorKeyFanoutDeps;
  userId: Member;
  vendorId: string;
  confirm: boolean;
};

/** A slot standing for `pair` in the caller's list, or a synthetic one. */
function slotFor(slots: readonly FanoutSlot[], vendorId: string, pair: FileConsumer): FanoutSlot {
  const match = slots.find((slot) => {
    const candidate = slotPair(slot);
    return candidate !== null && candidate.harness === pair.harness && candidate.target === pair.target;
  });
  return match ?? { vendorId, provider: pair.harness, ...(pair.target ? { target: pair.target } : {}) };
}

/**
 * Phase 1 of a delete, for one projection: decide, and mark what will be
 * removed as a tombstone (an intent that survives a crash or restart). Returns
 * a final outcome, or `pending` when a tombstone now waits for the drain.
 */
async function markForRemoval(ctx: RemoveContext, slot: FanoutSlot, pair: FileConsumer): Promise<RemovalOutcome | 'pending'> {
  const { deps, userId } = ctx;
  const entry = findEntry(readLedgerEntries(userId, ctx.vendorId), pair);
  let current: string | null;
  try {
    current = await deps.projections.read(userId, slot.provider, slot.target);
  } catch {
    if (!entry || (entry.origin === 'adopted' && !ctx.confirm)) return 'failed';
    return tombstone(ctx, entry);
  }
  if (current === null) {
    if (entry) updateLedger(userId, ctx.vendorId, (entries) => withoutEntry(entries, pair));
    return 'absent';
  }
  const owned = matchesEntry(deps, entry, current);
  if (owned && entry!.origin === 'adopted' && !ctx.confirm) return 'adopted_credential';
  if (!owned && !ctx.confirm) {
    // The value is no longer the one nassaj recorded: forget the stale entry, leave the file.
    if (entry) updateLedger(userId, ctx.vendorId, (entries) => withoutEntry(entries, pair));
    return 'foreign_credential';
  }
  const fingerprint = owned ? entry!.fingerprint : deps.fingerprint(current, deps.keyVersion);
  const keyVersion = owned ? entry!.keyVersion : deps.keyVersion;
  const origin = entry?.origin ?? 'fanout';
  return tombstone(ctx, { ...pair, fingerprint, keyVersion, origin, state: 'tombstone', updatedAt: '' });
}

function tombstone(ctx: RemoveContext, entry: LedgerEntry): 'pending' {
  const marked: LedgerEntry = { ...entry, state: 'tombstone', updatedAt: ctx.deps.now().toISOString() };
  updateLedger(ctx.userId, ctx.vendorId, (entries) => withEntry(entries, marked));
  return 'pending';
}

/**
 * Drains one tombstone under the delete gate: the file value is removed only
 * while it still matches the tombstone's fingerprint. Never throws; a failure
 * keeps the tombstone for the sweep.
 */
async function drainTombstone(
  deps: VendorKeyFanoutDeps,
  userId: Member,
  vendorId: string,
  slot: FanoutSlot,
  pair: FileConsumer,
): Promise<RemovalOutcome> {
  try {
    return await deps.projections.withDeleteGate(userId, slot.provider, async () => {
      const entry = findEntry(readLedgerEntries(userId, vendorId), pair);
      if (!entry || entry.state !== 'tombstone') return 'absent';
      const current = await deps.projections.read(userId, slot.provider, slot.target);
      const owned = current !== null && matchesEntry(deps, entry, current);
      if (owned) {
        await deps.projections.remove(userId, slot.provider, slot.target);
        if (await deps.projections.read(userId, slot.provider, slot.target) !== null) throw unverified();
      }
      updateLedger(userId, vendorId, (entries) => withoutEntry(entries, pair));
      if (owned) return 'removed';
      return current === null ? 'absent' : 'foreign_credential';
    });
  } catch {
    return 'failed';
  }
}

/** The vendor's projections (cli_file consumers), from the catalogue. */
function vendorPairs(vendorId: string): FileConsumer[] {
  return MIGRATION_VENDORS.find((vendor) => vendor.vendorId === vendorId)?.files.map((file) => ({ ...file })) ?? [];
}

/** Phase 1 for every projection of the vendor; returns final results and the pending drains. */
async function planRemoval(
  ctx: RemoveContext,
  options: FanoutRemoveOptions,
): Promise<{ results: FanoutSlotResult[]; pending: Array<{ slot: FanoutSlot; pair: FileConsumer }> }> {
  const results: FanoutSlotResult[] = [];
  const pending: Array<{ slot: FanoutSlot; pair: FileConsumer }> = [];
  for (const pair of vendorPairs(ctx.vendorId)) {
    const slot = slotFor(options.slots, ctx.vendorId, pair);
    const refused = scopeRefusal(ctx.deps, slot.provider, options.isElevated);
    const outcome = refused ?? await markForRemoval(ctx, slot, pair);
    if (outcome === 'pending') pending.push({ slot, pair });
    else results.push({ ...slot, outcome });
  }
  return { results, pending };
}

/** Retries one member's failed and stale projections with the stored key. */
async function retryProjections(deps: VendorKeyFanoutDeps, userId: Member, vendorId: string, key: string): Promise<void> {
  const ctx: SaveContext = {
    deps, userId, vendorId, key, isElevated: false, replaceForeignKey: false, principal: undefined, sweepRetry: true,
  };
  const retry = readLedgerEntries(userId, vendorId).filter((entry) => entry.state === 'failed' || entry.state === 'stale');
  for (const entry of retry) {
    const pair = { harness: entry.harness, target: entry.target };
    const slot = slotFor([], vendorId, pair);
    if (deps.isOwnScope(slot.provider)) await projectSlot(ctx, slot, pair);
  }
}

/**
 * The key is gone (a delete, or a flag-off legacy delete): every live entry
 * nassaj wrote becomes a tombstone. Adopted entries stay until the user confirms.
 */
function tombstoneOrphans(deps: VendorKeyFanoutDeps, userId: Member, vendorId: string): void {
  const nowIso = deps.now().toISOString();
  updateLedger(userId, vendorId, (entries) => entries.map((entry) => (
    entry.origin === 'fanout' && entry.state !== 'tombstone' ? { ...entry, state: 'tombstone', updatedAt: nowIso } : entry
  )));
}

/** One member, one vendor: retry, then drain every tombstone. */
async function sweepVendor(
  deps: VendorKeyFanoutDeps,
  userId: Member,
  vendor: { vendorId: string; secretId: string },
): Promise<void> {
  if (readLedgerEntries(userId, vendor.vendorId).length === 0) return;
  const key = deps.secrets.readState(userId, vendor.secretId);
  // G2: an undecryptable record is not a deleted key; nothing is tombstoned or removed.
  if (key.state === 'unreadable') return;
  if (key.state === 'ok') await retryProjections(deps, userId, vendor.vendorId, key.value);
  else tombstoneOrphans(deps, userId, vendor.vendorId);
  for (const entry of readLedgerEntries(userId, vendor.vendorId).filter((candidate) => candidate.state === 'tombstone')) {
    const pair = { harness: entry.harness, target: entry.target };
    await drainTombstone(deps, userId, vendor.vendorId, slotFor([], vendor.vendorId, pair), pair);
  }
}

function requireMember(deps: VendorKeyFanoutDeps, userId: unknown): Member {
  if (!deps.isEnabled()) throw fanoutError('UNIFIED_VENDOR_KEYS_OFF', 'Unified vendor keys are not enabled.');
  if (!isMember(userId)) throw fanoutError('MEMBER_REQUIRED', 'A signed-in member is required.', 400);
  return userId;
}

/** The audit view of a result list: where, and what happened; never a key or a message. */
function auditOutcomes(results: readonly FanoutSlotResult[]): Array<Record<string, unknown>> {
  return results.map(({ provider, target, outcome }) => ({ provider, target: target ?? null, outcome }));
}

/** §3 Save (and rotation): the AES record, then each selected projection. */
async function saveVendorKey(
  deps: VendorKeyFanoutDeps,
  userId: unknown,
  vendorId: string,
  key: string,
  options: FanoutSaveOptions,
): Promise<FanoutSlotResult[]> {
  const member = requireMember(deps, userId);
  const row = vendorRow(vendorId);
  assertNotClaudeSubscriptionToken(key, 'a vendor key');
  deps.secrets.write(member, row.secretId, key, options.auditContext);
  clearVendorDeleted(member, vendorId);
  const ctx: SaveContext = {
    deps, userId: member, vendorId, key, isElevated: options.isElevated,
    replaceForeignKey: options.replaceForeignKey === true, principal: options.authenticatedPrincipal,
  };
  const results: FanoutSlotResult[] = [];
  for (const slot of options.slots) {
    const pair = slotPair(slot);
    results.push(pair ? await projectSlot(ctx, slot, pair) : { ...slot, outcome: 'linked' });
  }
  deps.audit(member, 'vendor_key_saved', { vendorId, slots: auditOutcomes(results) }, options.auditContext);
  return results;
}

/** §6 Delete: the deletion marker and tombstones first, then the AES record, then the drain. */
async function removeVendorKey(
  deps: VendorKeyFanoutDeps,
  userId: unknown,
  vendorId: string,
  options: FanoutRemoveOptions,
): Promise<FanoutSlotResult[]> {
  const member = requireMember(deps, userId);
  const row = vendorRow(vendorId);
  const ctx: RemoveContext = { deps, userId: member, vendorId, confirm: options.removeForeignKey === true };
  markVendorDeleted(member, vendorId, deps.now().toISOString());
  const { results, pending } = await planRemoval(ctx, options);
  deps.secrets.remove(member, row.secretId, options.auditContext);
  for (const { slot, pair } of pending) {
    results.push({ ...slot, outcome: await drainTombstone(deps, member, vendorId, slot, pair) });
  }
  const aesSlots = options.slots.filter((slot) => slotPair(slot) === null);
  const all = [...aesSlots.map((slot) => ({ ...slot, outcome: 'removed' as const })), ...results];
  deps.audit(member, 'vendor_key_deleted', { vendorId, slots: auditOutcomes(all) }, options.auditContext);
  return all;
}

/** One member's retry sweep over every vendor; resolves to the number of vendors left unswept. */
async function sweepMemberWith(deps: VendorKeyFanoutDeps, userId: Member): Promise<number> {
  let failed = 0;
  for (const vendor of MIGRATION_VENDORS) {
    try {
      await sweepVendor(deps, userId, vendor);
    } catch {
      failed += 1;
    }
  }
  return failed;
}

/** The server-start sweep over every member; a no-op with the flag off. Logs counts only. */
async function sweepAllWith(deps: VendorKeyFanoutDeps): Promise<{ status: 'flag_off' | 'done'; failed: number }> {
  if (!deps.isEnabled()) return { status: 'flag_off', failed: 0 };
  let failed = 0;
  for (const userId of deps.listMemberIds()) failed += await sweepMemberWith(deps, userId);
  if (failed > 0) console.error('[vendor-key-fanout] sweep left vendors unswept', { failed });
  return { status: 'done', failed };
}

/** Builds the fan-out service over its dependencies (production: vendor-key-fanout.runtime). */
export function createVendorKeyFanoutService(deps: VendorKeyFanoutDeps) {
  return {
    save: (userId: unknown, vendorId: string, key: string, options: FanoutSaveOptions) =>
      saveVendorKey(deps, userId, vendorId, key, options),
    remove: (userId: unknown, vendorId: string, options: FanoutRemoveOptions) =>
      removeVendorKey(deps, userId, vendorId, options),
    sweepMember: (userId: Member) => sweepMemberWith(deps, userId),
    sweepAll: () => sweepAllWith(deps),
  };
}

export type VendorKeyFanoutService = ReturnType<typeof createVendorKeyFanoutService>;
