import { describe, expect, it } from 'vitest';

import { formatUptime, terminalUptimeMs } from './uptime';

const CREATED = '2026-07-28T00:00:00.000Z';
const CREATED_MS = Date.parse(CREATED);

describe('formatUptime', () => {
  it('pads to HH:MM:SS', () => {
    expect(formatUptime(0)).toBe('0ms');
    expect(formatUptime(9_000)).toBe('9.0s');
    expect(formatUptime(65_000)).toBe('1m 5.0s');
    expect(formatUptime(3_661_000)).toBe('1h 1m 1.0s');
  });

  it('lets hours grow past a day instead of wrapping', () => {
    expect(formatUptime(26 * 3_600_000)).toBe('1d 2h 0.0s');
    expect(formatUptime(73 * 3_600_000 + 4 * 60_000 + 9_000)).toBe('3d 1h 4m 9.0s');
  });

  it('floors sub-second remainders and clamps negatives', () => {
    expect(formatUptime(1_999)).toBe('1.9s');
    expect(formatUptime(-5_000)).toBe('0ms');
  });
});

describe('terminalUptimeMs', () => {
  it('counts a running terminal up to now', () => {
    const terminal = { status: 'running' as const, createdAt: CREATED, lastActivityAt: CREATED };
    expect(terminalUptimeMs(terminal, CREATED_MS + 42_000)).toBe(42_000);
  });

  it('ignores lastActivityAt while running', () => {
    const terminal = {
      status: 'running' as const,
      createdAt: CREATED,
      lastActivityAt: '2026-07-28T00:00:05.000Z',
    };
    expect(terminalUptimeMs(terminal, CREATED_MS + 60_000)).toBe(60_000);
  });

  it('freezes an exited terminal at its exit instant', () => {
    const terminal = {
      status: 'exited' as const,
      createdAt: CREATED,
      lastActivityAt: '2026-07-28T00:02:00.000Z',
    };
    // Frozen regardless of how far "now" has moved on.
    expect(terminalUptimeMs(terminal, CREATED_MS + 999_000)).toBe(120_000);
  });

  it('clamps a clock-skewed exit that precedes creation', () => {
    const terminal = {
      status: 'exited' as const,
      createdAt: CREATED,
      lastActivityAt: '2026-07-27T23:59:00.000Z',
    };
    expect(terminalUptimeMs(terminal, CREATED_MS)).toBe(0);
  });

  it('returns null for unparsable timestamps', () => {
    expect(
      terminalUptimeMs({ status: 'running', createdAt: 'nonsense', lastActivityAt: CREATED }, CREATED_MS),
    ).toBeNull();
    expect(
      terminalUptimeMs({ status: 'exited', createdAt: CREATED, lastActivityAt: '' }, CREATED_MS),
    ).toBeNull();
  });
});
