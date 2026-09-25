## 2.3.0.6 — 2026-09-25

استعادة محرّك نموذج Codex المجمَّد، حوكمة مشاريع وأجهزة محافظ، وقياس تكاليف متقدم.
Engine model recovery for frozen Codex, project governance and device wallets, advanced cost telemetry.

## 2.3.0.4 — 2026-09-24

تحسين حالات المزوّد وخيار عرض استهلاك العتاد والصور والقوائم.
Improve provider status localization, optional hardware usage, images and menus.

# التحديثات

هنا تجد ملخصاً عملياً لأحدث إصدارات نسّاج: ما الجديد، وما الذي ستلاحظه عند الاستخدام. أما التفاصيل التقنية الكاملة فتوجد في سجل التغييرات داخل المشروع.

---

## الإصدار 2.3.0.6 — محفظة الجهاز وحدود المشروع واستعادة نموذج الجلسة

مرشح بتاريخ 2026-09-25 لاحق للإصدار المنشور `2.3.0.5`.

ما الذي يتغير عند نشره:

- تعود محفظة الحسابات الجهازية: تُحفظ بيانات دخولك بهويتك الفريدة عبر الجلسات.
- المشاريع تحصل على حدود عضوية: من يدخل أي مشروع يُحدّد دوره ورؤيته.
- استعادة نموذج الجلسة: عند إعادة الإقلاع، يُسترجع النموذج النشط لكل جلسة من
  ذاكرة الحالة السابقة.
- تحديثات الموصلات والأداة موحّدة: مسار واحد آمن لتحديث نسخ النماذج المستخدمة.
- قياس التكاليف المتقدم: نظام جديد غير فعّال بانتظار التفعيل الموضعي.
- إصلاحات الفحوص: مقارنة أرقام الإصدارات تعمل بأمان مع الصيغ المختلفة.

### English

Candidate dated 2026-09-25, following published `2.3.0.5`.

What changes when published:

- Device account wallets return: your login is saved with your unique identity
  across sessions.
- Projects gain membership boundaries: anyone entering a project has their role
  and visibility set.
- Session model recovery: on restart, the active model for each session is
  restored from prior state.
- Unified connector and harness updates: one secure path to update active model
  versions.
- Advanced cost tracking: new system added but dormant, pending local activation.
- Version check fixes: release numbers now safely compare with different formats.

## الإصدار 2.3.0.3 — حد أوضح للحوكمة ومنشأ إصدار قابل للتحقق

مرشح بتاريخ 2026-09-24 لاحق للإصدار المنشور `2.3.0.2`. ما زال بانتظار مراجعة
QA المستقلة النهائية، ولم يُنشر أو يُفعّل على خادم.

ما الذي يتغير عند نشره:

- تفصل معمارية المنتج ومسارات الكتابة بين مستودع المنتج والحوكمة الحية.
- تقرأ اللوحة من كتالوج نظام ثابت وتفشل مغلقة عند غيابه أو فساده، بلا fallback.
- تبقى تعليمات مشروع Codex مفعلة من دون جذور كتابة خارج مساحة العمل.
- يصبح التصدير العام قابلاً للتحقق والاستئناف مع تثبيت النسب والبصمات.
- تستخدم أسرار النماذج المحلية دوالاً مخصصة لا تصل إلى بيانات اعتماد الموصلات.

مقارن ADR-169 غير نشط، ولا ينشر المرشح كتالوج الحوكمة أو لقطتها ولا يفعّل
خادماً.

[ملاحظات الإصدار الكاملة / Full release notes](../releases/2.3.0.3.md)

### English

Candidate dated 2026-09-24 following published `2.3.0.2`. It remains pending
final independent QA and has not been published or activated on a server.

Once published, it separates product files from live governance writes, reads
the board through a fail-closed immutable catalog, keeps Codex project
instructions enabled without external writable roots, hardens resumable public
export provenance, and narrows local-model access to its own secret namespace.
The ADR-169 comparator remains inactive, and the candidate does not publish a
governance catalog/snapshot or activate a server.

## الإصدار 2.3.0.2 — إصدار قابل للاستئناف، ومحادثة ونماذج محلية أكثر ثباتاً

إصدار منشور بتاريخ 2026-09-24 لاحق للإصدار `2.3.0.1`.

ما الذي تغير في الإصدار:

- تحديث المحادثة والانتقال إلى آخرها صار أكثر اتساقاً.
- تستعاد ردود OpenCode الحية التي انقطعت، ويظهر خطأ المزوّد المحدد بدلاً من
  رسالة عامة.
- سجل المحادثة يتحمل إنشاء الجلسة المتأخر وفجوات العرض في الأدوار الطويلة.
- رفض مفتاح نموذج محلي لا يسجّلك خروجاً، وتظهر أخطاء المصادقة `422` بوضوح أكبر.
- توثيق SSO ومسارات OIDC/PKCE وZitadel يشير إلى المرجع المعتمد.
- أصبح تنفيذ الإصدار نفسه قابلاً للاستئناف بعد فشل آمن، مع حارس لتصدير المحتوى
  العام (T-1832).

[ملاحظات الإصدار الكاملة / Full release notes](../releases/2.3.0.2.md)

### English

Published release dated 2026-09-24, following `2.3.0.1`.

What changed in the release:

- Chat refresh and moving to the newest message are more consistent.
- Dropped OpenCode live replies are recovered, and provider-specific errors are
  shown instead of generic failures.
- Chat history tolerates late session creation and display gaps during long turns.
- A rejected local-model key no longer signs you out, and `422` authentication
  errors are clearer.
- SSO documentation and the OIDC/PKCE and Zitadel paths point to the approved
  canonical reference.
- The release process itself can safely resume after failure and guards public
  content export (T-1832).

---

## الإصدار 2.3.0.1 — إصلاح ربط Claude والتثبيت الجديد، وأساس دخول موحّد

إصدار 2026-09-22 لاحق لإصدار 2.3.0.0 المنشور، يرفع مقطع البناء وحده. يجمع إصلاحين
تلمسهما مباشرةً، وأساس دخول موحّد معطَّل افتراضياً.

ما الذي ستلاحظه:

- ربط حساب Claude صار تسجيل دخول كاملاً افتراضياً، فيقرأ الحصة ولا يتوقّف لاحقاً.
  وإن كان ربطك جزئياً أو فارغاً فسترى الآن تنبيهاً صريحاً: «الربط غير مكتمل — أعد
  الربط» مع زرّ لإعادة الربط، بدل ربط صامت قد يتعطّل دون إشعار.

- التثبيت الجديد على عقدة صار يختم أرشيف النسخة المخدومة فلا يبقى ناقصاً، مع فحوص
  تمهيدية إضافية قبل التحديث.

- منتقي النماذج صار يعرض النماذج المتاحة فعلاً فقط ولا يقدّم كتالوجاً قديماً بعد
  تغيّر الحالة، مع حفظ الاسم المستعار الذي اخترته عند التقاط السياق.

- منبثقة استهلاك السياق صارت أصغر وأهدأ بصرياً، وانتقلت إدارة النماذج المحلية إلى
  شبكة عدّة الوكلاء في الإعدادات لتناسق أوضح.

- أساس دخول موحّد (SSO) دخل الكود لكنه **معطَّل افتراضياً**: لا يتغيّر شيء في شاشة
  الدخول ما لم يُفعِّله المشغّل بإعداد صريح؛ وحتى حينها يبقى محكوماً بحارس
  فاشل-الإغلاق. تفعيله قرار منفصل لكل عقدة.

### English

Release dated 2026-09-22, following the published 2.3.0.0 and advancing the build
segment only. It bundles two directly visible fixes plus a single-sign-on
groundwork that is disabled by default.

What you will notice:

- The Claude account link is now a full sign-in by default, so it reads usage and
  does not silently stop working. If your link is partial or empty, you now see
  an explicit "your link is incomplete — re-link" notice with a re-link button,
  instead of a silent link that could fail without warning.

- A fresh install on a node now seals the served archive so it is not left
  incomplete, with extra preflight checks before an update.

- The model picker now shows only the actually available models and no longer
  serves a stale catalog after state changes, and it preserves the alias you
  chose when the context is captured.

- The context-usage popover is now smaller and visually quieter, and local-models
  management has moved into the agents harness grid in Settings for clearer
  consistency.

- Single-sign-on (SSO) groundwork has landed but is **disabled by default**:
  nothing changes on the login screen unless an operator enables it with explicit
  configuration, and even then it stays behind a fail-closed guard. Enabling it
  is a separate per-node decision.

---

## الإصدار 2.3.0.0 — خوادم النماذج المحلية، ومسار تحديث أمتن

إصدار 2026-09-21 لاحق لإصدار 2.2.0.0 المنشور، ويضمّ أيضاً تغييرات دورة 2.2.0.1
المحلية التي لم تُنشَر سابقاً. الرقم `2.3.0.0`: إدارة خوادم النماذج المحلية ميزة
جديدة، فارتفع مقطع الميزة من `2` إلى `3` وأُعيد مقطعا الإصلاح والبناء إلى الصفر؛
ولا تغيير معماري جديد بعد 2.0.0.0 فبقي مقطع المعمارية `2`.

ما الذي ستلاحظه:

- خوادم النماذج المحلية: صار بإمكانك إضافة خادم نموذج محلي (مثل Ollama) من
  الإعدادات واستعماله مزوّداً داخل نسّاج. كل خادم محصور بمالكه، ومصادر طلباته
  مقيّدة بحارس صريح فلا يصل إليه غير أصله المعتمد.

- مسار التحديث داخل التطبيق صار أمتن: نسّاج يعتمد الآن نقلاً مثبّتاً لعفريت PM2
  واحد تحت إدارة النظام، مع حارس ملكية للمُشرف وعقد مصالحة يمنع ازدواج العفريت.
  أُضيفت مرشّحات استعادة محلية وتراجع يدوي محدود، وانتقال محكوم للتحديث دون
  اتصال، ويُتحقَّق من أهلية أي بناء محفوظ قبل قبوله. المحصّلة: تحديثات أهدأ
  وأقدر على التعافي دون تدخّل يدوي.

