# رحلة المهمة من البداية للنهاية

دعنا نتتبّع مهمة واحدة من اللحظة التي تكتب فيها طلبك إلى اللحظة التي ترى فيها النتيجة.

---

## مثال واقعي: طلب ميزة جديدة

**السيناريو:** أنت تريد صفحة جديدة لتقارير التحليلات.

## الخطوات الكاملة

<svg class="wiki-diagram" viewBox="0 0 960 760" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="رحلة المهمة الكاملة لطلب صفحة تقارير: تكتب الطلب، فيستقبله نسّاج ديف، ثم يفحص المنسّق الحصة والموارد فيتفرّع المسار: إن كانت الحصة كافية يستدعي ثلاثة وكلاء بالتوازي (ui-designer يصمم، backend-dev يبرمج، frontend-dev يربط) يرفعون الكود فتتحدّث اللوحة تلقائياً وترى المهام تتحرك، ثم ينهي الوكلاء فيحدّث المنسّق الحالة إلى مكتملة وترى الصفحة جاهزة؛ وإن كانت الحصة ناقصة يخبرك المنسّق بأنه مشغول الآن فانتظر.">
  <title>رحلة المهمة الكاملة — مثال صفحة تقارير مع تفرّع الحصة والتوازي بين الوكلاء</title>
  <desc>مخطط تدفّق رأسي يُقرأ من الأعلى للأسفل: كتابة الطلب، استقباله، فحص الحصة، ثم تفرّع بين حصة كافية (ثلاثة وكلاء بالتوازي ثم تحديث اللوحة والإنهاء) وحصة ناقصة (رسالة انتظار).</desc>
  <defs>
    <marker id="wf-tip" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
      <path d="M0,1 L9,5 L0,9 Z" fill="hsl(var(--muted-foreground))" />
    </marker>
    <marker id="wf-tip-ok" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
      <path d="M0,1 L9,5 L0,9 Z" fill="hsl(145 55% 42%)" />
    </marker>
    <marker id="wf-tip-warn" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
      <path d="M0,1 L9,5 L0,9 Z" fill="hsl(var(--destructive))" />
    </marker>
  </defs>

  <!-- كل المحتوى مُزاح 40 وحدة لضمان هامش داخلي على الحافتين (viewBox 0..960) -->
  <g transform="translate(40,0)">

  <!-- ─── 1. أنت تكتب الطلب ─── -->
  <g transform="translate(300,20)">
    <rect x="0" y="0" width="280" height="64" rx="14" fill="hsl(var(--card))" stroke="hsl(var(--border))" stroke-width="1.5" />
    <circle cx="34" cy="32" r="14" fill="hsl(var(--primary) / 0.12)" stroke="hsl(var(--primary))" stroke-width="1.6" />
    <g transform="translate(34,32)" stroke="hsl(var(--primary))" fill="none" stroke-width="1.6"><circle cx="0" cy="-3" r="4.5" /><path d="M-7,9 a7,7 0 0 1 14,0" stroke-linecap="round" /></g>
    <text x="258" y="28" text-anchor="start" font-size="15" font-weight="800" fill="hsl(var(--card-foreground))">أنت تكتب الطلب</text>
    <text x="258" y="49" text-anchor="start" font-size="13" fill="hsl(var(--muted-foreground))">«أريد صفحة تقارير»</text>
  </g>
  <path d="M440,84 L440,104" fill="none" stroke="hsl(var(--muted-foreground))" stroke-width="2" marker-end="url(#wf-tip)" />

  <!-- ─── 2. نسّاج ديف يستقبل ─── -->
  <g transform="translate(310,106)">
    <rect x="0" y="0" width="260" height="58" rx="14" fill="hsl(var(--card))" stroke="hsl(var(--border))" stroke-width="1.5" />
    <text x="238" y="26" text-anchor="start" font-size="14" font-weight="800" fill="hsl(var(--card-foreground))">نسّاج ديف يستقبل الطلب</text>
    <text x="238" y="45" text-anchor="start" font-size="13" fill="hsl(var(--muted-foreground))">ويمرّره للمنسّق</text>
  </g>
  <path d="M440,164 L440,184" fill="none" stroke="hsl(var(--muted-foreground))" stroke-width="2" marker-end="url(#wf-tip)" />

  <!-- ─── 3. المنسّق يفحص (معيّن) ─── -->
  <g transform="translate(320,186)">
    <path d="M120,0 L240,44 L120,88 L0,44 Z" fill="hsl(var(--primary))" stroke="hsl(var(--primary))" stroke-width="1.5" />
    <text x="120" y="40" text-anchor="middle" font-size="14.5" font-weight="800" fill="hsl(var(--primary-foreground))">المنسّق يفحص</text>
    <text x="120" y="60" text-anchor="middle" font-size="13" fill="hsl(var(--primary-foreground))">الحصة والموارد المتاحة؟</text>
  </g>

  <!-- تفرّع: يسار = كافية (أخضر) ، يمين = ناقصة (تحذير) -->
  <!-- فرع كافية -->
  <path d="M360,230 C250,260 235,270 235,300" fill="none" stroke="hsl(145 55% 42%)" stroke-width="2.2" marker-end="url(#wf-tip-ok)" />
  <g transform="translate(150,272)">
    <rect x="0" y="0" width="118" height="26" rx="13" fill="hsl(145 45% 42% / 0.14)" stroke="hsl(145 50% 42%)" stroke-width="1.3" />
    <text x="59" y="18" text-anchor="middle" font-size="13" font-weight="700" fill="var(--wiki-diagram-ok)">حصة كافية ✓</text>
  </g>
  <!-- فرع ناقصة -->
  <path d="M520,230 C650,260 690,270 690,300" fill="none" stroke="hsl(var(--destructive))" stroke-width="2.2" marker-end="url(#wf-tip-warn)" />
  <g transform="translate(628,272)">
    <rect x="0" y="0" width="124" height="26" rx="13" fill="hsl(var(--destructive) / 0.12)" stroke="hsl(var(--destructive))" stroke-width="1.3" />
    <text x="62" y="18" text-anchor="middle" font-size="13" font-weight="700" fill="var(--wiki-diagram-danger)">حصة ناقصة</text>
  </g>

  <!-- ─── فرع ناقصة: رسالة انتظار ─── -->
  <g transform="translate(560,304)">
    <rect x="0" y="0" width="270" height="62" rx="14" fill="hsl(var(--destructive) / 0.06)" stroke="hsl(var(--destructive) / 0.6)" stroke-width="1.5" />
    <circle cx="34" cy="31" r="13" fill="none" stroke="hsl(var(--destructive))" stroke-width="1.7" />
    <path d="M34,24 l0,7 l5,4" fill="none" stroke="hsl(var(--destructive))" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
    <text x="248" y="28" text-anchor="start" font-size="13.5" font-weight="800" fill="hsl(var(--foreground))">«مشغول الآن، انتظر»</text>
    <text x="248" y="47" text-anchor="start" font-size="13" fill="hsl(var(--muted-foreground))">حتى تتجدّد الحصة أو يفرغ وكيل</text>
  </g>

  <!-- ─── فرع كافية: الوكلاء الثلاثة بالتوازي ─── -->
  <g transform="translate(40,304)">
    <rect x="0" y="0" width="420" height="150" rx="16" fill="hsl(145 45% 42% / 0.06)" stroke="hsl(145 50% 42% / 0.55)" stroke-width="1.6" stroke-dasharray="6 4" />
    <text x="404" y="26" text-anchor="start" font-size="13" font-weight="700" fill="var(--wiki-diagram-ok)">ثلاثة وكلاء يعملون بالتوازي</text>

    <!-- ui-designer -->
    <g transform="translate(20,44)">
      <rect x="0" y="0" width="120" height="88" rx="12" fill="hsl(var(--card))" stroke="hsl(145 45% 42% / 0.5)" stroke-width="1.4" />
      <g transform="translate(60,26)" stroke="hsl(145 55% 42%)" fill="none" stroke-width="1.7">
        <rect x="-14" y="-11" width="28" height="22" rx="3" />
        <circle cx="-6" cy="-2" r="3" /><path d="M-12,9 l8,-7 l6,5 l4,-4 l6,6" stroke-linecap="round" stroke-linejoin="round" />
      </g>
      <text x="60" y="60" text-anchor="middle" font-size="13" font-weight="800" fill="hsl(var(--card-foreground))" direction="ltr">ui-designer</text>
      <text x="60" y="78" text-anchor="middle" font-size="13" fill="hsl(var(--muted-foreground))">يصمم</text>
    </g>
    <!-- backend-dev -->
    <g transform="translate(150,44)">
      <rect x="0" y="0" width="120" height="88" rx="12" fill="hsl(var(--card))" stroke="hsl(145 45% 42% / 0.5)" stroke-width="1.4" />
      <g transform="translate(60,26)" stroke="hsl(145 55% 42%)" fill="none" stroke-width="1.7">
        <ellipse cx="0" cy="-8" rx="14" ry="5" /><path d="M-14,-8 l0,16 a14,5 0 0 0 28,0 l0,-16" />
        <path d="M-14,0 a14,5 0 0 0 28,0" />
      </g>
      <text x="60" y="60" text-anchor="middle" font-size="13" font-weight="800" fill="hsl(var(--card-foreground))" direction="ltr">backend-dev</text>
      <text x="60" y="78" text-anchor="middle" font-size="13" fill="hsl(var(--muted-foreground))">يبرمج</text>
    </g>
    <!-- frontend-dev -->
    <g transform="translate(280,44)">
      <rect x="0" y="0" width="120" height="88" rx="12" fill="hsl(var(--card))" stroke="hsl(145 45% 42% / 0.5)" stroke-width="1.4" />
      <g transform="translate(60,26)" stroke="hsl(145 55% 42%)" fill="none" stroke-width="1.7">
        <path d="M-6,-11 l-11,11 l11,11" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M6,-11 l11,11 l-11,11" stroke-linecap="round" stroke-linejoin="round" />
      </g>
      <text x="60" y="60" text-anchor="middle" font-size="13" font-weight="800" fill="hsl(var(--card-foreground))" direction="ltr">frontend-dev</text>
      <text x="60" y="78" text-anchor="middle" font-size="13" fill="hsl(var(--muted-foreground))">يربط</text>
    </g>
  </g>
  <path d="M250,454 L250,478" fill="none" stroke="hsl(145 55% 42%)" stroke-width="2" marker-end="url(#wf-tip-ok)" />
  <text x="360" y="470" text-anchor="middle" font-size="13" fill="hsl(var(--muted-foreground))">يرفعون الكود والتغييرات</text>

  <!-- ─── اللوحة تتحدّث تلقائياً ─── -->
  <g transform="translate(90,480)">
    <rect x="0" y="0" width="320" height="72" rx="14" fill="hsl(var(--ring) / 0.10)" stroke="hsl(var(--ring))" stroke-width="1.6" />
    <g transform="translate(30,36)" stroke="hsl(var(--ring))" fill="none" stroke-width="1.7">
      <rect x="-15" y="-15" width="30" height="30" rx="4" />
      <line x1="-15" y1="-5" x2="15" y2="-5" /><line x1="-3" y1="-5" x2="-3" y2="15" />
    </g>
    <text x="296" y="30" text-anchor="start" font-size="14" font-weight="800" fill="hsl(var(--foreground))">لوحة المشروع تتحدّث تلقائياً</text>
    <text x="296" y="52" text-anchor="start" font-size="13" fill="hsl(var(--muted-foreground))">وأنت ترى المهام تتحرّك لحظياً</text>
  </g>
  <path d="M250,552 L250,576" fill="none" stroke="hsl(145 55% 42%)" stroke-width="2" marker-end="url(#wf-tip-ok)" />

  <!-- ─── المنسّق يحدّث الحالة (مكتملة) ─── -->
  <g transform="translate(90,578)">
    <rect x="0" y="0" width="320" height="64" rx="14" fill="hsl(var(--primary) / 0.08)" stroke="hsl(var(--primary))" stroke-width="1.5" />
    <g transform="translate(30,32)" stroke="hsl(var(--primary))" fill="none" stroke-width="1.7"><circle cx="0" cy="0" r="8" /><g stroke-linecap="round"><line x1="0" y1="-13" x2="0" y2="-11"/><line x1="0" y1="11" x2="0" y2="13"/><line x1="-13" y1="0" x2="-11" y2="0"/><line x1="11" y1="0" x2="13" y2="0"/></g></g>
    <text x="296" y="28" text-anchor="start" font-size="14" font-weight="800" fill="hsl(var(--foreground))">المنسّق يحدّث الحالة</text>
    <text x="296" y="48" text-anchor="start" font-size="13" fill="var(--wiki-diagram-ok)">مكتملة ✓ — بعد اجتياز فحص الجودة</text>
  </g>
  <path d="M250,642 L250,666" fill="none" stroke="hsl(145 55% 42%)" stroke-width="2" marker-end="url(#wf-tip-ok)" />

  <!-- ─── النتيجة: الصفحة جاهزة ─── -->
  <g transform="translate(110,668)">
    <rect x="0" y="0" width="280" height="72" rx="16" fill="hsl(var(--ring) / 0.14)" stroke="hsl(var(--ring))" stroke-width="1.8" />
    <circle cx="36" cy="36" r="16" fill="hsl(var(--ring))" />
    <path d="M29,36 l5,5 l9,-11" fill="none" stroke="hsl(0 0% 100%)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
    <text x="256" y="32" text-anchor="start" font-size="15" font-weight="800" fill="hsl(var(--foreground))">ترى الصفحة جاهزة</text>
    <text x="256" y="54" text-anchor="start" font-size="13" fill="hsl(var(--muted-foreground))">حيّة على موقعك</text>
  </g>

  </g>
