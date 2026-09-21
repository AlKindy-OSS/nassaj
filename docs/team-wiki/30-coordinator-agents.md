# المنسّق والوكلاء

نسّاج كور هو الدماغ الحقيقي للمنظومة. تخيّل أنك مدير مشروع — وفريقك من الخبراء. هذا هو نسّاج كور بالضبط.

---

## القاعدة الصفرية: من ينفّذ؟

**قاعدة ذهبية واحدة، صارمة:**

**المنسّق يستقبل الطلب والوكيل ينفّذ. المنسّق لا ينفّذ بنفسه أبداً.**

### مثال واقعي: المحادثة الكاملة

```
الموظف: أريد صفحة تسجيل دخول باستخدام Google.

[المنسّق يقرأ الطلب]

المنسّق (نفسياً): حسناً، هذا يحتاج:
  - ui-designer يرسم الصفحة
  - backend-dev يبرمج API Google
  - frontend-dev يربط التصميم مع API

[المنسّق يستدعي الثلاثة]

المنسّق: يا ui-designer، صمّم صفحة تسجيل باستخدام Google.
ui-designer: حسناً، بدأت العمل.

[المنسّق ينتظر]
[المنسّق يتابع التقدم]

backend-dev: انتهيت من واجهة برمجة التطبيقات (`API`).
frontend-dev: انتهيت من الربط.
ui-designer: انتهيت من التصميم.

[المنسّق يراجع النتيجة]

المنسّق: ممتاز، كل شيء جاهز. أخبر الموظف الخبر السار.

الموظف: شُكراً! الميزة حية.
```

**النقاط المهمة:**
- المنسّق لم يكتب سطر كود
- المنسّق لم يرسم تصميم
- المنسّق فقط **نسّق** بين الوكلاء

### مقارنة بين المنسّق والوكيل

| الفعل | المنسّق | الوكيل |
|---|---|---|
| استقبال الطلب | ✓ نعم | ✗ لا |
| فهم السياق والحصة | ✓ نعم | ✗ لا |
| اختيار الوكيل المختص | ✓ نعم | ✗ لا |
| **تنفيذ العمل** | ✗ **لا** | ✓ **نعم** |
| الاختبار والمراجعة | ✓ إشراف | ✓ تنفيذ |
| تحديث لوحة المشروع | ✓ نعم | ✗ لا |
| تسجيل القرارات | ✓ نعم | ✗ لا |

## الوكلاء: من هم؟

فريق الوكلاء المتخصصين الـ23، منظّمون حسب التخصص.

**تذكير مهم:** لست مضطراً لحفظ أسماء الوكلاء — **المنسّق يختار الوكيل المناسب تلقائياً** لطلبك. الجدول أدناه للاطلاع فقط إذا أردت معرفة من يفعل ماذا.

> عمود «النموذج» يعرض أعلى نموذج Claude متاح **حالياً** لكل درجة حساسية — قاعدة ديناميكية، لا اسماً ثابتاً للأبد. التفاصيل والقاعدة الكاملة في قسم «سياسة النماذج» أسفل هذه الصفحة.

### فريق الهندسة — 7 وكلاء

| المعرّف | الاسم العربي | الدور | النموذج |
|---|---|---|---|
| **architect** | المِعمار | تصميم معمارية النظام والقرارات التقنية الكبرى | Fable 5 |
| **backend-dev** | البنّاء | بناء APIs ومنطق الأعمال وطبقة البيانات | Fable 5 |
| **frontend-dev** | النقّاش | بناء واجهات المستخدم المتجاوبة بدعم RTL | Sonnet 5 |
| **devops** | البنيّة | البنية التحتية والنشر والمراقبة والحوادث | Fable 5 |
| **qa-critic** | الناقد | مراجعة نقدية للكود والقرارات بصلاحية فيتو | Fable 5 |
| **tester** | الفاحص | اختبارات unit/integration/e2e ورفع التغطية | Sonnet 5 |
| **end-user-tester** | المُجرِّب | تجربة التطبيق كمستخدم عادي عبر متصفح حقيقي | Fable 5 |

### فريق التصميم — 3 وكلاء

| المعرّف | الاسم العربي | الدور | النموذج |
|---|---|---|---|
| **ui-designer** | الرسّام | Design Brief بصري وdesign tokens قبل الكود | Fable 5 |
| **design-reviewer** | مُراجع التصميم | نقد جمالي للواجهات مقابل موجز التصميم (`Brief`) | Fable 5 |
| **a11y-architect** | المُيسِّر | امتثال WCAG 2.2 والتسهيلات والتيسير | Fable 5 |

### فريق الأعمال — 6 وكلاء