- تحسينات واجهة صغيرة: شريحة حصة الدورة لم تعد ترتجف أثناء تحميل نوافذ المزوّد،
  وتظهر شارة خطأ واضحة بدل شريحة قديمة حين يتعذّر قراءة الحصة؛ خفّ تشبّع لون
  الشريط الجانبي في الوضع الفاتح لسمة AlKindy؛ في المحادثة لم تعد شارة الاختصار
  تعترض النقر على حقل «غير ذلك» وصار الحقل يتلقّى التركيز فوراً فلا تضيع أوّل
  الضغطات؛ وإشعار `/btw` صار يتخطّى الدورة الفارغة فيظهر الجواب الحقيقي.

- صيانة التشغيل: سكربت مصالحة يضمن عفريت PM2 واحداً ويحصد التطبيقات اليتيمة بحسب
  المنفذ، وتصليب لبوابة التصدير العام.

### English

Release dated 2026-09-21, following the published 2.2.0.0 and folding in the
local 2.2.0.1 cycle. `2.3.0.0`: local model-server management is a new feature,
so the feature segment advances from `2` to `3` and the fix and build segments
reset; no new architectural change lands after 2.0.0.0, so architecture stays
`2`.

What you will notice:

- Local model servers: add a local model server (for example Ollama) from
  Settings and use it as a provider inside Nassaj. Each server is scoped to its
  owner, and its request origins are bound by an explicit guard.

- A hardened in-app update path: Nassaj now uses a pinned single PM2 daemon
  under the system manager, with a supervisor ownership guard and a
  reconciliation contract that prevents a duplicate daemon. Local recovery
  candidates, bounded manual rollback, a governed offline update transition, and
  qualification of any retained build before admission make updates quieter and
  more able to recover without manual intervention.

- Small UI improvements: the cycle-quota chip no longer flickers while provider
  windows load and shows a clear error badge instead of a stale chip when the
  quota read fails; the AlKindy light-mode sidebar tint is softened; in chat the
  shortcut badge no longer intercepts clicks on the "Other" input and the input
  focuses immediately so early keystrokes are not lost; and the `/btw`
  notification skips the empty cycle so the real answer is shown.

- Operations maintenance: a reconcile script enforces a single PM2 daemon and
  reaps orphaned apps by port, plus public-export gate hardening.

## الإصدار 2.2.0.1 — دورة تطوير محلية بعد 2.2.0.0

دورة تطوير محلية لاحقة لإصدار 2.2.0.0 المنشور، مؤرخة في 2026-09-19. لم تُضف
إليها تغييرات بعد، ولا تعني بناءً أو وسماً أو نشراً أو تفعيل عقدة.

### English

Local development cycle after the published 2.2.0.0 release, dated 2026-09-19.
No changes have landed yet; it does not claim a build, tag, publication, or node
activation.

## الإصدار 2.2.0.0 — نشر الصفحات العامة من الوكيل مباشرة، وإصلاحات أمان في الاعتمادات

إصدار 2026-09-19 لاحق لإصدار 2.1.0.0 المنشور، ويضمّ أيضاً تغييرات دورة
2.1.0.1 المحلية التي لم تُنشَر سابقاً. الرقم `2.2.0.0`: توجيه كل وكيل عند
الإطلاق إلى ناشر الصفحات العامة ميزة جديدة، فارتفع مقطع الميزة وأُعيد مقطعا
الإصلاح والبناء إلى الصفر.

ما الذي ستلاحظه:

- عند طلب صفحة هبوط أو موقع عام من أي وكيل، صار نسّاج يوجّهه من كود الإطلاق —
  لكل مزوّد — إلى النشر عبر ناشر الصفحات العامة في مخزن محتوى خارج شجرة تثبيت
  نسّاج، ويعيد له رابطاً جاهزاً على أصل العقدة العام (`https://<عقدة>/<site-id>/`)
  متى كان `NASSAJ_PUBLIC_ORIGIN` مضبوطاً؛ على عقدة بلا هذا المتغيّر يحصل الوكيل
  على المسار وحده بلا مضيف. وعند كلود تحديداً، محاولة كتابة ملف مباشرة داخل
  `dist/` أو `dist-server/` التابعين لنسّاج تُرفض، وجواب الرفض هو الأمر الصحيح
  الجاهز للتنفيذ.
  سبب الميزة: صفحة زُرعت يدوياً داخل `dist/` كسرت تحديث العقدة برسالة مبهمة
  `client_asset_manifest_changed`، وكانت ستُمحى عند أول تبديل جيل عميل. مربّع
  حوار التحديث صار يسرد عند هذا الخطأ أسماء الملفات الدخيلة والناقصة والمتغيّرة
  بدقّة. معرّفات المواقع المحجوزة تُرفض وقت النشر، والناشر يُشحن ضمن حزمة
  تحديث العقدة نفسها.
  حدود معروفة بصراحة: الصفحات تعيش على دومين العقدة نفسه تحت مسار، لا دعم
  لدومين مخصّص؛ والكتابة عبر أوامر الصدفة لا يعترضها هذا القفص — فحص المانيفست
  في مربّع حوار التحديث هو شبكة الأمان الخلفية، لا القفص نفسه.

- (من دورة 2.1.0.1) رفض بوّابة صيانة التحديث صار يظهر داخل لوح الطرفية كلافتة
  بسبب مصنَّف بدل لوح أسود صامت، ولكل رفض سطر تسجيل خادمي يسمّي سببه. انقطاع
  الطرفية صار يُميَّز برمز الإغلاق: الرفض القاطع نهائي، وأي انقطاع آخر (منها
  إعادة تشغيل الخادم) يعيد الارتباط. حقل لصق رمز كلود عاد ظاهراً للمالك، فصار
  بإمكانه إكمال الربط الذي يبدأه `claude setup-token` ولا يحفظ رمزه. رمز
  الاشتراك لا يُحدَّد افتراضاً لأي موضع، واختيار موضع يستدعي تحذيراً يسمّيه.
  ما **لم** يُعالَج: الطرفية السوداء نفسها على عقدة أخرى؛ تحسينات البوّابة
  تشخيصية في ذاتها ولا تُنسب إلى إصلاح ذلك العطل.

- إصلاحات أمان وُجدت في مراجعة ما قبل الإصدار:
  - حفظ أو حذف اعتماد مزوّد (كلود، Codex، OpenCode) صار يُطبَّق دائماً على شجرة
    العضو نفسه، حتى وهو حامل منحة اعتماد من عضو آخر؛ كان يمكن أن يقع في شجرة
    المانح (B-1251).
  - رمز اشتراك كلود الشخصي يُرفض خادمياً في كل موضع إلا فتحة كلود نفسها:
    OpenCode وCodex ومفاتيح المزوّدين ومفاتيح API الموصلات (B-1252).
  - الفشل العادي لم يعد يُبلَّغ كأن «صيانة التحديث فعّالة» في أي من أسطح
    الرفض الخمسة، مع بقاء كل رفض رافضاً كما هو، ونص خطأ الخادم صار يُعقَّم قبل
    وصوله إلى لوح الطرفية (B-1253).

  **تنبيه للمشغّل:** على أي عقدة استُعملت فيها منحة اعتماد قبل هذا الإصدار، قد
  يكون مفتاح العضو المُستفيد موجوداً فعلاً داخل `settings.json` أو `auth.json`
  الخاصّين بـ**المانح** نفسه، ولم يعد العضو المُستفيد يراه أو يقدر على حذفه من
  واجهته. على كل مانح مراجعة إعدادات مزوّديه بنفسه عن اعتماد ليس له وإزالته
  (B-1255).

- لوحة المشروع: نسبة المرحلة صارت تُحسب من مهامها فقط، والمرحلة بلا مهام
  تُشتقّ من حالتها (منتهية = 100، لم تبدأ = 0، قيد التنفيذ تُعرض «—» وتُستبعد)
  بدل إسقاطها من الحساب — فالأرقام الكلية على لوحات فيها مراحل كثيرة لم تبدأ
  بعد تنخفض إلى قيمتها الصادقة (T-1809، B-1249).

- المنسّق: حين يكون جذر مشروع الجلسة مجهولاً لا يُحقن شيء؛ متغيّر
  `NASSAJ_COORDINATOR_REPO_ROOT` لم يعد له أي أثر ويمكن حذفه من `.env`
  (T-1810، B-1250).

قيود معروفة مستمرّة: تجميع استيعاب الاستخدام قد يتوقف حتى إعادة التشغيل إن
تجاوز التحديث انتظار البوّابة أثناء تفعيل `USAGE_INGEST_BACKFILL=on` (B-1254).

### English

Release dated 2026-09-19, following published 2.1.0.0, and folding in the
local 2.1.0.1 cycle's changes, which were never released on their own.
`2.2.0.0`: guiding every agent at launch to the public-page publisher is a
new feature, so the feature segment advances and the fix and build segments
reset.

What you will notice:

- When any agent is asked for a landing page or public site, Nassaj now
  guides it — from launch-time code, for every provider — to publish through
  the public-page publisher into a content store outside the Nassaj
  installation tree, and hands back a ready link on the node's public origin
  (`https://<node>/<site-id>/`) when `NASSAJ_PUBLIC_ORIGIN` is configured; on
  a node without that variable the agent gets the path alone, without a host.
  For Claude specifically, a direct file write into Nassaj's own `dist/` or
  `dist-server/` is refused, and the refusal's answer is the correct,
  runnable command.
  Why the feature exists: a page planted by hand inside `dist/` broke that
  node's updates with an opaque `client_asset_manifest_changed`, and would have
  been erased by the next client generation swap. The update dialog now lists
  the exact unexpected, missing and changed files when that error occurs.
  Reserved site ids are rejected at publish time, and the publisher ships
  inside the node's own update bundle.
  Known limits, stated plainly: pages live on the node's own domain under a
  path, with no custom-domain support; writes through shell commands are not
  intercepted by this cage — the manifest check in the update dialog is the
  backstop, not the cage itself.

- (From the 2.1.0.1 cycle) An update-gate refusal now shows in the terminal
  pane as a banner with a classified reason instead of a silent black pane,
  and every refusal has a server-side log line naming its cause. A terminal
  drop is classified by its close code: an outright refusal is final, while
  any other drop — a server restart included — re-attaches. The Claude token
  paste field is visible to the owner again, so an owner can finish the link
  that `claude setup-token` starts but never stores. A subscription token is
  no longer preselected into any slot, and ticking one raises a warning that
  names it.
  What this **still does not** address: the black terminal itself on the
  operator node; the gate improvements above are diagnostic in their own
  right and are not credited with fixing that failure.

