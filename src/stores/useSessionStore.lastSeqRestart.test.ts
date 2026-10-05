import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../contexts/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ refreshProjects: async () => {} }),
}));
vi.mock('../utils/api', () => ({ authenticatedFetch: vi.fn() }));

import { useSessionStore } from './useSessionStore';

describe('lastSeq follows a restarted server sequence line', () => {
  it('lowers the floor for an unseen run, keeps it for same-run and late frames', () => {
    const { result } = renderHook(() => useSessionStore());
    const store = result.current;
    store.recordSeq('s', 3, 'run-1');
    store.recordSeq('s', 9, 'run-1');
    expect(store.getLastSeq('s')).toBe(9);
    store.recordSeq('s', 2, 'run-1');
    expect(store.getLastSeq('s')).toBe(9);
    store.recordSeq('s', 1, 'run-2');
    expect(store.getLastSeq('s')).toBe(1);
    store.recordSeq('s', 5, 'run-1');
    expect(store.getLastSeq('s')).toBe(5);
    store.recordSeq('s', 2, 'run-1');
    expect(store.getLastSeq('s')).toBe(5);
  });

  it('without a run id it stays a monotonic max', () => {
    const { result } = renderHook(() => useSessionStore());
    result.current.recordSeq('t', 7);
    result.current.recordSeq('t', 1);
    expect(result.current.getLastSeq('t')).toBe(7);
  });
});
