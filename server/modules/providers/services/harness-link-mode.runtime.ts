/**
 * harness-link-mode.runtime — ADR-200 S4: the production wiring of the
 * link-mode service (store, inventory, writers, grants, audit). Kept apart from
 * the service so its tests inject plain fakes instead of mocking modules.
 */

import { providerRegistry } from '@/modules/providers/provider.registry.js';
// Namespace import on purpose (same reason as provider-secrets.service): many
// test files mock the database barrel with a partial export set.
import * as database from '@/modules/database/index.js';
import {
  PROJECTION_FINGERPRINT_KEY_VERSION,
  getCanonicalVendorKey,
  projectionFingerprint,
  readVendorLedgerState,
  setLinkModeRecord,
} from '@/services/isolation/provider-secrets-store.js';

import type { LinkHarness } from './harness-credential-inventory.js';
import type { AdoptedProjection } from './harness-link-mode.policy.js';
import { linkModeScopeDeps } from './harness-link-mode.scope.js';
import {
  createHarnessLinkModeService,
  type LinkModeWriter,
  type ProjectionLedgerPort,
} from './harness-link-mode.service.js';
import { findEntry, readLedgerEntries, updateLedger, withEntry, withoutEntry } from './vendor-key-fanout.ledger.js';
import { backupBeforeFirstWrite } from './vendor-key-backup.guard.js';

/** The canonical vendor record each link-mode harness is fed from (ADR-200 §1). */
const CANONICAL_VENDOR_FOR: Record<LinkHarness, string> = { claude: 'anthropic', codex: 'openai' };

