# ADR-160 bridge rehearsal / تجربة العبور

هذه حاضنة تحقق غير مكتملة؛ لا تمنح إذن تفعيل. تكتب في
`.artifacts/t1772-bridge-rehearsal` فقط، وتستخدم namespaces منفصلة وPM2 خاصًا.
لا تنسخ قاعدة حية أو `.env` حقيقية ولا تبني المرشحين.

This unfinished harness is verification infrastructure, not activation authority.
It uses immutable artifact contents, synthetic database rows, private PM2 and
user/mount/network/PID namespaces. HOME retains its value while its backing tree
is private. Dependencies and Git objects are read-only binds. The driver kills
the namespace and descendants on timeout.

Available checks:

```bash
node --test scripts/update-lab/bridge-rehearsal.test.mjs
node scripts/update-lab/bridge-rehearsal.mjs --old-baseline
node scripts/update-lab/bridge-rehearsal.mjs --observed-old-baseline
node scripts/update-lab/bridge-rehearsal.mjs --old-admission-rejection
node scripts/update-lab/bridge-rehearsal.mjs --bridge-source-job <exact-oid> <exact-server-build-id> <exact-client-build-id>
node scripts/update-lab/bridge-rehearsal.mjs --bridge-success <exact-oid> <exact-server-build-id> <exact-client-build-id>
node scripts/update-lab/bridge-rehearsal.mjs --bridge-timeout <exact-oid> <exact-server-build-id> <exact-client-build-id> before-application-import
node scripts/update-lab/bridge-rehearsal.mjs --bridge-timeout <exact-oid> <exact-server-build-id> <exact-client-build-id> after-startup-reconciliation
```

`captureBridgeBaseline()` captures old artifacts once. Reuse its returned path
with `prepareBridgeBaseline(baseline, options)` across related cases. Content and
mode inventories are verified before/after copying and before reuse. Supporting
package and launcher files come from the old provenance OID, never the candidate.
The old immutable launcher is invoked by the real old HTTP action route so its
parent identity is the real application process. No injected launcher is used.

CDP uses a constant private inspector configuration. Checkpoints require resolved
breakpoints, exact compiled source hash and paused stack location. No evaluation
or monkeypatch is available. Paused event loops do not prove HTTP 503; no such
claim may be inferred from a request timeout.

Current evidence includes old startup, real owner/member login and effective
grant resolution, encrypted synthetic credential round trip, scheduled job
preservation, expected audit/orphan cleanup, expired never-claimed permission
lease reconciliation, namespace write protection and timeout cleanup. Credential
verification uses a fresh process per assertion to avoid cached generation code.

The private PM2 shutdown contract pins `treekill:false` and `kill_timeout:86400000`.
Only the `bridge-fault` policy (the default) uses shortened environment deadlines:
`WARM_READY_TIMEOUT_S=1`, `POST_RESTART_HEALTH_ATTEMPTS=2`,
`POST_RESTART_HEALTH_INTERVAL_S=0`, `NASSAJ_OID_HEALTH_ATTEMPTS=2`, and
`NASSAJ_OID_HEALTH_INTERVAL_MS=250`. These are shortened laboratory deadlines;
results prove timeout recovery, not production timing or a SIGKILL crash seam.
Full triple and release rehearsals instead require `NASSAJ_OID_HEALTH_ATTEMPTS=90`
and `NASSAJ_OID_HEALTH_INTERVAL_MS=500`, with all three short WARM/POST overrides
absent from both `.env` and the ecosystem configuration. Before preparation, the
actual pinned PM2 slot must pass the full policy for its effective environment
and its nested environment when present; conflicting snapshots are rejected.

العربية: مهلات 2/250 وإعدادات WARM/POST المختصرة خاصة بسياسة أعطال الجسر الافتراضية.
تجارب التحديث الثلاثي والإصدار الكاملة تستخدم 90/500، وتتحقق قبل التحضير من
بيئة خانة PM2 الفعلية والمتداخلة مع غياب الإعدادات المختصرة.

Verified checkpoint evidence for c9584199 / server adc52e29 / client 11065e63:

