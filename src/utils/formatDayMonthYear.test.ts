import { describe, expect, it } from 'vitest';

import { formatDayMonthYear } from './formatDayMonthYear';

describe('formatDayMonthYear', () => {
  it('prints day/month/year with zero padding and 24h time, no seconds', () => {
    expect(formatDayMonthYear(new Date(2026, 8, 10, 2, 0, 40).toISOString())).toBe('10/09/2026 02:00');
    expect(formatDayMonthYear(new Date(2026, 0, 5, 23, 7, 0).toISOString())).toBe('05/01/2026 23:07');
  });

  it('returns null for empty or invalid input', () => {
    expect(formatDayMonthYear(null)).toBeNull();
    expect(formatDayMonthYear(undefined)).toBeNull();
    expect(formatDayMonthYear('')).toBeNull();
    expect(formatDayMonthYear('not-a-date')).toBeNull();
  });
});
