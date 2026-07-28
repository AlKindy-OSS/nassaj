#!/usr/bin/env bash
# ============================================================================
# memory-guard.sh  (B-130)
# ----------------------------------------------------------------------------
# حارس ذاكرة يحترم الجلسات لعملية PM2 `nassaj-dev` — بديلٌ آمن عن آلية PM2
# الداخلية `max_memory_restart` (التي تُطلق restart أعمى بلا معرفة بالجلسات).
#
# A session-aware RSS guard for the `nassaj-dev` PM2 process. Safe replacement
# for PM2's built-in `max_memory_restart` (which fires a blind restart with no
# knowledge of live sessions).
#
# ── لماذا وُجد / Why (B-129 / B-130) ─────────────────────────────────────────
#   آلية PM2 (lib/Worker.js): كل دورة worker إن كان RSS > max_memory_restart
#   تُطلق reloadProcessId (= SIGINT في fork-mode) بلا أي فحص للجلسات. ذلك يدخل
#   العملية في drain (shutdown-drain.service.ts): server.close() يحرّر المقبس
#   فوراً، لكن PM2 fork-mode **لا يشغّل البديلة حتى تخرج العملية القديمة**،
#   والخروج ينتظر countActiveSessionsByProvider()==0 (drain بلا سقف،
#   DRAIN_TIMEOUT_MS=0). فما دامت جلسة claude ابنة حيّة (مثلاً --resume) لا مستمع
#   على المنفذ 3004 طوال الـdrain → انقطاع 502 ممتد (B-129: 916MB عند 06:57:47
#   UTC → احتجاز ~18 دقيقة). هذا المسار الآلي يتجاوز بوّابة safe-restart.sh كلياً.
#
#   الحلّ (B-130): يُحيَّد max_memory_restart من PM2 (يصير undefined فتُعطَّل آلية
#   Worker تماماً — انظر أدناه)، ويحلّ محلّه هذا الحارس الدوري (cron) الذي:
#     1) يقيس RSS من `pm2 jlist` (قراءة فقط).
#     2) دون العتبة → لا شيء (يحدّث ملف حالة خفيف فقط).
#     3) عند/فوق العتبة → يعيد التشغيل **فقط إن كان آمناً**: لا عمليات مزوّد
#        ابنة حيّة (= لا جلسات حيّة) **و** لا workflow حيّ. التنفيذ يُفوَّض دائماً
#        إلى بوّابة scripts/safe-restart.sh --exec المُصلّبة (تفحص الـworkflows
#        وتنفّذ restart آمناً)؛ إن وُجد عملٌ حيّ → تأجيل (لا قطع)، يُعاد المحاولة
#        في الدورة التالية.
#
#   لماذا فحص العمليات الأبناء هنا (لا فحص workflow في safe-restart وحده)؟
#   لأن الـdrain يُبقي العملية القديمة حيّة حتى countActiveSessions==0، وهذا
#   يقابل عمليات المزوّد الابنة (claude/agy/codex/gemini/cursor/hermes/opencode)
#   تحت PID العملية. safe-restart يفحص journals الـworkflows فقط، فأضفنا هنا
#   بوّابة العمليات الأبناء كي لا نُطلق restart أثناء جلسة تفاعلية حيّة (وهو ما
#   يعيد إنتاج عطل 502 بالضبط).
#
# ⚠️ قراءة فقط ما لم يقرّر restart، وحتى حينها **فقط عبر safe-restart.sh**. لا
#    pm2 restart/stop/reload خام إطلاقاً. Idempotent، محميّ بـflock ضد التداخل.
#
# ── التشغيل / Run ────────────────────────────────────────────────────────────
#   يُشغَّل من cron كل بضع دقائق. مثال (كل 3 دقائق):
#     */3 * * * * /usr/bin/env bash /path/to/nassaj/scripts/memory-guard.sh >/dev/null 2>&1
#   ملاحظة: cron يعمل خارج عميل Claude Code، فحارس الأوامر لا يعترض pm2 هناك —
#   لذا safe-restart.sh --exec ينفّذ pm2 restart فعلياً عند نافذة آمنة.
#   السكربت يثبّت HOME/PM2_HOME/PATH بنفسه (B-177)، فلا حاجة لتزيين سطر cron بها.
#
#   للتحقّق اليدوي بلا أي أثر (لا restart، لا قفل):
#     bash scripts/memory-guard.sh --check
#   يطبع القياس على stdout ويخرج بـ0 إن رأى العملية، وبـ1 إن كان أعمى.
#
# ── لماذا تصلّبت البيئة / Env hardening (B-177) ───────────────────────────────
#   عطل ميداني: 2026-07-19 → 2026-07-24 ظلّ الحارس يطبع «العملية nassaj-dev غير
#   موجودة في PM2» كل 3 دقائق (480 سطراً/يوم × 5 أيام = 2263 سطراً) ثم توقّف
#   وحده. التشخيص (مقارنة بعيّنات nassaj-mem-sampler المستقلّة التي تثبّت
#   PM2_HOME صراحةً): العيّنات سجّلت NOT_FOUND في **نفس** النافذة بالضبط، أي أن
#   العملية كانت فعلاً خارج PM2 آنذاك (أُعيد تسجيلها 07-24T15:45، pm_id 4→5).
#   فلا «انفصال رؤية» كان قد وقع — **لكن العطل الحقيقي أن الحارس بقي معطَّلاً
#   خمسة أيام دون أن يصرخ أحد**: يخرج بـ0 دوماً، وcron يبتلع مخرجه، والسطر
#   نفسه يتكرر بلا تصعيد. ولا وسيلة لتمييز «العملية غائبة» عن «الحارس أعمى».
#
#   وهناك انفصال رؤية *كامن* مُثبَت تجريبياً: `pm2 jlist` ببيئة HOME/PM2_HOME
#   مغايرة **يُطلق God Daemon جديداً فارغاً** ويُعيد `[]` (أو banner ASCII يفسد
#   JSON). عندها كان الحارس يبلّغ MISSING إلى الأبد بينما العملية سليمة. لذا:
#     • تُثبَّت HOME/PM2_HOME/PATH داخل السكربت (كما يفعل nassaj-mem-sampler)،
#       فلا يعود يعتمد على بيئة cron الفقيرة.
#     • **لا يُستدعى pm2 إطلاقاً قبل التأكد من وجود God Daemon حيّ** لهذا
#       PM2_HOME (pm2.pid + /proc، ثم مسح ps احتياطاً) → استحالة إطلاق daemon شبح.
#     • تُميَّز الحالات: no-bin / no-daemon / jlist-err / pm2-empty / missing.
#       `pm2-empty` (daemon حيّ لكن صفر تطبيقات) = انفصال رؤية لا غياب عملية.
#     • عدّاد إخفاق متتالٍ: WARN مرة واحدة، ثم CRITICAL عند العتبة (افتراضي 5
#       دورات = ~15 دقيقة عمى) وكل 100 دورة بعدها، وسطر «استعاد الرؤية» عند
#       التعافي. بدل 480 سطراً متطابقاً يومياً.
#
# ── متغيّرات البيئة / Env vars ────────────────────────────────────────────────
#   PROC_NAME               اسم عملية PM2                (افتراضي: nassaj-dev)
#   MEM_GUARD_THRESHOLD_MB  عتبة RSS بالميغابايت لبدء محاولة إعادة تشغيل آمنة
#                           (افتراضي: 850؛ الحدّ القديم كان 768MiB وأطلق فعلياً
#                           عند 916MB. النظام يملك ~10GB فالتأجيل حتى الخمول آمن
#                           من OOM بهامش واسع).
#   MEM_GUARD_FORCE_MB      سقف حرج اختياري (غير مضبوط افتراضياً = معطَّل). فوقه
#                           يُسجَّل سطر CRITICAL للتنبيه. لا restart قسري إلا إذا
#                           ضُبط أيضاً MEM_GUARD_FORCE_RESTART=1 (يقبل المالك حينها
#                           drain قصيراً محتمَلاً بدل نموّ لا محدود نحو OOM). القرار
#                           السياسي (تنبيه فقط أم قطع قسري) متروك للمالك — انظر
#                           triage B-130 (فصل خدمة الجلسات ADR-021 هو الحلّ الجذري).
#   MEM_GUARD_PROVIDERS_RE  regex لأسماء/وسائط عمليات المزوّد الابنة
#                           (افتراضي أدناه).
#   MEM_GUARD_PM2_HOME      PM2_HOME المُثبَّت (افتراضي: $PM2_HOME أو $HOME/.pm2)
#   MEM_GUARD_PM2_BIN       مسار pm2 صراحةً   (افتراضي: command -v pm2)
#   MEM_GUARD_NODE_BIN      مسار node صراحةً  (افتراضي: command -v node)
#   MEM_GUARD_FAIL_ESCALATE_AT  عدد الدورات العمياء المتتالية قبل CRITICAL (5)
#   MEM_GUARD_DRY_RUN=1     لا تنفيذ restart إطلاقاً + طباعة القرار على stdout
#                           (نفس أثر الوسيط --check / --dry-run). للتحقّق الميداني.
#   MEM_GUARD_LOG           ملف السجل (افتراضي: $PM2_HOME/logs/nassaj-memory-guard.log)
#   MEM_GUARD_STATE         ملف الحالة الخفيف (افتراضي: نفس المجلد/.state)
#
# ── رمز الخروج / Exit ─────────────────────────────────────────────────────────
#   من cron: دائماً 0 (حارس لا يجب أن يُصدر ضجيجاً في mail cron). القرارات في السجل.
#   مع --check: 0 إن رأى العملية وقاسها، و1 إن كان أعمى (لأي سبب) — للتحقّق اليدوي.
# ============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"

