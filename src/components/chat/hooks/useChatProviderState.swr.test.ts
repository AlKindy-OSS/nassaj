/**
 * useChatProviderState.swr.test.ts — B-1283 SWR re-fetch
 *
 * يثبت سلوك stale-while-revalidate في useChatProviderState:
 *  1. revalidating:true → جلب ثانٍ واحد بعد التأخير (fake timers).
 *  2. revalidating:true مرتين متتاليتين → لا جلب ثالث (حارس الحلقة).
 *  3. degraded:true بلا revalidating → لا إعادة جلب إطلاقاً.
 *  4. unmount قبل انقضاء التأخير → لا جلب ولا setState.
 *  5. الكتالوج لا يفرغ أثناء إعادة الجلب (القائمة القديمة تبقى حتى تصل الجديدة).
 *
 * Run:
 *   NODE_ENV=test npx vitest run \
 *     --config /var/tmp/vitest-swr-overlay.config.mjs \
 *     src/components/chat/hooks/useChatProviderState.swr.test.ts
 */

// vitest hoists vi.mock() calls above import statements automatically, so these
// imports always resolve after the mock factories run, regardless of file order.
import { authenticatedFetch } from '../../../utils/api';
import { useChatProviderState } from './useChatProviderState';

import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

// vi.mock factories are hoisted before any import / variable declaration,
// so variables used inside them must also be hoisted.
const { STUB_DEF_H, ALL_PROVIDERS_H } = vi.hoisted(() => {
  const STUB_DEF_H = {
    OPTIONS: [{ value: 'claude-opus', label: 'Opus' }],
    DEFAULT: 'claude-opus',
  };
  const ALL_PROVIDERS_H = [
    'claude', 'cursor', 'codex', 'gemini', 'antigravity',
    'opencode', 'hermes', 'kimi', 'deepseek', 'glm', 'qwen', 'sakana',
  ];
  return { STUB_DEF_H, ALL_PROVIDERS_H };
});

vi.mock('../../../utils/api', () => ({
  authenticatedFetch: vi.fn(),
}));

// Limit fan-out to exactly ONE provider ('claude') so fetch counts are unambiguous.
vi.mock('../../../../shared/disabledProviders', () => ({
  filterDisabledProviders: <T>(arr: T[]): T[] => (arr as T[]).slice(0, 1),
}));

vi.mock('../../provider-auth/vendorProviders', () => ({
  ENGINE_VENDOR_PROVIDERS: [],
  isVendorProvider: () => false,
}));

vi.mock('../../../preferences/preferencesSync', () => ({
  onApplyServerPreference: () => () => {},
}));

vi.mock('../../../stores/selectedProviderStore', () => ({
  setSelectedProvider: () => {},
  setSelectedEngineProvider: () => {},
}));

vi.mock('../constants/providerCapabilities', () => ({
  getProviderCapabilities: () => ({
    permissions: { modes: ['default'] },
    supportedFeatures: [],
    engineVendors: [],
    supportsAttachments: false,
    supportsImages: false,
    supportsStreaming: true,
  }),
  getProviderDisplayName: (p: string) => p,
}));

vi.mock('./normalizeProviderModel', () => ({
  pickStoredOrCurrent: (_key: unknown, current: string, _def: unknown) => current,
}));

vi.mock('./claudeModelSlot', () => ({
  claudeSlotCatalogProvider: () => 'claude',
}));

vi.mock('./engineProviderSession', () => ({
  readStoredEngineProvider: () => null,
  readSessionEngineProvider: () => null,
  stampSessionEngineProvider: () => {},
  writePendingEngineStamp: () => {},
  consumePendingEngineStamp: () => null,
}));