| المعرّف | الاسم العربي | الدور | النموذج |
|---|---|---|---|
| **product-strategist** | المُخطِّط | المشكلة والجمهور والنطاق وأولويات MVP | Fable 5 |
| **business-advisor** | مستشار الأعمال | الجدوى وROI والمنافسون بصلاحية فيتو | Fable 5 |
| **brand-marketer** | المُسوِّق | العلامة والتموضع والرسائل وGTM | Fable 5 |
| **certified-accountant** | المُحاسِب | محاسبة وضرائب VAT/زكاة وFatoora | Fable 5 |
| **legal-compliance-advisor** | المستشار القانوني | امتثال وخصوصية PDPL وجاهزية قانونية | Fable 5 |
| **negotiator** | المُفاوِض | التفاوض التجاري وتسوية النزاعات والردّ على المساومات | Fable 5 |

### فريق التسويق والمبيعات — 5 وكلاء

| المعرّف | الاسم العربي | الدور | النموذج |
|---|---|---|---|
| **growth-strategist** | المُنمّي | النمو وfunnel والقنوات والتجارب | Fable 5 |
| **sales-closer** | البائع | تأهيل العملاء والعروض وإغلاق الصفقات | Fable 5 |
| **content-writer** | الكاتب | محتوى تسويقي عربي/إنجليزي | Haiku 4.5 |
| **social-media-manager** | الإعلامي | تقويم النشر وتكييف المحتوى لكل منصة | Fable 5 |
| **customer-support** | المُساند | ردود الدعم وتأهيل الاستفسارات والتصعيد | Fable 5 |

### الوكلاء العابرون للتخصصات — وكيلان

| المعرّف | الاسم العربي | الدور | النموذج |
|---|---|---|---|
| **scribe** | الموثِّق | التوثيق وDecision Logs وmemory | Haiku 4.5 |
| **researcher** | الباحث | بحث منهجي محايد موثَّق المصادر | Sonnet 5 |

**الإجمالي: 23 وكيلاً** موزّعين على 5 فِرَق: الهندسة، التصميم، الأعمال، التسويق والمبيعات، والعابرون.

### الفِرَق والاستدعاء الجماعي

نسّاج ينظّم الوكلاء في فِرَق للعمل المنسّق:

| الفريق | الوكلاء | الاستدعاء الشائع | الحالة |
|---|---|---|---|
| **الفريق التقني** | المِعمار، البنّاء، النقّاش، البنيّة، الناقد، الفاحص، المُجرِّب | «الفريق التقني» | مشاريع هندسية، تطوير كامل |
| **فريق الأعمال** | المُخطِّط، مستشار الأعمال، المُسوِّق، المُحاسِب، المستشار القانوني، المُفاوِض | «فريق الأعمال» | إطلاق منتج، قرار استراتيجي، تسعير، تفاوض |
| **فريق التسويق** | المُنمّي، البائع، الكاتب، الإعلامي، المُساند | «فريق التسويق» | حملة جديدة، سياسة غيار، رسائل GTM |
| **العابرون** | الموثِّق، الباحث | «الموثِّقون» / «الباحثون» | توثيق عام، بحث مستقل |

### مسارات التفويض الشائعة

المنسّق يختار الوكلاء حسب نوع المهمة:

- **شاشة/واجهة جديدة:** الرسّام (Design Brief) → النقّاش (البرمجة) → مُراجع التصميم (تقييم جمالي) → المُجرِّب (اختبار يدوي) → الناقد (مراجعة جودة) → الفاحص (اختبارات آلية)
- **قرار معماري:** المِعمار + الناقد (مراجعة معمارية)
- **ميزة مكتملة:** الموثِّق (تسجيل القرارات والتغييرات)
- **إطلاق عام:** المستشار القانوني **إلزامي** + فريق الأعمال كاملاً
- **تسعير أو ضرائب:** المُحاسِب
- **حملة تسويقية:** المُسوِّق + الكاتب + الإعلامي + المُنمّي

## الذاكرة الدائمة

نسّاج لديه **ذاكرة قوية**. يتذكّر:

### ما يُحفظ في الذاكرة

| النوع | الأمثلة |
|---|---|
| **قرارات المشاريع السابقة** | "قررنا الشهر الماضي استخدام React" |
| **السياسات والقيود** | "لا نقبل commit بلا اختبارات" |
| **خطط المشاريع** | "المرحلة الثانية تبدأ الأسبوع القادم" |
| **السياق الكامل** | من بدأنا المشروع، كل الخطوات |
| **الأخطاء الماضية** | "كنا واجهنا هذه المشكلة سابقاً، إليك الحل" |

### كيف تُستخدم الذاكرة؟

```
أنت: أريد ميزة تسجيل باستخدام SSO.

[المنسّق يفتح ملفات المشروع]

المنسّق: آه، تذكرت! قررنا سابقاً استخدام Passport.js.
         ذكر الوكيل السابق أن هذه هي الممارسة الفضلى.
         سأستدعي الوكيل نفسه للحفاظ على الاتساق.
```

هذا يعني أنك **لا تضطر إلى شرح السياق كل مرة**. يفتح الوكيل الملف، ويقرأ السجل، ويستمر من حيث توقّفنا.

