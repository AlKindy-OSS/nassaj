/**
 * اختبارات T-900 — useProviderGovernance
 *
 * يغطّي:
 *   - 200 governed+enforced ⇒ GovernanceDescriptor صحيح
 *   - 200 governed+unenforced ⇒ GovernanceDescriptor صحيح
 *   - 200 ungoverned ⇒ GovernanceDescriptor صحيح
 *   - 404 (خادم قديم بلا الـendpoint) ⇒ null صامت
 *   - خطأ شبكي ⇒ null صامت (لا رمي، لا console.error)
 *   - payload مشوّه (حقل ناقص) ⇒ null صامت
 *   - provider=undefined ⇒ null فوراً بلا fetch
 *   - تغيُّر provider ⇒ إعادة جلب
 *
 * Run: npm run test:client -- src/components/chat/hooks/useProviderGovernance.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

import { authenticatedFetch } from '../../../utils/api';

vi.mock('../../../utils/api', () => ({
  authenticatedFetch: vi.fn(),
}));

import { useProviderGovernance } from './useProviderGovernance';
import type { GovernanceDescriptor } from './useProviderGovernance';

const fetchMock = vi.mocked(authenticatedFetch);

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function errorResponse(status: number) {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------

describe('useProviderGovernance', () => {
  it('returns null on mount before fetch resolves', () => {
    fetchMock.mockImplementation(() => new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useProviderGovernance('claude'));
    expect(result.current).toBeNull();
  });

  it('returns GovernanceDescriptor for governed+enforced (codex)', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        success: true,
        data: {
          provider: 'codex',
          status: 'governed',
          enforced: true,
          mechanism: 'codex-fingerprint',
        },
      }),
    );
    const { result } = renderHook(() => useProviderGovernance('codex'));
    await flushMicrotasks();

    const expected: GovernanceDescriptor = {
      provider: 'codex',
      status: 'governed',
      enforced: true,
      mechanism: 'codex-fingerprint',
    };
    expect(result.current).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/codex/governance');
  });

  it('returns GovernanceDescriptor for governed+unenforced (claude)', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        success: true,
        data: {
          provider: 'claude',
          status: 'governed',
          enforced: false,
          mechanism: 'claude-md',
        },
      }),
    );
    const { result } = renderHook(() => useProviderGovernance('claude'));
    await flushMicrotasks();

    expect(result.current).toEqual<GovernanceDescriptor>({
      provider: 'claude',
      status: 'governed',
      enforced: false,
      mechanism: 'claude-md',
    });
  });

  it('returns GovernanceDescriptor for ungoverned (hermes)', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        success: true,
        data: {
          provider: 'hermes',
          status: 'ungoverned',
          enforced: false,
          mechanism: 'none',
        },
      }),
    );
    const { result } = renderHook(() => useProviderGovernance('hermes'));
    await flushMicrotasks();

    expect(result.current).toEqual<GovernanceDescriptor>({
      provider: 'hermes',
      status: 'ungoverned',
      enforced: false,
      mechanism: 'none',
    });
  });

  it('returns null on 404 — old server without the endpoint (fail-HIDDEN, not fail-ungoverned)', async () => {
    fetchMock.mockResolvedValue(errorResponse(404));
    const { result } = renderHook(() => useProviderGovernance('claude'));
    await flushMicrotasks();
    expect(result.current).toBeNull();
  });

  it('returns null on network error — silent, no throw', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useProviderGovernance('codex'));
    await flushMicrotasks();
    expect(result.current).toBeNull();
  });

  it('returns null for a malformed payload — missing enforced field', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        success: true,
        data: { provider: 'claude', status: 'governed' /* enforced and mechanism absent */ },
      }),
    );
    const { result } = renderHook(() => useProviderGovernance('claude'));
    await flushMicrotasks();
    expect(result.current).toBeNull();
  });

  it('returns null for a malformed payload — unknown status value', async () => {
    fetchMock.mockResolvedValue(
      okResponse({
        success: true,
        data: { provider: 'claude', status: 'unknown-state', enforced: true, mechanism: 'claude-md' },
      }),
    );
    const { result } = renderHook(() => useProviderGovernance('claude'));
    await flushMicrotasks();
    expect(result.current).toBeNull();
  });

  it('returns null immediately when provider is undefined — no fetch fired', async () => {
    const { result } = renderHook(() => useProviderGovernance(undefined));
    await flushMicrotasks();
    expect(result.current).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null immediately when provider is null — no fetch fired', async () => {
    const { result } = renderHook(() => useProviderGovernance(null));
    await flushMicrotasks();
    expect(result.current).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-fetches with the new provider URL when provider changes', async () => {
    fetchMock
      .mockResolvedValueOnce(
        okResponse({
          success: true,
          data: { provider: 'claude', status: 'governed', enforced: false, mechanism: 'claude-md' },
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          success: true,
          data: { provider: 'hermes', status: 'ungoverned', enforced: false, mechanism: 'none' },
        }),
      );

    const { result, rerender } = renderHook(
      ({ prov }: { prov: 'claude' | 'hermes' }) => useProviderGovernance(prov),
      { initialProps: { prov: 'claude' as 'claude' | 'hermes' } },
    );
    await flushMicrotasks();
    expect(result.current?.status).toBe('governed');
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/claude/governance');

    rerender({ prov: 'hermes' });
    await flushMicrotasks();
    expect(result.current?.status).toBe('ungoverned');
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/hermes/governance');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