# ── تثبيت البيئة قبل أي شيء (B-177) ──────────────────────────────────────────
# cron يمرّر بيئة فقيرة (PATH=/usr/bin:/bin، ولا PM2_HOME). أي انحراف في HOME
# يجعل pm2 يحلّ PM2_HOME مغايراً → daemon شبح فارغ → عمى دائم. نثبّت الثلاثة.
if [ -z "${HOME:-}" ]; then
  HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
  [ -n "$HOME" ] || HOME="/home/$(id -un 2>/dev/null || echo nassaj)"
fi
export HOME
export PM2_HOME="${MEM_GUARD_PM2_HOME:-${PM2_HOME:-$HOME/.pm2}}"
# PATH: نُلحق المواضع المعروفة **بعد** الموروث (لا قبله) — كي لا نتجاوز pm2/node
# مثبَّتَين عمداً في مسار مخصّص (nvm/عقدة أسطول)، مع ضمان وجودها حين يأتي PATH
# فقيراً من cron.
export PATH="${PATH:-}:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

DRY_RUN="${MEM_GUARD_DRY_RUN:-0}"
for _arg in "$@"; do
  case "$_arg" in
    --check|--dry-run) DRY_RUN=1 ;;
  esac
done

PROC_NAME="${PROC_NAME:-nassaj-dev}"
THRESHOLD_MB="${MEM_GUARD_THRESHOLD_MB:-850}"
FORCE_MB="${MEM_GUARD_FORCE_MB:-}"
FORCE_RESTART="${MEM_GUARD_FORCE_RESTART:-0}"
PROVIDERS_RE="${MEM_GUARD_PROVIDERS_RE:-claude|agy|codex|gemini|cursor|hermes|opencode}"
LOG_FILE="${MEM_GUARD_LOG:-$PM2_HOME/logs/nassaj-memory-guard.log}"
STATE_FILE="${MEM_GUARD_STATE:-$PM2_HOME/logs/nassaj-memory-guard.state}"
FAIL_FILE="${MEM_GUARD_FAIL_STATE:-$STATE_FILE.fail}"
FAIL_ESCALATE_AT="${MEM_GUARD_FAIL_ESCALATE_AT:-5}"
LOCK_FILE="${MEM_GUARD_LOCK:-/tmp/nassaj-memory-guard.lock}"