## آلية استدعاء الوكلاء

### كيف يُستدعى الوكلاء؟

**المنسّق لا ينفّذ بنفسه.** بدلاً من ذلك:

1. **المنسّق يفهم طلبك** — يقرأ المحادثة، يفهم السياق، يفكر في التفاصيل
2. **المنسّق يختار الوكيل(اء) المختص(ين)** — أي خبير(ين) يحتاج لهذه المهمة؟
3. **المنسّق يستدعيهم** — يطلق وكيل واحد أو أكثر بالتوازي للمهام المستقلة
4. **الوكلاء ينفّذون** — كل وكيل يعمل ضمن تخصصه، ويختبر عمله، ويصلح أخطاءه
5. **الوكلاء يرجعون النتيجة** — "انتهيت من المهمة"
6. **المنسّق يحدّث اللوحة** — يُوثّق النتيجة، يُخبرك بالإنجاز

### تحديثات التقدّم

إذا استغرق العمل أكثر من ثلاث دقائق، يجب على المنسّق أن يضمّن نسبة الإنجاز الحالية في كل تحديث مرحلي يرسله أثناء التنفيذ، وأن يحدّثها مع كل تقدّم جوهري حتى اكتمال المهمة. تُذكر النسبة بصيغة واضحة مثل: **نسبة الإنجاز: 60%**، ولا تُستخدم لتوحي بدقة غير متاحة؛ عند عدم إمكان القياس الدقيق تُقدَّم كتقدير تقريبي.

**مثال واقعي:**

```
أنت: أريد صفحة تسجيل باستخدام Google

[المنسّق يقرأ]

المنسّق (نفسياً):
  ✓ هذا يحتاج تصميم (ui-designer)
  ✓ يحتاج برمجة خادم (backend-dev)
  ✓ يحتاج برمجة واجهة (frontend-dev)

[المنسّق يستدعيهم الثلاثة معاً]

ui-designer: أنا أرسم
backend-dev: أنا أبرمج API Google
frontend-dev: أنا أربط

[يعملون بالتوازي]

[بعد الانتهاء]

qa-critic: اختبرت الميزة، وكل شيء سليم

المنسّق: ممتاز! الميزة حية الآن.
أنت: شُكراً! (ترى الزر مباشرة)
```

## بوابة بدء المشروع: لا كود قبل الخطة

**قاعدة صارمة:** لا نكتب سطر كود قبل اعتماد خطة المشروع.

### الخطوات الإلزامية

1. **فهم المشكلة** — اسأل نفسك:
   - ما المشكلة التي نحلها؟
   - من العميل (داخلي أو خارجي)؟
   - كم نربح من هذا؟

2. **كتابة الخطة** — وثيقة تفصيلية:
   - المراحل الرئيسية
   - المهام الفردية
   - المواعيد والمسؤولون

3. **عرض على المالك** — اجتماع مباشر:
   - شرح الخطة كاملة
   - الإجابة على الأسئلة

4. **موافقة مكتوبة واضحة** — توقيع رسمي:
   - المالك يقول: "موافق"
   - تُسجَّل الموافقة في الملفات

5. **البدء** — فقط بعد الموافقة:
   - الآن يمكنك البدء بالكود

**النتيجة:** توفير وقت، منع إعادة العمل، توافق تام.

## حدود الاستخدام: لماذا يتوقّف نسّاج؟

نسّاج مثل موظف يعمل بميزانية محدودة:

| الحد | الكمية |
|---|---|
| **الجلسة الواحدة** | 5 ساعات عمل |
| **الأسبوع الواحد** | ساعات إضافية محدودة |

عندما تنتهي الساعات:
- المنسّق يقول: "الحصة انتهت، انتظر الجلسة الجديدة"
- الجلسة الجديدة تبدأ بسياق كامل من السابقة (الذاكرة محفوظة)
- الساعات تعود من الصفر

**لماذا هذا؟** الوكلاء في الحقيقة أدوات ذكية (Claude، agy)، كل منها لها تكلفة مالية. الميزانية تحمينا من الإفراط والتكاليف الضخمة.

## الاجتماعات والقرارات الكبيرة

القرارات الكبيرة (إطلاق منتج، تغيير استراتيجية، دخول سوق جديد) تحتاج استدعاء جماعي:

| الطرف | الدور |
|---|---|
| **المالك** | يقرر النهائي |
| **المنسّق** | ينسّق النقاش |
| **الوكلاء المعنيون** | يشرحون المتطلبات الفنية |

بعد النقاش:
1. **القرار يُتخذ** من المالك
2. **يُسجَّل رسمياً** في ملف القرارات
3. **نسّاج يتذكّره** للأبد

---

## للمهتمين: سياسة النماذج (متقدم)

هذا القسم تفاصيل تقنية عن النماذج واللغات المستخدمة. **تخطّاه إن لم تكن مهتماً.**

