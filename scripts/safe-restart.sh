#!/usr/bin/env bash
# ============================================================================
# safe-restart.sh  (B-95 / حادثة 2026-06-27 wf_ef5ba242)
# ----------------------------------------------------------------------------
# الغرض / Purpose:
#   بوّابة ما-قبل-إعادة-التشغيل (pre-restart gate) لعملية PM2 `nassaj-dev`.
#   تفحص سجلّات الـ workflows (journal.jsonl) عبر كل جلسات المشروع، وتكشف هل
#   هناك workflow حيّ (وكلاؤه ما زالوا يعملون). إن وُجد عملٌ حيّ → تُنذر وتؤجّل
#   (لا تعيد التشغيل)؛ إن لم يوجد → تمرّ بصمت (exit 0) ليُكمل المُشغِّل restart.
#
#   Pre-restart gate for the `nassaj-dev` PM2 process. Scans every project
#   session's workflow journals (journal.jsonl) for a LIVE workflow (agents
#   still running). If live work is found → WARN and defer (do NOT restart);
#   otherwise → pass silently (exit 0) so the caller may proceed.
#
# سبب الوجود / Context:
#   حادثة 2026-06-27 (wf_ef5ba242): workflow خلفي أُطلق من جلسة Claude Code نجا
#   من restart السيرفر (treekill:false → الوكلاء orphans أكملوا العمل)، لكن
#   منطق الـ drain (countActiveSessionsByProvider في server/index.js) يَعدّ
#   جلسات المزوّدات بالذاكرة فقط ولا يرى الـ workflows، فخرجت الأم فوراً
#   وأصدرت الجلسة الجديدة إشعار "stopped" مبكّراً (انفصام رؤية، لا فقدان عمل).
#   الجذر في طبقة Claude Code SDK؛ هذه البوّابة تصحيح في طبقة نسّاج: لا تُطلق
#   restart ما دام هناك workflow حيّ على القرص لا تراه ذاكرة السيرفر.
#
# ⚠️ قراءة فقط افتراضياً: لا تقتل، لا تعيد تشغيل، لا تعدّل أي إعداد، لا تمسّ
#    journal. الوضع الافتراضي إنذاري بحت — لا ينفّذ restart إطلاقاً. لتنفيذ
#    restart فعلي بعد اجتياز البوّابة استعمل --exec (يتطلّب --force إن وُجد
#    عملٌ حيّ). آمن للتكرار.
#    READ-ONLY by default: never kills/edits. --exec opts into running the
#    restart only AFTER the gate passes; --force overrides a live finding.
#    تنبيه: pm2 restart يحجبه حارس عميل Claude Code؛ ضمن العميل سيفشل --exec
#    عند أمر pm2 — وهذا متوقَّع، عندها نفّذ السطر المطبوع يدوياً في طرفية المالك.
#
# الاستخدام / Usage:
#   bash scripts/safe-restart.sh                 # فحص فقط (إنذاري). exit 0=آمن،
#                                                #   3=عمل حيّ، 2=خطأ قراءة.
#   bash scripts/safe-restart.sh --json          # نفس الفحص، خرج JSON.
#   bash scripts/safe-restart.sh --exec          # افحص ثم نفّذ restart إن آمِن؛
#                                                #   إن وُجد عمل حيّ: امتنع (exit 3).
#   bash scripts/safe-restart.sh --force --exec  # تجاوز واعٍ: نفّذ restart حتى
#                                                #   لو وُجد عمل حيّ (يُسجَّل تحذير).
#   bash scripts/safe-restart.sh --set K=V --exec# حَقن env مُصرَّح به (allowlist)
#                                                #   ضيّق: يُضيف K=V فقط إلى العملية
#                                                #   الحيّة عبر بيئة معاد تركيبها
#                                                #   (env -i) + --update-env، مع عزل
#                                                #   الشيل الحالي وصون المفاتيح
#                                                #   الحسّاسة (تحقّق قبل/بعد). --set
#                                                #   قابل للتكرار. بلا --set: لا حَقن
#                                                #   والسلوك مطابق تماماً للسابق.
#                                                #   مثال B-117 (تفعيل تشخيص SDK):
#                                                #   --set DEBUG_CLAUDE_AGENT_SDK=1 --exec
#
# متغيّرات البيئة / Env vars:
#   PROC_NAME        اسم عملية PM2                 (افتراضي: nassaj-dev)
#   ECOSYSTEM        مسار ملف ecosystem العقدة (ecosystem.<node>.config.cjs) —
#                    يُستعمل فقط في رسائل الاسترداد المطبوعة (host-side)، لا في
#                    مسار restart الآمن. لا افتراض runnable: القيمة الافتراضية
#                    placeholder صريح (ecosystem.<node>.config.cjs) يجب أن يستبدله
#                    المالك باسم ملف عقدته الفعلي؛ مرّره صراحةً لرسالة دقيقة.
#   WF_BASE          جذر جلسات المشروع (transcripts)
#                    (افتراضي: المسار المحلول لـ
#                     ~/the governance repo/projects/-home-nassaj-Project-nassaj-dev)
#   FRESH_WINDOW_S   نافذة الحداثة (ثوانٍ) على agent-*.jsonl لاعتبار workflow
#                    حيّاً فعلاً (افتراضي: 180). لماذا: عدّ started>result وحده
#                    يُنتج false-positive من وكيل مات دون إصدار "result" (يبقى
#                    "حيّاً" للأبد). نشترط أيضاً أن يكون أحد ملفات agent-*.jsonl
#                    قد كُتب خلال هذه النافذة → نشاطٌ فعليّ لا شبح.
#
# رمز الخروج / Exit code:
#   0 = آمن (لا workflow حيّ ولا جلسة محادثة حيّة) — وإن طُلب --exec فالـ restart نجح/طُلب.
#   3 = عمل حيّ (workflow) موجود → أُجّل (أو، مع --force --exec، نُفّذ رغمه ثم 0).
#   6 = جلسة/جلسات محادثة تفاعلية حيّة (أبناء/أحفاد OS لعملية الخادم) → أُجّل
#       (B-168/T-880). أخطر من 3: بقاؤها أثناء restart يُغلق المنفذ 3004 ويُدخل
#       العملية طور drain بلا موت ⇒ 502 ممتد (B-95). رمز مخصّص ليميّزه مسار HTTP
#       آلياً (B-193/T-950) عن تأجيل الورشات. مع --force --exec: نُفّذ رغمه ثم 0.
#       الأسبقية: إن وُجدت جلسة وورشة معاً فالرمز 6 (الجلسة أخطر).
#       يُصدَر 6 أيضاً حين يفشل كشف الجلسات داخلياً والعملية online (fail-closed —
#       B-195): تعذّر تأكيد السلامة أثناء online يُعامَل كجلسة حيّة لا كـ«صفر آمن».
#   2 = خطأ قراءة/إعداد (مثلاً WF_BASE غير موجود، أو --set غير صالح/مفتاح حسّاس).
#   4 = العملية غير مُسجَّلة في PM2 (B-110) → لا restart بالاسم؛ ابدأ من ecosystem.
#       أو مُسجَّلة بحالة غير online (launching/stopping/errored/stopped) — يُرفض
#       القرار لأن كشف الجلسات الحيّة أعمى حينها ويخاطر بنافذة B-95 (B-168/T-880).
#   5 = فشل حَقن --set: تعذّر restart أثناء الحَقن، أو انجراف مفتاح حسّاس بعد
#       التنفيذ، أو لم يُطبَّق مفتاح --set (fail-closed — B-117).
#
# الخرج القابل للتحليل آلياً (B-168/T-880) — يُستهلك من مسار HTTP لاحقاً (B-193):
#   • --json:  كائن stdout يحوي sessionCount + liveSessions[] (pid,provider,ageS,sessionId,cmd)
#              + sessionServerPid + sessionDetectError + sessionDetectReason (B-195)
#              + sessionDetectBlock (B-198). يُصدَر بعد حسم القرار (online+B-195) فيعكسه لا حالة وسطى.
#   • دائماً:  سطر ملخّص على stderr بادئته `SR-SESSION-BLOCK count=N serverPid=… exit=6`
#              (ومع خطأ الكشف fail-closed: count=0 … reason=detect_error)، وسطر لكل
#              جلسة بادئته `SR-SESSION pid=… provider=… ageS=… sessionId=… cmd="…"`.
#
# ماذا تكشف الجلسات وكيف (B-168/T-880):
#   كل عملية مزوّد حيّة (`claude`/`codex`/`agy`/`opencode`/`hermes`) هي ابن/حفيد OS
#   لعملية PM2 `nassaj-dev`. نستنبط PID الخادم من `pm2 jlist` (لا من مسار مثبَّت —
#   تفادياً لعطل B-863 على عقد الأسطول)، ثم نمشي شجرة /proc (PPid من
#   /proc/<pid>/status، والهوية من /proc/<pid>/cmdline) لجمع كل الأحفاد ونطابق اسم
#   المزوّد على basename(argv[0]) بدقّة (أو مفسّر node/bun/python + سكربت باسم المزوّد،
#   أو مسار رمز السكربت داخل حزمة مزوّد معروفة مثل @anthropic-ai/claude-code — B-196)
#   لتفادي المطابقات الكاذبة (grep/محرِّر يحمل الاسم لا يُعدّ).
#
# ── التحقّق اليدوي (لا يوجد مشغّل اختبار للسكربتات في المستودع) ─────────────────
#   موجب (رصد وتأجيل):
#     bash scripts/safe-restart.sh --json | node -e 'let s="";process.stdin.on("d\
#       ata",d=>s+=d).on("end",()=>console.log(JSON.parse(s).sessionCount))'
#     # يطبع عدد جلسات المحادثة الحيّة الأبناء لعملية الخادم؛ الرمز = 6 عند > 0.
#     bash scripts/safe-restart.sh ; echo "exit=$?"   # يعرض SR-SESSION-BLOCK ويُرجِع 6
#   سالب (لا يُنسب لغير الأحفاد): مرّر SERVER_PID مغايراً عبر بيئة الكشف — عمليات
#     claude القائمة على المضيف لا تُعدّ ما لم تكن أحفاد الـ PID المستهدَف تحديداً
#     (النطاق = شجرة عملية الخادم لا «أي claude على الجهاز»). التحقّق الميداني
#     الموثّق: 2026-07-25 — الخادم pid=3397936، جلسة claude حيّة (pid=3650946) رُصدت
#     وأُجّل (exit 6). ثلاث حالات إسناد للكشف نفسه أثبتت النطاق: (1) إسناد لعملية
#     غير-قريبة (sleep) ⇒ sessionCount=0 رغم بقاء claude حيّاً على المضيف (لا يُنسب
#     لغير الأحفاد)؛ (2) إسناد لـ PM2 God (pid الأب للخادم) ⇒ رُصدت الجلسة كحفيد
#     (مشي الشجرة يشمل الأحفاد لا الأبناء المباشرين فقط)؛ (3) إسناد للخادم نفسه ⇒
#     رُصدت. ملاحظة: لا تُستعمل pid=1 للحالة السالبة — init سلفٌ لكل جلسة فيُطابق.
# ============================================================================
set -euo pipefail