mkdir -p "$(dirname -- "$LOG_FILE")" 2>/dev/null || true

ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
log() {
  printf '%s [%s] %s\n' "$(ts)" "$1" "$2" >>"$LOG_FILE" 2>/dev/null
  [ "$DRY_RUN" = "1" ] && printf '%s [%s] %s\n' "$(ts)" "$1" "$2"
  return 0
}
state() { printf '%s rss=%sMB threshold=%sMB %s\n' "$(ts)" "$1" "$THRESHOLD_MB" "$2" >"$STATE_FILE" 2>/dev/null; }

# ── عدّاد الإخفاق المتتالي: WARN مرة، CRITICAL عند العتبة، لا سيل متطابق ──────
_read_streak() {
  local v
  v="$(cat "$FAIL_FILE" 2>/dev/null)"
  case "$v" in ''|*[!0-9]*) printf '0' ;; *) printf '%s' "$v" ;; esac
}
# blind <state-kind> <message> — يسجّل دورة عمياء ويخرج (0 من cron، 1 من --check)
blind() {
  local kind="$1" msg="$2" n
  n=$(( $(_read_streak) + 1 ))
  printf '%s\n' "$n" >"$FAIL_FILE" 2>/dev/null || true
  if [ "$n" -eq 1 ]; then
    log WARN "$msg"
  elif [ "$n" -eq "$FAIL_ESCALATE_AT" ]; then
    log CRITICAL "الحارس أعمى منذ $n دورة متتالية — لا حراسة ذاكرة فعلية. $msg"
  elif [ $(( n % 100 )) -eq 0 ]; then
    log CRITICAL "الحارس ما زال أعمى ($n دورة متتالية). $msg"
  fi
  state "?" "$kind:streak=$n"
  [ "$DRY_RUN" = "1" ] && exit 1
  exit 0
}
# sighted — استُعيدت الرؤية: يمسح العدّاد ويسجّل سطر تعافٍ إن سبقه عمى
sighted() {
  local n
  n="$(_read_streak)"
  if [ "$n" -gt 0 ] 2>/dev/null; then
    log INFO "الحارس استعاد رؤية $PROC_NAME بعد $n دورة عمياء."
  fi
  rm -f "$FAIL_FILE" 2>/dev/null || true
}

