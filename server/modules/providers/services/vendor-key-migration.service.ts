/**
 * vendor-key-migration.service — ADR-200 S5 (in-flag `NASSAJ_UNIFIED_VENDOR_KEYS`):
 * moves a member's existing vendor keys into the unified model without
 * deleting or rewriting any harness file (D5).
 *
 *   - **Inventory** (`inventory`) is read-only: the member's own Claude, Codex
 *     and OpenCode credential files plus the AES store, per vendor.
 *   - **Conflict** (D9): when a vendor's sources hold different keys (AES `glm`
 *     ≠ OpenCode `glm`; Claude settings ≠ OpenCode `anthropic`), nothing is
 *     written for that vendor until the user picks one (`resolveConflict`).
 *   - **Adoption**: a single non-conflicting key becomes the canonical AES
 *     record when none exists, and each harness file that holds it gets a
 *     ledger entry with `origin: 'adopted'` (fingerprint only, never the value).
 *   - **Backups** (§2, D8): before the first nassaj write for a member, every
 *     own harness file is stored byte for byte as `backup:<harness>`. A run
 *     that adopted and re-verified everything marks the migration verified;
 *     30 days later the backups are purged. `restoreBackup` puts the API-key
 *     fields back (or, on explicit confirm, the exact bytes) under the same
 *     (user, harness) lock as the fan-out, then forgets that harness's ledger
 *     entries and stale link-mode projection (G2, B-1570).
 *   - **Deleted vendors** (G2, B-1570): a vendor the user deleted carries a
 *     marker (`deletedVendors`) and is never adopted again from a harness file
 *     until an explicit Save clears it. An AES record that does not decrypt is
 *     never adopted over either.
 *   - **Idempotent**: a re-run with nothing new writes nothing. A `keyVersion`
 *     rotation re-verifies old entries under their own version and
 *     re-fingerprints them under the current one.
 *
 * Audit rows: one per adoption, per purge, per conflict choice and per restore.
 * No key value is ever returned, logged or put in an error or audit row.
 */

import { isClaudeSubscriptionToken } from '@/modules/providers/shared/credentials/subscription-token-guard.js';
import * as store from '@/services/isolation/provider-secrets-store.js';
import { AppError } from '@/shared/utils.js';

import { createKeyedLock } from './harness-link-mode.service.js';
import {
  MIGRATION_VENDORS,
  currentFileValue,
  readHarnessFile,
  vendorFileSources,
  type FileConsumer,
  type HarnessFileLocation,
  type HarnessFileRead,
  type KeySource,
  type KeySourceRef,
  type MigrationVendor,
  type ProjectionHarness,
} from './vendor-key-migration.inventory.js';
import { restoreHarnessFile, type RestoreMode } from './vendor-key-restore.js';

/** D8: backups are purged this long after a verified migration. */
export const BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type LedgerEntry = FileConsumer & {
  fingerprint: string;
  keyVersion: number;
  state: 'synced' | 'stale' | 'failed' | 'tombstone';
  origin: 'fanout' | 'adopted';
  updatedAt: string;
};

export type VendorKeyAuditAction =
  | 'vendor_key_adopted'
  | 'vendor_key_backup_purged'
  | 'vendor_key_backup_restored'
  | 'vendor_key_conflict_resolved';

export type VendorKeyMigrationDeps = {
  isEnabled(): boolean;
  /** The member's own credential file per harness; shared trees are never inventoried. */
  locateHarnessFiles(userId: string | number): HarnessFileLocation[];
  fingerprint(value: string, keyVersion: number): string;
  keyVersion: number;
  listMemberIds(): Array<string | number>;
  audit(userId: string | number, action: VendorKeyAuditAction, metadata: Record<string, unknown>): void;
  now(): Date;
  /** Runs `work` under the (user, harness) lock the fan-out writes take (restore, G2). */
  withHarnessLock<T>(userId: string | number, harness: ProjectionHarness, work: () => Promise<T>): Promise<T>;
};