# ── إعداد المسارات ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"

PROC_NAME="${PROC_NAME:-nassaj-dev}"
# ECOSYSTEM: ملف ecosystem الخاص بالعقدة. لا يوجد `ecosystem.config.cjs` متعقَّب
# قابل للتشغيل بعد B-115 (المتعقَّب صار `ecosystem.config.example.cjs` = قالب مرجعي
# لا يُشغَّل؛ وأي `ecosystem.config.cjs`/`ecosystem.*.config.cjs` محلي = مُتجاهَل في
# Git ويولّده bootstrap-node.sh لكل عقدة). لذا الافتراضي هنا **placeholder غير
# قابل للتشغيل** يُذكِّر المالك باستبداله باسم ملف عقدته الفعلي (مثل
# ecosystem.nassaj.config.cjs). يُستعمل في رسائل الاسترداد المطبوعة فقط، لا في
# مسار restart الآمن (الذي يستهدف $PROC_NAME). مرّر ECOSYSTEM=... لرسالة دقيقة.
ECOSYSTEM="${ECOSYSTEM:-$REPO_DIR/ecosystem.<node>.config.cjs}"
FRESH_WINDOW_S="${FRESH_WINDOW_S:-180}"

# جذر الـ workflows (transcripts): يُشتقّ ديناميكياً ليَحمِل عبر عقد الأسطول
# (مستخدمون/جذور HOME مختلفة لكل عقدة) بدل تثبيت مسار مطلق واحد الذي
# يُفشِل traventure/mujtana. البنية: <claude-root>/projects/<مسار-المشروع-مهروباً>
# حيث المهروب = REPO_DIR (مشتقّ من موقع السكربت) مع استبدال '/' بـ '-'. جذر claude:
# $CLAUDE_CONFIG_DIR إن وُجد (يحوي projects/)، وإلا $HOME/the governance repo. نحلّ الـ
# symlink لاحقاً (readlink أدناه) لأن المسار الفعلي عبر projects رمزيٌّ نحو
# ~/the governance repo (راجع reference_nassaj_core_symlink في memory). التجاوز عبر WF_BASE.
ESCAPED_PROJECT_PATH="${REPO_DIR//\//-}"
CLAUDE_ROOT="${CLAUDE_CONFIG_DIR:-$HOME/the governance repo}"
DEFAULT_WF_BASE="$CLAUDE_ROOT/projects/$ESCAPED_PROJECT_PATH"
WF_BASE="${WF_BASE:-$DEFAULT_WF_BASE}"
if [ -e "$WF_BASE" ]; then
  WF_BASE="$(readlink -f "$WF_BASE")"
fi

# ── تحليل الوسائط ───────────────────────────────────────────────────────────
DO_EXEC=0
FORCE=0
JSON=0
# SET_KEYS/SET_VALS: مصفوفتان متوازيتان تحملان أزواج --set KEY=VALUE المصرَّح بها
# صراحةً (allowlist ضيّق). فارغتان افتراضياً → لا حَقن env البتّة والسلوك مطابق
# تماماً للسابق. راجع كتلة «حَقن env المُصرَّح به» أدناه للأمان والتبرير (B-117).
SET_KEYS=()
SET_VALS=()

# قائمة المفاتيح الحسّاسة الممنوع أن يمسّها أي حَقن (تُرفض في --set صراحةً، وتُتحقَّق
# قبل/بعد التنفيذ أنها لم تنجرف). المجموعة الأولى مفاتيح انجرافي B-95/B-110:
#   PORT (تصادم منفذ) / JWT_SECRET (طرد الجلسات، B-70) / ALLOWED_ORIGINS (عطل CORS
#   500) / NODE_ENV (تقليم devDeps).
# المجموعة الثانية (توسعة qa-critic، مُتحقَّق منها ميدانياً في العملية الحيّة على
# pm2 7.0.1، 2026-07-02) — كلها حاضرة وحسّاسة تشغيلياً:
#   SERVER_PORT (المتغيّر الفعلي الذي يقرأه الكود؛ PORT مهمَل — حقنه يزيح المنفذ) /
#   DATABASE_PATH (يقلب القاعدة الحيّة) / WEBAUTHN_RP_ID·WEBAUTHN_ORIGIN·
#   WEBAUTHN_RP_NAME (يكسر passkeys) / OIDC_ISSUER_URL·OIDC_CLIENT_ID (يكسر SSO) /
#   HOST (يزيح ربط الاستماع، قد يقطع النفق). لا يُحقَن أيٌّ منها من هنا أبداً.
SENSITIVE_KEYS=(
  PORT JWT_SECRET ALLOWED_ORIGINS NODE_ENV
  SERVER_PORT DATABASE_PATH
  WEBAUTHN_RP_ID WEBAUTHN_ORIGIN WEBAUTHN_RP_NAME
  OIDC_ISSUER_URL OIDC_CLIENT_ID
  HOST
)

# مفاتيح البنية التحتية المحقونة قسراً لأجل تشغيل PM2 (HOME/PATH/PM2_HOME) لكن
# التي **يجب ألا تتغيّر إطلاقاً** في بيئة العملية الحيّة قبل/بعد الحَقن. الخطر
# (كشفه qa-critic، مُتحقَّق ميدانياً 2026-07-02): PATH في شِل جلسة Claude يحوي مسارات
# إضافية (~/.claude/plugins/cache/...) غير الموجودة في PATH العملية الحيّة؛ حقن
# "PATH=${PATH}" حرفياً يُسرّبها، وتنتشر لأبناء PTY/plugins (commandParser.js:288،
# plugin-process-manager.js:33). وPM2_HOME غائب في العملية الحيّة → إضافته انجراف
# absent→present. هذه المفاتيح ليست في SENSITIVE_KEYS (فهي محقونة عمداً لا مرفوضة
# في --set)، لكن تُفحص انجرافها قبل/بعد فيُرفض (exit 5) لو تغيّرت دون طلب صريح.
# ملاحظة: --set لهذه المفاتيح مرفوض ضمناً — دالة الحقن تبني قيمتها من مصدرها
# الموثوق وتتجاهل أي --set لها؛ ولأنها في PROTECTED_KEYS فأي انجراف ناتج يُكتشف.
PROTECTED_KEYS=(HOME PATH PM2_HOME)

# صحّة اسم متغيّر البيئة: يبدأ بحرف/شرطة سفلية ثم [A-Za-z0-9_].
_valid_env_name() { case "$1" in [A-Za-z_]*) [ -z "${1//[A-Za-z0-9_]/}" ] ;; *) return 1 ;; esac; }

# _is_sensitive KEY → 0 إن كان المفتاح ضمن SENSITIVE_KEYS.
_is_sensitive() {
  local k="$1" s
  for s in "${SENSITIVE_KEYS[@]}"; do [ "$k" = "$s" ] && return 0; done
  return 1
}

# _is_protected KEY → 0 إن كان المفتاح ضمن PROTECTED_KEYS (بنية تحتية تُحقَن قسراً
# لكن يجب ألا تنجرف قيمتها الحيّة). لا يُحقَن أيٌّ منها من المستخدم عبر --set.
_is_protected() {
  local k="$1" s
  for s in "${PROTECTED_KEYS[@]}"; do [ "$k" = "$s" ] && return 0; done
  return 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --exec)  DO_EXEC=1 ;;
    --force) FORCE=1 ;;
    --json)  JSON=1 ;;
    --set)
      # يتطلّب وسيطاً تالياً بصيغة KEY=VALUE.
      if [ "$#" -lt 2 ]; then
        echo "safe-restart: --set يتطلّب KEY=VALUE / --set requires KEY=VALUE" >&2
        exit 2
      fi
      shift
      _pair="$1"
      _k="${_pair%%=*}"
      _v="${_pair#*=}"
      if [ "$_pair" = "$_k" ] || [ -z "$_k" ]; then
        echo "safe-restart: --set يجب أن يكون KEY=VALUE / must be KEY=VALUE: $_pair" >&2
        exit 2
      fi
      if ! _valid_env_name "$_k"; then
        echo "safe-restart: اسم متغيّر غير صالح / invalid env name: $_k" >&2
        exit 2
      fi
      if _is_sensitive "$_k"; then
        echo "safe-restart: المفتاح $_k حسّاس ومحظور في --set (يُدار من ملف العقدة فقط) / sensitive key refused: $_k" >&2
        exit 2
      fi
      SET_KEYS+=("$_k")
      SET_VALS+=("$_v")
      ;;
    --set=*)
      # صيغة مدمجة --set=KEY=VALUE.
      _pair="${1#--set=}"
      _k="${_pair%%=*}"
      _v="${_pair#*=}"
      if [ "$_pair" = "$_k" ] || [ -z "$_k" ]; then
        echo "safe-restart: --set يجب أن يكون KEY=VALUE / must be KEY=VALUE: $_pair" >&2
        exit 2
      fi
      if ! _valid_env_name "$_k"; then
        echo "safe-restart: اسم متغيّر غير صالح / invalid env name: $_k" >&2
        exit 2
      fi
      if _is_sensitive "$_k"; then
        echo "safe-restart: المفتاح $_k حسّاس ومحظور في --set / sensitive key refused: $_k" >&2
        exit 2
      fi
      SET_KEYS+=("$_k")
      SET_VALS+=("$_v")
      ;;
    -h|--help)
      sed -n '2,117p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "safe-restart: وسيط غير معروف / unknown arg: $1" >&2
      exit 2 ;;
  esac
  shift
done

ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
emit() { echo "$(ts) [$1] $2" >&2; }   # السجل إلى stderr كي يبقى stdout نظيفاً لـ --json

# ── رؤية المهام الخلفية الحية (wf-*.service) — B-103/T-823، قراءة-فقط ──────────
# الغرض: أن يرى المُشغِّل المهامَّ الخلفية الحيّة قبل أي restart. هذه الكتلة
# **قراءة-فقط** بحتة: تسرد الوحدات فقط (systemctl list-units)، ولا تلمس منطق الدرين/
# العد/الإيقاف إطلاقاً، ولا تغيّر أي رمز خروج أو قرار (تُستدعى كبيان مستقل يُرجِع 0
# دائماً). الوحدات wf-*.service خدمات systemd عابرة يملكها مدير المستخدم و**تنجو من
# restart** بالتصميم (§ج-6)، فالعرض إعلاميٌّ لا يؤجِّل ولا يحجب.
#
# محروسة بالعلم WORKFLOW_SUPERVISOR: **OFF ⇒ لا سطر جديد إطلاقاً** (سلوك مطابق
# للسابق). نستنبط العلم من: (1) بيئة هذا الشِل صراحةً، أو (2) بيئة عملية PM2 الحيّة
# (jlist، قراءة-فقط). إن تعذّر الحسم أو كان مطفأً ⇒ صمت تام.
_truthy() { case "$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z')" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }

