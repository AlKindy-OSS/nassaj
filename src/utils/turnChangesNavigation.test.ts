/** T-2095: the chip → git panel hand-off carries one session turn target. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openTurnChanges, peekTurnChangesTarget, subscribeTurnChanges, takeTurnChangesTarget } from './turnChangesNavigation';

afterEach(() => { takeTurnChangesTarget(); });

describe('turnChangesNavigation', () => {
  it('notifies subscribers with the requested session turn', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTurnChanges(listener);
    openTurnChanges({ sessionId: 's-1', turnSeq: 3 });
    expect(listener).toHaveBeenCalledWith({ sessionId: 's-1', turnSeq: 3 });
    unsubscribe();
    openTurnChanges({ sessionId: 's-1', turnSeq: 4 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps the latest target until the panel takes it', () => {
    openTurnChanges({ sessionId: 's-1', turnSeq: 3 });
    openTurnChanges({ sessionId: 's-2', turnSeq: 9 });
    expect(peekTurnChangesTarget()).toEqual({ sessionId: 's-2', turnSeq: 9 });
    expect(takeTurnChangesTarget()).toEqual({ sessionId: 's-2', turnSeq: 9 });
    expect(takeTurnChangesTarget()).toBeNull();
  });
});
