/**
 * providerCapabilities.modelSwitch.test.ts — T-1028 / ثبّيت تطابق الواصف
 *
 * يُثبّت خريطة modelSwitch.supported لكل مزوّد مقابل الحقيقة الخادمية.
 * المرجع: server/modules/providers/list/<provider>/<provider>-models.provider.ts
 *
 * قاعدة الإضافة: لا تعدّل هذا الملف مباشرةً عند رفع مزوّد من false إلى true
 * دون أن تتحقّق أولاً من تنفيذ changeActiveModel خادمياً (writeProviderSessionActiveModelChange).
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/constants/providerCapabilities.modelSwitch.test.ts
 */

import { describe, it, expect } from 'vitest';
import { PROVIDER_UI_CAPABILITIES, getProviderCapabilities } from './providerCapabilities';

// ─── جدول الحقيقة الخادمية ────────────────────────────────────────────────────
//
// مزوّد مُفعَّل = changeActiveModel يستدعي writeProviderSessionActiveModelChange.
// مزوّد مُعطَّل = يرمي notSupported() أو stub أو لا تنفيذ موثَّق.
//
// المراجع:
//   claude        — claude-models.provider.ts (مُنفَّذ)
//   codex         — codex-models.provider.ts  (مُنفَّذ)
//   opencode      — opencode-models.provider.ts (مُنفَّذ)
//   antigravity   — antigravity-models.provider.ts:72-76 (مُنفَّذ) + agy-cli.js:530-535
//   cursor        — cursor-models.provider.ts:814-818 (مُنفَّذ) ← تصحيح T-1028
//   hermes        — يرمي 501 في المحوِّل، لكن الخدمة تلتقطه وتكتب في مخزن نسّاج (T-1198)
//   kimi          — kimi-models.provider.ts  (مُنفَّذ)
//   deepseek      — deepseek-models.provider.ts (مُنفَّذ)
//   glm           — glm-models.provider.ts   (مُنفَّذ)
//   sakana        — stub (STUB_API_PROVIDERS، لا changeActiveModel فعلي)

const EXPECTED: Record<string, boolean> = {
  claude:       true,
  codex:        true,
  opencode:     true,
  qwen:         true,
  antigravity:  true,   // antigravity-models.provider.ts:72-76 + agy-cli.js:530-535
  cursor:       true,   // cursor-models.provider.ts:814-818
  hermes:       true,   // T-1198: الخدمة تلتقط NOT_IMPLEMENTED وتكتب في مخزن نسّاج المحايد
  kimi:         true,
  deepseek:     true,
  glm:          true,
  sakana:       false,  // stub — لا تنفيذ فعلي
};

describe('providerCapabilities.modelSwitch — خريطة الدعم مقابل الحقيقة الخادمية', () => {

  it('تغطّي جدول الحقيقة كل المزوّدات المُعرَّفة في PROVIDER_UI_CAPABILITIES', () => {
    const defined = Object.keys(PROVIDER_UI_CAPABILITIES);
    const covered = Object.keys(EXPECTED);
    const missing = defined.filter((p) => !covered.includes(p));
    expect(missing, `مزوّدات ناقصة من جدول الحقيقة: ${missing.join(', ')}`).toEqual([]);
  });

  // ── مُفعَّلات: changeActiveModel مُنفَّذ خادمياً ──
  const ENABLED = Object.entries(EXPECTED)
    .filter(([, v]) => v)
    .map(([k]) => k);

  it.each(ENABLED)(
    '%s — modelSwitch.supported يجب أن يكون true (changeActiveModel مُنفَّذ خادمياً)',
    (provider) => {
      expect((PROVIDER_UI_CAPABILITIES as Record<string, { modelSwitch: { supported: boolean } }>)[provider].modelSwitch.supported).toBe(true);
    },
  );

  // ── مُعطَّلات: notSupported أو stub ──
  const DISABLED = Object.entries(EXPECTED)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  it.each(DISABLED)(
    '%s — modelSwitch.supported يجب أن يكون false (notSupported أو stub)',
    (provider) => {
      expect((PROVIDER_UI_CAPABILITIES as Record<string, { modelSwitch: { supported: boolean } }>)[provider].modelSwitch.supported).toBe(false);
    },
  );

  // ── hermes و sakana بالاسم الصريح لمنع التمرير الصامت ──
  // T-1198: هرمز صار true — الـ501 من المحوِّل يلتقطه changeActiveModel في
  // provider-models.service ويكتب التثبيت في مخزن نسّاج، وspawn يمرّره
  // `-m … --provider …`. القفل السابق كان قراءةً خاطئة للـ501.
  it('hermes: true صريح — الخدمة تلتقط 501 وتكتب في مخزن نسّاج (T-1198)', () => {
    expect(PROVIDER_UI_CAPABILITIES.hermes.modelSwitch.supported).toBe(true);
  });

  it('sakana: false صريح — مزوّد stub بلا تنفيذ فعلي (STUB_API_PROVIDERS)', () => {
    expect(PROVIDER_UI_CAPABILITIES.sakana.modelSwitch.supported).toBe(false);
  });

  it('antigravity: true — agy-cli.js:530-535 يقرأ التغيير الصريح عبر getChangedActiveModel', () => {
    expect(PROVIDER_UI_CAPABILITIES.antigravity.modelSwitch.supported).toBe(true);
  });

  it('cursor: true — cursor-models.provider.ts:814 ينفّذ writeProviderSessionActiveModelChange', () => {
    expect(PROVIDER_UI_CAPABILITIES.cursor.modelSwitch.supported).toBe(true);
  });

  // ── safeFallbackCapabilities: fail-closed للمزوّد المجهول ──
  it('مزوّد مجهول: safeFallback يُعيد modelSwitch.supported=false (fail-closed)', () => {
    const fallback = getProviderCapabilities('unknown-future-provider-xyz');
    expect(fallback.modelSwitch.supported).toBe(false);
  });
});