</svg>

## شرح مرحلة بمرحلة

### 1. تكتب طلبك (دقيقة واحدة)

```
أنت: أريد صفحة تقارير تفصيلية تُظهر:
  - عدد المستخدمين الجدد هذا الأسبوع
  - الإيرادات اليومية
  - أكثر الميزات استخداماً
  أريدها بتصميم جميل ويمكن تصديرها PDF
```

**النقاط المهمة:**
- كن واضحاً في طلبك
- اذكر كل المتطلبات (ليس فقط الميزة، بل التفاصيل)
- لا تقل "افعل ما تراه صحيحاً" — قل بالضبط ماذا تريد

### 2. المنسّق يفحص الحصة (ثوان)

المنسّق يسأل نفسه:
- هل عندي وكلاء متاحين؟
- هل عندي ساعات عمل متبقية اليوم؟
- هل الموارد كافية (خادم، ذاكرة، إلخ)؟

**الحالات الثلاث:**
1. **كل شيء متاح:** يستدعي الوكلاء فوراً
2. **وكلاء مشغولون:** يضع الطلب في الصف وينتظر
3. **حصة انتهت:** يقول لك "انتظر حتى تجدّد الحصة" (ساعات العمل الأسبوعية انتهت)

### 3. المنسّق يستدعي الوكلاء المختصين (دقيقة)

