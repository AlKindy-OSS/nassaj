# منصّة اختبار التحديث / Update Lab (WI-0 — ADR-156)

منصّة محلية تقود دورة تحديث `git-checkout-v2` كاملة على **عقدة تجريبية قابلة للإعادة إلى نقطة الصفر**، بلا شبكة، وبلا مستودع على GitHub، وبلا أي مساس بالتثبيت الحيّ `nassaj-dev`.

A local platform that drives a complete `git-checkout-v2` update cycle on a **resettable laboratory node** — no network, no GitHub repository, and no contact with the live `nassaj-dev` install.

---

## ما يضمنه العزل / Isolation guarantees

| المحور | العقدة التجريبية | الحيّ |
|---|---|---|
| المنفذ / port | `3104` (أو أول منفذ حرّ) | `3004` — يرفض السكربت استعماله |
| قاعدة البيانات / database | `.artifacts/update-lab/node/data/auth.db` | لا تُمسّ |
| pm2 | عفريت خاص عبر `PM2_HOME=.artifacts/update-lab/node/pm2`، اسم العملية `nassaj-lab` | `nassaj-dev` في عفريت المستخدم، لا يراه المختبر |
| `WF_BASE` | `.artifacts/update-lab/node/workflows` (فارغ) | نسخ الجلسات الحقيقية لا تُفحص |
| `TMPDIR` | `/var/tmp` (قرص) | — |
| المصدر / remote | `git@github.com:your-org/nassaj-update-lab.git` يخدمه **shim محلي للـssh** من مستودع `bare` | لا اتصال بالشبكة إطلاقاً |

`pm2 save` الذي ينفّذه `safe-restart.sh` يكتب في عفريت المختبر وحده، فقائمة إحياء العمليات الحيّة لا تتغيّر.
The `pm2 save` that `safe-restart.sh` performs writes to the laboratory daemon only, so the live resurrection list never changes.

---

## لماذا shim للـssh ولا `file://` مباشرة / Why an ssh shim, not a bare `file://` remote

`defaultGitCheckoutProbe` و`normalizeGitHubRemote` في `server/services/source-updater.js` يقبلان **شكل GitHub وحده**: `https://github.com/<owner>/<repo>` أو `git@github.com:<owner>/<repo>`. مستودع `file://` يُرفض بـ`unsafe_remote` قبل أي سيناريو. ومحاولة `url.<file>.insteadOf` لا تنفع لأن `git remote get-url` يطبّق إعادة الكتابة فيُرى `file://` مجدداً.

الحل المعتمد: يبقى عنوان `origin` بشكل GitHub، ويُضبط `core.sshCommand` في **إعداد المستودع المحلي** (الذي ينجو من `GIT_CONFIG_GLOBAL=/dev/null` الذي يفرضه المحدّث) على سكربت يخدم `git-upload-pack` من المستودع `bare` المحلي. السحب فقط — `git-receive-pack` مرفوض، فلا دفع ممكن من أي سيناريو.

The updater accepts GitHub-shaped remotes only, and `git remote get-url` applies `insteadOf` rewriting, so a `file://` fixture fails `unsafe_remote`. The lab keeps the GitHub-shaped URL and points the repository-local `core.sshCommand` at a fetch-only shim backed by the local bare repository.

**اسم الـshim حرّ (منذ `462fcabd8`):** البيئة المحكومة (`resolveGovernedSshCommand` في `source-updater.js`) تأخذ الأمر الذي كان git سيختاره — `GIT_SSH_COMMAND` ثم `GIT_SSH` ثم `core.sshCommand` — وتُلحق به `BatchMode=yes` و`StrictHostKeyChecking=yes` و`ConnectTimeout=10` فقط؛ والـshim يقرأ آخر معامل فيمرّ ذلك بلا أثر. يبقى في `<lab>/shim-bin/ssh` ويُمرَّر في `GIT_SSH_COMMAND` أيضاً للاتساق مع الأشجار القائمة لا لضرورة.
The shim's name is free since `462fcabd8`: the governed environment composes the command git would pick (GIT_SSH_COMMAND, then GIT_SSH, then core.sshCommand) and only appends its three ssh options, which the shim ignores.

**موضع المختبر / Lab location:** `NASSAJ_UPDATE_LAB_ROOT=/var/tmp/<dir>` ينقل الشجرة كلها (المستودع، العقدة، `node_modules`) خارج نسخة العمل؛ `/tmp` و`/dev/shm` مرفوضان لأنهما tmpfs.

---

## الاستخدام / Usage

### 1. مستودع الإصدار التجريبي / Fixture repository

```bash
node scripts/update-lab/create-fixture-repo.mjs --force
# ‏v9.0.0.1 على commit تالٍ للقاعدة يغيّر package.json و package-lock.json ويضيف docs/update-lab-release-note.md
```

مستودع `bare` بنسخ مرتبطة (hard links) من الشجرة الحالية — ثوانٍ ومساحة شبه صفرية، بلا checkout وبلا أي remote على المستودع الحيّ. إصدار إضافي:

