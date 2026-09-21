#!/usr/bin/env bash
# pm2-reconcile-single-daemon.sh
# ─────────────────────────────────────────────────────────────────────────────
# Purpose: reconcile the duplicated PM2 God Daemons on the configured PM2_HOME
#   down to exactly ONE daemon, owned by the systemd unit pm2-nassaj.service,
#   resurrecting the configured apps from dump.pm2.
#
# THE PROBLEM:
#   - REAL daemon runs the configured apps (nassaj-dev plus any foreign apps
#     named in NASSAJ_PM2_FOREIGN_APPS) + one pm2-logrotate, and owns their ports.
#   - STRAY daemon (spawned by an out-of-band SSH session) runs ONLY
#     pm2-logrotate but has hijacked pm2.pid / rpc.sock /
#     pub.sock, so every `pm2` CLI now talks to the WRONG daemon.
#   - A THIRD daemon uses a DIFFERENT PM2_HOME
#     (an isolated lab PM2_HOME under the project .artifacts) — it is
#     the isolated update-lab supervisor and is UNRELATED to this problem.
#     This script only reports it, read-only, and never signals it.
#
# WHY WE DO NOT `pm2 save`:
#   Because the stray daemon owns the sockets, `pm2 save`/`pm2 jlist`/`pm2 kill`
#   all talk to the STRAY (which knows only pm2-logrotate). A `pm2 save` here
#   would OVERWRITE dump.pm2 with a single logrotate entry and DESTROY the app
#   definition. dump.pm2 was already saved by the REAL daemon and
#   contains all configured apps, so it is the golden resurrect source. We back it up and
#   preserve it; the systemd unit's `pm2 resurrect` replays it into one daemon.
#
# USAGE:
#   Read-only preview (safe, run this first):
#       bash scripts/ops/pm2-reconcile-single-daemon.sh --dry-run
#   Live reconcile (owner, from an SSH terminal — NOT the nassaj web UI, because
#   this restarts nassaj-dev and kills sessions the UI spawned):
#       bash scripts/ops/pm2-reconcile-single-daemon.sh --exec --confirm
#
# Live steps (systemctl/kill/rm) require BOTH --exec and --confirm and are
# owner-only; the nassaj client guard blocks them for agents by design.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PM2_HOME_REAL="${PM2_HOME:-$HOME/.pm2}"
DUMP="${PM2_HOME_REAL}/dump.pm2"
PM2_PID_FILE="${PM2_HOME_REAL}/pm2.pid"
RPC_SOCK="${PM2_HOME_REAL}/rpc.sock"
PUB_SOCK="${PM2_HOME_REAL}/pub.sock"
UNIT="pm2-nassaj.service"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3004/health}"
EXPECTED_APPS=(nassaj-dev ${NASSAJ_PM2_FOREIGN_APPS:-})
EXPECTED_PORTS=(${NASSAJ_PM2_HEALTH_PORT:-3004} ${NASSAJ_PM2_FOREIGN_PORTS:-})   # nassaj-dev health port + configured foreign app ports
GRACE_SECS="${GRACE_SECS:-45}"         # graceful wait after SIGINT before escalation

MODE="none"; CONFIRM=0
for a in "$@"; do
  case "$a" in
    --dry-run) MODE="dry" ;;
    --exec)    MODE="exec" ;;
    --confirm) CONFIRM=1 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done
[ "$MODE" = "none" ] && { echo "specify --dry-run or --exec [--confirm]" >&2; exit 2; }

C_R=$'\e[31m'; C_G=$'\e[32m'; C_Y=$'\e[33m'; C_B=$'\e[36m'; C_0=$'\e[0m'
say(){ printf '%s\n' "$*"; }
hdr(){ printf '\n%s== %s ==%s\n' "$C_B" "$*" "$C_0"; }
ok(){  printf '%s[ OK ]%s %s\n' "$C_G" "$C_0" "$*"; }
warn(){ printf '%s[WARN]%s %s\n' "$C_Y" "$C_0" "$*"; }
err(){ printf '%s[FAIL]%s %s\n' "$C_R" "$C_0" "$*"; }
die(){ err "$*"; exit 1; }