لطلب التقارير، يستدعي ثلاثة:

| الوكيل | الدور | المهمة |
|---|---|---|
| **ui-designer** | المصمم | يرسم الصفحة: أين الأزرار، الرسوم البيانية، الألوان |
| **backend-dev** | مبرمج الخادم | يبرمج واجهات برمجة التطبيقات (`APIs`): جلب البيانات من قاعدة البيانات |
| **frontend-dev** | مبرمج الواجهة | يربط التصميم مع البيانات، يصنع الأزرار |

يقول المنسّق لكل وكيل: «هذا طلبك، وفيه السياق والشرح الشامل ومواعيد التسليم».

### 4. الوكلاء ينفّذون (ساعات)

- **ui-designer:** يكتب Design Brief ومواصفات التصميم نصياً (ألوان، تخطيط، مكوّنات)، ينتهي بعد ساعة
- **backend-dev:** يكتب واجهات برمجة التطبيقات، وينتهي بعد ساعتين
- **frontend-dev:** ينتظر حتى ينتهي backend-dev، ثم يربط الكود، ينتهي بعد ساعة

يختبر كل وكيل عمله. وإذا وجد خطأً أصلحه من دون انتظار.

### 5. التحديثات تظهر على اللوحة

لوحة المشروع **تنتعش حياً**:
- `backend-dev ينهي` → المهمة تتحول لأخضر (مكتملة)
- `frontend-dev ينهي` → الصفحة الكاملة تُعتبر جاهزة