/** A source as shown to the user: `group` tells which sources hold the same key. */
export type KeySourceView = KeySourceRef & { group: number | null; refused?: 'subscription_token' };

export type VendorMigrationOutcome =
  | 'nothing'
  | 'unchanged'
  | 'adopted'
  | 'conflict'
  | 'ledger_unreadable'
  /** The user deleted this vendor's key: nothing is adopted until a Save. */
  | 'deleted'
  /** The AES record exists but does not decrypt: nothing is adopted over it. */
  | 'key_unreadable';

export type VendorMigrationView = { vendorId: string; outcome: VendorMigrationOutcome; sources: KeySourceView[] };

export type HarnessFileView = {
  harness: ProjectionHarness;
  scope: 'own' | 'shared';
  state?: 'absent' | 'unreadable' | 'ok' | 'unparseable';
};

export type VendorKeyMigrationResult = {
  status: 'flag_off' | 'no_member' | 'store_unreadable' | 'done';
  vendors: VendorMigrationView[];
  harnesses: HarnessFileView[];
  backupsTaken: ProjectionHarness[];
  verifiedAt: string | null;
  purged: ProjectionHarness[];
};

type MigrationState = {
  v: 1;
  verifiedAt: string | null;
  purgedAt: string | null;
  resolved: Record<string, { fp: string; keyVersion: number }>;
  /** vendorId → when the user deleted its key (G2); cleared by a Save. */
  deletedVendors: Record<string, string>;
};

type VendorPlan = VendorMigrationView & {
  storeWrite: string | null;
  ledgerNext: LedgerEntry[] | null;
  adopted: FileConsumer[];
};

type RunContext = {
  userId: string | number;
  files: HarnessFileRead[];
  state: MigrationState;
  nowIso: string;
  deps: VendorKeyMigrationDeps;
};

const EMPTY_RESULT = { vendors: [], harnesses: [], backupsTaken: [], verifiedAt: null, purged: [] };

function migrationError(code: string, message: string, statusCode = 409): AppError {
  return new AppError(message, { code, statusCode });
}

function isMemberId(userId: unknown): userId is string | number {
  return userId !== null && userId !== undefined && userId !== '' && userId !== store.SYSTEM_SECRET_SCOPE;
}

function samePair(a: FileConsumer, b: FileConsumer): boolean {
  return a.harness === b.harness && (a.target ?? null) === (b.target ?? null);
}

function isCanonicalSecretId(secretId: string): boolean {
  return secretId.startsWith('vendor:');
}

type LegacySlot = Parameters<typeof store.getProviderKey>[1];

function readStoreKey(userId: string | number, secretId: string): string | null {
  return isCanonicalSecretId(secretId)
    ? store.getCanonicalVendorKey(userId, secretId.slice('vendor:'.length))
    : store.getProviderKey(userId, secretId as LegacySlot);
}

/** Writes one AES record and re-reads it (L4); a mismatch is a failed write. */
function writeStoreKey(userId: string | number, secretId: string, value: string): void {
  if (isCanonicalSecretId(secretId)) store.setCanonicalVendorKey(userId, secretId.slice('vendor:'.length), value);
  else store.setProviderKey(userId, secretId as LegacySlot, value);
  if (readStoreKey(userId, secretId) !== value) {
    throw migrationError('VENDOR_MIGRATION_WRITE_UNVERIFIED', 'The adopted key could not be verified after writing.', 500);
  }
}

