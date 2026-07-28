// PM2 ecosystem config for nassaj-dev (development sibling of nassaj/claudecodeui).
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  ⚠️  قالب مرجعي فقط — لا تشغّل منه (REFERENCE TEMPLATE ONLY — DO NOT RUN) ║
// ╚══════════════════════════════════════════════════════════════════════════╝
// هذا الملف (`ecosystem.config.example.cjs`) قالبٌ مرجعيّ محايد-المضيف لمفاتيح
// B-N-DRAIN البنيوية فقط؛ لا يحوي قيم المضيف (المنفذ/مسار DB/أصول WebAuthn/الأسرار).
// تشغيله مباشرةً بـ`pm2 start ecosystem.config.example.cjs` على عقدة **يُسقطها**:
// بلا `.env` يصير SERVER_PORT=undefined فيقع على المنفذ الافتراضي 3001 → EADDRINUSE
// → crash-loop → 502 (حادثة traventure 2026-06-30، الدرس في
// memory: incident_traventure_ecosystem_outage).
//
// ── النموذج الأسطولي الصحيح للتشغيل ──────────────────────────────────────────
// كل عقدة تشغّل nassaj-dev من **ملف ecosystem خاص بها** `ecosystem.<node>.config.cjs`
// (يولّده `bootstrap-node.sh` في nassaj-core بكل القيم inline: cwd/المنفذ/DB/الأسرار/
// أصول WebAuthn)، **لا من هذا القالب ولا من ملف باسم `ecosystem.config.cjs`**. ملفات
// العقد (`ecosystem.config.cjs` و`ecosystem.*.config.cjs`) غير متعقَّبة في Git (راجع
// .gitignore) كي لا تنجرف القيم السرّية إلى المستودع. هذا القالب `.example` هو
// المتعقَّب الوحيد، ودوره مرجعيّ بحت: يوضّح مفاتيح B-N-DRAIN الموحَّدة كي تُنسَخ منها
// (لا تُشغَّل) عند توليد ملف عقدة جديد.
//
// لماذا يبقى هذا القالب متعقَّباً:
// - مَرجع الحقيقة لمفاتيح B-N-DRAIN البنيوية الموحَّدة أسطولياً (treekill/kill_timeout/
//   drain/bind-window)، كي لا تنجرف بين العقد عند توليد ملفاتها من bootstrap.
// - يَحفظ الشكل المرجعي في الـ repo كي يَنجو ويُراجَع تاريخياً.
// - يَتطابق مع نَمط <repo>/ecosystem.config.cjs
//   لتسهيل العمليات وتَوحيد سياسة الـ logs.
//
// ── مبدأ التصميم: محايد-المضيف (host-neutral) — B-110 ────────────────────────
// تَراجَعنا عن إلغاء تَعقُّب هذا الملف (الذي كان سيفتّت مصدر الحقيقة الأسطولي).
// البديل: يبقى الملف **متعقَّباً وموحَّداً**، لكنه لا يحوي أي قيمة خاصة بمضيف
// (cwd/منفذ/أصول WebAuthn/مسار DB/أسرار). تلك القيم يقرأها التطبيق من `.env`
// المحلي لكل مضيف (غير متعقَّب). والملف هنا يحمل فقط مفاتيح B-N-DRAIN البنيوية
// (غير السرّية، الموحَّدة أسطولياً).
//
// كيف يعمل الإسقاط إلى .env بأمان: load-env.js يضبط كل مفتاح بشرط
// `if (!process.env[key])` — أي لا يَدُوس على متغيّر موجود مسبقاً. وPM2 يضع كتلة
// env هذه في process.env **قبل** تحميل التطبيق، فلو وُجد المفتاح هنا لطغى على
// .env. لذا: حَذْفُ المفتاح من هنا هو ما يُفعِّل قراءته من .env (السلوك المقصود).
//
// ملاحظات تَصميم حَرِجة (لا تَحذف):
// 1) الامتداد .cjs مَقصود: package.json يَحوي "type": "module"، لذا ملف بِامتداد .js
//    سَيُفسَّر كـ ESM ويَفشل PM2 في تَحميل module.exports.
// 2) لا cwd هنا: PM2 يجعل cwd افتراضاً = مجلد ملف الإعداد (= جذر مستودع كل
//    مضيف)، فيصير host-correct تلقائياً. تثبيت cwd كان يربط الملف بمضيف واحد.
// 3) المنفذ ومسار DB وأصول WebAuthn تأتي من `.env` المحلي. الوسيط `--port` يُمرَّر
//    من args هنا (المسار الموثَّق للربط) ويبقى موحَّداً؛ إن لزم منفذٌ مختلف لمضيف
//    فعدّله في .env (SERVER_PORT) — الكود يقرأ SERVER_PORT لا PORT (راجع
//    server/index.js: `const SERVER_PORT = process.env.SERVER_PORT || 3001`).
// 4) المتَغيِّر الذي يَقرأه التَطبيق لمسار DB هو DATABASE_PATH (راجع
//    server/load-env.js). يأتي الآن من .env؛ غيابه عن .env يُسقِط الكود إلى
//    ~/.cloudcli/auth.db الخاص بالإنتاج — فتأكّد أن .env يضبطه على كل مضيف.
// 5) JWT_SECRET من `.env` حصراً (مصدر واحد ثابت) — لا يُمرَّر من هنا إطلاقاً كي
//    لا يتعارض السرّان (حادثة B-70: env≠.env قلب السرّ وطرد التوكنات).
// 6) script يَفترض وجود dist-server/ — يَجب تَنفيذ `npm run build` مَرّة واحدة
//    قبل أوّل `pm2 start ecosystem.<node>.config.cjs` (ملف العقدة، لا هذا القالب).

