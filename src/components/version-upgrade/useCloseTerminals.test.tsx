/**
 * B-1448 slice 2 review fixes (qa-critic T4a/T4b and the not-overridable
 * reasons): the hook keeps the `remaining` count and leaves `done` once the
 * poll shows a different terminal set.
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authenticatedFetch = vi.fn();
vi.mock('../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const { closeTerminalsErrorKey, NOT_OVERRIDABLE_REASONS, useCloseTerminals } = await import('./useCloseTerminals');

const set = (snapshot: string, count = 2) => ({
  count, attached: count, detached: 0, usernames: ['sara'], detachedClosesAt: null, snapshot,
});
const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response;
const A = set('a'.repeat(32));
const B = set('b'.repeat(32), 1);

async function closeWith(body: Record<string, unknown>, current = A) {
  authenticatedFetch.mockResolvedValue(reply(200, body));
  const hook = renderHook(({ terminals }) => useCloseTerminals('job-1', terminals), { initialProps: { terminals: current } });
  act(() => hook.result.current.open());
  await act(async () => { await hook.result.current.confirm(); });
  return hook;
}

beforeEach(() => authenticatedFetch.mockReset());

describe('useCloseTerminals after a close', () => {
  it('T4a: keeps the remaining count', async () => {
    const hook = await closeWith({ status: 'closed', closed: 2, remaining: 1, activation: 'triggered' });
    expect(hook.result.current.phase).toBe('done');
    expect(hook.result.current.closedCount).toBe(2);
    expect(hook.result.current.remainingCount).toBe(1);
  });

  it('T4b: stays done while the poll shows the closed set, returns to idle on a new one', async () => {
    const hook = await closeWith({ status: 'closed', closed: 2, remaining: 1, activation: 'triggered' });
    hook.rerender({ terminals: set(A.snapshot) });
    expect(hook.result.current.phase).toBe('done');
    hook.rerender({ terminals: B });
    expect(hook.result.current.phase).toBe('idle');
    // The outcome stays readable next to the returned button.
    expect(hook.result.current.remainingCount).toBe(1);
  });

  it('T4b: opening the confirmation again clears the previous outcome', async () => {
    const hook = await closeWith({ status: 'closed', closed: 2, remaining: 1, activation: 'triggered' });
    hook.rerender({ terminals: B });
    act(() => hook.result.current.open());
    expect(hook.result.current.phase).toBe('confirming');
    expect(hook.result.current.confirmSet?.snapshot).toBe(B.snapshot);
    expect(hook.result.current.remainingCount).toBe(0);
  });

  it('keeps the server reason of update_not_overridable', async () => {
    authenticatedFetch.mockResolvedValue(reply(409, { code: 'update_not_overridable', reason: 'scheduled_wait' }));
    const hook = renderHook(() => useCloseTerminals('job-1', A));
    act(() => hook.result.current.open());
    await act(async () => { await hook.result.current.confirm(); });
    expect(hook.result.current.error).toEqual({ kind: 'error', code: 'update_not_overridable', status: 409, reason: 'scheduled_wait' });
  });
});

describe('closeTerminalsErrorKey not-overridable reasons', () => {
  it.each(NOT_OVERRIDABLE_REASONS)('maps %s to its own key', (reason) => {
    expect(closeTerminalsErrorKey({ code: 'update_not_overridable', status: 409, reason }))
      .toBe(`notOverridableReasons.${reason}`);
  });

  it('falls back to the generic key when the reason is absent or unknown', () => {
    expect(closeTerminalsErrorKey({ code: 'update_not_overridable', status: 409 })).toBe('notOverridable');
    expect(closeTerminalsErrorKey({ code: 'update_not_overridable', status: 409, reason: null })).toBe('notOverridable');
    expect(closeTerminalsErrorKey({ code: 'update_not_overridable', status: 409, reason: 'brand_new' })).toBe('notOverridable');
  });
});
