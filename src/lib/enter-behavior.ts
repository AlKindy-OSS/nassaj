/**
 * enter-behavior — الحلّ الوحيد لسلوك مفتاح Enter في مُؤلِّف الرسالة.
 *
 * ## المشكلة التي يحلّها (‏T-1319)
 *
 * التفضيل اليوم بوليان واحد (`sendByCtrlEnter`) مُزامَن على مستوى الحساب:
 * إمّا «‏Enter يُرسل» في كل أجهزة الحساب، أو «‏Enter سطر جديد» في كلّها. وهذا
 * يقود إلى عطلٍ بنيوي: الجوال بلا لوحة مفاتيح فيزيائية يريد Enter سطراً
 * جديداً، والكمبيوتر يريده إرسالاً — والحساب واحد.
 *
 * ولا يكفي ترقيعُ الحلّ بـ`sendByCtrlEnter || isTouch`، لأنّه يسحب من مستخدم
 * اللمس القدرةَ على استعادة الإرسال بـEnter نهائياً: القيمة `false` صارت تعني
 * «حسب الجهاز» و`true` تعني «سطر جديد»، ولا تبقى قيمة تعني «أرسِل دائماً».
 *
 * ## القاعدة
 *
 * تُخزَّن **النيّة** في فضاء ثلاثي، ويُحلّ سلوك الجهاز الحاضر محلياً وقت العرض.
 * وهو النمط القائم في المنتج نفسه: `theme` مُزامَن وقيمته قد تكون `'system'`
 * ويحلّها `resolveIsDark()` في `src/lib/theme-mode.ts`.
 *
 * ## لماذا `'auto'` هنا وقد أُسقطت في `tabs-display-mode`؟
 *
 * هناك كان `resolve('auto') ≡ resolve('full')` في كل بيئة ممكنة، فالقيمة
 * الخامسة بلا معلومة. وهنا العكس تماماً: الحلّ **لا** يُطبَّق على القيمتين
 * الصريحتين (`'send'` و`'newline'` نيّةٌ لا تُنقض بالبيئة)، فـ`'auto'` هي
 * القيمة الوحيدة التي تحمل معلومة «اسأل الجهاز» — وبدونها لا يوجد افتراضٌ
 * يختلف بين الجوال والكمبيوتر أصلاً، وهو نصّ المطلوب.
 */

/** نيّة المستخدم المخزَّنة والمُزامَنة على الحساب. */
export type EnterBehavior = 'auto' | 'send' | 'newline';

export const ENTER_BEHAVIORS: readonly EnterBehavior[] = ['auto', 'send', 'newline'];

/**
 * الإشارة: **وجود** مؤشّر دقيق على الجهاز (فأرة أو لوحة تعقّب)، لا نوع المؤشّر
 * الأوّلي ولا عرض النافذة.
 *
 * لماذا `any-pointer` لا `pointer`؟ لأن الجهاز اللوحي الموصول بلوحة مفاتيح
 * (‏iPad + Magic Keyboard، وأجهزة أندرويد المرصوفة) يبقى مؤشّره الأوّلي خشناً
 * بينما صار له لوحة مفاتيح فيزيائية فعلاً — و`any-pointer: fine` هي الاستعلام
 * الوحيد الذي يلتقطه. والمؤشّر الدقيق ملازمٌ عملياً للوحة مفاتيح فيزيائية،
 * وهي بالضبط الشرط الذي يجعل «‏Enter يُرسل» مريحاً لا مفخّخاً.
 *
 * ولماذا لا `useDeviceSettings`؟ لأنه يقيس **عرض النافذة**: نافذةٌ ضيّقة على
 * سطح المكتب ليست جوالاً، وجهازٌ لوحي أفقي ليس كمبيوتراً. القرار هنا عن
 * الإدخال لا عن المساحة.
 */
export const FINE_POINTER_QUERY = '(any-pointer: fine)';

export type EnterBehaviorEnvironment = {
  /** للجهاز مؤشّر دقيق (⇒ لوحة مفاتيح فيزيائية عملياً). */
  hasFinePointer: boolean;
};

/**
 * يحوّل النيّة المخزَّنة إلى القرار الفعلي: هل ضغطة Enter المجرّدة تُرسل؟
 *
 * دالّة نقيّة بلا DOM ولا React، فتُختبَر جدولياً على كل تقاطع.
 */
export function resolveEnterSends(
  stored: EnterBehavior,
  env: EnterBehaviorEnvironment,
): boolean {
  if (stored === 'send') return true;
  if (stored === 'newline') return false;
  return env.hasFinePointer;
}

/** يقرأ قيمة واردة (تخزين، حساب، تبويب آخر) ويردّ ما ليس من الـenum إلى البديل. */
export function parseEnterBehavior(value: unknown, fallback: EnterBehavior): EnterBehavior {
  if (typeof value === 'string' && (ENTER_BEHAVIORS as readonly string[]).includes(value)) {
    return value as EnterBehavior;
  }
  return fallback;
}

