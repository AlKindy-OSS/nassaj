#!/usr/bin/env bash
# liveness-watch — notify-only local health monitor.
#
# مرصاد حياة إشعاري بحت: يفحص /health على المنفذ المحلي، وبعد ٣ فحوص متتالية
# فاشلة يكتب إنذاراً في السجل ويصدر سطر logger — **ولا يرسل أي إشارة ولا يقتل
# ولا يعيد تشغيل شيئاً أبداً**. التعافي التلقائي من فحص منفرد قد يحوّل نبضة
# عابرة إلى انقطاع؛ لذلك يبقى القرار لمسار التشغيل المحكوم.
#
# لماذا ٣ فحوص ومهلة 10 ثوانٍ؟ /health يلمس SQLite (better-sqlite3 متزامن)
# وخادم أحادي الخيط قد يتأخر تحت حمل مشروع — فشل واحد أو اثنان ليسا دليل موت.
#
# التعافي (يد المشغّل حصراً) موثّق في docs/runbooks/drain-recovery.md.
#
# يُشغَّل من systemd user timer (scripts/systemd/nassaj-liveness.*) كل ٦٠ ثانية.
set -u

PORT="${NASSAJ_PORT:-3004}"
PROC_NAME="${PROC_NAME:-${NASSAJ_PROCESS_NAME:-nassaj-dev}}"
URL="http://127.0.0.1:${PORT}/health"
STATE_DIR="${XDG_RUNTIME_DIR:-/tmp}/nassaj-liveness"
ALERT_DIR="${HOME}/.local/share/nassaj-liveness"
FAILS_FILE="${STATE_DIR}/consecutive-fails"
ALERT_LOG="${ALERT_DIR}/alerts.log"
THRESHOLD=3

mkdir -p "$STATE_DIR" "$ALERT_DIR"

# قفل يمنع تراكب تشغيلين (نمط memory-guard).
exec 9>"${STATE_DIR}/lock"
flock -n 9 || exit 0

# افحص الصحة مرة واحدة. لا تستدعِ pm2 من المرصاد: أوامر القراءة في عميل PM2
# تنشئ عفريتاً جديداً إن غاب pm2.pid أو المقبس، وهذا صنع مشرفاً موازياً للخدمة
# الحيّة وحجب safe-restart (B-1204).
health_json=""
health_ok=0
if health_json="$(curl -fsS --max-time 10 "$URL")"; then
  health_ok=1
fi

# T-1686: أبقِ core dumps مطفأة على العملية التي أثبتتها /health نفسها. لا
# نستنبط PID عبر PM2، كي يبقى المرصاد إشعارياً ولا ينشئ مشرفاً عند غياب المقبس.
live_pid="$(printf '%s' "$health_json" | python3 -c '
import json,sys
try:
    pid=json.load(sys.stdin).get("pid")
    if isinstance(pid,int) and pid > 1:
        print(pid)
except Exception:
    pass' 2>/dev/null || true)"
if [ -n "$live_pid" ] && [ "$live_pid" != "0" ] \
   && [ "$(stat -c %u "/proc/${live_pid}" 2>/dev/null || true)" = "$(id -u)" ] \
   && grep -q '^Max core file size *unlimited' "/proc/${live_pid}/limits" 2>/dev/null; then
  if prlimit --core=0 --pid "$live_pid" 2>/dev/null; then
    logger -t nassaj-liveness "core dump limit set to 0 on pid ${live_pid} (T-1686)"
  fi
fi

fails=0
[ -f "$FAILS_FILE" ] && fails="$(cat "$FAILS_FILE" 2>/dev/null || echo 0)"
case "$fails" in ''|*[!0-9]*) fails=0 ;; esac

if [ "$health_ok" -eq 1 ]; then
  if [ "$fails" -ge "$THRESHOLD" ]; then
    echo "$(date -Is) RECOVERED after ${fails} failed probe(s) — ${URL}" >> "$ALERT_LOG"
    logger -t nassaj-liveness "RECOVERED: ${URL} answering again after ${fails} failed probe(s)"
  fi
  echo 0 > "$FAILS_FILE"
  exit 0
fi

fails=$((fails + 1))
echo "$fails" > "$FAILS_FILE"

if [ "$fails" -lt "$THRESHOLD" ]; then
  # فشل مبكر: سجّل بصمت فقط — لا إنذار قبل العتبة.
  logger -t nassaj-liveness "probe failed (${fails}/${THRESHOLD}) — ${URL}"
  exit 0
fi

# العتبة بلغت: إنذار مفصَّل قابل للتنفيذ. قراءة فقط — جمع سياق لا أفعال.
pm2_line="pm2: not queried (no-spawn monitor, process=${PROC_NAME})"
port_holder="$(ss -ltnp 2>/dev/null | grep ":${PORT} " | head -1 || echo "no listener on :${PORT}")"

{
  echo "$(date -Is) ALERT probe ${fails}/${THRESHOLD} failed — ${URL}"
  echo "  ${pm2_line:-pm2: unavailable}"
  echo "  port: ${port_holder}"
  echo "  runbook: docs/runbooks/drain-recovery.md (استخدم مسار الاستعادة المحكوم فقط)"
} >> "$ALERT_LOG"
logger -t nassaj-liveness "ALERT: ${URL} dead for ${fails} consecutive probes — see ${ALERT_LOG}"
exit 0
