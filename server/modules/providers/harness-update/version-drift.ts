/**
 * Harness version drift ledger (T-1871 stage 2).
 *
 * Persists the last installed version Nassaj SAW per harness in app_config
 * (`harness_version_seen`). A status read that finds a different installed
 * version, with no Nassaj update job having recorded that change, reports drift
 * and writes ONE `harness_version_drift` audit row per change. Update jobs call
 * `recordJobVersionChange` on success, so their own changes are never drift.
 *
 * All reads and writes are synchronous (better-sqlite3), so a read-modify-write
 * cannot interleave with another status read in the same process.
 */

import { appConfigDb, auditLogDb } from '@/modules/database/index.js';

import type { HarnessVersionDrift } from '../../../../shared/harness-update.contract.js';

const CONFIG_KEY = 'harness_version_seen';

interface DriftRecord {
  from: string;
  to: string;
  at: string;
}

interface SeenEntry {
  version: string;
  at: string;
  /** Last unexplained change still in effect, or null. */
  drift: DriftRecord | null;
}

export type SeenMap = Record<string, SeenEntry>;

/** Storage port for the ledger (app_config in production, memory in tests). */
export interface VersionLedger {
  read(): SeenMap;
  write(map: SeenMap): void;
}

export type DriftAudit = (metadata: { provider: string; from: string; to: string }) => void;

export interface DriftDeps {
  ledger?: VersionLedger;
  audit?: DriftAudit;
  nowIso?: () => string;
}

function isDriftRecord(value: unknown): value is DriftRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.from === 'string' && typeof v.to === 'string' && typeof v.at === 'string';
}

function isSeenEntry(value: unknown): value is SeenEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.version === 'string'
    && typeof v.at === 'string'
    && (v.drift === null || isDriftRecord(v.drift));
}

/**
 * Parses the stored JSON, dropping malformed entries instead of throwing. A
 * corrupt value reads as empty, so the next observation re-seeds the ledger.
 */
export function parseSeenMap(raw: string | null): SeenMap {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: SeenMap = {};
  for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (isSeenEntry(entry)) out[id] = entry;
  }
  return out;
}

/** Production ledger: one JSON value in app_config. */
export const appConfigVersionLedger: VersionLedger = {
  read: () => parseSeenMap(appConfigDb.get(CONFIG_KEY)),
  write: (map) => appConfigDb.set(CONFIG_KEY, JSON.stringify(map)),
};

const defaultAudit: DriftAudit = (metadata) => {
  auditLogDb.record('harness_version_drift', { userId: null, metadata });
};

/**
 * Records what the status read observed and returns the drift verdict.
 * First sighting seeds the ledger (no drift). An unchanged version returns the
 * drift still in effect. A changed version records a new drift and audits it
 * once. Throws only when the ledger itself fails (caller omits `drift`).
 */
export function observeInstalledVersion(
  provider: string,
  version: string,
  deps: DriftDeps = {},
): HarnessVersionDrift {
  const ledger = deps.ledger ?? appConfigVersionLedger;
  const audit = deps.audit ?? defaultAudit;
  const at = (deps.nowIso ?? (() => new Date().toISOString()))();
  const map = ledger.read();
  const entry = map[provider];

  if (!entry) {
    map[provider] = { version, at, drift: null };
    ledger.write(map);
    return { detected: false };
  }
  if (entry.version === version) {
    return entry.drift ? { detected: true, ...entry.drift } : { detected: false };
  }
  const drift: DriftRecord = { from: entry.version, to: version, at };
  map[provider] = { version, at, drift };
  ledger.write(map);
  audit({ provider, from: drift.from, to: drift.to });
  return { detected: true, ...drift };
}

/** Called by a successful Nassaj update job: the change is explained, not drift. */
export function recordJobVersionChange(
  provider: string,
  version: string,
  deps: Pick<DriftDeps, 'ledger' | 'nowIso'> = {},
): void {
  const ledger = deps.ledger ?? appConfigVersionLedger;
  const at = (deps.nowIso ?? (() => new Date().toISOString()))();
  const map = ledger.read();
  map[provider] = { version, at, drift: null };
  ledger.write(map);
}