/* ───────────────────────── قرار الضغطة الواحدة ───────────────────────── */

/** المُعدِّلات المرافقة لضغطة Enter، بلا اعتماد على نوع حدث React. */
export type EnterChord = {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** إدخال IME قيد التركيب (`event.nativeEvent.isComposing`). */
  isComposing: boolean;
};

/**
 * ‏`'send'` = نُوقف السلوك الافتراضي ونُرسل. `'newline'` = نتركها للمتصفّح
 * (سطرٌ جديد، أو إنهاءُ تركيب IME).
 */
export type EnterAction = 'send' | 'newline';

/**
 * قرار ضغطة Enter الواحدة. نقيّة بلا DOM كي تُختبَر على المصفوفة كاملةً:
 * ‏(‏auto|send|newline) × (fine|coarse) × (‏Enter|Shift|Ctrl|Alt).
 *
 * ترتيب الفروع مقصود، وكلٌّ منها موثَّق عند نظيره في `useChatComposerState`:
 *   1. تركيب IME → لا إرسال (الضغطة تُنهي التركيب).
 *   2. ‏Ctrl/Cmd+Enter (بلا Shift) → إرسالٌ دائماً، مخرج الطوارئ الثابت.
 *   3. ‏Shift → سطرٌ جديد دائماً.
 *   4. ‏Alt → سطرٌ جديد (قرارٌ مقصود يصحّح سهواً قائماً — انظر التعليق هناك).
 *   5. المجرّدة → القرار المحلول لهذا الجهاز.
 */
export function decideEnterAction(chord: EnterChord, enterSends: boolean): EnterAction {
  if (chord.isComposing) return 'newline';
  if ((chord.ctrlKey || chord.metaKey) && !chord.shiftKey) return 'send';
  if (chord.shiftKey) return 'newline';
  if (chord.altKey) return 'newline';
  return enterSends ? 'send' : 'newline';
}

/* ───────────────── الجسر إلى المفتاح القديم `sendByCtrlEnter` ─────────────────
 *
 * ‏[حرج] المفتاح القديم **يبقى** مُزامَناً مرآةً مشتقّة، ولا يُحذف. الكتلة
 * (`uiPreferences`) تُزامَن صفقةً واحدة: القارئ يختزل على `PREFERENCE_KEYS`
 * الخاصة بحزمة العميل التي يشغّلها، والكاتب يكتب الحالة كاملة، والخادم يدمج
 * دمجاً سطحياً للمستوى الأعلى. فتبويبٌ على حزمة قديمة — والـService Worker
 * يجعل ذلك واقعاً لا احتمالاً — لن يجد `enterBehavior`، ولن يجد
 * `sendByCtrlEnter` لو حُذف، فيسقط على الافتراضات ثم يكتب الكتلة كاملةً فوق
 * الحساب: أي عودةُ العطل المطلوب إصلاحه، صامتةً وعلى كل الأجهزة.
 */

/**
 * المرآة للأمام: ماذا يجب أن يقرأ عميلٌ قديم لا يعرف `enterBehavior`؟
 *
 * ‏`'auto'` تُنتج `false` قصداً: العميل القديم لا يملك حلّاً محلياً، و`false`
 * تُبقيه على سلوكه اليوم حرفياً (‏Enter يُرسل) فلا انحدار. و`true` كانت
 * ستُوقف الإرسال بـEnter على سطح المكتب لكل من لم يغيّر شيئاً.
 */
export const enterBehaviorToLegacy = (behavior: EnterBehavior): boolean => behavior === 'newline';

/**
 * الاشتقاق العكسي: قيمةٌ وردت من عميل قديم (لا `enterBehavior` فيها) تُعاد إلى
 * نيّة.
 *
 * **خانة فقدٍ مقبولة وموثَّقة:** رحلة (جديد ← قديم ← جديد) تُعيد `'send'` إلى
 * `'auto'`، لأن كليهما يُنتج `sendByCtrlEnter: false` فلا يبقى في الحمولة ما
 * يفرّق بينهما. وعلى سطح المكتب `auto ≡ send` فلا فرق مرئي؛ والضرر محصور في
 * مستخدم لمسٍ اختار «يُرسل» صراحةً، وانحدارُه إلى الافتراض الآمن لا إلى ضدّه.
 * لا تحاول علاجها: كل علاج يتطلّب حقلاً ثانياً في نفس الكتلة التي يمحوها
 * العميل القديم أصلاً.
 */
export const enterBehaviorFromLegacy = (sendByCtrlEnter: boolean): EnterBehavior =>
  (sendByCtrlEnter ? 'newline' : 'auto');
