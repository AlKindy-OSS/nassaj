#!/usr/bin/env bash
# T-2089 S0 probe runner (recording only, not shipped). Writes only under a fresh /var/tmp run dir.
# Usage: DSH_BIN=<fresh /var/tmp install>/node_modules/@deepseek-ai/dsh/lib/bin.js \
#   run-probe.sh <plugin name form: rel|abs|url> <plan variant> [port]   (NOXDG=1: Nassaj's exact env)
set -u
export TMPDIR=/var/tmp
S=$(cd "$(dirname "$0")" && pwd)
DSH=${DSH_BIN:?set DSH_BIN}
REPO=$(git -C "$S" rev-parse --show-toplevel)
export PROBE_DIR=$S
NV=$1; PV=$2; PORT=${3:-47811}
if [ "${NOXDG:-0}" = 1 ]; then EXTRA=; else EXTRA="XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus"; fi
R=$(mktemp -d /var/tmp/t2089-run-XXXXXX); echo "RUN=$R"
mkdir -p $R/home/.dsh $R/home/.agents $R/home/.tmp $R/ws $R/layers/plugin $R/out
cp $S/nassaj-probe-plugin.mjs $R/layers/plugin/
case $NV in
  rel) PNAME=./plugin/nassaj-probe-plugin.mjs ;;
  abs) PNAME=$R/layers/plugin/nassaj-probe-plugin.mjs ;;
  url) PNAME=file://$R/layers/plugin/nassaj-probe-plugin.mjs ;;
esac
sed "s#https://api.deepseek.com/anthropic#http://127.0.0.1:$PORT/anthropic#" $REPO/server/governance/dsh-nassaj-layer.yml > $R/layers/probe-layer.yml
cat >> $R/layers/probe-layer.yml <<YML
- insert:
    - id: nassaj-parity-probe
      name: '$PNAME'
      config:
        marker: probe
YML
node $S/fake-llm-steps.mjs $PORT $R/out/llm.jsonl & LLM=$!
sleep 0.5
node $S/make-plan.mjs $R/ws $R/out/plan.json $PV
cd $R/ws && env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=$R/home LANG=C.UTF-8 TERM=dumb TMPDIR=$R/home/.tmp \
  DSH_HOME=$R/home/.dsh DSH_AGENTS_HOME=$R/home/.agents DEEPSEEK_API_KEY=sk-fake-t2089 DSH_TELEMETRY_DISABLED=1 \
  REC_CWD=$R/ws $EXTRA \
  timeout 150 $(command -v node) $S/acp-probe-recorder.mjs $R/out/plan.json $R/out/traffic.jsonl -- $(command -v node) $DSH \
  nassaj-acp --from-default-profile acp --patch $R/layers/probe-layer.yml
kill $LLM 2>/dev/null
echo "exit=$?"