_wf_supervisor_flag_on() {
  # (1) علم صريح على هذا الشِل.
  _truthy "${WORKFLOW_SUPERVISOR:-}" && return 0
  # (2) بيئة عملية PM2 الحيّة (قراءة-فقط عبر jlist؛ لا يحجبها حارس العميل).
  if command -v pm2 >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
    local v
    v="$(pm2 jlist 2>/dev/null | PROC_NAME="$PROC_NAME" node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        let arr;try{arr=JSON.parse(s)}catch(_){process.stdout.write("");return}
        const p=(arr||[]).find(x=>x&&x.name===process.env.PROC_NAME);
        const val=p&&p.pm2_env&&p.pm2_env.env&&p.pm2_env.env.WORKFLOW_SUPERVISOR;
        process.stdout.write(String(val==null?"":val));
      })' 2>/dev/null || true)"
    _truthy "$v" && return 0
  fi
  return 1
}

# يعرض المهامَّ الخلفية الحيّة (قراءة-فقط). يُرجِع 0 دائماً — لا يؤثّر في أي قرار.
show_live_wf_units() {
  _wf_supervisor_flag_on || return 0            # العلم OFF ⇒ لا سطر جديد
  command -v systemctl >/dev/null 2>&1 || return 0
  local units n=0 u desc
  units="$(systemctl --user list-units --type=service --state=active,activating \
             --no-legend --plain 'wf-*.service' 2>/dev/null \
             | awk '{print $1}' | grep -E '^wf-.*\.service$' || true)"
  [ -n "$units" ] && n="$(printf '%s\n' "$units" | grep -cE '^wf-' || true)"
  emit INFO "المهام الخلفية الحيّة (wf-*.service): $n — تنجو من restart (وحدات عابرة)، للعرض فقط لا تؤجّل الدرين."
  if [ "$n" -gt 0 ] 2>/dev/null; then
    while IFS= read -r u; do
      [ -n "$u" ] || continue
      desc="$(systemctl --user show -p Description --value "$u" 2>/dev/null || true)"
      emit INFO "  • $u${desc:+  ($desc)}"
    done <<< "$units"
  fi
  return 0
}

# ── رؤية جلسات المزوّدات الحيّة عبر /health (OC-08) — قراءة-فقط ─────────────────
# الغرض: أن تسمّي رسالةُ التأجيل المزوّدَ (خصوصاً opencode) وعددَ جلساته الحيّة،
# بدل أن تُعدّ في الدرين بلا هوية. المصدر: نقطة /health العامة التي تصدّر
# activeSessions (أعداد صحيحة فقط، بلا معرّفات — آمنة على نقطة غير مصادَقة).
# **قراءة-فقط بحتة**: لا تغيّر رمز الخروج ولا قرار الدرين؛ إعلامية فقط. تصمت
# تماماً إن تعذّرت القراءة (لا curl/node، أو الخادم غير مستجيب، أو الحقل غائب).
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${HEALTH_PORT:-3004}/health}"

# يطبع أعداد الجلسات الحيّة لكل مزوّد له عدّ > 0 (سطر لكل مزوّد). لا مخرَج البتّة
# عند التعذّر أو انعدام الجلسات. يُرجِع 0 دائماً.
show_live_provider_sessions() {
  command -v curl >/dev/null 2>&1 || return 0
  command -v node >/dev/null 2>&1 || return 0
  local body
  body="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true)"
  [ -n "$body" ] || return 0
  local lines
  lines="$(printf '%s' "$body" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      let o;try{o=JSON.parse(s)}catch(_){return}
      const a=o&&o.activeSessions;
      if(!a||typeof a!=="object")return;
      for(const [k,v] of Object.entries(a)){
        const n=Number(v);
        if(Number.isFinite(n)&&n>0)process.stdout.write(`${k}=${n}\n`);
      }
    })' 2>/dev/null || true)"
  [ -n "$lines" ] || return 0
  emit INFO "جلسات المزوّدات الحيّة (من /health، للعرض فقط لا تؤجّل بذاتها):"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    emit INFO "  • ${line%%=*}: ${line#*=} جلسة حيّة"
  done <<< "$lines"
  return 0
}

# ── فحص توفّر القراءة ───────────────────────────────────────────────────────
if [ ! -d "$WF_BASE" ]; then
  emit ERR "WF_BASE غير موجود / not found: $WF_BASE"
  [ "$JSON" -eq 1 ] && printf '{"ok":false,"error":"wf_base_missing","wfBase":%s}\n' "\"$WF_BASE\""
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  emit ERR "node غير متوفّر — مطلوب لتحليل JSONL / node required for JSONL parsing"
  exit 2
fi

# ── الكشف عن الـ workflows الحية (قراءة فقط، عبر Node) ───────────────────────
# المنطق لكل مجلد wf_*:
#   live = ( عدد "started" > عدد "result" في journal.jsonl )  AND
#          ( أحدث mtime لأي agent-*.jsonl ضمن FRESH_WINDOW_S الأخيرة )
# الشرطان معاً: started>result يلتقط عدم اكتمال، ونافذة الحداثة تستبعد الأشباح
# (وكيل مات دون "result"). نستخدم Node لتحليل JSON بأمان (لا grep هشّ، ولا jq).
SCAN_JSON="$(
  WF_BASE="$WF_BASE" FRESH_WINDOW_S="$FRESH_WINDOW_S" node - <<'NODE'
const fs = require('fs');
const path = require('path');
const base = process.env.WF_BASE;
const freshMs = (parseInt(process.env.FRESH_WINDOW_S, 10) || 180) * 1000;
const now = Date.now();

// اجمع كل مجلدات wf_* تحت <session>/subagents/workflows/ عبر كل الجلسات.
const wfDirs = [];
let sessions = [];
try { sessions = fs.readdirSync(base, { withFileTypes: true }); } catch (_) {}
for (const s of sessions) {
  if (!s.isDirectory()) continue;
  const wfRoot = path.join(base, s.name, 'subagents', 'workflows');
  let entries;
  try { entries = fs.readdirSync(wfRoot, { withFileTypes: true }); } catch (_) { continue; }
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith('wf_')) {
      wfDirs.push({ session: s.name, wf: e.name, dir: path.join(wfRoot, e.name) });
    }
  }
}

const live = [];
for (const w of wfDirs) {
  const journalPath = path.join(w.dir, 'journal.jsonl');
  let started = 0, result = 0;
  let raw;
  try { raw = fs.readFileSync(journalPath, 'utf8'); } catch (_) { continue; }
  for (const lineRaw of raw.split('\n')) {
    const line = lineRaw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; } // سطر تالف يُتجاوز
    if (obj && obj.type === 'started') started++;
    else if (obj && obj.type === 'result') result++;
  }
  if (started <= result) continue; // كل ما بدأ أصدر نتيجة → غير حيّ

  // نافذة الحداثة: أحدث mtime لأي agent-*.jsonl (نستثني .meta.json).
  let newestMtime = 0;
  let files;
  try { files = fs.readdirSync(w.dir); } catch (_) { files = []; }
  for (const f of files) {
    if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue; // .meta.json مُستبعَد
    let st;
    try { st = fs.statSync(path.join(w.dir, f)); } catch (_) { continue; }
    if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs;
  }
  const ageS = newestMtime ? Math.round((now - newestMtime) / 1000) : null;
  const fresh = newestMtime > 0 && (now - newestMtime) <= freshMs;
  if (!fresh) continue; // started>result لكن لا نشاط حديث → شبح، لا نحجب عليه

  live.push({
    session: w.session,
    wf: w.wf,
    pending: started - result,
    newestAgentAgeS: ageS,
  });
}

process.stdout.write(JSON.stringify({
  ok: true,
  wfBase: base,
  freshWindowS: freshMs / 1000,
  scanned: wfDirs.length,
  liveCount: live.length,
  live,
}));
NODE
)"

# ── تفسير النتيجة ───────────────────────────────────────────────────────────
LIVE_COUNT="$(printf '%s' "$SCAN_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).liveCount))}catch(_){process.stdout.write("ERR")}})')"

if [ "$LIVE_COUNT" = "ERR" ] || [ -z "$LIVE_COUNT" ]; then
  emit ERR "تعذّر تحليل نتيجة الفحص / scan parse failed"
  [ "$JSON" -eq 1 ] && printf '%s\n' "$SCAN_JSON"
  exit 2
fi

# ── الكشف عن جلسات المحادثة التفاعلية الحيّة (B-168/T-880) — قراءة فقط ──────────
# الثغرة: البوّابة كانت تفحص journal الورشات فقط وتَعمى عن جلسات المحادثة الحيّة —
# وهي عمليات مزوّد (claude/codex/agy/opencode/hermes) أبناءُ/أحفادُ OS مباشرون
# لعملية PM2 nassaj-dev. تصميم الـ drain (treekill:false + kill_timeout=24h) يعني
# أن restart مع جلسة ابنة حيّة يُغلق المنفذ 3004 ويُبقي العملية `stopping` بلا موت
# ⇒ انقطاع 502 ممتد (حادثتا B-95 ‏2026-06-27/30، وB-168 ‏2026-07-11، وnear-miss
# ‏2026-07-14). هذا الكشف يسدّها كفئة تأجيل ثالثة.
#
# ⚠️ B-863: لا نعتمد على أي مسار مثبَّت (WF_BASE أو مسار المحور) — يُفشِل precondition
# على عقد الأسطول (WF_BASE ثابت على المحور). نستنبط PID الخادم من `pm2 jlist`
# (قراءة-فقط، لا يحجبها حارس العميل) ونمشي شجرة /proc منه فقط. لا pm2 ⇒ لا PID ⇒
# لا نستطيع الكشف: نُبقي sessionCount=0 مع تحذير (fail-open هنا آمن — بلا pm2 لا
# restart-بالاسم أصلاً، وحارس precondition لاحقاً يُرجِع 4).
#
# لماذا شجرة /proc لا `ps`؟ ps مقيَّد/غائب في بعض البيئات؛ /proc متاح دائماً على
# Linux. نقرأ PPid من /proc/<pid>/status وcmdline من /proc/<pid>/cmdline، ونطابق
# اسم المزوّد على basename(argv[0]) بدقّة (أو مفسّر node/bun/python + سكربت باسم
# المزوّد) لتفادي المطابقات الكاذبة: grep يحمل الاسم = argv[0]=grep (لا يُطابق)،
# ومحرِّر يفتح ملف codex-*.js = argv[0]=vim (لا يُطابق).
SERVER_PID=""
if command -v pm2 >/dev/null 2>&1; then
  SERVER_PID="$(pm2 jlist 2>/dev/null | PROC_NAME="$PROC_NAME" node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      let arr;try{arr=JSON.parse(s)}catch(_){return}
      const p=(arr||[]).find(x=>x&&x.name===process.env.PROC_NAME);
      if(p&&p.pm2_env&&p.pm2_env.status==="online"&&Number.isInteger(p.pid)&&p.pid>0)
        process.stdout.write(String(p.pid));
    })' 2>/dev/null || true)"
fi

# يُنتج JSON: {sessionCount, serverPid|null, sessions:[{pid,provider,ageS,sessionId,cmd}], reason?}.
# node يُنهي دائماً برمز 0 ويطبع JSON صالحاً (try/catch) كي لا يكسر set -e.
SESSION_JSON="$(
  SERVER_PID="${SERVER_PID}" node - <<'NODE'
