#!/usr/bin/env bash
# ============================================================================
# monitor-rss.sh  (B-MU-SYNC / Phase-MU)
# ----------------------------------------------------------------------------
# الغرض / Purpose:
#   مراقبة قراءة-فقط لاستهلاك ذاكرة (RSS) عملية PM2 `nassaj-dev` وعملياتها
#   الفرعية `claude` تحت حمل تعدّد المستخدمين، مقابل سقف `max_memory_restart`.
#   يطبع تحذيراً عند تجاوز عتبة (افتراضياً 80% من السقف) أو عند ارتفاع
#   استهلاك ذاكرة النظام فوق ~80%.
#
#   Read-only RSS monitor for the `nassaj-dev` PM2 process and its child
#   `claude` processes under multi-user load, compared against the live
#   `max_memory_restart` cap. Prints a WARN when a threshold is crossed.
#
# سبب الوجود / Context:
#   تعدّد المستخدمين يُشغّل عملية claude فرعية معزولة لكل جلسة (ADR-023).
#   مجموع RSS قد يتجاوز سقف nassaj-dev → pm2 يعيد التشغيل ويقطع الجلسات،
#   أو نوبة OOM على مستوى النظام. راجع حادثة nassaj-server-docs.md 2026-06-06
#   وقسم §11 في docs/RUNBOOK-MULTI-USER.md.
#
# ⚠️ قراءة فقط: لا يقتل، لا يعيد تشغيل، لا يعدّل أي إعداد. آمن للتكرار.
#    READ-ONLY: never kills, restarts, or edits config. Idempotent.
#    حارس restart يحجب pm2 restart على أي حال؛ هذا السكربت لا يحاوله.
#
# الاستخدام / Usage:
#   bash scripts/monitor-rss.sh              # لقطة واحدة / one snapshot
#   bash scripts/monitor-rss.sh --watch      # كل 30 ثانية / loop every 30s
#   bash scripts/monitor-rss.sh --watch 60   # كل 60 ثانية / loop every 60s
#   bash scripts/monitor-rss.sh --json       # خرج JSON للتجميع/التنبيهات
#
# متغيّرات البيئة / Env vars:
#   PROC_NAME   اسم عملية PM2          (افتراضي: nassaj-dev)
#   THRESHOLD   نسبة التحذير من السقف  (افتراضي: 80)
#   SYS_THRESH  عتبة ذاكرة النظام %    (افتراضي: 80)
#   LOG_FILE    مسار سجل اختياري       (افتراضي: لا تسجيل، stdout فقط)
#
# رمز الخروج / Exit code: 0 = OK، 1 = تحذير عتبة، 2 = خطأ قراءة.
# ============================================================================
set -euo pipefail

PROC_NAME="${PROC_NAME:-nassaj-dev}"
THRESHOLD="${THRESHOLD:-80}"
SYS_THRESH="${SYS_THRESH:-80}"
LOG_FILE="${LOG_FILE:-}"

ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }

emit() {
  # $1 = level (INFO|WARN|CRIT), $2 = message
  local line="$(ts) [$1] $2"
  echo "$line"
  [ -n "$LOG_FILE" ] && echo "$line" >> "$LOG_FILE" || true
}

# --- جمع البيانات (قراءة فقط) -------------------------------------------------
# نقرأ pid + max_memory_restart الحيّ من pm2 jlist (لا من ecosystem.config.cjs،
# لأن السقف الحيّ قد يكون None رغم وجود قيمة في الملف — حادثة 2026-06-06).
# ملاحظة: python يستدعي pm2 بنفسه (لا عبر pipe) لأن الـ heredoc يحتلّ stdin.
collect() {
  PROC_NAME="$PROC_NAME" python3 - <<'PY'
import sys, json, os, subprocess

proc_name = os.environ["PROC_NAME"]
try:
    out = subprocess.run(["pm2", "jlist"], capture_output=True, text=True).stdout
    data = json.loads(out)
except Exception:
    print("ERR pm2_jlist_unreadable"); sys.exit(0)

target = next((p for p in data if p.get("name") == proc_name), None)
if not target:
    print(f"ERR process_not_found:{proc_name}"); sys.exit(0)

pid = target.get("pid") or 0
env = target.get("pm2_env", {})
cap = env.get("max_memory_restart")          # bytes or None
rss = (target.get("monit") or {}).get("memory") or 0   # bytes
restarts = env.get("restart_time", env.get("restarts", 0))

# عمليات claude الفرعية المباشرة (PPID == pid). قراءة فقط من ps.
children = []
total_child_rss = 0
if pid:
    try:
        out = subprocess.check_output(
            ["ps", "-eo", "pid,ppid,rss,comm"], text=True)
        for ln in out.splitlines()[1:]:
            parts = ln.split(None, 3)
            if len(parts) < 4:
                continue
            cpid, ppid, krss, comm = parts
            if ppid == str(pid) and "claude" in comm.lower():
                kb = int(krss)
                total_child_rss += kb * 1024
                children.append({"pid": int(cpid), "rss": kb * 1024, "comm": comm})
    except Exception:
        pass

# ذاكرة النظام
sys_used_pct = 0.0
try:
    mt = ma = 0
    with open("/proc/meminfo") as f:
        for ln in f:
            if ln.startswith("MemTotal:"):     mt = int(ln.split()[1])
            elif ln.startswith("MemAvailable:"): ma = int(ln.split()[1])
    if mt:
        sys_used_pct = round((mt - ma) / mt * 100, 1)
except Exception:
    pass

print(json.dumps({
    "proc": proc_name, "pid": pid, "rss": rss, "cap": cap,
    "restarts": restarts, "children": children,
    "child_total_rss": total_child_rss,
    "combined_rss": rss + total_child_rss,
    "sys_used_pct": sys_used_pct,
}))
PY
}

