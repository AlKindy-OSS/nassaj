/**
 * harness auto-update settings (T-1749 / ADR-159 item 6 / D2).
 *
 * Owner decision: harnesses must keep updating continuously → enabled BY DEFAULT
 * with a 12h interval. Persisted as one JSON value in app_config; owner-only
 * GET/PUT at the route. `lastRunAt`/`nextRunAt` are tracked by the scheduler.
 */

import { appConfigDb } from '@/modules/database/index.js';
import type { HarnessAutoUpdateSettings } from '../../../../shared/harness-update.contract.js';

const CONFIG_KEY = 'harness_autoupdate';

/** 12h default interval (owner decision). */
export const DEFAULT_INTERVAL_MINUTES = 12 * 60;
export const MIN_INTERVAL_MINUTES = 30;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60; // one week

interface StoredSettings {
  enabled: boolean;
  intervalMinutes: number;
  lastRunAt: string | null;
}

function clampInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return DEFAULT_INTERVAL_MINUTES;
  return Math.min(Math.max(value, MIN_INTERVAL_MINUTES), MAX_INTERVAL_MINUTES);
}

function readStored(): StoredSettings {
  const defaults: StoredSettings = {
    enabled: true,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    lastRunAt: null,
  };
  try {
    const raw = appConfigDb.get(CONFIG_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<StoredSettings>;
    if (
      !parsed
      || typeof parsed !== 'object'
      || typeof parsed.enabled !== 'boolean'
      || typeof parsed.intervalMinutes !== 'number'
      || !Number.isSafeInteger(parsed.intervalMinutes)
      || parsed.intervalMinutes < MIN_INTERVAL_MINUTES
      || parsed.intervalMinutes > MAX_INTERVAL_MINUTES
      || !(parsed.lastRunAt === null || typeof parsed.lastRunAt === 'string')
    ) {
      return { ...defaults, enabled: false };
    }
    return {
      enabled: parsed.enabled,
      intervalMinutes: clampInterval(parsed.intervalMinutes),
      lastRunAt: parsed.lastRunAt,
    };
  } catch {
    return { ...defaults, enabled: false };
  }
}

function persist(next: StoredSettings): void {
  appConfigDb.set(CONFIG_KEY, JSON.stringify(next));
}

function withDerived(stored: StoredSettings): HarnessAutoUpdateSettings {
  let nextRunAt: string | null = null;
  if (stored.enabled) {
    const last = stored.lastRunAt ? Date.parse(stored.lastRunAt) : Date.now();
    const base = Number.isFinite(last) ? last : Date.now();
    nextRunAt = new Date(base + stored.intervalMinutes * 60_000).toISOString();
  }
  return {
    enabled: stored.enabled,
    intervalMinutes: stored.intervalMinutes,
    lastRunAt: stored.lastRunAt,
    nextRunAt,
  };
}

/** Current settings with derived nextRunAt. */
export function getAutoUpdateSettings(): HarnessAutoUpdateSettings {
  return withDerived(readStored());
}

/** Validates and persists a partial owner patch; returns the merged settings. */
export function setAutoUpdateSettings(
  patch: unknown,
): { ok: true; settings: HarnessAutoUpdateSettings } | { ok: false; error: string } {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'Settings must be an object' };
  }
  const p = patch as Record<string, unknown>;
  if ('enabled' in p && typeof p.enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be a boolean' };
  }
  if ('intervalMinutes' in p) {
    const n = p.intervalMinutes;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < MIN_INTERVAL_MINUTES || n > MAX_INTERVAL_MINUTES) {
      return {
        ok: false,
        error: `intervalMinutes must be between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`,
      };
    }
  }
  const current = readStored();
  const next: StoredSettings = {
    enabled: 'enabled' in p ? Boolean(p.enabled) : current.enabled,
    intervalMinutes: 'intervalMinutes' in p ? clampInterval(p.intervalMinutes) : current.intervalMinutes,
    lastRunAt: current.lastRunAt,
  };
  persist(next);
  return { ok: true, settings: withDerived(next) };
}

/** Scheduler-only: stamp the last run time. */
export function markSchedulerRun(at: string): void {
  const current = readStored();
  persist({ ...current, lastRunAt: at });
}