const fs = require('fs');
function out(o){ process.stdout.write(JSON.stringify(o)); }
try {
  const serverPid = parseInt(process.env.SERVER_PID || '', 10);
  if (!Number.isInteger(serverPid) || serverPid <= 0) {
    out({ sessionCount: 0, serverPid: null, sessions: [], reason: 'server_pid_unresolved' });
    process.exit(0);
  }
  // زمن الإقلاع + CLK_TCK لحساب العمر من /proc/<pid>/stat (الحقل 22 starttime).
  let btime = 0;
  try { const st = fs.readFileSync('/proc/stat', 'utf8'); const m = st.match(/^btime\s+(\d+)/m); if (m) btime = parseInt(m[1], 10); } catch (_) {}
  const CLK = 100; // sysconf(_SC_CLK_TCK)=100 على Linux (فرضية موثّقة؛ لو خطأ فالعمر تقريبي فقط، لا يؤثّر في قرار الرصد)
  const now = Math.floor(Date.now() / 1000);

  const base = (p) => { const s = String(p); const i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; };
  function readPPid(pid){ try { const t = fs.readFileSync('/proc/' + pid + '/status', 'utf8'); const m = t.match(/^PPid:\s+(\d+)/m); return m ? parseInt(m[1], 10) : null; } catch (_) { return null; } }
  function readCmdline(pid){
    try {
      const b = fs.readFileSync('/proc/' + pid + '/cmdline');
      if (!b.length) return []; // خيط نواة/بلا argv
      const parts = b.toString('utf8').split('\0');
      if (parts.length && parts[parts.length - 1] === '') parts.pop(); // إسقاط null الذيلي
      return parts;
    } catch (_) { return null; }
  }
  function readAgeS(pid){
    try {
      const t = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      const r = t.lastIndexOf(')');            // comm قد يحوي أقواس/مسافات؛ الحقول تبدأ بعد آخر ')'
      const rest = t.slice(r + 2).trim().split(/\s+/);
      const start = parseInt(rest[19], 10);    // starttime = الحقل 22 = الفهرس 19 بعد ')'
      if (!Number.isFinite(start) || !btime) return null;
      return Math.max(0, Math.floor(now - (btime + start / CLK)));
    } catch (_) { return null; }
  }

  // خريطة الأبناء من كامل جدول العمليات (لا نعتمد على ps).
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(Number); } catch (_) {}
  const childrenOf = new Map();
  for (const pid of pids) {
    const ppid = readPPid(pid);
    if (ppid == null) continue;
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(pid);
  }

  // BFS: كل أحفاد عملية الخادم (أبناء مباشرون + أحفاد).
  const seen = new Set();
  const queue = [...(childrenOf.get(serverPid) || [])];
  const descendants = [];
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    descendants.push(pid);
    for (const c of (childrenOf.get(pid) || [])) if (!seen.has(c)) queue.push(c);
  }

  // مطابقة المزوّد بدقّة على argv[0] (أو مفسّر + سكربت باسم المزوّد، أو مسار حزمة).
  const PROV = new Set(['claude', 'codex', 'agy', 'opencode', 'hermes']);
  const INTERP = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'python3']); // لا bash/sh: المزوّدات لا تُطلَق `bash claude`، وتجنّب مسح سلاسل أوامر الصدفة
  // أعلام node لتشغيل كود سطري (ليست جلسة مزوّد): node -e 'code'. نتفاداها قبل رمز
  // السكربت كي لا نطابق كلمة عابرة في كود -e على أنها مسار حزمة (B-196/B-195).
  const EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print']);
  // أعلام node تأخذ قيمة **منفصلة** (وسيطاً تالياً): node --loader X .../cli.js. لولا
  // تخطّي قيمتها لعوملت القيمة (مثل ts-node/esm) كرمز السكربت الأول فيُرجَع null قبل
  // بلوغ cli.js (B-196/qa). الصيغة المدمجة --loader=X يغطّيها فحص '-' العام (بلا قيمة منفصلة).
  const VALUE_FLAGS = new Set(['-r', '--require', '--loader', '--experimental-loader', '--import', '--conditions', '-C']);
  // علامات حزم المزوّدات كمقاطع مسار (B-196): جلسة قد تُطلَق كـ shim مفسّر
  // `node <path>/@anthropic-ai/claude-code/cli.js` فيصير basename(argv[0])="cli"
  // ∉ PROV ⇒ كان يفوت الكشف (fail-open ⇒ نافذة B-95 على عقدة أسطول تُطلق هكذا).
  // نطابق العلامة كمقطع مسار كامل (محاطة بـ '/' أو الطرف) على **رمز السكربت الأول
  // فقط**، لا على barewords أو أي وسيط لاحق — حفاظاً على استبعاد المحرِّرات (a0∉INTERP)
  // والأوامر العابرة، وتفادياً لإيجابيات كاذبة من وسائط مسارية غير-سكربت.
  const PKG_MARKERS = [
    [/(^|\/)@anthropic-ai\/claude-code(\/|$)/, 'claude'],
    [/(^|\/)claude-code(\/|$)/,               'claude'],
    [/(^|\/)@openai\/codex(\/|$)/,            'codex'],
    [/(^|\/)codex(\/|$)/,                     'codex'],     // codex مجرَّد غير منسوب (qa) — لا يطابق '/opencode/' (مقطع مسار كامل)
    [/(^|\/)opencode(\/|$)/,                  'opencode'],
    [/(^|\/)agy(\/|$)/,                       'agy'],
    [/(^|\/)hermes(\/|$)/,                    'hermes'],
  ];
  function detect(argv){
    if (!argv || !argv.length) return null;
    const a0 = base(argv[0]);
    if (PROV.has(a0)) return a0;               // الحالة الغالبة: claude/codex/agy/opencode/hermes مباشرة
    if (INTERP.has(a0)) {                        // غلاف مفسّر: node .../opencode.js أو bun run opencode.js
      const RUNNER_SUBCMD = new Set(['run', 'exec', 'x']); // bun/deno run <script>
      for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg) continue;
        if (EVAL_FLAGS.has(arg)) return null;   // node -e/-p 'code' → ليست جلسة مزوّد (قبل رمز السكربت)
        if (VALUE_FLAGS.has(arg)) { i++; continue; } // علم يأخذ قيمة منفصلة (node --loader X) → تخطَّ العلم وقيمته معاً كي لا تُعامَل القيمة كرمز السكربت
        if (arg[0] === '-') continue;            // علم node آخر (أو =eval مدمج) → تخطَّ
        const raw = base(arg);
        if (RUNNER_SUBCMD.has(raw)) continue;    // تخطّي كلمة الأمر الفرعي قبل السكربت
        // **رمز السكربت الأول فقط** ثم نتوقّف: نتفادى مطابقة كلمة عابرة مثل
        // `node script.js opencode` (وسيط موضعي "opencode" ليس هوية المزوّد).
        // (1) basename المزوّد مباشرةً (سلوك سابق): node .../opencode.js → opencode.
        const b = raw.replace(/\.(c|m)?js$/, '');
        if (PROV.has(b)) return b;
        // (2) shim: basename ليس اسم مزوّد لكن **مسار** رمز السكربت داخل حزمة معروفة
        //     (B-196): node .../@anthropic-ai/claude-code/cli.js → claude. المطابقة
        //     على المسار الكامل لهذا الوسيط وحده (لا الوسائط اللاحقة) كي لا نلتقط ضوضاء.
        for (const [re, prov] of PKG_MARKERS) { if (re.test(arg)) return prov; }
        return null;
      }
    }
    return null;
  }

  // B-270: معرّف المحادثة من argv، ليعرض الطالبُ عناوينها بدل «claude · 14m».
  // الاستخراج هنا لأن هذا الماسح وحده يملك argv الكامل لكل سليل؛ ترجمة المعرّف
  // إلى عنوان تبقى في الخادم (لا قاعدة بيانات في هذا السكربت: يجب أن يعمل
  // مستقلاً وبأقل امتياز).
  // أعلام الاستئناف لدى المزوّدات: claude ‏--resume/-r، وagy ‏--conversation،
  // وصيغتا «العلم ثم القيمة» و«العلم=القيمة»، وأمر فرعي `resume <id>` (codex).
  const RESUME_FLAGS = new Set(['--resume', '-r', '--conversation', '--session', '--session-id']);
  // معرّف معقول: UUID أو رمز طويل بأحرف آمنة. الشرط يمنع التقاط قيمة علم أخرى
  // (مثل مسار أو نموذج) لو تغيّرت صيغة سطر الأوامر لاحقاً.
  const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,}$/;
  function detectSessionId(argv){
    if (!argv || !argv.length) return null;
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i];
      if (!arg) continue;
      const eq = arg.indexOf('=');
      if (eq > 0 && RESUME_FLAGS.has(arg.slice(0, eq))) {
        const v = arg.slice(eq + 1);
        if (ID_RE.test(v)) return v;
        continue;
      }
      if (RESUME_FLAGS.has(arg) || arg === 'resume') {
        const v = argv[i + 1];
        if (v && ID_RE.test(v)) return v;
        continue;
      }
    }
    return null;
  }

  const sessions = [];
  for (const pid of descendants) {
    const argv = readCmdline(pid);
    const prov = detect(argv);
    if (!prov) continue;
    const cmd = (argv || []).join(' ').replace(/\s+/g, ' ');
    sessions.push({
      pid,
      provider: prov,
      ageS: readAgeS(pid),
      sessionId: detectSessionId(argv),
      cmd: cmd.slice(0, 200),
    });
  }
  sessions.sort((a, b) => a.pid - b.pid);
  out({ sessionCount: sessions.length, serverPid, sessions });
} catch (e) {
  // B-195 (fail-closed): علامة صريحة تميّز «خطأ كشف داخلي» (مثل فشل قراءة /proc
  // بعد استنباط PID صالح) عن «صفر جلسات حقيقي». المستهلك في bash يُعامل
  // detectError=true كتأجيل (exit 6) إن كانت العملية online، بدل المرور الصامت.
  // ملاحظة: server_pid_unresolved (أعلاه) ليس detectError — fail-open موثّق آمن هناك
  // (بلا PID خادم لا restart-بالاسم أصلاً، وحارس precondition يُرجِع 4 إن لم تكن online).
  out({ sessionCount: 0, serverPid: null, sessions: [], detectError: true, reason: 'detect_error: ' + (e && e.message ? String(e.message) : String(e)) });
}
NODE
)"
SESSION_COUNT="$(printf '%s' "$SESSION_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).sessionCount))}catch(_){process.stdout.write("0")}})')"
[ -z "$SESSION_COUNT" ] && SESSION_COUNT=0
# B-195 (fail-closed): ميّز «خطأ الكشف» عن «صفر جلسات حقيقي». مصدرا الخطأ:
#   (1) كتلة catch في node أعلاه أخرجت detectError:true (خطأ داخلي بعد استنباط PID
#       صالح)، أو (2) خرج node تالف لا يُحلَّل هنا أصلاً (catch المحلّل bash ⇒ "1").
# في الحالتين لا نثق بـ sessionCount=0. القرار النهائي (SESSION_DETECT_BLOCK لاحقاً)
# يُشرَط بأن العملية online (يؤكّده حارس precondition) فيؤجّل (exit 6) بدل المرور
# الصامت؛ وبلا PID خادم (pm2 غائب/غير online) لا يُعَدّ خطأ كشف (reason=
# server_pid_unresolved بلا detectError) فلا حجب زائف. الافتراضي عند الفراغ = 1.
SESSION_DETECT_ERROR="$(printf '%s' "$SESSION_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);process.stdout.write(o&&o.detectError===true?"1":"0")}catch(_){process.stdout.write("1")}})')"
[ -z "$SESSION_DETECT_ERROR" ] && SESSION_DETECT_ERROR=1
SESSION_DETECT_REASON="$(printf '%s' "$SESSION_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);process.stdout.write(String((o&&o.reason)||""))}catch(_){process.stdout.write("session_json_unparseable")}})')"
if [ -z "$SERVER_PID" ]; then
  emit WARN "تعذّر استنباط PID الخادم من pm2 — كشف جلسات المحادثة الحيّة معطّل هذه المرة (لا يمكن مسح شجرة /proc بلا PID). سيعتمد القرار على الورشات فقط."
