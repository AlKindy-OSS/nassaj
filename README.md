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

المتطلّبات: **Node ‏22 أو 23**، وgit، والوكلاء التي تريد استعمالها مثبَّتة ومصادَقة مسبقاً.

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

## سياسة الإصدار

`X.n` لدفعة تغييرات كبيرة، و`X.x.n` لميزة صغيرة، و`X.x.0.n` لإصلاح خلل. التفصيل في [CONTRIBUTING.md](CONTRIBUTING.md).

## الرخصة

**AGPL-3.0-or-later**، كالمشروع الأصل — انظر [LICENSE](LICENSE) بما فيه الشروط الإضافية تحت المادة 7. والمادة 13 تلزم من شغّل نسخة معدَّلة عبر الشبكة بإتاحة مصدرها لمستخدميها: وجّه `VITE_SOURCE_URL` إلى مستودعك عند البناء، فتتبعه كل روابط المصدر داخل التطبيق.

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

**Install** — Node 22 or 23:

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

**Versioning.** `X.n` for a large batch of changes, `X.x.n` for a small feature,
`X.x.0.n` for a bug fix. See [CONTRIBUTING.md](CONTRIBUTING.md).

**License: AGPL-3.0-or-later.** If you run a modified version over a network, §13 obliges
you to offer its source to your users — point `VITE_SOURCE_URL` at your own repository
when you build and every in-app source link follows it.
