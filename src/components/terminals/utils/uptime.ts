// Uptime helpers for standalone terminals. A running terminal counts from its
// `createdAt` to "now"; an exited one freezes at `lastActivityAt` (the registry
// stamps it on exit), so the badge keeps showing the total runtime.

import { formatWorkDuration, type WorkDurationLocale } from '../../../utils/workDurationFormat';

export type UptimeSource = {
  status: 'running' | 'exited';
  createdAt: string;
  lastActivityAt: string;
};

/**
 * Elapsed milliseconds for a terminal, or null when the timestamps are
 * unusable (never throws — the badge simply renders nothing).
 */
export function terminalUptimeMs(terminal: UptimeSource, now: number): number | null {
  const started = Date.parse(terminal.createdAt);
  if (!Number.isFinite(started)) {
    return null;
  }
  const ended = terminal.status === 'exited' ? Date.parse(terminal.lastActivityAt) : now;
  if (!Number.isFinite(ended)) {
    return null;
  }
  return Math.max(0, ended - started);
}

/**
 * Uses the product-wide elapsed-work notation, including calendar-scale units
 * for exceptionally long-running terminals.
 */
export function formatUptime(ms: number, locale: WorkDurationLocale = 'en'): string {
  return formatWorkDuration(Math.max(0, ms), locale);
}
