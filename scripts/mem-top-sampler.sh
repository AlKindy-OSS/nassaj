#!/usr/bin/env bash
# راصد ذاكرة على مستوى النظام — قراءة فقط، لا يقتل ولا يعيد تشغيل شيئاً.
# الغاية: تسمية العملية المسبِّبة لضغط الذاكرة بدل الاستنتاج بعد فوات الأوان.
#
# المخرجات:
#   top-rss.csv         — كل دقيقة: أعلى 8 عمليات بالـRSS + إجمالي الذاكرة المتاحة
#   pressure-<ts>.txt   — لقطة ps كاملة عند هبوط MemAvailable دون العتبة (الدليل الحاسم)
set -uo pipefail

OUT_DIR="${MEM_TOP_DIR:-${HOME}/.local/share/nassaj-mem-monitor}"
CSV="$OUT_DIR/top-rss.csv"
PRESSURE_MB="${MEM_TOP_PRESSURE_MB:-1800}"   # عتبة اللقطة الكاملة
KEEP_DAYS="${MEM_TOP_KEEP_DAYS:-14}"

mkdir -p "$OUT_DIR" || exit 0

# قفل: التشغيل كل دقيقة مع قصّ الملف يعني أن تشغيلين متداخلين قد يفقدان أسطراً
# بين tail وmv — وذلك بالضبط تحت الحِمل، أي حين تكون البيانات مطلوبة.
LOCK="$OUT_DIR/.mem-top-sampler.lock"
exec 9>"$LOCK" 2>/dev/null || true
if command -v flock >/dev/null 2>&1; then
  flock -n 9 || exit 0
fi
TS="$(date +%Y-%m-%dT%H:%M:%S%z)"

read -r _ MEM_TOTAL_KB _ < <(grep -m1 MemTotal /proc/meminfo)
MEM_AVAIL_KB="$(awk '/MemAvailable/{print $2; exit}' /proc/meminfo)"
SWAP_FREE_KB="$(awk '/SwapFree/{print $2; exit}' /proc/meminfo)"
SWAP_TOTAL_KB="$(awk '/SwapTotal/{print $2; exit}' /proc/meminfo)"
AVAIL_MB=$(( MEM_AVAIL_KB / 1024 ))
SWAP_USED_MB=$(( (SWAP_TOTAL_KB - SWAP_FREE_KB) / 1024 ))
# tmpfs محجوز من RAM ولا يتحرّر إلا بحذف أو إعادة إقلاع (وقد تُبدَّل
# صفحاته إلى swap). Shmem أوسع من tmpfs: يشمل memfd وSysV — والعمودان
# معاً هما ما يفصل الفاعل في المرّة القادمة.
SHMEM_KB="$(awk '/^Shmem:/{print $2; exit}' /proc/meminfo)"
SHMEM_MB=$(( ${SHMEM_KB:-0} / 1024 ))
TMP_MB=$(df -m --output=used /tmp 2>/dev/null | tail -1 | tr -d ' ')
SHM_MB=$(df -m --output=used /dev/shm 2>/dev/null | tail -1 | tr -d ' ')

[ -s "$CSV" ] || echo "ts,avail_mb,swap_used_mb,shmem_mb,tmp_mb,devshm_mb,rank,rss_mb,pid,ppid,etimes,comm,args" >"$CSV"

# أعلى 8 عمليات — args مقصوصة لـ120 محرفاً وفواصلها مُستبدلة كي لا تكسر الـCSV
ps -eo rss=,pid=,ppid=,etimes=,comm=,args= --sort=-rss 2>/dev/null | head -8 | \
  awk -v ts="$TS" -v a="$AVAIL_MB" -v s="$SWAP_USED_MB" -v sh="$SHMEM_MB" -v tm="${TMP_MB:-0}" -v ds="${SHM_MB:-0}" '{
    rss=$1; pid=$2; ppid=$3; et=$4; comm=$5;
    args=""; for(i=6;i<=NF;i++) args=args" "$i;
    args=substr(args,2,120); gsub(/[",]/," ",args);
    printf "%s,%d,%d,%d,%d,%d,%d,%.1f,%s,%s,%s,%s,%s\n", ts, a, s, sh, tm, ds, NR, rss/1024, pid, ppid, et, comm, args;
  }' >>"$CSV"

# صفّ المجموع (rank=0): أعلى 8 وحدها تُخفي تسرّباً موزّعاً على خمسين عملية
# صغيرة — وهو شكل التسرّب الذي يصعب رصده.
TOTAL_RSS_MB="$(ps -eo rss= --no-headers 2>/dev/null | awk '{s+=$1} END{printf "%.1f", s/1024}')"
PROC_COUNT="$(ps -eo pid= --no-headers 2>/dev/null | wc -l)"
printf '%s,%d,%d,%d,%d,%d,0,%s,0,0,0,__total__,%s processes\n' \
  "$TS" "$AVAIL_MB" "$SWAP_USED_MB" "$SHMEM_MB" "${TMP_MB:-0}" "${SHM_MB:-0}" \
  "${TOTAL_RSS_MB:-0}" "$PROC_COUNT" >>"$CSV"

# ضغط حقيقي → لقطة كاملة تُسمّي كل شيء
if [ "$AVAIL_MB" -gt 0 ] && [ "$AVAIL_MB" -lt "$PRESSURE_MB" ]; then
  SNAP="$OUT_DIR/pressure-$(date +%Y%m%dT%H%M%S).txt"
  {
    echo "== $TS  MemAvailable=${AVAIL_MB}MB  SwapUsed=${SWAP_USED_MB}MB  (عتبة ${PRESSURE_MB}MB) =="
    free -m
    echo; echo "== كل العمليات فوق 100MB =="
    ps -eo rss,pid,ppid,etimes,user,comm,args --sort=-rss | awk 'NR==1 || $1>102400'
    echo; echo "== ما يشغل المسارات التي تعيش في الذاكرة =="
    du -xhd1 /tmp /dev/shm 2>/dev/null | sort -h | tail -12
    echo; echo "== أعلى 10 بذاكرة مشتركة (RssShmem) — يفصل memfd عن ملفات tmpfs =="
    for f in /proc/[0-9]*/status; do
      awk '/^Name:/{n=$2} /^RssShmem:/{if($2>10240) printf "%8d kB  %s\n", $2, n}' "$f" 2>/dev/null
    done | sort -rn | head -10
    echo; echo "== مجموع RSS حسب الاسم =="
    ps -eo rss=,comm= | awk '{s[$2]+=$1; n[$2]++} END{for(c in s) printf "%8.0fMB x%-3d %s\n", s[c]/1024, n[c], c}' | sort -rn | head -20
  } >"$SNAP" 2>&1
fi

find "$OUT_DIR" -maxdepth 1 -name 'pressure-*.txt' -mtime "+$KEEP_DAYS" -delete 2>/dev/null
# قصّ الـCSV عند ~60 ألف سطر (~5 أيام بمعدل 8 أسطر/دقيقة)
if [ "$(wc -l <"$CSV")" -gt 60000 ]; then
  tail -n 40000 "$CSV" >"$CSV.tmp" && { head -1 "$CSV" >"$CSV.new"; cat "$CSV.tmp" >>"$CSV.new"; mv "$CSV.new" "$CSV"; rm -f "$CSV.tmp"; }
fi
exit 0