- Security fixes found in pre-release review:
  - Saving or deleting a provider credential (Claude, Codex, OpenCode) now
    always acts on the member's own account, even while holding a credential
    grant from another member; it could previously land in the grantor's
    tree (B-1251).
  - A personal Claude subscription token is now refused server-side
    everywhere except Claude's own slot: OpenCode, Codex, vendor keys, and
    connector API keys (B-1252).
  - An ordinary failure is no longer reported as "update maintenance is
    active" at any of the five refusal surfaces, while every refusal still
    refuses; server error text is now sanitized before it reaches the
    terminal pane (B-1253).

  **OPERATOR ACTION NOTE:** on any node where a credential grant was used
  before this release, the grantee's personal key may already sit in the
  **grantor's** own `settings.json` or `auth.json`, and the grantee can no
  longer see or delete it from their own UI. Grantors should check their own
  provider settings for a credential that is not theirs and remove it
  (B-1255).

- Project board: a phase's percentage now comes from its own tasks only, and
  a phase with no tasks is derived from its status (done = 100, not started
  = 0, in progress shown as "—" and excluded) instead of being dropped from
  the calculation — overall numbers on boards with many not-yet-started
  phases go down to the truthful value (T-1809, B-1249).

- Coordinator: when a session's project root is unknown, nothing is
  injected; the `NASSAJ_COORDINATOR_REPO_ROOT` variable no longer has any
  effect and can be removed from `.env` (T-1810, B-1250).

Known limitation carried forward: usage-ingestion backfill may stop until a
restart if an update outlasts the gate wait while `USAGE_INGEST_BACKFILL=on`
(B-1254).

## الإصدار 2.1.0.0 — نشر محتوى الصفحات العامة خارج شجرة نسّاج

إصدار 2026-09-18 لاحق لإصدار 2.0.0.0 المنشور. الرقم `2.1.0.0`: آلية نشر محتوى
الصفحات العامة ميزة جديدة، فارتفع مقطع الميزة وأُعيد مقطعا الإصلاح والبناء إلى
الصفر.

ما الذي ستلاحظه: الصفحة العامة التي كانت تُزرع يدوياً داخل `dist` صار لها مخزن
مستقل خارج شجرة التطبيق، فلم تعد تكسر تحديثات العقدة ولا يمحوها تبديل جيل
العميل. النشر ذرّي: لا يظهر للزائر إلا تبديل المؤشر بعد اكتمال النسخة.

- T-1798: جذر محتوى خارجي من `NASSAJ_PUBLIC_CONTENT_ROOT` أو
  `$XDG_DATA_HOME/nassaj-dev/public-content`، ويُرفض أي جذر داخل جذر التطبيق.
- T-1799: `scripts/public-page-publish.mjs` للنشر والتراجع والسحب والاستعادة
  والسرد، بنسخ معنونة بالمحتوى لا تُعدّل بعد كتابتها.
- T-1800: خدمة عرض قبل `express.static(dist)` في صندوق رملي بلا
  `allow-same-origin`، بلا `Service-Worker-Allowed`، مع قراءة `O_NOFOLLOW`
  ومطابقة sha256 للبايتات المُعادة.

التفعيل على كل عقدة يبقى إجراءً مستقلاً من زر التحديث بعد فحص جاهزيتها.

### English

Release dated 2026-09-18, following published 2.0.0.0. `2.1.0.0`: the public
page content publication mechanism is a new feature, so the feature segment
advances and the fix and build segments reset.

What you will notice: the public page that used to be planted by hand inside
`dist` now has an independent store outside the application tree, so it no
longer breaks node updates and a client generation swap does not delete it.
Publication is atomic: a visitor only ever sees the pointer swap after a
revision is complete.

- T-1798: an external content root from `NASSAJ_PUBLIC_CONTENT_ROOT` or
  `$XDG_DATA_HOME/nassaj-dev/public-content`; a root inside the application
  root is refused.
- T-1799: `scripts/public-page-publish.mjs` for publish, rollback, withdraw,
  restore and list, over content-addressed revisions that are never mutated.
- T-1800: a serving path mounted before `express.static(dist)`, sandboxed
  without `allow-same-origin`, never emitting `Service-Worker-Allowed`, reading
  every segment with `O_NOFOLLOW` and matching the sha256 of returned bytes.

Node activation remains a separate per-node action from the update button.

## الإصدار 2.0.0.1 — دورة تطوير محلية بعد 2.0.0.0

دورة تطوير محلية لاحقة لإصدار 2.0.0.0 المنشور، مؤرخة في 2026-09-17. لم تُضف
إليها تغييرات بعد، ولا تعني بناءً أو وسماً أو نشراً أو تفعيل عقدة.

### English

Local development cycle after the published 2.0.0.0 release, dated 2026-09-17.
No changes have landed yet; it does not claim a build, tag, publication, or node
activation.

## الإصدار 2.0.0.0 — صفحات عامة محكومة وتحسينات المحادثة

إصدار 2026-09-17 لاحق لإصدار 1.48.0.6. الرقم الصحيح هو
`2.0.0.0`: إضافة نطاق الصفحات العامة المحكوم في T-1796 تغيير معماري، لذلك
ارتفع مقطع المعمارية وأُعيدت المقاطع التابعة إلى الصفر. يشمل الإصدار:

- أوامر slash العربية وتحصين توجيه الجلسات والأوامر الجانبية غير السليمة.
- استعادة إحصاءات تكلفة Codex، وتشخيص واسترداد شريط سجل المحادثة غير المتاح.
- إظهار تبويبات الشريط الجانبي الثلاثة للمستخدمين الموثقين، وتحسين تصنيف فشل
  كتالوج النماذج (B-1203).
- مشاركة مستندات ومعاينات HTML معزولة بعمليات فرعية محدودة.
- تذكير دفع الالتزامات بجوار المشروع، وإصلاح قراءة سياق Codex الأصلي.
- T-1796: أساس صفحات عامة مستقل: صفحة شعار ثابتة وخدمة عرض مستقلة، وقارئ
  محدود وقفل نشر على مستوى النواة؛ لا يشمل ناشراً عاماً مكتملاً أو منح/سحب
  الوصول.
- قائمة الإجراءات الجماعية في الشريط الجانبي لا تدخل الإصدار؛ تغييراتها رُجعت.
- تثبيت أدوات CLI وتحديثها من واجهة المالك لا يدخلان الإصدار؛ أُزيلت مساراتهما
  منه.

تفعيل الإصدار على كل عقدة يبقى من زر التحديث وبعد فحص جاهزيتها.

### English

Release dated 2026-09-17, following 1.48.0.6. `2.0.0.0` is the
correct version: T-1796 adds a governed public-pages domain, so the architecture
segment advances and dependent segments reset. The release covers Arabic slash
commands, Codex cost-statistics and native-context recovery, diagnosable and
recoverable unavailable conversation history, authenticated sidebar tabs,
model-catalog failure classification (B-1203), isolated document previews, a
pending-push reminder, and the public-pages foundation: a static logo page,
standalone service, bounded reader, and publication lock. It does not include a
complete public publisher or access grant/revoke flows. The reverted sidebar
bulk-actions menu and owner CLI install/update flows are excluded.

Activation remains a separate per-node owner action.

[ملاحظات الإصدار الكاملة / Full release notes](../releases/2.0.0.0.md)

## الإصدار 1.48.0.6 — إعادة محاولة تحديث حقيقية

إصدار 2026-09-16 يصلح زر إعادة المحاولة بعد فشل بناء أو تفعيل سابق.

- «بدء محاولة جديدة» ينشئ الآن مهمة مستقلة للإصدار المعروض، ولا يعيد استعمال
  المهمة الطرفية القديمة.
- لا توجد هجرة قاعدة بيانات أو تغييرات في إعدادات العقد.
- تفعيل الإصدار على كل عقدة يبقى من زر التحديث وبعد فحص جاهزيتها.

### English

Patch release dated 2026-09-16. A retry after a terminal update failure now
creates a distinct governed job instead of reusing the dead attempt. It carries
no database migration or node-configuration change; activation remains a
separate per-node owner action.

[ملاحظات الإصدار الكاملة / Full release notes](../releases/1.48.0.6.md)

## الإصدار 1.48.0.2 — تحديث متوافق وتجهيز آمن للموصلات الجديدة

إصدار 2026-09-15 يعالج سبب فشل بناء التحديث في مشروع-أ، ويضم الالتزامين الجديدين الخاصين بتجهيز الموصلات.

- يستطيع محدّث `v1.47.0.18` على Node 24 الآن قبول حاضنة SQLite وبناء المرشح؛ أضيف اختبار يحاكي قاعدة التحقق القديمة حرفياً (B-1211).
- أضيف تجهيز مقيد لموصلات DCR المدعومة في التثبيتات الجديدة، مع إثبات الأصل والثقة، ومنع تكرار أي أثر خارجي غير محسوم (ADR-162).
- لا تتغير واجهة المستخدم، ولا تُفعّل Google أو Canva أو BYO، ولا تصبح التثبيتات القائمة مؤهلة تلقائياً.
- نشر الإصدار لا يحدّث العقد تلقائياً؛ يظل التفعيل عبر زر التحديث والمسار المحكوم لكل عقدة.

### English

Patch build dated 2026-09-15. It makes the update capsule admissible to the `v1.47.0.18` Node 24 verifier and includes the two new bounded connector-provisioning commits. Provisioning remains fail-closed, applies only to genuinely new installations and supported DCR providers, adds no UI, and does not activate Google, Canva, BYO apps, or any fleet node automatically.

[ملاحظات الإصدار الكاملة / Full release notes](../releases/1.48.0.2.md)

## الإصدار 1.48.0.1 — استعادة إشراف PM2 ومنع تكرار العفريت

إصدار تصحيحي بتاريخ 2026-09-15 يمنع مرصاد الحياة من إنشاء مشرف PM2 موازٍ عندما يغيب ملف التحكم أو المقبس.

