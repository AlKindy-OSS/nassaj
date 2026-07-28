import type { LLMProvider } from '../../../types/app';
import type { PermissionMode } from '../types/types';

/**
 * T-904 (روح ADR-047، م0) — واصف قدرات واجهة المُؤلِّف لكل مزوّد. المصدر
 * الوحيد المعتمد لكل "provider === 'x'" التي كانت مبعثرة في ChatComposer.tsx
 * و useChatProviderState.ts. القيم أدناه تُعيد سلوك اليوم حرفياً 1:1 — هذا
 * الملف لا يغيّر أي سلوك بذاته، فقط يجمع الشروط القائمة في مكان واحد.
 *
 * القاعدة الحاكمة (قرار المالك T-904): يُستهلك عبر `displayProvider` (مزوّد
 * الجلسة المفتوحة = selectedSession?.__provider ?? provider العام) لا
 * `provider` العام وحده، فتبقى أدوات جلسة claude ثابتة مهما تغيّر الاختيار
 * العام؛ الاختيار العام يؤثّر فقط على جلسة جديدة (لا selectedSession بعد).
 *
 * نطاق T-904: effort/tokenCounter/command.supportsImages/permissions/quota
 * فقط (ما تستهلكه ChatComposer/useChatProviderState/أشرطة الحصة). تعميم
 * مكافئات هرمز الفعلية (reasoning_effort حقيقي، حصة حيّة…) مؤجَّل لما بعد
 * T-905 — لا تُستنتج هنا قيم "true" غير مثبتة خادمياً اليوم.
 *
 * T-905 يضيف حقلين فقط: effort.modes (مجموعة فرعية اختيارية من هويّات
 * effortModes حين لا يطابق المزوّد مجموعة claude الكاملة) وposture.supported
 * (زر معلومات السقف الفعلي — sandbox/شبكة — بجانب زرّ وضع الأذونات؛ codex
 * فقط اليوم لأنه المزوّد الوحيد ذو سقف قابل للتباين الفعلي بين الأوضاع).
 */

export interface ProviderUiCapabilities {
  /** مطابق للقيمة الممرَّرة — يبقى كما هي حتى لمزوّد غير معروف. */
  id: string;
  /**
   * اسم عرض إنجليزي مختصر (تسمية تقنية، ليس نصاً مترجَماً). يُستهلك عبر
   * getProviderDisplayName المصدَّرة أدناه في أربعة مواضع (T-224 م0):
   * ProviderSelectionEmptyState، وChatInterface×2، وMessageComponent.
   * المزوّدات غير المُدرَجة تعرض اسمها الخام (لا «Claude») عبر safeFallbackCapabilities.
   */
  displayName: string;
  /**
   * منتقي التفكير/الجهد (ThinkingModeSelector + شارة ULTRACODE). `modes`
   * (اختياري) يحصر القائمة على هويّات effortModes بعينها — غيابه يعني القائمة
   * الكاملة (سلوك claude الحالي بلا تغيير). عند supported=false يُتجاهل modes.
   */
  effort: { supported: boolean; modes?: string[] };
  /** عدّاد التوكنز/تعفّن السياق (TokenUsageSummary). */
  tokenCounter: { supported: boolean };
  /** شكل أمر الإرسال ذو الصلة بالمُؤلِّف (تلميح إرفاق الملفات/الصور). */
  command: { supportsImages: boolean };
  /** أوضاع الأذونات المتاحة فعلياً لهذا المزوّد (getPermissionModesForProvider سابقاً). */
  permissions: { modes: PermissionMode[] };
  /** هل أشرطة حصة C/W/S/O (حساب Claude) تطابق مزوّد هذه الجلسة فعلياً. */
  quota: { isClaudeAccount: boolean };
  /** زرّ معلومات سقف الـsandbox/الشبكة الفعلي بجانب زرّ وضع الأذونات (T-894/T-905). */
  posture: { supported: boolean };
  /**
   * قناة «/btw» الجانبية (T-849): سؤال جانبي على سياق الجلسة يُنفَّذ خادمياً
   * كجلسة SDK مفروكة (fork) وتُعرض إجابته في overlay — بلا مساس بالبث الجاري ولا
   * بسجل المحادثة. claude وحده true اليوم (المزوّد الوحيد ذو آلية الفرك)؛ غيره
   * false فلا يتفعّل استثناء الإرسال أثناء البث ولا اعتراض التوجيه.
   */
  sideChannel: { supported: boolean };
  /**
   * KM-3/GL-8 (ADR-062): هل يملك هذا المزوّد وضعَ «وكيل» محكوماً خادمياً (native
   * CLI لـkimi، حامل OpenCode لـglm) إلى جانب سطح دردشته العادي عديم الأدوات؟ عند
   * supported=true يجوز للمُؤلِّف عرض مبدّل دردشة⇄وكيل، وقيمته «agent» تتدفّق
   * `options.mode==='agent'` إلى seam التوجيه. `flag` (اختياري) اسم علم الأسطول
   * المرئي للعميل (مفتاح import.meta.env بادئته VITE_) الذي يجب أن يكون مسلَّحاً
   * كي يُعرَض السطح — غيابه = يُعرَض دائماً عند الدعم. الخادم يفرض البوّابة نفسها
   * fail-closed مستقلاً، فعلمٌ عميلي بائت لا يفعّل سطحاً معطّلاً أبداً. الافتراض
   * OFF لـglm (المعلَّم بعلم): علمٌ غير مسلَّح ⇒ لا يُعرَض ⇒ سلوك اليوم بلا تغيير.
   */
  agentMode: { supported: boolean; flag?: string };
  /**
   * T-1028 / B-247: هل يدعم هذا المزوّد تبديل النموذج وسط المحادثة عبر
   * `POST /api/providers/<id>/sessions/<sid>/active-model`؟
   * false = يُخفى مبدّل النموذج المدمج في شريط الأدوات. القيم:
   * - hermes: false — changeActiveModel يرمي 501 (hermes.provider.ts:58).
   * - antigravity: false — agy يحذف --model عمداً عند الاستئناف (agy-cli.js:503-540)
   *   فالمفتاح المكتوب لن يُقرأ ⇒ سلوك مضلِّل.
   * - cursor/gemini/sakana: false — لا آلية active-model موثَّقة أو المزوّد يدير النموذج بنفسه.
   * - الباقون: true — نقطة النهاية تكتب المفتاح وresolveResumeModel يقرأه.
   */
  modelSwitch: { supported: boolean };
}