```bash
node scripts/update-lab/create-fixture-repo.mjs --append --version 9.0.0.2                      # إصدار تالٍ
node scripts/update-lab/create-fixture-repo.mjs --append --version 9.0.0.3 --gitlink-op add     # لسيناريو S6
```

### 2. العقدة التجريبية / The laboratory node

```bash
node scripts/update-lab/provision-node.mjs create --port 3104   # clone + npm ci + npm run build (الخطوة البطيئة)
node scripts/update-lab/provision-node.mjs snapshot --name base # نقطة الصفر
node scripts/update-lab/provision-node.mjs start|status|stop
node scripts/update-lab/provision-node.mjs restore --name base  # إعادة إلى نقطة الصفر
node scripts/update-lab/provision-node.mjs destroy
```

اللقطة تستثني `node_modules` وتستعيده من نسخة مرتبطة (`node_modules.pristine`)، فحجمها معقول والاستعادة ثوانٍ.
`stop` لا يستعمل أي أمر دورة حياة من pm2 (`restart/stop/delete`): يُرسل `SIGTERM` إلى عمليات المختبر بمعرّفاتها.

### 3. السيناريوهات / Scenarios

```bash
node scripts/update-lab/run-scenario.mjs --list
node scripts/update-lab/run-scenario.mjs S1
node scripts/update-lab/run-scenario.mjs S1 S2 S3 --timeout-ms 2400000
```

كل تشغيل: استعادة نقطة الصفر ← تهيئة السيناريو ← تشغيل ← `POST /api/system/update/jobs` برمز مالك ← متابعة المهمة ← (عند اللزوم) `POST /api/system/pending/:id/execute` ← تحقق. الدليل في `.artifacts/update-lab/results/<Sx>-<timestamp>.json`.

**أحكام النتيجة / Verdicts**

| الحكم | معناه |
|---|---|
| `pass` | السلوك مطابق لعقد ADR-156 |
| `defect-confirmed` | السلوك مطابق **للعيب المعروف** الذي وُضع السيناريو لالتقاطه (الحارس التقطه بدقة) |
| `inconclusive` | التشغيل لم يبلغ الحالة محلّ الاختبار أصلاً، فلا يصلح دليلاً للعقد ولا للعيب |
| `fail` | لا هذا ولا ذاك: اكتشاف جديد يستحق فحصاً |
| `deferred` | يحتاج مستودعاً خاصاً بعيداً غير موجود (S4/S5) |

---

## السيناريوهات العشرة / The ten scenarios

| # | يقابل | الحالة في هذه المنصّة |
|---|---|---|
| S1 | B-1050 | مُنفَّذ — ملف غير متتبَّع خارج مسارات الإصدار |
| S2 | B-1050 | مُنفَّذ — ملف غير متتبَّع على مسار يضيفه الإصدار بالضبط |
| S3 | B-1051 | مُنفَّذ — commit محلي على `main`، مع إثبات عدم إعادة كتابة التاريخ |
| S4 | B-1052 | **مؤجَّل** — يحتاج مستودعاً خاصاً حقيقياً لإثبات سلطة الإصدار (ADR-156 §3: بإذن إنشاء مستقل) |
| S5 | B-1053 | **مؤجَّل** — يحتاج HTTPS خاصاً بلا اعتماد، و`/preflight` غير موجود بعد (WI-7) |
| S6 | B-1054 | مُنفَّذ، ويشترط إصدار gitlink في المستودع التجريبي |
| S7 | B-1055 | مُنفَّذ — يقف قبل التفعيل ويقرأ حالة «مُحضَّر» من `/health` بمعادلة `resolveUpdatePrepared` نفسها |
| S8 | B-1056 | مُنفَّذ — مهمة أولى تُهجَر ثم تُعاد المحاولة على **البصمة نفسها** |
| S9 | B-1057 | مُنفَّذ — يزرع صفّاً `pending` بنونس غير فارغ على **البناء الجاري** ثم يعيد الإقلاع |
| S10 | عائق مدخل pm2 | مُنفَّذ — يتحقق أن البديل يستمع بعد إعادة التشغيل المحكومة |
| S11 | qa-critic C3 | مُنفَّذ — يثبّت العقدة **عبر `scripts/install-node.mjs`** (لا ecosystem المختبر) ويشغّل pm2 من الملف الذي ولّده المثبّت، ثم يثبت `/health` ورمز `pm2_entry` وتحقّق الطبيب من حساب الخدمة |

**S11:** يستورد المثبّت من شجرة العقدة نفسها (الإصدار قيد الاختبار). حافّتا الشبكة وحدهما مُحاكاتان: تحية ssh من GitHub، و`git ls-remote` عبر الـshim إلى المستودع `bare` المحلي. كل ما يكتبه المثبّت حقيقي. لاختبار commit غير مدموج: `create-fixture-repo.mjs --force --base HEAD` (يقبل أي commit يشارك `main` تاريخاً، ولو تباعد عنه بعد تقدّم `main`؛ ويرفض التاريخ غير المرتبط وحده).
S11 imports the installer from the node's own tree (the release under test); only the two network edges are simulated. To exercise an unmerged commit, build the fixture with `--base HEAD` (any commit sharing history with `main` is accepted, including one that diverged after `main` moved on).