fi

# --json (B-198): نُقل إصداره إلى ما بعد حسم القرار النهائي (بعد حارس online وكتلة
# fail-closed B-195 وحساب SESSION_DETECT_BLOCK) كي لا تسبق التلمتريةُ القرارَ في مسار
# الحافة online+SERVER_PID-غير-محلول. انظر كتلة الإصدار أسفل، قُبيل قرار التأجيل.

# رؤية قراءة-فقط للمهام الخلفية الحيّة (wf-*.service) — B-103/T-823. محروسة بالعلم
# (OFF ⇒ لا سطر)، إعلامية بحتة: لا تغيّر رمز الخروج ولا قرار الدرين/الإيقاف.
show_live_wf_units

# السطر الجاهز للّصق.
# B-110/2 (حادثة الصفحة البيضاء): نستهدف العملية بالاسم ($PROC_NAME) لا ملف
# ecosystem، ونُسقط --update-env. السبب: تمرير الملف مع --exec يُعيد PM2 تطبيق
# كامل كتلة env (CORS/WEBAUTHN/JWT/...) من ملف قد يكون منجرفاً عن المضيف أو
# معطوباً، وقد يطرد الجلسات. الاستهداف بالاسم يُعيد تشغيل البرنامج فقط بـ pm2_env
# المحفوظة الحالية دون لمس البيئة.
#
# شرط السلامة (يدقّقه qa-critic/architect): kill_timeout=86400000 وtreekill:false
# (B-23/B-95) يجب أن تكونا أصلاً في pm2_env المحفوظة. هما كذلك ما دامت حالة PM2
# بُنيت مرّة من ecosystem سليم ثم pm2 save (دورة الإقلاع المعتادة). الاستهداف
# بالاسم لا يُسقطهما — يبقيهما كما هما؛ إنما لا «يُصلح» انجرافاً سابقاً في الحالة
# المحفوظة. إعادة بناء الحالة من ecosystem سليم (delete+start ثم save) إجراء
# منفصل، يُنفَّذ يدوياً عند الحاجة (راجع أوامر host-side في المخرَج)، لا من هنا.
#
# ── حارس precondition (B-110) ────────────────────────────────────────────────
# restart-بالاسم بلا معنى إن لم تكن العملية مُسجَّلة في PM2 أصلاً (لا توجد
# pm2_env محفوظة لإعادة استخدامها). نتحقّق قبل بناء/طباعة RESTART_CMD:
#   • العملية غير موجودة → ERROR + exit 4 (ابدأها من ملف عقدتها أولاً).
#   • موجودة لكن حالتها ليست online (launching/stopping/errored/stopped) → ERROR +
#     exit 4 (B-168/T-880): كشف الجلسات الحيّة يشترط online، فأي قرار restart في
#     حالة أخرى أعمى ويخاطر بنافذة B-95.
#   • موجودة لكن treekill≠false أو kill_timeout<24h في الحالة الحيّة → تحذير
#     (انجراف B-23/B-95): restart-بالاسم لن يُصلحه؛ أعد بناء الحالة من ملف العقدة.
# B-115: رسائل الاسترداد تشير إلى ملف العقدة ($ECOSYSTEM = ecosystem.<node>.config.cjs)
# لا إلى ecosystem.config.cjs (لم يعد متعقَّباً قابلاً للتشغيل). استبدل <node> باسم
# عقدتك (مثل ecosystem.nassaj.config.cjs) أو مرّر ECOSYSTEM=... للسكربت.
# pm2 describe/jlist قراءة فقط (لا يحجبها حارس عميل Claude، بخلاف pm2 restart).
# B-195: عَلَم «online مؤكَّد» — يُرفع فقط داخل هذا الحارس بعد إثبات الحالة online.
# يُشرَط عليه حجب fail-closed عند خطأ الكشف (SESSION_DETECT_BLOCK أدناه): لا نحجب
# إلا حين نتأكّد أن العملية online (حيث كشف الجلسات ذو معنى)؛ إن كان pm2 غائباً
# (الحارس مُتخطّى) يبقى 0 فلا حجب زائف — إذ لا restart-بالاسم ممكن أصلاً بلا pm2.
PROC_ONLINE_CONFIRMED=0
if command -v pm2 >/dev/null 2>&1; then
  if ! pm2 describe "$PROC_NAME" --silent >/dev/null 2>&1; then
    emit ERROR "العملية $PROC_NAME غير موجودة في PM2 — لا restart بالاسم؛ ابدأها من ملف عقدتها أولاً."
    emit INFO  "ابدأ نظيفاً: cd $REPO_DIR && env -u PORT pm2 start $ECOSYSTEM && pm2 save"
    [ "$JSON" -eq 1 ] && printf '{"ok":false,"error":"proc_not_in_pm2","proc":%s}\n' "\"$PROC_NAME\""
    exit 4
  fi
  # اشتراط online (فيتو qa-critic — B-168/T-880): pm2 describe ينجح لأي حالة مُسجَّلة
  # (launching/stopping/errored/stopped)، لكن استنباط SERVER_PID أعلاه يشترط online.
  # ففي حالة غير-online مع جلسة حفيدة حيّة يسقط كشف الجلسات fail-open (count=0) بينما
  # قد يمرّ restart ⇒ نافذة B-95 بعينها (العملية stopping بجلسة ابنة حيّة → 502 ممتد).
  # الحسم: لا يُتَّخذ أي قرار restart ما لم تكن online (الحالة الوحيدة التي يرى فيها
  # كشف الجلسات). نُبقي رمز 4 (transient/بيئي → المستهلك HTTP يُعيد للـpending فيَنجح
  # retry بعد الاستقرار) ونسمّي الحالة الفعلية في الرسالة.
  # حاسم: PROC_NAME على جانب node لا pm2 (في `A=v cmd | node` الإسناد يخصّ cmd؛ راجع
  # ملاحظة _pm2_saved_env أدناه) — وإلا رأى node القيمة undefined فطابق الاسم dundefined
  # → status فارغة → رفض online كاذب.
  PROC_STATUS="$(
    pm2 jlist 2>/dev/null | PROC_NAME="$PROC_NAME" node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        let arr;try{arr=JSON.parse(s)}catch(_){process.stdout.write("");return}
        const p=(arr||[]).find(x=>x&&x.name===process.env.PROC_NAME);
        process.stdout.write(String((p&&p.pm2_env&&p.pm2_env.status)||""));
      })' 2>/dev/null || true
  )"
  if [ "$PROC_STATUS" != "online" ]; then
    emit ERROR "العملية $PROC_NAME مُسجَّلة في PM2 لكن حالتها '${PROC_STATUS:-غير معروفة}' لا 'online' — يُرفض أي قرار restart: كشف الجلسات الحيّة أعمى في هذه الحالة (يشترط online)، والمضيّ يخاطر بنافذة B-95 (drain بجلسة ابنة حيّة ⇒ 502 ممتد)."
    emit INFO  "انتظر استقرار العملية على online، أو أعد بناءها: cd $REPO_DIR && env -u PORT pm2 delete $PROC_NAME && env -u PORT pm2 start $ECOSYSTEM && pm2 save"
    [ "$JSON" -eq 1 ] && printf '{"ok":false,"error":"proc_not_online","proc":%s,"status":%s}\n' "\"$PROC_NAME\"" "\"${PROC_STATUS}\""
    exit 4
  fi
  # وصلنا هنا ⇒ الحالة online مؤكَّدة (وإلا خرجنا بـ4). ارفع العَلَم لتفعيل حجب
  # fail-closed عند خطأ كشف الجلسات (B-195): online = الحالة الوحيدة التي يرى فيها
  # الكشف الجلسات، فخطأ الكشف حينها يعني تعذّر تأكيد السلامة ⇒ نؤجّل لا نمرّ.
  PROC_ONLINE_CONFIRMED=1
  # فحص انجراف الحالة الحيّة (تحذيري فقط — لا يقطع). نقرأ pm2_env عبر jlist.
  # B-194: PROC_NAME على جانب node لا pm2 — في `A=v cmd | node` الإسناد يخصّ cmd
  # (pm2) لا node، فكان node يرى PROC_NAME=undefined ⇒ لا مطابقة ⇒ التحذير كود ميّت
  # لا يُطلق أبداً. طابقنا أسلوب b5248470 (حارس online أعلاه) للاتساق.
  DRIFT="$(
    pm2 jlist 2>/dev/null | PROC_NAME="$PROC_NAME" node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        const want=process.env.PROC_NAME;
        let arr;try{arr=JSON.parse(s)}catch(_){process.exit(0)}
        const p=(arr||[]).find(x=>x && x.name===want);
        if(!p){process.exit(0)}
        const e=p.pm2_env||{};
        // treekill الافتراضي في PM2 = true؛ نعتبره منجرفاً ما لم يكن false صراحةً.
        const tk=e.treekill;
        const kt=Number(e.kill_timeout);
        const probs=[];
        if(tk!==false) probs.push("treekill="+JSON.stringify(tk)+" (المطلوب false — B-23/ADR-021)");
        if(!(kt>=86400000)) probs.push("kill_timeout="+JSON.stringify(e.kill_timeout)+" (المطلوب ≥86400000 — B-95)");
        if(probs.length) process.stdout.write(probs.join(" | "));
      })' 2>/dev/null
  )"
  if [ -n "$DRIFT" ]; then
    emit WARN "انجراف في حالة PM2 المحفوظة للعملية $PROC_NAME: $DRIFT"
    emit WARN "restart-بالاسم لن يُصلح هذا الانجراف. أعد بناء الحالة من ملف عقدة سليم:"
    emit WARN "  cd $REPO_DIR && env -u PORT pm2 delete $PROC_NAME && env -u PORT pm2 start $ECOSYSTEM && pm2 save"
  fi