- صار المرصاد يأخذ هوية عملية نسّاج من `/health` ولا يستدعي أوامر `pm2 pid` أو `pm2 jlist`.
- يبقى تعطيل core dumps مطبقاً على PID المثبت من الصحة، دون توسيع صلاحية المرصاد أو منحه حق إعادة التشغيل.
- أضيف اختبار يمنع رجوع أوامر PM2 المنشئة للعفريت إلى المرصاد.
- صُححت مراجع بوابة الإصدار القديمة: ربط مصنّف سياق Codex في حاضنة الذاكرة، وبصمة/أسطر جرد كتّاب قاعدة البيانات.
- لا يتضمن الإصدار ترحيل قاعدة بيانات؛ التفعيل على كل عقدة يبقى خطوة مستقلة.

### English

Patch release dated 2026-09-15. The liveness monitor now derives the Nassaj PID from `/health` and never calls daemon-spawning PM2 reads. The release-only Codex memory harness and database-writer inventory were also synchronized with their current sources. Core dumps remain disabled for the attested process, with no database migration. Per-node activation remains separate.

[ملاحظات الإصدار الكاملة / Full release notes](../releases/1.48.0.1.md)

## الإصدار 1.48.0.0 — التحديث الموحد ووضوح السياق

إصدار 2026-09-14: أعاد المالك قبول جميع الأعمال في الجدول الشامل، وأكد اكتمال التخزين المؤقت. الحصر 56 التزامًا حتى `45d0a6222245d0177d61a8f897b09c0a2ca0abf4`، ويتضمن تعديل السياق `7855652d5` وإغلاق حاضنات الإصدار النهائية.

- يشمل التحديث الموحد، مشاركة المستندات، تعافي المحادثة، أدوات نشر عميل التطوير، وإصلاحات الإصدار والصيانة.
- يشمل مؤشر إعادة استخدام التخزين المؤقت مستقلًا عن حجم السياق، مع حفظ عتبة متابعة Claude عند 250 ألف رمز، ونسبة swap وألوان الموارد.
- نجح بناء العميل والخادم على اللقطة السابقة `7a7bdd41e` دون تغيير التشغيل الحي؛ التفعيل محجوب بـ B-1193. مثال: إنشاء ملفات جيل جديد لا يعني أن الخدمة بدأت استخدامه.
- تبقى بوابات الإصدار والقبول الحي لكل ميزة؛ قبول إدراجها لا يغير حالة المهام المحجوبة إلى مكتملة.

### English

Released 2026-09-14: the owner restored comprehensive scope and confirmed cache completion. The fixed snapshot has 56 commits through the endpoint above, including context commit `7855652d5` and final release-fixture closure.

- Includes unified updates, document sharing, chat recovery, development publication and release maintenance.
- Includes independent cache reuse, the Claude 250k continuation threshold, swap percentage and resource colors.
- Client/server build-only passed at the earlier 7a7bdd41e snapshot without changing live operation; B-1193 blocks activation. Producing a new generation does not activate it.
- Release and live-acceptance gates remain; inclusion does not mark blocked tasks complete.

[الجدول الشامل وأدلة البناء وخطة العقد / Full inventory, build evidence and node plan](../releases/1.48.0.0.md)

### إصلاحات التحضير قبل التجميد / Pre-freeze preparation fixes

- `da3a9c93d`: إغلاق B-1180 بجرد 138 موقعًا و13 اختبار mutation؛ `ecfe82801`: إغلاق B-1194 وحاضنة الأمان 24/24. / Permission inventory resolved with 138 sites and 13 mutation checks; security harness resolved with 24/24 passing.
- `68c8503b5`: lint صفر أخطاء و459 تحذيرًا، واختبارات الواجهة 3,754/3,754 وفحص أنواع العميل والخادم وقبول QA. / Preparation lint, all client tests, both typechecks and QA passed.
- `f14b03e19`: إغلاق B-1190 بربط Sharp المحدد لمسار forward فقط؛ actual 8/8 وprofile 49/49 وقبول QA. / Exact forward-only Sharp startup binding accepted with actual/profile checks and QA.
- `6708cb091` و`48a43ca37` و`45d0a6222`: إغلاق جاهزية bootstrap وحاضنات الخادم والطرفية وإيصالات التراجع قبل المرجع النهائي. / Close bootstrap readiness, server and terminal fixtures, and rollback receipts before the final reference.

## الإصدار 1.47.0.18 — العقد المثبّتة تُقلع من جديد بعد 1.47.0.17

- **B-1147:** توقّفت العقد المثبّتة بعد التحديث إلى 1.47.0.17 في وضع الصيانة لأن ترحيلاً فيه كان يعمل داخل معاملة لا تسمح به؛ صار يعمل بعدها مباشرة، فتُقلع العقدة بلا أي تغيير في بياناتها.
- العقدة التي دخلت الصيانة فعلاً تحتاج بعد التحديث `doctor --reopen-gate` وإعادة تشغيل آمنة.
- بُني محلياً وفق ADR-150 في 2026-09-12؛ التفاصيل في `docs/releases/1.47.0.18.md`.

## الإصدار 1.47.0.17 — تحديث بموافقتك، وتأجيل لا يقطع الجلسات، وصفحات العقدة المختومة

- زرّ التحديث يعرض أهم تحسينات الإصدار ويطلب موافقتك، ثم تجري إعادة التشغيل الآمنة وحدها حين تخلو العقدة، دون إنهاء أي جلسة (T-1751).
- سجلّ حيّ لخطوات التحديث أثناء تنفيذه (T-1768).
- «جهّز التحديث…» ينتظر انتهاء الجلسات الحيّة بدل الرفض، ويمكن إلغاؤه (T-1730).
- صفحات العقدة الخاصة مثل `/hub` تُخدم من ختم يملكه المالك، فلا تمنع التحديث بعد اليوم (T-1730).
- شاشة للمالك لمراجعة أسوار الصلاحيات ورفعها (T-1770).
- تنبيه الخمول يتبع مدة ذاكرة كل مزوّد، والوكلاء يُعثر عليهم خارج PATH الخاص بـpm2 (T-1765، B-1138).
- بُني محلياً وفق ADR-150 في 2026-09-12؛ التفاصيل في `docs/releases/1.47.0.17.md`.

## الإصدار 1.47.0.16 — تنبيه خمول الجلسة وإيقاف أمتن ونافذة إعدادات حقيقية

- بعد ساعة بلا رسائل يظهر تنبيه بحجم السياق الحالي ورابط لبدء محادثة نظيفة (T-1764).
- زر الإيقاف لم يعد يعلق، وقناة التحكم تنتظر المهام الخلفية فلا يُلغى نداء الوكيل التالي برفض وهمي (B-1136، B-1120).
- نافذة الإعدادات لا تُغلق عند تغيّر عرض الشاشة وصارت حواراً حقيقياً يمكن التنقل فيه بلوحة المفاتيح (B-466، B-557، B-559، B-560).
- لوحة DeepSeek «قريباً» بشعارها الرسمي، وإخفاء Gemini مؤقتاً (T-1760، T-1761، B-1133).
- فشل كتابة إعداد الموصل لم يعد يترك ملفاً سرياً على القرص (B-532، B-533، B-1118).
- بُني محلياً وفق ADR-150 في 2026-09-12؛ التفاصيل في `docs/releases/1.47.0.16.md`.

## الإصدار 1.47.0.15 — أرشفة المشاريع وتبسيط المهارات المرصودة

- قائمة سياق المشروع في الشريط الجانبي اكتسبت عنصر «أرشفة» بمربّع تأكيد؛ يبقى المشروع المؤرشف مخفياً حتى مع إطلاق وكيل عليه، وإنشاء مشروع صريح وحده يعيد تنشيطه (T-1756/B-1096).
- كل مهارة مرصودة صارت سطراً واحداً كاستدعاء الأداة (علامة الحالة والاسم، و`xN` عند تكرار الاستدعاء)، بلا تجزئة أو معرّف نداء أو مصدر دليل أو طابع زمني (T-1758).
- بُني محلياً وفق ADR-150 في 2026-09-11؛ التفاصيل في `docs/releases/1.47.0.15.md`.

## الإصدار 1.47.0.14 — خطوات التحديث وتحديد مسار Claude

- نافذة التحديث تعرض خطوات المسار واحدةً واحدةً مع عدّاد الخطوة ولوحة خطأ تشرح سبب الفشل بالعربية والإنجليزية (T-1748/T-1750)، والخطوات المكتملة قبل الفشل تظهر منجَزة لا معلّقة.
- كشف أداة Claude Code لم يعد معلّقاً على PATH الطرفية التي أقلعت الخدمة؛ بعد فشل البحث يُفتّش في أماكن التثبيت المعروفة، فلا تقول الإعدادات «غير متصل» بعد ربط ناجح (B-1091).
- مسار التحديث `release-layout-v2` المُتقاعد مُجمَّد خلف علم معطَّل افتراضياً، ومسار git هو الافتراضي (T-1750).
- جرد مواقع إطلاق الصلاحيات أُعيد توليده ليطابق شجرة المرشح بلا إضافة موقع إطلاق أو حذفه (B-1092).
- بُني محلياً وفق ADR-150 في 2026-09-11؛ التفاصيل في `docs/releases/1.47.0.14.md`.

## الإصدار 1.47.0.13 — بطاقة ربط Claude وتقدّم التحديث

- بطاقة ربط Claude تقرأ مجلد الإعداد الذي تعمل عليه الخدمة بحسب سياسة المشاركة (B-1087)، ونسبة تقدّم محدّدة في نافذة التحديث مع امتلاء صحيح في RTL (T-1748)، وإخفاء نص المشاركين على تثبيتات الحساب الواحد (B-1088).
- بُني محلياً وفق ADR-150 في 2026-09-11؛ التفاصيل في `docs/releases/1.47.0.13.md`.

## الإصدار 1.47.0.12 — تحسينات المحادثة والشريط الجانبي وحارس النشر

- التفكير مضمَّن في الرسالة عند تفعيل عرضه، وبطاقة التحديث شريط مضغوط، وحركة ناعمة لكل القوائم المنبثقة، وطيّ البطاقة المدمجة بنقرة على عنوانها (T-1744).
- إصلاحات B-1078 (إيصالات الصور والملفات والفقاعة المتفائلة)، وB-1084 (الجواب الفارغ)، وB-1077 (بطاقة حالة الوكيل)، وT-1741 (حارس التبادل الحي والمانع السابق)، وT-1742/T-1743 (قسم المهارات المرصودة).
- بُني محلياً وفق ADR-150 في 2026-09-11؛ التفاصيل في `docs/releases/1.47.0.12.md`.

