import { describe, expect, it } from 'vitest';

import { formatUptime, terminalUptimeMs } from './uptime';

const CREATED = '2026-07-28T00:00:00.000Z';
const CREATED_MS = Date.parse(CREATED);

describe('formatUptime', () => {
  it('pads to HH:MM:SS', () => {
    expect(formatUptime(0)).toBe('00:00:00');
    expect(formatUptime(9_000)).toBe('00:00:09');
    expect(formatUptime(65_000)).toBe('00:01:05');
    expect(formatUptime(3_661_000)).toBe('01:01:01');
  });

  it('lets hours grow past a day instead of wrapping', () => {
    expect(formatUptime(26 * 3_600_000)).toBe('26:00:00');
    expect(formatUptime(73 * 3_600_000 + 4 * 60_000 + 9_000)).toBe('73:04:09');
  });

  it('floors sub-second remainders and clamps negatives', () => {
    expect(formatUptime(1_999)).toBe('00:00:01');
    expect(formatUptime(-5_000)).toBe('00:00:00');
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