else
  emit INFO "pm2 غير متوفّر — تخطّي حارس precondition (تعذّر التحقّق من تسجيل العملية)."
fi

RESTART_CMD="cd $REPO_DIR && env -u PORT pm2 restart $PROC_NAME && pm2 save"

# ── حَقن env المُصرَّح به (allowlist) — B-117 ────────────────────────────────────
# لماذا يختلف هذا عن انجراف B-110 (الذي سبّب انقطاعي 502)؟
#
#   B-110 كان: `pm2 restart ecosystem.config.cjs --update-env` — يُعيد PM2 قراءة
#   كامل ملف ecosystem (قد يكون منجرفاً/معطوباً) ويطبّق كل كتلة env منه، أو
#   `--update-env` من شيلٍّ منجرف (cwd خاطئ، PORT مصدَّر، JWT_SECRET مفقود) فيلتقط
#   `Object.assign({}, process.env)` كل بيئة الشيل الملوّثة ويكتبها في العملية.
#
#   هنا: لا ملف ecosystem إطلاقاً، ولا بيئة الشيل الحالية. نبني بيئة **مُعاد
#   تركيبها من الصفر (`env -i`)** تحتوي حصراً: (1) قيم أساسية لا غنى عنها لـ PM2
#   (HOME/PATH/PM2_HOME من مصادر موثوقة)، و(2) المفاتيح المُصرَّح بها عبر --set فقط.
#   ثم `--update-env` (وهو تقنياً الوسيلة الوحيدة لأي حَقن على restart-بالاسم — راجع
#   pm2 API.js: `restart(name,{env})` يرفض inline env بلا ecosystem، و`_operate`
#   يطبّق env فقط حين updateEnv=true). دمج God جانبَ الخادم إضافيٌّ لا استبدالي
#   (Utility.extend في ActionMethods.js): المفاتيح غير المُمرَّرة **تبقى** من
#   pm2_env المحفوظة كما هي — لذا JWT_SECRET/ALLOWED_ORIGINS/PORT الحاليّة تُصان
#   تلقائياً ما دمنا لا نمرّرها (وهي محظورة في --set أصلاً).
#
#   حارس fail-closed: نلتقط قيم SENSITIVE_KEYS **قبل** التنفيذ من pm2 jlist، ننفّذ،
#   ثم نتحقّق **بعده** أنها لم تتغيّر (absent يبقى absent، وقيمة تبقى كما هي)
#   وأن مفاتيح --set صارت حاضرة بقيمها المطلوبة. أي انجراف في مفتاح حسّاس → خطأ صاخب
#   (exit 5) لا ثقة عمياء.

# السنتينل الدالّ على «المفتاح غير موجود» (نميّزه عن السلسلة الفارغة). لا نستعمل
# بايت null لأن bash يسقطه في $(...) (يحوّل \x00ABSENT\x00 إلى ABSENT فيكسر المقارنة
# ويلوّث stderr بتحذيرات) — نعتمد سلسلة خالية من null غير قابلة للتصادم مع قيمة env
# صالحة (تحوي مسافة، وقيم env تُمرَّر ككلمة واحدة عبر --set فلا تحوي مسافات هكذا).
_ABSENT_SENTINEL='<<safe-restart:ABSENT>>'

# يقرأ قيمة env محفوظة لمفتاح من عملية PM2 عبر jlist. يطبع القيمة، أو $_ABSENT_SENTINEL
# إن كان المفتاح غير موجود.
# ملاحظة حاسمة: في خط الأنابيب `A=v cmd | node`، إسنادات البيئة تخصّ cmd (pm2) لا
# node — لذا نضع PROC_NAME/KEY/ABSENT على جانب node مباشرةً (وإلا رآها node undefined
# فطابق x.name===undefined → لا عملية → ABSENT دائماً حتى للمفاتيح الموجودة).
_pm2_saved_env() {
  local key="$1"
  pm2 jlist 2>/dev/null | PROC_NAME="$PROC_NAME" KEY="$key" ABSENT="$_ABSENT_SENTINEL" node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const ABSENT=process.env.ABSENT;
      let arr;try{arr=JSON.parse(s)}catch(_){process.stdout.write(ABSENT);return}
      const p=(arr||[]).find(x=>x&&x.name===process.env.PROC_NAME);
      const e=(p&&p.pm2_env&&p.pm2_env.env)||{};
      const k=process.env.KEY;
      if(!Object.prototype.hasOwnProperty.call(e,k)) process.stdout.write(ABSENT);
      else process.stdout.write(String(e[k]));
    })'
}

# يبني وينفّذ restart مع حَقن env المُصرَّح به (يُستدعى فقط حين ${#SET_KEYS[@]}>0).
# fail-closed: يُرجِع رمز خروج غير صفري إن انجرف مفتاح حسّاس أو لم يُطبَّق --set.
_exec_restart_with_injection() {
  # 1) لقطة ما-قبل للمفاتيح الحسّاسة + المحمية (المرجع لكشف الانجراف).
  #    الحسّاسة: يجب ألا تُحقَن ولا تتغيّر. المحمية (HOME/PATH/PM2_HOME): تُحقَن قسراً
  #    لتشغيل PM2 لكن قيمتها الحيّة يجب ألا تتغيّر — أي انجراف (مثل PATH مسرَّب من شِل
  #    Claude، أو PM2_HOME absent→present) يُكتشَف هنا ويُرفَض (exit 5).
  local -a _pre_sens=()
  local -a _pre_prot=()
  local k
  for k in "${SENSITIVE_KEYS[@]}"; do
    _pre_sens+=("$(_pm2_saved_env "$k")")
  done
  for k in "${PROTECTED_KEYS[@]}"; do
    _pre_prot+=("$(_pm2_saved_env "$k")")
  done

  # 2) ابنِ وسائط env -i: أساسيات PM2 (HOME/PATH[/PM2_HOME]) + مفاتيح --set حصراً.
  #    لا شيء من الشيل الحالي عدا هذه الأساسيات.
  #
  #    ⚠️ لماذا لا نأخذ PATH/PM2_HOME من الشِل (كشف qa-critic، مُثبَت ميدانياً على
  #    pm2 7.0.1 يوم 2026-07-02)؟ لأن `pm2 restart --update-env` يدمج
  #    `Object.assign({}, process.env)` **إضافياً** فوق pm2_env.env المحفوظة
  #    (API.js:1367 + God/ActionMethods.js:405). فأي قيمة نحقنها هنا تُكتب فعلاً في
  #    بيئة العملية الحيّة. وشِل جلسة Claude يحوي PATH ملوَّثاً بمسارات
  #    ~/.claude/plugins/cache/... (541 محرف مقابل 145 نظيفة محفوظة)، وPM2_HOME
  #    مصدَّراً (~/.pm2 للمستخدم) بينما اللقطة الحيّة absent. حقن هذين الخامين
  #    يُنتج انجرافاً حقيقياً في PROTECTED_KEYS (PATH نظيف→ملوّث، PM2_HOME
  #    absent→present) يُكتشف **بعد** فوات الأوان (بعد restart+save، سطر 476/481) →
  #    exit 5 على عملية أُعيد تشغيلها بالفعل بحالة ملوّثة. غير قابل للتراجع.
  #
  #    الحلّ: اشتقّ PATH من **اللقطة الحيّة المحفوظة** (`_pm2_saved_env PATH`) لا من
  #    $PATH الخام — فتُطابق القيمة المحقونة ما هو محفوظ حرفياً ولا تُنشئ انجرافاً.
  #    (fallback نظيف لو تعذّرت اللقطة: PATH نظامي أدنى كافٍ لتشغيل pm2 CLI — لا
  #    نستعمل $PATH الملوّث إطلاقاً.) وحقن PM2_HOME **شرطي**: فقط إن كان حاضراً في
  #    اللقطة الحيّة (غير ABSENT)؛ وإلا نُسقطه تماماً — لا نحقن قيمة لم تكن موجودة.
  #    فحص PROTECTED_KEYS قبل/بعد يبقى شبكة أمان أخيرة (exit 5) لأي انجراف متبقٍّ.
  local _saved_path; _saved_path="$(_pm2_saved_env PATH)"
  if [ "$_saved_path" = "$_ABSENT_SENTINEL" ] || [ -z "$_saved_path" ]; then
    # اللقطة لا تحوي PATH صالحاً (نادر): استعمل PATH نظامي أدنى نظيفاً كافياً لـ pm2
    # CLI — لا $PATH الخام (قد يكون ملوّثاً بمسارات plugins من شِل Claude).
    _saved_path="/usr/local/bin:/usr/bin:/bin"
    emit WARN "تعذّر اشتقاق PATH من اللقطة الحيّة — استعمال PATH نظامي أدنى نظيف: $_saved_path"
  fi
  local -a _env_args=(
    "HOME=${HOME}"
    "PATH=${_saved_path}"
  )
  # PM2_HOME: حقن شرطي — فقط إن كان حاضراً فعلاً في اللقطة الحيّة (غير ABSENT).
  # حقنه غير المشروط (absent→present) كان أحد وجهي الانجراف في فيتو qa-critic.
  local _saved_pm2home; _saved_pm2home="$(_pm2_saved_env PM2_HOME)"
  if [ "$_saved_pm2home" != "$_ABSENT_SENTINEL" ]; then
    _env_args+=("PM2_HOME=${_saved_pm2home}")
  fi
  local i
  for i in "${!SET_KEYS[@]}"; do
    # دفاع في العمق: تجاهُل أي --set لمفتاح محمي (يُبنى من مصدره أعلاه؛ لا يُزاح
    # بقيمة المستخدم). حتى لو مرّ في التحليل، PROTECTED_KEYS يكشف أي انجراف لاحقاً.
    if _is_protected "${SET_KEYS[$i]}"; then
      emit WARN "تجاهُل --set ${SET_KEYS[$i]} — مفتاح بنية تحتية محمي، لا يُحقَن من المستخدم."
      continue
    fi
    _env_args+=("${SET_KEYS[$i]}=${SET_VALS[$i]}")
  done

  emit INFO "حَقن env مُصرَّح به: ${SET_KEYS[*]} (عبر env -i + --update-env، الشيل الحالي معزول)."

  # 3) نفّذ: cwd = REPO_DIR، بيئة معاد تركيبها، restart بالاسم + --update-env، ثم save.
  #    نبقي env -u PORT حارساً إضافياً ضد أي PORT متسرّب (رغم أن env -i يُسقطه أصلاً).
  if ! ( cd "$REPO_DIR" && env -i "${_env_args[@]}" env -u PORT pm2 restart "$PROC_NAME" --update-env ); then
    emit ERROR "فشل pm2 restart أثناء الحَقن. لم يُحفَظ. تحقّق يدوياً من حالة $PROC_NAME."
    return 5
  fi
  # save في بيئة نظيفة أيضاً (لا يكتب env، لكن نُبقي الاتساق).
  ( env -u PORT pm2 save >/dev/null 2>&1 ) || emit WARN "pm2 save فشل (غير قاطع) — الحالة الحيّة مطبَّقة لكن قد لا تُستعاد بعد reboot."

  # امهل العملية لتُعاد كتابة env المحفوظة قبل التحقّق.
  local _waited=0
  while [ "$_waited" -lt 5 ]; do
    sleep 1
    _waited=$((_waited+1))
    [ "$(_pm2_saved_env "${SET_KEYS[0]}")" = "${SET_VALS[0]}" ] && break
  done

  # 4) تحقّق ما-بعد (fail-closed):
  local _fail=0
  #   (أ) كل مفتاح حسّاس لم يتغيّر عن لقطته.
  for i in "${!SENSITIVE_KEYS[@]}"; do
    local _now; _now="$(_pm2_saved_env "${SENSITIVE_KEYS[$i]}")"
    if [ "$_now" != "${_pre_sens[$i]}" ]; then
      local _b="${_pre_sens[$i]}"; local _a="$_now"
      [ "$_b" = "$_ABSENT_SENTINEL" ] && _b="(absent)"
      [ "$_a" = "$_ABSENT_SENTINEL" ] && _a="(absent)"
      emit ERROR "انجراف مفتاح حسّاس ${SENSITIVE_KEYS[$i]}: قبل=$_b بعد=$_a — إجراء خطر! أعد بناء الحالة من ملف العقدة."
      _fail=1
    fi
  done
  #   (أ-2) كل مفتاح محمي (HOME/PATH/PM2_HOME) لم يتغيّر عن لقطته. هذا يكشف تسريب
  #        PATH من شِل جلسة Claude أو إضافة PM2_HOME (absent→present).
  for i in "${!PROTECTED_KEYS[@]}"; do
    local _pnow; _pnow="$(_pm2_saved_env "${PROTECTED_KEYS[$i]}")"
    if [ "$_pnow" != "${_pre_prot[$i]}" ]; then
      local _pb="${_pre_prot[$i]}"; local _pa="$_pnow"
      [ "$_pb" = "$_ABSENT_SENTINEL" ] && _pb="(absent)"
      [ "$_pa" = "$_ABSENT_SENTINEL" ] && _pa="(absent)"
      emit ERROR "انجراف مفتاح بنية تحتية محمي ${PROTECTED_KEYS[$i]}: قبل=$_pb بعد=$_pa — الحقن أزاح البيئة الحيّة! أعد بناء الحالة من ملف العقدة."
      _fail=1
    fi
  done
  #   (ب) كل مفتاح --set صار حاضراً بقيمته (نتجاهل المفاتيح المحمية: لا تُحقَن عمداً).
  for i in "${!SET_KEYS[@]}"; do
    if _is_protected "${SET_KEYS[$i]}"; then continue; fi
    local _got; _got="$(_pm2_saved_env "${SET_KEYS[$i]}")"
    if [ "$_got" != "${SET_VALS[$i]}" ]; then
      emit ERROR "لم يُطبَّق --set ${SET_KEYS[$i]}=${SET_VALS[$i]} (القيمة الآن: ${_got/"$_ABSENT_SENTINEL"/(absent)})."
      _fail=1
    else
      emit INFO "تحقّق: ${SET_KEYS[$i]}=${SET_VALS[$i]} مطبَّق في العملية الحيّة."
    fi
  done

  if [ "$_fail" -eq 1 ]; then
    emit ERROR "الحَقن اكتمل تقنياً لكن التحقّق فشل. راجع أعلاه فوراً."
    return 5
  fi
  emit INFO "الحَقن نجح والمفاتيح الحسّاسة صينت (لا انجراف)."
  return 0
}