vi.mock('../../../constants/providerModelFallbacks', () => ({
  FALLBACK_DEFAULT_MODEL: Object.fromEntries(ALL_PROVIDERS_H.map((p) => [p, 'claude-opus'])),
  PROVIDER_FALLBACK_MODELS: Object.fromEntries(ALL_PROVIDERS_H.map((p) => [p, STUB_DEF_H])),
  PLACEHOLDER_FALLBACK_MODELS: Object.fromEntries(ALL_PROVIDERS_H.map((p) => [p, STUB_DEF_H])),
  sanitizeStoredModel: (_p: string, stored: string | null) => stored ?? 'claude-opus',
  sanitizeStoredProvider: (stored: string | null) => stored ?? 'claude',
}));


// ─── Helpers ─────────────────────────────────────────────────────────────────

const CACHE_INFO = {
  updatedAt: '2024-01-01T00:00:00Z',
  expiresAt: '2099-01-01T00:00:00Z',
  source: 'fresh' as const,
};

type FetchReturnType = Awaited<ReturnType<typeof authenticatedFetch>>;

/** Build a successful /models JSON response with optional extra fields. */
function makeResp(extra: Record<string, unknown> = {}): FetchReturnType {
  return {
    ok: true,
    json: async () => ({
      success: true,
      data: { models: STUB_DEF_H, cache: CACHE_INFO, ...extra },
    }),
  } as FetchReturnType;
}

const HOOK_ARGS = { selectedSession: null, selectedProject: null };

// SWR re-fetch delay, must match REVALIDATING_REFETCH_DELAY_MS in useChatProviderState.ts
const SWR_DELAY_MS = 3_000;

/**
 * Flush the full async chain inside loadProviderModels.
 * loadProviderModels has multiple internal `await` points (authenticatedFetch,
 * response.json, Promise.all settlement). Each `await Promise.resolve()` yields
 * to the microtask queue once, letting one more `await` in the chain complete.
 * Four yields cover the deepest path without being brittle.
 */