| Case | Evidence directory | Result |
| --- | --- | --- |
| Configuration utility + exact action | `run-Qpz7KM` | Real old HTTP pending action, prepare/apply/checkBridgeConfig, exact action-id correlation, physical MODE placement, HTTP503 then normal-ready200 and served |
| Configuration restore after rollback | `run-YgEfq0` | Actual old-capsule rollback and previous-process attestation precede restoreBridgeConfig; original inode/bytes restored; database not restored |
| Actual old action → bridge | `run-p3fGxT` | `served` journal, exact process/nonces, local-main normal readiness, real client publisher before MODE, HTTP assets and auth/grants/data checks |
| Timeout before application import | `run-C5Rz3L` | Resolved breakpoint in actual index.js:209; predicates still present; old capsule killed candidate and restarted old; exact `rolled_back` receipt |
| Actual listener readiness | `run-ATm6zT` | Network HTTP 503 handled after inspector resume, followed by normal-ready HTTP 200 and served |
| Stranded source activation | `run-iEg1pH` | Real claim/release; activating job and matching active_job_id before bridge; failed + recovery receipt and cleared active_job_id after startup |
| External-unknown admission rejection | `run-ZRxPsT` | First old startup rejects reconciliation; no update transaction begins; no retry or database restore |
| Timeout after startup reconciliation | `run-HtOsBv` | Application.js:3840 after bridge consumed re-seeded predicates; old capsule rollback on resulting database; old auth/grants/decryption/jobs/assets work |

Audit/orphan/permission predicates are re-seeded **after** the successful old
baseline, preventing old startup from consuming the branches intended for the
bridge. Predicates and post-checkpoint state are saved logically. The failed
candidate is never resumed to manufacture late health; its death is observed
before attaching the inspector to the restored old process.

Unfinished acceptance: browser-level client compatibility, remaining checkpoint
matrix (including post-health), connector retention coverage, final pinned-artifact replay and live configuration application. The production
configuration utility has now been exercised inside the private namespace;
conflict/partial-write paths additionally have unit coverage, not live evidence. Connector fixture
is currently unverified and its unsuccessful fixture is excluded: a bare repository connection failed the real
authority UDF guard (`run-NWT2F9`); no fake UDF, trigger removal or lease takeover
was used. Dependency-generation exchange and native lazy-load are outside these
two-generation results (B-1154). These partial results are not live admission.

Development artifact f4adc539/89150a12 failed real startup with undefined
`resolveHostUpdateMode` in application.js. Its runs are failure evidence, never
activation approval. The current external-unknown case is an independent rejection
test, not an unconditional bridge baseline.

نقطة التثبيت الحالية تثبت العبور وحالتي تعافي المهلة وفحوص البيانات
والمصادقة وإصلاح مهمة المصدر المتروكة. تغطية connector وتعارض إعداد الوضع
وما بعد health وتوافق المتصفح وتبديل الاعتماديات لم تكتمل؛ اختُبرت أداة
الإعداد الفعلية وتراجعها في المختبر، ولا إذن حي من هذه النتائج.

### Three-generation private lab

`triple-rehearsal.mjs` captures exact reviewed bridge artifacts and creates a
private Git target from the approved native-package delta. It copies dependency
contents and every non-symlink mode exactly, then compares the complete v2
identity with the source before and after copying. Canonical host dependencies
are never an exchange endpoint. Public npm/prebuild/header caches are copied
into private backing directories; installation and activation have no network.

`triple-namespace.sh` pivots the mount namespace root into private backing,
detaches the previous root, closes inherited descriptors, and uses the original
non-root service UID and unchanged HOME value. Mount capabilities exist only during setup;
Node and PM2 run with all capability sets zero and NoNewPrivs=1. Host modules
and Git objects are read-only; private modules remain movable. Isolation and
actual timeout tests prove the host-data boundary and descendant termination.
The lab's own PID-namespace proc mount permits user-namespace mapping writes;
sys/irq/bus/fs and sysrq-trigger are masked read-only before capabilities drop.
Nested namespace creation, complete old-root detachment, process roots/cwd,
control-file write denial and unchanged host mountinfo are checked explicitly.
A second complete proc mount for that same private PID namespace is read-only
at `/proc-reference`, with nosuid/nodev/noexec. Nested remount-to-write attempts
must fail. It neither exposes host processes nor supplies a writable control path.