// المجموعة الافتراضية لأي مزوّد لم يُخصَّص له سلوك أذونات خاص — مطابقة
// حرفياً لفرع else في getPermissionModesForProvider الأصلية.
const DEFAULT_PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
];

/**
 * سقوط آمن لمزوّد غير مُدرَج في PROVIDER_UI_CAPABILITIES (مزوّد مستقبلي، أو
 * قيمة displayProvider نصّية غير متوقّعة إذ النوع في ChatComposer هو
 * `Provider | string`): كل القدرات الحسّاسة false/none، ما عدا الأذونات التي
 * تبقى مجموعة صالحة غير فارغة (['default']) كي لا يتعطّل دوّار الأذونات.
 *
 * `modelSwitch: false` هنا مقصود fail-closed للمزوّدات المجهولة: نقطة نهاية
 * active-model مكتوبة لمزوّد معروف فقط — مزوّد مستقبلي غير مُدرَج قد لا
 * ينفّذها أصلاً، ويُفضَّل إخفاء المبدّل على إظهار سلوك صامت.
 */
function safeFallbackCapabilities(id: string): ProviderUiCapabilities {
  return {
    id,
    displayName: id ? id.charAt(0).toUpperCase() + id.slice(1) : 'Unknown',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    permissions: { modes: ['default'] },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
    agentMode: { supported: false },
    // fail-closed للمزوّد المجهول — انظر تعليق JSDoc أعلاه.
    modelSwitch: { supported: false },
  };
}