module.exports = {
  apps: [
    {
      name: 'nassaj-dev',
      // لا cwd (B-110): PM2 يجعل cwd = مجلد ملف الإعداد = جذر مستودع كل مضيف،
      // فيصير host-correct تلقائياً ويبقى الملف محايد-المضيف.
      script: 'dist-server/server/index.js',
      args: '--port 3004',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      // باعد بين محاولات إعادة التشغيل (B-23): بدون backoff كانت 10 محاولات
      // EADDRINUSE تُحرق max_restarts في ~5 ثوانٍ وتترك العملية errored.
      exp_backoff_restart_delay: 1000,
      // ── max_memory_restart مُعطَّل عمداً (B-130) ────────────────────────────
      // كان: max_memory_restart: '768M' (وقائي ضد OOM، نوبة 2026-06-06؛ رُفع
      // 512M→768M بعد B-23، تجاوز 586MB في 2026-06-11). لماذا أُزيل: آلية PM2
      // (lib/Worker.js) تُطلق reloadProcessId (= SIGINT في fork-mode) بمجرّد
      // تجاوز RSS الحدَّ، بلا أي معرفة بالجلسات الحيّة. مع treekill:false +
      // kill_timeout=24h + drain بلا سقف (أدناه)، تدخل العملية في drain تنتظر
      // خروجها قبل تشغيل البديلة، فلا مستمع على المنفذ طوال الـdrain ما دامت
      // جلسة claude ابنة حيّة → انقطاع 502 تلقائي متكرّر يتجاوز بوّابة
      // safe-restart.sh كلياً (حادثة B-129: 916MB عند 06:57:47 UTC 2026-07-06
      // → احتجاز ~18 دقيقة). حذف المفتاح يجعل pm2_env.max_memory_restart =
      // undefined فتُعطَّل آلية Worker تماماً (شرطها هناك `!== undefined`).
      // البديل: حارس ذاكرة يحترم الجلسات scripts/memory-guard.sh (من cron) يقيس
      // RSS ويعيد التشغيل فقط عبر safe-restart.sh --exec عند نافذة خالية من
      // الجلسات/الـworkflows. ⚠️ لا تُعِد هذا المفتاح إلا مع حلٍّ للتفاعل السامّ
      // (مثلاً فصل خدمة الجلسات ADR-021). النظام ~10GB فهامش تأجيل الحارس آمن.
      // treekill:false إلزامي (ADR-021/ADR-022): إشارات PM2 — بما فيها SIGKILL
      // بعد kill_timeout — تصيب العملية الأم فقط، فلا تُقتل عمليات claude الأبناء.
      treekill: false,
      // kill_timeout = أقصى مهلة تنتظرها PM2 بعد إشارة الإيقاف قبل أن ترسل
      // SIGKILL — وبفضل treekill:false (أعلاه) هذا الـ SIGKILL يصيب **العملية
      // الأم فقط**؛ عمليات/workflows claude الأبناء (orphans) تبقى حية وتُكمل،
      // فالقيمة هنا لا تقطع أي دور جارٍ، إنما تحدّ متى تتوقف PM2 عن انتظار خروج
      // الأم النظيف. علاقتها بـ DRAIN_TIMEOUT_MS:'0' (في env أدناه): الـ drain
      // داخل التطبيق بلا سقف زمني إطلاقاً (نيّة B-N-DRAIN: الأدوار قد تعمل
      // ساعات)، لذا يجب أن يفوق kill_timeout أطول دور متوقَّع حتى لا تَقطع PM2
      // انتظارها للأم بينما الـ drain ما زال مفتوحاً منطقياً.
      //
      // B-95 (تصحيح خلط B-23): مدخل B-23 خفّض هذه القيمة 24h→5min بحجّة «الخادم
      // صار يحرّر المنفذ فوراً». ذلك صحيح لكنه يخصّ **تحرير المنفذ** (server.close
      // في shutdown-drain.service.ts يفكّ المقبس فوراً فتُقلع البديلة بلا
      // EADDRINUSE) — وهو أمرٌ مستقل تماماً عن **مهلة قتل الأم**. خلْطُ الأمرين
      // جعل kill_timeout=5min يناقض DRAIN_TIMEOUT_MS=0: drain بلا سقف لكن الأم
      // تُقتَل بعد 5 دقائق. الحادثة (2026-06-27، wf_ef5ba242) أثبتت دوراً يتجاوز
      // 58 دقيقة. لذا نعيد القيمة إلى 24h (ما قبل B-23) لتتسق مع drain بلا سقف.
      // ملاحظة: مع treekill:false، رفع هذه القيمة لا يخاطر بإطالة قتل الأبناء —
      // فهم لا يُقتلون عبر هذا المسار أصلاً؛ الخطر الوحيد لو خُفِّضت هو خروج الأم
      // المبكر وانفصام الرؤية الذي سبّب الحادثة.
      kill_timeout: 86400000,
      // ── B-24: كبح respawn الزائف (ghost) بعد drain طويل ─────────────────────
      // God.handleExit في PM2 7.0.1 (lib/God.js:404) يقرّر إعادة التشغيل من
      // clusters_db[pm_id] — أي من **شاغل الخانة الحالي** — بلا أي حارس pid. لذا
      // حين تخرج النسخة القديمة متأخّرةً (drain بلا سقف) بينما البديلة online،
      // يرى PM2 خانةً online فيستنتج «انهيار» ويُطلق نسخةً ثالثة زائفة تفشل على
      // المنفذ. حارس الربط (B-41) يمنعها من حلقة EADDRINUSE لكنها تخرج 0 فيتكرّر
      // handleExit إلى ما لا نهاية (exp_backoff سقفه 15s، وunstable_restarts لا
      // يرتفع لأن عمر كل شبح يفوق min_uptime).
      // المدخل الوحيد في handleExit الذي يُلغي القرار مهما كانت حالة الخانة هو
      // stop_exit_codes (God.js:414). لذا: النسخة التي تكتشف عند نهاية الـdrain
      // أنها **يتيمة** (ملف pid الخاص بـPM2 صار يحمل pid حيّاً غيرها) تخرج بالكود
      // 75 (EX_TEMPFAIL — لا يُنتجه Node أصلاً فلا يلتبس بانهيار حقيقي)، فيَعُدّ
      // PM2 خروجها إيقافاً مقصوداً ولا يولّد شبحاً. أي خروج آخر يبقى 0 حرفياً،
      // فإشارة SIGINT اليدوية على النسخة المتتبَّعة ما زالت تُعيد تشغيلها ذاتياً.
      // ⚠️ القيمة مُقترنة بـ DRAIN_ORPHAN_EXIT_CODE في server/index.js (يفرض
      // التطابقَ اختبارُ server/index.drain-ghost-respawn.test.js). لا تُغيَّر هنا
      // وحدها. تخفيف لا حلّ جذري: محاسبة PM2 تبقى مشوّهة (الخانة تُوسم stopped
      // بينما البديلة حيّة) — الحلّ البنيوي يبقى ADR-028 (cluster mode).
      // لا يسري إلا بعد restart يُعيد قراءة ملف الـecosystem ثم pm2 save.
      stop_exit_codes: [75],
      watch: false,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
      // لا out_file/error_file مطلقَين (B-110): تثبيت مسار HOME مطلق يربط الملف
      // بمضيف. حذفهما يجعل PM2 يكتب افتراضاً إلى $HOME/.pm2/logs/nassaj-dev-out.log
      // و -error.log — وهو نفس المسار حرفياً على alkindy (لا تغيير سلوك) لكنه
      // host-correct على بقية العقد.
      env: {
        // ── مفاتيح B-N-DRAIN/الأسطول البنيوية فقط (غير سرّية، موحَّدة لكل مضيف) ──
        // الخاص-بالمضيف (SERVER_PORT/PORT/HOST/DATABASE_PATH/WEBAUTHN_*/JWT_SECRET)
        // أُزيل من هنا عمداً (B-110) ويأتي من `.env` المحلي — راجع رأس الملف.
        NODE_ENV: 'production',

        // ── OC-01 (T-855) — إلحاق ثنائي opencode بـPATH ────────────────────
        // عملية PM2 لا تقرأ ~/.bashrc، ومواقع نداء المزوّد تستدعي `opencode`
        // عارياً عبر PATH → بدون هذا الإلحاق تظهر بطاقة opencode «غير مثبَّت»
        // على كل عقدة أسطول جديدة. لا يُضبط من .env لأن load-env.js لا يدوس
        // مفتاحاً موجوداً وPATH موجود دائماً، فلا بدّ من ضبطه هنا.
        // محايد-المضيف (B-110): المسار مشتقّ من os.homedir() لا من مسار مطلق مثبَّت
        // المثبَّت في ملف عقدة alkindy. الإلحاق مشروط فلا يتكرّر.
        // يسري فقط عند restart يُعيد قراءة ملف الـecosystem
        // (pm2 restart ecosystem.<node>.config.cjs --update-env) ثم pm2 save —
        // ‏safe-restart.sh --exec (restart-بالاسم) لا يطبّقه وحده.
        PATH: (() => {
          const bin = require('node:path').join(
            require('node:os').homedir(),
            '.opencode',
            'bin'
          );
          const base = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
          return base.split(':').includes(bin) ? base : `${base}:${bin}`;
        })(),

        // ADR-041 (B-80): يُفعّل سجل الإعادة (replay) القرائي لجلسات claude،
        // المعزول في SessionRegistry خاص خلف هذا العلم (server/session-registry.js:
        // flagEnabled يقبل 1/true/yes/on). إطفاؤه (حذف السطر) no-op كامل يعيد المسار
        // الحيّ إلى ما قبل الشريحة بلا فقد بيانات. يُقرأ من process.env عبر getter حيّ.
        SESSION_REGISTRY_claude: '1',

        // B-117 (تشخيصي، مؤقّت): يُفعّل كتابة سجلّات @anthropic-ai/claude-agent-sdk
        // التلقائية. الـSDK يقرأ process.env.DEBUG_CLAUDE_AGENT_SDK عبر A$() الذي
        // يقبل 1/true/yes/on (sdk.mjs: yw()/spawnLocalProcess)، فيكتب ملفاً باسم
        // sdk-<id>.txt تحت <CLAUDE_CONFIG_DIR>/debug/ (المعزول per-user:
        // ~/.nassaj-users/<userId>/.claude/debug/، أو ~/.claude/debug/ للمشترك).
        // لازمٌ لحسم زناد B-117. إطفاؤه (حذف السطر) no-op كامل. لا يمسّ node_modules.
        DEBUG_CLAUDE_AGENT_SDK: '1',

        // ADR-048 / B-93: تفعيل reconcile مهام الخلفية بعد restart — خدمة
        // read-only fail-safe تشتقّ تصحيح stopped→completed عند إعادة فتح الجلسة.
        // مُتحقَّق ميدانياً قبل التفعيل: wf_1ea9f41d (7/7 → بطاقة completed)،
        // والحادثة الأصلية wf_ef5ba242 (17/15 → لا تصحيح، محافظة ضد false-positive).
        // للإطفاء وإرجاع السلوك byte-for-byte: احذف السطر أو اجعله '0'.
        WORKFLOW_RECONCILE: '1',

        // ── B-103 المرحلة 1 — مُشغِّل الورشات الدائم (WORKFLOW_SUPERVISOR) ────
        // مصدر الحقيقة للدوام عند إعادة بناء الحالة من ecosystem؛ يطابق الحقن
        // الحيّ (safe-restart --set WORKFLOW_SUPERVISOR=1). غيابه من هذا القالب
        // كان يعني أن كل عقدة أسطول جديدة تنطلق **بلا مشرف ورشات** بينما عقدة
        // alkindy تعمل به — انحراف صامت بين العقد. مفتاح بنيوي غير سرّي فموضعه
        // هنا لا في .env. المرحلة 2 (WORKFLOW_SUPERVISOR_CHAT_LOCK) تبقى OFF حتى
        // soak 72h + توقيع qa-critic. للإطفاء: احذف السطر أو اجعله '0'.
        WORKFLOW_SUPERVISOR: '1',

        // ── ADR-064 — تفعيل حارس المنسّق (opt-in على مستوى العملية) ──────────
        // يفعّل الحقن الإعلامي عند التفويض عبر Agent/Task. الأثر إعلامي بحت
        // (additionalContext): يُحقن كنصّ سياق، بلا permissionDecision، fail-safe
        // مطلق (أي شكّ ⇒ {})، فلا يحجب/يرفض أي تفويض ولا يمسّ canUseTool.
        // البوابة: NASSAJ_COORDINATOR==='1' حصراً (أي قيمة أخرى ⇒ no-op فوري).
        // غيابه من القالب كان يترك كل عقدة جديدة بلا هذا الحارس.
        // للإطفاء: احذف السطر أو اجعله '0'.
        NASSAJ_COORDINATOR: '1',

        // ── B-41 (self-hosting trap) — single-listener bind guard ────────────
        // T-95 (2026-06-13) diagnosed a 7.5h EADDRINUSE crash-loop (2026-06-12
        // 17:14 → 2026-06-13 03:13). The running build ALREADY had B-23 (port
        // released on stop via server.close()), proven by the
        //   "[DRAIN] SIGTERM: listener closed — port released"
        // line that ended the loop at 03:13:39. So the predecessor was holding
        // the port simply because it had never been signaled to stop — PM2
        // fork-mode lost its pid under treekill:false (ADR-028/B-24) and spawned
        // a replacement beside the still-live original. The loop is broken by
        // the bind guard below, NOT by capping the drain. The owner-mandated
        // unbounded drain (B-N-DRAIN, 2026-06-09: roles may run for hours) is
        // therefore preserved.
        //
        // DRAIN_TIMEOUT_MS=0: drain with NO deadline (owner decision). A wedged
        //   drain still has two escape hatches: a second stop signal and PM2's
        //   kill_timeout. A positive value would opt a single run into a cap.
        DRAIN_TIMEOUT_MS: '0',
        // LISTEN_BIND_WINDOW_MS: how long a STARTING instance tolerates
        //   EADDRINUSE (a draining/ghost predecessor still on the socket) before
        //   exiting cleanly (0) instead of crash-looping. A healthy handoff
        //   binds in <1s; 10s absorbs slow ones. THIS is what breaks the loop.
        LISTEN_BIND_WINDOW_MS: '10000',

        // ── الخاص-بالمضيف يأتي من .env المحلي (B-110)، لا من هنا ─────────────
        // أُزيلت من هذا الملف عمداً ليبقى محايد-المضيف؛ كل مضيف يضبطها في `.env`:
        //   • SERVER_PORT (المنفذ — الكود يقرأه؛ PORT مهمَل) — مثال alkindy: 3004
        //   • HOST (مثال: 127.0.0.1)
        //   • DATABASE_PATH (مسار SQLite؛ غيابه يسقط إلى ~/.cloudcli/auth.db الإنتاجي)
        //   • WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN / WEBAUTHN_RP_NAME (هوية passkeys
        //     للنطاق المنشور؛ غيابها يسقط إلى localhost التطويري)
        //   • JWT_SECRET (سرّ التوقيع — .env حصراً، مصدر واحد، B-70)
        //   • ALLOWED_ORIGINS (اختياري؛ يضيف أصولاً لقائمة CORS — غيابه يبقي
        //     القائمة الافتراضية المُضمّنة، راجع server/index.js)
        // ملاحظة B-04: NASSAJ_DB_PATH كان توافقياً وغير مُستهلَك من الكود — أُسقط.
      },
    },
  ],
};