The unchanged `b500106` artifact native probe passed on sealed better-sqlite3
12.8 dependencies in `run-K1Vl0e`; the aggregate proof is
`.artifacts/t1772-layout-fixed-native-proof.json`. All eight probe packages
loaded, its child exited, and outer capability/NoNewPrivs checks passed before
and after. This is native-probe evidence, not PM2 activation or crash recovery.
Earlier libmount A/B results establish the effect of API selection; they are
not syscall traces. The approved proc mount selector applies to one command only.

The native happy scenario uses actual HTTP owner preparation/confirmation,
the approved consumer, installer, builds and native probe. A successful bridge
alone does not prove this scenario. Three-generation success, repeated dependency
contracts and retained-executor crash recovery require their own result files;
preparation-only or instrumented misses are not activation evidence.

المختبر الثلاثي يحافظ على UID غير الجذري وقيمة HOME مع backing خاص، ويسقط
الصلاحيات قبل Node وPM2. تُنسخ الاعتماديات بأوضاعها الدقيقة ويُتحقق من هويتها
قبل النسخ وبعده؛ لا تصبح اعتماديات المضيف طرفًا للتبديل. نجاح العبور السابق
لا يثبت التبديل الثلاثي أو تكراره أو تعافي الأعطال، ولا تمنح نتائج المختبر إذنًا حيًا.
يُنقل جذر مساحة التركيب إلى الجذر الخاص مع فصل الجذر القديم وإغلاق واصفاته.
تسمح proc الخاصة بالمختبر بخرائط مساحة المستخدم وتبقى عناصر التحكم محمية
للقراءة فقط؛ لا تُربط proc المضيف داخل التطبيق.
نجح الفاحص الأصلي للمرشح b500106 على اعتماديات12.8 المختومة في run-K1Vl0e؛
لا يغني ذلك عن إثبات التفعيل والتعافي عبر PM2. مرجع proc الإضافي يخص مساحة
PID الخاصة نفسها ويظل كاملًا للقراءة فقط، مع رفض تحويله للكتابة من العزل المتداخل.

### تجهيز بيئة إصدار العقدة / Prepared release runtime profile

الخيار `runBridgeIsolated(lab, entry, { privateDependencies: true, runtimeProfile: 'fleet-public-24.17-npm12', timeout })` مخصص للمختبر الخاص فقط. تبقى `HOME` كما هي، ويصبح `NASSAJ_UPDATE_LAB_ROOT=lab` و`PM2_HOME=$HOME/.pm2` و`DATABASE_PATH=lab/node/data/auth.db` و`TMPDIR=/var/tmp` على backing خاص. نقطة الدخول تحت `lab/harness` تعمل PID1 وبـcwd=lab. مصدر Node/npm العام ثابت في `run-Mx3eDp/tooling/usr` ويُركّب للقراءة فقط داخل `/usr` المعزولة، مع بصمات قبل التشغيل وبعده؛ لا إعدادات PM2 أو بيانات مضيف. هذا إعداد للمراجعة، وليس إثبات تجربة release أو تصريح تشغيلها؛ اختبار profile مستقل ولا يبدأ PM2 أو installer.

لا يوفّر `installAndBuildCandidate` مسارًا لتجاوز `npm ci` لهدف جديد، ولو كانت شجرة مطابقة موجودة في canonical dependency store. يعاد استخدام cache/prebuild/headers العامة فقط دون نقل إيصالات أو تغيير producer. ميزانية التجربة التالية: fresh واحدة بتقدير 5GiB وحدّ رفض عندما تقل المساحة الحرة عن16GiB. تحفظ SgWAN7 كدليل محاولات سابقة ولا تعاد كتابة صفوفها، وكذلك Ys7vYO وMx3eDp والمرجع الناجح K1Vl0e والـbaselines.

English: The fixed public Node24.17/npm12 profile is preparation for review, not a release execution claim. It preserves the private pivot boundary and HOME value, uses the driver’s `node/app` layout and private `HOME/.pm2` daemon directory, and mounts only pinned public interpreter/tool bytes read-only. The separate profile test starts no PM2 or installer. The existing producer always runs npm ci for a fresh target: only public cache, prebuilds and headers may be reused; no imported receipts or invented install bypass. Run one fresh laboratory at a time within the stated disk budget and retain all pending evidence.