# ── قفل ضد التداخل (best-effort) ─────────────────────────────────────────────
# لو دورة سابقة ما زالت تعمل (مثلاً safe-restart ينتظر)، نتخطّى هذه الدورة.
# --check لا يأخذ القفل: فحصٌ قراءة-فقط لا ينفّذ شيئاً، ويجب أن يعمل بأي وقت.
if [ "$DRY_RUN" != "1" ] && command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE" 2>/dev/null || true
  if ! flock -n 9; then
    state "?" "skip:locked"
    exit 0
  fi
fi

# ── حلّ الثنائيات صراحةً (cron قد لا يرى pm2/node) ───────────────────────────
PM2_BIN="${MEM_GUARD_PM2_BIN:-$(command -v pm2 2>/dev/null || true)}"
NODE_BIN="${MEM_GUARD_NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [ -z "$PM2_BIN" ] || [ -z "$NODE_BIN" ]; then
  blind "error:no-bin" "pm2/node غير موجودين على PATH=$PATH (pm2='$PM2_BIN' node='$NODE_BIN')."
fi

# ── بوّابة God Daemon: لا نستدعي pm2 قبل التأكد من daemon حيّ لهذا PM2_HOME ───
# سبب البوّابة (B-177): `pm2 jlist` على PM2_HOME بلا daemon **يُطلق daemon جديداً
# فارغاً** ثم يُعيد [] (أو banner ASCII يفسد JSON) — فيبلّغ الحارس «غير موجودة»
# إلى الأبد بينما العملية الحقيقية سليمة تحت daemon آخر. نمنع ذلك بنيوياً.
daemon_pid() {
  local p
  p="$(cat "$PM2_HOME/pm2.pid" 2>/dev/null | tr -dc '0-9')"
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null \
     && tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -q 'God Daemon'; then
    printf '%s' "$p"; return 0
  fi
  # احتياط: pm2.pid مفقود/بائت لكن الـdaemon حيّ — امسح ps بحثاً عن هذا PM2_HOME.
  p="$(ps -eo pid=,args= 2>/dev/null | grep -F "God Daemon ($PM2_HOME)" \
       | grep -v grep | awk '{print $1}' | head -n1)"
  [ -n "$p" ] && { printf '%s' "$p"; return 0; }
  return 1
}
DAEMON_PID="$(daemon_pid || true)"
if [ -z "$DAEMON_PID" ]; then
  blind "error:no-daemon" "لا God Daemon حيّ على PM2_HOME=$PM2_HOME — لم نستدعِ pm2 (تفادياً لإطلاق daemon شبح)."
fi

