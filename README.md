<div align="center">
  <img src="public/logo.svg" alt="نسّاج" width="64" height="64">
  <h1>نسّاج — nassaj</h1>
  <p>واجهة ويب وجوّال لتشغيل وكلاء البرمجة من أي مكان: جلساتك ومشاريعك وطرفياتك في مكان واحد، بعربية كاملة الاتجاه.</p>
  <p><i>A web and mobile UI for coding agents — sessions, projects and terminals in one place, with first-class Arabic/RTL.</i></p>
</div>

<p align="center">
  <a href="#التثبيت">التثبيت</a> ·
  <a href="#المزوّدات">المزوّدات</a> ·
  <a href="#الأمان-وتصنيف-النشر">الأمان</a> ·
  <a href="#english">English</a> ·
  <a href="CONTRIBUTING.md">المساهمة</a> ·
  <a href="CHANGELOG.md">سجلّ التغييرات</a>
</p>

---

## ما هو نسّاج

نسّاج واجهة تُدير **وكلاء البرمجة الطرفيين** (‏Claude Code وCodex وغيرهما) من المتصفّح: تفتح جلسة، تتابع بثّها لحظياً، توافق على الأدوات، وتعود إليها من الجوّال. ليس مزوّد ذكاء اصطناعي ولا بديلاً عنه — بل الطبقة التي تجلس فوق الوكلاء المثبَّتة على جهازك، وتشغّل كلاً منها باعتماداته هو.