نتيجة اختبار التكييف فقط: `run-u38PzS/release-profile-proof.json` و`runtime-profile-proof.json`؛ Node24.17.0/npm12.0.2 فعليان، execPath/SHA وnpm canonical/tree متطابقة، host node ومعلومات mounts ثابتة قبل/بعد. اختبار1/1 ناجح بلا PM2 أو install؛ لا يعادل دليل releaseflow. Profile-only result: actual runtime and isolation checks passed, with host interpreter and mount table unchanged; no release activation was attempted.


### مسار PM2 الخاص القصير / Short private PM2 path

كل بيئات الحاضنة تستخدم `PM2_HOME=$HOME/.pm2` مع بقاء HOME نصًا كما على المضيف وbacking خاص في `path.join(lab, 'home', '.pm2')` بوضع0700. ecosystem وchild assertions يستخدمان القيمة نفسها؛ قراءة dump/pid من خارج namespace تتم عبر `path.join(lab, 'home', '.pm2')`. لا mount جديد ولا نسخ إعداد PM2 حي ولا تغيير process.title. السبب المثبت: المسار الطويل السابق قُطع في cmdline إلى54بايت فرفض الحارس اللاحقة الدقيقة.

`pm2-home-profile.test.mjs`: actual daemon محدود في host-local وفي Node24.17/npm12، باستخدام الكبسولة المجمعة الأصلية من artifact1a4 دون تعديل، نجح2/2. دليل host-local/release في `run-Y944YQ/pm2-home-proof.json` و`run-sozTyP/pm2-home-proof.json` (حقلruntimeProfile يحدد البيئة). title الكامل وPID/start/exe وjlist/dump وفاحص `captureOidTripleSupervisor` الأصلي نجحت ثمأُوقف PM2؛ بقي host nodeSHA/mountinfo ثابتين. اختبارات العزل/profile الأخرى4/4 ناجحة. قبلأي تحضير مكلف، triple-child يفحص supervisor الأصلي أثناء baseline. هذه أدلة fixture/admission فقط وليست نجاح التحديث الثلاثي.

English: All laboratory environments use the unchanged HOME value with a private0700 `path.join(lab, 'home', '.pm2')` backing. The complete daemon title now fits without altering process.title or the product guard. Both actual private PM2 profiles passed original sealed-capsule supervisor capture and dump/process identity checks, followed by daemon cleanup. External evidence reads use `path.join(lab, 'home', '.pm2')`; no host PM2 settings are copied. The happy driver checks the original supervisor before invoking preparation. This establishes fixture compatibility, not triple activation or crash recovery.

### حدود الانتظار بعد B-1159 / Bounded observation after B-1159

مصافحة `executor_ready` تخص ملكية المعاملة المثبتة فقط، قبل نسخ الاعتماديات؛ ليست نجاح تفعيل أو إذن إيقاف. تبقى clone-ready وإعادة تحقق الموافقة والمالك وmain شروطًا قبل stop. انتظار launcher للنتيجة في V2 محدود900 ثانية، ولا يوقف الكبسولة أو يغيّر journal عند انتهاء الوقت؛ V1 يبقى120 ثانية. مهلة health في الحاضنة900 ثانية، والتحضير900 ثانية، وانتظار إثبات serving60 ثانية؛ namespace لها سقف إجمالي2400 ثانية (40 دقيقة) يشمل baseline والتحضير والتفعيل والتحقق والتنظيف. هذه حدود مراقبة وليست مدة توقف خدمة أو إذن إعادة محاولة.

فحص صغير منفصل `run-ztITUu/safe-stop-preflight-proof.json`: baseline1a4 الفعلية أقلعت، وnative SQLite :memory نجح، وsafe --json رجع0/sessionCount0. استُخدمت namespace القراءة فقط القائمة مع UID mapped0؛ لا typed-stop أو clone ولا ادعاء أنها تعيد سبب رفض HYUkrk. محاولة DoTgcK السابقة لم تصل إلى الفحص بسبب symlink مختبري ذي اسم `/host-modules` لا يحافظ على Node hoisting، وحُفظ فشلها دون نسبته إلى المنتج.

English: Readiness acknowledges durable executor ownership, not activation. V2 outcome observation is capped at900s without state mutation, owner termination or retry on timeout; V1 remains120s. Laboratory preparation and health each have900s limits, serving proof60s, and the enclosing namespace2400s. The independent readonly baseline diagnostic passed ordinary --json and in-memory SQLite only; it does not prove typed stop or explain HYUkrk’s failure.
