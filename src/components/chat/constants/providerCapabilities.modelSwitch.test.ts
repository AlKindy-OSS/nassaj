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
//   gemini        — gemini-models.provider.ts:37-41  (مُنفَّذ) ← تصحيح T-1028
//   antigravity   — antigravity-models.provider.ts:72-76 (مُنفَّذ) + agy-cli.js:530-535
//   cursor        — cursor-models.provider.ts:814-818 (مُنفَّذ) ← تصحيح T-1028
//   hermes        — hermes.provider.ts:58 يرمي notSupported('changeActiveModel') → 501
//   kimi          — kimi-models.provider.ts  (مُنفَّذ)
//   deepseek      — deepseek-models.provider.ts (مُنفَّذ)
//   glm           — glm-models.provider.ts   (مُنفَّذ)
//   sakana        — stub (STUB_API_PROVIDERS، لا changeActiveModel فعلي)

const EXPECTED: Record<string, boolean> = {
  claude:       true,
  codex:        true,
  opencode:     true,
  gemini:       true,   // gemini-models.provider.ts:37-41
  antigravity:  true,   // antigravity-models.provider.ts:72-76 + agy-cli.js:530-535
  cursor:       true,   // cursor-models.provider.ts:814-818
  hermes:       false,  // hermes.provider.ts:58 → notSupported() → 501
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
  it('hermes: false صريح — changeActiveModel يرمي 501 (hermes.provider.ts:58)', () => {
    expect(PROVIDER_UI_CAPABILITIES.hermes.modelSwitch.supported).toBe(false);
  });

  it('sakana: false صريح — مزوّد stub بلا تنفيذ فعلي (STUB_API_PROVIDERS)', () => {
    expect(PROVIDER_UI_CAPABILITIES.sakana.modelSwitch.supported).toBe(false);
  });

  // ── gemini/antigravity/cursor: true صريح — كانت false خطأً ──
  it('gemini: true — gemini-models.provider.ts:37 ينفّذ writeProviderSessionActiveModelChange', () => {
    expect(PROVIDER_UI_CAPABILITIES.gemini.modelSwitch.supported).toBe(true);
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