هذا المشروع **تفريعة** من [claudecodeui](https://github.com/siteboon/claudecodeui)، وما يميّزه:

- **مزوّدات متعددة خلف نموذج جلسة واحد** — لكلٍّ بيت إعدادات معزول خاص به لكل مستخدم.
- **عزل حقيقي بين المستخدمين** — كل عضو يصادق باعتماده هو؛ لا اعتماد مشترك بين الحسابات.
- **عربية وRTL في صميم الواجهة** لا كطبقة ترجمة فوقها: اتجاه أساس لكل رسالة، وخطوط عربية مدمجة، وانعكاس منطقي للتخطيط.
- **مسار إطلاق محكوم** — كل مزوّد يعمل تحت وثيقة حوكمة؛ الافتراضي المحايد في `server/governance/default-AGENTS.md`، وتستبدله بوضع وثيقتك في `~/.claude/AGENTS.md`.
- **أدوات تشغيل** — لوحة مشروع حيّة، وويكي فريق، ولوحة أوامر مُصرَّحة، وإعادة تشغيل آمنة لا تقطع جلسة جارية.

## المزوّدات

| المزوّد | الاستدعاء |
|---|---|
| Claude Code | ‏Agent SDK رسمي |
| Codex | ‏Codex SDK |
| Gemini CLI · Cursor CLI · OpenCode · Hermes · Kimi · GLM · DeepSeek · Antigravity | ‏CLI محكوم لكلٍّ منها |

كل مزوّد اختياري: يظهر في المنتقي إن كان **مثبَّتاً ومصادَقاً** على الجهاز، ويختفي وإلا. لا يشحن نسّاج مفاتيح ولا يطلبها لنفسه.

## التثبيت

### تثبيت إصدار إنتاجي قابل للتحديث

المتطلّبات: **Node 24 على Linux x64 وبـglibc 2.39 أو أحدث**، و`curl` و`jq` و`tar`. لا تحتاج إلى checkout أو `npm` أو رمز GitHub: نزّل حزمة المثبّت المستقلة من قناة الإصدار العامة، وتحقق من digest الذي تعيده GitHub API، ثم مرّر receipt الإصدار ذاتها للمثبّت كي لا يعيد اكتشاف `latest`:

```bash
(
  set -euo pipefail
  INSTALL_TMP=''
  trap 'test -z "$INSTALL_TMP" || rm -rf -- "$INSTALL_TMP"' EXIT
  REPO='AlKindy-OSS/nassaj'; INSTALL_TMP="$(mktemp -d -p /var/tmp nassaj-install.XXXXXX)"; chmod 700 "$INSTALL_TMP"
  curl --fail --silent --show-error \
    "https://api.github.com/repos/$REPO/releases/latest" -o "$INSTALL_TMP/release.json"
  TAG="$(jq -r .tag_name "$INSTALL_TMP/release.json")"
  COMMIT="$(curl --fail --silent --show-error \
    "https://api.github.com/repos/$REPO/commits/$TAG" | jq -r .sha)"
  NAME="nassaj-installer-${TAG}.tar.gz"
  test "$(jq --arg n "$NAME" '[.assets[]|select(.name==$n and .state=="uploaded")]|length' "$INSTALL_TMP/release.json")" = 1
  ID="$(jq -r --arg n "$NAME" '.assets[]|select(.name==$n)|.id' "$INSTALL_TMP/release.json")"
  DIGEST="$(jq -r --arg n "$NAME" '.assets[]|select(.name==$n)|.digest' "$INSTALL_TMP/release.json")"
  SIZE="$(jq -r --arg n "$NAME" '.assets[]|select(.name==$n)|.size' "$INSTALL_TMP/release.json")"
  [[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] && [[ "$ID" =~ ^[1-9][0-9]*$ ]] && [[ "$SIZE" =~ ^[1-9][0-9]*$ ]]
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    -H 'Accept: application/octet-stream' \
    "https://api.github.com/repos/$REPO/releases/assets/$ID" -o "$INSTALL_TMP/$NAME"
  test "$(stat -c %s "$INSTALL_TMP/$NAME")" = "$SIZE"
  echo "${DIGEST#sha256:}  $INSTALL_TMP/$NAME" | sha256sum --check --strict
  mkdir "$INSTALL_TMP/bundle" && tar -xzf "$INSTALL_TMP/$NAME" -C "$INSTALL_TMP/bundle"
  node "$INSTALL_TMP/bundle/scripts/install-release-runtime.mjs" --deploy-root /opt/nassaj \
    --release-file "$INSTALL_TMP/release.json" --release-commit "$COMMIT"
)
```

ينتهي الأمر بالحالة `prepared_not_activated`: راجع ملف الإعداد الذي يطبعه، واضبط الخدمة على مسار launcher المطبوع، ثم نفّذ التفعيل/إعادة التشغيل فقط عبر موافقة المالك المنفصلة ومسار `safe-restart`. لا يدّعي المثبّت نجاح `/health` أو `updateReady` قبل تشغيل الخدمة والتحقق منهما.

بعد التفعيل، زر التحديث يحضّر الإصدار التالي كعملية خادمية غير متزامنة قابلة للاستئناف. لا يعيد الزر تشغيل الخادم؛ تظهر موافقة مالك منفصلة لإعادة التشغيل الآمنة بعد اكتمال التحضير.

**العقد القديمة 1.44:** أول انتقال إلى Release Runtime ليس عملية زرية ولا إعادة محاولة للمحدّث القديم. هو cutover صيانة لمرة واحدة ينفذه المشغّل على كل عقدة بموافقة مالك موقّعة ومحددة لتلك العقدة. يحفظ Git/PM2 وقاعدة البيانات، ويعرض 503 صريحة قابلة للقياس بدلاً من 502 أثناء النافذة، ويمنع الأعمال الجديدة ويثبت صفر الأعمال قبل تجميد الكتّاب والنسخة النهائية والتبديل. تثبيت دعم المشغّل، وتعديل الخدمة، وتنفيذ cutover أذونات إنتاج منفصلة لكل عقدة. تصبح التحديثات **اللاحقة** زرية فقط بعد نجاح التفعيل وإثبات `/health` أن `updateReady=true` والاستراتيجية `artifact-runtime-v2`. التفاصيل والحدود في [ADR-135](docs/release-runtime-installation.md).

### تثبيت شجرة المصدر للتطوير

المتطلّبات: Node ضمن المجال المحدد في `package.json`، وgit، والوكلاء التي تريد استعمالها مثبَّتة ومصادَقة مسبقاً. هذا مسار تطوير ولا يساوي تثبيت Release Runtime الإنتاجي أعلاه.

```bash
git clone <هذا-المستودع> nassaj && cd nassaj
npm install --include=dev      # ‏--include=dev إلزامي: NODE_ENV=production يقلّم أدوات البناء
cp .env.example .env && chmod 600 .env
npm run doctor                 # فحص ما قبل التشغيل — يطبع سطر إصلاح لكل عائق
npm run build                  # واجهة ثم خادم
npm run server
```

ثم افتح `http://localhost:3001` (أو `SERVER_PORT` الذي ضبطتَه). أول حساب يُنشأ هو المالك.

### `npm run doctor`

فحص **قراءة فقط** لا يعدّل شيئاً؛ يطبع الأمر الذي تنفّذه أنت. يغطّي: إصدار Node مقابل `engines`، وعضوية مجموعة docker وأثرها، ووجود `.env` وصلاحياته، وطول `JWT_SECRET`، وإشغال المنفذ، وقابلية الكتابة على مسار القاعدة، وتقليم `devDependencies`، ووجود البناء، وتحميل `node-pty`. يخرج بـ1 عند عائق يمنع التشغيل فعلاً.

### الإعداد

كل الإعداد في `.env` (انظر `.env.example` — كل مفتاح موثَّق فيه). أكثرها استعمالاً:

| المفتاح | المعنى |
|---|---|
| `SERVER_PORT` · `HOST` | منفذ الخادم وواجهة الربط |
| `ALLOWED_ORIGINS` | الأصول المسموحة — **يلزم ذكر كل نطاق عام** تُخدَم عليه النسخة |
| `JWT_SECRET` | ‏32 محرفاً فأكثر؛ إن تُرك فارغاً يُولَّد سرّ لكل تثبيت ويُحفظ في القاعدة |
| `DATABASE_PATH` | مسار قاعدة SQLite |
| `NASSAJ_SECURITY_POSTURE` | تصنيف النشر (أدناه) |

## الأمان وتصنيف النشر

نسّاج يشغّل وكلاء لها صلاحية على جهازك؛ فحواجزه مبنية على سؤال واحد: **من أصحاب الحسابات على هذه النسخة؟**

- **الافتراضي — `trusted`:** أصحاب الحسابات مشغّلو هذا الجهاز. ما يصله الخادم (مقبس docker، البيت، sudo) يصلونه من صدفتهم أصلاً، فالحواجز المضيفية تُبلّغ بصوت عالٍ ولا تمنع الإقلاع. التحذيرات تُقرأ من `GET /api/system/security-posture` (مالك/أدمن).
- **`NASSAJ_SECURITY_POSTURE=strict`:** النسخة تخدم مستخدمين غير موثوقين. عندها تصبح تلك الحواجز **قاطعة**: مثلاً إن كانت عملية الخادم قادرة على بلوغ `/var/run/docker.sock` — أي هروب إلى جذر المضيف بأمر واحد — يرفض الإقلاع ويطبع خطوات الإصلاح.
- **وضع platform** متشدّد دائماً ولا يُنزِله أي متغيّر بيئة، لأن المصادقة معطَّلة فيه.

للإنتاج على شبكة عامة: `strict`، وأخرِج مستخدم الخدمة من مجموعة docker، وثبّت `ALLOWED_ORIGINS` و`JWT_SECRET`.

## إعادة التشغيل الآمنة

`bash scripts/safe-restart.sh` يفحص أولاً ثم يقرّر: إن كانت ثمّة جلسة محادثة حيّة أو عمل جارٍ **يؤجّل** ويشرح السبب بدل أن يقطعها، ويُنفَّذ بـ`--exec`. لا تستبدله بإعادة تشغيل خام من مدير العمليات: تصميم التصريف يُغلق المنفذ ويُبقي العملية حيّة ما دامت لها جلسة ابنة، فتحصل على انقطاع ممتد.

## دليل الموصلات

إعداد تطبيقات الموصلات المشتركة والعنوان العام والتفعيل يراه وينفّذه **المالك
فقط**؛ أما كل عضو فيربط حساباته الشخصية مرة واحدة لتتاح أدواتها لبيتي Claude
وCodex المؤهلين له. لا يعني ظهور خدمة أنها معتمدة أو مفعّلة. راجع
[دليل إعداد الموصلات بالعربية](docs/guides/connectors-setup.ar.md) أو
[النسخة الإنجليزية](docs/guides/connectors-setup.md).

## سياسة الإصدار

هوية الإصدار دائماً من أربعة مقاطع: نزيد الثاني للدفعة الكبيرة (`1.41.0.0` ← `1.42.0.0`)، والثالث للميزة الصغيرة، والرابع لإصلاح الخلل. التفصيل في [CONTRIBUTING.md](CONTRIBUTING.md).

## الرخصة

**AGPL-3.0-or-later**، كالمشروع الأصل — انظر [LICENSE](LICENSE) بما فيه الشروط الإضافية تحت المادة 7. والمادة 13 تلزم من شغّل نسخة معدَّلة عبر الشبكة بإتاحة مصدرها لمستخدميها: وجّه `VITE_PUBLIC_SOURCE_URL` إلى مستودعك العام عند البناء، واضبط `VITE_RELEASE_REPO_URL` لقناة الإصدارات العامة بصورة مستقلة.

## شكر

الأساس من [claudecodeui](https://github.com/siteboon/claudecodeui) لفريق siteboon والمساهمين فيه — نسّاج مَدين له ببنيته الأولى. ومبنيّ على [React](https://react.dev/) و[Vite](https://vitejs.dev/) و[Tailwind CSS](https://tailwindcss.com/) و[CodeMirror](https://codemirror.net/) و[xterm.js](https://xtermjs.org/).

---

<a id="english"></a>

## English

**nassaj** is a web and mobile UI for terminal coding agents — a fork of
[claudecodeui](https://github.com/siteboon/claudecodeui). It drives the agents already
installed on your machine, each under its own isolated per-user config home and its own
credentials, and puts their sessions, your projects and live terminals in one place.
Arabic and RTL are first-class throughout, not a translation layer.

**Providers** (each optional, each listed only when installed and authenticated):
Claude Code, Codex, Gemini CLI, Cursor CLI, OpenCode, Hermes, Kimi, GLM, DeepSeek,
Antigravity. nassaj ships no keys and asks for none of its own.

**Production release install** requires Node 24 on Linux x64 with glibc 2.39 or newer, plus `curl`, `jq`, and `tar`. It needs no checkout, npm, or GitHub token: use the Arabic command block above to resolve `latest` from the public `AlKindy-OSS/nassaj` release channel, verify the standalone installer asset against GitHub's API digest, and pass that exact release receipt and resolved commit to the installer.

The result is `prepared_not_activated`. Review the printed config path, point the service at the printed stable launcher, and activate/restart only through the separately approved owner `safe-restart` action. The installer does not claim `/health` or `updateReady` before the service starts and those values are verified. Later, the Update button prepares a resumable asynchronous job; a separate owner approval performs the safe restart.

**Legacy 1.44 nodes:** the first transition to Release Runtime is not a button action and must not retry the old updater. It is a one-time operator-run maintenance cutover with an owner-signed approval bound to each specific node. It preserves Git/PM2/database evidence, proves an explicit public 503 rather than a 502 during the window, fences new work, proves zero work, freezes writers, takes the final verified backup, and only then switches. Installing operator support, changing the service, and executing cutover require separate production authorization per node. Only after successful activation and `/health` proves `updateReady=true` with `artifact-runtime-v2` are **future** releases button-ready. See [ADR-135](docs/release-runtime-installation.md) for the full contract.

**Source/developer install** uses the Node range in `package.json` and is distinct from the production Release Runtime path:

```bash
npm install --include=dev      # required: NODE_ENV=production prunes the build tools
cp .env.example .env && chmod 600 .env
npm run doctor                 # read-only preflight; prints a ready-to-run fix per finding
npm run build && npm run server
```

**Security posture.** Host-level guards follow one question: are the accounts on this
instance operators of the host? By default they are assumed to be, so a finding — say the
server being able to reach `/var/run/docker.sock`, one `docker run -v /:/host` away from
host root — is logged loudly and surfaced at `GET /api/system/security-posture` while the
server boots. Set `NASSAJ_SECURITY_POSTURE=strict` on an instance serving untrusted users
and the same finding becomes a hard refusal to boot with its remediation steps. Platform
mode is always strict and cannot be downgraded, because authentication is disabled there.

**Restarting.** `bash scripts/safe-restart.sh` checks before it acts: with a live chat
session or work in flight it defers and explains rather than cutting them off; `--exec`
performs it. Do not substitute a raw process-manager restart — the drain design keeps the
process alive while a child session lives, so the port stays closed.

**Connectors.** Shared provider applications, the public origin, and local
activation live in a distinct **owner-only** setup area. Each member links only
their personal accounts once, for fan-out to their eligible Claude and Codex
homes. A catalog entry is not proof of certification or activation. See the
[connector setup guide](docs/guides/connectors-setup.md) or its
[Arabic edition](docs/guides/connectors-setup.ar.md).

**Versioning.** Release identities always contain four segments: increment the second
for a major batch (`1.41.0.0` → `1.42.0.0`), the third for a small feature, and the
fourth for a bug fix. See [CONTRIBUTING.md](CONTRIBUTING.md).

**License: AGPL-3.0-or-later.** If you run a modified version over a network, §13 obliges
you to offer its source to your users — point `VITE_PUBLIC_SOURCE_URL` at your public
repository when you build, and configure `VITE_RELEASE_REPO_URL` independently for the
public update channel.
