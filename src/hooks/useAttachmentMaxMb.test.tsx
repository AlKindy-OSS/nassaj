/**
 * The composer's attachment cap comes from the one storage-policy fetch path,
 * falls back to 50 MB while loading or on failure, reads the
 * member-readable `/api/system/attachment-limit` (owners and members alike), and follows owner saves.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

import { DEFAULT_ATTACHMENT_MAX_MB, publishStoragePolicy, resetStoragePolicyForTests } from '../utils/storagePolicy';

import { useAttachmentMaxMb } from './useAttachmentMaxMb';

beforeEach(() => {
  fetchMock.mockReset();
  resetStoragePolicyForTests();
});

afterEach(() => vi.restoreAllMocks());

function limitResponse(attachmentMaxMb: number) {
  return { ok: true, status: 200, json: async () => ({ attachmentMaxMb }) };
}

describe('useAttachmentMaxMb', () => {
  it('defaults to 50 MB, then uses the server limit', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ attachmentMaxMb: 150 }) });
    const { result } = renderHook(() => useAttachmentMaxMb());
    expect(result.current).toBe(DEFAULT_ATTACHMENT_MAX_MB);
    expect(DEFAULT_ATTACHMENT_MAX_MB).toBe(50);
    await waitFor(() => expect(result.current).toBe(150));
    expect(fetchMock).toHaveBeenCalledWith('/api/system/attachment-limit');
  });

  it('keeps 50 MB when the fetch fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const { result } = renderHook(() => useAttachmentMaxMb());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toBe(50);
  });

  it('fetches once for many composers and follows a later owner save', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ attachmentMaxMb: 80 }) });
    const a = renderHook(() => useAttachmentMaxMb());
    const b = renderHook(() => useAttachmentMaxMb());
    await waitFor(() => expect(a.result.current).toBe(80));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => publishStoragePolicy({ attachmentMaxMb: 30 }));
    expect(a.result.current).toBe(30);
    expect(b.result.current).toBe(30);
  });

  it('ignores an invalid value from the server', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ attachmentMaxMb: 'x' }) });
    const { result } = renderHook(() => useAttachmentMaxMb());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(result.current).toBe(50);
  });

  it('a limit raised elsewhere reaches an open page when it regains focus', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    fetchMock.mockResolvedValueOnce(limitResponse(50)).mockResolvedValueOnce(limitResponse(120));
    const { result } = renderHook(() => useAttachmentMaxMb());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    now += 11_000;
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(result.current).toBe(120));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('becoming visible again refreshes too', async () => {
    let now = 2_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    fetchMock.mockResolvedValueOnce(limitResponse(50)).mockResolvedValueOnce(limitResponse(80));
    const { result } = renderHook(() => useAttachmentMaxMb());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    now += 11_000;
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(result.current).toBe(80));
  });

  it('focus bursts within 10 seconds do not refetch', async () => {
    let now = 3_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    fetchMock.mockResolvedValue(limitResponse(50));
    renderHook(() => useAttachmentMaxMb());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    now += 5_000;
    act(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