// claude محايد حرفياً (بوابة الحياد AC-0.1 من PLAN-v1 §9/م0): القيم أدناه
// تُعيد سلوك اليوم بلا أي انحراف بصري أو سلوكي.
export const PROVIDER_UI_CAPABILITIES: Record<LLMProvider, ProviderUiCapabilities> = {
  claude: {
    id: 'claude',
    displayName: 'Claude',
    effort: { supported: true },
    tokenCounter: { supported: true },
    command: { supportsImages: true },
    permissions: {
      modes: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
    },
    quota: { isClaudeAccount: true },
    posture: { supported: false },
    // T-849: القناة الجانبية «/btw» — claude وحده يملك آلية الفرك (fork) اليوم.
    sideChannel: { supported: true },
    // KM-3/GL-8: لا وضع وكيل محكوم لـclaude (سطحه أصلاً كامل الأدوات).
    agentMode: { supported: false },
    // T-1028: تبديل النموذج وسط المحادثة — مدعوم (نقطة النهاية active-model تكتب المفتاح).
    modelSwitch: { supported: true },
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    // T-905: يفعّل ThinkingModeSelector للـcodex بمجموعة فرعية بلا max/ultracode
    // (لا مقابل لهما في ModelReasoningEffort). 'none' يبقى مضمَّناً — يعني حذف
    // الحقل فيُترك للجهد الافتراضي config.toml (medium)، مطابقاً معنى claude.
    effort: { supported: true, modes: ['none', 'low', 'medium', 'high', 'xhigh'] },
    tokenCounter: { supported: true },
    command: { supportsImages: false },
    permissions: { modes: ['default', 'acceptEdits', 'bypassPermissions'] },
    quota: { isClaudeAccount: false },
    // T-894/T-905: زرّ معلومات السقف الفعلي (sandbox/شبكة) بجانب زرّ وضع
    // الأذونات — codex وحده اليوم لأن نصوصه القديمة كانت تُضلِّل (ADR-058/T-884).
    posture: { supported: true },
    sideChannel: { supported: false },
    agentMode: { supported: false },
    // T-1028: مدعوم — resolveResumeModel يقرأ المفتاح ويمرّره لـcodex.
    modelSwitch: { supported: true },
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    effort: { supported: false },
    tokenCounter: { supported: true },
    command: { supportsImages: false },
    permissions: { modes: ['default'] },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
    // KM-3/GL-8: لا مبدّل «دردشة⇄وكيل» هنا لأن opencode وكيلٌ دائماً — لا سطح
    // دردشة عديم أدوات يقابله. وبعد طيّ GLM (قرار المالك 2026-07-26) يُبلَغ GLM
    // من هنا: نموذج `glm/*` داخل نماذج opencode، لا مزوّد مستقل.
    agentMode: { supported: false },
    // T-1028: مدعوم — المعرِّف المؤهَّل (glm/glm-5.2) يُمرَّر حرفياً (T-1021/6be3c7ab).
    modelSwitch: { supported: true },
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    permissions: { modes: DEFAULT_PERMISSION_MODES },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
    agentMode: { supported: false },
    // T-1028: مدعوم — changeActiveModel مُنفَّذ خادمياً ويستدعي
    // writeProviderSessionActiveModelChange (gemini-models.provider.ts:37-41).
    modelSwitch: { supported: true },
  },
  antigravity: {
    id: 'antigravity',
    displayName: 'Antigravity (agy)',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    permissions: { modes: DEFAULT_PERMISSION_MODES },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
    agentMode: { supported: false },
    // T-1028: مدعوم — changeActiveModel مُنفَّذ (antigravity-models.provider.ts:72-76).
    // agy يحذف --model عند الاستئناف العادي لكنه يقرأ التغيير الصريح عبر
    // getChangedActiveModel وinline switcher هذا تغييرٌ صريح (agy-cli.js:530-535).
    modelSwitch: { supported: true },
  },
  cursor: {
    id: 'cursor',
    displayName: 'Cursor',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    permissions: { modes: DEFAULT_PERMISSION_MODES },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
    agentMode: { supported: false },
    // T-1028: مدعوم — changeActiveModel مُنفَّذ خادمياً ويستدعي
    // writeProviderSessionActiveModelChange (cursor-models.provider.ts:814-818).
    modelSwitch: { supported: true },
  },
  hermes: {
    id: 'hermes',
    displayName: 'Hermes (Nous)',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    // T-224 (م1): hermes -z يتجاوز الأذونات خادمياً (server/hermes-cli.js:179-181)
    // فالدوّار يبقى أحادياً — المستخدم يرى زرّ أذونات واحداً ثابتاً لا يدور.
    permissions: { modes: ['default'] },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
    agentMode: { supported: false },
    // T-1028: false — changeActiveModel يرمي notSupported() خادمياً (hermes.provider.ts:58).
    // «return notSupported('changeActiveModel')» → 501 Not Implemented. المبدّل مخفيٌّ.
    modelSwitch: { supported: false },
  },
  kimi: {
    id: 'kimi',
    displayName: 'Kimi',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    permissions: { modes: DEFAULT_PERMISSION_MODES },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
    // KM-3 (ADR-062): kimi يملك مُشغّل وكيل أصيل محكوم (@moonshot-ai/kimi-code)
    // بلا علم أسطول — يُعرَض مبدّل الوضع دائماً. الخادم يفرض الحوكمة/التنظيف
    // fail-closed. (شارة الحوكمة تبقى `enforced:false` صدقاً — لا آلية native.)
    agentMode: { supported: true },
    // T-1028: مدعوم — نقطة النهاية active-model تكتب المفتاح.
    modelSwitch: { supported: true },
  },
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    permissions: { modes: DEFAULT_PERMISSION_MODES },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
    agentMode: { supported: false },
    // T-1028: مدعوم — نقطة النهاية active-model تكتب المفتاح.
    modelSwitch: { supported: true },
  },
  glm: {
    id: 'glm',
    displayName: 'GLM',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    permissions: { modes: DEFAULT_PERMISSION_MODES },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
    // GL-8 (ADR-062): سطح GLM الوكيل يجري عبر حامل OpenCode المُبوَّب بعلم الأسطول
    // NASSAJ_OPENCODE_CARRIER (افتراضه OFF). لا يُعرَض المبدّل عميلياً إلا حين
    // يُسلَّح `VITE_NASSAJ_OPENCODE_CARRIER`؛ والخادم يفرض العلم نفسه fail-closed.
    //
    // يبقى الواصف كاملاً بعد طيّ GLM (قرار المالك 2026-07-26) لأن الجلسات
    // التاريخية المختومة `glm` ما تزال تُفتح وتُعرض وتُستأنف بوضع الوكيل عبر
    // الحامل؛ الاختيار الجديد لم يعد يمرّ من هنا (OpenCode + نموذج `glm/*`).
    agentMode: { supported: true, flag: 'NASSAJ_OPENCODE_CARRIER' },
    // T-1028: مدعوم للجلسات التاريخية glm — نقطة النهاية active-model تكتب المفتاح.
    modelSwitch: { supported: true },
  },
  sakana: {
    id: 'sakana',
    displayName: 'Sakana',
    effort: { supported: false },
    tokenCounter: { supported: false },
    command: { supportsImages: false },
    permissions: { modes: DEFAULT_PERMISSION_MODES },
    quota: { isClaudeAccount: false },
    posture: { supported: false },
    sideChannel: { supported: false },
    agentMode: { supported: false },
    // T-1028: false — sakana مزوّد stub (STUB_API_PROVIDERS في provider.routes.ts:547)،
    // لا تنفيذ حقيقي لـchangeActiveModel؛ تفعيله يُضلِّل بلا تأثير فعلي.
    modelSwitch: { supported: false },
  },
};

