#!/usr/bin/env bash
# مرصاد الفاعل: من يُعيد تشغيل nassaj-dev من خارج التطبيق؟
#
# السياق: سجلّ God Daemon يُظهر إعادات تشغيل متكررة (01:07 · 01:12 · 01:30 ·
# 01:57 · 02:04) واحدةٌ فقط منها لها أثر في audit_log — أي أن الباقي صادر من
# خارج مسار لوحة الأوامر. استُبعدت المؤتمتات بالفحص: minwal-supervisor بلا أي
# منطق restart، وmemory-guard آخر قراراته «لا إجراء»، وPM2 بـwatch=false
# وkill_timeout=24h وrestart_time=0.
#
# لينكس لا يسجّل مُرسِل الإشارة بلا auditd/eBPF، فالمرصاد يأخذ عيّنات سريعة من
# /proc بدلاً من ذلك: أي عملية تشغّل safe-restart أو pm2 بفعل دورة حياة تُلتقط
# مع **سلسلة آبائها كاملة** — وهي ما يميّز جلسة Claude من طرفية ssh من cron.
#
# قراءة فقط: لا يقتل شيئاً ولا يعدّل شيئاً.
set -uo pipefail

OUT="${1:-/tmp/restart-culprit.log}"
DURATION_S="${2:-3600}"
INTERVAL_S=1

say() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$OUT"; }

# سلسلة الآباء من عملية حتى init — تكشف السياق الذي أطلق الأمر.
ancestry() {
  local pid="$1" depth=0
  while [ "$pid" -gt 1 ] && [ "$depth" -lt 8 ]; do
    local cmd ppid
    cmd=$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | cut -c1-120)
    [ -z "$cmd" ] && cmd="[$(cat "/proc/$pid/comm" 2>/dev/null)]"
    ppid=$(awk '/^PPid:/{print $2}' "/proc/$pid/status" 2>/dev/null)
    printf '      ↑ %s  %s\n' "$pid" "$cmd" >>"$OUT"
    [ -z "$ppid" ] && break
    pid="$ppid"
    depth=$((depth + 1))
  done
}

say "=== بدء المراقبة (مدة ${DURATION_S}s، عيّنة كل ${INTERVAL_S}s) ==="
say "pid الخادم الحالي: $(pgrep -f 'dist-server/server/index.js' | head -1)"

END=$(( $(date +%s) + DURATION_S ))
declare -A SEEN

while [ "$(date +%s)" -lt "$END" ]; do
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    cmd=$(tr '\0' ' ' <"$d/cmdline" 2>/dev/null) || continue
    [ -z "$cmd" ] && continue
    case "$cmd" in
      # الفاعل المحتمل: سكربت النشر، أو pm2 بفعل دورة حياة (لا pm2 jlist/describe القرائية)
      *safe-restart.sh*|*pm2\ restart*|*pm2\ reload*|*pm2\ stop*|*pm2\ delete*|*pm2\ start*)
        # تجاهل المرصاد نفسه
        case "$cmd" in *restart-culprit-watch*) continue ;; esac
        key="$pid"
        [ -n "${SEEN[$key]:-}" ] && continue
        SEEN[$key]=1
        say "‼️  التُقط: pid=$pid"
        say "    الأمر: $(printf '%s' "$cmd" | cut -c1-200)"
        say "    السلسلة:"
        ancestry "$pid"
        ;;
    esac
  done
  sleep "$INTERVAL_S"
done

say "=== انتهت المراقبة ==="
