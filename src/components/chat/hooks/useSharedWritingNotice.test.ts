/**
 * ADR-173 P6 — which shared-writing notice the composer shows: a server notice
 * for this session first; before any send, a member viewing another member's
 * conversation on a creator-only provider sees the fork banner up front.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useSharedWritingNotice } from './useSharedWritingNotice';

const owner = { userId: 1, username: 'ibrahim' };

type HookProps = Parameters<typeof useSharedWritingNotice>[0];

function setup(initial: Partial<HookProps>) {
  const base: HookProps = { sessionId: 's1', provider: 'codex', owner, currentUserId: 2 };
  return renderHook((props: HookProps) => useSharedWritingNotice(props), { initialProps: { ...base, ...initial } });
}

describe('useSharedWritingNotice', () => {
  it('shows the fork banner before sending in another member conversation on a creator-only provider', () => {
    const { result } = setup({});
    expect(result.current.notice).toEqual({
      kind: 'unsupported', sessionId: 's1', provider: 'codex', creatorName: 'ibrahim', canFork: true,
    });
  });

  it('shows nothing up front to the creator, on Claude, or without a known owner', () => {
    expect(setup({ currentUserId: 1 }).result.current.notice).toBeNull();
    expect(setup({ provider: 'claude' }).result.current.notice).toBeNull();
    expect(setup({ owner: null }).result.current.notice).toBeNull();
    expect(setup({ provider: 'opencode' }).result.current.notice).toMatchObject({ canFork: false });
  });

  it('prefers the server notice for this session and drops it on another session', () => {
    const { result, rerender } = setup({ provider: 'claude' });
    act(() => result.current.setNotice({
      kind: 'busy', sessionId: 's1', busyBy: 1, phase: 'running', stuck: false, canStop: false,
    }));
    expect(result.current.notice?.kind).toBe('busy');
    rerender({ sessionId: 's2', provider: 'claude', owner, currentUserId: 2 });
    expect(result.current.notice).toBeNull();
  });

  it('dismiss hides the up-front banner for that session only', () => {
    const { result, rerender } = setup({});
    act(() => result.current.dismiss());
    expect(result.current.notice).toBeNull();
    rerender({ sessionId: 's2', provider: 'codex', owner, currentUserId: 2 });
    expect(result.current.notice?.sessionId).toBe('s2');
  });
});