human() { # bytes -> MB
  awk -v b="$1" 'BEGIN{ printf "%.0fM", b/1048576 }'
}

raw="$(collect || true)"

if [ -z "$raw" ] || echo "$raw" | grep -q '^ERR '; then
  emit CRIT "read failure: ${raw:-no_output} (هل PM2 يعمل وعملية $PROC_NAME موجودة؟)"
  exit 2
fi

if [ "${1:-}" = "--json" ]; then
  echo "$raw"
  exit 0
fi

# --- تحليل + تحذيرات ---------------------------------------------------------
analyze() {
  RAW_JSON="$raw" THRESHOLD="$THRESHOLD" SYS_THRESH="$SYS_THRESH" python3 - <<'PY'
import os, json
d = json.loads(os.environ["RAW_JSON"])
thr = float(os.environ["THRESHOLD"]); sys_thr = float(os.environ["SYS_THRESH"])

def mb(b): return f"{(b or 0)/1048576:.0f}M"

cap = d["cap"]
rss = d["rss"]
combined = d["combined_rss"]
nchild = len(d["children"])

lines = []
status = "INFO"

cap_str = mb(cap) if cap else "None (غير مطبَّق على runtime / not applied)"
lines.append(f"proc={d['proc']} pid={d['pid']} restarts={d['restarts']}")
lines.append(f"  nassaj-dev RSS   = {mb(rss)}")
lines.append(f"  child claude     = {nchild} proc, total {mb(d['child_total_rss'])}")
lines.append(f"  combined RSS     = {mb(combined)}")
lines.append(f"  max_memory_restart = {cap_str}")
lines.append(f"  system mem used  = {d['sys_used_pct']}%")

# عتبة السقف: pm2 يقيس RSS العملية نفسها (لا الأطفال) مقابل cap.
# لكن combined هو ما يهدّد OOM على مستوى النظام؛ نراقب الاثنين.
if cap:
    pct = rss / cap * 100
    if pct >= thr:
        status = "WARN"
        lines.append(f"  ⚠️ nassaj-dev RSS = {pct:.0f}% من السقف (عتبة {thr:.0f}%) → خطر pm2 restart وقطع الجلسات")
    combined_pct = combined / cap * 100
    if combined_pct >= 100:
        status = "WARN"
        lines.append(f"  ⚠️ combined RSS = {combined_pct:.0f}% من سقف العملية → الأطفال يتجاوزون السقف؛ راقب OOM وخفّف الجلسات المتزامنة")
else:
    lines.append("  ℹ️ لا سقف حيّ — اعتمد على عتبة ذاكرة النظام أدناه (راجع §11 + حادثة 2026-06-06)")

if d["sys_used_pct"] >= sys_thr:
    status = "WARN"
    lines.append(f"  ⚠️ ذاكرة النظام {d['sys_used_pct']}% ≥ {sys_thr:.0f}% → لا تطلق موجات جلسات متزامنة جديدة (قاعدة CLAUDE.md)")

print(status)
print("\n".join(lines))
PY
}

result="$(analyze)"
level="$(echo "$result" | head -1)"
body="$(echo "$result" | tail -n +2)"

emit "$level" "RSS snapshot:"
echo "$body"
[ -n "$LOG_FILE" ] && echo "$body" >> "$LOG_FILE" || true

# --- وضع المراقبة المستمرة ---------------------------------------------------
if [ "${1:-}" = "--watch" ]; then
  interval="${2:-30}"
  emit INFO "watch mode: every ${interval}s — Ctrl-C للإيقاف"
  while true; do
    sleep "$interval"
    raw="$(collect || true)"
    if [ -z "$raw" ] || echo "$raw" | grep -q '^ERR '; then
      emit CRIT "read failure: ${raw:-no_output}"
      continue
    fi
    result="$(analyze)"
    level="$(echo "$result" | head -1)"
    body="$(echo "$result" | tail -n +2)"
    if [ "$level" != "INFO" ]; then
      emit "$level" "threshold crossed:"
      echo "$body"
      [ -n "$LOG_FILE" ] && echo "$body" >> "$LOG_FILE" || true
    else
      emit INFO "ok ($(echo "$raw" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("rss="+str(round(d["rss"]/1048576))+"M combined="+str(round(d["combined_rss"]/1048576))+"M sys="+str(d["sys_used_pct"])+"%")'))"
    fi
  done
fi

case "$level" in
  WARN|CRIT) exit 1 ;;
  *)         exit 0 ;;
esac