## الإصدار 1.47.0.11 — طرفية Claude وربط الاعتماد

- **لا حجب بعد إغلاق الطرفية:** إغلاق تبويب طرفية Claude أو إعادة تحميل الصفحة لم يعد يقفل كل طرفيات Claude للمستخدم برسالة `EFFECT_SCOPE_FENCED` حتى يتدخل المشغّل.
- **ربط الاعتماد يكتمل من الإعدادات:** بعد تشغيل `claude setup-token` في الطرفية، الصق الرمز المطبوع في حقل بطاقة «ربط Claude» فتتحول البطاقة إلى «متصل» فوراً.
- المعلّق: مراجعة P2/P3 من ADR-156 بـ`qa-critic` وإثباتها على منصّة الاختبار، وWI-13 (T-1728) وWI-15 (T-1730).

## الإصدار 1.47.0.10 — التحديث بضغطة واحدة

- **فحص ما قبل التحديث:** قبل أي تحديث يفحص نسّاج عشر نقاط (نظافة الشجرة، المصدر، السحب، الروابط الفرعية، نظام الملفات…) ويسمّي ما يمنع التحديث بدل أن يفشل في منتصفه.
- **لا انقطاع من التراجع:** الحالات التي كانت تُسقط التفعيل والتراجع معاً (كحادثة 1.47.0.9) تُرفض الآن قبل أي كتابة، وتبقى الخدمة كما هي.
- **مثبّت العقدة:** تثبيت كامل بضغطة لعقدة `git-checkout` مع تثبيت مصدر الإصدار ومدخل pm2 يشحنه الإصدار نفسه.
- **زر التحديث لا يختفي** بعد تجهيز إصدار، وتقدّم التحديث يُعرض بحركة حيّة.
- **الصور في المحادثة:** يعرض المساعد صوراً داخل الرد، وتُقصّ الصور المرفقة قبل إرسالها.
- **الواجهة:** حركة أسلس لطيّ الشريط الجانبي وصفوف الجلسات، وسمة irukhaimi بالبنفسجي الحصري، ومؤشر الاستهلاك بجوار مبدّل المحادثة/الطرفية.
- **الطرفية** تجد Claude في `~/.local/bin` حين لا يعرفه مسار الخادم.

## الإصدار 1.47.0.9 — استقرار الخادم وعودة عرض المحادثات

- تُفتح المحادثات الكبيرة من جديد؛ القارئ المحدود للذاكرة صار اختيارياً ولا يعمل إلا بتفعيل صريح.
- مؤشر السياق في المحرر يومض ويفتح بطاقته حين تتجاوز الجلسة 150 ألف توكن (نفّذ `/compact`) أو 200 ألف (أغلق الجلسة وابدأ جديدة) أو حين يمضي عليها ساعة، في كل المزوّدين.
- لا يمكن لأي بناء أن يستبدل الخادم الحي أثناء عملية تحديث جارية، وأصبح البناء النظيف يقلع تحت PM2 بلا 502.
- أداة الاحتفاظ بالقرص وتنظيف المحادثات القديمة عند الطلب، ومنح بيانات الاعتماد بين الأعضاء، وإجماليات الكلفة التراكمية.
- أُزيل نظام إضافات الواجهة بالكامل.
- سمة الكِندي: أسطح التنقل من الصبغة الأساسية وبلا فواصل هيكلية، والنوافذ المنبثقة بخلفية الصفحة؛ و`/compact` يُرسل فوراً من قائمة الشرطة.
- إصلاحات كودكس (SDK الصور بلا نص، قارئ الإيصالات المحدود) وأساس الحذف S1 خلف علمه دون تفعيل.
- بُني محلياً وفق ADR-150؛ يحمل صندوق الصادر A فوق أرضية التوافق B من 1.47.0.8.
- [تفاصيل الحزمة وحدودها](../releases/1.47.0.9.md).

## الإصدار 1.47.0.8 — مرشح إصلاح الرسائل وأساس التوافق

- تختفي بطاقة النسخة المحلية بعد تأكيد الاستلام، مع بقاء حماية الرسالة حتى المطابقة الدقيقة بالسجل؛ تبقى الرسائل الفاشلة وغير المؤكدة ظاهرة.
- تتحسن مطابقة إيصالات Codex دون حذف رسائل متشابهة أرسلها المستخدم عمداً أو تغيير سجل المحادثة.
- تظهر نتيجة إجراء الخادم غير المحسومة بحالة تحقق محايدة، وتُطوى العمليات المكتملة القديمة.
- يُزال زر تنظيف النسخ المستلمة العام من محرر الرسالة.
- هذا الإصدار أساس توافق B: يحافظ على عمل التخزين الجديد لمن فعّله سابقاً، لكنه لا يبدأ تفعيله لبقية المتصفحات بعد.
- [تفاصيل الحزمة وحدودها](../releases/1.47.0.8.md).

> مرشح حتى يُثبت نشره؛ لا يعني تحديث العقدتين أو حذف النسخ القديمة. تفعيل SDK المصححة للصور بلا نص B-990 خارج هذا الإصدار.
>
> Candidate until publication is verified. Includes message/receipt and command-panel repairs plus the B compatibility floor, without activating v2 on new browsers. Fleet activation, old-copy disposal and the corrected B-990 SDK are not claimed.

---

## الإصدار 1.47.0.7 — إصلاح الترقية واستلام الرسائل والنسخ المحلية

- إصلاح التعامل مع طلب الترقية القديم ومنع تعارضه مع الطلبات الأحدث، مع إيصالات تحقق تحفظ أثر العملية.
- تصحيح تفعيل النسخة المثبتة وإعداد مجلد البناء المؤقت على القرص ضمن إعادة التشغيل المعتمدة.
- دعم النسخ الاحتياطي عند غياب أداة SQLite النظامية، باستخدام المكتبة المثبتة مع فحوص السلامة القائمة.
- تضمين تحسينات الواجهة والأزرار والتنقل المحفوظة في مرجع الإصدار.
- Governed upgrade recovery, pinned activation and disk-backed temporary builds, together with committed interface improvements.
- Database backups now support hosts without the system SQLite executable by using the installed library with existing integrity checks.
- حفظ إثبات الاستلام للرسائل الجديدة المؤهلة من Codex واستعادة الحالة عند إعادة فتح المحادثة، بما فيها النص المصحوب بصورة عند اكتمال الإثبات.
- زر لإزالة النسخ المستلمة من هذا المتصفح للحساب الحالي عبر جميع المحادثات في المتصفح نفسه؛ البطاقات القديمة تحتاج الإزالة اليدوية، ويبقى سجل الخادم محفوظًا.
- لا تسوية تلقائية للصور وحدها أو الإثبات الملتبس أو الحالات خارج نافذة التحقق. بقية إصلاحات الهوية وC1 مؤجلة؛ لا ادعاء بحل نفاد الذاكرة أو تفعيل الأسطول.
- Durable receipt proof for eligible new Codex messages, including text with an image when fully proven, plus manual cleanup of received local copies in this browser. Older cards require manual cleanup; image-only, ambiguous and out-of-window cases are not automatically reconciled. Remaining identity/C1 work and fleet activation are excluded.

- [تفاصيل الإصدار وحدود التفعيل / Release details](../releases/1.47.0.7.md).

---

## الإصدار 1.47.0.5 — إصلاح الاعتمادات وحزمة التشغيل وإعادة التشغيل المُدارة

- إصدار تراكمي منذ آخر إصدار منشور، 1.47.0.0؛ يشمل إصلاح التحقق من أسماء اعتماديات npm البديلة وإدراج مشغّل Claude المُدار في الحزمة.
- أدوات الانتقال إلى إعادة التشغيل المُدارة تثبت هوية العملية وأذونات الإقلاع والإيصالات؛ النشر لا يفعّل الخادم تلقائياً.
- اقتران قياس ساعتي إعادة التشغيل يمنع الرفض الكاذب بسبب تأخر الجدولة، دون توسيع تسامح التحقق أو تجديد المهلة أو إعادة تنفيذ الأمر.
- تصحيح تشغيل مدخل أداة الترحيل المثبت عبر FD5 مع إبقاء الاستيراد العادي خاملًا وشروط الإذن والتحقق الأخرى قائمة؛ يتطلب الأثر التشغيلي تفعيل الحزمة.
- Run the retained migration CLI entry through FD5 while keeping ordinary imports inert and preserving authorization and verification requirements; operational use requires activating the package.
- إصلاح أسئلة Codex الجانبية `/btw`، وتضييق سياج آثار التنفيذ غير المحسومة، وحماية الرسائل والمرفقات عند إعادة المحاولة.
- طلب حتى عشرة مستويات تفويض لمسار Claude المدعوم مع حارس موارد؛ تبقى حدود المحرك الأصلية.
- تحسين معلومات نهاية الرد ورموز الأخطاء ورصد المهارات وتسعير النماذج وعرض المشاريع والجلسات على الهاتف، إضافة إلى إصلاح `claude setup-token` وانقطاع EPIPE.
- [تفاصيل الإصدار وحدود التفعيل](../releases/1.47.0.5.md).

> هذه ملاحظات المرشح إلى أن يُثبت نشر الإصدار. حزمة GitHub الافتراضية مستقلة عن حزمة forward المحلية. يلزم قبل تفعيل كل عقدة التحقق من قاعدة بياناتها وصلاحيات المشغّل والنسخة الاحتياطية ومسار التراجع. لا ندّعي اكتمال استعادة الرسائل أو اختفاء بطاقاتها، ولا يُرفع سياج تنفيذ تلقائياً.

---

## الإصدار 1.47.0.4 — مسودة الإصدار العاجل

- إصلاح مسار جلسة الصورة المرتبط بحواجز التنفيذ قيد المراجعة الأمنية النهائية؛ لا تعني هذه المسودة أن الحواجز تُرفع بلا تحقق.
- يحافظ محلّل سجل Codex على المسافات الأصلية لنص طلب الصورة، لتطابق هوية المرسل مع النص الموثق دون تعديل التاريخ.
- إصلاح تهيئة المفتاح المشترك للموصلات في التثبيت النظيف، وإظهار تحذير اقتراب انتهاء حزمة الموصلات للمالك.
- يتضمن النطاق المقترح تحسينات الشريط الجانبي المحفوظة؛ يجري تثبيت أدلة قبول آخر تعديلات المظهر.
- تحسين مدة تخزين قائمة نماذج المزوّد مؤقتًا ينتظر نتائج الاختبارات والقبول قبل تثبيت نطاق الإصدار.

