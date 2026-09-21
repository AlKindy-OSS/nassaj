# مختبر استعادة المصدر المحلي / Local source recovery laboratory

هذه أدوات اختبار فقط. أثبتت تجربة الإقلاع الأول انتقال المصدر، لكن دورة التحديث التالي لم تجتز القبول بعد؛ نجاح اختبارات الحراس وTLS ليس إثبات نجاح الدورة الكاملة.
These are test-only tools. One rehearsal proved initial source recovery; subsequent activation has not passed acceptance. Guard/TLS tests do not prove the full cycle.

## المدخلات / Inputs

بعد اعتماد الالتزام النهائي، ابنِ مرشح الإنتاج المعزول مرة واحدة عبر المنتج المعتمد دون تفعيل. مرّر إلى `inspectSealedRecoveryLab` ثم `prepareLocalRecoveryLab`:
After pinning final main, build the production candidate once without activation. Pass:

- `expectedOid`: exact final local main OID.
- `planPath`: canonical sealed production `local-candidate-plan.json`.
- `cacheRoot`: existing public npm cache directory; copied into private HOME configuration.
- `publicMaterialRoot`: directory containing `ripgrep-v15.0.1-x86_64-unknown-linux-musl.tar.gz`.
- `materialize: true`: explicit opt-in to heavy private copies, only after measured capacity passes.
- `rehearsalScope`: defaults to `full`; explicit `first-boot-only` stops after the real source bootstrap and all first-boot checks.

`prepareLocalRecoveryLab` returns `{lab, entry, baseline}`. `runLocalRecoveryLab(prepared)` runs the existing triple namespace with private dependencies, a 40-minute ceiling and whole-namespace termination on timeout. No standalone command automatically materializes or runs this lab.

وضع `first-boot-only` اختيار صريح لا يغيّر الافتراضي الكامل. يقيس مرحلة `laboratoryFirstBoot` وحدها، مع إبقاء نسخ الكاش والمواد محسوبة ومحضّرة كما في الاختبار الكامل. يخرج بالحالة `source_recovery_first_boot_only_verified` و`nextUpdateVerified: false` بعد فحوص الأشجار والبيانات/auth/assets وjob/gate/index؛ لا ينشئ التزامًا لاحقًا أو يبدأ prepare/consumer/confirm. دليل الدورة الكاملة لمرشح سابق يبقى منفصلًا، ولا يُنسب إلى المرشح الجديد.
Explicit `first-boot-only` selects only the existing `laboratoryFirstBoot` budget, conservatively retaining the same cache/material copies. It reports `source_recovery_first_boot_only_verified` and `nextUpdateVerified: false` after tree/data/auth/assets/job/gate/index checks. It never creates the next commit or runs next prepare/consumer/confirm. A previous candidate's full-cycle evidence remains separate and is not claimed for this candidate.

## الدليل المطلوب / Required evidence

1. Real loaded old artifact bytes and private PM2 fork at port 3004; synthetic fixture DB only.
2. Exact full client/server/dependency tree identity against the retained production candidate. Lab-only manifest binds separate PID, config, source linked worktree and authority. No production candidate adoption API, build timestamp normalization, or hash substitution.
3. Real HTTPS loopback facade proxies real old `/health`; test certificate trusted only by the operator child using `NODE_EXTRA_CA_CERTS`. Untrusted TLS must fail. No host trust changes.
4. Actual registration in `restart_queued` with `auto_activate=0`, then actual source job confirm endpoint. New local-main process must settle `activated`, gate `OPEN`, and normal admission.
5. A fixture-only main commit without dependency changes; actual local prepare endpoint, installed retained consumer launcher, owner confirm endpoint, triple `pair_served` receipt and exact server/client/dependency health.
6. Served asset bytes, representative data/authentication and staged/dirty/untracked source preservation. Prepared-only is a failure.

The launcher runs in the private namespace with enforcement=1 and domains=client,server. It does not test the separate host systemd unit transition.