# run_restart: نقطة تنفيذ موحّدة. بلا --set → السلوك الافتراضي (RESTART_CMD) حرفياً
# كما كان. مع --set → مسار الحَقن الآمن أعلاه. تُرجِع رمز خروج المسار المختار.
run_restart() {
  if [ "${#SET_KEYS[@]}" -gt 0 ]; then
    _exec_restart_with_injection
    return $?
  fi
  bash -c "$RESTART_CMD"
  return $?
}

# ── تسخين كاش Cloudflare بعد النشر (--exec فقط، بعد نجاح run_restart) ───────────
# المشكلة المقيسة: أول طلب للحزمة بعد كل نشر = cf-cache-status: MISS = ~12.4s
# (سحب ~3.9MB خاماً عبر النفق بـ~314 KB/s)؛ الطلب التالي (HIT) = 0.75s. ننقل هذه
# الكلفة من المستخدم إلى لحظة النشر: بعد نجاح restart نطلب الأصول المهشّرة عبر
# النطاق العام فتُخزَّن في حافة Cloudflare مسبقاً (HIT للمستخدم الأول).
#
# لا يغيّر نجاح/فشل النشر أبداً: أي تعذّر (خادم لم يجهز، غياب curl/node/index،
# أصل غير 200) → تخطٍّ صامت ويُعاد رمز خروج run_restart كما هو.
#
# حارس إلزامي (مطابق public/sw.js:52-58): لا يُقبل إلا 200. أي 4xx/5xx (خصوصاً
# 502 من نافذة الدرين) لا يُطلب مجدداً ولا يُعدّ نجاحاً — لأن الأصول تُخدَم بـ
# max-age=31536000, immutable (server/index.js:882) فقد تخزّن Cloudflare الردّ
# الفاسد تحت الرابط عاماً كاملاً. كل أصل يُطلب مرّة واحدة؛ غير-200 → emit WARN.
WARM_PUBLIC_ORIGIN="${WARM_PUBLIC_ORIGIN:-http://localhost:${PORT:-3004}}"
WARM_READY_TIMEOUT_S="${WARM_READY_TIMEOUT_S:-60}"
WARM_READY_INTERVAL_S="${WARM_READY_INTERVAL_S:-2}"