/** Normalised migration bookkeeping; unreadable is reported by the caller. */
function normalizeState(raw: Record<string, unknown> | null): MigrationState {
  const resolved: MigrationState['resolved'] = {};
  const rawResolved = raw?.resolved && typeof raw.resolved === 'object' ? raw.resolved as Record<string, unknown> : {};
  for (const [vendorId, value] of Object.entries(rawResolved)) {
    const entry = value as { fp?: unknown; keyVersion?: unknown } | null;
    if (typeof entry?.fp === 'string' && Number.isInteger(entry.keyVersion)) {
      resolved[vendorId] = { fp: entry.fp, keyVersion: entry.keyVersion as number };
    }
  }
  return {
    v: 1,
    verifiedAt: typeof raw?.verifiedAt === 'string' ? raw.verifiedAt : null,
    purgedAt: typeof raw?.purgedAt === 'string' ? raw.purgedAt : null,
    resolved,
    deletedVendors: readDeletedVendors(raw),
  };
}

/** The `deletedVendors` markers of a raw migration record; malformed entries are dropped. */
export function readDeletedVendors(raw: Record<string, unknown> | null): Record<string, string> {
  const source = raw?.deletedVendors && typeof raw.deletedVendors === 'object' ? raw.deletedVendors as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(source).filter(([, at]) => typeof at === 'string')) as Record<string, string>;
}

function viewOf(source: KeySource, values: readonly string[]): KeySourceView {
  const ref = { harness: source.harness, target: source.target };
  if (isClaudeSubscriptionToken(source.value)) return { ...ref, group: null, refused: 'subscription_token' };
  return { ...ref, group: values.indexOf(source.value) };
}

function harnessView(file: HarnessFileRead): HarnessFileView {
  if (file.scope === 'shared') return { harness: file.harness, scope: 'shared' };
  const state = file.state === 'ok' && file.json === null ? 'unparseable' : file.state;
  return { harness: file.harness, scope: 'own', state };
}

const CONFLICT = Symbol('conflict');

/**
 * D9: one value is canonical; several are a conflict unless the user already
 * chose, or the vendor is already migrated (a store record with a ledger): a
 * file that diverges after that is a stale or foreign projection, not a conflict.
 */
function chooseCanonical(
  ctx: RunContext,
  vendorId: string,
  storeValue: string | null,
  values: readonly string[],
  migrated: boolean,
): string | null | typeof CONFLICT {
  if (values.length <= 1) return values[0] ?? null;
  if (storeValue && migrated) return storeValue;
  const resolved = ctx.state.resolved[vendorId];
  if (storeValue && resolved && ctx.deps.fingerprint(storeValue, resolved.keyVersion) === resolved.fp) {
    return storeValue;
  }
  return CONFLICT;
}

/**
 * Re-verifies one existing entry against the file. A match under its own
 * keyVersion is re-fingerprinted under the current one; a mismatch is `stale`.
 * Tombstones and failed entries belong to the fan-out retry (S6).
 */
function reverifyEntry(ctx: RunContext, entry: LedgerEntry): LedgerEntry {
  if (entry.state === 'tombstone' || entry.state === 'failed') return entry;
  const current = currentFileValue(ctx.files, entry);
  if (current === undefined) return entry;
  const matches = current !== null && ctx.deps.fingerprint(current, entry.keyVersion) === entry.fingerprint;
  if (!matches) return entry.state === 'stale' ? entry : { ...entry, state: 'stale', updatedAt: ctx.nowIso };
  if (entry.keyVersion === ctx.deps.keyVersion) return entry;
  const keyVersion = ctx.deps.keyVersion;
  return { ...entry, fingerprint: ctx.deps.fingerprint(current, keyVersion), keyVersion, updatedAt: ctx.nowIso };
}

function nextLedger(
  ctx: RunContext,
  vendor: MigrationVendor,
  existing: readonly LedgerEntry[],
  canonical: string | null,
): { entries: LedgerEntry[]; adopted: FileConsumer[] } {
  const entries = existing.map((entry) => reverifyEntry(ctx, entry));
  const adopted: FileConsumer[] = [];
  for (const consumer of vendor.files) {
    if (!canonical || entries.some((entry) => samePair(entry, consumer))) continue;
    if (currentFileValue(ctx.files, consumer) !== canonical) continue;
    const keyVersion = ctx.deps.keyVersion;
    entries.push({
      ...consumer,
      fingerprint: ctx.deps.fingerprint(canonical, keyVersion),
      keyVersion,
      state: 'synced',
      origin: 'adopted',
      updatedAt: ctx.nowIso,
    });
    adopted.push(consumer);
  }
  return { entries, adopted };
}