/**
 * القارئ الوحيد المعتمد للواصف. خالصة (بلا I/O ولا حالة داخلية) — مذكِّرها
 * موقع الاستهلاك عبر useMemo عند اللزوم. تقبل أي نص (وليس فقط LLMProvider)
 * لأن `displayProvider`/`provider` في ChatComposer مطبوعان `Provider | string`؛
 * قيمة فارغة/غير معروفة تسقط بأمان (راجع التعليق أعلى safeFallbackCapabilities).
 */
export function getProviderCapabilities(
  provider: string | null | undefined,
): ProviderUiCapabilities {
  const key = provider || 'claude';
  return PROVIDER_UI_CAPABILITIES[key as LLMProvider] ?? safeFallbackCapabilities(key);
}

/**
 * T-224 (م0) — اسم العرض الكانوني للمزوّد. مصدر الحقيقة الوحيد بديلاً عن:
 *   - getProviderDisplayName المحلية في ProviderSelectionEmptyState.tsx
 *   - الترناريات المكرّرة في ChatInterface.tsx وMessageComponent.tsx
 *
 * مزوّد معروف → displayName من الواصف.
 * مزوّد غير معروف → اسمه الخام (الحرف الأول كبير) لا «Claude».
 * لا يُترجَم: هذه أسماء تقنية ثابتة (Claude API، Hermes، Kimi…).
 */
export function getProviderDisplayName(provider: string | null | undefined): string {
  return getProviderCapabilities(provider).displayName;
}

/**
 * KM-3/GL-8 (ADR-062) — CLIENT-side predicate: هل يُعرَض مبدّل «وضع الوكيل» لهذا
 * المزوّد الآن؟ true فقط حين يدعمه الواصف **و** (إن سُمّي علم أسطول) كان مسلَّحاً
 * في بيئة العميل. الافتراض OFF للمزوّد المعلَّم بعلم (glm): مفتاح `VITE_<flag>`
 * غير مضبوط ⇒ لا يُعرَض السطح ⇒ سلوك اليوم بلا تغيير. هذه بوّابة عرضٍ فقط —
 * الخادم يعيد فرض البوّابة نفسها fail-closed، فعلمٌ عميلي بائت لا يفعّل سطحاً
 * معطّلاً أبداً (kimi: بلا علم ⇒ يُعرَض دائماً عند الدعم).
 *
 * `env` قابل للحقن للاختبار؛ الافتراض `import.meta.env` (كائن يُجسّده Vite بكل
 * متغيّرات `VITE_` وقت التشغيل، فالفهرسة الديناميكية بالمفتاح صالحة).
 */
export function isAgentModeAvailable(
  provider: string | null | undefined,
  env: Record<string, unknown> = import.meta.env as unknown as Record<string, unknown>,
): boolean {
  const { supported, flag } = getProviderCapabilities(provider).agentMode;
  if (!supported) {
    return false;
  }
  if (!flag) {
    return true;
  }
  return env?.[`VITE_${flag}`] === 'true';
}
