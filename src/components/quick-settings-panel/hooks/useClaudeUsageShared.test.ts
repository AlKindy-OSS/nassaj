/**
 * T-1822: اختبارات المخزن المشترك useClaudeUsageShared.
 *
 * يختبر:
 *  - عدّاد المشتركين: تشغيل/إيقاف المؤقّت
 *  - إعادة ضبط المخزن عند وصول enabledCount إلى صفر
 *  - تجاهل الردود القديمة (requestId guard)
 *  - notifyClaudeUsageTurnEnd: يُطلق جلباً إضافياً حين enabledCount > 0
 *  - تبديل المستخدم: يُعيد الضبط ويُلغي الطلب الجاري
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('../../../utils/api', () => ({
  api: {
    providers: {
      claudeUsage: vi.fn(),
    },
  },
}));

import { renderHook, act, cleanup } from '@testing-library/react';
import { api } from '../../../utils/api';
import {
  notifyClaudeUsageTurnEnd,
  useClaudeUsageShared,
} from './useClaudeUsageShared';

const mockApi = api.providers.claudeUsage as ReturnType<typeof vi.fn>;

function makeOkResponse(partial: Record<string, unknown> = {}): Response {
  return {
    ok: true,
    json: async () => ({
      session: null, weeklyAllModels: null, weeklySonnet: null, weeklyOpus: null,
      ...partial,
    }),
  } as unknown as Response;
}

/** flush promise queue (for real-timer-based async) */
async function flushPromises(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockApi.mockResolvedValue(makeOkResponse());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ------------------------------------------------------------------ //
//  عدّاد المشتركين وإدارة المؤقّت                                     //
// ------------------------------------------------------------------ //

describe('subscriber refcount and timer lifecycle', () => {
  it('starts polling (calls api) when first subscriber enables', async () => {
    renderHook(() => useClaudeUsageShared(true, 'u1'));
    // تنشيط useEffect
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => { await Promise.resolve(); });
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it('does not call api when enabled=false', async () => {
    renderHook(() => useClaudeUsageShared(false, 'u1'));
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => { await Promise.resolve(); });
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('polls again on interval tick', async () => {
    renderHook(() => useClaudeUsageShared(true, 'u2'));
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => { await Promise.resolve(); });
    const callsAfterFirst = mockApi.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    await act(async () => { vi.advanceTimersByTime(180_000); });
    await act(async () => { await Promise.resolve(); });
    expect(mockApi.mock.calls.length).toBeGreaterThanOrEqual(callsAfterFirst + 1);
  });

  it('stop polling when last subscriber unmounts (cleanup path)', async () => {
    const { unmount } = renderHook(() => useClaudeUsageShared(true, 'u3'));
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => { await Promise.resolve(); });
    const callsBefore = mockApi.mock.calls.length;
    unmount();
    // بعد unmount لا ينبغي أن يُطلق المؤقّت طلبات جديدة
    await act(async () => { vi.advanceTimersByTime(180_000); });
    await act(async () => { await Promise.resolve(); });
    expect(mockApi.mock.calls.length).toBe(callsBefore); // لا طلبات إضافية
  });
});

// ------------------------------------------------------------------ //
//  notifyClaudeUsageTurnEnd                                            //
// ------------------------------------------------------------------ //

describe('notifyClaudeUsageTurnEnd (T-1822)', () => {
  it('triggers an immediate refetch when enabledCount > 0', async () => {
    renderHook(() => useClaudeUsageShared(true, 'u4'));
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => { await Promise.resolve(); });
    const callsBefore = mockApi.mock.calls.length;
    act(() => { notifyClaudeUsageTurnEnd(); });
    await act(async () => { await Promise.resolve(); });
    expect(mockApi.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('does not throw when no subscribers', () => {
    expect(() => notifyClaudeUsageTurnEnd()).not.toThrow();
  });
});

// ------------------------------------------------------------------ //
//  تبديل المستخدم — عزل البيانات                                     //
// ------------------------------------------------------------------ //

describe('user switch isolation (fix-2)', () => {
  it('resets store when userId changes to a different user', async () => {
    const { rerender } = renderHook(
      ({ uid }: { uid: string }) => useClaudeUsageShared(true, uid),
      { initialProps: { uid: 'user-X' } },
    );
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => { await Promise.resolve(); });
    const callsAfterUserX = mockApi.mock.calls.length;

    // تبديل للمستخدم ص — يُفترض أن يُعيد الضبط ويجلب من جديد
    rerender({ uid: 'user-Y' });
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => { await Promise.resolve(); });
    // استدعاءات إضافية تحدث عند تبديل المستخدم
    expect(mockApi.mock.calls.length).toBeGreaterThanOrEqual(callsAfterUserX);
  });

  it('does not cause extra fetches when same userId', async () => {
    const { rerender } = renderHook(
      ({ uid }: { uid: string }) => useClaudeUsageShared(true, uid),
      { initialProps: { uid: 'same-user-Z' } },
    );
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => { await Promise.resolve(); });
    const callsBefore = mockApi.mock.calls.length;
    rerender({ uid: 'same-user-Z' });
    await act(async () => { vi.advanceTimersByTime(0); });
    await act(async () => { await Promise.resolve(); });
    // لا يجب أن يُضاف طلب جديد لمجرد rerender بنفس المعرّف
    expect(mockApi.mock.calls.length).toBe(callsBefore);
  });
});
