/**
 * Server facts behind the `pinBreak` / `dataLoss` acknowledgements of the
 * harness actions (T-1871 stage 3, spec §6 + §9). Facts come from the digest
 * pin table, the live pin posture, the spawn ledger and the live stores —
 * never from the request. The pin table is only READ here.
 */

import path from 'node:path';

import { PINNED_VENDOR_DIGESTS } from '@/services/isolation/vendor-binary-integrity.js';

import type { AckAction, AckContext, DataLossFacts, PinBreakFacts, SuppliedAck } from './confirmation.js';
import type { HarnessDescriptor } from './descriptors.js';
import { hashFile } from './snapshot/durable-fs.js';
import type { HarnessSnapshotManifest, StoreBackupRecord } from './snapshot/manifest.js';
import { SNAPSHOT_MAX_AGE_MS } from './snapshot/retention.js';
import { enumerateStoreCoverage, storesFingerprint, type StoreSpec } from './snapshot/store-backup.js';
import type { SnapshotRuntime } from './snapshot-runtime.js';
import { compatibilityOf } from './version-status.service.js';

const HOUR_MS = 60 * 60 * 1000;

/** Display names used inside the server-built ack texts. */
const HARNESS_NAMES: Readonly<Record<string, string>> = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  opencode: 'OpenCode',
});

function pinOf(d: HarnessDescriptor): { version: string } | null {
  const pins = PINNED_VENDOR_DIGESTS as Readonly<Record<string, { version: string }>>;
  return d.pinKey !== null && d.pinKey in pins ? pins[d.pinKey] : null;
}

/**
 * pinBreak facts when moving `d` to `target` leaves its digest pin in a mode
 * that enforces it. An unknown target on a pinned harness is treated as
 * leaving the pin (conservative). Null when nothing would be blocked.
 */
export function pinBreakFacts(rt: SnapshotRuntime, d: HarnessDescriptor, target: string | null): PinBreakFacts | null {
  const pin = pinOf(d);
  if (!pin || target === pin.version) return null;
  const armed = rt.pinArmed();
  if (target !== null && compatibilityOf(d, target, armed).state !== 'incompatible') return null;
  if (!armed && !d.compat?.alwaysEnforcedMode) return null;
  return { variant: armed ? 'all' : 'carrier', target: target ?? 'latest', pin: pin.version };
}

/** Store kinds of `d` as a mutable list for the store helpers. */
function storeSpecs(d: HarnessDescriptor): StoreSpec[] {
  return [...(d.snapshot?.stores ?? [])];
}

/** Sets whose live bytes differ from the backup, plus sets that appeared since. */
function changedSetCount(d: HarnessDescriptor, rt: SnapshotRuntime, rec: StoreBackupRecord): number {
  const backed = new Map(rec.sets.map((s) => [`${s.dir}\0${s.base}`, s]));
  const live = enumerateStoreCoverage(storeSpecs(d), rt.home).sets;
  let changed = [...backed.keys()].filter((k) => !live.some((s) => `${s.dir}\0${s.base}` === k)).length;
  for (const set of live) {
    const before = backed.get(`${set.dir}\0${set.base}`);
    const differs = !before || set.members.some((m, i) => {
      const was = before.members[i];
      if (m.present !== was.present) return true;
      return m.present && hashFile(path.join(set.dir, set.base + m.suffix)).sha256 !== was.sha256;
    });
    if (differs) changed += 1;
  }
  return changed;
}

/** Spawn + live store facts of a succeeded run (the rollback / dataLoss path only: hashes stores). */
function dataRestoreFacts(rt: SnapshotRuntime, d: HarnessDescriptor, m: HarnessSnapshotManifest): {
  requiresAck: boolean; firstSpawnAt: number | null; spawnCount: number; storesChanged: boolean; unknown: boolean;
} {
  const spawn = rt.ledger.spawnFactsSince(d.id, m.jobId);
  const rec = m.stores;
  const storesChanged = rec !== null && storesFingerprint(rec.coverage) !== rec.postFingerprint;
  const requiresAck = rec !== null && rec.sets.length > 0 && (spawn.count > 0 || spawn.unknown || storesChanged);
  return { requiresAck, firstSpawnAt: spawn.firstSpawnAt, spawnCount: spawn.count, storesChanged, unknown: spawn.unknown };
}

/**
 * dataLoss facts for a `binary+data` rollback of `m`, or null when no
 * acknowledgement is needed (spec §6). `asideExpiry` is floored to the hour so
 * the facts (and the token bound to them) stay stable for the 5-minute token
 * life; the asides live at least that long.
 */
export function dataLossFacts(rt: SnapshotRuntime, d: HarnessDescriptor, m: HarnessSnapshotManifest): DataLossFacts | null {
  const facts = dataRestoreFacts(rt, d, m);
  if (!facts.requiresAck || !m.stores) return null;
  return {
    storeCount: m.stores.sets.length,
    backupAt: m.createdAt,
    spawnCount: facts.unknown ? null : facts.spawnCount,
    firstSpawnAt: facts.firstSpawnAt,
    changedStores: changedSetCount(d, rt, m.stores),
    asideExpiry: Math.floor((rt.now() + SNAPSHOT_MAX_AGE_MS) / HOUR_MS) * HOUR_MS,
  };
}

/** Throws CONFIRMATION_REQUIRED unless every ack the facts require was supplied. */
export function verifyActionAcks(
  rt: SnapshotRuntime,
  d: HarnessDescriptor,
  input: { action: AckAction; userId: number | null; pinBreak: PinBreakFacts | null; dataLoss: DataLossFacts | null; acks: unknown },
): void {
  if (!input.pinBreak && !input.dataLoss) return;
  const ctx: AckContext = {
    userId: input.userId ?? -1,
    harness: d.id,
    harnessName: HARNESS_NAMES[d.id] ?? d.id,
    action: input.action,
    pinBreak: input.pinBreak,
    dataLoss: input.dataLoss,
  };
  rt.acks().verifyAcks(ctx, Array.isArray(input.acks) ? (input.acks as SuppliedAck[]) : undefined);
}
