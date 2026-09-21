/**
 * T-1191 — اختيار حصار الحصة وصياغة مهلته.
 *
 * المُثبَت هنا هو قرار «هل يُعرض شيء؟» أساساً: مزوّد آخر، أو مهلة انقضت بين
 * الجلب والعرض، أو طابع زمني فاسد — ثلاثتها تُخفي، ولكلٍّ منها سببٌ مختلف.
 *
 * RUNNER: vitest (`npm run test:client`).
 */

import { describe, expect, it } from 'vitest';

import { quotaCountdownParts, selectActiveQuotaBlock } from './quotaBlockHelpers';

const NOW = Date.UTC(2026, 7, 2, 17, 38, 34);
const iso = (ms: number) => new Date(ms).toISOString();

// نصّ agy الحرفي من حادثة الجلسة 06804bb2.
const LIVE_REASON =
  'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 94h52m23s.';

const blockAt = (ms: number) => ({
  provider: 'antigravity',
  resetsAt: iso(ms),
  reason: LIVE_REASON,
});

describe('selectActiveQuotaBlock', () => {
  it('يُعيد حصار المزوّد المطلوب حين يكون موعده في المستقبل', () => {
    const result = selectActiveQuotaBlock([blockAt(NOW + 3_600_000)], 'antigravity', NOW);
    expect(result?.provider).toBe('antigravity');
    expect(result?.msRemaining).toBe(3_600_000);
    expect(result?.reason).toBe(LIVE_REASON);
  });

  it('لا يُعير حصار مزوّد إلى مزوّد آخر', () => {
    expect(selectActiveQuotaBlock([blockAt(NOW + 3_600_000)], 'codex', NOW)).toBeNull();
  });

  it('يُخفي حصاراً انقضى بعد الجلب — الهوك يجلب مرّة ولا يستقصي', () => {
    expect(selectActiveQuotaBlock([blockAt(NOW - 1000)], 'antigravity', NOW)).toBeNull();
  });

  it('يُخفي حصاراً موعده اللحظة نفسها', () => {
    expect(selectActiveQuotaBlock([blockAt(NOW)], 'antigravity', NOW)).toBeNull();
  });

  it('طابع زمني فاسد يُقرأ «لا حصار» لا «حصار بلا موعد»', () => {
    const malformed = [{ provider: 'antigravity', resetsAt: 'غداً', reason: LIVE_REASON }];
    expect(selectActiveQuotaBlock(malformed, 'antigravity', NOW)).toBeNull();
  });

  it('يصمد أمام حمولة غائبة أو فارغة أو بلا مزوّد مُختار', () => {
    expect(selectActiveQuotaBlock(null, 'antigravity', NOW)).toBeNull();
    expect(selectActiveQuotaBlock(undefined, 'antigravity', NOW)).toBeNull();
    expect(selectActiveQuotaBlock([], 'antigravity', NOW)).toBeNull();
    expect(selectActiveQuotaBlock([blockAt(NOW + 1000)], null, NOW)).toBeNull();
  });
});

describe('quotaCountdownParts', () => {
  it('يُصيغ مهلة الحادثة الحقيقية (‏94س52د23ث) أياماً', () => {
    const ms = (94 * 3600 + 52 * 60 + 23) * 1000;
    expect(quotaCountdownParts(ms)).toEqual({ unit: 'days', value: 4 });
  });

  it('ما دون اليوم يُصاغ ساعات', () => {
    expect(quotaCountdownParts(5 * 3_600_000)).toEqual({ unit: 'hours', value: 5 });
  });

  it('ما دون الساعة يُصاغ دقائق', () => {
    expect(quotaCountdownParts(20 * 60_000)).toEqual({ unit: 'minutes', value: 20 });
  });

  it('يُقرّب لأعلى فلا يَعِد بلحظةٍ تسبق التجدّد', () => {
    // ثانيتان باقيتان لا تُعرضان «0 دقيقة».
    expect(quotaCountdownParts(2_000)).toEqual({ unit: 'minutes', value: 1 });
    // 59 ثانية كذلك.
    expect(quotaCountdownParts(59_000)).toEqual({ unit: 'minutes', value: 1 });
  });

  it('التقريب لأعلى يترقّى بالوحدة عند الحافّة بدل «60 دقيقة»', () => {
    // 59د30ث ⇒ ceil = 60 دقيقة، وهي ليست دون الستين، فتُعرض «ساعة». وهذا هو
    // السلوك المرغوب: «ساعة» أقرأ من «60 دقيقة»، والحافّة تُوثَّق لئلا يُقرأ
    // شرط `< 60` لاحقاً على أنه خطأ بمقدار واحد.
    expect(quotaCountdownParts(59.5 * 60_000)).toEqual({ unit: 'hours', value: 1 });
    // ونفس الترقّي عند حافّة اليوم: 23س30د ⇒ ceil = 24 ساعة ⇒ «يوم».
    expect(quotaCountdownParts(23.5 * 3_600_000)).toEqual({ unit: 'days', value: 1 });
  });

  it('يختار وحدة واحدة لا اثنتين', () => {
    const parts = quotaCountdownParts((26 * 3600 + 30 * 60) * 1000);
    expect(parts.unit).toBe('days');
    expect(Object.keys(parts)).toEqual(['unit', 'value']);
  });
});