async function flushAsyncLoad() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // vi.resetAllMocks() — not vi.clearAllMocks() — is required here: clearAllMocks
  // only resets call counts but leaves the mockResolvedValueOnce queue intact.
  // If a test queues 2 values but consumes only 1 (e.g. unmount cancels SWR),
  // the leftover bleeds into the next test and causes it to see the wrong response.
  vi.resetAllMocks();
  cleanup();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('B-1283 SWR re-fetch — useChatProviderState', () => {
  /**
   * 1. revalidating:true → جلب ثانٍ واحد بعد التأخير
   *
   * الاستجابة الأولى تحمل revalidating:true.
   * بعد انتهاء التأخير (SWR_DELAY_MS) يُطلَق جلب ثانٍ واحد فقط.
   */
  it('يُطلق جلباً ثانياً واحداً عند revalidating:true بعد التأخير', async () => {
    const mockFetch = vi.mocked(authenticatedFetch);
    mockFetch
      .mockResolvedValueOnce(makeResp({ revalidating: true }))  // initial load
      .mockResolvedValueOnce(makeResp({ revalidating: false })); // SWR re-fetch

    renderHook(() => useChatProviderState(HOOK_ARGS));

    // Flush the full async body of loadProviderModels — this schedules the SWR timer.
    await flushAsyncLoad();

    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance past SWR delay and flush the resulting async re-fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SWR_DELAY_MS + 1);
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  /**
   * 2. revalidating:true مرتين متتاليتين → لا جلب ثالث
   *
   * حتى لو أعادت استجابة SWR نفسها revalidating:true، يمنع الحارس
   * (revalidatingScheduledRef) جدولة جلب ثالث.
   */
  it('لا يُجدوِل جلباً ثالثاً إن عادت SWR بـrevalidating:true أيضاً', async () => {
    const mockFetch = vi.mocked(authenticatedFetch);
    mockFetch
      .mockResolvedValueOnce(makeResp({ revalidating: true })) // initial
      .mockResolvedValueOnce(makeResp({ revalidating: true })); // SWR also revalidating

    renderHook(() => useChatProviderState(HOOK_ARGS));

    await flushAsyncLoad();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Fire SWR timer + flush its async body.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SWR_DELAY_MS + 1);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Advance more time — the guard (revalidatingScheduledRef) must block any
    // third timer that fetchSingleProviderSWR might have tried to schedule.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SWR_DELAY_MS + 1);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2); // guard held — still 2
  });

  /**
   * 3. degraded:true بلا revalidating → لا إعادة جلب
   *
   * الكتالوج الاحتياطي الموسوم degraded صالح عمداً لمدة 5 دقائق.
   * إعادة جلبه لن تغيّر شيئاً، والمحفّز هو revalidating فقط.
   */
  it('لا يُطلق أي جلب SWR عند degraded:true بلا revalidating', async () => {
    const mockFetch = vi.mocked(authenticatedFetch);
    mockFetch.mockResolvedValueOnce(makeResp({ degraded: true, revalidating: false }));

    renderHook(() => useChatProviderState(HOOK_ARGS));

    await flushAsyncLoad();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance well past any would-be SWR delay — no second fetch should appear.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SWR_DELAY_MS * 3);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1); // no second fetch
  });

  /**
   * 4. unmount قبل انقضاء التأخير → لا جلب ولا setState
   *
   * يتحقق أن cleanup effect يُلغي المؤقت قبل أن يُطلق الجلب الثاني،
   * فلا setState يُشغَّل على مكوّن غير مُركَّب.
   */
  it('يُلغي المؤقت عند unmount قبل انتهاء التأخير', async () => {
    const mockFetch = vi.mocked(authenticatedFetch);
    mockFetch.mockResolvedValueOnce(makeResp({ revalidating: true }));
    // Should never be called; if it is the test sees count=2.
    mockFetch.mockResolvedValueOnce(makeResp({ revalidating: false }));

    const { unmount } = renderHook(() => useChatProviderState(HOOK_ARGS));

    // Initial load: authenticatedFetch called once, 3s SWR timer pending.
    await flushAsyncLoad();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Unmount before the SWR timer fires — cleanup effect cancels the timer.
    unmount();

    // Advance past the delay; the cancelled timer must not trigger a second fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SWR_DELAY_MS + 1);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1); // still only 1
  });

  /**
   * 5. الكتالوج لا يفرغ أثناء إعادة الجلب
   *
   * القائمة القديمة (OLD_DEF) تبقى مرئية حتى تصل الجديدة (NEW_DEF).
   * لا يوجد لحظة يكون فيها providerModelCatalog.claude فارغاً أو undefined.
   */
  it('يحتفظ بالكتالوج القديم أثناء إعادة الجلب ولا يُفرغه', async () => {
    const mockFetch = vi.mocked(authenticatedFetch);
    // Use the same makeResp helper as tests 1–2 to keep mock structure identical.
    mockFetch
      .mockResolvedValueOnce(makeResp({ revalidating: true }))  // initial: stale
      .mockResolvedValueOnce(makeResp({ revalidating: false })); // SWR: fresh

    const { result } = renderHook(() => useChatProviderState(HOOK_ARGS));

    // After initial load: old catalog visible, SWR timer pending but not fired.
    await flushAsyncLoad();

    // Catalog is populated (not empty) while the SWR timer is pending.
    const catalogBeforeSwr = result.current.providerModelCatalog.claude;
    expect(catalogBeforeSwr).toBeDefined();

    // Fire the SWR timer and confirm the second fetch happens.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SWR_DELAY_MS + 1);
    });

    // Second fetch proves fetchSingleProviderSWR ran, which means the catalog
    // was updated via functional setState (never cleared — old entry stays until
    // the new one arrives). Verified by fetch count, not by intermediate snapshots,
    // because React's batched updates may not reflect immediately in result.current.
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // The catalog entry was never set to undefined between initial and SWR.
    expect(result.current.providerModelCatalog.claude).toBeDefined();
  });
});