> مسودة للمراجعة: لم يُنشر هذا الإصدار بعد. تبقى حزم التفعيل المحلي forward خارج هذا الإصدار العاجل، ولا يثبت نشر الإصدار تفعيل خادم أو إصلاح بيانات تاريخية.

---

## الإصدار 1.47.0.3 — قيد الإصدار

### إصلاح عاجل: توقّف الإرسال برسالة GENERATION_BLOCKED

- عند موت خادم نسّاج أثناء جلسة نشطة يبقى سياج الأذونات فيرفض كل إرسال. لا يُرفع السياج
  تلقائياً لأن انتهاء العملية لا يثبت نتيجة أثرها؛ وأُضيفت أداة للمشغّل ترفعه بقرار موثّق:
  `node scripts/permission-fence.mjs list|lift` مع إقرارين صريحين وسجل نية قبل الحذف.
### قناة OSS عامة قابلة للتحديث

- صار مسار التثبيت والتحديث لإصدار OSS يعتمد حصراً على
  `AlKindy-OSS/nassaj`، بما فيه بيانات الحزمة وروابط المصدر والإصدار.
- لا يتطلب تثبيت OSS أو اكتشاف تحديثاته رمز GitHub أو وصولاً إلى قناة خاصة؛
  يبقى التحقق من أصل الإصدار وملفات الأصول وـSHA-256 إلزامياً.
- تبدأ التثبيتات الجديدة على Release Runtime القابل للتحديث؛ وبعد التفعيل
  الناجح يجهز زر التحديث الإصدارات التالية من القناة العامة ثم يطلب إعادة
  التشغيل الآمنة بموافقة المالك.
- تكتمل حزمة OSS العامة والمثبّت من المصدر العام نفسه عبر allowlist دقيق
  لملفات `ops/` العامة اللازمة للتثبيت فقط؛ فلا تُحذف ملفات المشغّل المطلوبة
  ولا تتسرّب ملفات تشغيل أو إعدادات خاصة إلى الإصدار العام.

> هذا الإدخال يصف المرشح التالي. لا يصبح إصداراً منشوراً حتى تنجح بوابات
> الجودة، وتُنشر الأصول، ويتحقق `releases/latest` من المستودع العام.

---

## الإصدار 1.46.0.8 — 2 سبتمبر 2026

### هوية عملية أدق ولوحة أوامر بلا إجراءات يتيمة

- صار التحقق من هوية عملية الخادم على Linux يقرأ حقل بدء العملية الصحيح حتى
  عندما يحتوي اسمها على مسافات أو أقواس.
- تعمل صيانة طابور الإجراءات دورياً بساعة رتيبة، فتُعاد الإجراءات العالقة
  القابلة للمحاولة بعد تقادمها ولا تتعطل الصيانة عند رجوع الساعة إلى الخلف.
- تُصالح لوحة الأوامر نتائج OID النهائية، بما فيها `rolled_back`، فلا يبقى زر
  ميت أو يتيم بعد تراجع آمن.
- تعرض اللوحة رسالة واضحة عند فشل تحكم OID بدلاً من رسالة الخطأ العامة.
- رُفعت `fast-uri` غير المباشرة إلى `3.1.7` لرقعتها الأمنية، وأُغلقت
  `GHSA-p498-v437-472g` برفع `@humanfs/node` إلى `0.16.8` وتثبيت عقد القفل
  المصاحب `@humanfs/core 0.19.2` و`@humanfs/types 0.15.0`.
- أكد التدقيق عدم وجود ثغرات عالية أو حرجة؛ تنبيهات `qs` المتوسطة المتبقية
  مؤجلة ومتعقبة في `B-838`.

> نشر `v1.46.0.8` وحده لا ينقل عقدة قديمة إلى Release Runtime ولا يفعّل جيلاً
> أو يعيد تشغيل الخادم. انتقال كل عقدة وتفعيلها وإعادة تشغيلها الآمن عمليات
> إنتاج مستقلة تحتاج إذن المالك.

---

## الإصدار 1.46.0.7 — 2 سبتمبر 2026

### استعادة الجوال والبث ومسار إعادة تشغيل OID محكوم

- عادت المحادثة للعمل على عرض الهاتف مباشرة، وتظهر الردود المتدفقة فوراً من
  دون تحديث نافذة البث يدوياً.
- أُصلح احتساب زمن Codex وقراءة سياق Claude من transcript المفهرس.
- صار مسار OID يستخدم launcher وكبسولة مثبتين داخل artifact الخادم، مع قفل
  وسجل معاملة واستئناف أو تراجع حتمي وتسوية نتائج لوحة الأوامر.
- عاد زر التثبيت للشكل المصمت الخافت/الأساسي الذي وافق عليه المالك، وصارت
  أفعال رسالة المساعد في صف مستقل لا يتداخل مع صورة الهوية.
- تضمّن الإصدار أيضاً إصلاحات أسوار الصلاحيات وهوية launch actor والتحقق
  الصريح من إدارة ingress قبل أي انتقال Release Runtime.

> نشر `v1.46.0.7` لا يفعّل مرشح الخادم ولا ينفذ bootstrap أو PM2 أو ترحيل
> قاعدة بيانات أو إعادة تشغيل. بروفة العقدة والتفعيل وإعادة التشغيل الآمن
> عمليات مستقلة تحتاج إذن المالك الصريح.

---

## الإصدار 1.46.0.6 — 1 سبتمبر 2026

### انتقال محكوم وهوية Node مثبتة

- يضم هذا المرشح مسار الانتقال المحكوم لعقد 1.44 إلى Release Runtime، مع حفظ
  Git المحلي وإعداد المشرف وقاعدة البيانات وأدلة التراجع.
- صار Node المستخدم في بوابتي Release وCI matrix ملفاً عادياً مملوكاً لـroot
  عند `/usr/bin/node`، لا رابط setup-node؛ وتتحقق البوابتان من `command -v`
  و`process.execPath` والإصدار قبل الاختبارات.
- يستهلك اختبار migration composition الهوية المثبتة نفسها، ويرفض بصمة معدلة
  أو alias رمزياً قابلاً للسباق.
- تبقى تهيئة مرشح الخادم ذرية ومطابقة لأصل الإصدار، وفحوص user namespace
  إلزامية، واختبارات حد ثانية JWT حتمية.
- تبقى معاملة الصيانة صريحة: `503` و`Retry-After` ثم إثبات صفر الأعمال
  والكتّاب والنسخة النهائية وتعافٍ يدوي آمن بعد نية الفتح العام.

> يحل `v1.46.0.6` محل الوسوم الفاشلة غير المنشورة `.2`–`.5`. بقيت ثابتة
> للتدقيق ولم يُنشأ لأي منها Release أو مسودة أو أصول. نشر `.6` لا يثبت دعم
> المشغّل ولا يغير PM2 ولا يرحّل قاعدة ولا يفعّل جيلاً ولا يعيد تشغيل عقدة؛ كل
> عملية إنتاج تحتاج إذناً مستقلاً.

---

## المرشح 1.46.0.5 — محاولة غير منشورة (1 سبتمبر 2026)

### انتقال محكوم ومرشح دقيق واختبار JWT حتمي

- يضم هذا الإصدار مسار الانتقال المحكوم لعقد 1.44 إلى Release Runtime، مع حفظ
  Git المحلي وإعداد المشرف وقاعدة البيانات وأدلة التراجع.
- تبني بوابة GitHub بيئة اختبارات السكربتات عبر دالة مرشح الإصدار نفسها في
  مجلد أخ ثابت، وتتحقق من الالتزام والنسخة والشجرة ومدخل الترحيل قبل وبعد نقل
  ذري بلا نسخ أو استبدال لهدف موجود.
- يكتمل عقد العداء النظيف بمسار `/usr/bin/node` مثبت ومتحقق أنه Node.js 24،
  وفحص إلزامي دقيق لـuser namespace و`unshare`، وruntime خادم مجمّع للاختبارات.
- صار اختبار B-164 يثبت الساعة داخل ثانية JWT واحدة أثناء محاكاة 64 إصداراً
  عند ميلي ثوانٍ مختلفة، فيثبت أن `pwd_iat=0` لا يضخم عاصفة refresh.
- يثبت اختبار مستقل أن عبور حد الثانية يغيّر `iat` و`exp` طبيعياً مع بقاء
  `pwd_iat` حتمياً؛ لم تُجمّد مدة JWT ولم تُخفف صلاحية ختم كلمة المرور.
- تبقى معاملة الصيانة صريحة: `503` و`Retry-After` ثم إثبات صفر الأعمال
  والكتّاب والنسخة النهائية وتعافٍ يدوي آمن بعد نية الفتح العام.

> لم يصبح `v1.46.0.5` GitHub Release. اجتاز materialization الدقيق، ثم فشلت
> اختبارات migration composition الثلاثة في `test:scripts` لأن
> `process.execPath` الخاص بـsetup-node لم يحقق عقد الملف التنفيذي المثبت:
> ملف عادي مملوك لـroot، غير قابل لكتابة المجموعة أو العموم، وليس symlink.
> توقفت المحاولة قبل الأمن والبناء والمسودة والأصول والنشر، ونُقل إصلاح الهوية
> المملوكة لـroot إلى `.6` في بوابتي Release وCI matrix.

---

## المرشح 1.46.0.4 — محاولة غير منشورة (1 سبتمبر 2026)

### انتقال محكوم ومرشح اختبار مطابق لأصل الإصدار

- يضم هذا الإصدار مسار الانتقال المحكوم لعقد 1.44 إلى Release Runtime، مع حفظ
  شجرة Git المحلية وإعداد المشرف وقاعدة البيانات وأدلة التراجع.
- تبني بوابة GitHub بيئة اختبارات السكربتات عبر دالة مرشح الإصدار المراجعة
  نفسها، ولا تستدعي ناشر الخادم الحي أو بوابة موارد المضيف الخاصة به.
- يُبنى المرشح في مجلد أخ ثابت على نظام الملفات نفسه، ويشترط غياب المرشح
  والهدف، ثم تتحقق هوية الالتزام والنسخة والشجرة النظيفة ومدخل الترحيل قبل
  وبعد نقله ذرياً إلى `dist-server` بلا نسخ أو استبدال لهدف موجود.
