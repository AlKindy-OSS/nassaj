/**
 * `quota.surface` — لقطة للمزوّدات كلها (شرط A5-و من المراجعة النقدية).
 *
 * لماذا لقطة لا حالة أو اثنتان: هذا الحقل يقرّر ما يُعرض في سطحين دائمَي الظهور
 * (الشريط العلوي والشريط الجانبي المطويّ)، ومزوّدٌ جديد يُضاف بلا قرار واعٍ
 * سيرث سلوك جاره صامتاً. اللقطة تُفشِل الإضافة الصامتة وتُجبر على الاختيار.
 *
 * القاعدة المُثبَتة:
 *  • `claude-windows` — claude وحده (نوافذ استخدام حساب Anthropic).
 *  • `cycle` — كل مزوّد يظهر في `SUBSCRIPTION_PROVIDERS` خادمياً، فقد يكون له
 *    صفّ دورة. والعرض بعد ذلك بيانيّ: مرساة `detected`/`manual` وإلا صمت.
 *  • `none` — sakana (مستبعَد خادمياً: مُعرِّف بلا تنفيذ) والمزوّد المجهول
 *    (‏fail-closed): لا صفّ لهما أبداً، فلا وعد بسطح.
 *
 * وتُثبِت أيضاً أن **لا مزوّد يعلن سطحاً بمبلغ**: الاتحاد نفسه لا يحمل خياراً
 * مالياً (‏N2)، وهذا ما يجعل «رقم في الهيدر» غير قابل للتعبير أصلاً لا مجرّد
 * غير مُنفَّذ.
 *
 * RUNNER: vitest (`npm run test:client`).
 */

import { describe, it, expect } from 'vitest';

import { getProviderCapabilities, PROVIDER_UI_CAPABILITIES } from './providerCapabilities';

// نفس القائمة الخادمية حرفياً (‏SUBSCRIPTION_PROVIDERS في
// subscription-config.service.ts) — ما عدا claude الذي له سطحه الخاص.
const SERVER_SUBSCRIPTION_PROVIDERS_MINUS_CLAUDE = [
  'codex',
  'gemini',
  'cursor',
  'antigravity',
  'opencode',
  'kimi',
  'deepseek',
  'glm',
  'hermes',
  'qwen',
];

describe('quota.surface', () => {
  it('اللقطة الكاملة لكل مزوّد مُدرَج', () => {
    const surfaces = Object.fromEntries(
      Object.entries(PROVIDER_UI_CAPABILITIES).map(([id, caps]) => [id, caps.quota.surface]),
    );

    expect(surfaces).toEqual({
      claude: 'claude-windows',
      // codex وglm لهما نقطة حصّة رسمية مُتحقَّقة حيّاً (جولة 2026-07-30):
      // ChatGPT backend لكودكس، ومراقبة z.ai لـglm. وحين يتعذّر المصدر يسقط
      // العرض إلى الدورة — والسقوط في المكوّن لا في الواصف.
      codex: 'provider-windows',
      opencode: 'cycle',
      qwen: 'cycle',
      gemini: 'cycle',
      antigravity: 'cycle',
      cursor: 'cycle',
      hermes: 'cycle',
      kimi: 'cycle',
      deepseek: 'cycle',
      glm: 'provider-windows',
      sakana: 'none',
    });
  });

  it('claude وحده صاحب نوافذ حساب Claude، وisClaudeAccount يوافق السطح', () => {
    for (const [id, caps] of Object.entries(PROVIDER_UI_CAPABILITIES)) {
      expect(caps.quota.isClaudeAccount).toBe(id === 'claude');
      expect(caps.quota.surface === 'claude-windows').toBe(id === 'claude');
    }
  });

  it('كل مزوّد له صفّ خادمي مُحتمل يعلن سطحاً غير none', () => {
    // من له نقطة حصّة رسمية يعلن provider-windows، ومن لا فـcycle. المهم أن
    // أحداً منهم لا يعلن `none` — فذلك يمنع حتى محاولة القراءة.
    for (const provider of SERVER_SUBSCRIPTION_PROVIDERS_MINUS_CLAUDE) {
      const surface = getProviderCapabilities(provider).quota.surface;
      expect(surface === 'cycle' || surface === 'provider-windows').toBe(true);
    }
    expect(getProviderCapabilities('codex').quota.surface).toBe('provider-windows');
    expect(getProviderCapabilities('glm').quota.surface).toBe('provider-windows');
    expect(getProviderCapabilities('hermes').quota.surface).toBe('cycle');
  });

  it('المزوّد المجهول fail-closed: none لا cycle', () => {
    expect(getProviderCapabilities('some-future-provider').quota.surface).toBe('none');
    expect(getProviderCapabilities('').quota.surface).toBe('claude-windows');
  });

  // توثيقٌ لسلوك قائم لا إقرارٌ به: `getProviderCapabilities(undefined)` تسقط
  // على claude (‏`provider || 'claude'` في السطر 342). هذا بذاته هو جذر B-310 —
  // ولذلك يُحرَس عند **موقع الاستدعاء**: الهيدر والشريط الجانبي يمرّران
  // `sessionProvider ?? globalProvider` والمتجر لا يُنتج undefined أصلاً
  // (احتياطه 'claude' صريحاً). تغيير الافتراض هنا يمسّ كل مستهلكي الواصف
  // (أدوات المُؤلِّف والأذونات ومنتقي التفكير) فهو قرار مستقلّ لا أثرٌ جانبي
  // لمؤشّر حصّة. هذه الحالة تُثبِّت الواقع كي يُكشَف تغيّره.
  it('undefined/null تسقط على claude — والحرس عند موقع الاستدعاء لا هنا', () => {
    expect(getProviderCapabilities(undefined).quota.surface).toBe('claude-windows');
    expect(getProviderCapabilities(null).quota.surface).toBe('claude-windows');
  });

  it('لا خيار مالي في الاتحاد: أي سطح مُعلَن هو أحد الثلاثة', () => {
    const allowed = new Set(['claude-windows', 'provider-windows', 'cycle', 'none']);
    for (const caps of Object.values(PROVIDER_UI_CAPABILITIES)) {
      expect(allowed.has(caps.quota.surface)).toBe(true);
    }
  });
});