warm_cf_cache() {
  command -v curl >/dev/null 2>&1 || { emit INFO "تسخين الكاش: curl غير متوفّر — تخطٍّ صامت."; return 0; }
  command -v node >/dev/null 2>&1 || { emit INFO "تسخين الكاش: node غير متوفّر — تخطٍّ صامت."; return 0; }

  # 1) انتظر جاهزية الخادم عبر HEALTH_URL (رد 200) حتى المهلة القصوى.
  local waited=0 ready=0 code
  while [ "$waited" -lt "$WARM_READY_TIMEOUT_S" ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
    if [ "$code" = "200" ]; then ready=1; break; fi
    sleep "$WARM_READY_INTERVAL_S"
    waited=$((waited + WARM_READY_INTERVAL_S))
  done
  if [ "$ready" -ne 1 ]; then
    emit INFO "تسخين الكاش: الخادم لم يجهز خلال ${WARM_READY_TIMEOUT_S}s (HEALTH_URL) — تخطٍّ صامت، لا يؤثّر في نتيجة النشر."
    return 0
  fi

  # 2) استخرج مسارات الأصول المهشّرة (/assets/…) من dist/index.html: وسوم
  #    <script src>، <link href> (يشمل modulepreload وstylesheet). node لا regex هشّ.
  local index_html="$REPO_DIR/dist/index.html"
  if [ ! -f "$index_html" ]; then
    emit INFO "تسخين الكاش: dist/index.html غير موجود — تخطٍّ صامت."
    return 0
  fi
  local assets
  assets="$(INDEX_HTML="$index_html" node -e '
    const fs=require("fs");
    let html="";try{html=fs.readFileSync(process.env.INDEX_HTML,"utf8")}catch(_){process.exit(0)}
    const set=new Set();
    const re=/(?:src|href)\s*=\s*["\x27]([^"\x27]+)["\x27]/g;   // \x27 = علامة اقتباس مفردة
    let m;
    while((m=re.exec(html))){ const u=m[1]; if(/^\/assets\//.test(u)) set.add(u); }
    process.stdout.write([...set].join("\n"));
  ' 2>/dev/null || true)"
  if [ -z "$assets" ]; then
    emit INFO "تسخين الكاش: لم يُعثر على أصول /assets/ في index.html — تخطٍّ صامت."
    return 0
  fi

  # 3) اطلب كل أصل مرّة واحدة عبر النطاق العام بترميز المتصفّح. حارس 200 صارم.
  local url full acode n_ok=0 n_bad=0
  while IFS= read -r url; do
    [ -n "$url" ] || continue
    full="${WARM_PUBLIC_ORIGIN}${url}"
    acode="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 \
               -H 'Accept-Encoding: br, gzip' "$full" 2>/dev/null || true)"
    if [ "$acode" = "200" ]; then
      n_ok=$((n_ok + 1))
    else
      n_bad=$((n_bad + 1))
      emit WARN "تسخين الكاش: $url ردّ ${acode:-؟} (ليس 200) — لم يُسخَّن ولن يُعاد طلبه (تفادي تسميم كاش immutable في Cloudflare)."
    fi
  done <<< "$assets"
  emit INFO "تسخين كاش Cloudflare اكتمل: $n_ok أصل سُخِّن (200)، $n_bad تُخطّي."
  return 0
}

# ── قرار التأجيل الموحّد: ورشات حيّة و/أو جلسات محادثة تفاعلية حيّة (B-168/T-880) ─
# فئتان تؤجّلان restart:
#   (LIVE_COUNT)    ورشات حيّة على القرص (سلوك سابق — exit 3).
#   (SESSION_COUNT) جلسات محادثة تفاعلية حيّة أبناء/أحفاد OS لعملية الخادم (جديد —
#                   exit 6). أخطر: بقاؤها أثناء restart يُغلق 3004 ويُدخل drain بلا
#                   موت ⇒ 502 ممتد (B-95). وجود واحدة يكفي للتأجيل كورشة حيّة تماماً.
#   (SESSION_DETECT_BLOCK) خطأ في كشف الجلسات والعملية online (B-195 — exit 6). لا
#                   نعرف إن كانت ثمّة جلسة حيّة ⇒ fail-closed: نؤجّل كأنها موجودة.
# --force --exec يتجاوز الفئات الثلاث معاً مع تحذير صارخ. الرمز عند التأجيل: 6 إن
# وُجدت جلسة أو خطأ كشف (الأخطر)، وإلا 3.
#
# B-195/qa (حالة الحافة #1): online مؤكَّد لكن تعذّر حلّ pid الخادم (SERVER_PID فارغ)
# ⇒ لم يجرِ مشي شجرة /proc أصلاً ⇒ كشف أعمى بينما العملية حيّة = نافذة B-95 بعينها.
# قابلة للبلوغ عبر TOCTOU launching→online بين قراءتي jlist المنفصلتين (SERVER_PID
# مبكّراً ~478، PROC_STATUS في الحارس ~657). fail-closed: عامله كخطأ كشف (يؤجّل exit 6،
# قابل للتجاوز الواعي بـ--force). التمييز نظيف: pm2 غائب ⇒ PROC_ONLINE_CONFIRMED=0 (لا
# حجب زائف)؛ غير-online ⇒ خرج بـ4 مسبقاً؛ online+pid محلول ⇒ SERVER_PID غير فارغ (لا حجب).
if [ "$PROC_ONLINE_CONFIRMED" -eq 1 ] && [ -z "$SERVER_PID" ]; then
  SESSION_DETECT_ERROR=1
  SESSION_DETECT_REASON="server_pid_unresolved_while_online"
fi
# B-195: احسب حجب fail-closed. يُفعَّل فقط حين أخفق الكشف (SESSION_DETECT_ERROR=1)
# **والعملية online مؤكَّدة** (فالكشف حينها ذو معنى ويُفترض أن يرى أي جلسة حيّة).
SESSION_DETECT_BLOCK=0
if [ "$SESSION_DETECT_ERROR" -eq 1 ] && [ "$PROC_ONLINE_CONFIRMED" -eq 1 ]; then
  SESSION_DETECT_BLOCK=1
fi

# ── إصدار --json بعد حسم القرار النهائي (B-198) ───────────────────────────────
# نُقل إلى هنا من قبل حارس online (~716) وكتلة recompute حالة الحافة (~963): الآن
# PROC_ONLINE_CONFIRMED وSERVER_PID وحالة الكشف (SESSION_DETECT_ERROR/REASON) وقرار
# الحجب (SESSION_DETECT_BLOCK) كلها محسومة، فيعكس الكائنُ القرارَ الفعلي لا حالة
# وسطى. مسارات الخطأ الطرفية (wf_base_missing/scan_parse/proc_not_in_pm2/proc_not_online)
# أصدرت كائنها وخرجت قبل هنا، فلا يُصدَر كائنان متناقضان على stdout في أي مسار.
# sessionDetectError/Reason/Block مصدرها متغيّرات bash النهائية لا حقول SESSION_JSON
# الخام (التي لا تُعاد كتابتها عند recompute حالة الحافة online+pid-غير-محلول).
if [ "$JSON" -eq 1 ]; then
  printf '%s' "$SCAN_JSON" \
    | SESSION_JSON="$SESSION_JSON" \
      SR_DETECT_ERROR="$SESSION_DETECT_ERROR" \
      SR_DETECT_REASON="$SESSION_DETECT_REASON" \
      SR_DETECT_BLOCK="$SESSION_DETECT_BLOCK" \
      node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      let scan;try{scan=JSON.parse(s)}catch(_){scan={ok:false,error:"scan_parse"}}
      let sess;try{sess=JSON.parse(process.env.SESSION_JSON)}catch(_){sess={sessionCount:0,sessions:[],serverPid:null}}
      scan.sessionCount=sess.sessionCount||0;
      scan.liveSessions=sess.sessions||[];
      scan.sessionServerPid=(sess.serverPid==null?null:sess.serverPid);
      scan.sessionDetectError=(process.env.SR_DETECT_ERROR==="1");            // B-195/B-198: القيمة النهائية بعد recompute
      scan.sessionDetectReason=(process.env.SR_DETECT_REASON||null);          // B-195/B-198
      scan.sessionDetectBlock=(process.env.SR_DETECT_BLOCK==="1");            // B-198: قرار الحجب fail-closed النهائي
      process.stdout.write(JSON.stringify(scan)+"\n");
    })'
fi

if [ "$SESSION_COUNT" -gt 0 ] || [ "$LIVE_COUNT" -gt 0 ] || [ "$SESSION_DETECT_BLOCK" -eq 1 ]; then
  # (أ) الورشات الحيّة (رسائل السلوك السابق محفوظة حرفياً).
  if [ "$LIVE_COUNT" -gt 0 ]; then
    emit WARN "عُثر على $LIVE_COUNT workflow حيّ (started>result + نشاط خلال ${FRESH_WINDOW_S}s)."
    if [ "$JSON" -eq 0 ]; then
      printf '%s\n' "$SCAN_JSON" | node -e '
        let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
          try{const o=JSON.parse(s);
            for(const w of o.live){
              process.stderr.write(`  • ${w.wf} (session ${w.session.slice(0,8)}…) — pending=${w.pending}, آخر نشاط قبل ${w.newestAgentAgeS}s\n`);
            }
          }catch(_){}
        })'
    fi
  fi
  # (ب) جلسات المحادثة التفاعلية الحيّة (B-168/T-880). خرج قابل للتحليل آلياً:
  #     سطر ملخّص `SR-SESSION-BLOCK` + سطر لكل جلسة `SR-SESSION` (يستهلكهما B-193).
  if [ "$SESSION_COUNT" -gt 0 ]; then
    emit WARN "عُثر على $SESSION_COUNT جلسة محادثة تفاعلية حيّة — أبناء/أحفاد OS لعملية $PROC_NAME (pid=${SERVER_PID:-?})."
    emit WARN "أثر التجاهل: restart سيُغلق المنفذ 3004 ويُدخل العملية طور drain (treekill:false، kill_timeout 24h) بلا موت ما دامت جلسة ابنة حيّة ⇒ انقطاع 502 ممتد (تكرار B-95). قد تكون جلستك الحالية إحداها."
    emit WARN "SR-SESSION-BLOCK count=$SESSION_COUNT serverPid=${SERVER_PID:-0} exit=6"
    printf '%s' "$SESSION_JSON" | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{const o=JSON.parse(s);
          for(const x of (o.sessions||[])){
            const snip=String(x.cmd||"").replace(/\s+/g," ").slice(0,80);
            const age=(x.ageS==null?"?":x.ageS+"s");
            const sid=(x.sessionId||"");
            process.stderr.write(`SR-SESSION pid=${x.pid} provider=${x.provider} ageS=${x.ageS==null?"":x.ageS} sessionId=${sid} cmd=${JSON.stringify(snip)}\n`);
            process.stderr.write(`  • جلسة حيّة: pid=${x.pid}  مزوّد=${x.provider}  العمر=${age}${sid?`  محادثة=${sid.slice(0,8)}…`:""}  —  ${snip}\n`);
          }
        }catch(_){}
      })'
  fi
  # (ب-2) خطأ كشف الجلسات مع online — حجب fail-closed (B-195). خرج قابل للتحليل آلياً
  #       بنفس بادئة SR-SESSION-BLOCK ليميّزه مسار HTTP (reason=detect_error، count=0).
  if [ "$SESSION_DETECT_BLOCK" -eq 1 ]; then
    emit WARN "فشل كشف جلسات المحادثة الحيّة داخلياً (detectError) والعملية online — تعذّر تأكيد غياب جلسة ابنة حيّة (السبب: ${SESSION_DETECT_REASON:-غير معروف})."
    emit WARN "أثر التجاهل: قد توجد جلسة ابنة حيّة غير مرئية؛ restart يُغلق المنفذ 3004 ويُدخل العملية طور drain (treekill:false، kill_timeout 24h) بلا موت ⇒ انقطاع 502 ممتد (نافذة B-95). fail-closed: أُعامله كتأجيل لا كصفر آمن."
    emit WARN "SR-SESSION-BLOCK count=0 serverPid=${SERVER_PID:-0} exit=6 reason=detect_error"
  fi
  # (ج) التجاوز الواعي الصارخ (يشمل الفئات الثلاث).
  if [ "$DO_EXEC" -eq 1 ] && [ "$FORCE" -eq 1 ]; then
    if [ "$SESSION_COUNT" -gt 0 ]; then
      emit WARN "تجاوز واعٍ (--force): تنفيذ restart رغم $SESSION_COUNT جلسة محادثة حيّة! خطر إغلاق 3004 ودخول drain ⇒ 502 ممتد إن بقيت جلسة عالقة. تأكّد أنك لست داخل إحداها."
    fi
    if [ "$SESSION_DETECT_BLOCK" -eq 1 ]; then
      emit WARN "تجاوز واعٍ (--force): تنفيذ restart رغم فشل كشف الجلسات (detectError، ${SESSION_DETECT_REASON:-غير معروف}) — قد توجد جلسة ابنة حيّة غير مرئية ⇒ خطر إغلاق 3004 ودخول drain ⇒ 502 ممتد. تأكّد يدوياً أنه لا جلسة claude/codex/agy/opencode/hermes حيّة تحت العملية."
    fi
    if [ "$LIVE_COUNT" -gt 0 ]; then
      emit WARN "تجاوز واعٍ (--force): تنفيذ restart رغم وجود عمل حيّ. orphans ستُكمل (treekill:false) لكن انفصام الرؤية قد يتكرّر."
    fi
    if [ "${#SET_KEYS[@]}" -gt 0 ]; then
      emit INFO "تنفيذ مع حَقن env مُصرَّح به (${SET_KEYS[*]})."
    else
      emit INFO "تنفيذ / running: $RESTART_CMD"
    fi
    run_restart
    _rc=$?
    if [ "$_rc" -eq 0 ]; then warm_cf_cache || true; fi
    exit "$_rc"
  fi
  # (د) التأجيل. OC-08: سمِّ جلسات المزوّدات الحيّة (opencode وغيره) في رسالة التأجيل.
  show_live_provider_sessions
  emit WARN "أُجّل restart. للتجاوز الواعي: --force --exec. أو أعد المحاولة بعد انتهاء العمل/الجلسات بـ:"
  emit INFO "bash scripts/safe-restart.sh --exec"
  emit WARN "⛔ لا تُشغِّل pm2 restart الخام مطلقاً كبديل يدوي: تصميم الدرين (treekill:false + kill_timeout 24h) يُغلق المنفذ 3004 ويُبقي العملية في طور drain بلا موت ما دامت جلسة ابنة حيّة ⇒ انقطاع 502 ممتد (B-95). أعد المحاولة عبر هذا السكربت وحده."
  # جلسات المحادثة الحيّة أو خطأ كشفها fail-closed (B-195): رمز مخصّص (6) لتمييزها
  # آلياً عن الورشات (3) في مسار HTTP (B-193/T-950).
  if [ "$SESSION_COUNT" -gt 0 ] || [ "$SESSION_DETECT_BLOCK" -eq 1 ]; then
    exit 6
  fi
  exit 3
fi

# لا عمل حيّ ولا جلسة محادثة حيّة → آمن.
emit INFO "آمن: لا workflow حيّ ولا جلسة محادثة تفاعلية حيّة (فُحص ${SCAN_JSON:+$(printf '%s' "$SCAN_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).scanned))}catch(_){process.stdout.write("?")}})')} workflow؛ جلسات=${SESSION_COUNT})."
if [ "$DO_EXEC" -eq 1 ]; then
  if [ "${#SET_KEYS[@]}" -gt 0 ]; then
    emit INFO "تنفيذ مع حَقن env مُصرَّح به (${SET_KEYS[*]})."
  else
    emit INFO "تنفيذ / running: $RESTART_CMD"
  fi
  run_restart
  _rc=$?
  if [ "$_rc" -eq 0 ]; then warm_cf_cache || true; fi
  exit "$_rc"
else
  if [ "${#SET_KEYS[@]}" -gt 0 ]; then
    emit INFO "وضع الفحص فقط. مع --exec سيُحقَن (عبر env -i + --update-env، الشيل معزول): ${SET_KEYS[*]}"
    emit INFO "المفاتيح الحسّاسة المصانة (لا تُمسّ): ${SENSITIVE_KEYS[*]}"
  else
    emit INFO "وضع الفحص فقط. للتنفيذ: --exec. السطر الجاهز:"
    emit INFO "$RESTART_CMD"
  fi
fi
exit 0