### سياسة النماذج الهجينة: أرضية ديناميكية وتصعيد محكوم

**القاعدة الرسمية أولاً:** أرضية كل وكيل ليست اسم نموذج مثبَّتاً للأبد، بل قاعدة: **أعلى نموذج Claude متاح حينها**. حالياً (منذ عودته للمنصة في 2026-07-02) ذلك يعني **Fable 5**. لو غاب Fable 5 غداً، تهبط الأرضية تلقائياً لأعلى ما يليه — اليوم ذلك **Opus 4.8** — بلا انتظار قرار وبلا تعديل توثيق.

**كل وكيل له "نموذج أرضية" حسب حساسية عمله (بالقيم الحالية):**

| الحساسية | النموذج الحالي (أعلى متاح) | الوكلاء |
|---|---|---|
| **حسّاس جداً** | Fable 5 | المنسّق، architect, qa-critic, security-review, devops |
| **روتيني** | Sonnet 5 | frontend-dev, researcher, tester |
| **خفيف** | Haiku 4.5 | scribe, content-writer |
| **غير محدد** | Fable 5 | أي وكيل آخر لا يوجد له نموذج معروّف |

**تفسير البطاقة:**
- **الحسّاس جداً** = يأخذ دائماً أعلى نموذج متاح (اليوم Fable 5) — للقرارات والمراجعات والعمل عالي المخاطر
- **الروتيني** = يكفيه نموذج متوسط (Sonnet 5) — توازن بين القوة والسرعة
- **الخفيف** = يكفيه نموذج سريع (Haiku 4.5) — للتوثيق والمحتوى البسيط

### التصعيد المحكوم

المنسّق يجوز له **رفع وكيل درجة واحدة للأعلى** لمهمة معقّدة أو عالية المخاطر:

- **Haiku → Sonnet** (خفيف → روتيني)
- **Sonnet → Fable** (روتيني → حسّاس، أو أعلى نموذج متاح حينها إن تغيّر الاسم)
- **Fable → أعلى نموذج متاح** (فقط في أقسى الحالات)

**شرط التصعيد:** يجب تسجيل السبب في prompt الوكيل أو تحديث لوحة المشروع.

**لا تخفيض أبداً:** الأرضية سقف سفلي لا يُكسر للأسفل، مهما تغيّر اسم النموذج الأعلى.

### قاعدة الاحتياط: آلية دائمة، لا حالة استثنائية

**هذه ليست حالة نادرة يُستثنى لها — إنها التصميم الدائم:** الأرضية تُعرَّف بالقاعدة («أعلى نموذج Claude متاح حينها») لا باسم نموذج بعينه.

- **إن غاب Fable 5** من البيئة (كما حدث فعلاً قبل عودته في 2026-07-02): تهبط الأرضية فوراً لأعلى نموذج Claude متاح حينها — اليوم ذلك **Opus 4.8**.
- **إن عاد نموذج أعلى من Fable 5 مستقبلاً:** يرتفع سقف الأرضية معه تلقائياً، بلا حاجة لتعديل هذه الصفحة يدوياً.

**تذكّر:** لا تحفظ "Fable 5" كاسم ثابت — احفظ القاعدة نفسها: الأرضية = أعلى نموذج Claude متاح الآن.

---

## أين يقيم كل شيء فعلياً؟

سؤال يتكرر: "نسّاج هذا... وين بالضبط؟" وَ"وين يشتغل الذكاء الاصطناعي فعلياً؟" الإجابة المختصرة: **التنسيق محلي، والتفكير الفعلي بعيد دائماً.**