function vendorSources(ctx: RunContext, vendor: MigrationVendor, storeValue: string | null): KeySource[] {
  const fromStore: KeySource[] = storeValue ? [{ harness: 'store', target: vendor.secretId, value: storeValue }] : [];
  return [...fromStore, ...vendorFileSources(vendor, ctx.files)];
}

/** The AES record of a vendor with its state; `unreadable` never reads as "no key" (G2). */
function readStoreState(userId: string | number, secretId: string): { state: 'absent' | 'unreadable' } | { state: 'ok'; value: string } {
  const read = store.readVendorKeyState(userId, secretId) as
    { state: 'absent' } | { state: 'unreadable' } | { state: 'ok'; value: string };
  return read.state === 'ok' ? read : { state: read.state };
}

/** The outcome when nothing may be adopted for the vendor, else null. */
function blockedOutcome(
  ctx: RunContext,
  vendor: MigrationVendor,
  storeRead: ReturnType<typeof readStoreState>,
): VendorMigrationOutcome | null {
  if (storeRead.state === 'unreadable') return 'key_unreadable';
  // N-3: the marker blocks even while the AES record still exists — the delete
  // writes the marker before it removes the record, and a run in between must
  // not adopt the key back. A Save clears the marker.
  if (ctx.state.deletedVendors[vendor.vendorId]) return 'deleted';
  return null;
}

/** Read-only plan for one vendor. Nothing is written here. */
function planVendor(ctx: RunContext, vendor: MigrationVendor): VendorPlan {
  const storeRead = readStoreState(ctx.userId, vendor.secretId);
  const storeValue = storeRead.state === 'ok' ? storeRead.value : null;
  const all = vendorSources(ctx, vendor, storeValue);
  const values = [...new Set(all.filter((s) => !isClaudeSubscriptionToken(s.value)).map((s) => s.value))];
  const base = {
    vendorId: vendor.vendorId,
    sources: all.map((source) => viewOf(source, values)),
    storeWrite: null,
    ledgerNext: null,
    adopted: [],
  };
  const blocked = blockedOutcome(ctx, vendor, storeRead);
  if (blocked) return { ...base, outcome: blocked };
  const ledgerRead = store.readVendorLedgerState(ctx.userId, vendor.vendorId);
  if (ledgerRead.state === 'unreadable') return { ...base, outcome: 'ledger_unreadable' };
  const existing = ledgerRead.state === 'ok' ? ledgerRead.ledger.entries as LedgerEntry[] : [];
  const canonical = chooseCanonical(ctx, vendor.vendorId, storeValue, values, existing.length > 0);
  if (canonical === CONFLICT) return { ...base, outcome: 'conflict' };
  const { entries, adopted } = nextLedger(ctx, vendor, existing, canonical);
  const storeWrite = canonical && !storeValue ? canonical : null;
  const changed = JSON.stringify(entries) !== JSON.stringify(existing);
  let outcome: VendorMigrationOutcome = 'nothing';
  if (storeWrite || adopted.length > 0) outcome = 'adopted';
  else if (canonical || existing.length > 0) outcome = 'unchanged';
  return { ...base, outcome, storeWrite, ledgerNext: changed ? entries : null, adopted };
}

