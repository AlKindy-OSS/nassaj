/**
 * ADR-207 (T-2024 S5): background prestage of the next release, as published
 * owner-only on GET /api/system/release/latest. Absent for everyone else, and
 * then nothing about it is ever shown.
 */
export type PrestageState = 'none' | 'waiting' | 'quarantine' | 'building' | 'ready' | 'adopted';

export interface PrestageStatus {
  state: PrestageState;
  version: string | null;
  quarantineUntil: string | null;
  notPrestagedReason: string | null;
  readySince: string | null;
}

const PRESTAGE_STATES: ReadonlyArray<string> = ['none', 'waiting', 'quarantine', 'building', 'ready', 'adopted'];
const REASON_PATTERN = /^[a-z_]{1,64}$/;

const isoOrNull = (value: unknown): string | null =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;

/** Validate the `prestage` field; never trust the response body as-is. */
export function normalizePrestage(value: unknown): PrestageStatus | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.state !== 'string' || !PRESTAGE_STATES.includes(raw.state)) return null;
  return {
    state: raw.state as PrestageState,
    version: typeof raw.version === 'string' && raw.version ? raw.version.slice(0, 64) : null,
    quarantineUntil: isoOrNull(raw.quarantineUntil),
    notPrestagedReason: typeof raw.notPrestagedReason === 'string' && REASON_PATTERN.test(raw.notPrestagedReason)
      ? raw.notPrestagedReason : null,
    readySince: isoOrNull(raw.readySince),
  };
}

/** True only when the prepared candidate is the very release on offer. */
export function isPrestageReadyFor(prestage: PrestageStatus | null | undefined, latestVersion: string | null): boolean {
  return Boolean(prestage && latestVersion && prestage.state === 'ready' && prestage.version === latestVersion);
}

export interface PrestageNotice {
  tone: 'ready' | 'neutral';
  key: string;
  /** Quarantine end (ISO), interpolated as local time. */
  until?: string;
}

/**
 * Owner-facing reason codes (closed vocabulary of
 * server/services/update-prestage-status.js) mapped to one plain line each.
 * Anything unlisted, including `other`, reads as "not prepared yet".
 */
const REASON_KEYS: Readonly<Record<string, string>> = {
  low_memory: 'lowMemory',
  low_disk: 'lowDisk',
  policy_off: 'stopped',
  kill_switch: 'stopped',
  resource_busy: 'busy',
  settling: 'settling',
  job_active: 'otherUpdate',
  slot_busy: 'otherUpdate',
  maintenance: 'maintenance',
  backoff: 'willRetry',
  interrupted: 'willRetry',
  failed: 'gaveUp',
  blocked: 'readinessBlocked',
  rejected: 'readinessBlocked',
  discovery_failed: 'sourceUnreachable',
  unsupported_mode: 'unavailable',
  not_owner_node: 'unavailable',
  release_unverified: 'unavailable',
};

/** The plain reason line for a release that is not prepared; never a raw code. */
function reasonKey(reason: string): string {
  const suffix = Object.prototype.hasOwnProperty.call(REASON_KEYS, reason) ? REASON_KEYS[reason] : 'notYet';
  return `versionUpdate.prestage.${suffix}`;
}

/**
 * Which one line the update dialog shows about the prestage, or null for
 * nothing. A ready candidate for an OLDER release is not "ready" for this one.
 */
export function prestageNotice(prestage: PrestageStatus | null | undefined, latestVersion: string | null): PrestageNotice | null {
  if (!prestage || !latestVersion) return null;
  if (isPrestageReadyFor(prestage, latestVersion)) return { tone: 'ready', key: 'versionUpdate.prestage.ready' };
  if (prestage.state === 'ready') return { tone: 'neutral', key: 'versionUpdate.prestage.notYet' };
  if (prestage.state === 'building') return { tone: 'neutral', key: 'versionUpdate.prestage.building' };
  if (prestage.state === 'quarantine') {
    return prestage.quarantineUntil
      ? { tone: 'neutral', key: 'versionUpdate.prestage.quarantine', until: prestage.quarantineUntil }
      : { tone: 'neutral', key: 'versionUpdate.prestage.notYet' };
  }
  if ((prestage.state === 'waiting' || prestage.state === 'none') && prestage.notPrestagedReason) {
    return { tone: 'neutral', key: reasonKey(prestage.notPrestagedReason) };
  }
  return null;
}

/**
 * Local clock time for the quarantine end; the weekday is added when it is not
 * today so "after 03:00" never reads as the wrong day.
 */
export function formatPrestageTime(iso: string, locale: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const sameDay = at.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(locale, sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(at);
}