<svg class="wiki-diagram" viewBox="0 0 1180 700" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="مخطط الهيكل الكامل لنسّاج: طبقة الوصول (متصفح، طرفية، agy، Hermes) تصل إلى الخادم المحلي (نفق كلاودفلير، كود نسّاج ديف، المنسّق، وكيل متخصص) الذي ينسّق محلياً فقط، بينما التفكير يجري دائماً في السحابة البعيدة (سحابة Anthropic افتراضياً، وسحابة Antigravity وسحابة Nous عند التفعيل الصريح).">
  <title>الهيكل الكامل لنسّاج — التنسيق محلي، والتفكير سحابي دائماً</title>
  <desc>ثلاث طبقات من الأعلى للأسفل: كيف تصل، الخادم المحلي (تنسيق فقط)، ومعالجة الذكاء الاصطناعي السحابية. الخطوط الممتلئة مسارات دائمة والمنقّطة مسارات مباشرة أو عند التفعيل الصريح.</desc>
  <defs>
    <marker id="ov1-arrow-solid" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,1 L9,5 L0,9 Z" fill="hsl(var(--muted-foreground))" />
    </marker>
    <marker id="ov1-arrow-dash" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,1 L9,5 L0,9 Z" fill="hsl(var(--ring))" />
    </marker>
    <marker id="ov1-arrow-local" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0,1 L9,5 L0,9 Z" fill="hsl(145 55% 42%)" />
    </marker>
  </defs>

  <!-- المحتوى (عرضه 900) موسّط داخل viewBox=1180 بإزاحة 140 على كل جانب، فلا قصّ ولا هامش أعرج.
       عناوين الأشرطة اليمنى تحمل direction="rtl" مع text-anchor="end" لتُثبَّت حافتها اليمنى عند المرساة
       وتتدفّق يساراً — يمنع أي تجاوز للحافة اليمنى مهما طال النص. -->
  <g transform="translate(140,10)">

  <!-- ═══ طبقة 1: كيف تصل؟ ═══ -->
  <g>
    <rect x="0" y="0" width="900" height="132" rx="18" fill="hsl(var(--muted) / 0.45)" stroke="hsl(var(--border))" stroke-width="1.5" />
    <text x="882" y="27" text-anchor="start" direction="rtl" font-size="16" font-weight="700" fill="hsl(var(--foreground))">كيف تصل؟</text>

    <!-- متصفح (أقصى اليمين) -->
    <g transform="translate(688,44)">
      <rect x="0" y="0" width="194" height="72" rx="12" fill="hsl(var(--card))" stroke="hsl(var(--border))" stroke-width="1.5" />
      <rect x="16" y="24" width="26" height="20" rx="3" fill="none" stroke="hsl(var(--primary))" stroke-width="1.8" />
      <line x1="16" y1="30" x2="42" y2="30" stroke="hsl(var(--primary))" stroke-width="1.8" />
      <circle cx="19.5" cy="27" r="1.1" fill="hsl(var(--primary))" />
      <circle cx="23.5" cy="27" r="1.1" fill="hsl(var(--primary))" />
      <text x="178" y="32" text-anchor="start" font-size="14" font-weight="700" fill="hsl(var(--card-foreground))">متصفح</text>
      <text x="178" y="54" text-anchor="end" font-size="13" fill="hsl(var(--muted-foreground))" direction="ltr">nassaj.example.com</text>
    </g>

    <!-- طرفية -->
    <g transform="translate(466,44)">
      <rect x="0" y="0" width="204" height="72" rx="12" fill="hsl(var(--card))" stroke="hsl(var(--border))" stroke-width="1.5" />
      <rect x="16" y="23" width="26" height="22" rx="3" fill="hsl(var(--foreground) / 0.06)" stroke="hsl(var(--primary))" stroke-width="1.8" />
      <path d="M20,30 l4,4 l-4,4" fill="none" stroke="hsl(var(--primary))" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      <line x1="28" y1="39" x2="36" y2="39" stroke="hsl(var(--primary))" stroke-width="1.6" stroke-linecap="round" />
      <text x="188" y="32" text-anchor="start" font-size="13.5" font-weight="700" fill="hsl(var(--card-foreground))">طرفية Claude Code</text>
      <text x="188" y="54" text-anchor="start" font-size="13" fill="hsl(var(--muted-foreground))">اتصال CLI مباشر</text>
    </g>

    <!-- agy -->
    <g transform="translate(244,44)">
      <rect x="0" y="0" width="204" height="72" rx="12" fill="hsl(var(--card))" stroke="hsl(var(--border))" stroke-width="1.5" />
      <circle cx="29" cy="34" r="13" fill="none" stroke="hsl(var(--primary))" stroke-width="1.8" />
      <ellipse cx="29" cy="34" rx="13" ry="5.5" fill="none" stroke="hsl(var(--primary))" stroke-width="1.4" />
      <line x1="29" y1="21" x2="29" y2="47" stroke="hsl(var(--primary))" stroke-width="1.4" />
      <text x="188" y="32" text-anchor="start" font-size="13.5" font-weight="700" fill="hsl(var(--card-foreground))">عميل agy</text>
      <text x="188" y="54" text-anchor="start" font-size="13" fill="hsl(var(--muted-foreground))">مزوّد Antigravity</text>
    </g>

    <!-- Hermes (أقصى اليسار) -->
    <g transform="translate(18,44)">
      <rect x="0" y="0" width="204" height="72" rx="12" fill="hsl(var(--card))" stroke="hsl(var(--border))" stroke-width="1.5" stroke-dasharray="4 3" />
      <path d="M22,46 l0,-18 a7,7 0 0 1 14,0 l0,18 M18,46 l22,0" fill="none" stroke="hsl(var(--primary))" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
      <text x="188" y="32" text-anchor="start" font-size="13.5" font-weight="700" fill="hsl(var(--card-foreground))">عميل Hermes</text>
      <text x="188" y="54" text-anchor="start" font-size="13" fill="hsl(var(--muted-foreground))">مزوّد Nous · تكامل جزئي</text>
    </g>
  </g>

  <!-- ═══ طبقة 2: الخادم المحلي ═══ -->
  <g>
    <rect x="0" y="200" width="900" height="238" rx="18" fill="hsl(145 45% 42% / 0.08)" stroke="hsl(145 50% 42%)" stroke-width="1.75" />
    <g transform="translate(882,228)">
      <text x="0" y="0" text-anchor="start" direction="rtl" font-size="16" font-weight="700" fill="hsl(var(--foreground))">الخادم — محلي عندنا</text>
      <text x="0" y="20" text-anchor="start" direction="rtl" font-size="13" fill="var(--wiki-diagram-ok)">تنسيق فقط · بلا تفكير ذكاء اصطناعي</text>
    </g>

    <!-- نفق Cloudflare -->
    <g transform="translate(660,270)">
      <rect x="0" y="0" width="222" height="66" rx="12" fill="hsl(var(--card))" stroke="hsl(145 45% 42% / 0.55)" stroke-width="1.5" />
      <path d="M18,44 a11,11 0 0 1 2,-21 a13,13 0 0 1 24,3 a9,9 0 0 1 -2,18 Z" fill="hsl(145 55% 42% / 0.14)" stroke="hsl(145 55% 42%)" stroke-width="1.5" stroke-linejoin="round" />
      <text x="206" y="27" text-anchor="start" direction="rtl" font-size="13.5" font-weight="700" fill="hsl(var(--card-foreground))">نفق Cloudflare</text>
      <text x="206" y="47" text-anchor="end" font-size="13" fill="hsl(var(--muted-foreground))" direction="ltr">nassaj.example.com → 127.0.0.1:3004</text>
    </g>

    <!-- كود نسّاج ديف -->
    <g transform="translate(660,352)">
      <rect x="0" y="0" width="222" height="64" rx="12" fill="hsl(var(--card))" stroke="hsl(145 45% 42% / 0.55)" stroke-width="1.5" />
      <path d="M28,22 l-9,10 l9,10 M20,22 l7,0 l0,20 l-7,0" fill="none" stroke="hsl(145 55% 42%)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
      <rect x="30" y="26" width="14" height="12" rx="2" fill="none" stroke="hsl(145 55% 42%)" stroke-width="1.5" />
      <text x="206" y="27" text-anchor="start" direction="rtl" font-size="13.5" font-weight="700" fill="hsl(var(--card-foreground))">كود نسّاج ديف</text>
      <text x="206" y="47" text-anchor="start" direction="rtl" font-size="13" fill="hsl(var(--muted-foreground))">الخادم الرئيسي · fork من claudecodeui</text>
    </g>

    <!-- المنسّق -->
    <g transform="translate(338,274)">
      <rect x="0" y="0" width="266" height="76" rx="14" fill="hsl(var(--primary))" stroke="hsl(var(--primary))" stroke-width="1.5" />
      <g transform="translate(30,38)" stroke="hsl(var(--primary-foreground))" fill="none" stroke-width="1.7">
        <circle cx="0" cy="0" r="7" />
        <g stroke-linecap="round">
          <line x1="0" y1="-13" x2="0" y2="-10" /><line x1="0" y1="13" x2="0" y2="10" />
          <line x1="-13" y1="0" x2="-10" y2="0" /><line x1="13" y1="0" x2="10" y2="0" />
          <line x1="-9.2" y1="-9.2" x2="-7" y2="-7" /><line x1="9.2" y1="9.2" x2="7" y2="7" />
          <line x1="9.2" y1="-9.2" x2="7" y2="-7" /><line x1="-9.2" y1="9.2" x2="-7" y2="7" />
        </g>
        <circle cx="0" cy="0" r="2.4" fill="hsl(var(--primary-foreground))" />
      </g>
      <text x="248" y="32" text-anchor="start" direction="rtl" font-size="16" font-weight="800" fill="hsl(var(--primary-foreground))">المنسّق</text>
      <text x="248" y="54" text-anchor="end" font-size="13" fill="hsl(var(--primary-foreground))" direction="ltr">Fable 5</text>
    </g>

    <!-- وكيل متخصص (يسار، مباعد عن المنسّق) -->
    <g transform="translate(18,262)">
      <rect x="0" y="0" width="266" height="100" rx="14" fill="hsl(var(--card))" stroke="hsl(145 45% 42% / 0.55)" stroke-width="1.5" />
      <g transform="translate(30,32)" stroke="hsl(145 55% 42%)" fill="none" stroke-width="1.7">
        <circle cx="0" cy="-4" r="6" />
        <path d="M-9,14 a9,9 0 0 1 18,0" stroke-linecap="round" />
      </g>
      <text x="248" y="30" text-anchor="start" direction="rtl" font-size="14.5" font-weight="800" fill="hsl(var(--card-foreground))">وكيل متخصص واحد</text>
      <text x="248" y="54" text-anchor="end" font-size="13" fill="hsl(var(--muted-foreground))" direction="ltr">architect · backend-dev · frontend-dev</text>
      <text x="248" y="74" text-anchor="end" font-size="13" fill="hsl(var(--muted-foreground))" direction="ltr">qa-critic · scribe · devops · tester …</text>
    </g>
  </g>

  <!-- ═══ طبقة 3: السحابة ═══ -->
  <g>
    <rect x="0" y="484" width="900" height="152" rx="18" fill="hsl(202 85% 55% / 0.09)" stroke="hsl(202 80% 52%)" stroke-width="1.75" />
    <g transform="translate(882,512)">
      <text x="0" y="0" text-anchor="start" direction="rtl" font-size="16" font-weight="700" fill="hsl(var(--foreground))">معالجة الذكاء الاصطناعي — سحابية دائماً</text>
      <text x="0" y="20" text-anchor="start" direction="rtl" font-size="13" fill="var(--wiki-diagram-info)">خارج الخادم · كل مستخدم باشتراكه الخاص</text>
    </g>

    <!-- سحابة Anthropic -->
    <g transform="translate(626,550)">
      <rect x="0" y="0" width="256" height="70" rx="14" fill="hsl(202 85% 55% / 0.10)" stroke="hsl(202 80% 52%)" stroke-width="1.6" />
      <path d="M18,50 a12,12 0 0 1 2,-23 a14,14 0 0 1 26,3 a10,10 0 0 1 -2,20 Z" fill="hsl(202 85% 55% / 0.16)" stroke="hsl(202 80% 52%)" stroke-width="1.6" stroke-linejoin="round" />
      <text x="240" y="30" text-anchor="start" direction="rtl" font-size="14" font-weight="800" fill="hsl(var(--foreground))">سحابة Anthropic</text>
      <text x="240" y="50" text-anchor="start" direction="rtl" font-size="13" fill="hsl(var(--muted-foreground))">الافتراضي · حارس القاعدة الحديدية</text>
    </g>

    <!-- سحابة Antigravity -->
    <g transform="translate(340,550)">
      <rect x="0" y="0" width="262" height="70" rx="14" fill="hsl(202 85% 55% / 0.06)" stroke="hsl(202 60% 52% / 0.7)" stroke-width="1.5" stroke-dasharray="5 4" />
      <path d="M18,50 a12,12 0 0 1 2,-23 a14,14 0 0 1 26,3 a10,10 0 0 1 -2,20 Z" fill="hsl(202 85% 55% / 0.10)" stroke="hsl(202 65% 52%)" stroke-width="1.5" stroke-linejoin="round" />
      <text x="246" y="30" text-anchor="start" direction="rtl" font-size="14" font-weight="700" fill="hsl(var(--foreground))">سحابة Antigravity</text>
      <text x="246" y="50" text-anchor="start" direction="rtl" font-size="13" fill="hsl(var(--muted-foreground))">عبر agy · عند التفعيل الصريح</text>
    </g>

    <!-- سحابة Nous -->
    <g transform="translate(18,550)">
      <rect x="0" y="0" width="298" height="70" rx="14" fill="hsl(202 85% 55% / 0.06)" stroke="hsl(202 60% 52% / 0.7)" stroke-width="1.5" stroke-dasharray="5 4" />
      <path d="M18,50 a12,12 0 0 1 2,-23 a14,14 0 0 1 26,3 a10,10 0 0 1 -2,20 Z" fill="hsl(202 85% 55% / 0.10)" stroke="hsl(202 65% 52%)" stroke-width="1.5" stroke-linejoin="round" />
      <text x="282" y="30" text-anchor="start" direction="rtl" font-size="14" font-weight="700" fill="hsl(var(--foreground))">سحابة Nous</text>
      <text x="282" y="50" text-anchor="start" direction="rtl" font-size="13" fill="hsl(var(--muted-foreground))">عبر Hermes · عند التفعيل الصريح</text>
    </g>
  </g>

  <!-- ═══ الوصلات ═══ -->
  <!-- متصفح → نفق (ممتلئ) -->
  <path d="M785,116 L771,270" fill="none" stroke="hsl(var(--muted-foreground))" stroke-width="2" marker-end="url(#ov1-arrow-solid)" />
  <!-- طرفية → منسّق (منقّط مباشر) -->
  <path d="M568,116 C560,180 520,222 500,274" fill="none" stroke="hsl(var(--ring))" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#ov1-arrow-dash)" />
  <!-- agy → منسّق (منقّط) -->
  <path d="M346,116 C366,180 430,228 455,274" fill="none" stroke="hsl(var(--ring))" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#ov1-arrow-dash)" />
  <!-- Hermes → منسّق (منقّط) -->
  <path d="M120,116 C150,190 320,240 360,290" fill="none" stroke="hsl(var(--ring))" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#ov1-arrow-dash)" />
  <text x="470" y="176" text-anchor="middle" font-size="13" font-weight="600" fill="hsl(var(--ring))">بلا نفق · اتصال مباشر</text>

  <!-- نفق → كود (محلي ممتلئ) -->
  <path d="M771,336 L771,352" fill="none" stroke="hsl(145 55% 42%)" stroke-width="2" marker-end="url(#ov1-arrow-local)" />
  <!-- كود → منسّق (محلي ممتلئ) -->
  <path d="M660,384 L604,326" fill="none" stroke="hsl(145 55% 42%)" stroke-width="2" marker-end="url(#ov1-arrow-local)" />
  <!-- منسّق → وكيل (محلي ممتلئ، يفوّض) -->
  <path d="M338,312 L284,312" fill="none" stroke="hsl(145 55% 42%)" stroke-width="2.4" marker-end="url(#ov1-arrow-local)" />
  <text x="311" y="366" text-anchor="middle" font-size="13" font-weight="700" fill="var(--wiki-diagram-ok)">يفوّض فوراً · لا ينفّذ بنفسه</text>

  <!-- منسّق → Anthropic (ممتلئ سحابي، استدلال) -->
  <path d="M560,350 C640,430 710,486 754,550" fill="none" stroke="hsl(202 80% 52%)" stroke-width="2.4" marker-end="url(#ov1-arrow-solid)" />
  <text x="712" y="460" text-anchor="middle" font-size="13" font-weight="700" fill="var(--wiki-diagram-info)">استدلال النموذج</text>
  <!-- منسّق → Antigravity (منقّط سحابي) -->
  <path d="M468,350 C470,430 470,486 466,550" fill="none" stroke="hsl(202 60% 52%)" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#ov1-arrow-solid)" />
  <!-- منسّق → Nous (منقّط سحابي) -->
  <path d="M386,350 C300,430 220,486 178,550" fill="none" stroke="hsl(202 60% 52%)" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#ov1-arrow-solid)" />
  <text x="250" y="460" text-anchor="middle" font-size="13" font-weight="600" fill="var(--wiki-diagram-info)">عند التفعيل الصريح · مرونة المورّد</text>

  <!-- مفتاح الخطوط (أسفل طبقة السحابة، خارج حدّها) -->
  <g transform="translate(18,662)">
    <line x1="0" y1="0" x2="26" y2="0" stroke="hsl(var(--muted-foreground))" stroke-width="2" />
    <text x="32" y="4" font-size="13" fill="hsl(var(--muted-foreground))">مسار دائم</text>
    <line x1="150" y1="0" x2="176" y2="0" stroke="hsl(var(--ring))" stroke-width="2" stroke-dasharray="5 4" />
    <text x="182" y="4" font-size="13" fill="hsl(var(--muted-foreground))">مباشر / عند التفعيل</text>
  </g>

  </g>