**أنت ترى كل هذا وأنت تشرب قهوتك.** لا تحتاج لسؤال "كم اشتغلتوا؟" — اللوحة تخبّرك.

### 6. الاختبار والمراجعة (دقائق)

قبل أن يقول المنسّق "انتهينا"، **qa-critic** (مختبر الجودة) يقول:
- هل الكود نظيف؟
- هل يُعمل على جميع الأجهزة؟
- هل هو آمن (لا توجد ثغرات أمنية)؟
- هل سريع؟

إذا كان كل شيء سليماً وافق، وإذا وجد مشكلةً طلب إصلاحها.

### 7. المنسّق يحدّث لوحة المشروع

عندما كل شيء جاهز:
- **الحالة:** من "قيد الإنجاز" إلى "مكتملة ✓"
- **التاريخ:** متى انتهينا بالضبط
- **ملاحظة:** ما الذي تم بالضبط

هذا يُوثّق كل شيء للمستقبل.

### 8. النتيجة النهائية

الآن **الصفحة حية** على الموقع:
- تفتح موقعك
- تضغط على "التقارير"
- ترى البيانات والرسوم البيانية جميلة

والمهمة انتهت.

## كم من الوقت؟

- **طلب بسيط** (تصحيح نص، إضافة زر): 1 ساعة
- **ميزة متوسطة** (صفحة جديدة): 3-5 ساعات
- **ميزة كبيرة** (نظام جديد كامل): أيام أو أسابيع