---

## ما اكتشفته المنصّة أثناء بنائها / What building the platform already found

أربعة شروط بيئية لم تكن موثّقة، وكلها تُسقط تحديثاً حقيقياً على عقدة جديدة:

1. **المصدر لا يقبل `file://`**: `normalizeGitHubRepositoryIdentity` يقصر الريموت على شكل GitHub، و`git remote get-url` يطبّق `insteadOf` فلا ينفع الالتفاف به. الحل المعتمد هنا shim للـssh.
2. **الاكتشاف يشترط وسماً موقّعاً (annotated)**: `git-tag-release-discovery.js:64-80` لا يقبل إلا الوسم الذي يثبته سطر `refs/tags/<tag>^{}`؛ الوسم الخفيف (lightweight) يعطي `release_not_found` قبل أن يصل المحدّث إلى أي فحص.
3. **أول بناء على عقدة جديدة يفشل** ما لم يوجد `dist/assets` و`dist-server` مسبقاً: `client-build-atomic.mjs:148-152` يجرد أصول الدليل الحيّ قبل الترقية، فالدليل الفارغ لا يكفي (`ENOENT … dist/assets`).
4. **`node_modules` مرتبط بروابط صلبة يكسر البناء**: `scripts/patch-codex-sdk-image-only.mjs:40` يرفض أي ملف `nlink !== 1` بـ`CODEX_IMAGE_ONLY_PATCH_UNSAFE_FILE`، فنسخة `cp -al` تُسقط `build:server`. المنصّة تستعمل نسخة حقيقية.

**English:** four undocumented environment preconditions, each fatal on a fresh node — the release source must be GitHub-shaped (hence the ssh shim), discovery accepts only annotated tags, the first build needs `dist/assets` and `dist-server` to exist, and a hard-linked `node_modules` fails the codex-SDK build guard.

---

## القيود / Limits

1. **التفعيل يستلزم pm2.** ‏`scripts/safe-restart.sh:1092` يثبّت `pm2 restart "$PROC_NAME"`، بلا أي مخرج لأمر بديل؛ ولذلك تعمل العقدة تحت pm2 باسم `nassaj-lab` في `PM2_HOME` خاص. السيناريوهات التي تقف قبل التفعيل (S1–S3، S7، S8) لا تحتاج ذلك.
2. **مسار بوابة إعادة التشغيل من `dist-server/`.** عند وجود تفعيل تحديث يستبدل المسار في `server/routes/system.js:2684-2687` إلى `dist-server/scripts/safe-restart.sh`، فالعقدة تُبنى بناءً كاملاً (‏`npm run build`) ولا تعمل من المصدر وحده.
3. **‏`npm ci` داخل `.artifacts/update-lab/` فقط**، وبـ`TMPDIR=/var/tmp`؛ لا شيء في `/tmp` ولا `/dev/shm`. بناء المرشّح داخل دورة التحديث ينفّذ `npm ci` ثانية داخل جذر المرشّح — وهي أبطأ خطوة في الدورة، ويحتاج مخزن npm دافئاً لأن المختبر بلا شبكة.
4. **الموارد:** افحص المعالج والذاكرة قبل `create` وقبل أي سيناريو يبلغ التجهيز؛ البناء يستهلك أنوية متعددة وذاكرة معتبرة.
5. **الاكتشاف مختبَر جزئياً:** مسار `git-checkout-v2` يكتشف الإصدار بـ`git ls-remote` فيعمل عبر الـshim بلا شبكة (ولذلك يشترط وسماً annotated)؛ أما مسار GitHub REST فغير مختبَر. المنصّة تصكّ المهمة مباشرة بـ`expectedVersion` (كما فُعل على عقدة مشروع-أ في B-1055) ولا تمرّ بزرّ الواجهة.
6. **لا يوجد أي شيء متتبَّع خارج `scripts/update-lab/`**: كل حالة المختبر تحت `.artifacts/update-lab/` وهو في `.gitignore`.

**English summary of the limits:** activation hard-requires pm2 (`safe-restart.sh:1092`), so the node runs under a private pm2 daemon; the restart gate is resolved from `dist-server/`, so the node is fully built rather than run from source; `npm ci` happens only inside `.artifacts/update-lab/` with `TMPDIR=/var/tmp`, and the candidate build runs a second `npm ci` that needs a warm npm cache because the lab is offline; check CPU/RAM before provisioning or any scenario that reaches staging; release discovery is not exercised (it queries GitHub) — jobs are minted directly with `expectedVersion`; nothing but `scripts/update-lab/` is tracked, all state lives under the gitignored `.artifacts/update-lab/`.
