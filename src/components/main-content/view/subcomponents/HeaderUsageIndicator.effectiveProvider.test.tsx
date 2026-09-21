/**
 * `HeaderUsageIndicator` — المؤشّر يتبع **المزوّد الفعلي** لا مزوّد الجلسة وحده.
 *
 * العيب المُصلَح: الهيدر كان يقرأ `selectedSession?.__provider` فقط، فحين لا
 * جلسة مفتوحة (أو جلسة جديدة قبل ختمها) تسقط القيمة على `'claude'` افتراضياً
 * داخل `getProviderCapabilities`، فتُعرض أشرطة حصّة حساب Claude مع منتقٍّ
 * غير كلود (kimi/glm/codex…). الاحتياط الصحيح هو النمط الكانوني في التطبيق:
 * `sessionProvider ?? globalProvider` (مزوّد الجلسة أولاً، وإلا المنتقي العام
 * من `selectedProviderStore`).
 *
 * المُثبَت هنا:
 *  1. لا جلسة + منتقٍّ كلود ⇒ يُعرض.
 *  2. لا جلسة + منتقٍّ غير كلود ⇒ يُخفى (كان يُعرض قبل الإصلاح).
 *  3. جلسة claude تتقدّم على منتقٍّ غير كلود ⇒ يُعرض.
 *  4. جلسة غير كلود تتقدّم على منتقٍّ كلود ⇒ يُخفى.
 *  5. تغيّر المنتقي بلا جلسة يُخفي المؤشّر **تفاعلياً** (المتجر لا إعادة تحميل).
 *
 * ⚠️ تُقارَن قيم أوّلية فقط، لا عناصر DOM — تمرير عنصر jsdom إلى `node:assert`
 * يقتل عامل vitest عند الفشل (انظر AgentStatusCard.displayTruth.test.tsx).
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import assert from 'node:assert/strict';

import { cleanup, render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = (opts?.defaultValue as string) ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ''));
    },
    i18n: { language: 'en' },
  }),
}));

// حمولة ناجحة بشكل عقد `GET /api/providers/claude/usage` (نوافذ + resetsAt ISO).
// الهوك مُستبدَل كي يبقى الاختبار على منطق البوابة لا على الشبكة.
const usageFixture = {
  plan: 'max',
  session: { utilization: 4, resetsAt: '2026-07-30T03:29:59.842Z' },
  weeklyAllModels: { utilization: 74, resetsAt: '2026-08-03T23:59:59.842Z' },
  weeklySonnet: { utilization: 12, resetsAt: '2026-08-03T23:59:59.842Z' },
  // Anthropic يُعيد `seven_day_opus=null` فعلياً على هذه الخطة (B-64) ⇒ نافذة مُهملة.
  weeklyOpus: null,
  extraUsage: null,
  fetchedAt: '2026-07-30T00:00:00.000Z',
  stale: false,
};

// نلتقط وسيط `enabled` لإثبات أن الجلب يتوقّف لغير كلود (لا مجرّد إخفاء بصري).
const enabledCalls: boolean[] = [];

vi.mock('../../../quick-settings-panel/hooks/useClaudeUsage', () => ({
  useClaudeUsage: (enabled: boolean) => {
    enabledCalls.push(enabled);
    return enabled
      ? { status: 'success', data: usageFixture, refetch: () => {} }
      : { status: 'idle', refetch: () => {} };
  },
}));

import { setSelectedProvider, __resetSelectedProviderStore } from '../../../../stores/selectedProviderStore';

import HeaderUsageIndicator from './HeaderUsageIndicator';

afterEach(cleanup);

beforeEach(() => {
  __resetSelectedProviderStore();
  enabledCalls.length = 0;
});

/** يُصيّر المؤشّر ويعيد عدد أشرطة النوافذ المعروضة (0 = مُخفى). */
function renderIndicator(sessionProvider?: string | null) {
  const { container } = render(
    <HeaderUsageIndicator tabsMode="full" sessionProvider={sessionProvider} />,
  );
  return {
    container,
    windowCount: container.querySelectorAll('span[aria-label]').length,
  };
}

describe('HeaderUsageIndicator — المزوّد الفعلي', () => {
  it('لا جلسة + منتقٍّ كلود ⇒ يُعرض', () => {
    setSelectedProvider('claude');
    // ثلاث نوافذ لها بيانات (weeklyOpus = null ⇒ تُحجب).
    assert.equal(renderIndicator(null).windowCount, 3);
    assert.equal(enabledCalls.includes(true), true);
  });

  it('لا جلسة + منتقٍّ غير كلود ⇒ يُخفى ولا يُجلب', () => {
    setSelectedProvider('kimi');
    assert.equal(renderIndicator(null).windowCount, 0);
    assert.equal(enabledCalls.includes(true), false);
  });

  it('لا جلسة + منتقٍّ codex ⇒ يُخفى', () => {
    setSelectedProvider('codex');
    assert.equal(renderIndicator(undefined).windowCount, 0);
  });

  it('جلسة claude تتقدّم على منتقٍّ غير كلود ⇒ يُعرض', () => {
    setSelectedProvider('glm');
    assert.equal(renderIndicator('claude').windowCount, 3);
  });

  it('جلسة غير كلود تتقدّم على منتقٍّ كلود ⇒ يُخفى', () => {
    setSelectedProvider('claude');
    assert.equal(renderIndicator('codex').windowCount, 0);
  });

  it('تغيّر المنتقي بلا جلسة يُخفي المؤشّر تفاعلياً', () => {
    setSelectedProvider('claude');
    const { container } = renderIndicator(null);
    assert.equal(container.querySelectorAll('span[aria-label]').length, 3);

    act(() => setSelectedProvider('kimi'));
    assert.equal(container.querySelectorAll('span[aria-label]').length, 0);
  });
});
