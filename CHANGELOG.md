## 2.3.0.6 — 2026-09-25

يعيد محفظة حسابات الجهاز، ويضيف إدارة أعضاء المشروع مع فرض حدود العضوية، ويستعيد نموذج
المحرّك المسجَّل للجلسة بعد إعادة التشغيل، ويوحّد إعداد الموصلات وتحديث الأدوات، ويضم قياس
تكاليف متقدماً معطَّلاً. ويُصلح إعادة استخدام مستودع مستنسخ مسبقاً عند استنساخه من جديد.
Restore the device account wallet, add project member management with enforced membership
boundaries, recover a session's recorded engine model after restart, unify connector setup
and harness updates, and ship dormant cost telemetry. Fix reusing an already-cloned repository.

## 2.3.0.5 — 2026-09-24

توفيق إجمالي تكلفة Codex مع إبقاء تذييل كل ردّ، وإصلاحات فحص الإصدار ونشاط الأدوات،
ونواة توقيع الموصلات مع إعداد أولي اختياري خامل، وترقيع الاعتماديات.
Reconcile Codex cost totals while keeping per-reply footers, fix version checks and tool
activity, add connector signing core with dormant opt-in auto-setup, and patch dependencies.

قيد معروف: يقرأ `/status` الإصدار من `package.json` على القرص فقد يعرض إصداراً أحدث من
المشغَّل حين يسبق المصدرُ الإصدارَ؛ الإصلاح في 2.3.0.6 بالقراءة كما يفعل `/health`.
Known limitation: `/status` reads the version from `package.json` on disk, so while a node's
source is ahead of its running release it can show a newer version than is running; fix
planned for 2.3.0.6 (read the version the way `/health` does).