function applyPlan(ctx: RunContext, vendor: MigrationVendor, plan: VendorPlan): void {
  const { userId, deps } = ctx;
  if (plan.storeWrite) {
    writeStoreKey(userId, vendor.secretId, plan.storeWrite);
    deps.audit(userId, 'vendor_key_adopted', {
      vendorId: vendor.vendorId, harness: 'store', target: vendor.secretId, keyVersion: deps.keyVersion,
    });
  }
  if (plan.ledgerNext) store.setVendorLedger(userId, vendor.vendorId, { v: 1, entries: plan.ledgerNext });
  for (const consumer of plan.adopted) {
    deps.audit(userId, 'vendor_key_adopted', {
      vendorId: vendor.vendorId, harness: consumer.harness, target: consumer.target, keyVersion: deps.keyVersion,
    });
  }
}

/** Stores every own, readable harness file as it is now, unless already backed up. */
function takeBackups(ctx: RunContext): ProjectionHarness[] {
  const taken: ProjectionHarness[] = [];
  for (const file of ctx.files) {
    if (file.scope === 'shared' || file.state === 'unreadable') continue;
    const bytes = file.state === 'ok' ? file.bytes : null;
    if (store.putHarnessBackupIfAbsent(ctx.userId, file.harness, bytes, ctx.nowIso)) taken.push(file.harness);
  }
  return taken;
}

/** Every `synced` entry of one vendor still matches its file, under its own keyVersion. */
function ledgerVerifies(ctx: RunContext, files: readonly HarnessFileRead[], vendor: MigrationVendor): boolean {
  const read = store.readVendorLedgerState(ctx.userId, vendor.vendorId);
  if (read.state === 'absent') return true;
  if (read.state === 'unreadable') return false;
  return (read.ledger.entries as LedgerEntry[])
    .filter((entry) => entry.state === 'synced')
    .every((entry) => {
      const current = currentFileValue(files, entry);
      return typeof current === 'string' && ctx.deps.fingerprint(current, entry.keyVersion) === entry.fingerprint;
    });
}

/**
 * The migration is verified when no vendor is in conflict, every own harness
 * file has an intact backup, and every synced ledger entry re-reads as written.
 */
function verificationPasses(ctx: RunContext, plans: readonly VendorPlan[]): boolean {
  const blocking: readonly VendorMigrationOutcome[] = ['conflict', 'ledger_unreadable', 'key_unreadable'];
  if (plans.some((plan) => blocking.includes(plan.outcome))) return false;
  const own = ctx.files.filter((file) => file.scope === 'own');
  if (own.length === 0 || own.some((file) => file.state === 'unreadable')) return false;
  const intact = own.every((file) => store.readHarnessBackup(ctx.userId, file.harness)?.intact === true);
  if (!intact) return false;
  const reread = readFiles(ctx.deps, ctx.userId);
  return MIGRATION_VENDORS.every((vendor) => ledgerVerifies(ctx, reread, vendor));
}

/** D8: purges every backup once 30 days have passed since verification. */
function purgeIfDue(ctx: RunContext, verifiedAt: string | null): ProjectionHarness[] {
  if (!verifiedAt) return [];
  if (ctx.deps.now().getTime() - Date.parse(verifiedAt) < BACKUP_RETENTION_MS) return [];
  const purged = (store.listHarnessBackups(ctx.userId) as ProjectionHarness[])
    .filter((harness) => store.deleteHarnessBackup(ctx.userId, harness));
  for (const harness of purged) {
    ctx.deps.audit(ctx.userId, 'vendor_key_backup_purged', { harness, verifiedAt });
  }
  return purged;
}

function readFiles(deps: VendorKeyMigrationDeps, userId: string | number): HarnessFileRead[] {
  return deps.locateHarnessFiles(userId).map(readHarnessFile);
}

/** Builds the run context, or null when the member's keys file is unreadable. */
function loadContext(deps: VendorKeyMigrationDeps, userId: string | number): RunContext | null {
  const read = store.readVendorMigrationState(userId);
  if (read.state === 'unreadable') return null;
  return {
    userId,
    files: readFiles(deps, userId),
    state: normalizeState(read.state === 'ok' ? read.record : null),
    nowIso: deps.now().toISOString(),
    deps,
  };
}

