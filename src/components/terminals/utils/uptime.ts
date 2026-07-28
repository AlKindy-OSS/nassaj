// Uptime helpers for standalone terminals. A running terminal counts from its
// `createdAt` to "now"; an exited one freezes at `lastActivityAt` (the registry
// stamps it on exit), so the badge keeps showing the total runtime.

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
 * `HH:MM:SS` with UNBOUNDED hours (`73:04:09` after three days) — deliberately
 * digits-only so the badge needs no translation and reads identically in RTL.
 */
export function formatUptime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}
