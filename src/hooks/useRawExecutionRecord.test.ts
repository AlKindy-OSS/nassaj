import { describe, it, expect } from 'vitest';

import { isExecutionDone, parseExecutionRecord } from './useRawExecutionRecord';

describe('parseExecutionRecord', () => {
  it('accepts a well-formed ledger entry', () => {
    const r = parseExecutionRecord({
      executedAt: '2026-10-04T09:30:00.000Z', outcome: 'success', exitCode: 0, executedBy: 'owner',
    });
    expect(r).toEqual({
      executedAt: '2026-10-04T09:30:00.000Z', outcome: 'success', exitCode: 0, executedBy: 'owner',
    });
  });

  it.each([
    null, undefined, 'x', {}, { executedAt: 'not-a-date', outcome: 'success' },
    { executedAt: '2026-10-04T09:30:00.000Z', outcome: 'weird' },
  ])('fails closed on %j', (v) => {
    expect(parseExecutionRecord(v)).toBeNull();
  });

  it('only a clean success retires the button', () => {
    const base = { executedAt: '2026-10-04T09:30:00.000Z', exitCode: 0, executedBy: null };
    expect(isExecutionDone({ ...base, outcome: 'success' })).toBe(true);
    expect(isExecutionDone({ ...base, outcome: 'failure' })).toBe(false);
    expect(isExecutionDone({ ...base, outcome: 'unknown' })).toBe(false);
    expect(isExecutionDone(null)).toBe(false);
  });
});
