/**
 * `useProviderCycles` — شروط A3/A4 من المراجعة النقدية.
 *
 * المُثبَت:
 *  • لا جلب حين `enabled=false` (السطح المخفيّ لا يُحمّل الخادم).
 *  • الحمولة السليمة تُخزَّن كما هي، والحمولة بلا مصفوفة `cycles` **خطأ** لا
 *    «قائمة فارغة»: الفراغ يقول «لا دورة لأي مزوّد» وهو ادّعاء لا نملكه.
 *  • ‏HTTP غير ناجح ⇒ خطأ صامت (السطح يصمت، لا يعرض سبباً إنجليزياً).
 *  • **الإلغاء عند التفريغ** بـ`AbortController` — لا إسقاطُ ردٍّ بعد وصوله مع
 *    ترك العمل الخادمي مهدوراً (وهو عيب `useSubscriptionCosts` الذي منعت
 *    المراجعة تكراره)، ولا تحديثُ حالةٍ بعد التفريغ.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { renderHook, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

const calls: Array<{ signal?: AbortSignal }> = [];
let respond: (value: unknown) => void = () => {};

// حمولة بشكل ما يُعيده الخادم فعلاً (‏{success, cycles}) — مشتقّة من الحيّ.
const LIVE_BODY = {
  success: true,
  cycles: [
    {
      provider: 'codex',
      displayName: 'Codex',
      plan: 'Plus',
      anchorDay: 11,
      anchorSource: 'detected',
      cycleStart: '2026-07-10T21:00:00.000Z',
      cycleEnd: '2026-08-10T21:00:00.000Z',
    },
  ],
};

vi.mock('../../../utils/api', () => ({
  api: {
    providers: {
      providerCycles: (options: { signal?: AbortSignal } = {}) => {
        calls.push(options);
        return new Promise((resolve) => {
          respond = resolve;
        });
      },
    },
  },
}));

import { useProviderCycles } from './useProviderCycles';

const okResponse = (body: unknown) => ({ ok: true, json: async () => body });

afterEach(cleanup);

beforeEach(() => {
  calls.length = 0;
});

describe('useProviderCycles', () => {
  it('enabled=false ⇒ لا جلب إطلاقاً', () => {
    const { result } = renderHook(() => useProviderCycles(false));
    assert.equal(calls.length, 0);
    assert.equal(result.current.status, 'idle');
  });

  it('حمولة سليمة ⇒ success بالصفوف كما وصلت', async () => {
    const { result } = renderHook(() => useProviderCycles(true));
    assert.equal(calls.length, 1);

    respond(okResponse(LIVE_BODY));
    await waitFor(() => {
      assert.equal(result.current.status, 'success');
    });
    assert.equal(result.current.status === 'success' && result.current.rows.length, 1);
    assert.equal(
      result.current.status === 'success' && result.current.rows[0].anchorSource,
      'detected',
    );
  });

  it('حمولة بلا مصفوفة cycles ⇒ error لا قائمة فارغة', async () => {
    const { result } = renderHook(() => useProviderCycles(true));
    respond(okResponse({ success: true }));
    await waitFor(() => {
      assert.equal(result.current.status, 'error');
    });
  });

  it('ردّ غير ناجح ⇒ error (والسطح يصمت)', async () => {
    const { result } = renderHook(() => useProviderCycles(true));
    respond({ ok: false, json: async () => ({}) });
    await waitFor(() => {
      assert.equal(result.current.status, 'error');
    });
  });

  it('يمرّر AbortSignal ويُلغيه عند التفريغ (لا عملٌ خادمي مهدور)', async () => {
    const { unmount } = renderHook(() => useProviderCycles(true));
    const signal = calls[0]?.signal;
    assert.ok(signal, 'يجب تمرير signal للجلب');
    assert.equal(signal?.aborted, false);

    unmount();
    assert.equal(signal?.aborted, true, 'التفريغ يجب أن يُلغي الطلب المعلّق');
  });

  it('ردٌّ يصل بعد التفريغ لا يُحدِّث حالة ولا يرمي', async () => {
    const { unmount, result } = renderHook(() => useProviderCycles(true));
    const statusBefore = result.current.status;
    unmount();
    // الردّ المتأخّر بعد الإلغاء: يجب أن يُتجاهل بصمت.
    respond(okResponse(LIVE_BODY));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(result.current.status, statusBefore);
  });
});