التحقق / Verification: مجموعة مواقع جرد الصلاحيات = v2.3.0.4 ∪
{connector-auto-setup.ts#child_process.spawnSync#1}. / Permission inventory site set =
v2.3.0.4 ∪ {connector-auto-setup.ts#child_process.spawnSync#1}.

## 2.3.0.4 — 2026-09-24

تحسين حالات المزوّد وخيار عرض استهلاك العتاد والصور والقوائم.
Improve provider status localization, optional hardware usage, images and menus.

# Changelog

All notable changes to Nassaj will be documented in this file.

## [2.3.0.3] — Product/governance boundary and release provenance (2026-09-24)

مرشح لاحق للإصدار المنشور `2.3.0.2`. يبقى بانتظار مراجعة QA المستقلة النهائية؛
ولا يدل هذا السجل على وسم أو نشر أو تفعيل خادم. / Candidate following the
published `2.3.0.2`. It remains pending final independent QA; this entry does
not claim a tag, publication or server activation.

### أُضيف / Added

- قراءة حوكمة فاشلة الإغلاق من الكتالوج الثابت
  `/etc/nassaj/governance-content.json` وبمفاتيح منطقية ظاهرة للفاعل. غياب
  الكتالوج أو فساده أو عدم تطابق اللقطة يعيد `available: false` بلا fallback. /
  Fail-closed governance reads from the immutable system catalog with
  actor-visible logical keys; missing, malformed or mismatched input returns
  `available: false` with no fallback.
- بيان منشأ خارجي غير دائري للتصدير العام، مع تثبيت المرشح والأب العام ومحاولات
  نشر قابلة للاستئناف. / An external non-circular public-export provenance
  manifest that binds the candidate, public parent and resumable attempts.

### تغيّر / Changed

- أصبحت معمارية المنتج ملفات عادية متتبعة، وبقيت اللوحة والخطط والحالة في
  الحوكمة الخارجية. يرفض `scripts/board.mjs` داخل المنتج القراءة والكتابة ويوجه
  العمليات إلى CLI النمطي الخارجي. / Product architecture is now tracked as
  regular files while board, plan and status truth remains external; product
  `scripts/board.mjs` refuses reads and writes and directs operations to the
  typed external CLI.
- بقيت تعليمات مشروع Codex مفعلة، مع إزالة منح الكتابة إلى جذور خارج مساحة عمل
  المنتج. / Codex project instructions remain enabled while external writable
  roots are removed from product sessions.
- `NASSAJ_COORDINATOR=1` مخصص لحقن حقائق المنسق فقط، ولا يفعّل قراءة اللوحة أو
  fallback. / `NASSAJ_COORDINATOR=1` controls coordinator ground-truth
  injection only; it does not enable board reads or a fallback.

### أُصلح / Fixed

- حُصر وصول النماذج المحلية إلى الأسرار في دوال مخصصة تثبت نطاق
  `local-model` ولا تمنح وصولاً إلى بيانات اعتماد الموصلات. / Local-model secret
  access now uses dedicated wrappers that pin the `local-model` namespace and
  cannot select connector credentials.
- شُدد استئناف نشر المصدر العام والتحقق من النسب والبصمات من دون force push أو
  إعادة نشر الإصدار الخاص. / Public-source publication resume and
  ancestry/digest verification are hardened without force-push or private
  republishing.

### لم يُفعّل / Not activated

- مقارن ADR-169 تاريخي وغير معتمد لإصدار `2.3.0.2`، ويبقى غير نشط في
  `2.3.0.3`. ولا ينشر المرشح كتالوج الحوكمة أو لقطتها، ولا يشغل CLI الخاص بـcore،
  ولا يفعّل خادماً. / The historical ADR-169 comparator was not adopted for
  `2.3.0.2` and remains inactive in `2.3.0.3`. The candidate does not publish a
  governance catalog or snapshot, execute the core CLI or activate a server.

## [2.3.0.2] — Resumable release, chat, local-model, and SSO documentation updates (2026-09-22)

إصدار منشور لاحق للإصدار `2.3.0.1`؛ يرفع مقطع البناء وحده تحت
`architecture.feature.fix.build`. لا يدل هذا السجل على تفعيل عقدة. / Published
release following `2.3.0.1`, advancing the build segment only under
`architecture.feature.fix.build`. This entry does not claim node activation.

### أُضيف / Added

- تشغيل إصدار قابل للاستئناف (T-1832) يسجل المراحل، ويستأنف بأمان بعد الفشل،
  ويحرس تصدير المحتوى العام. / Resumable release execution (T-1832) records
  phases, recovers safely after failure, and guards public-content export.

### تغيّر / Changed

- أصبحت استعادة ردود OpenCode الحية وسجل المحادثة أكثر موثوقية، بما في ذلك
  إنشاء الجلسة المتأخر وفجوات العرض في الأدوار الطويلة. / OpenCode live-reply
  recovery and chat history are more reliable, including late session creation
  and display gaps during long turns.
- وثائق SSO ومسارات OIDC/PKCE وZitadel تشير الآن إلى المرجع المعتمد. / SSO
  documentation and the OIDC/PKCE and Zitadel paths now point to the approved
  canonical reference.

### أُصلح / Fixed

- رفض مفتاح نموذج محلي لا يسجّل المستخدم خروجه، وتعالج استجابة المصادقة `422`
  والرسائل الجزئية بوضوح أكبر. / A rejected local-model key no longer signs
  the user out; `422` authentication responses and partial messages are handled
  more clearly.

## [2.3.0.1] — Claude full-login and fresh-install fixes; SSO groundwork (2026-09-22)

إصدار لاحق للإصدار المنشور `2.3.0.0`، يرفع مقطع البناء وحده تحت
`architecture.feature.fix.build`. يجمع إصلاحين ظاهرين للمستخدم، وأساس دخول موحّد
معطَّلاً افتراضياً، ووثائق قرار. / Release following the published `2.3.0.0`,
advancing the build segment only under `architecture.feature.fix.build`. It
bundles user-visible fixes and UI refinements, a single-sign-on groundwork
disabled by default, and decision records.

### أُصلح / Fixed

- ربط Claude صار تسجيل دخول OAuth كاملاً افتراضياً بدل ربط جزئي لا يقرأ الحصة؛
  والاعتماد الجزئي أو الفارغ يظهر الآن تنبيه «الربط غير مكتمل — أعد الربط» مع زرّ
  إعادة ربط صريح (B-1260، B-1261، B-586). / The default Claude link is now a full
  OAuth sign-in instead of a partial link that cannot read usage; a partial or
  empty credential now shows an "incomplete link — re-link" notice with an
  explicit re-link button (B-1260, B-1261, B-586).
- التثبيت الجديد يختم أرشيف النسخة المولَّدة المخدومة فلا يبقى غير مكتمل على عقدة
  جديدة، مع فحوص تمهيدية إضافية قبل التحديث (B-1293). / Fresh install seals the
  served generated archive so it is not left incomplete on a new node, with
  additional preflight checks before an update (B-1293).
- منتقي النماذج لم يعد يقدّم كتالوج مزوّد قديماً بعد تغيّر الحالة، فتظهر النماذج
  المتاحة فعلاً فقط (B-1283). / The model picker no longer serves a provider's
  stale catalog after state changes, so only the actually available models are
  shown (B-1283).
- مُعرّف لقطة السياق يحافظ على الاسم المستعار المختار في المنتقي فلا يضيع عند
  التقاط السياق (B-1295). / The context-snapshot identity preserves the alias
  chosen in the picker, so it is not lost when the context is captured (B-1295).
- حُصِّن `answer.trim()` في `BtwOverlay` و`forkBtw` ضدّ القيمة غير المعرّفة فلا
  تنهار الواجهة. / `answer.trim()` in `BtwOverlay` and `forkBtw` is guarded
  against an undefined value, so the UI does not crash.
- سجلّ المحادثة يتحمّل نتائج الأدوات منزوعة المحتوى فلا ينكسر عرضها. / Chat
  history tolerates tool results with stripped content, so rendering no longer
  breaks.

### غُيّر / Changed

- منبثقة استهلاك السياق أصغر وأقل ضجيجاً بعد إعادة تنسيقها. / The context-usage
  popover is smaller and less noisy after a recompose.
- نُقلت إدارة النماذج المحلية إلى شبكة عدّة الوكلاء في الإعدادات دون تغيير في
  وظيفتها. / Local-models management moved into the agents harness grid in
  Settings, with no change to its function.

### أُضيف (معطَّل افتراضياً) / Added (disabled by default)

- أساس دخول موحّد يربط أدوار المشروع من مزوّد الهوية ويتحقّق من `id_token` عبر
  JWKS. الحارس فاشل-الإغلاق: كل مسارات OIDC تُعيد 501 ما لم يُضبط `OIDC_ENABLED=true`
  ويكن `OIDC_ROLE_PROJECT_ID` صحيحاً، فالميزة خاملة في الإعداد الافتراضي. / A
  single-sign-on groundwork that maps identity-provider project roles and
  verifies the `id_token` via JWKS. The guard is fail-closed: every OIDC route
  returns 501 unless `OIDC_ENABLED=true` and a valid `OIDC_ROLE_PROJECT_ID` is
  set, so the feature is dormant in the default configuration.

### توثيق / Documentation

- وثيقتا قرار ADR-158 وADR-166 وترقيم مصحَّح لسلسلة ADR. / Decision records
  ADR-158 and ADR-166, and a corrected ADR series numbering.

## [2.3.0.0] — Local model servers; hardened in-app updates (2026-09-21)

إصدار لاحق للإصدار المنشور `2.2.0.0`، يضمّ تغييرات دورة `2.2.0.1` المحلية التي
لم تُنشَر بمفردها من قبل. الرقم `2.3.0.0`: إدارة خوادم النماذج المحلية ميزة
جديدة، فيرتفع مقطع الميزة من `2` إلى `3` وتُعاد مقاطع الإصلاح والبناء إلى الصفر
تحت `architecture.feature.fix.build`؛ ولا يحمل الإصدار تغييراً معمارياً جديداً
بعد `2.0.0.0` فيبقى مقطع المعمارية `2`. / Release following the published
`2.2.0.0`, folding in the local `2.2.0.1` cycle's changes, which were never
released on their own. `2.3.0.0`: local model-server management is a new
feature, so the feature segment advances from `2` to `3` and the fix and build
segments reset under `architecture.feature.fix.build`; no new architectural
change lands after `2.0.0.0`, so the architecture segment stays `2`.

### أُضيف / Added

- إدارة خوادم النماذج المحلية من الإعدادات: يمكن إضافة خادم نموذج محلي (مثل
  Ollama) واستعماله مزوّداً داخل نسّاج. كل خادم محصور بمالكه، ومصادر طلباته
  مقيّدة بحارس صريح (T-1806، B-1268). / Local model-server management in
  Settings: add a local model server (for example Ollama) and use it as a
  provider inside Nassaj. Each server is scoped to its owner and its request
  origins are bound by an explicit guard (T-1806, B-1268).

### أُصلح / Fixed

- مسار التحديث داخل التطبيق صار أمتن: نقل مثبّت لعفريت PM2 واحد، وحارس ملكية
  للمُشرف، وعقد مصالحة، ومرشّحات استعادة محلية وتراجع يدوي محدود، وانتقال محكوم
  للمستهلك دون اتصال، مع التحقّق من أهلية البناءات المحفوظة قبل قبولها. / The
  in-app update path is hardened: a pinned single PM2-daemon transport, a
  supervisor ownership guard, a reconciliation contract, local recovery
  candidates with bounded manual rollback, a governed offline-consumer
  transition, and qualification of retained builds before admission.
- شريحة حصة الدورة لم تعد ترتجف أثناء تحميل نوافذ المزوّد، وتظهر شارة خطأ بدل
  شريحة دورة قديمة حين يتعذّر قراءة الحصة. / The cycle-quota chip no longer
  flickers while provider windows load, and an error badge is shown instead of
  a stale cycle chip when the quota read fails.
- خفّت درجة تشبّع لون الـnavy في الشريط الجانبي بالوضع الفاتح لسمة AlKindy. /
  The AlKindy light-mode sidebar navy tint is softened.
- في المحادثة: لم تعد شارة اختصار لوحة المفاتيح تعترض النقر على حقل «غير ذلك»،
  وصار الحقل يتلقّى التركيز فوراً فلا تضيع أوّل ضغطات المفاتيح. / In chat: the
  keyboard-shortcut badge no longer intercepts clicks on the "Other" input, and
  the input focuses synchronously so the first keystrokes are not lost.
- إشعار `/btw` صار يتخطّى دورة الإشعار الفارغة (`num_turns:0`) فيظهر الجواب
  الحقيقي بدلها (B-1286). / The `/btw` notification now skips the empty
  (`num_turns:0`) cycle so the real answer wins (B-1286).
- سُدّت ثغرات تعطيل التنفيذ الخام لنفسه في لوح الأوامر، وصار نصّ الرفض صادقاً. /
  Raw-exec self-disruption gaps in the command board are closed and the denial
  text is now honest.
- تباعُد نقطة الانشغال عن عنوان المشروع في الشريط الجانبي عبر هامش بادئ منطقي. /
  The busy-indicator dot gets a logical start margin for spacing from the
  project title.

### تغيّر / Changed

- صيانة التشغيل: سكربت مصالحة يضمن عفريت PM2 واحداً، ويحصد تطبيقات PM2 اليتيمة
  بحسب المنفذ. / Operations maintenance: a reconcile script enforces a single
  PM2 daemon and reaps orphaned PM2 apps by port.
- تصليب بوابة التصدير العام وتعقيم هوية المشغّل (باللاتينية والعربية) في الشجرة
  المُصدَّرة. / The public-export gate is hardened and operator identity is
  scrubbed (Latin and Arabic) from the exported tree.

## [2.2.0.0] — Agent-guided public page publishing; credential security fixes (2026-09-19)

إصدار لاحق للإصدار المنشور `2.1.0.0`، يضمّ أيضاً تغييرات دورة `2.1.0.1`
المحلية التي لم تُنشَر بمفردها من قبل. الرقم `2.2.0.0`: توجيه كل وكيل عند
الإطلاق إلى ناشر الصفحات العامة ميزة جديدة، فيرتفع مقطع الميزة وتُعاد
المقاطع التابعة إلى الصفر تحت `architecture.feature.fix.build`. /
Release following the published `2.1.0.0`, folding in the local `2.1.0.1`
cycle's changes, which were never released on their own. `2.2.0.0`: guiding
every agent at launch to the public-page publisher is a new feature, so the
feature segment advances and subordinate segments reset under
`architecture.feature.fix.build`.

**ملاحظة للمشغّل / Operator note:** على أي عقدة استُعملت فيها منحة اعتماد
قبل هذا الإصدار، قد يكون مفتاح العضو المُستفيد موجوداً فعلاً داخل
`settings.json` أو `auth.json` الخاصّين بـ**المانح** نفسه، ولم يعد العضو
المُستفيد يراه أو يقدر على حذفه من واجهته؛ على كل مانح مراجعة إعدادات
مزوّديه بنفسه وإزالة اعتماد ليس له (B-1255). / On any node where a credential
grant was used before this release, the grantee's personal key may already
sit in the **grantor's** own `settings.json` or `auth.json`, and the grantee
can no longer see or delete it from their own UI; grantors should check their
own provider settings for a credential that is not theirs and remove it
(B-1255).

### أُضيف / Added

- T-1802: مربّع حوار التحديث يسرد الآن، عند `client_asset_manifest_changed`،
  قائمة انحراف بنيوية (دخيل/ناقص/متغيّر، نسبية إلى `dist`، محدودة الطول)
  تصل من إيصال مهمّة التحديث؛ ونص الرسالة يبقى بلا مسارات كي لا يفسده مطهِّر
  اللقطة. / The manifest error now carries a structured drift list
  (unexpected/missing/changed, dist-relative, bounded) through the update job
  receipt to the upgrade dialog; the text message stays path-free so the
  snapshot sanitizer cannot mangle it.
- T-1803: `scripts/public-page-publish.mjs` يُشحن الآن ضمن حزمة تشغيل
  التحديث؛ يُخدَم `/<site>/` ويُعاد توجيه `/<site>` فقط بعد النشر؛ أسماء
  مسارات الواجهة أحادية الصفحة محجوزة في قائمة واحدة يشترك فيها القارئ
  والناشر. / `scripts/public-page-publish.mjs` ships inside the update
  runtime bundle; `/<site>/` is served and `/<site>` redirected only once
  published; SPA route names are reserved in one list shared by reader and
  publisher.
- T-1804: تعليمات نشر الصفحات العامة تُحقَن عند إطلاق كل مزوّد، بمسار الناشر
  المطلق المحلول خادمياً وجذر المحتوى المحلول خادمياً أيضاً (عزل المزوّدين
  يبدّل `HOME`)؛ الأصل العام (`NASSAJ_PUBLIC_ORIGIN`) يُبنى منه رابط مطلق
  جاهز حين يكون مضبوطاً وموثوقاً، وإلا يبقى النص نسبياً بلا استنتاج أصل من
  ترويسة الطلب. عند كلود تحديداً تُرفض الكتابة أو التحرير مباشرة داخل
  `dist/` و`dist-server/` التابعين لتثبيت نسّاج فوق فحص `bypassPermissions`،
  ورسالة الرفض تحمل الأمر البديل القابل للتنفيذ؛ `dist/` الخاص بمشروع
  المستخدم نفسه لا يُرفض أبداً. أوامر Bash والكتابة عبر خوادم MCP تبقى خارج
  القفص عمداً؛ فحص المانيفست هو شبكة الأمان الخلفية. / Publishing guidance
  is injected at spawn for every provider, with the host-resolved absolute
  publisher path and the server-resolved content root (provider isolation
  swaps `HOME`); the public origin (`NASSAJ_PUBLIC_ORIGIN`) is turned into a
  ready absolute link when configured and trusted, otherwise the text stays
  relative and never infers an origin from the request `Host`. For Claude
  specifically, Write/Edit into the Nassaj installation's own `dist/` and
  `dist-server/` is refused above the `bypassPermissions` check, with the
  runnable alternative command in the denial; a user project's own `dist/`
  is never refused. Bash and MCP writes stay outside the cage by design; the
  manifest check is the backstop.

### أُصلح / Fixed

- رفض بوّابة صيانة التحديث صار يظهر داخل لوح الطرفية كلافتة تحمل سبباً مصنَّفاً،
  بدل لوح أسود صامت بلا نصّ. التشخيصات المُعلَنة تظهر بنصّها الخاص، وما عداها
  يظهر بسطر عام مع رمز سبب، ولا يتسرّب نصّ الاستثناء الخام. /
  An update-gate refusal now appears in the terminal pane as a banner carrying a
  classified reason, instead of a silent black pane. Listed diagnostics are
  shown in their own wording, anything else gets a generic line plus a reason
  code, and raw exception text no longer leaks.
- انقطاع الطرفية صار يُميَّز برمز الإغلاق: الرفض القاطع نهائي بلا إعادة اتصال،
  وأي انقطاع آخر (منها إعادة تشغيل الخادم) يعيد الارتباط كما كان. /
  A terminal drop is now classified by its close code: an outright refusal is
  final with no reconnect, while any other drop — a server restart included —
  re-attaches as before.
- عاد حقل لصق رمز كلود ظاهراً للمالك بعد أن كان محجوباً عنه، فصار بإمكانه إكمال
  الربط الذي يبدأه `claude setup-token` ولا يحفظ رمزه. ويوضّح مودال الربط أن
  الخطوتين لازمتان، والأمر المعروض صار هو الأمر المُشغَّل فعلاً. /
  The Claude token paste field is visible to the owner again after being hidden
  from them, so an owner can finish the link that `claude setup-token` starts
  but never stores. The link modal states that both steps are required, and the
  command shown is now the command actually run.
- لم يعد رمز الاشتراك يُحدَّد افتراضاً لأي موضع؛ واختيار موضع يستدعي تحذيراً
  أحمر يسمّي ذلك الموضع، ومن لا يملك صلاحية الكتابة يُخبَر قبل إنفاق الرمز الذي
  يُستعمل مرة واحدة. /
  A subscription token is no longer preselected into any slot; ticking a slot
  raises a red warning that names it, and a user without write permission is
  told before the one-time token is spent.
- لم يعد جسم استجابة 409 من `applicationWriterLeaseMiddleware` يُعيد
  `update_writer_unavailable`، بل يُعيد رمز السبب الفعلي من البوابة. لا مستهلك
  في `src/` أو `server/` أو `scripts/` كان يقرأ تلك القيمة. /
  fix(update-gate): the 409 body from applicationWriterLeaseMiddleware no longer
  returns update_writer_unavailable; it now returns the gate's actual reason
  code. No consumer in src/, server/ or scripts/ read that value.
- صار غلاف HTTP يميّز رفض البوّابة عن خطأ المسار، فلم يعد الاثنان يظهران
  للمستخدم بالمعنى نفسه. / The HTTP wrapper now distinguishes a gate refusal
  from a route error, so the two no longer read alike to the user.
- جميع أسطح الرفض الخمسة تصنّف الآن عبر مساعد واحد؛ رموز البوّابة المركَّبة
  تُعرَف كرفض بوّابة فعلي، فلم يعد الفشل العادي يُبلَّغ كأن «صيانة التحديث
  فعّالة»، مع بقاء كل رفض رافضاً؛ وحلقة إعادة محاولة استيعاب الاستخدام صار
  لها تراجع محدود (B-1253). / All five refusal surfaces classify through one
  shared helper; composed gate codes are recognised as genuine gate denials,
  so an ordinary failure is no longer reported as "update maintenance is
  active", while every branch still refuses. The usage-ingestion retry loop
  gets bounded backoff (B-1253).
- نص خطأ الخادم يُعقَّم قبل وصوله إلى لوح الطرفية (B-1253). / Server error
  text is sanitized before it reaches the terminal pane (B-1253).
- كتابة الاعتماد أو حذفه أو قراءة حالته لكلود وCodex وOpenCode كانت تتبع منحة
  فعّالة إلى شجرة المانح؛ الكاتب الآن يحلّ شجرة الطالب نفسه دائماً (B-1251). /
  A credential write, delete or status read for Claude, Codex and OpenCode
  followed an active grant into the grantor's tree; writers now always
  resolve the caller's own tree (B-1251).
- رمز اشتراك كلود يُرفض خادمياً (400) عبر حارس واحد مشترك في كل كاتب اعتماد
  غير كلود (B-1252). / A Claude subscription token is refused server-side
  (400) by every non-Claude credential writer through one shared guard
  (B-1252).
- مسبار التحقّق في الموصلات يرسل مفتاح الموصل إلى الطرف الثالث، فصار رمز
  اشتراك كلود يُرفض كمفتاح موصل قبل أي أثر؛ بادئة الرمز صارت تعريفاً واحداً
  في `shared/` (B-1252). / The connector verify probe sends the connector key
  to the third party, so a Claude subscription token is now refused as a
  connector key before any effect; the token prefix now has one definition
  in `shared/` (B-1252).
- نسبة المرحلة في لوحة المشروع صارت تُقرأ من مهامها وحدها لا من حالتها
  المكتوبة يدوياً؛ ومرحلة منتهية بمهام 60٪ لم تعد تُعرض 100٪ (T-1809). ومرحلة
  بلا مهام لم تعد تُسقَط من المتوسط الكلي، بل تُوزَن بحالتها (منتهية = 100،
  لم تبدأ = 0، قيد التنفيذ = مجهولة وتُستبعد) بصوت واحد في المتوسط، فالأرقام
  الكلية على لوحات فيها مراحل كثيرة لم تبدأ تنخفض إلى قيمتها الصادقة
  (B-1249). / A project board phase's percentage is now read from its own
  tasks, never its hand-written status; a phase marked done with 60% of its
  tasks complete no longer shows 100% (T-1809). A taskless phase is no
  longer dropped from the overall average, but weighed by its own status
  (done = 100, not started = 0, in progress = unknown and excluded) as one
  voice in the average — overall figures on boards with many not-yet-started
  phases move down to the truthful value (B-1249).
- المنسّق لم يعد يسقط إلى `cwd` عملية الخادم عندما يغيب جذر مشروع الجلسة؛
  جذر مجهول يعني ألا يُحقن شيء، وجذر جلسة صريح يفوز دائماً على
  `NASSAJ_COORDINATOR_REPO_ROOT` الذي لم يعد له أثر (T-1810، B-1250). / The
  coordinator no longer falls back to the server process `cwd` when a
  session's project root is unknown; an unknown root means nothing is
  injected, and an explicit session root always wins over
  `NASSAJ_COORDINATOR_REPO_ROOT`, which no longer has any effect (T-1810,
  B-1250).

### تغيّر / Changed

- صار لكل رفض بوّابة سطر تسجيل خادمي يسمّي سببه بعد أن كان صامتاً تماماً،
  مخنوقاً حتى لا يُغرق السجل أثناء انتقالات قفل التحديث. / Every gate refusal
  now has a server-side log line naming its cause, where before it was wholly
  silent, throttled so it cannot flood the log during update-lock transitions.
- صُنِّفت أسباب الرفض من قائمة رموز واحدة مُعلَنة تعيش مع البوّابة، يحرسها حارس
  انحراف يقرأ المصدر؛ ووُحِّد مستهلكو القائمة عليها بدل رموز يدوية غير موجودة. /
  Refusal reasons are classified from a single declared reason-code list living
  with the gate, watched by a drift guard that reads the source; its consumers
  are unified on that list instead of hand-written codes that do not exist.
- تُعقَّم بايتات التحكّم قبل إرسال أي نصّ إلى لوح الطرفية، ومنها `projectPath`
  داخل رسالة الترحيب. / Control bytes are stripped before any text is sent to
  the terminal pane, `projectPath` in the welcome message included.

### أُزيل / Removed

- حُذف مفتاح الترجمة `ownerNote` («اعتمادك مربوط تلقائياً») من اللغات التسع:
  كان يَعِد بربط تلقائي أُلغي بـADR-105/B-486، فصار نصّاً كاذباً يصرف المالك عن
  إكمال الربط يدوياً. / The `ownerNote` translation key ("your credential is
  linked automatically") is deleted from all nine locales: it promised an
  auto-link revoked by ADR-105/B-486, so it had become a false statement that
  steered the owner away from completing the link by hand.

### حدود الإصدار / Release limits

- تجميع استيعاب الاستخدام قد يتوقف حتى إعادة التشغيل إن تجاوز التحديث انتظار
  البوّابة أثناء تفعيل `USAGE_INGEST_BACKFILL=on` (B-1254). / Usage-ingestion
  backfill may stop until a restart if an update outlasts the gate wait while
  `USAGE_INGEST_BACKFILL=on` (B-1254).

## [2.1.0.0] — Public page content published outside the Nassaj tree (2026-09-18)

Release following the published `2.0.0.0`. The feature segment advances because
the public page content publication mechanism is a new feature; the fix and
build segments reset under `architecture.feature.fix.build`. Node activation
remains a separate per-node owner action.

### أُضيف / Added

- T-1798: جذر محتوى عام خارج شجرة التطبيق من `NASSAJ_PUBLIC_CONTENT_ROOT` أو
  `$XDG_DATA_HOME/nassaj-dev/public-content`، مع رفض أي جذر داخل جذر التطبيق
  حتى تفشل الميزة مغلقة بدل إعادة زرع `dist`. / T-1798: an external public
  content root from `NASSAJ_PUBLIC_CONTENT_ROOT` or
  `$XDG_DATA_HOME/nassaj-dev/public-content`; a root inside the application
  root is refused so the feature fails off instead of recreating the `dist`
  planting it replaces.
- T-1799: `scripts/public-page-publish.mjs` للنشر والتراجع والسحب والاستعادة
  والسرد على `bundles/<id>/<revision>/` و`pointers/<id>.json`
  و`tombstones/<id>`، مُسلسلة بقفل النواة القائم؛ النسخة معنونة بالمحتوى ولا
  تُعدّل، ولا يظهر إلا تبديل المؤشر. / T-1799: publish, rollback, withdraw,
  restore and list over `bundles/<id>/<revision>/`, `pointers/<id>.json` and
  `tombstones/<id>`, serialized by the existing kernel flock; a revision is
  content-addressed and never mutated, and only the pointer rename is visible.
- T-1800: خدمة عرض تُركَّب قبل `express.static(dist)` في صندوق رملي بلا
  `allow-same-origin`، بلا إصدار `Service-Worker-Allowed` أبداً، ولا تخدم شيئاً
  عند جذر الأصل؛ تقرأ كل مقطع بـ`O_NOFOLLOW` وتطابق sha256 للبايتات المعادة
  مع manifest. / T-1800: a serving path mounted before `express.static(dist)`,
  sandboxed without `allow-same-origin`, never emitting
  `Service-Worker-Allowed`, serving nothing at the origin root, reading every
  segment with `O_NOFOLLOW` and matching the sha256 of returned bytes against
  the manifest.

### تغيّر / Changed

- وُسِّعت قاعدة معرّف قفل النشر إلى `isPublicationId` المشتركة لتغطي منشورات
  الـslug إضافة إلى بصمات مشاركة المستندات. / The publication lock's id rule is
  widened to the shared `isPublicationId`, covering slug publications as well
  as document-share hashes.

## [2.0.0.0] — Governed public pages and collaboration improvements (2026-09-17)

Release following `1.48.0.6`. The architecture segment
advances because T-1796 introduces a governed public-pages domain foundation;
subordinate segments reset under `architecture.feature.fix.build`.
Node activation remains a separate per-node owner action.

### أُضيف / Added

- T-1796: أساس نطاق صفحات عامة مستقل: صفحة شعار ثابتة وخدمة عرض مستقلة،
  وقارئ محدود الصلاحيات وقفل نشر على مستوى النواة؛ لا يشمل ناشراً عاماً
  مكتملاً أو منح/سحب الوصول. / T-1796: the foundation of an independent
  public-pages domain: a static logo page and standalone serving service, a
  bounded reader, and a kernel-level publication lock; it does not include a
  complete public publisher or access grant/revoke flows.
- مشاركة مستندات بين الأدوات ومعاينات HTML معزولة بعمليات فرعية محدودة. /
  Cross-harness document sharing with isolated HTML previews in bounded child
  processes.
- تذكير دفع الالتزامات بجوار المشروع عندما تتقدم الالتزامات المحلية على
  upstream المعروف محلياً. / A pending-push reminder when local commits are
  ahead of the locally known upstream.

### تغيّر / Changed

- أُتيحت تبويبات الشريط الجانبي الثلاثة لكل مستخدم موثّق. / All three sidebar
  navigation tabs are available to every authenticated user.
- عُرّبت أوامر slash وقويت أسماؤها البديلة وتوجيه الجلسة. / Slash commands are
  localized for Arabic, with hardened aliases and session routing.

### أُصلح / Fixed

- استعاد Codex إحصاءات التكلفة وقراءة استخدام السياق الأصلي بدلاً من حجم
  إدخال آخر طلب. / Codex cost statistics and native context usage are restored
  instead of treating the last request input size as context.
- صار شريط سجل المحادثة غير المتاح قابلاً للتشخيص والتعافي التلقائي، وحُجزت
  الأوامر الجانبية المشوهة بأمان. / The unavailable conversation-history
  banner is diagnosable and auto-recovers; malformed side commands are safely
  reserved.

### أُزيل / Removed

- لا تدخل قائمة الإجراءات الجماعية في الشريط الجانبي: التزاماتها عُكست ولا
  أثر فعّال لها في الإصدار. / The sidebar bulk-actions menu is excluded: its
  commits were reverted and have no effective release change.
- لا تدخل مسارات تثبيت وتحديث أدوات CLI من واجهة المالك: أُزيلت من الإصدار.
  / Owner-initiated CLI installation and update flows are excluded: they were
  removed from the release.

## [1.48.0.6] — Reliable update retries (2026-09-16)

### أُصلح / Fixed

- يبدأ زر إعادة المحاولة مهمة تحديث جديدة بعد الفشل الطرفي، بدلاً من تمرير
  التأكيد إلى مسار مخصص حصراً لمرشح ينتظر إعادة التشغيل؛ وبذلك لا تبقى رسالة
  البناء القديمة معروضة دون أي طلب جديد (B-1218). / Retrying a terminally
  failed update now starts a distinct update job instead of routing consent to
  the restart-confirmation path, so a stale build failure can no longer absorb
  the owner's retry without creating a request (B-1218).

### حدود الإصدار / Release limits

- لا ترحيل لقاعدة البيانات ولا تغيير في إعدادات العقد. نُفذ تمهيد حزمة
  المشغّل للعقد القديمة كإجراء تشغيلي مستقل (B-1219)، وليس كتعديل بيانات ضمن
  هذا الإصدار. / No database migration or node-configuration change. The old
  nodes' updater-runtime bootstrap was a separate operational repair (B-1219),
  not a data mutation shipped by this release.

## [1.48.0.5] — Deterministic release-asset permissions (2026-09-15)

- طُبّعت صلاحيات ملفات إغلاق ترحيل قاعدة البيانات قبل قياس عقد الحزمة، فلا
  يغيّر جامع الأصول البصمة بعد حسابها عندما يكون `umask` للباني `0002`
  (B-1217). / Canonicalized database-migration closure modes before measuring
  the release contract, preventing the asset collector from changing its own
  measured identity under a `0002` builder umask (B-1217).
- يتضمن هذا البناء إصلاحي توافق npm 12 وهوية مصدر كبسولة OID من دورة
  `1.48.0.4` غير المنشورة. / Includes the npm 12 and OID capsule-source
  identity fixes prepared in the unpublished `1.48.0.4` cycle.

## [1.48.0.4] — npm 12 candidate-build compatibility (2026-09-15)

### أُصلح / Fixed

- طُبّعت 25 وصلة tarball قديمة في `package-lock.json` من
  `registry.npmmirror.com` إلى `registry.npmjs.org`؛ بذلك لا يعود npm 12 يرفض
  بناء مرشح التحديث بالخطأ `EALLOWREMOTE` (B-1215). أضيف حارس يمنع عودة مضيف
  تنزيل غير قياسي، بلا تغيير إصدارات الاعتماديات أو بصمات تكاملها. / Normalized
  25 stale tarball URLs to the canonical npm registry so npm 12 no longer aborts
  update-candidate installation with `EALLOWREMOTE`; a regression guard rejects
  future non-canonical lockfile download hosts without changing dependency
  versions or integrity hashes (B-1215).
- أُدخل مصدر كبسولة OID ضمن مدخلات بصمة بناء الخادم، فلا يرفض المتحقق إغلاق
  الكبسولة لأنه غير ممثل في manifest البناء (B-1216). / Included the authored
  OID capsule source in the server build fingerprint, so closure verification no
  longer rejects a source omitted from the immutable input manifest (B-1216).

## [1.48.0.2] — Predecessor-compatible updates and bounded connector provisioning (2026-09-15)

### أُصلح / Fixed

- صارت حاضنة التحكم المبنية تستخدم محمّل `node:process` المسموح به لجلب SQLite، مع حارس لا يقبل إلا `node:sqlite` حرفياً. بذلك يستطيع محدّث `v1.47.0.18` على Node 24 قبول المرشح وبناءه بدلاً من إسقاطه بعد اكتمال بناء العميل (B-1211). / The built control capsule loads SQLite through the predecessor-admissible `node:process` bridge, while the current verifier permits only the literal `node:sqlite` lookup. A Node 24 node on `v1.47.0.18` can therefore admit and build the candidate (B-1211).

### أُضيف / Added

- أضيفت آلة حالات دائمة، ومسارات مالك محمية، وجداول فارغة إضافية لتجهيز موصلات DCR في التثبيتات الجديدة فقط (ADR-162). تفشل مغلقةً عند غياب الثقة أو إثبات الأصل أو قناة DCR، وتحفظ الأثر غير المحسوم للمصالحة اليدوية دون تكراره. / Added a durable state machine, owner-protected routes, and additive empty persistence for supported DCR provisioning on genuinely new installations only (ADR-162). Missing trust, origin proof, or DCR channels fail closed; uncertain external effects require manual reconciliation and are never repeated automatically.

### حدود الإصدار / Release limits

- لا تغيير في الواجهة، ولا تفعيل إنتاجي تلقائي، ولا دعم جديد لـGoogle أو Canva أو BYO، ولا تعديل للتثبيتات القائمة. تفعيل كل عقدة مستقل عن نشر GitHub. / No UI change, automatic production activation, Google/Canva/BYO expansion, or retroactive eligibility for existing installations. Per-node activation remains separate from GitHub publication.

## [1.48.0.1] — PM2 supervisor recovery and no-spawn liveness monitoring (2026-09-15)

### أُصلح / Fixed

- لم يعد مرصاد الحياة يستدعي `pm2 pid` أو `pm2 jlist`؛ يأخذ PID الخادم من استجابة `/health` الموثوقة ويستخدمه فقط لإبقاء core dumps معطلة. بذلك لا يستطيع فحص القراءة إنشاء عفريت PM2 ثانياً عند غياب ملف PID أو المقبس. / The liveness monitor no longer calls `pm2 pid` or `pm2 jlist`; it takes the server PID from the trusted `/health` response solely to retain the core-dump limit, so a read-only probe cannot spawn a second PM2 daemon when control state is absent.
- أضيف حارس اختبار يمنع عودة استدعاءات PM2 المنشئة للعفريت إلى المرصاد. / A regression guard rejects daemon-spawning PM2 reads in the monitor.
- أُعيدت مزامنة حاضنة اختبار ذاكرة Codex مع مصنّف سياق الإقلاع، وحُدّث جرد كتّاب قاعدة البيانات إلى بصمة migration الحالية، لكي تقيس بوابة الإصدار الكود الفعلي بدل أن تفشل على مراجع قديمة. / The Codex memory harness now loads the current bootstrap-context classifier, and the database-writer inventory matches the current migration digest and line map, so the release gate measures current code instead of stale references.

### حدود الإصدار / Release limits

- لا ترحيل قاعدة بيانات ولا تغيير في واجهات المستخدم. تفعيل كل عقدة وإعادة تشغيلها يبقيان عمليتين مستقلتين عبر المسار المحكوم. / No database migration or UI change; per-node activation and restart remain separately governed operations.

## [1.48.0.0] — Unified updates, context visibility, and release hardening (2026-09-14)

أعاد المالك قبول النطاق الشامل وأكد اكتمال التخزين المؤقت. يشمل الإصدار كل الالتزامات من `v1.47.0.18` حتى وسم `v1.48.0.0`، بما فيها `7855652d5` وأعمال الكاش وإغلاق حاضنات الإصدار النهائية وإصلاحا استعادة إعادة التشغيل وطابورها. لا يشمل أي تغييرات غير ملتزمة بعد الوسم.

The owner restored comprehensive scope and confirmed cache completion: 56 commits from stable v1.47.0.18 to the fixed endpoint above, including context/cache work and final release-fixture closure. Uncommitted work and this documentation update are outside the snapshot.

### أُضيف / Added

- التحديث بأجيال العميل والخادم والاعتماديات، روابط مشاركة المستندات، ونشر عميل التطوير المتحقق منه ضمن `button-only` (off). / Complete-generation updates, document sharing and verified development publication with policy off.
- مؤشر مستقل لإعادة استخدام التخزين المؤقت الأصلي؛ سلسلة `8f858749f` و`006ced98b` و`fb4016494` و`7a7bdd41e`. / Independent native cache-reuse indicator and its policy, threshold fix and acceptance evidence.

### تغيّر / Changed

- سياسة ترقيم `architecture.feature.fix.build`، ودلالات استهلاك السياق والتنبيهات، ونسبة swap وألوان الموارد. / Four-part version semantics, native context usage/alerts, swap percentage and resource colors.

### أُصلح / Fixed

- التعافي بعد إعادة الاتصال، وحصة المشاركة، وضوابط التحديث والإقلاع، وحاضنات الإصدار وترتيب الاستيرادات؛ عتبة متابعة Claude محفوظة عند 250 ألف رمز. / Reconnect recovery, sharing quota, update/startup guards, release fixtures and imports; Claude continuation threshold remains 250k.

### دليل القبول وحدوده / Acceptance evidence and limits

- T-1777: قبول المصدر وQA واختبارات محددة، وبناء العميل والخادم ناجح على اللقطة السابقة `7a7bdd41e`؛ `liveUnchanged=true`. التفعيل محجوب بـ B-1193. / Cache source/QA and bounded checks accepted; client/server build-only passed at the earlier 7a7bdd41e snapshot, live unchanged and activation blocked.
- قبول النطاق لا يغلق بوابات الإصدار أو يحول المهام المحجوبة إلى مكتملة. أدلة البناء وبوابات القبول وخطة كل عقدة في [الحصر الشامل / full inventory](docs/releases/1.48.0.0.md). / Scope acceptance does not close release gates or blocked tasks; see the full inventory for build identities and node rollout conditions.

### إصلاحات التحضير قبل التجميد / Pre-freeze preparation fixes

- `da3a9c93d`: إغلاق B-1180 بجرد 138 موقعًا و13 اختبار mutation؛ `ecfe82801`: إغلاق B-1194 وحاضنة الأمان 24/24. / Permission inventory resolved with 138 sites and 13 mutation checks; security harness resolved with 24/24 passing.
- `68c8503b5`: lint صفر أخطاء و459 تحذيرًا، واختبارات الواجهة 3,754/3,754 وفحص أنواع العميل والخادم وقبول QA. / Preparation lint, all client tests, both typechecks and QA passed.
- `f14b03e19`: إغلاق B-1190 بربط Sharp المحدد لمسار forward فقط؛ actual 8/8 وprofile 49/49 وقبول QA. / Exact forward-only Sharp startup binding accepted with actual/profile checks and QA.
- `6708cb091` و`48a43ca37` و`45d0a6222`: تثبيت نشر جاهزية bootstrap ذريًا، ومواءمة حاضنات الخادم مع عقود التشغيل الحالية، وعزل حاضنات الطرفية والتحقق من إيصالات التراجع. / Atomically publish bootstrap readiness, align server fixtures with current runtime contracts, and isolate terminal fixtures while verifying rollback receipts.
- يخضع المرجع النهائي لاختبارات الإصدار والبناء المحلي قبل نشر الوسم والحزم. تبقى B-1193 مرتبطة باكتشاف الإصدار والتفعيل بعد النشر، ولا يغلقها نشر GitHub وحده. / The final reference remains subject to release gates and a local build before publishing the tag and assets. B-1193 still requires post-publication discovery and activation evidence; GitHub publication alone does not close it.

## [1.47.0.18] — Installed nodes boot again after 1.47.0.17 (2026-09-12)

### Fixed

- B-1147: on an installed node the connector fence wraps `runMigrations` in a transaction, so the
  1.47.0.17 `source_update_jobs` rebuild ran `VACUUM INTO` and `BEGIN` inside it and every boot failed
  with `migration_backup_required`. The rebuild is now skipped inside the transaction and run right
  after the fenced block, idempotently. A node already held in `manual_recovery_required` still needs
  this release, `doctor --reopen-gate` and a safe restart.

## [1.47.0.17] — Update on consent, declared session deferral and a sealed node overlay (2026-09-12)

### Added

- The update button opens a consent window listing the release's main improvements; confirming it is
  the human approval, bound to the shown version (`consent.version`, `409 update_consent_mismatch`), and
  lets the safe restart run by itself once the node is idle, within 24 hours and without ending any
  session (T-1751, ADR-159).
- A live terminal log of the running update job, redacted of credentials and capped at 2 MiB (T-1768).
- "Prepare the update…" defers an update while sessions are live (`deferUntilIdle`, `awaiting_sessions`),
  promotes it after two idle samples, and can be cancelled; the deadline is
  `NASSAJ_UPDATE_DEFER_MAX_HOURS` (default 24) (T-1730, ADR-156).
- A sealed node overlay (`config/node-overlay.json`) serves a node's own static pages such as `/hub`
  from a root-owned seal, with an enforced CSP; `doctor --seal-overlay`, `doctor --explain-divergence`
  and `install-node --import-live-env` support it (T-1730).
- Owner screen to review and lift permission fences (T-1770).

### Changed

- The idle warning threshold follows each harness's cache lifetime, read from what Anthropic reports for
  Claude (T-1765); the agents bar is ordered by verified first generative releases (T-1760).
- Every update job runs the read-only preflight first, with new codes `node_overlay_invalid`,
  `node_overlay_mount_conflict` and `node_env_not_loaded` (ADR-156).

### Fixed

- Agent CLIs resolve outside the pm2 PATH (B-1138); sent messages drop trailing whitespace and blank
  lines (T-1769).
- Update-path hardening: handoff recovery and phase read-back (B-1125, B-1126, B-1127), an empty
  directory where a file installs is refused (B-1128), a degraded gate has an exit path, and the
  activation path's throws are covered (T-1728).

## [1.47.0.16] — Session idle warning, sturdier Claude stop and a real Settings dialog (2026-09-12)

### Added

- After 60 minutes with no message and no active stream, a banner below the last message states the
  current context size (`tokenBudget.used`, only when the provider has a token counter) and links to a
  clean new conversation; it hides on send or stream start (T-1764).
- A DeepSeek coming-soon tile with the official mark and no backend wiring; the agents strip is ordered
  by each company's first generative-AI release. Gemini is interim-hidden via `DISABLED_PROVIDERS`
  (T-1760/T-1761).

### Fixed

- STOP no longer hangs when `interrupt()` is never answered: it is raced against
  `CLAUDE_SDK_INTERRUPT_TIMEOUT_MS` (default 3000), then the CLI is force-stopped (B-1136).
- The control stream is held while CLI background tasks are pending and waits for the notification cycle
  after they end, so the next Agent/Task call is not cancelled with the human-refusal text; capped by
  `CLAUDE_SDK_BACKGROUND_HOLD_IDLE_MAX_MS` and `CLAUDE_SDK_CONTINUATION_WAIT_MS` (B-1120).
- Settings stays mounted across the 768px breakpoint and is a real dialog (focus trap and restore, Escape
  yielding to nested dialogs); vendors, connectors and references tabs are reachable; zoom is no longer
  blocked (B-466, B-557, B-559, B-560).
- Opening the DeepSeek tile no longer traps agent navigation (B-1133).
- A failed MCP config write removes the secret file it created, encoded paths decode, and the npx fallback
  root resolves in `dist-server` builds (B-532, B-533, B-1118).

## [1.47.0.15] — Project archive action and simpler observed skills (2026-09-11)

### Added

- The sidebar project context menu gains an Archive item with its own confirmation dialog and a handler
  that neither navigates away nor clears the selection; an agent launch registers the path with
  `preserveArchived` so an archived project stays hidden, while an explicit create-project still
  reactivates it (T-1756/B-1096).

### Changed

- Each observed skill is now one line — a status mark with the name, plus `xN` only when invoked more
  than once — like a tool call. The hash, agent call id, evidence source and timestamp are gone from the
  agent card and the participants panel, and their i18n keys were removed (T-1758).

## [1.47.0.14] — Update phase stepper and Claude CLI resolution (2026-09-11)

### Added

- The update modal shows a per-strategy phase stepper with a step counter and an error panel that maps
  each failure code to an Arabic and English title and hint (T-1748/T-1750).
- The update-job snapshot the client polls carries flat failure fields — `targetVersion`, `failedPhase`,
  `errorCode` and a sanitized message — beside the unchanged nested error object (T-1750).

### Changed

- Activation rollback, manual-recovery and recovery transitions record the reason code and failed phase
  as a hash-chained receipt, so a rolled-back job no longer reports a null cause (T-1750).
- The retired `release-layout-v2` update path is frozen behind the default-off `NASSAJ_UPDATER_RELEASE_LAYOUT`
  flag; a host that would resolve it returns `ready:false` with `release_layout_retired`. ADR-135 is
  superseded by ADR-141 (T-1750).

### Fixed

- Detecting the Claude Code CLI no longer depends on the launching shell's PATH: after a PATH miss the
  resolver probes the well-known install dirs, and detection and the managed terminal now share one
  runnable-executable criterion (B-1091).
- Free-text activation codes are demoted in the update modal, and phases completed before a failure are
  marked done instead of pending (T-1750).
- The permission launch inventory is regenerated so its recorded spawn-site line numbers match the
  candidate tree; no launch site was added or removed and the reviewed siteDigest is unchanged (B-1092).
- The new update-job snapshot tests no longer embed the operator home path, so the public-operations
  boundary gate passes on the release candidate (B-1093).

## [1.47.0.13] — Claude connection card and update progress (2026-09-11)

### Added

- The update modal shows a determinate progress percentage, and the bar fills from the inline start in RTL (T-1748).

### Fixed

- The settings Claude connection card reads the config dir the service resolves: the isolated dir under the isolated policy and the operator's dir under the shared policy (B-1087).
- The loaded-session participants text is hidden on single-account installs (B-1088).

## [1.47.0.12] — Chat and sidebar refinements, hardened publisher (2026-09-11)

### Added

- Thinking renders inline in the message when showThinking is ON, with no toggle row.
- Clicking the MergedCard header row toggles expand and collapse (T-1744).
- The sidebar update card is a single-row compact banner with a clearer hierarchy and standard dark tones.
- Smooth enter and exit animation for ActionMenu and every popup menu.

### Fixed

- Image and file user messages pair by folded-text receipt, the optimistic bubble retires by display id, and the user row binds to its send before the turn ends (B-1078).
- An empty model answer surfaces as an error instead of a blank overlay (B-1084).
- Every live client exchange is guarded against dropping the live base, and the prior inhibit is restored when the exchange guard refuses (T-1741, B-1059).
- The agent status card opens by default on every run (B-1077).
- The observed-skills section hides when the agent has zero skills, and the observation-limits disclosure is dropped (T-1742, T-1743).
- The sidebar project path wraps fully and the project context menu narrows to 190px; the message copy control folds into the metadata row.

## [1.47.0.11] — Claude terminal fence and credential linking (2026-09-11)

### Fixed

- Closing a managed Claude terminal tab no longer fences the user's `claude:spawn` scope: the launch broker records the wrapper identity at start and, on revoke, terminates the wrapper and settles `failed` once its death is proven, settling `reconciled_unknown` only for a wrapper that is provably still alive (B-1074).
- The token printed by `claude setup-token` can now be pasted into the Claude connection card and is stored as `CLAUDE_CODE_OAUTH_TOKEN` in the user's isolated `settings.json`; the connection status honours that key, so the card turns green without an operator copying credential files (B-1075).
- A delegated sub-agent prompt streamed by the SDK as a user message is folded into its container instead of rendering as a human turn, so it no longer resets the run timer or the turn boundary.
- The isolated client publisher is gated by lineage and the integration-branch HEAD (T-1740); a fixture session id in the sub-agent prompt test carries an explicit fixture name so the public boundary gate passes.
- The participants bar shows the observed-skills section compactly, like the agents list (T-1742).

## [1.47.0.10] — One-click update hardening (2026-09-11)

### Added

- Read-only update preflight with ten codes (`/api/system/update/preflight`) and `scripts/doctor.mjs --update-preflight`, which never exits 0 on an unverified run (T-1719, T-1720, ADR-156).
- Full node installer for a git-checkout install, release-source attestation with the installer's tofu pin, and a release-borne pm2 entry that calls the sealed launcher (T-1731, ADR-156).
- Reopen the maintenance gate on the previous generation with a named exit path, and the governed `doctor --reopen-gate` action (WI-12, WI-14).
- `/health` publishes the running build identity and a `degraded` signal; build detail moved behind auth.
- Assistant inline images from an `image` fence and real pixel crop of attached images (T-1737, ADR-157).
- Animated update progress while a job is in flight (T-1710); the local update test platform `scripts/update-lab` (WI-0).

### Fixed

- Updater cleanliness checks scoped to the release paths (B-1050).
- A gitlink change, a two-filesystem generation or a host without `mv --exchange` is refused before any write, so activation and rollback no longer fail together (B-1054, WI-11); the G1 gitlink exclusion gate is permanent.
- The update entry point stays visible while a release is prepared and is bound to the promoted build (B-1055).
- Abandoned restart rows are superseded under CAS instead of rebound; the attempt nonce is cleared on requeue and only deferred rows settle at boot (B-1056, B-1057).
- The terminal finds Claude in `~/.local/bin` when the server PATH lacks it (B-1058, T-1709).
- Public boundary violations that predate P1 cleared (B-1062); host memory measured by `MemAvailable` (B-1072).
- Sidebar collapse and session-row animations, `inert` on collapsed containers, jsdom `matchMedia`, alkindy contrast, the irukhaimi theme retint (T-1735), and header control placement.

### Documentation

- ADR-156 (one-click update) proposed and accepted under owner delegation; ADR-150 guide and the G1 gate header corrected: gitlink changes are refused before any write since WI-11.

## [1.47.0.9] — Server stability and conversation history (candidate, 2026-09-10)

### Fixed

- Conversations load again: the bounded history reader is opt-in via `NASSAJ_BOUNDED_HISTORY=1` and the full reader is the default (B-1025, T-1632).
- The atomic server publisher refuses to rotate `dist-server` while a non-terminal OID transaction exists (T-1683, root cause of B-1023).
- The server bootstrap recognizes PM2's fork container, so clean builds no longer start silently into 502 (B-1025).
- Catch-up migration for the Claude receipt identity columns and indexes that existed only in `CREATE TABLE` (B-1035).
- Attribute Opus turns to the final text row and keep the turn metric (B-1024).
- Codex image-only positional SDK patch and bounded receipt proof reader (B-990, B-996).
- OID adopted-live dispositions are reconciled and the preview consumer hardened (B-1032).
- A provider credential 401 no longer signs the member out (B-1043); the received-copies banner shows only after a refused admission (B-1042).
- Scheduled messages return an empty list for an unpersisted session instead of a load error.

### Added

- Context gauge alerts: pulse and card at 150K tokens, 200K tokens and one hour of session age, on every provider (T-1688).
- Bounded reader service seam with its envelope raised to the measured acceptance corpus, not activated (T-1632).
- `settled_at` history for pending server actions and `available_at` for scheduled messages (T-1684).
- Disk-retention tool with quarantine, caps and a daily timer; on-demand purge of old conversations (T-1686, T-1689).
- Member-to-member credential grants, cumulative cost totals, owner-confirmed force restart (T-1675, T-1676, T-1677).
- Deletion S1 substrate: guards, generation repository, writer inventory and platform protocol registry, behind its flag (T-1634).
- Durable outbox recovery hook and the ADR-122 unified-floor amendment (B-638, B-1034).
- Claude `/compact` dispatches at once from the slash menu, with a running-command bar and compaction note (T-1704).

### Changed

- Remove the UI plugins subsystem, orphan modules, dormant scripts and dead dependencies (T-1687).
- AlKindy theme: project-nav surfaces derive from the primary hue, structural dividers removed, popovers and dialogs use the page background (T-1695, T-1700, T-1703, T-1705).
- Local-build publication tooling (ADR-150) is part of the live tree; all workflows are dispatch-only.

### Notes

- Built locally under ADR-150 on 2026-09-11 and joins the v1.47.0.8 bridge history into main. This release carries the A outbox (`MAY_ACTIVATE_OUTBOX_V2=true`); the B floor is v1.47.0.8 (latest since 2026-09-09).
- Candidate scope only; the nassaj-dev live server runs clean build c6880d70 (commit add7fdc5). The command-board safe-restart stays blocked for hand-built candidates until OID 174 is settled (T-1678). See [release notes](docs/releases/1.47.0.9.md).

## [1.47.0.8] — Message repairs and outbox B compatibility (candidate, 2026-09-09)

### Fixed

- Hide confirmed-delivery outbox cards while retaining exact-proof protection (T-1648); remove the global composer cleanup control (B-1000).
- Include bounded Codex receipt/history repairs and internal goal-context matching fixes without text-only deduplication (B-983/B-995/B-996/B-997).
- Recover command outcomes from matching receipts, keep uncertain outcomes neutral, and fold older completed actions (B-986/B-998).

### Added

- Outbox B compatibility floor: read/write previously activated v2 storage without initiating v2 activation on new browsers.

### Changed

- Build and verify release assets locally, then upload them to GitHub without Actions builds or billing changes (ADR-150).

### Notes

- Candidate scope only; publication and fleet activation require separate verification. Local live A remains separate.
- Excludes corrected B-990 SDK activation, C0/C1, T-1634 deletion and UI changes held under T-1656. See [release notes](docs/releases/1.47.0.8.md).

## [1.47.0.5] — Fleet login and broker stability (unreleased)

### Fixed

- Provider login for Claude now runs `claude setup-token`; the removed interactive `/login` exited with code 64 under a PTY and never minted a token (upstreamed from the fleet-node node).
- The managed Claude launch broker no longer crashes the server with an unhandled EPIPE when a shim client resets before the authorization reply (upstreamed from the fleet-node node).
- Sidebar project rows no longer reserve empty space before project logos.

### Notes

- Supersedes `1.47.0.4` for fleet nodes whose local trees already carried the two fleet-node fixes; the updater's fast-forward rule requires a release that contains them.

## [1.47.0.4] — Urgent repair candidate (2026-09-06)

### Fixed

- Preserve original image-prompt whitespace in Codex history so authenticated sender matching remains exact.
- Initialize the installation-wide connector API-key profile before credential verification, preserving owner authorization.
- Show connector-pack expiry warnings to the owner.

### Review pending

- Execution generation fences (GENERATION_BLOCKED) are no longer lifted automatically on reboot; `scripts/permission-fence.mjs` is the audited operator recovery path (B-953, decision record `alkindy/decisions/b953-urgent-generation-fence-recovery.md`).
- Provider model-cache TTL changes and the latest committed sidebar refinements require their final readiness evidence.

This candidate does not publish local-forward activation assets or claim a completed host activation. Final release scope remains subject to the reviewed commit and clean-runner gates.

## [1.46.0.6] — Root-owned pinned Node release candidate (2026-09-01)

> `v1.46.0.6` supersedes the failed, unpublished `v1.46.0.2` through
> `v1.46.0.5` candidates. Their immutable tags remain at their reviewed
> commits as audit evidence; none has a GitHub Release, draft, or release
> assets.

### Added

- Added the governed, one-time migration path from legacy 1.44 source-tree
  nodes to the immutable Release Runtime, preserving local Git, supervisor,
  configuration, database, and rollback evidence.
- Added the manifest-bound database contract, exact compiled migration
  rehearsal, semantic preservation receipts, encrypted credential checks,
  verified backups, measured maintenance routing, durable recovery, and the
  standalone operator/recovery closure.

### Security

- Bound first-cutover approval and migration capability to the exact node,
  host, release asset, database, PM2, migration, dependency, and executable
  identities.
- Kept secrets out of arguments, environment variables, and receipts, and made
  cutover fail closed on identity drift, symlink substitution, unknown writers,
  incomplete rollback evidence, or mismatched health identities.

### Fixed

- Replaced the clean-runner setup-node symlink assumption with a root-owned,
  non-writable regular Node executable at `/usr/bin/node`; both Release and CI
  matrix workflows now materialize and verify the same pinned execution
  identity before tests.
- Made the real host-migration composition fixture consume that exact pinned
  executable and added negative coverage for digest tampering and raceable
  symlink aliases.
- Retained exact clean-runner server-candidate materialization, mandatory
  user-namespace preflight, and the deterministic JWT second-boundary coverage
  introduced by the preceding candidates.

### Operations

- Preserved explicit maintenance semantics: public `503` with `Retry-After`,
  fenced new work, proved zero live work, frozen writers, verified final backup,
  and `backup_restore_only` recovery after public-opening intent.
- Publication alone does not install operator support, migrate a database,
  change a supervisor, activate a generation, or restart a fleet node. Those
  remain separately authorized production operations per node.

## [1.46.0.5] — Failed unpublished candidate (2026-09-01)

> This immutable candidate tag never became a GitHub Release. Exact candidate
> materialization passed, then `test:scripts` failed all three real host-
> migration composition tests because setup-node's `process.execPath` did not
> satisfy the root-owned, non-symlink pinned-executable identity required by
> host operations. The workflow stopped before security, build, draft, asset,
> and publication stages. `v1.46.0.6` carries its payload and materializes a
> root-owned regular pinned Node executable in both Release and CI runners.

> `v1.46.0.5` had superseded the failed, unpublished `v1.46.0.2`,
> `v1.46.0.3`, and `v1.46.0.4` candidates. Their immutable tags remain at
> their reviewed commits as audit evidence; none has a GitHub Release, draft,
> or release assets.

### Added

- Added the governed, one-time migration path from legacy 1.44 source-tree
  nodes to the immutable Release Runtime, preserving local Git, supervisor,
  configuration, database, and rollback evidence.
- Added the manifest-bound database contract, exact compiled migration
  rehearsal, semantic preservation receipts, encrypted credential checks,
  verified backups, measured maintenance routing, durable recovery, and the
  standalone operator/recovery closure.

### Security

- Bound first-cutover approval and migration capability to the exact node,
  host, release asset, database, PM2, migration, and dependency identities.
- Kept secrets out of arguments, environment variables, and receipts, and made
  cutover fail closed on identity drift, unknown writers, incomplete rollback
  evidence, or mismatched health identities.

### Fixed

- Materialized clean-runner script tests through the exact reviewed server
  release-candidate builder in a fixed same-filesystem sibling, verifying the
  migration entry and commit/version/clean provenance before and after an
  atomic `mv --no-copy --no-clobber` promotion into an absent `dist-server`.
- Completed the clean-runner contract with a verified Node.js 24
  `/usr/bin/node` path, a mandatory exact user-namespace/`unshare` preflight,
  and the compiled server runtime required by release-script tests.
- Removed the B-164 second-boundary test race: refresh bursts are now exercised
  at many distinct milliseconds inside one fixed JWT second, while a separate
  boundary test proves standard `iat` and `exp` advance across seconds and the
  password-version `pwd_iat` fallback remains deterministic at zero.
- Clarified the production token contract without freezing JWT lifetime fields
  or weakening password-stamp invalidation.

### Operations

- Preserved explicit maintenance semantics: public `503` with `Retry-After`,
  fenced new work, proved zero live work, frozen writers, verified final backup,
  and `backup_restore_only` recovery after public-opening intent.
- Publication alone does not install operator support, migrate a database,
  change a supervisor, activate a generation, or restart a fleet node. Those
  remain separately authorized production operations per node.

## [1.46.0.4] — Failed unpublished candidate (2026-09-01)

> This immutable candidate tag never became a GitHub Release. Exact candidate
> materialization passed, then `test:server` failed one B-164 assertion because
> its real five-millisecond delay crossed a JWT second boundary: standard
> `iat`/`exp` correctly changed, making the byte-equality assertion flaky. The
> workflow stopped before security, build, draft, asset, and publication stages.
> Its payload and deterministic boundary test are carried by `v1.46.0.6`.

> `v1.46.0.4` had superseded the failed, unpublished `v1.46.0.2` and
> `v1.46.0.3` candidates. Both immutable tags remain at their reviewed commits
> as audit evidence; neither tag has a GitHub Release or release assets.

### Added

- Added the governed, one-time migration path from legacy 1.44 source-tree
  nodes to the immutable Release Runtime, preserving local Git, supervisor,
  configuration, database, and rollback evidence.
- Added the manifest-bound database contract, exact compiled migration
  rehearsal, semantic preservation receipts, encrypted credential checks,
  verified backups, measured maintenance routing, durable recovery, and the
  standalone operator/recovery closure.

### Security

- Bound first-cutover approval and migration capability to the exact node,
  host, release asset, database, PM2, migration, and dependency identities.
- Kept secrets out of arguments, environment variables, and receipts, and made
  cutover fail closed on identity drift, unknown writers, incomplete rollback
  evidence, or mismatched health identities.

### Fixed

- Replaced the clean-runner call to the live atomic server publisher with an
  exact test-only release candidate materializer. It builds through the same
  reviewed release-candidate function later used for packaging and never
  invokes the live publisher or its host resource-admission gate.
- Restricted materialization to a fixed same-filesystem sibling, required both
  candidate and `dist-server` to be absent, verified the compiled migration
  entry and exact commit/version/clean provenance before and after promotion,
  and used an atomic `mv --no-copy --no-clobber` rename.
- Added tests for occupied targets, malformed candidates, target races,
  candidate cleanup, fixed paths, move capabilities, workflow wiring, and the
  absence of resource-wait or bypass behavior.

### Operations

- Preserved explicit maintenance semantics: public `503` with `Retry-After`,
  fenced new work, proved zero live work, frozen writers, verified final backup,
  and `backup_restore_only` recovery after public-opening intent.
- Publication alone does not install operator support, migrate a database,
  change a supervisor, activate a generation, or restart a fleet node. Those
  remain separately authorized production operations per node.

## [1.46.0.3] — Failed unpublished candidate (2026-09-01)

> This immutable candidate tag never became a GitHub Release. Its workflow
> stopped while materializing clean-runner prerequisites because the live
> atomic server builder correctly deferred at the 80% host resource ceiling,
> before quality, security, build, draft, asset, and publication stages. Its
> payload and the exact candidate-materialization correction are carried
> forward by `v1.46.0.6`.

> `v1.46.0.3` had superseded the failed, unpublished `v1.46.0.2` candidate. The
> immutable `v1.46.0.2` tag remains at its reviewed commit as audit evidence;
> its workflow failed in `test:scripts` on a clean runner before the security,
> build, draft, asset, and GitHub Release stages ran. No GitHub Release was
> created for that tag.

### Added

- Added the governed, one-time migration path from legacy 1.44 source-tree
  nodes to the immutable Release Runtime, preserving local Git, supervisor,
  configuration, database, and rollback evidence.
- Added the manifest-bound database contract, exact compiled migration
  rehearsal, semantic preservation receipts, encrypted credential checks,
  verified backups, measured maintenance routing, durable recovery, and the
  standalone operator/recovery closure.

### Security

- Bound first-cutover approval and migration capability to the exact node,
  host, release asset, database, PM2, migration, and dependency identities.
- Kept secrets out of arguments, environment variables, and receipts, and made
  cutover fail closed on identity drift, unknown writers, incomplete rollback
  evidence, or mismatched health identities.

### Fixed

- Made the release workflow materialize and verify clean-runner prerequisites
  before `test:scripts`: a pinned Node.js 24 path, usable unprivileged user
  namespaces, the compiled server migration closure, and exact clean build
  provenance for the candidate commit and version.
- Added workflow-contract tests that reject attempts to skip or soften those
  prerequisites with `continue-on-error`, conditional skips, or `|| true`.

### Operations

- Preserved explicit maintenance semantics: public `503` with `Retry-After`,
  fenced new work, proved zero live work, frozen writers, verified final backup,
  and `backup_restore_only` recovery after public-opening intent.
- Publication alone does not install operator support, migrate a database,
  change a supervisor, activate a generation, or restart a fleet node. Those
  remain separately authorized production operations per node.

## [1.46.0.2] — Failed unpublished candidate (2026-09-01)

> This immutable candidate tag never became a GitHub Release. `test:scripts`
> reported 12 clean-runner failures: nine could not open the absent compiled
> `dist-server/server/scripts/release-database-migration.js`, two systemd
> contract tests found `/usr/bin/node` absent, and one user-namespace identity
> test received `EPERM` while opening `uid_map`. The workflow stopped before
> security, build, draft, asset, and publication stages. `v1.46.0.6` carries
> the reviewed payload plus the verified Node.js 24 path, mandatory exact
> user-namespace preflight, and compiled runtime corrections.

### Added

- Added a one-time, operator-run migration path for legacy 1.44 nodes that
  preserves the original Git tree, PM2 evidence, configuration, and database
  while preparing the immutable Release Runtime outside the live source tree.
- Added a manifest-bound 1.44 database contract, exact compiled migration
  rehearsal, canonical schema digest, semantic preservation receipts, encrypted
  credential verification, and verified `VACUUM` backups.
- Added a root-owned measured host dispatcher, fixed maintenance responder,
  early-boot gate restoration, durable recovery journal, and separately
  installable operator/recovery support in the standalone installer bundle.

### Security

- Bound every first-cutover approval to the node, host, release asset, database
  migration, and PM2 identities with a short-lived Ed25519 owner signature.
- Kept decryption material out of argv, environment variables, and receipts by
  passing it through a bounded file descriptor to the exact migration process,
  run as the service uid under a capability bound to the database contract and
  migration closure.
- Made the cutover fail closed on identity drift, unknown database writers,
  unverified maintenance routing, incomplete rollback evidence, or mismatched
  private/public health identities.

### Operations

- Replaced the broken legacy retry model with an explicit maintenance
  transaction: public traffic receives a measured `503` with `Retry-After`, new
  work is fenced, zero live work is proved, writers are frozen, the final backup
  is verified, and only then may the stable launcher replace the old supervisor.
- Classified the 1.44 to 1.46 database transition as `backup_restore_only`.
  Automatic rollback is permitted only before public-opening intent; after that
  durable boundary the transaction enters manual recovery rather than risking
  the loss of new public writes.
- Kept the reviewed dependency tree intact between release-candidate creation
  and asset packaging, avoiding a post-build prune that could change the input
  closure after the quality gate.
- This release publication does not install operator support, modify a
  supervisor, migrate a database, activate a generation, or restart any fleet
  node. Each of those production operations remains separately authorized for
  each individual node, and future button updates are supported only after that
  node proves `updateReady=true` with `artifact-runtime-v2`.

## [1.46.0.1] — Portable updates and measured execution permissions (2026-09-01)

> `v1.46.0.1` supersedes the unpublished `v1.46.0.0` candidate. The earlier
> immutable tag remains at its reviewed commit as audit evidence; its workflow
> failed in the server quality gate before any draft, assets, or GitHub Release
> were created.

### Added

- Added a standalone, no-Git/no-npm release-runtime installer with pinned
  release identity, runtime compatibility checks, an immutable generation
  layout, and a fail-closed launcher outside release generations.
- Added a server-authoritative execution-permission slice, including measured
  Claude and Codex parity, runtime admission, capability inventories, durable
  permission records, and release-bound runtime identity.

### Changed

- Release automation now builds on Node.js 24 and publishes the runtime archive,
  manifest, standalone installer, and checksum as one verified asset set.
- Enclosed provider, workflow, command, Git, SSE, and WebSocket execution
  surfaces behind the measured permission policy and explicit actor identity.
- Improved the conversation cost breakdown so long model names remain readable,
  usage details have their own row, the dialog has a visible accessible title,
  and focus returns to the cost chip after closing.

### Security

- Bound installer downloads to one stable GitHub release, tag commit, asset ids,
  sizes, and digests; hardened redirects and temporary credential handling so
  tokens do not enter command arguments, logs, or receipts.
- Made permission admission fail closed on binary drift, unknown reconciliations,
  invalid runtime identity, unsupported bodies, and unclassified launch forms.

### Operations

- Installation prepares and verifies a release generation but does not activate
  it, restart a service, migrate a database, or overwrite host-local Git work.
  Fleet migration and activation remain separately approved operations.
- Restored the full release quality gate after measured permission admission
  exposed stale WebSocket dispatch harnesses, migration rerun handling, provider
  model fallback assumptions, and release-runner fixtures. The corrected gate
  passed 4,559 server tests with zero failures before this replacement candidate.

## [1.44.0.0] — Atomic builds, delegation, and wiki updates (2026-08-19)

### Added

- Added a persisted per-message delegation level, including provider capability
  checks, WebSocket attribution, conversation controls, and an in-chat badge.
- Added disk usage to hardware statistics.
- Added team-wiki release updates and a cumulative AI-news digest, together
  with a tested digest runner. Native in-product scheduling remains a separate,
  not-yet-activated feature.
- Added proposed bilingual UI control-sizing standards, an audit tool, and a
  versioned audit baseline.

### Fixed

- Published staged server artifacts atomically after validating compiled alias
  resolution through the AST, including supported esbuild wrapper metadata.
- Raised the Vite heap available to atomic client publishing.
- Restored Codex subagents in the actor roster and exposed all session models.
- Restored live session indicators and improved new-chat navigation, sidebar
  footer layout, and closed-session status placement.
- Consumed delivery verdicts at WebSocket ingress so delayed control events do
  not corrupt the client outbox state.
- Applied the configured primary theme color to user-message bubbles.

### Documentation

- Reviewed and corrected team-wiki wording, translations, and navigation.
- Recorded the operational handoff for the private update channel.

### Operations

- This private source release does not deploy, migrate, schedule background
  tasks, or restart the live service; those remain separately approved
  operations.

## [1.42.0.5] — Node 22 CI compatibility fix (2026-08-17)

### Fixed

- Converted every mock in the login timing fixture to the Node 22
  `namedExports`/`defaultExport` contract used by GitHub Actions.

## [1.42.0.4] — Clean-runner verification fix (2026-08-17)

### Fixed

- Removed hidden CI dependencies on a developer-installed Claude executable,
  inherited `XDG_CONFIG_HOME`, and an inherited private deploy-root variable.
- Made OpenCode governance fixtures own both HOME and XDG configuration paths.
- Kept terminal tests on mocked PTYs while using the Node executable only as an
  inert managed-launcher preflight fixture.
- Restored the login timing fixture on the Node 22 module-mocking API used by
  GitHub Actions.

## [1.42.0.3] — Source-tree and CI consolidation (2026-08-17)

### Fixed

- Preserved the current live-source changes while restoring compatibility with
  the complete isolated server and client verification suites.
- Restored `clientMsgId` propagation for OpenCode WebSocket messages, including
  the dedicated OpenCode dispatch path.
- Made OpenCode governance and direct MCP paths respect an explicitly isolated
  `HOME`, preventing host credentials and persisted catalogs from leaking into
  tests or per-user execution.
- Updated stale database, provider, release, and governance fixtures to match
  the current fail-closed production contracts without weakening those gates.

### Documentation

- Added the owner-approved progress-update rule to the team wiki using the
  repository's Western-digit prose convention.

## [1.42.0.2] — Android APK verification fix (2026-08-17)

### Fixed

- Switched APK metadata verification from the unsupported `aapt2 dump badging`
  command to the Build Tools `aapt dump badging` command and made the inspected
  metadata visible in CI diagnostics.

## [1.42.0.1] — Android wrapper build fix (2026-08-17)

### Fixed

- Replaced an invalid nullable `WebViewClient` assignment in the Android
  renderer-loss cleanup path, restoring Kotlin compilation while still
  releasing the Activity-capturing client before `WebView.destroy()`.

## [1.42.0.0] — Live-source consolidation (2026-08-17)

### Added

- Preserved the owner-approved live chat, sidebar, settings, provider, theme,
  RTL, and conversation-fork work in one reviewed source release.
- Added independent public source and public release-channel configuration;
  the private runtime Git remote is never exposed to the browser.
- Added governed exact four-part release tooling, build provenance, pinned
  workflow actions, and substantive versioned release notes.

### Security

- Hardened credential and API-key storage, OIDC verification, Git transport,
  command-file reads, request body limits, and pre-migration backups.
- Replaced persistent API keys in SSE query strings with short-lived,
  single-use tickets bound to the user and endpoint.
- Replaced production-derived fixtures with representative synthetic data and
  excluded local databases, sidecars, backups, and operator handoffs from Git.

### Operations

- Kept `nassaj` as the product identity while making the live source process
  name `nassaj-dev` explicit and configurable across safe restart and monitors.
- Replaced raw `git pull` updates with an exact-tag, four-part-version updater
  that refuses dirty trees, active sessions, remote drift, and non-fast-forward
  targets, and never restarts the service automatically.
- This private source release does not deploy, migrate, or restart fleet nodes;
  those remain separately approved operations.


## [1.36.1.3] — Fix (2026-07-29)

### Fixed

- The previous fix seeded the empty wiki index for `build` and the client tests
  but not for `typecheck`, so CI stayed red on every push with the same
  unresolvable import. `typecheck` now seeds it too.

## [1.36.1.2] — Fix (2026-07-29)

### Fixed

- `npm run build` failed on any checkout without the optional team-wiki content:
  the wiki module imports `docs/team-wiki/index.json` statically, so vite could
  not resolve the module at all and the error read like a code fault rather than
  a missing optional file. A deployed node sat on a half-built tree because of
  it. The build now seeds an empty, valid index when none is present (and never
  touches an existing one), so a fresh clone builds standalone.

## [1.36.1.1] — Fix (2026-07-29)

### Fixed

- The restart pre-flight gate failed with a configuration error whenever it ran
  from the server rather than from an operator's shell, so every "Server built —
  restart required" request in the command board came back as "An unexpected
  error occurred". The transcript-root fallback had been rewritten into a path
  that cannot exist; it is now derived from `$CLAUDE_CONFIG_DIR` when set and
  `$HOME/.claude` otherwise, with the first existing candidate winning and an
  explicit `WF_BASE` still overriding both. A regression test runs the gate under
  an isolated environment and asserts the derived path is a real one.
- A failing gate now reports its exit code, so an environmental failure is
  distinguishable from a genuine safety refusal instead of both reading as
  "unexpected error".

## [1.36.1] — Small feature (2026-07-29)

### Added

- Fork a side query into a real conversation. The semantics mirror "f to fork"
  in the CLI: the on-disk session transcript is branched under fresh
  identifiers, progress entries are dropped and children re-parented, sidechain
  entries are excluded, the origin is recorded as `forkedFrom`, and the question
  with its already-rendered answer is appended along with a "btw: ..." title
  line. No inference and no quota spend — the existing answer is reused.

## [1.36.0.1] — Fix (2026-07-29)

### Fixed

- The Docker-socket boot guard no longer refuses to start an ordinary install.
  The guard exists to stop an agent escaping to host root through
  `/var/run/docker.sock`, but it refused on ANY host whose service user is in
  the `docker` group — which is the normal state of a machine its owner also
  uses for Docker, and left deployed nodes dead until someone ran `sudo`.
  Detection is unchanged; the ACTION now follows a declared posture. By default
  the accounts on an instance are treated as operators of the host (they can
  reach the socket from their own shell anyway), so the finding is logged loudly
  and surfaced in the UI while the server boots. On an instance that serves
  untrusted users, set `NASSAJ_SECURITY_POSTURE=strict` and the original
  fail-closed refusal returns unchanged. Platform mode — where authentication is
  disabled — is always strict and no environment value can downgrade it.

### Added

- `npm run doctor`: a read-only preflight that checks the Node version, docker
  group membership, `.env` and its permissions, `JWT_SECRET` length, port
  availability, the database path, pruned devDependencies, build output and the
  `node-pty` binding — printing a ready-to-run fix for each finding.
- `GET /api/system/security-posture` (owner/admin): boot-time security findings
  that degraded to a warning instead of refusing to boot.

### Versioning

- The version scheme is now documented in CONTRIBUTING.md: `X.n` for a large
  batch of changes, `X.x.n` for a small feature, `X.x.0.n` for a bug fix.

## [1.36.0] — First public release (2026-07-29)

First release published from the public repository. The tree is now the tool
alone: operator-specific content lives outside it, and everything a deployment
needs is configuration rather than a shipped constant.

### New Features
- **Bundled neutral governance.** Governed CLI providers (Codex, Kimi, the
  OpenCode carrier) require a governance document at launch. A neutral default
  now ships at `server/governance/default-AGENTS.md` and is used when the
  operator has installed none, so a fresh checkout works out of the box.
  Install `~/.claude/AGENTS.md` to override it.

### Changed
- **Deployment values moved to configuration.** Public origins come from
  `ALLOWED_ORIGINS` (built-in defaults are localhost only); the source-repository
  link used for the AGPL-3.0 §13 notice comes from `VITE_SOURCE_URL`; the
  coordinator ground-truth root comes from `NASSAJ_COORDINATOR_REPO_ROOT`; the
  agent response-language rule comes from `NASSAJ_RESPONSE_LANGUAGE` and is
  omitted entirely when unset.

### Fixed
- Governed CLI launches no longer fail on a checkout that has no operator
  governance file. The gate remains fail-closed for a genuine materialization
  failure.


## [Unreleased] — B-80 WebSocket Session Resilience + Hide Fable (2026-06-23)

> توحيد خط تطوير نسّاج إلى `main` (ADR-043). التفاصيل: `docs/decisions/041-claude-live-replay-b80.md`، `docs/decisions/042-claude-ghost-session-detach-b80c.md`، `docs/decisions/043-git-topology-consolidation.md`.
> Consolidates the nassaj development line into `main` (ADR-043). Detail in the referenced ADRs.

### New Features

* **ws / sessions:** **live-stream replay (B-80a, ADR-041)** — إعادة الاتصال بـ WebSocket (تحديث الصفحة أو مشاهد جديد) تعيد بثّ الجلسة الجارية من `transcript.jsonl` بدل تجمّد الواجهة، مع احترام فيتو no-swap (B-N1). Reconnecting a WS client now replays the active session from `transcript.jsonl` instead of freezing the UI.

### Bug Fixes

* **ws / drain:** **ghost-session detach (B-80c, ADR-042)** — جلسة claude التي مات كل مستمعيها تُفصَل من حساب الـ`drain` (detach لا abort) خلف علم مطفأ، فلا تبقى محسوبة `active` وتمنع `pm2 restart` حتى `kill_timeout`. Detaches dead-listener ghost sessions from the drain count (behind a disabled flag), so they no longer block restarts.
* **models / chat:** **إخفاء `claude-fable-5` غير المُطلَق (ADR-044)** — النموذج غير المُطلَق يُستبعد من قائمة النماذج المعروضة وقوائم fallback مع إبقاء حارس auto/القيم الفاسدة. Hides the unreleased `claude-fable-5` from the model picker and fallback lists while keeping the auto/corrupted-value guard. (`server/modules/providers/list/claude/claude-catalog.client.ts`, `claude-models.provider.ts`, `src/constants/providerModelFallbacks.ts`)

### Tests

* add/extend `server/modules/providers/list/claude/__tests__/claude-catalog.test.ts`, `server/claude-sdk.model.test.js`. Full suite green at merge: **527 pass / 0 fail** (498 + 29).

### Infrastructure

* **git:** consolidate the nassaj dev line (`b63`, 360 commits) into `main` via merge-commit (no rebase/squash). The shallow local repo had masked the real gap. Policy: named work branches (no detached HEAD), isolated `/tmp` worktrees during parallel sessions, worktree cleanup after each workflow. (ADR-043)


## [1.33.0] — Model Selection Overhaul (2026-06-09)

> إصلاح وتحديث منظومة اختيار النماذج (Claude SDK + Antigravity). التفاصيل المعمارية في `docs/decisions/025-model-selection-overhaul.md`.
> Model selection overhaul (Claude SDK + Antigravity). Architectural detail in `docs/decisions/025-model-selection-overhaul.md`. Reviewed & approved by qa-critic.

### New Features

* **claude:** discover supported models dynamically via Claude Code SDK `query(...).supportedModels()` — replaces the hardcoded list. Isolated, side-effect-free probe (zero-turn async-generator prompt → no ghost jsonl session; temp cwd cleaned up; `close()` teardown) with circuit breaker, single-flight, and degraded fallback. Default is now **Opus 4.8**, and the newest model the subscription exposes (e.g. **Fable 5**) appears automatically. Adds stale-while-revalidate caching. (`server/modules/providers/list/claude/claude-catalog.client.ts`, `claude-models.provider.ts`, `provider-models.service.ts`)
* **agy:** dynamic Antigravity model selection — UI now lists the full catalog instead of a single `auto` option, and the server forwards the chosen model as `--model <label>` (translating UI `modelId` → display `label` from the cached catalog; no `--model` on `auto`/empty). (`src/components/chat/ProviderSelectionEmptyState.tsx`, `server/agy-cli.js`)

### Bug Fixes

* **chat:** fix `There's an issue with the selected model (auto)` crash on every send. Root cause: a stale `localStorage["claude-model"]="auto"` (leaked from Cursor models) passed unvalidated to the SDK, plus client-side sanitization that only ran on a successful catalog load. Adds server-side model validation in `mapCliOptionsToSDK` with an explicit `console.warn` fallback (no silent swap), a client mirror with `sanitizeStoredModel`/`sanitizeStoredProvider`, initial-read sanitization of localStorage, single-provider failure isolation, fallback-catalog use on load failure, and a status banner. Corrects `FALLBACK_DEFAULT_MODEL.claude` from `'opus'` to `'default'`. (`server/claude-sdk.js`, `src/constants/providerModelFallbacks.ts`, `src/components/chat/hooks/normalizeProviderModel.ts`, `src/components/chat/hooks/useChatProviderState.ts`, `src/components/CommandResultModal.tsx`)
* **chat:** fix Fable 5 being silently downgraded to Opus 4.8. Send-time validation now checks the **union** of the dynamic catalog (from `getProviderModels` cache) and the static list (`buildValidClaudeModelValues`), so models discovered dynamically are no longer rejected — while keeping the auto/corrupted-value guard. (`server/claude-sdk.js`)
* **chat:** fix the provider switcher disappearing when the active provider is antigravity — the `isAntigravity` branch in `ProviderSelectionEmptyState.tsx` rendered a read-only card with no way to reopen the picker. The clickable picker is now always shown. (`src/components/chat/ProviderSelectionEmptyState.tsx`)

### Tests

* add `server/claude-sdk.model.test.js`, `server/modules/providers/list/claude/__tests__/claude-catalog.test.ts`, `server/modules/providers/services/provider-models.service.test.ts`, `server/agy-cli.model.test.ts`, `src/components/chat/hooks/normalizeProviderModel.test.ts`.

### Notes

* Verification is done via the **nassaj-dev log** (absence of `model "<x>" not in CLAUDE OPTIONS; falling back` for valid models; for agy, presence of `Propagating selected model override to backend: label="..."`), **not** by asking the model its identity (unreliable). Deployment: UI (`dist/`) on browser refresh; server (`dist-server/`) requires `pm2 restart nassaj-dev`. Model cache: `~/.cloudcli/provider-models-cache.json` (TTL 3 days). Open follow-ups (non-critical) are tracked in ADR-025.


## [](https://github.com/siteboon/claudecodeui/compare/v1.32.0...vnull) (2026-06-01)

### New Features

* add opencode support ([#762](https://github.com/siteboon/claudecodeui/issues/762)) ([374e9de](https://github.com/siteboon/claudecodeui/commit/374e9de71934c41ce2c19c796e35a19234b240ec))
* **sidebar:** tooltip for the active-session indicator dot ([#782](https://github.com/siteboon/claudecodeui/issues/782)) ([27e509a](https://github.com/siteboon/claudecodeui/commit/27e509a9b8bb25c35ae0abbda44c536e15c332c8))

### Bug Fixes

* **chat:** prevent double send on mobile by removing redundant submit handlers ([#719](https://github.com/siteboon/claudecodeui/issues/719)) ([dbc41dc](https://github.com/siteboon/claudecodeui/commit/dbc41dc91dbf1fb54f92f5536d64646b4e924f31))
* preserve WebSocket frame type in plugin proxy ([#594](https://github.com/siteboon/claudecodeui/issues/594)) ([36b860e](https://github.com/siteboon/claudecodeui/commit/36b860e322454df62ebf5309018590b596e6b913)), closes [CoderLuii/HolyClaude#11](https://github.com/CoderLuii/HolyClaude/issues/11)
* refine token usage reporting ([#807](https://github.com/siteboon/claudecodeui/issues/807)) ([38bf21d](https://github.com/siteboon/claudecodeui/commit/38bf21ddf554ed28676d86b5221c25adf6f07afd))
* refresh Claude auth status after login flow ([#617](https://github.com/siteboon/claudecodeui/issues/617)) ([1e125f3](https://github.com/siteboon/claudecodeui/commit/1e125f3db5248399cd50dc3d40b1f8f44cf7ccb6))
* **sidebar:** keep session rename input visible while editing ([#781](https://github.com/siteboon/claudecodeui/issues/781)) ([951f587](https://github.com/siteboon/claudecodeui/commit/951f58751c152fbbb3f8b3ce3c814c06c061de18))

### Styling

* fix project star button location by replacing folder icon ([#793](https://github.com/siteboon/claudecodeui/issues/793)) ([295bad9](https://github.com/siteboon/claudecodeui/commit/295bad9c006b669878cbf52940794f29f7370178))

## [1.32.0](https://github.com/siteboon/claudecodeui/compare/v1.31.5...v1.32.0) (2026-05-13)

### Bug Fixes

* add clarification on auto mode ([392c73b](https://github.com/siteboon/claudecodeui/commit/392c73b6933600ea8a589c5d4eff5f7b830f99c5))
* enhance regex to correctly parse wrapper file paths for claude.exe ([#741](https://github.com/siteboon/claudecodeui/issues/741)) ([beb0a50](https://github.com/siteboon/claudecodeui/commit/beb0a50413beddfb16f6b49103e1b6b80567cb90))

## [1.31.5](https://github.com/siteboon/claudecodeui/compare/v1.31.4...v1.31.5) (2026-04-30)

### New Features

* add auto mode to claude code ([3f71d49](https://github.com/siteboon/claudecodeui/commit/3f71d4932b05dfedcdf816e2a3d7d0cd69c4f566))

## [1.31.4](https://github.com/siteboon/claudecodeui/compare/v1.31.3...v1.31.4) (2026-04-30)

### Bug Fixes

* bump codex sdk to latest version ([658421c](https://github.com/siteboon/claudecodeui/commit/658421c1c44ec4eb58b69ec7b1844a9fba11a3f3))

## [1.31.3](https://github.com/siteboon/claudecodeui/compare/v1.31.2...v1.31.3) (2026-04-30)

## [1.31.2](https://github.com/siteboon/claudecodeui/compare/v1.31.0...v1.31.2) (2026-04-30)

### Bug Fixes

* migrations for new sqlite schema ([0753c04](https://github.com/siteboon/claudecodeui/commit/0753c047837dab17b86ae4453027e30b465870f8))

## [1.31.0](https://github.com/siteboon/claudecodeui/compare/v1.30.0...v1.31.0) (2026-04-30)

### Bug Fixes

* **/status:** use CLAUDE_MODELS.DEFAULT instead of stale 'claude-sonnet-4.5' fallback ([#723](https://github.com/siteboon/claudecodeui/issues/723)) ([b4a39c7](https://github.com/siteboon/claudecodeui/commit/b4a39c729710a6294c62eb742e99e05f3e3914e9))

## [1.30.0](https://github.com/siteboon/claudecodeui/compare/v1.29.5...v1.30.0) (2026-04-21)

### New Features

* **i18n:** add Italian language support ([#677](https://github.com/siteboon/claudecodeui/issues/677)) ([86b6545](https://github.com/siteboon/claudecodeui/commit/86b6545c3505475ac2de0cec75cc8f86ab22aceb))
* **i18n:** add Turkish (tr) language support ([#678](https://github.com/siteboon/claudecodeui/issues/678)) ([89b754d](https://github.com/siteboon/claudecodeui/commit/89b754d186b68f3df8aa439a2d535644406066f0)), closes [#384](https://github.com/siteboon/claudecodeui/issues/384) [#514](https://github.com/siteboon/claudecodeui/issues/514) [#525](https://github.com/siteboon/claudecodeui/issues/525) [#534](https://github.com/siteboon/claudecodeui/issues/534)
* introduce opus 4.7 ([#682](https://github.com/siteboon/claudecodeui/issues/682)) ([c5e55ad](https://github.com/siteboon/claudecodeui/commit/c5e55adc89d0316675f90a927aa40d115958ae9f))

### Bug Fixes

* iOS scrolling main chat area ([3969135](https://github.com/siteboon/claudecodeui/commit/3969135bd427fbf48f29bb3dbfedb47791ca78dc))
* migrate PlanDisplay raw params from native details to Collapsible primitive ([fc3504e](https://github.com/siteboon/claudecodeui/commit/fc3504eaed8ca7ed9214838d148ea385b8352c31))
* precise Claude SDK denial message detection in deriveToolStatus ([09dcea0](https://github.com/siteboon/claudecodeui/commit/09dcea05fbc8c208d931aa1f08618f0e8087392f))
* reduce size of permission mode button tap target and provider selector on  mobile ([457ca0d](https://github.com/siteboon/claudecodeui/commit/457ca0daabcaa8397f4375ee8aa2671336b648ff))
* small mobile respnosive fixes ([25820ed](https://github.com/siteboon/claudecodeui/commit/25820ed995c1b813b1f9ed073097b08eb1d902ec))
* small mobile respnosive fixes ([c471b5d](https://github.com/siteboon/claudecodeui/commit/c471b5d3fa6ce1968adb4cf87a15ac0e18febd20))

### Refactoring

* add primitives, plan mode display, and new session model selector ([7763e60](https://github.com/siteboon/claudecodeui/commit/7763e60fb32e34742058c055c57664a503a34d1d))
* chat composer new design ([5758bee](https://github.com/siteboon/claudecodeui/commit/5758bee8a038ed50073dba882108617959dda82c))
* queue primitive, tool status badges, and tool display cleanup ([ec0ff97](https://github.com/siteboon/claudecodeui/commit/ec0ff974cba213a1100b2a071b8ba533e812fe82))

### Maintenance

* add docker sandbox action ([fa5a238](https://github.com/siteboon/claudecodeui/commit/fa5a23897c086bcacf1cf5d926c650f98a0f2222))

## [1.29.5](https://github.com/siteboon/claudecodeui/compare/v1.29.4...v1.29.5) (2026-04-16)

### Bug Fixes

* update node-pty to latest version ([6a13e17](https://github.com/siteboon/claudecodeui/commit/6a13e1773b145049ade512aa6e5cac21c2e5c4de))

## [1.29.4](https://github.com/siteboon/claudecodeui/compare/v1.29.3...v1.29.4) (2026-04-16)

### New Features

* deleting from sidebar will now ask whether to remove all data as well ([e9c7a50](https://github.com/siteboon/claudecodeui/commit/e9c7a5041c31a6f7b2032f06abe19c52d3d4cd8c))

### Bug Fixes

* pass pathToClaudeCodeExecutable to SDK when CLAUDE_CLI_PATH is set ([4c106a5](https://github.com/siteboon/claudecodeui/commit/4c106a5083d90989bbeedaefdbb68f5b3fa6fd58)), closes [#468](https://github.com/siteboon/claudecodeui/issues/468)

### Refactoring

* remove the sqlite3 dependency ([2895208](https://github.com/siteboon/claudecodeui/commit/289520814cf3ca36403056739ef22021f78c6033))
* **server:** extract URL detection and color utils from index.js ([#657](https://github.com/siteboon/claudecodeui/issues/657)) ([63e996b](https://github.com/siteboon/claudecodeui/commit/63e996bb77cfa97b1f55f6bdccc50161a75a3eee))

### Maintenance

* upgrade commit lint to 20.5.0 ([0948601](https://github.com/siteboon/claudecodeui/commit/09486016e67d97358c228ebc6eb4502ccb0012e4))

## [1.29.3](https://github.com/siteboon/claudecodeui/compare/v1.29.2...v1.29.3) (2026-04-15)

### Bug Fixes

* **version-upgrade-modal:** implement reload countdown and update UI messages ([#655](https://github.com/siteboon/claudecodeui/issues/655)) ([6413042](https://github.com/siteboon/claudecodeui/commit/641304242d7705b54aab65faa4a7673438c92c60))

### Maintenance

* remove unused route (migrated to providers already) ([31f28a2](https://github.com/siteboon/claudecodeui/commit/31f28a2c183f6ead50941027632d7ab64b7bb2d4))

## [1.29.2](https://github.com/siteboon/claudecodeui/compare/v1.29.1...v1.29.2) (2026-04-14)

### Bug Fixes

* **sandbox:** use backgrounded sbx run to keep sandbox  alive ([9b11c03](https://github.com/siteboon/claudecodeui/commit/9b11c034d9a19710a23b56c62dcf07c21a17bd97))

## [1.29.1](https://github.com/siteboon/claudecodeui/compare/v1.29.0...v1.29.1) (2026-04-14)

### Bug Fixes

* add latest tag to docker npx command and change the detach mode to work without spawn ([4a56972](https://github.com/siteboon/claudecodeui/commit/4a569725dae320a505753359d8edfd8ca79f0fd7))

## [1.29.0](https://github.com/siteboon/claudecodeui/compare/v1.28.1...v1.29.0) (2026-04-14)

### New Features

* adding docker sandbox environments ([13e97e2](https://github.com/siteboon/claudecodeui/commit/13e97e2c71254de7a60afb5495b21064c4bc4241))

### Bug Fixes

* **thinking-mode:** fix dropdown positioning ([#646](https://github.com/siteboon/claudecodeui/issues/646)) ([c7a5baf](https://github.com/siteboon/claudecodeui/commit/c7a5baf1479404bd40e23aa58bd9f677df9a04c6))

### Maintenance

* update release flow node version ([e2459cb](https://github.com/siteboon/claudecodeui/commit/e2459cb0f8b35f54827778a7b444e6c3ca326506))

## [1.28.1](https://github.com/siteboon/claudecodeui/compare/v1.28.0...v1.28.1) (2026-04-10)

### New Features

* add branding, community links, GitHub star badge, and About settings tab ([2207d05](https://github.com/siteboon/claudecodeui/commit/2207d05c1ca229214aa9c2e2c9f4d0827d421574))

### Bug Fixes

* corrupted binary downloads ([#634](https://github.com/siteboon/claudecodeui/issues/634)) ([e61f8a5](https://github.com/siteboon/claudecodeui/commit/e61f8a543d63fe7c24a04b3d2186085a06dcbcdb))
* **ui:** remove mobile bottom nav, unify processing indicator, and improve tooltip behavior on mobile ([#632](https://github.com/siteboon/claudecodeui/issues/632)) ([a8dab0e](https://github.com/siteboon/claudecodeui/commit/a8dab0edcf949ae610820bae9500c433781f7c73))

### Refactoring

* remove unused whispher transcribe logic ([#637](https://github.com/siteboon/claudecodeui/issues/637)) ([590dd42](https://github.com/siteboon/claudecodeui/commit/590dd42649424ab990353fcf59ce0965036d3d25))

## [1.28.0](https://github.com/siteboon/claudecodeui/compare/v1.27.1...v1.28.0) (2026-04-03)

### New Features

* adding session resume in the api ([8f1042c](https://github.com/siteboon/claudecodeui/commit/8f1042cf256be282f009adcceeb55ab2dddf3fba))
* moving new session button higher ([1628868](https://github.com/siteboon/claudecodeui/commit/16288684702dec894cf054291ca3d545ddb8214b))

### Maintenance

* changing package name to @cloudcli-ai/cloudcli ([ef51de2](https://github.com/siteboon/claudecodeui/commit/ef51de259ea2b963bc15f058b084e11220bc216a))

## [1.27.1](https://github.com/siteboon/claudecodeui/compare/v1.26.3...v1.27.1) (2026-03-29)

### Bug Fixes

* prevent split on undefined（[#491](https://github.com/siteboon/claudecodeui/issues/491)） ([#563](https://github.com/siteboon/claudecodeui/issues/563)) ([b54cdf8](https://github.com/siteboon/claudecodeui/commit/b54cdf8168fc224e9907796e4229ae8ed34e6885))

### Maintenance

* add release-it github action ([42a1313](https://github.com/siteboon/claudecodeui/commit/42a131389a6954df0d2c3bedd2cb6d3406c5ebc1))
* add terminal plugin in the plugins list ([004135e](https://github.com/siteboon/claudecodeui/commit/004135ef0187023e1da29c4a7137a28a42ebf9af))
* release tokens ([f1063fd](https://github.com/siteboon/claudecodeui/commit/f1063fd33964ccb517f5ebcdd14526ed162e1138))
* relicense to AGPL-3.0-or-later ([27cd124](https://github.com/siteboon/claudecodeui/commit/27cd12432b7d3237981f86acd9cc99532d843d4a))

## [1.26.3](https://github.com/siteboon/claudecodeui/compare/v1.26.2...v1.26.3) (2026-03-22)

## [1.26.2](https://github.com/siteboon/claudecodeui/compare/v1.26.0...v1.26.2) (2026-03-21)

### Bug Fixes

* change SW cache mechanism ([17d6ec5](https://github.com/siteboon/claudecodeui/commit/17d6ec54af18d333c8b04d2ffc64793e688d996e))
* claude auth changes and adding copy on mobile ([a41d2c7](https://github.com/siteboon/claudecodeui/commit/a41d2c713e87d56f23d5884585b4bb43c43a250a))

## [1.26.0](https://github.com/siteboon/claudecodeui/compare/v1.25.2...v1.26.0) (2026-03-20)

### New Features

* add German (Deutsch) language support ([#525](https://github.com/siteboon/claudecodeui/issues/525)) ([a7299c6](https://github.com/siteboon/claudecodeui/commit/a7299c68237908c752d504c2e8eea91570a30203))
* add WebSocket proxy for plugin backends ([#553](https://github.com/siteboon/claudecodeui/issues/553)) ([88c60b7](https://github.com/siteboon/claudecodeui/commit/88c60b70b031798d51ce26c8f080a0f64d824b05))
* Browser autofill support for login form ([#521](https://github.com/siteboon/claudecodeui/issues/521)) ([72ff134](https://github.com/siteboon/claudecodeui/commit/72ff134b315b7a1d602f3cc7dd60d47c1c1c34af))
* git panel redesign ([#535](https://github.com/siteboon/claudecodeui/issues/535)) ([adb3a06](https://github.com/siteboon/claudecodeui/commit/adb3a06d7e66a6d2dbcdfb501615e617178314af))
* introduce notification system and claude notifications ([#450](https://github.com/siteboon/claudecodeui/issues/450)) ([45e71a0](https://github.com/siteboon/claudecodeui/commit/45e71a0e73b368309544165e4dcf8b7fd014e8dd))
* **refactor:** move plugins to typescript ([#557](https://github.com/siteboon/claudecodeui/issues/557)) ([612390d](https://github.com/siteboon/claudecodeui/commit/612390db536417e2f68c501329bfccf5c6795e45))
* unified message architecture with provider adapters and session store ([#558](https://github.com/siteboon/claudecodeui/issues/558)) ([a4632dc](https://github.com/siteboon/claudecodeui/commit/a4632dc4cec228a8febb7c5bae4807c358963678))

### Bug Fixes

* detect Claude auth from settings env ([#527](https://github.com/siteboon/claudecodeui/issues/527)) ([95bcee0](https://github.com/siteboon/claudecodeui/commit/95bcee0ec459f186d52aeffe100ac1a024e92909))
* remove /exit command from claude login flow during onboarding ([#552](https://github.com/siteboon/claudecodeui/issues/552)) ([4de8b78](https://github.com/siteboon/claudecodeui/commit/4de8b78c6db5d8c2c402afce0f0b4cc16d5b6496))

### Documentation

* add German language link to all README files ([#534](https://github.com/siteboon/claudecodeui/issues/534)) ([1d31c3e](https://github.com/siteboon/claudecodeui/commit/1d31c3ec8309b433a041f3099955addc8c136c35))
* **readme:** hotfix and improve for README.jp.md ([#550](https://github.com/siteboon/claudecodeui/issues/550)) ([7413c2c](https://github.com/siteboon/claudecodeui/commit/7413c2c78422c308ac949e6a83c3e9216b24b649))
* **README:** update translations with CloudCLI branding and feature restructuring ([#544](https://github.com/siteboon/claudecodeui/issues/544)) ([14aef73](https://github.com/siteboon/claudecodeui/commit/14aef73cc6085fbb519fe64aea7cac80b7d51285))

## [1.25.2](https://github.com/siteboon/claudecodeui/compare/v1.25.0...v1.25.2) (2026-03-11)

### New Features

* **i18n:** localize plugin settings for all languages ([#515](https://github.com/siteboon/claudecodeui/issues/515)) ([621853c](https://github.com/siteboon/claudecodeui/commit/621853cbfb4233b34cb8cc2e1ed10917ba424352))

### Bug Fixes

* codeql user value provided path validation ([aaa14b9](https://github.com/siteboon/claudecodeui/commit/aaa14b9fc0b9b51c4fb9d1dba40fada7cbbe0356))
* numerous bugs ([#528](https://github.com/siteboon/claudecodeui/issues/528)) ([a77f213](https://github.com/siteboon/claudecodeui/commit/a77f213dd5d0b2538dea091ab8da6e55d2002f2f))
* **security:** disable executable gray-matter frontmatter in commands ([b9c902b](https://github.com/siteboon/claudecodeui/commit/b9c902b016f411a942c8707dd07d32b60bad087c))
* session reconnect catch-up, always-on input, frozen session recovery ([#524](https://github.com/siteboon/claudecodeui/issues/524)) ([4d8fb6e](https://github.com/siteboon/claudecodeui/commit/4d8fb6e30aa03d7cdb92bd62b7709422f9d08e32))

### Refactoring

* new settings page design and new pill component ([8ddeeb0](https://github.com/siteboon/claudecodeui/commit/8ddeeb0ce8d0642560bd3fa149236011dc6e3707))

## [1.25.0](https://github.com/siteboon/claudecodeui/compare/v1.24.0...v1.25.0) (2026-03-10)

### New Features

* add copy as text or markdown feature for assistant messages ([#519](https://github.com/siteboon/claudecodeui/issues/519)) ([1dc2a20](https://github.com/siteboon/claudecodeui/commit/1dc2a205dc2a3cbf960625d7669c7c63a2b6905f))
* add full Russian language support; update Readme.md files, and .gitignore update ([#514](https://github.com/siteboon/claudecodeui/issues/514)) ([c7dcba8](https://github.com/siteboon/claudecodeui/commit/c7dcba8d9117e84db8aac7d8a7bf6a3aa683e115))
* new plugin system ([#489](https://github.com/siteboon/claudecodeui/issues/489)) ([8afb46a](https://github.com/siteboon/claudecodeui/commit/8afb46af2e5514c9284030367281793fbb014e4f))

### Bug Fixes

* resolve duplicate key issue when rendering model options ([#520](https://github.com/siteboon/claudecodeui/issues/520)) ([9bceab9](https://github.com/siteboon/claudecodeui/commit/9bceab9e1a6e063b0b4f934ed2d9f854fcc9c6a4))

### Maintenance

* add plugins section in readme ([e581a0e](https://github.com/siteboon/claudecodeui/commit/e581a0e1ccd59fd7ec7306ca76a13e73d7c674c1))

## [1.24.0](https://github.com/siteboon/claudecodeui/compare/v1.23.2...v1.24.0) (2026-03-09)

### New Features

* add full-text search across conversations ([#482](https://github.com/siteboon/claudecodeui/issues/482)) ([3950c0e](https://github.com/siteboon/claudecodeui/commit/3950c0e47f41e93227af31494690818d45c8bc7a))

### Bug Fixes

* **git:** prevent shell injection in git routes ([86c33c1](https://github.com/siteboon/claudecodeui/commit/86c33c1c0cb34176725a38f46960213714fc3e04))
* replace getDatabase with better-sqlite3 db in getGithubTokenById ([#501](https://github.com/siteboon/claudecodeui/issues/501)) ([cb4fd79](https://github.com/siteboon/claudecodeui/commit/cb4fd795c938b1cc86d47f401973bfccdd68fdee))

## [1.23.2](https://github.com/siteboon/claudecodeui/compare/v1.22.1...v1.23.2) (2026-03-06)

### New Features

* add clickable overlay buttons for CLI prompts in Shell terminal ([#480](https://github.com/siteboon/claudecodeui/issues/480)) ([2444209](https://github.com/siteboon/claudecodeui/commit/2444209723701dda2b881cea2501b239e64e51c1)), closes [#427](https://github.com/siteboon/claudecodeui/issues/427)
* add terminal shortcuts panel for mobile ([#411](https://github.com/siteboon/claudecodeui/issues/411)) ([b0a3fdf](https://github.com/siteboon/claudecodeui/commit/b0a3fdf95ffdb961261194d10400267251e42f17))
* implement session rename with SQLite storage ([#413](https://github.com/siteboon/claudecodeui/issues/413)) ([198e3da](https://github.com/siteboon/claudecodeui/commit/198e3da89b353780f53a91888384da9118995e81)), closes [#72](https://github.com/siteboon/claudecodeui/issues/72) [#358](https://github.com/siteboon/claudecodeui/issues/358)

### Bug Fixes

* **chat:** finalize terminal lifecycle to prevent stuck processing/thinking UI ([#483](https://github.com/siteboon/claudecodeui/issues/483)) ([0590c5c](https://github.com/siteboon/claudecodeui/commit/0590c5c178f4791e2b039d525ecca4d220c3dcae))
* **codex-history:** prevent AGENTS.md/internal prompt leakage when reloading Codex sessions ([#488](https://github.com/siteboon/claudecodeui/issues/488)) ([64a96b2](https://github.com/siteboon/claudecodeui/commit/64a96b24f853acb802f700810b302f0f5cf00898))
* preserve pending permission requests across WebSocket reconnections ([#462](https://github.com/siteboon/claudecodeui/issues/462)) ([4ee88f0](https://github.com/siteboon/claudecodeui/commit/4ee88f0eb0c648b54b05f006c6796fb7b09b0fae))
* prevent React 18 batching from losing messages during session sync ([#461](https://github.com/siteboon/claudecodeui/issues/461)) ([688d734](https://github.com/siteboon/claudecodeui/commit/688d73477a50773e43c85addc96212aa6290aea5))
* release it script ([dcea8a3](https://github.com/siteboon/claudecodeui/commit/dcea8a329c7d68437e1e72c8c766cf33c74637e9))

### Styling

* improve UI for processing banner ([#477](https://github.com/siteboon/claudecodeui/issues/477)) ([2320e1d](https://github.com/siteboon/claudecodeui/commit/2320e1d74b59c65b5b7fc4fa8b05fd9208f4898c))

### Maintenance

* remove logging of received WebSocket messages in production ([#487](https://github.com/siteboon/claudecodeui/issues/487)) ([9193feb](https://github.com/siteboon/claudecodeui/commit/9193feb6dc83041f3c365204648a88468bdc001b))

## [1.22.0](https://github.com/siteboon/claudecodeui/compare/v1.21.0...v1.22.0) (2026-03-03)

### New Features

* add community button in the app ([84d4634](https://github.com/siteboon/claudecodeui/commit/84d4634735f9ee13ac1c20faa0e7e31f1b77cae8))
* Advanced file editor and file tree improvements ([#444](https://github.com/siteboon/claudecodeui/issues/444)) ([9768958](https://github.com/siteboon/claudecodeui/commit/97689588aa2e8240ba4373da5f42ab444c772e72))
* update document title based on selected project ([#448](https://github.com/siteboon/claudecodeui/issues/448)) ([9e22f42](https://github.com/siteboon/claudecodeui/commit/9e22f42a3d3a781f448ddac9d133292fe103bb8c))

### Bug Fixes

* **claude:** correct project encoded path ([#451](https://github.com/siteboon/claudecodeui/issues/451)) ([9c0e864](https://github.com/siteboon/claudecodeui/commit/9c0e864532dcc5ce7ee890d3b4db722872db2b54)), closes [#447](https://github.com/siteboon/claudecodeui/issues/447)
* **claude:** move model usage log to result message only ([#454](https://github.com/siteboon/claudecodeui/issues/454)) ([506d431](https://github.com/siteboon/claudecodeui/commit/506d43144b3ec3155c3e589e7e803862c4a8f83a))
* missing translation label ([855e22f](https://github.com/siteboon/claudecodeui/commit/855e22f9176a71daa51de716370af7f19d55bfb4))

### Maintenance

* add Gemini-CLI support to README ([#453](https://github.com/siteboon/claudecodeui/issues/453)) ([503c384](https://github.com/siteboon/claudecodeui/commit/503c3846850fb843781979b0c0e10a24b07e1a4b))

## [1.21.0](https://github.com/siteboon/claudecodeui/compare/v1.20.1...v1.21.0) (2026-02-27)

### New Features

* add copy icon for user messages ([#449](https://github.com/siteboon/claudecodeui/issues/449)) ([b359c51](https://github.com/siteboon/claudecodeui/commit/b359c515277b4266fde2fb9a29b5356949c07c4f))
* Google's gemini-cli integration ([#422](https://github.com/siteboon/claudecodeui/issues/422)) ([a367edd](https://github.com/siteboon/claudecodeui/commit/a367edd51578608b3281373cb4a95169dbf17f89))
* persist active tab across reloads via localStorage ([#414](https://github.com/siteboon/claudecodeui/issues/414)) ([e3b6892](https://github.com/siteboon/claudecodeui/commit/e3b689214f11d549ffe1b3a347476d58f25c5aca)), closes [#387](https://github.com/siteboon/claudecodeui/issues/387)

### Bug Fixes

* add support for Codex in the shell ([#424](https://github.com/siteboon/claudecodeui/issues/424)) ([23801e9](https://github.com/siteboon/claudecodeui/commit/23801e9cc15d2b8d1bfc6e39aee2fae93226d1ad))

### Maintenance

* upgrade @anthropic-ai/claude-agent-sdk to version 0.2.59 and add model usage logging ([#446](https://github.com/siteboon/claudecodeui/issues/446)) ([917c353](https://github.com/siteboon/claudecodeui/commit/917c353115653ee288bf97be01f62fad24123cbc))
* upgrade better-sqlite to latest version to support node 25 ([#445](https://github.com/siteboon/claudecodeui/issues/445)) ([4ab94fc](https://github.com/siteboon/claudecodeui/commit/4ab94fce4257e1e20370fa83fa4c0f6fadbb8a2b))

## [1.20.1](https://github.com/siteboon/claudecodeui/compare/v1.19.1...v1.20.1) (2026-02-23)

### New Features

* implement install mode detection and update commands in version upgrade process ([f986004](https://github.com/siteboon/claudecodeui/commit/f986004319207b068431f9f6adf338a8ce8decfc))
* migrate legacy database to new location and improve last login update handling ([50e097d](https://github.com/siteboon/claudecodeui/commit/50e097d4ac498aa9f1803ef3564843721833dc19))

## [1.19.1](https://github.com/siteboon/claudecodeui/compare/v1.19.0...v1.19.1) (2026-02-23)

### Bug Fixes

* add prepublishOnly script to build before publishing ([82efac4](https://github.com/siteboon/claudecodeui/commit/82efac4704cab11ed8d1a05fe84f41312140b223))

## [1.19.0](https://github.com/siteboon/claudecodeui/compare/v1.18.2...v1.19.0) (2026-02-23)

### New Features

* add HOST environment variable for configurable bind address ([#360](https://github.com/siteboon/claudecodeui/issues/360)) ([cccd915](https://github.com/siteboon/claudecodeui/commit/cccd915c336192216b6e6f68e2b5f3ece0ccf966))
* subagent tool grouping ([#398](https://github.com/siteboon/claudecodeui/issues/398)) ([0207a1f](https://github.com/siteboon/claudecodeui/commit/0207a1f3a3c87f1c6c1aee8213be999b23289386))

### Bug Fixes

* **macos:** fix node-pty posix_spawnp error with postinstall script ([#347](https://github.com/siteboon/claudecodeui/issues/347)) ([38a593c](https://github.com/siteboon/claudecodeui/commit/38a593c97fdb2bb7f051e09e8e99c16035448655)), closes [#284](https://github.com/siteboon/claudecodeui/issues/284)
* slash commands with arguments bypass command execution ([#392](https://github.com/siteboon/claudecodeui/issues/392)) ([597e9c5](https://github.com/siteboon/claudecodeui/commit/597e9c54b76e7c6cd1947299c668c78d24019cab))

### Refactoring

* **releases:** Create a contributing guide and proper release notes using a release-it plugin ([fc369d0](https://github.com/siteboon/claudecodeui/commit/fc369d047e13cba9443fe36c0b6bb2ce3beaf61c))

### Maintenance

* update @anthropic-ai/claude-agent-sdk to version 0.1.77 in package-lock.json ([#410](https://github.com/siteboon/claudecodeui/issues/410)) ([7ccbc8d](https://github.com/siteboon/claudecodeui/commit/7ccbc8d92d440e18c157b656c9ea2635044a64f6))