# ── قراءة RSS وPID من pm2 jlist (قراءة فقط) ─────────────────────────────────
# ملاحظة حاسمة: في `A=v cmd | node` يخصّ الإسناد cmd لا node — لذا PROC_NAME على
# جانب node مباشرةً (وإلا رآه node undefined فطابق x.name===undefined → MISSING).
READ="$(
  "$PM2_BIN" jlist 2>/dev/null | PROC_NAME="$PROC_NAME" "$NODE_BIN" -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      let a;try{a=JSON.parse(s)}catch(_){process.stdout.write("ERR");return}
      if(!Array.isArray(a)){process.stdout.write("ERR");return}
      if(a.length===0){process.stdout.write("EMPTY");return}
      const p=a.find(x=>x&&x.name===process.env.PROC_NAME);
      if(!p){process.stdout.write("MISSING:"+a.length);return}
      const rss=(p.monit&&p.monit.memory)||0;
      const status=(p.pm2_env&&p.pm2_env.status)||"?";
      process.stdout.write(String(p.pid||0)+" "+String(rss)+" "+status);
    })' 2>/dev/null
)"

case "$READ" in
  ""|ERR)
    blind "error:jlist" "تعذّر قراءة/تحليل مخرج pm2 jlist (PM2_HOME=$PM2_HOME، daemon=$DAEMON_PID، pm2=$PM2_BIN)."
    ;;
  EMPTY)
    # daemon حيّ لكن صفر تطبيقات = انفصال رؤية (PM2_HOME/بيئة خاطئة أو daemon شبح)،
    # وليس غياب العملية. تمييزها عن MISSING شرطُ التشخيص الصحيح.
    blind "error:pm2-empty" "pm2 يرى صفر تطبيقات رغم daemon حيّ pid=$DAEMON_PID على PM2_HOME=$PM2_HOME — انفصال رؤية لا غياب عملية."
    ;;
  MISSING:*)
    blind "missing" "العملية $PROC_NAME غير موجودة ضمن ${READ#MISSING:} تطبيقاً مسجّلاً على PM2_HOME=$PM2_HOME — لا شيء لحراسته."
    ;;
esac

PID="${READ%% *}"
_rest="${READ#* }"
RSS_BYTES="${_rest%% *}"
STATUS="${_rest##* }"
RSS_MB=$(( RSS_BYTES / 1048576 ))

# وصلنا هنا ⇒ الحارس يرى العملية ويقيسها فعلاً: امسح عدّاد العمى (وسجّل التعافي).
sighted

# العملية ليست online (قد تكون stopping/errored) → لا نتدخّل، نسجّل فقط.
if [ "$STATUS" != "online" ]; then
  log WARN "الحالة=$STATUS (rss=${RSS_MB}MB) — لا إجراء (العملية ليست online)."
  state "$RSS_MB" "noop:status=$STATUS"
  exit 0
fi

# ── دون العتبة → لا إجراء ─────────────────────────────────────────────────────
if [ "$RSS_MB" -lt "$THRESHOLD_MB" ]; then
  [ "$DRY_RUN" = "1" ] && log INFO \
    "فحص: $PROC_NAME pid=$PID rss=${RSS_MB}MB < ${THRESHOLD_MB}MB (PM2_HOME=$PM2_HOME، daemon=$DAEMON_PID) → لا إجراء."
  state "$RSS_MB" "ok"
  exit 0
fi

# ── فوق العتبة: عُدّ عمليات المزوّد الابنة (= جلسات حيّة) ────────────────────────
# نمشي شجرة الأحفاد من PID العملية ونعدّ ما يطابق اسمه/وسائطه regex المزوّدين.
# اللقطة من ps -eo واحدة (تجنّب السباق) ونحلّها في node.
# نطابق basename لأول رمزين فقط (argv0 + argv1) لا كامل الargs — كي لا نطابق
# مسارات عابرة تحوي اسم مزوّد (مثل .../.claude/...) في أغلفة bash. هذا يلتقط
# `claude ...` (argv0) و`node /path/agy.js ...` (argv1) ويتجاهل `/bin/bash -c ...`.
LIVE_SESSIONS="$(
  ps -eo pid=,ppid=,args= 2>/dev/null | \
  ROOT="$PID" RE="$PROVIDERS_RE" node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const root=parseInt(process.env.ROOT,10);
      // مثبَّت عند بداية الـbasename، يسمح بلاحقة (agy.js) لكن يمنع تطابق منتصف كلمة.
      const re=new RegExp("^("+process.env.RE+")([^A-Za-z0-9]|$)","i");
      const base=(t)=>{ if(!t) return ""; t=t.split("/").pop(); return t; };
      const rows=[];
      for(const line of s.split("\n")){
        const m=line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if(m) rows.push({pid:+m[1],ppid:+m[2],args:m[3]});
      }
      const childrenOf={};
      for(const r of rows){(childrenOf[r.ppid]=childrenOf[r.ppid]||[]).push(r);}
      // BFS للأحفاد
      const desc=[]; const q=[root]; const seen=new Set([root]);
      while(q.length){const cur=q.shift();for(const c of (childrenOf[cur]||[])){if(!seen.has(c.pid)){seen.add(c.pid);desc.push(c);q.push(c.pid);}}}
      let n=0;
      for(const d of desc){
        const toks=d.args.split(/\s+/);
        const t0=base(toks[0]), t1=base(toks[1]);
        if(re.test(t0) || re.test(t1)) n++;
      }
      process.stdout.write(String(n));
    })' 2>/dev/null
)"
[ -z "$LIVE_SESSIONS" ] && LIVE_SESSIONS="?"