- تغطي الاختبارات الهدف المشغول والمرشح التالف وسباق ظهور الهدف والتنظيف
  وقدرات النقل وربط workflow، وترفض الانتظار الالتفافي أو تجاوز بوابة الفشل.
- تبقى معاملة الصيانة صريحة: `503` و`Retry-After`، ثم إثبات صفر الأعمال
  والكتّاب والنسخة النهائية، وتعافٍ يدوي آمن بعد نية الفتح العام.

> لم يصبح `v1.46.0.4` GitHub Release. نجح materialization الدقيق، ثم فشل
> `test:server` في assertion واحدة لـB-164 لأن تأخيراً حقيقياً قدره 5ms عبر حد
> ثانية JWT فغيّر `iat` و`exp` بصورة صحيحة وكشف تذبذب الاختبار. توقفت المحاولة
> قبل الأمن والبناء والمسودة والأصول والنشر، ونُقل الإصلاح الحتمي إلى `.6`.

---

## المرشح 1.46.0.3 — محاولة غير منشورة (1 سبتمبر 2026)

### انتقال محكوم للعقد القديمة وبوابة إصدار قابلة للإعادة

- يضم هذا الإصدار مسار الانتقال المحكوم لعقد 1.44 إلى Release Runtime، مع حفظ
  شجرة Git المحلية وإعداد المشرف وقاعدة البيانات وأدلة التراجع.
- يربط عقد قاعدة البيانات ومدخل الترحيل وclosure التبعيات وبصمات البيانات
  بهوية الإصدار والعقدة، ويمرر مادة فك التشفير عبر file descriptors مقيسة.
- يعرض مسار الصيانة `503` مع `Retry-After`، ويثبت صفر الأعمال والكتّاب قبل
  النسخة النهائية والتبديل، ويعامل الرجوع بعد نية الفتح كتعافٍ يدوي آمن.
- أصبحت بوابة GitHub تهيئ متطلبات العداء النظيف قبل اختبارات السكربتات: مسار
  Node.js 24 ثابت، وuser namespaces قابلة للاستخدام، وبناء الخادم ومدخل الترحيل
  وبصمة provenance مطابقة تماماً لالتزام المرشح ونسخته وشجرة نظيفة.
- تحمي اختبارات عقد الـworkflow هذه المتطلبات من التجاوز أو التليين الصامت.

> لم يصبح `v1.46.0.3` GitHub Release. توقفت محاولته في تهيئة متطلبات العداء
> النظيف لأن ناشر الخادم الحي أجّل البناء عند سقف موارد المضيف 80%، قبل الجودة
> والأمن والبناء والمسودة والأصول والنشر. بقي الوسم ثابتاً للتدقيق، ونُقلت
> أعماله مع materialization مرشح الاختبار الدقيق إلى `v1.46.0.4`.

---

## المرشح 1.46.0.2 — محاولة غير منشورة (1 سبتمبر 2026)

### انتقال محكوم للعقد القديمة إلى Release Runtime

- أضيف مسار تحضير لمرة واحدة لعقد 1.44 يحفظ شجرة Git والتزاماتها المحلية
  وإعداد PM2 وقاعدة البيانات، ويجهز التخطيط الثابت خارج الشجرة الحية.
- صار عقد قاعدة البيانات مرتبطاً بأصل الإصدار ومدخل الترحيل المجمّع نفسه، مع
  fixture ممثل لـ1.44 وبصمة schema موحدة وإيصالات تثبت بقاء المستخدمين
  والمشاريع والجلسات والاعتمادات والمفاتيح بعد البروفة المعزولة.
- صار التنفيذ الفعلي للترحيل يستهلك قدرة محدودة مرتبطة بعقد القاعدة وclosure
  التبعيات ويعمل بهوية مستخدم الخدمة، مع بقاء الملفات المثبتة مملوكة لـroot.
- أضيف dispatcher مقيس مملوك لـroot ومجيب صيانة ثابت وخدمات تعافٍ مبكر عند
  الإقلاع، ولا يقبل المسار أوامر shell أو مسارات أو عناوين يرسلها التطبيق.
- تعرض نافذة الصيانة `503` صريحة مع `Retry-After` بدلاً من اتصال مرفوض أو 502،
  وتُثبت قبل منع الأعمال وتجميد كتّاب القاعدة وإنشاء النسخة النهائية.
- أصبح انتقال قاعدة 1.44 إلى 1.46 من نوع `backup_restore_only`: يمكن الرجوع
  الآلي قبل نية الفتح العام فقط، وبعدها يلزم تعافٍ يدوي يحمي الكتابات الجديدة.

### ما ستلاحظه في هذا الإصدار

- لا يعود زر المحدّث القديم هو طريق الانتقال الأول لعقدة 1.44؛ يبدأ الانتقال
  بمعاملة مشغّل مع موافقة مالك موقعة وقصيرة العمر ومخصصة لهوية العقدة.
- بعد اكتمال الانتقال وإثبات `/health` أن `updateReady=true` والاستراتيجية
  `artifact-runtime-v2` تصبح التحديثات اللاحقة قابلة للتحضير من الزر، ويبقى
  التفعيل وإعادة التشغيل موافقة منفصلة.

> لم يصبح `v1.46.0.2` إصدار GitHub منشوراً. سجل `test:scripts` اثني عشر فشلاً:
> تسعة لغياب `dist-server/server/scripts/release-database-migration.js`، واثنان
> في عقد systemd لغياب `/usr/bin/node`، وواحد في هوية user namespace لأن فتح
> `uid_map` أعاد `EPERM`. توقف قبل الأمن والبناء والمسودة والأصول. تحمل `.6`
> الإصلاحات: مسار Node.js 24 متحقق، وفحص userns/`unshare` إلزامي ودقيق، وruntime
> مجمّع للاختبارات. بقي الوسم القديم ثابتاً للتدقيق فقط.

---

## الإصدار 1.46.0.1 — 1 سبتمبر 2026

### تحديثات محمولة وصلاحيات تنفيذ مقيسة

- أضيف مثبت مستقل يجهز Release Runtime من حزمة الإصدار بلا Git أو npm على
  العقد، ويثبت هوية الإصدار والأصول وبصماتها وعقد Node/ABI/glibc قبل قبولها.
- صار أصل الإصدار يتضمن runtime وmanifest ومثبتاً مستقلاً وبصمته كأربع قطع
  مترابطة تتحقق منها بوابة النشر قبل إعلان الإصدار.
- أضيفت سلطة صلاحيات تنفيذ يقررها الخادم وتعيد قياس هوية CLI عند admission،
  مع تكافؤ محلي مقيس لـClaude وCodex ورفض مغلق للانحراف والحالات غير المصنفة.
- أحيطت أسطح المزوّدات والـWebSocket وSSE والأوامر وGit وسير العمل بعقد actor
  و`EffectivePolicy` بدلاً من الثقة في ادعاء العميل.
- تحسنت نافذة تكلفة المحادثة: أسماء النماذج الطويلة لا تُقتطع، وتفاصيل
  الاستخدام أوضح، والعنوان مرتبط بقارئ الشاشة، والتركيز يعود للشارة عند الإغلاق.
- أُعيدت مواءمة اختبارات مسارات WebSocket مع admission المقيسة، وشُددت إعادة
  تشغيل ترحيل الصلاحيات وافتراضات fallback للنماذج وfixtures بوابة الإصدار؛
  اجتازت الحزمة المصححة 4559 اختبار خادم بلا فشل قبل إعداد هذا المرشح.

### ما ستلاحظه في هذا الإصدار

- يصبح تثبيت أصل قابل للتحديث ممكناً من حزمة مستقلة بلا source checkout؛ أما
  التفعيل وإعادة التشغيل فيبقيان قرارين منفصلين يوافق عليهما مالك العقدة.
- يرفض التنفيذ مبكراً إذا تغيرت هوية أداة CLI أو لم تكن صلاحيات الجسد قابلة
  للإثبات الميكانيكي.
- تعرض نافذة التكلفة أسماء النماذج والتفاصيل الطويلة بوضوح أكبر على الشاشات
  الضيقة، وتعيد التركيز إلى موضعه الصحيح بعد الإغلاق.

> يحل المرشح `v1.46.0.1` محل `v1.46.0.0` غير المنشور. فشل مسار المرشح السابق
> في بوابة اختبارات الخادم قبل إنشاء مسودة أو أصول أو GitHub Release، وبقي
> وسمه الثابت أثر تدقيق فقط. لا يصبح هذا المرشح منشوراً إلا بعد نجاح بوابات
> الجودة والوسم وGitHub Release والتحقق من `releases/latest`، ولا يمنح إذناً
> لتفعيل أي عقدة أو إعادة تشغيلها أو ترحيل بياناتها.

---

## الإصدار 1.45.0.5 — 31 أغسطس 2026

### نشر عميل معزول واستئناف جلسات أكثر مرونة

- لم تعد لوحة الأوامر تعرض إعادة تشغيل لمرشح قديم أو لهوية بناء غير متطابقة؛
  ويعيد العميل التحقق من المرشح قبل إرسال أي طلب.
- أصبح ناشر OID الخاص بالعميل معزولاً عن أحداث ومسارات الخادم. وصار الترويج
  وتحديث المراجع وإعادة تشغيل الأحداث ذرياً وقابلاً للاسترداد بعد الانقطاع.
- يعمل بناء Vite من إعدادات للقراءة فقط، فلا يحتاج ناشر العميل إلى الكتابة في
  الاعتماديات المحمية أو توسيع صلاحياته.
- يمكن للجلسات استخدام مساحة مشتركة موثقة للمشاريع المسجلة غير الخاضعة لـGit
  وللمجلدات الفرعية المسجلة، مع رفض المسارات المفقودة أو غير الآمنة قبل تشغيل
  المزوّد.
- يستمر سياج الإقلاع في إبقاء المسار القديم الصالح قابلاً للاستئناف، وتحويل
  المسارات المحذوفة أو المؤقتة إلى العزل الآمن بدلاً من حلقة فشل عند الإقلاع.
- ينتظر مسار الإصدار ظهور المسودة المطابقة، وينشر فشل استعلام المسودات
  وقائمة الأصول بدلاً من متابعتهما كقوائم فارغة وإنتاج إصدار ناقص.

### ما ستلاحظه في هذا الإصدار