</svg>

**كيف تقرأ هذا المخطط:**

| الطبقة | المعنى |
|---|---|
| **كيف تصل؟** | أربع طرق: متصفح إلى الموقع، طرفية Claude Code مباشرة، عميل agy، أو عميل Hermes (تكامل جزئي حالياً) |
| **الخادم — محلي** | نسّاج ديف (الكود الفعلي، fork من claudecodeui) يعمل على الخادم الرئيسي، ويُخدَّم عادةً خلف وكيل عكسي أو نفق (Cloudflare Tunnel مثلاً) من عنوان مؤسستك إلى المنفذ المحلي. هنا المنسّق يستقبل طلبك ويفوّضه فوراً لوكيل واحد متخصص — **تنسيق فقط، لا معالجة ذكاء اصطناعي محلياً** |
| **معالجة الذكاء الاصطناعي — سحابية دائماً** | الاستدلال الفعلي للنموذج (تفكير الوكيل) يحدث دوماً خارج هذا الخادم: على سحابة Anthropic افتراضياً، أو على سحابة مزوّد بديل (Antigravity، Nous) عند تفعيل صريح ضمن مبادرة مرونة المورّد. كل مستخدم باشتراكه/مفتاحه الخاص — لا اشتراك مشترك |

**الخلاصة بجملة واحدة:** نسّاج (التنسيق) عندنا، دائماً؛ والذكاء الاصطناعي (التفكير) بعيد، دائماً.

## خلاصة

نسّاج كور = نظام متكامل من:

| العنصر | الشرح |
|---|---|
| **القاعدة الصفرية** | المنسّق ينسّق، الوكيل ينفّذ (لا استثناء) |
| **فريق متخصص** | كل وكيل خبير في مجاله |
| **ذاكرة دائمة** | يتذكّر السياق والقرارات والسياسات |
| **حدود واضحة** | ميزانية ساعات وموارد معروفة |
| **قرارات منظّمة** | خطط معتمدة، اجتماعات رسمية، توثيق كامل |
| **بوابة بدء** | لا كود قبل خطة معتمدة |

---

## الخطوة التالية

- [رحلة المهمة من البداية للنهاية](31-task-journey.md) — كيف يترجَم هذا كله إلى عمل
- [كيف تكتب طلباً يفهمه نسّاج](12-good-request.md) — لتستفيد من التخصّص فعلاً
