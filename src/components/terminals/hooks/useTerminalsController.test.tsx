/**
 * B-1669: a user without the terminals role never calls /api/terminals (the
 * server answers 403 by design) and never logs; losing the role clears the list.
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const stableT = (key: string) => key;

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: stableT }) }));
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

import { canUseTerminals } from '../utils/canUseTerminals';

import { useTerminalsController } from './useTerminalsController';

const LIST = { terminals: [{ id: 't1', title: 'One' }] };
const okList = () => ({ ok: true, status: 200, json: async () => LIST });

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchMock.mockReset();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  consoleError.mockRestore();
});

describe('canUseTerminals', () => {
  it('allows owner and admin only', () => {
    expect(canUseTerminals('owner')).toBe(true);
    expect(canUseTerminals('admin')).toBe(true);
    expect(canUseTerminals('user')).toBe(false);
    expect(canUseTerminals(undefined)).toBe(false);
    expect(canUseTerminals(null)).toBe(false);
  });
});

describe('useTerminalsController enabled gate', () => {
  it('disabled: no request, no log, not loading, mutations are no-ops', async () => {
    const { result } = renderHook(() => useTerminalsController({ enabled: false }));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.terminals).toEqual([]);
    await act(async () => {
      await result.current.refresh();
      expect(await result.current.createTerminal()).toBeNull();
      expect(await result.current.renameTerminal('t1', 'x')).toBe(false);
      expect(await result.current.deleteTerminal('t1')).toBe(false);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('enabled: loads the list once', async () => {
    fetchMock.mockResolvedValue(okList());
    const { result } = renderHook(() => useTerminalsController({ enabled: true }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.terminals).toEqual(LIST.terminals);
  });

  it('false -> true after auth resolves: loading shows, then exactly one GET', async () => {
    fetchMock.mockResolvedValue(okList());
    const { result, rerender } = renderHook(
      ({ enabled }) => useTerminalsController({ enabled }),
      { initialProps: { enabled: false } },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ enabled: true });
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.terminals).toEqual(LIST.terminals));
    expect(result.current.isLoading).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('true -> false clears the previous user list and error', async () => {
    fetchMock.mockResolvedValue(okList());
    const { result, rerender } = renderHook(
      ({ enabled }) => useTerminalsController({ enabled }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.terminals).toEqual(LIST.terminals));
    rerender({ enabled: false });
    expect(result.current.terminals).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('a 403 while enabled sets the error without a console error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    const { result } = renderHook(() => useTerminalsController({ enabled: true }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('errors.loadFailed');
    expect(result.current.terminals).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