- اختفاء تنبيه «إعادة التشغيل مطلوبة» عندما يكون مصدره مرشحاً قديماً.
- وصول تغييرات العميل من دون خلطها بأحداث خادم أو طلب إعادة تشغيله.
- إنشاء واستئناف الجلسات في المشاريع غير Git والمجلدات الفرعية المسجلة ضمن
  حدود تحقق صريحة.
- فشل مبكر وواضح لمسار النشر إذا تعذر إثبات المسودة المطابقة.

> هذا سجل الإصدار `v1.45.0.5`. يصبح منشوراً فقط بعد نجاح بوابات الجودة
> والوسم وGitHub Release والتحقق من `releases/latest`. تفعيل الخادم وإعادة
> تشغيله عمليتان مستقلتان ولا يمنحهما سجل الإصدار تلقائياً.

---

## الإصدار 1.45.0.4 — 31 أغسطس 2026

### أصل تحديث محمول وإقلاع أكثر ثباتاً

- أعيد بناء أصل الإصدار حول إغلاق صريح لاعتماديات التشغيل، موثق في manifest
  ومرتبط بملف القفل، بدلاً من نسخ `node_modules` كاملاً. ويشمل الأصل أدوات
  التشغيل وبناء العميل اللازمة مع تحقق من البصمات والاعتماديات الأصلية.
- أصبح عقد المنصة صريحاً لـNode.js 24 وABI 137 على Linux/x64، مع تحقق من
  توافق libc ونسخ الحزم قبل التفعيل، وبروفة تفك الأصل وتختبر SQLite وأدوات
  Claude وCodex وripgrep وبناء العميل المعزول.
- يمنع إصلاح B-794 تعطل إقلاع الخادم بسبب مسارات جلسات قديمة محذوفة أو مؤقتة
  أو sentinel؛ تُحوّل هذه الحالات إلى overlay، بينما تظل المسارات القانونية
  الموجودة مؤهلة للاستئناف وفق إصلاح B-791.
- توضح لوحة الأوامر الآن أن المرشح الحساس لا يمر بإعادة التشغيل العادية، وأنه
  يحتاج مسار تفعيل إصدار مراجعاً ومصرحاً به، بدلاً من رسالة «خطأ غير متوقع».

### ما ستلاحظه في هذا الإصدار

- حزمة تحديث قابلة للتحقق والنقل ضمن السقوف المشتركة للبناء والاستهلاك.
- إقلاع أكثر ثباتاً حتى عند وجود سجلات جلسات تشير إلى مساحات عمل لم تعد
  موجودة، مع استمرار الرفض الآمن للحالات غير المصنفة.
- رسالة واضحة عند حجب إعادة تشغيل بناء حساس، من دون تجاوز بوابة الحساسية أو
  منح إذن تفعيل تلقائي.

> هذا سجل لمرشح الإصدار `v1.45.0.4`؛ يظل النشر معلقاً حتى اكتمال الوسم وGitHub
> Release والتحقق من `releases/latest`. كما يبقى تفعيل كل عقدة وإعادة تشغيلها
> خطوتين مستقلتين بعد النشر.

---

## الإصدار 1.45.0.3 — 30 أغسطس 2026

### دورة تشغيل أوثق وموصلات قابلة للنقل

- أضيف أساس متكامل للموصلات يفصل التسجيل والاعتماد والتوزيع، مع خزنة مشفّرة،
  وحدود واضحة للحسابات الشخصية والمشتركة، وحالة إعداد وتوزيع أكثر صدقاً في
  الواجهة. بقيت عمليات الترحيل والتفعيل غير المعتمدة خاملة عمداً.
- أصبحت المحادثات أكثر ثباتاً عند الإغلاق وإعادة الاتصال والاستئناف، وتحسّن
  عرض النتيجة النهائية والمدة ومؤشرات المشاركين وتثبيت الجلسات والمشاريع.
- صارت إحصاءات المشروع توضّح حداثة البيانات واكتمالها وحدود تقدير التكلفة،
  واكتملت أسطح الويكي المتجاوبة وتنظيم المواد المرجعية.
- تعزّزت دورة البناء والإصدار بعزل المعاينات المتوازية، والتحقق من ملفات
  runtime وmanifest، وبوابات اختبار خادم وfixtures معزولة عن قيود الإنتاج.
- بعد حادثة عدم توافق `better-sqlite3` بين Node.js 22 و24، أصبح مسار إعادة
  التشغيل الآمن يفحص ABI فعلياً قبل تغيير الخدمة ولا يقبل النجاح دون HTTP
  200. لا يزال لمس اعتماديات الخدمة الحية من أعمال البناء محظوراً.
- أصبحت بوابات الإصدار حتمية وقابلة للنقل بين بيئات CI، ويستطيع المسار
  استئناف المسودة المطابقة وحدها والتحقق من هوية أصولها قبل النشر.
- عاد استئناف المحادثات القديمة المؤهلة التي تحفظ مجلد مشروع قانونياً سابقاً
  على Git وoverlays، مع رفض الروابط الرمزية والمجلدات الجزئية الغامضة قبل
  تشغيل المزوّد.
- أصبحت مزارع روابط npm التنفيذية تُدقق وتُثبت في manifest قبل استبعادها من
  أصل الإصدار، بدلاً من رفض الأصل أو إسقاط الروابط بلا دليل قابل للتحقق.
- صار رفع أصول GitHub يستخدم مضيف `uploads.github.com` القانوني بعنوانه
  الكامل، مع إبقاء التحقق من هوية المسودة وبصمة الأصل وحجمه قبل النشر.

### ما ستلاحظه في هذا الإصدار

- إعدادات موصلات أوضح، مع رسائل جاهزية وحسابات وحالة توزيع أدق.
- حالة جلسة ونتيجة نهائية ومدة عمل أكثر اتساقاً بعد التحديث أو الانقطاع.
- مؤشرات مشروع وويكي أوضح على الشاشات الواسعة والضيقة.
- فشل آمن ومبكر إذا لم تطابق اعتماديات Node الأصلية بيئة الخادم قبل إعادة
  التشغيل، بدلاً من بقاء PM2 online مع خدمة لا تستمع على المنفذ.
- إمكانية استئناف محادثة قديمة مؤهلة من مجلدها المحفوظ حتى إن لم يكن مستودع
  Git، بعد وصول الإصدار إلى الخدمة عبر مسار التفعيل المستقل.

> هذه مسودة تحديث للدورة الحالية؛ يصبح الإصدار منشوراً فقط بعد اكتمال بوابات
> الاختبار والوسم وGitHub Release والتحقق من `releases/latest`. التفعيل الحي
> وإعادة التشغيل عمليتان منفصلتان.
>
> المرشحون `v1.45.0.0` و`v1.45.0.1` و`v1.45.0.2` لم يُنشروا، وحلّ
> `v1.45.0.3` محلهم. توقف الأولان في بوابات CI وبناء الأصل، وبقي الثالث
> مسودة بلا أصول بعد فشل مضيف الرفع. تبقى آثارهم أدلة تدقيق لا قناة تحديث
> مستقرة.

---

## الإصدار 1.44.0.0 — 19 أغسطس 2026

### الويكي وحالة المحادثات

- أضيفت صفحة «التحديثات» إلى مقدمة الويكي وصفحة واحدة تراكمية لنشرة أخبار
  الذكاء الاصطناعي، مع مراجعة لغة صفحات الويكي وترجماتها وفهرستها. النشرة
  اليومية مهيأة بالمحتوى والمشغّل، لكن جدولتها الأصلية داخل نسّاج لم تُفعّل
  بعد.
- أصبح بالإمكان حفظ مستوى التفويض المطلوب لكل رسالة وعرضه في المحادثة، مع
  تحسين موثوقية إسناد الرسائل عند إعادة الاتصال أو تأخر أحداث التسليم.
- تعرض جلسات Codex نماذجها والمشاركين الفرعيين بصورة أكمل، وعادت مؤشرات
  الجلسات الحية إلى الشريط الجانبي.
- تحسّن فتح المحادثة الجديدة من النقرة الأولى، وتراص إجراءات تذييل الشريط
  الجانبي، وموضع حالة المحادثة المغلقة.
- أصبحت إحصاءات العتاد تعرض استخدام القرص، وصار اللون الأساسي للعلامة مطبقاً
  على فقاعات رسائل المستخدم.
- تعزّز مسار بناء الخادم ونشر ملفاته بتحقق مرحلي وترويج ذري، وأضيفت معايير
  مقترحة وأداة تدقيق لأحجام عناصر التحكم في الواجهة.

### ما ستلاحظه في هذا الإصدار

- يسهل الآن متابعة تغييرات نسّاج من الويكي والوصول إلى صفحة أخبار الذكاء
  الاصطناعي من مكان ثابت.
- صارت حالة المحادثات والتفويض والمشاركين أوضح، مع تنقل أكثر ثباتاً في الشريط
  الجانبي.
- يقل خطر وصول ملفات بناء خادم ناقصة إلى الجيل المنشور؛ ولا يلزم المستخدم
  إجراء يدوي بعد التحديث المعتاد.

---

## الإصدار 1.42.0.5 — 17 أغسطس 2026

### ثبات الإصدار وأمان التحديث

- تحسّن ثبات اختبارات تسجيل الدخول على بيئة Node.js 22 في قناة الإصدار.
- أصبحت اختبارات الإصدار المعزولة أقل اعتماداً على إعدادات جهاز المطوّر وأدواته المثبّتة محلياً.
- حُفظت تحسينات المحادثة والشريط الجانبي والإعدادات والنماذج والسمات ودعم اتجاه الواجهة من اليمين إلى اليسار ضمن إصدار مصدر موحّد.
- تعزّزت حماية بيانات الاعتماد ومفاتيح الواجهات البرمجية، وأصبحت عمليات التحديث تلتزم بالإصدار المحدد وترفض الشجرة غير النظيفة أو الجلسات النشطة.

### ما ستلاحظه بعد التحديث

- إصدار أكثر قابلية للتحقق وأقل تأثراً باختلاف بيئة التشغيل.
- تحديثات أكثر أماناً؛ لا تعيد عملية التحديث تشغيل الخدمة تلقائياً ولا تتجاوز موافقات التشغيل الحسّاسة.
- استمرار العمل المعتاد دون خطوات ترحيل يدوية من المستخدم.
