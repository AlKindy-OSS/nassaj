/**
 * نسبة النموذج إلى **المورّد الذي يُدفع له** — لا إلى الأداة التي شغّلته.
 *
 * الطبقات ثلاث ولا يجوز خلطها:
 *
 *  • **الجسم (harness)** — الأداة التي نفّذت: ‏claude-code، codex، opencode،
 *    glm-cli، antigravity. هذا ما يحمله عمود `provider` في جدول الجلسات.
 *  • **المورّد (vendor)** — من خدَم النموذج فعلاً، وهو **صاحب الاشتراك الذي
 *    يُدفع**: ‏anthropic، openai، ‏glm‏ (‏z.ai)، opencode-zen، moonshot…
 *  • **النموذج** — ‏claude-opus-5، ‏glm-5.2، ‏big-pickle.
 *
 * الخلط بين الأوّل والثاني هو العطل الذي رصده المالك: ‏opencode **حاملٌ لا
 * اشتراك**، فحين تُبنى بطاقات الاشتراكات على الأجسام يظهر GLM ببطاقة تقول «غير
 * متاح» بينما إنفاقه الحقيقي مدفونٌ داخل بطاقة OpenCode. الاشتراك يُشترى من
 * المورّد، فالنسبة إليه.
 *
 * ولهذا سندٌ في البيانات لا في التخمين: عمود `model` في قاعدة opencode نصُّ
 * JSON يحمل المورّد صراحةً — `{"id":"glm-5.2","providerID":"glm"}` — ومُستخرِج
 * القاعدة يحفظه في التسمية `glm/glm-5.2`. فالبادئة هنا **مصدر حقيقة** لا زينة.
 */

/** مفتاح المورّد = مفتاح الاشتراك. */
export type VendorKey =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'glm'
  | 'moonshot'
  | 'deepseek'
  | 'opencode-zen'
  | 'nous'
  | 'unknown';

/**
 * بادئة الحامل (`<providerID>/<id>`) ⇒ المورّد. هذه أوثق إشارة لدينا لأنها
 * مكتوبة من المزوّد نفسه لا مستنتَجة من اسم.
 *
 * `opencode` كبادئة تعني بوّابة OpenCode Zen المستضافة (‏`big-pickle`،
 * `deepseek-v4-flash-free`) — وهي **مورّد فعلي يُدفع له**، بخلاف opencode
 * كجسم. الاسمان متطابقان والمعنيان مختلفان، وهذا بالضبط ما يستدعي الفصل.
 */
const CARRIER_PREFIX_VENDORS: Readonly<Record<string, VendorKey>> = Object.freeze({
  anthropic: 'anthropic',
  claude: 'anthropic',
  openai: 'openai',
  azure: 'openai',
  google: 'google',
  gemini: 'google',
  vertex: 'google',
  glm: 'glm',
  zai: 'glm',
  'z-ai': 'glm',
  zhipu: 'glm',
  moonshot: 'moonshot',
  kimi: 'moonshot',
  deepseek: 'deepseek',
  opencode: 'opencode-zen',
  nous: 'nous',
  hermes: 'nous',
});

/** اسم النموذج نفسه ⇒ المورّد، حين لا بادئة حامل. */
const MODEL_PREFIX_VENDORS: ReadonlyArray<readonly [string, VendorKey]> = Object.freeze([
  ['claude-', 'anthropic'],
  ['gpt-', 'openai'],
  ['o1-', 'openai'],
  ['o3-', 'openai'],
  ['o4-', 'openai'],
  ['codex-', 'openai'],
  ['gemini-', 'google'],
  ['glm-', 'glm'],
  ['kimi-', 'moonshot'],
  ['moonshot-', 'moonshot'],
  ['deepseek-', 'deepseek'],
]);

/**
 * الجسم ⇒ مورّده الطبيعي، كملاذ أخير حين لا يدلّ اسم النموذج على شيء.
 *
 * ‏`opencode` **غائب عمداً**: الجسم الحامل لا مورّد طبيعي له — نموذجٌ مرّ به
 * ولم يُعرف مورّده يبقى `unknown` بدل أن يُنسب زوراً إلى OpenCode Zen ويُضخّم
 * فاتورة اشتراك لم يُستهلك منه شيء.
 */
const HARNESS_VENDORS: Readonly<Record<string, VendorKey>> = Object.freeze({
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
  antigravity: 'google',
  agy: 'google',
  glm: 'glm',
  kimi: 'moonshot',
  deepseek: 'deepseek',
  hermes: 'nous',
});

/** أسماء العرض — ما يظهر على بطاقة الاشتراك. */
const VENDOR_LABELS: Readonly<Record<VendorKey, string>> = Object.freeze({
  anthropic: 'Claude',
  openai: 'OpenAI',
  google: 'Google',
  glm: 'GLM',
  moonshot: 'Kimi',
  deepseek: 'DeepSeek',
  'opencode-zen': 'OpenCode Zen',
  nous: 'Hermes',
  unknown: 'Unknown',
});

export const vendorDisplayName = (vendor: VendorKey): string => VENDOR_LABELS[vendor] ?? vendor;

/** مورّد الجسم الطبيعي (‏null للحامل الذي لا مورّد له). */
export const harnessVendor = (harness: string): VendorKey | null =>
  HARNESS_VENDORS[harness.trim().toLowerCase()] ?? null;

/**
 * المورّد الذي يُنسب إليه استهلاك هذا النموذج.
 *
 * الترتيب مقصود: البادئة المكتوبة من المزوّد أوّلاً، ثم اسم النموذج، ثم جسمه
 * — من الأوثق إلى الأضعف. و`unknown` مُخرَجٌ مشروع: نموذج لا نعرف مورّده لا
 * يُلحَق باشتراك عشوائياً، لأن إلحاقه يضخّم فاتورة أحدهم بلا سند.
 */
export function resolveModelVendor(modelLabel: string, harness?: string): VendorKey {
  const label = (modelLabel ?? '').trim().toLowerCase();

  const slash = label.indexOf('/');
  if (slash > 0) {
    const prefix = label.slice(0, slash);
    const mapped = CARRIER_PREFIX_VENDORS[prefix];
    if (mapped) {
      return mapped;
    }
  }

  const bare = slash > 0 ? label.slice(slash + 1) : label;
  for (const [prefix, vendor] of MODEL_PREFIX_VENDORS) {
    if (bare.startsWith(prefix)) {
      return vendor;
    }
  }

  if (harness) {
    const fallback = harnessVendor(harness);
    if (fallback) {
      return fallback;
    }
  }

  return 'unknown';
}