# ── process identity helpers (read-only, /proc based) ────────────────────────
proc_cmdline(){ tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null || true; }
proc_pm2home(){ tr '\0' '\n' < "/proc/$1/environ" 2>/dev/null | sed -n 's/^PM2_HOME=//p'; }
proc_starttime(){ local s; s=$(cat "/proc/$1/stat" 2>/dev/null) || return 1; s=${s#*) }; awk '{print $20}' <<<"$s"; }
proc_lstart(){ ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//'; }
is_god(){ proc_cmdline "$1" | grep -q 'God Daemon'; }
alive(){ kill -0 "$1" 2>/dev/null; }

# Discover all God Daemons and classify them.
discover(){
  REAL_PID=""; STRAY_PIDS=(); THIRD_PIDS=()
  local pid
  for pid in $(pgrep -f 'God Daemon' 2>/dev/null || true); do
    is_god "$pid" || continue
    local home; home="$(proc_pm2home "$pid")"
    if [ "$home" = "$PM2_HOME_REAL" ]; then
      # distinguish real vs stray by whether a child runs the nassaj-dev server
      if pgrep -P "$pid" -a 2>/dev/null | grep -q 'dist-server/server/index.js'; then
        REAL_PID="$pid"
      else
        STRAY_PIDS+=("$pid")
      fi
    else
      THIRD_PIDS+=("$pid")
    fi
  done
}

# ── STAGE 1: preflight (read-only) ───────────────────────────────────────────
discover
hdr "STAGE 1 — Preflight (read-only)"
say "Mode: ${MODE}$([ $CONFIRM = 1 ] && echo ' +confirm')"

[ -n "$REAL_PID" ]  || die "could not identify the REAL daemon (child running nassaj-dev). Aborting — nothing changed."
[ "${#STRAY_PIDS[@]}" -gt 0 ] || warn "no STRAY daemon found on ${PM2_HOME_REAL} (already clean?)."

say ""
say "REAL  daemon : pid=${REAL_PID}  start=$(proc_lstart "$REAL_PID")  starttime_ticks=$(proc_starttime "$REAL_PID")"
for sp in "${STRAY_PIDS[@]}"; do say "STRAY daemon : pid=${sp}  start=$(proc_lstart "$sp")  starttime_ticks=$(proc_starttime "$sp")"; done
if [ "${#THIRD_PIDS[@]}" -gt 0 ]; then
  for p in "${THIRD_PIDS[@]}"; do
    say "THIRD daemon : pid=${p}  PM2_HOME=$(proc_pm2home "$p")  (UNRELATED — left untouched)"
  done
fi

say ""
say "pm2.pid file currently points to : $(cat "$PM2_PID_FILE" 2>/dev/null || echo '(missing)')"
_pp="$(cat "$PM2_PID_FILE" 2>/dev/null || true)"
if [ -n "$_pp" ] && [ "$_pp" != "$REAL_PID" ]; then
  warn "pm2.pid ($_pp) does NOT point to the real daemon (${REAL_PID}) — confirms the hijack."
fi
ls -la "$RPC_SOCK" "$PUB_SOCK" "$PM2_PID_FILE" 2>/dev/null || true

hdr "STAGE 1 — Configured apps (children of REAL daemon ${REAL_PID}) + ports"
pgrep -P "$REAL_PID" -a 2>/dev/null || true
say ""
say "Listening ports (expected on the real apps):"
ss -ltnp 2>/dev/null | grep -E ":($(IFS='|'; echo "${EXPECTED_PORTS[*]}"))\b" || warn "no expected ports listening"

hdr "STAGE 1 — dump.pm2 (golden resurrect source)"
if [ -r "$DUMP" ]; then
  say "path : $DUMP"
  ls -la "$DUMP"
  DUMP_COUNT=$(node -e 'const fs=require("fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(d.length);process.stdout.write("");for(const a of d)process.stderr.write("  - "+a.name+"\n")' "$DUMP" 2>/tmp/.dumpnames || echo 0)
  cat /tmp/.dumpnames 2>/dev/null; rm -f /tmp/.dumpnames
  if [ "$DUMP_COUNT" = "${#EXPECTED_APPS[@]}" ]; then ok "dump.pm2 holds ${DUMP_COUNT} app definitions."; else
    die "dump.pm2 holds ${DUMP_COUNT} apps, expected ${#EXPECTED_APPS[@]} — refusing to proceed. Investigate before any reconcile."
  fi
else
  die "dump.pm2 not readable at $DUMP — cannot guarantee resurrect. Aborting."
fi

hdr "STAGE 1 — Active sessions (from /health, read-only)"
if command -v curl >/dev/null 2>&1; then
  body="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null || true)"
  if [ -n "$body" ]; then
    node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{try{const j=JSON.parse(b);const a=j.activeSessions||{};const t=Object.entries(a).filter(([,v])=>v>0);console.log("  runtimeVersion:",j.runtimeVersion,"| degraded:",j.degraded);if(t.length){console.log("  ACTIVE SESSIONS (will be lost on nassaj-dev restart):");for(const[k,v]of t)console.log("    "+k+": "+v)}else console.log("  no active provider sessions")}catch(e){console.log("  (health parse failed)")}})' <<<"$body"
    warn "Reconcile restarts nassaj-dev: any active sessions above will be terminated."
  else
    warn "/health did not respond — cannot show active sessions (server may be busy)."
  fi
else
  warn "curl not available — skipping session visibility."
fi

hdr "STAGE 1 — Systemd unit"
say "unit file : /etc/systemd/system/${UNIT} (SYSTEM unit — needs sudo, NOT --user)"
say "enabled   : $(systemctl is-enabled "$UNIT" 2>&1)"
say "active    : $(systemctl is-active "$UNIT" 2>&1)"
say "ExecStart : pm2 resurrect   (replays dump.pm2 into one daemon)"

# ── DRY-RUN stops here ───────────────────────────────────────────────────────
if [ "$MODE" = "dry" ]; then
  hdr "DRY-RUN — planned live steps (NOT executed)"
  cat <<PLAN
  1. kill every STRAY daemon on ${PM2_HOME_REAL} (${STRAY_PIDS[*]:-<none>}) + their logrotate children
  2. graceful drain: SIGINT nassaj-dev app child, then SIGINT REAL daemon ${REAL_PID}, wait ${GRACE_SECS}s, escalate
  3. reap by PORT: any pid still on ${EXPECTED_PORTS[*]} → TERM then KILL (frees ports before resurrect)
  4. rm stale ${RPC_SOCK}, ${PUB_SOCK}, ${PM2_PID_FILE}
  5. sudo systemctl start ${UNIT}   (pm2 resurrect → one daemon, all configured apps)
  6. verify: one God Daemon, pm2.pid matches, all configured apps online, 1 logrotate, ports up, /health 200
  NOTE: no 'pm2 save' — it would hit the hijacked stray socket and clobber dump.pm2.
PLAN
  hdr "RESULT"; ok "Dry-run complete. No changes made."
  say "To reconcile (owner, from SSH): bash scripts/ops/pm2-reconcile-single-daemon.sh --exec --confirm"
  exit 0
fi

# ── EXEC path — require explicit confirmation ────────────────────────────────
[ "$CONFIRM" = 1 ] || die "--exec requires --confirm (re-read the preflight above first)."
sudo -v || die "sudo authentication required (stage 5 runs 'sudo systemctl start ${UNIT}') — aborting before any change."

# Reap any process still listening on a port (TERM, then KILL). Prints what it kills.
reap_port(){ # port
  local port="$1" p
  for p in $(ss -ltnpH "( sport = :$port )" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
    say "  reaping pid=$p holding :$port ($(proc_cmdline "$p" | cut -c1-50))"
    kill -TERM "$p" 2>/dev/null || true; sleep 1
    alive "$p" && kill -9 "$p" 2>/dev/null || true
  done
}

# Immediate pre-signal identity re-check to avoid PID reuse.
recheck(){ # pid expected_starttime label
  local pid="$1" want="$2" label="$3" got
  alive "$pid" || { warn "$label pid $pid already gone — skipping."; return 1; }
  is_god "$pid" || die "$label pid $pid is no longer a God Daemon — ABORT (pid reuse?)."
  got="$(proc_starttime "$pid")"
  [ "$got" = "$want" ] || die "$label pid $pid starttime changed ($got != $want) — ABORT (pid reuse?)."
  return 0
}

BACKUP_DIR="/var/tmp/pm2-reconcile-$(date +%Y%m%d-%H%M%S)"

hdr "STAGE 2 — Backup → ${BACKUP_DIR}"
mkdir -p "$BACKUP_DIR"
cp -a "$DUMP" "$BACKUP_DIR/dump.pm2.bak"
# Forensic jlist (reflects whichever daemon owns the socket — recorded as-is).
PM2_HOME="$PM2_HOME_REAL" pm2 jlist > "$BACKUP_DIR/pm2-jlist-socket-owner.json" 2>/dev/null || true
ps -eo pid,ppid,lstart,etime,args | grep -E 'God Daemon|pm2-logrotate' | grep -v grep > "$BACKUP_DIR/daemons.txt" || true
pgrep -P "$REAL_PID" -a > "$BACKUP_DIR/real-daemon-children.txt" 2>/dev/null || true
ls -la "$PM2_HOME_REAL" > "$BACKUP_DIR/pm2-home-ls.txt" 2>/dev/null || true
ok "Backup written (dump.pm2.bak is the golden app definition)."

REAL_ST="$(proc_starttime "$REAL_PID")"

hdr "STAGE 3 — Kill every STRAY daemon on ${PM2_HOME_REAL} (${STRAY_PIDS[*]:-<none>})"
# Re-discover right before signaling: a transient extra daemon may have appeared.
discover
if [ "${#STRAY_PIDS[@]}" = 0 ]; then
  ok "no stray daemon to kill."
else
  for sp in "${STRAY_PIDS[@]}"; do
    st="$(proc_starttime "$sp")"
    recheck "$sp" "$st" "STRAY" || continue
    for child in $(pgrep -P "$sp" 2>/dev/null || true); do
      say "  killing stray child pid=$child ($(proc_cmdline "$child" | cut -c1-60))"; kill "$child" 2>/dev/null || true
    done
    say "  SIGINT stray daemon $sp"; kill -INT "$sp" 2>/dev/null || true
    for _ in $(seq 1 10); do alive "$sp" || break; sleep 1; done
    if alive "$sp"; then say "  escalating SIGKILL to stray $sp"; kill -9 "$sp" 2>/dev/null || true; sleep 1; fi
    alive "$sp" && die "stray daemon $sp survived — ABORT." || ok "stray daemon $sp gone."
  done
fi

hdr "STAGE 4a — Stop REAL daemon ${REAL_PID} (graceful)"
recheck "$REAL_PID" "$REAL_ST" "REAL" || die "REAL daemon vanished before stop — ABORT, inspect manually."
# Graceful drain of nassaj-dev first: SIGINT its app child so shutdown-drain closes
# the listener immediately (frees :3004) and closes WS clients with 1001.
NASSAJ_CHILD="$(pgrep -P "$REAL_PID" -f 'dist-server/server/index.js' 2>/dev/null | head -n1 || true)"
if [ -n "$NASSAJ_CHILD" ]; then say "  SIGINT nassaj-dev app child $NASSAJ_CHILD (graceful drain)"; kill -INT "$NASSAJ_CHILD" 2>/dev/null || true; fi
say "  SIGINT real daemon $REAL_PID"
kill -INT "$REAL_PID" 2>/dev/null || true
for _ in $(seq 1 "$GRACE_SECS"); do alive "$REAL_PID" || break; sleep 1; done
if alive "$REAL_PID"; then
  warn "real daemon still up after ${GRACE_SECS}s (drain). Escalating."
  kill -TERM "$REAL_PID" 2>/dev/null || true; sleep 3
  alive "$REAL_PID" && { kill -9 "$REAL_PID" 2>/dev/null || true; sleep 1; }
fi
alive "$REAL_PID" && die "real daemon $REAL_PID survived — ABORT." || ok "real daemon gone."

# The God daemon only treekills its apps over the RPC 'kill' path; signaling the
# daemon directly (as above) leaves the apps orphaned. Reap them UNCONDITIONALLY
# by port so resurrect does not hit EADDRINUSE — regex on app names is unreliable
# (e.g. a foreign app may hold its port under a renamed process title).
say "  reaping any process still holding the expected ports..."
for port in "${EXPECTED_PORTS[@]}"; do reap_port "$port"; done
# Also reap any surviving pm2-logrotate children of the daemons we just killed.
for p in $(pgrep -f 'pm2-logrotate' 2>/dev/null || true); do
  ppid="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
  [ "$ppid" = 1 ] && { say "  reaping orphaned pm2-logrotate pid=$p"; kill -9 "$p" 2>/dev/null || true; }
done

# Ports MUST be free before resurrect, or the new apps hit EADDRINUSE. Hard FAIL.
say "  confirming expected ports are free..."
for _ in $(seq 1 15); do
  busy=0
  for port in "${EXPECTED_PORTS[@]}"; do ss -ltn "( sport = :$port )" 2>/dev/null | grep -q LISTEN && busy=1; done
  [ "$busy" = 0 ] && break; sleep 1
done
if [ "$busy" != 0 ]; then
  err "expected ports still listening after reap — NOT starting ${UNIT} (would EADDRINUSE)."
  say "  Inspect and clear, then start manually:"
  say "    ss -ltnp | grep -E ':($(IFS='|'; echo "${EXPECTED_PORTS[*]}"))' ; kill -9 <pid>"
  say "    sudo systemctl start ${UNIT}"
  say "  Golden dump backup: ${BACKUP_DIR}/dump.pm2.bak"
  exit 1
fi
ok "expected ports free."

hdr "STAGE 4b — Clean stale socket/pid, hand ownership to systemd"
rm -f "$RPC_SOCK" "$PUB_SOCK" "$PM2_PID_FILE"
ok "removed stale rpc.sock / pub.sock / pm2.pid (they belonged to the dead stray)."
say "  starting ${UNIT} (system unit — uses sudo)"
sudo systemctl start "$UNIT"
say "  waiting for daemon + apps to come up..."
for _ in $(seq 1 30); do
  [ -S "$RPC_SOCK" ] && [ -f "$PM2_PID_FILE" ] && break; sleep 1
done

# ── STAGE 5 — verify ─────────────────────────────────────────────────────────
hdr "STAGE 5 — Verify"
FAIL=0
discover
GODS=$(pgrep -f 'God Daemon' 2>/dev/null | while read -r p; do [ "$(proc_pm2home "$p")" = "$PM2_HOME_REAL" ] && echo "$p"; done | wc -l)
[ "$GODS" = 1 ] && ok "exactly one God Daemon on ${PM2_HOME_REAL}." || { err "God Daemons on ${PM2_HOME_REAL}: $GODS (expected 1)"; FAIL=1; }

NEWPID="$(cat "$PM2_PID_FILE" 2>/dev/null || echo '')"
if [ -n "$NEWPID" ] && alive "$NEWPID" && is_god "$NEWPID"; then ok "pm2.pid ($NEWPID) matches a live God Daemon."; else err "pm2.pid does not match a live daemon."; FAIL=1; fi

JL="$(PM2_HOME="$PM2_HOME_REAL" pm2 jlist 2>/dev/null || echo '[]')"
node -e '
  let b=process.argv[1];const want=process.argv.slice(2);let j=[];try{j=JSON.parse(b)}catch(e){}
  const online=j.filter(a=>a.pm2_env&&a.pm2_env.status==="online").map(a=>a.name);
  let bad=0;
  for(const w of want){const n=online.filter(x=>x===w).length;if(n===1)console.log("  [ OK ] "+w+" online x1");else{console.log("  [FAIL] "+w+" online x"+n);bad=1}}
  const lr=j.filter(a=>a.name==="pm2-logrotate"&&a.pm2_env&&a.pm2_env.status==="online").length;
  console.log((lr===1?"  [ OK ] ":"  [FAIL] ")+"pm2-logrotate online x"+lr);if(lr!==1)bad=1;
  process.exit(bad)
' "$JL" "${EXPECTED_APPS[@]}" || FAIL=1

say "  ports:"
for port in "${EXPECTED_PORTS[@]}"; do
  if ss -ltn "( sport = :$port )" 2>/dev/null | grep -q LISTEN; then ok "port $port listening"; else err "port $port NOT listening"; FAIL=1; fi
done

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null || echo 000)"
[ "$code" = 200 ] && ok "nassaj-dev /health → 200" || { err "nassaj-dev /health → $code"; FAIL=1; }

hdr "RESULT"
if [ "$FAIL" = 0 ]; then
  ok "PASS — single systemd-owned PM2 daemon, all configured apps online, ports up, health 200."
  say "Backup kept at: ${BACKUP_DIR}"
  exit 0
fi

err "FAIL — verification did not pass. ROLLBACK / RECOVERY:"
cat <<ROLL
  1. Inspect: PM2_HOME=${PM2_HOME_REAL} pm2 list ; sudo systemctl status ${UNIT}
  2. If dump.pm2 looks wrong, restore the golden backup:
       cp -a ${BACKUP_DIR}/dump.pm2.bak ${DUMP}
  3. Restart the systemd-owned daemon from that dump:
       sudo systemctl restart ${UNIT}
     (or, if the unit will not start:  PM2_HOME=${PM2_HOME_REAL} pm2 resurrect )
  4. Re-verify:  PM2_HOME=${PM2_HOME_REAL} pm2 list ; curl -sS ${HEALTH_URL}
  5. If a port is stuck (EADDRINUSE), find and kill the orphan:
       ss -ltnp | grep -E ":($(IFS='|'; echo "${EXPECTED_PORTS[*]}"))" ; kill -9 <pid> ; sudo systemctl restart ${UNIT}
ROLL
exit 1