تُقرأ صلاحيات أقفال التحكم الثلاثة من البيئة الحية وتُرفض الملفات غير العادية أو غير المملوكة أو القابلة للكتابة للمجموعة/الآخرين. تُنشأ نظائر فارغة حصرًا في المختبر الجديد قبل التشغيل، بنفس الصلاحيات، دون استبدال أي ملف موجود أو تعديل `umask`. يحمل مدخل PM2 عنوان العملية كاملًا لتجنب اقتطاع المسار المختبري الطويل.
The three existing live control locks are inspected for regular type, ownership and absence of group/other write permissions. Empty counterparts are created exclusively in fresh scratch before startup, with exact baseline modes and no existing-file overwrite or umask change. PM2 receives the complete process title to prevent truncation of long laboratory paths.

يُفحص كذلك `dump.pm2` الحي كملف عادي مملوك بصلاحية `0600` ورابط واحد، وتُحفظ هويته وبصمته دون نسخ محتواه. يُنشأ ملف `[]` حصريًا بصلاحية `0600` في HOME المختبر قبل أول تشغيل PM2، وتُعاد مقارنة baseline والملف المختبري قبل تشغيل العزل؛ أي تغير يرفض التشغيل. أثبت اختبار PM2 الفعلي `start/save/stop/save/restart/save` نجاح حارسي حفظ التوقف والتشغيل بهذه التهيئة. ملف backup لا يفحصه هذا الحارس، ولا تُغيّر صلاحيته كحل إضافي. هذا لا يثبت نجاح الدورة الكاملة.
The live `dump.pm2` must be a regular owned0600 file with one link. Capture its identity and digest, never its saved environments. Exclusively seed `[]`0600 inside private HOME before the first PM2 startup, then recheck both identities before launching isolation; drift refuses launch. A real PM2 start/save/stop/save/restart/save probe verified both stopped and online persistence with this baseline. The guard does not inspect the backup file, whose permissions are not changed as an extra fix. This bounded probe does not prove a full update cycle.

## السعة والتنظيف / Capacity and cleanup

Provisional phase measurements are in `.artifacts/t1772-current-readiness-20260919/local-source-recovery-lab-phases.json`. Recompute using actual sealed candidate trees before copies. Source exchange swaps old/candidate trees; it does not allocate a second rollback copy. Triple activation does allocate a dependency exchange clone, counted separately. Both producers move installed dependencies rather than retain duplicates. General phases retain one 2 GiB reserve. The separate archive preparation phase must retain the production default **16 GiB plus three times incoming asset bytes**, after its preceding allocations. This replaces the general reserve for that phase; the dependency exchange clone does not yet exist. Use the maximum phase requirement, not a sum of phase reserves.

أثبتت تجربة `run-6oJytN` نجاح الإقلاع الأول ثم رفض أرشفة التحديث التالي قبل تبديل التشغيل، بحالة `PRE_CANDIDATE / restart_deferred_restored`. كان نموذج السعة القديم يغفل احتياط الأرشفة البالغ 16 GiB. يستمد القياس المصحح حجم الأصول من المرشح المختوم، ويقارن اختبار الحدود بالحارس الإنتاجي الفعلي. يفترض أن التعديل المختبري التالي يضيف ملف علامة خارج الواجهة؛ أي تعديل يغيّر مدخلات أصول الواجهة يتطلب قياسًا وميزانية جديدين. الأدلة في `replacement-60c7305dec/archive-capacity-readonly-proof.json` داخل مجلد الجاهزية؛ لا تعني إعادة حساب السعة نجاح الدورة.
The `run-6oJytN` rehearsal passed the first boot but rejected the next archive before switching runtime, ending `PRE_CANDIDATE / restart_deferred_restored`. The former capacity model omitted the 16 GiB archive reserve. Incoming bytes now come from the sealed client inventory, and a boundary test exercises the actual production guard. This estimate assumes the next private commit only adds a non-client marker file; changed client inputs require fresh measurement and budgeting. The readiness directory retains the read-only guard proof under `replacement-60c7305dec/archive-capacity-readonly-proof.json`; recalculation is not full-cycle acceptance.

The production candidate remains untouched outside lab scratch. Export `local-source-recovery-result.json`, preparation/identity records, logs and TLS/isolation evidence before removing only paths this task created. Never remove pre-existing baselines or caches. Production artifacts must still match the recorded hashes before live activation.

## التحقق الخفيف / Lightweight checks

`node --test scripts/update-lab/local-source-recovery-*.test.mjs`

Run the complete lightweight suite after fixture changes. Full-cycle acceptance requires both real activations against the final sealed candidate. Coverage percentage for the full harness is not claimed.