function saveStateIfChanged(ctx: RunContext, next: MigrationState): void {
  if (JSON.stringify(next) !== JSON.stringify(ctx.state)) store.setVendorMigrationState(ctx.userId, next);
}

function migrateLocked(deps: VendorKeyMigrationDeps, userId: string | number): VendorKeyMigrationResult {
  const ctx = loadContext(deps, userId);
  if (!ctx) return { status: 'store_unreadable', ...EMPTY_RESULT };
  const pairs = MIGRATION_VENDORS.map((vendor) => ({ vendor, plan: planVendor(ctx, vendor) }));
  const writes = pairs.some(({ plan }) => plan.storeWrite || plan.ledgerNext);
  const backupsTaken = writes && !ctx.state.verifiedAt ? takeBackups(ctx) : [];
  for (const { vendor, plan } of pairs) applyPlan(ctx, vendor, plan);
  const plans = pairs.map(({ plan }) => plan);
  const verifiedAt = ctx.state.verifiedAt
    ?? (store.listHarnessBackups(userId).length > 0 && verificationPasses(ctx, plans) ? ctx.nowIso : null);
  const purged = purgeIfDue(ctx, verifiedAt);
  saveStateIfChanged(ctx, { ...ctx.state, verifiedAt, purgedAt: purged.length > 0 ? ctx.nowIso : ctx.state.purgedAt });
  return {
    status: 'done',
    vendors: plans.map(({ vendorId, outcome, sources }) => ({ vendorId, outcome, sources })),
    harnesses: ctx.files.map(harnessView),
    backupsTaken,
    verifiedAt,
    purged,
  };
}

function sourceValue(ctx: RunContext, vendor: MigrationVendor, choice: KeySourceRef): string | null {
  if (choice.harness === 'store') return readStoreKey(ctx.userId, vendor.secretId);
  const consumer = vendor.files.find((entry) => samePair(entry, choice as FileConsumer));
  return consumer ? currentFileValue(ctx.files, consumer) ?? null : null;
}

function findVendor(vendorId: unknown): MigrationVendor {
  const vendor = MIGRATION_VENDORS.find((entry) => entry.vendorId === vendorId);
  if (!vendor) throw migrationError('UNKNOWN_MIGRATION_VENDOR', 'This vendor has no key to migrate.', 404);
  return vendor;
}

/** D9: the user's choice among conflicting keys becomes the canonical record. */
function resolveLocked(
  deps: VendorKeyMigrationDeps,
  userId: string | number,
  vendor: MigrationVendor,
  choice: KeySourceRef,
): VendorKeyMigrationResult {
  const ctx = loadContext(deps, userId);
  if (!ctx) throw migrationError(store.PROVIDER_SECRETS_STORE_UNREADABLE, store.PROVIDER_SECRETS_STORE_REPAIR_MESSAGE);
  if (planVendor(ctx, vendor).outcome !== 'conflict') {
    throw migrationError('VENDOR_MIGRATION_NO_CONFLICT', 'There is no key conflict to resolve for this vendor.');
  }
  const value = sourceValue(ctx, vendor, choice);
  if (!value || isClaudeSubscriptionToken(value)) {
    throw migrationError('VENDOR_MIGRATION_SOURCE_NOT_FOUND', 'The chosen key source holds no usable key.', 400);
  }
  if (!ctx.state.verifiedAt) takeBackups(ctx);
  if (readStoreKey(userId, vendor.secretId) !== value) writeStoreKey(userId, vendor.secretId, value);
  const resolved = { ...ctx.state.resolved, [vendor.vendorId]: { fp: deps.fingerprint(value, deps.keyVersion), keyVersion: deps.keyVersion } };
  store.setVendorMigrationState(userId, { ...ctx.state, resolved });
  deps.audit(userId, 'vendor_key_conflict_resolved', {
    vendorId: vendor.vendorId, harness: choice.harness, target: choice.target ?? null,
  });
  return migrateLocked(deps, userId);
}