## ماذا تكتب في طلبك؟

صياغة الطلب هي أكبر ما يؤثّر في جودة النتيجة، ولها صفحة كاملة:
**[كيف تكتب طلباً يفهمه نسّاج](12-good-request.md)**.

## خلاصة

رحلة المهمة الكاملة:
1. **أنت تكتب** طلباً واضحاً
2. **المنسّق يفحص** الحصة والموارد
3. **الوكلاء ينفّذون** (كل وكيل ضمن تخصصه)
4. **qa-critic يختبر** (جودة عالية)
5. **اللوحة تتحدّث** (أنت ترى التقدم)
6. **المنسّق يحدّث** الملفات
7. **النتيجة** تظهر على الموقع
8. **توثيق** يبقى للمستقبل

## سيناريوهات شائعة (ليس التدفّق الخطي دائماً)

الخطوات أعلاه هي **الطريق السعيد**. لكن الواقع أكثر تنوعاً. إليك 4 سيناريوهات عملية:

### السيناريو 1: وجدت خطأ بالموقع — أصلحه بسرعة

```
أنت: يا نسّاج، الزر لا يعمل على الجوال.
[لقطة الشاشة]

المنسّق: يوجد خطأ في CSS. سأستدعي frontend-dev.

frontend-dev: اكتشفت المشكلة. أحتاج إلى خمس دقائق فقط.
[بعد 5 دقائق]
frontend-dev: انتهيت! جرّب تدوير الشاشة.

أنت: رائع! يعمل الآن.
```

**المفتاح:** خطأ = priority عالية، الحل سريع.

