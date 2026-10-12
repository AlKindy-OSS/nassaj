/**
 * vendor-key-fanout.ledger — ADR-200 S6: the provenance-ledger bookkeeping the
 * fan-out needs, over the S5 `ledger:<vendor>` record. Every update is one
 * synchronous read → modify → write, so two updates in this process never
 * interleave. Fingerprints only; no key value is ever stored here.
 */

import * as store from '@/services/isolation/provider-secrets-store.js';
import { AppError } from '@/shared/utils.js';

import { readDeletedVendors, type LedgerEntry } from './vendor-key-migration.service.js';
import type { FileConsumer } from './vendor-key-migration.inventory.js';

export type LedgerState = LedgerEntry['state'];
export type LedgerOrigin = LedgerEntry['origin'];

/** True when both name the same (harness, target) projection. */
export function samePair(a: FileConsumer, b: FileConsumer): boolean {
  return a.harness === b.harness && (a.target ?? null) === (b.target ?? null);
}

/**
 * One member's ledger entries for a vendor; absent reads as empty. An
 * unreadable ledger refuses with the typed store 409: nassaj never decides
 * ownership without it.
 */
export function readLedgerEntries(userId: string | number, vendorId: string): LedgerEntry[] {
  const read = store.readVendorLedgerState(userId, vendorId);
  if (read.state === 'unreadable') {
    throw new AppError(store.PROVIDER_SECRETS_STORE_REPAIR_MESSAGE, {
      code: store.PROVIDER_SECRETS_STORE_UNREADABLE, statusCode: 409,
    });
  }
  return read.state === 'ok' ? read.ledger.entries as LedgerEntry[] : [];
}

/** The entry for one projection, or undefined. */
export function findEntry(entries: readonly LedgerEntry[], pair: FileConsumer): LedgerEntry | undefined {
  return entries.find((entry) => samePair(entry, pair));
}

/**
 * Applies `mutate` to the member's ledger and stores the result in one
 * synchronous step; an empty result removes the record (store rule).
 */
export function updateLedger(
  userId: string | number,
  vendorId: string,
  mutate: (entries: LedgerEntry[]) => LedgerEntry[],
): void {
  const next = mutate(readLedgerEntries(userId, vendorId));
  store.setVendorLedger(userId, vendorId, { v: 1, entries: next });
}

/** Replaces (or adds) the entry for `entry`'s pair. */
export function withEntry(entries: readonly LedgerEntry[], entry: LedgerEntry): LedgerEntry[] {
  return [...entries.filter((candidate) => !samePair(candidate, entry)), entry];
}

/** Removes the entry for `pair`, if any. */
export function withoutEntry(entries: readonly LedgerEntry[], pair: FileConsumer): LedgerEntry[] {
  return entries.filter((candidate) => !samePair(candidate, pair));
}

/** The member's raw migration record; absent reads as a fresh one, unreadable as null. */
function readMigrationRecord(userId: string | number): Record<string, unknown> | null {
  const read = store.readVendorMigrationState(userId);
  if (read.state === 'unreadable') return null;
  return read.state === 'ok' ? { ...read.record } : { v: 1 };
}

/**
 * G2 (B-1570): records that the user deleted this vendor's key, so the
 * migration never adopts it back from a harness file. An unreadable record
 * refuses with the typed store 409: the delete must not go ahead unmarked.
 */
export function markVendorDeleted(userId: string | number, vendorId: string, at: string): void {
  const record = readMigrationRecord(userId);
  if (!record) {
    throw new AppError(store.PROVIDER_SECRETS_STORE_REPAIR_MESSAGE, {
      code: store.PROVIDER_SECRETS_STORE_UNREADABLE, statusCode: 409,
    });
  }
  store.setVendorMigrationState(userId, { ...record, deletedVendors: { ...readDeletedVendors(record), [vendorId]: at } });
}

/** An explicit Save clears the vendor's deletion marker; an unreadable record is left alone. */
export function clearVendorDeleted(userId: string | number, vendorId: string): void {
  const record = readMigrationRecord(userId);
  const deleted = record ? readDeletedVendors(record) : {};
  if (!record || !(vendorId in deleted)) return;
  delete deleted[vendorId];
  store.setVendorMigrationState(userId, { ...record, deletedVendors: deleted });
}