export type RestoreOptions = {
  /** `keys` (default): API-key fields only. `full`: the exact bytes, only with `confirm`. */
  mode?: RestoreMode;
  confirm?: boolean;
};

/**
 * After a restore the harness holds the backup's values, not nassaj's: its
 * ledger entries go (so the sweep cannot re-project over the restore) and a
 * link-mode projection that no longer matches the file is cleared (in-flag
 * only; with the flag off a stale projection only makes the value read as
 * foreign, which is the safe side).
 */
function forgetProjections(deps: VendorKeyMigrationDeps, userId: string | number, location: HarnessFileLocation & { scope: 'own' }) {
  for (const vendor of MIGRATION_VENDORS.filter((entry) => entry.files.some((file) => file.harness === location.harness))) {
    store.dropVendorLedgerHarness(userId, vendor.vendorId, location.harness);
  }
  if (location.harness === 'opencode' || !deps.isEnabled()) return;
  const read = store.readLinkModeRecordState(userId, location.harness);
  const projection = read.state === 'ok' ? read.record.projection as { fp?: unknown; keyVersion?: unknown } | null : null;
  if (!projection || read.state !== 'ok') return;
  const current = currentFileValue([readHarnessFile(location)], { harness: location.harness, target: null });
  const keyVersion = Number.isInteger(projection.keyVersion) ? projection.keyVersion as number : deps.keyVersion;
  if (current && deps.fingerprint(current, keyVersion) === projection.fp) return;
  store.setLinkModeRecord(userId, location.harness, { ...read.record, projection: null, updatedAt: deps.now().toISOString() });
}

/** Restores one backup onto the member's own harness file (§3 rollback). */
function restoreLocked(deps: VendorKeyMigrationDeps, userId: string | number, harness: ProjectionHarness, mode: RestoreMode) {
  const backup = store.readHarnessBackup(userId, harness);
  if (!backup?.intact) throw migrationError('VENDOR_BACKUP_UNAVAILABLE', 'No intact backup exists for this harness.');
  const location = deps.locateHarnessFiles(userId).find((entry) => entry.harness === harness);
  if (!location || location.scope !== 'own') {
    throw migrationError('VENDOR_BACKUP_SHARED_SCOPE', 'This harness does not use your own credential files.');
  }
  const { skipped } = restoreHarnessFile(harness, location.path, backup, mode);
  forgetProjections(deps, userId, location);
  deps.audit(userId, 'vendor_key_backup_restored', { harness, takenAt: backup.takenAt, mode, skipped });
  return { harness, restored: true as const, existed: backup.existed, mode, skipped };
}

function readRestoreMode(options: RestoreOptions | undefined): RestoreMode {
  const mode = options?.mode ?? 'keys';
  if (mode !== 'keys' && mode !== 'full') {
    throw migrationError('INVALID_RESTORE_MODE', '`mode` must be "keys" or "full".', 400);
  }
  if (mode === 'full' && options?.confirm !== true) {
    throw migrationError('VENDOR_RESTORE_CONFIRM_REQUIRED',
      'A full restore replaces the whole file, logins included. Confirm to proceed.');
  }
  return mode;
}

/** Read-only inventory: what a run would adopt, and what conflicts. Writes nothing. */
function inventoryOf(deps: VendorKeyMigrationDeps, userId: string | number | null | undefined): VendorKeyMigrationResult {
  if (!deps.isEnabled()) return { status: 'flag_off', ...EMPTY_RESULT };
  if (!isMemberId(userId)) return { status: 'no_member', ...EMPTY_RESULT };
  const ctx = loadContext(deps, userId);
  if (!ctx) return { status: 'store_unreadable', ...EMPTY_RESULT };
  const vendors = MIGRATION_VENDORS.map((vendor) => planVendor(ctx, vendor))
    .map(({ vendorId, outcome, sources }) => ({ vendorId, outcome, sources }));
  return { status: 'done', ...EMPTY_RESULT, vendors, harnesses: ctx.files.map(harnessView), verifiedAt: ctx.state.verifiedAt };
}