---

### السيناريو 2: أريد معرفة حالة مشروع لم أفتحه شهر

```
أنت: كيفك المشروع المتجر؟ شنو آخر تطور؟

المنسّق: [يشوف لوحة المتجر]
اللوحة تقول:
- المرحلة الأولى: ✅ انتهت
- المرحلة الثانية: 🔵 جاري 80%
- المرحلة الثالثة: ⏸️ عالقة (انتظار اجتماع)

المنسّق: يسير المشروع كما ينبغي. حالته الحية ظاهرة في الأعلى.

أنت: ألا أحتاج إلى السؤال في كل مرة؟

المنسّق: بالضبط! انظر إلى اللوحة مباشرة؛ فهي حيّة على مدار الساعة.
```

**المفتاح:** اللوحة = تقرير لحظي، بلا اجتماعات.

---

### السيناريو 3: انتهى الوكيل، لكن النتيجة لم تُرضِني

```
أنت: برمجت الميزة كما طلبت، لكنها تفتقر إلى الأثر البصري.
     أردت أزرار أكثر براقة.

المنسّق: حسناً، كانت النتيجة مبنية على اجتهاد الوكيل.
         أستدعي ui-designer يحسّن التصميم.

ui-designer: [بعد ساعة]
شفت التصميم. سأضيف gradient و shadow.
انتهيت!

أنت: أفضل! الآن شكل احترافي.

المنسّق: حسناً. اللوحة تقول: مهمة مُعاد تصميمها ✅
```

**المفتاح:** رد: لا = ثانية دورة + تحسين سريع.

---

### السيناريو 4: أريد إيقاف/تعديل مهمة بعد بدء العمل

```
أنت: طلبت ميزة البحث المتقدم، بس اكتشفت العملاء
     ما محتاجينها. نسيانها.

المنسّق: حسناً، طلبت من الوكيل التوقّف. وهو يغلق الملفات
         ويرجع للمهمة السابقة.

frontend-dev: حسناً، أوقفت المهمة. بقيت أربع ساعات،
             وسأستخدمها في مهمة أخرى.

المنسّق: [يحدّث اللوحة]
         مهمة ملغاة، وكيل متاح للمهمة الجديدة.
```

**المفتاح:** لا تُضيع وقت — ألغِ وحوّل الموارد.

---

### السيناريو 5: اجتماع مهم يتطلب تسريع مهمة معينة

```
المدير: بكرة عندي اجتماع عميل، احتاج status تقرير الإيرادات.
        الوقت الآن ساعة واحدة بعد الظهر.

المنسّق: بحسب اللوحة، التقرير 50% انتهى.
         بطلب من backend-dev يركز عليها الآن (priority أعلى).

backend-dev: أوك، بترك كل شيء، بشتغل على التقرير مباشرة.
             [بعد ساعتين]
             خلصت. البيانات جاهزة.

frontend-dev: [بسرعة القطار]
              ربطت الواجهة. وكل شيء يعمل.

المدير: [قبل الاجتماع ب 30 دقيقة]
        حفظت التقرير بصيغة PDF. شكراً!
```

**المفتاح:** أولويات ديناميكية تتغيّر بسرعة وفقاً للطوارئ.

---

## الفرق بين الخطط

| الخطة | الوقت | الحالات | مثال |
|---|---|---|---|
| **التدفّق الطبيعي** | ساعات/أيام | ميزة عادية | صفحة جديدة |
| **إيقاف وتعديل** | دقائق | اكتشاف خطأ/إلغاء | اكتشفنا أننا لا نحتاج إليها |
| **تسريع** | ساعات | اجتماع طارئ | عميل يطلب تقريراً |
| **إعادة الرد** | ساعات | نتيجة غير مُرضية | التصميم غير جذّاب |
| **ثانية دورة** | أيام | تحسين كبير | نريد نسخة أفضل |

---

## الخطوة التالية

- [لوحة المشروع](23-project-board.md) — أين تظهر نتائج هذه الرحلة