function toAuditUserId(userId: string | number | null | undefined): number | undefined {
  const id = Number(userId);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

/** Canonical records are member-scoped; the anonymous operator has none. */
function readCanonicalKey(userId: string | number | null | undefined, harness: LinkHarness): string | null {
  if (userId === null || userId === undefined || userId === '') return null;
  try {
    return getCanonicalVendorKey(userId, CANONICAL_VENDOR_FOR[harness]);
  } catch {
    return null;
  }
}

/**
 * ADR-200 S6 (G2): the vendor ledger's live `adopted` entry for the harness's
 * own file (target null), so the link-mode status calls it adopted, not foreign.
 * The operator tree and an unreadable ledger have none.
 */
function adoptedProjection(ownerId: string | number | null | undefined, harness: LinkHarness): AdoptedProjection {
  if (ownerId === null || ownerId === undefined || ownerId === '') return null;
  const read = readVendorLedgerState(ownerId, CANONICAL_VENDOR_FOR[harness]);
  if (read.state !== 'ok') return null;
  const entry = read.ledger.entries.find((candidate) => candidate.harness === harness
    && candidate.target === null && candidate.origin === 'adopted' && candidate.state !== 'tombstone');
  return entry ? { fp: String(entry.fingerprint), keyVersion: Number(entry.keyVersion) } : null;
}

function isMemberTree(ownerId: string | number | null | undefined): ownerId is string | number {
  return ownerId !== null && ownerId !== undefined && ownerId !== '';
}

/**
 * The harness's own file entry after a switch wrote `projection`: `synced`, or
 * `failed` when the first record did not land (B-1575; the sweep re-verifies).
 * A still-equal adopted value keeps `adopted`; anything else is `fanout`.
 */
function writeOwnEntry(
  ownerId: string | number,
  harness: LinkHarness,
  projection: { fp: string; keyVersion: number },
  state: 'synced' | 'failed',
): void {
  const pair = { harness, target: null };
  updateLedger(ownerId, CANONICAL_VENDOR_FOR[harness], (entries) => {
    const previous = findEntry(entries, pair);
    const keptAdopted = previous?.origin === 'adopted' && previous.state !== 'tombstone'
      && previous.fingerprint === projection.fp && previous.keyVersion === projection.keyVersion;
    return withEntry(entries, {
      ...pair,
      fingerprint: projection.fp,
      keyVersion: projection.keyVersion,
      state,
      origin: keptAdopted ? 'adopted' : 'fanout',
      updatedAt: new Date().toISOString(),
    });
  });
}

/**
 * B-1574: the harness's own file (target null) in the vendor ledger, written
 * by a link-mode switch exactly as the fan-out writes it: origin `fanout`,
 * state `synced`. A still-equal adopted value keeps `adopted` (nassaj rewrote
 * the user's own key, it did not replace it). The operator tree has no ledger.
 */
const projectionLedger: ProjectionLedgerPort = {
  assertWritable(ownerId, harness) {
    if (isMemberTree(ownerId)) readLedgerEntries(ownerId, CANONICAL_VENDOR_FOR[harness]);
  },
  recordWritten(ownerId, harness, projection) {
    if (isMemberTree(ownerId)) writeOwnEntry(ownerId, harness, projection, 'synced');
  },
  recordFailed(ownerId, harness, projection) {
    if (isMemberTree(ownerId)) writeOwnEntry(ownerId, harness, projection, 'failed');
  },
  recordRemoved(ownerId, harness) {
    if (!isMemberTree(ownerId)) return;
    updateLedger(ownerId, CANONICAL_VENDOR_FOR[harness], (entries) => withoutEntry(entries, { harness, target: null }));
  },
};

/** ADR-200 §2: every link-mode harness write is preceded by the member's backup. */
function withBackups(harness: LinkHarness, writer: LinkModeWriter): LinkModeWriter {
  const remove = writer.deleteSubscriptionToken?.bind(writer);
  return {
    setApiKey: async (userId, ...rest) => {
      await backupBeforeFirstWrite(userId, harness);
      return writer.setApiKey(userId, ...rest);
    },
    deleteApiKey: async (userId, target) => {
      await backupBeforeFirstWrite(userId, harness);
      return writer.deleteApiKey(userId, target);
    },
    ...(remove ? {
      deleteSubscriptionToken: async (userId: string | number | null | undefined) => {
        await backupBeforeFirstWrite(userId, harness);
        return remove(userId);
      },
    } : {}),
  };
}

function resolveWriter(harness: LinkHarness): LinkModeWriter | null {
  try {
    const writer = providerRegistry.resolveProvider(harness).credentials ?? null;
    return writer ? withBackups(harness, writer) : null;
  } catch {
    return null;
  }
}

/**
 * Accepted (not declined) grants on a member's tree, to ACTIVE grantees only
 * (getUserById applies both activity guards). The operator tree has none.
 */
function countGrantees(ownerId: string | number | null | undefined, harness: LinkHarness): number {
  const id = toAuditUserId(ownerId);
  if (id === undefined) return 0;
  try {
    return (database.credentialGrantsDb?.listByOwner(id) ?? [])
      .filter((row) => row.provider === harness && row.declinedAt === null)
      .filter((row) => Boolean(database.userDb?.getUserById(row.granteeUserId))).length;
  } catch {
    return 0;
  }
}

export const harnessLinkModeService = createHarnessLinkModeService({
  isEnabled: linkModeScopeDeps.isEnabled,
  readInventory: linkModeScopeDeps.readInventory,
  readRecordState: linkModeScopeDeps.readRecordState,
  writeRecord: (userId, harness, record) => setLinkModeRecord(userId, harness, record),
  fingerprint: (value, keyVersion) => projectionFingerprint(value, keyVersion),
  keyVersion: PROJECTION_FINGERPRINT_KEY_VERSION,
  readCanonicalKey,
  resolveWriter,
  treeOwner: linkModeScopeDeps.treeOwner,
  countGrantees,
  adoptedProjection,
  projectionLedger,
  audit: (userId, metadata, context) => {
    database.auditLogDb?.record('link_mode_switched', {
      userId: toAuditUserId(userId),
      metadata,
      ipAddress: context?.ipAddress ?? undefined,
      userAgent: context?.userAgent ?? undefined,
    });
  },
  now: () => new Date(),
});