function ensureBackupsLocked(deps: VendorKeyMigrationDeps, userId: string | number): ProjectionHarness[] {
  const ctx = loadContext(deps, userId);
  if (!ctx) throw migrationError(store.PROVIDER_SECRETS_STORE_UNREADABLE, store.PROVIDER_SECRETS_STORE_REPAIR_MESSAGE);
  return ctx.state.verifiedAt ? [] : takeBackups(ctx);
}

/** Runs every member; one member's failure never stops the others. Logs ids and codes only. */
async function runEveryMember(
  deps: VendorKeyMigrationDeps,
  run: (userId: string | number) => Promise<VendorKeyMigrationResult>,
): Promise<{ status: 'flag_off' | 'done'; failed: number }> {
  if (!deps.isEnabled()) return { status: 'flag_off', failed: 0 };
  let failed = 0;
  for (const userId of deps.listMemberIds()) {
    try {
      await run(userId);
    } catch (error) {
      failed += 1;
      console.error('[vendor-key-migration] run failed', { userId, code: (error as { code?: unknown })?.code ?? 'unknown' });
    }
  }
  return { status: 'done', failed };
}

function requireMember(userId: string | number | null | undefined): string | number {
  if (!isMemberId(userId)) throw migrationError('MEMBER_REQUIRED', 'A signed-in member is required.', 400);
  return userId;
}

/** Builds the migration service over its dependencies (production: vendor-key-migration.runtime). */
export function createVendorKeyMigrationService(deps: VendorKeyMigrationDeps) {
  const withLock = createKeyedLock();
  const locked = <T>(userId: string | number, work: () => T) => withLock(`vendor-migration:${userId}`, async () => work());
  const run = async (userId: string | number | null | undefined): Promise<VendorKeyMigrationResult> => {
    if (!deps.isEnabled()) return { status: 'flag_off', ...EMPTY_RESULT };
    if (!isMemberId(userId)) return { status: 'no_member', ...EMPTY_RESULT };
    return locked(userId, () => migrateLocked(deps, userId));
  };

  return {
    /** Read-only inventory; see {@link inventoryOf}. */
    inventory: (userId: string | number | null | undefined) => inventoryOf(deps, userId),
    /** One member's migration run; idempotent, and a no-op with the flag off. */
    run,
    /** Every member, at server start and daily (runtime sweep). */
    runAll: () => runEveryMember(deps, run),
    /** Backs up every own harness file before a first write, until the migration is verified. */
    async ensureBackups(userId: string | number | null | undefined): Promise<ProjectionHarness[]> {
      if (!deps.isEnabled() || !isMemberId(userId)) return [];
      return locked(userId, () => ensureBackupsLocked(deps, userId));
    },
    /** D9: adopt the key the user chose for a vendor in conflict, then re-run. */
    async resolveConflict(userId: string | number | null | undefined, vendorId: unknown, choice: KeySourceRef) {
      if (!deps.isEnabled()) throw migrationError('UNIFIED_VENDOR_KEYS_OFF', 'Unified vendor keys are not enabled.');
      const member = requireMember(userId);
      const vendor = findVendor(vendorId);
      return locked(member, () => resolveLocked(deps, member, vendor, choice));
    },
    /**
     * §3 rollback of one harness file; open with the flag off. Runs under the
     * fan-out's (user, harness) lock, then the migration lock (that order only).
     */
    async restoreBackup(userId: string | number | null | undefined, harness: ProjectionHarness, options?: RestoreOptions) {
      const member = requireMember(userId);
      const mode = readRestoreMode(options);
      return deps.withHarnessLock(member, harness, () => locked(member, () => restoreLocked(deps, member, harness, mode)));
    },
  };
}

export type VendorKeyMigrationService = ReturnType<typeof createVendorKeyMigrationService>;