# ── سقف حرج اختياري (opt-in) ─────────────────────────────────────────────────
if [ -n "$FORCE_MB" ] && [ "$RSS_MB" -ge "$FORCE_MB" ]; then
  log CRITICAL "RSS=${RSS_MB}MB بلغ السقف الحرج ${FORCE_MB}MB (جلسات حيّة=$LIVE_SESSIONS). خطر نموّ نحو OOM."
  if [ "$FORCE_RESTART" = "1" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      log INFO "[dry-run] كان سيُنفَّذ: safe-restart.sh --force --exec (rss=${RSS_MB}MB ≥ ${FORCE_MB}MB)."
      state "$RSS_MB" "dry-run:force-restart"
      exit 0
    fi
    log CRITICAL "MEM_GUARD_FORCE_RESTART=1 → restart قسري عبر safe-restart --force --exec (قد يسبّب drain قصيراً)."
    ( cd "$REPO_DIR" && bash scripts/safe-restart.sh --force --exec ) >>"$LOG_FILE" 2>&1
    rc=$?
    log CRITICAL "safe-restart --force --exec انتهى برمز=$rc"
    state "$RSS_MB" "force-restart:rc=$rc"
    exit 0
  fi
  # بلا FORCE_RESTART: تنبيه فقط، لا قطع — نكمل لمنطق التأجيل العادي أدناه.
fi

# ── جلسات حيّة → تأجيل (لا قطع) ────────────────────────────────────────────────
if [ "$LIVE_SESSIONS" != "0" ]; then
  log INFO "RSS=${RSS_MB}MB ≥ ${THRESHOLD_MB}MB لكن $LIVE_SESSIONS جلسة مزوّد حيّة → تأجيل (سيُعاد الفحص لاحقاً)."
  state "$RSS_MB" "defer:sessions=$LIVE_SESSIONS"
  exit 0
fi

# ── لا جلسات حيّة → نافذة آمنة: فوّض التنفيذ إلى safe-restart المُصلّبة ──────────
# safe-restart يفحص الـworkflows بنفسه ويؤجّل (exit 3) إن وُجد عملٌ حيّ، وينفّذ
# restart آمناً وإلا. لا نمرّر --force: نحترم أي workflow حيّ يكشفه.
if [ "$DRY_RUN" = "1" ]; then
  log INFO "[dry-run] rss=${RSS_MB}MB ≥ ${THRESHOLD_MB}MB ولا جلسات حيّة → كان سيُنفَّذ: safe-restart.sh --exec"
  state "$RSS_MB" "dry-run:restart"
  exit 0
fi
log INFO "RSS=${RSS_MB}MB ≥ ${THRESHOLD_MB}MB ولا جلسات حيّة → نافذة آمنة: تفويض safe-restart.sh --exec"
( cd "$REPO_DIR" && bash scripts/safe-restart.sh --exec ) >>"$LOG_FILE" 2>&1
rc=$?
case "$rc" in
  0) log INFO  "safe-restart: أُعيد التشغيل بنجاح (rc=0)." ; state "$RSS_MB" "restarted" ;;
  3) log INFO  "safe-restart: أُجّل (workflow حيّ اكتشفه، rc=3)." ; state "$RSS_MB" "defer:workflow" ;;
  4) log WARN  "safe-restart: العملية غير مسجّلة في PM2 (rc=4)." ; state "$RSS_MB" "error:not-in-pm2" ;;
  *) log WARN  "safe-restart: رمز خروج غير متوقّع rc=$rc." ; state "$RSS_MB" "error:rc=$rc" ;;
esac
exit 0
