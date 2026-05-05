#!/usr/bin/env bash
# Remote bench control — drives the bench on the prod droplet without
# requiring an interactive SSH session. Run from a developer Mac.
#
#   ./bench/scripts/remote-bench.sh start [--limit N] [--runs N] [--rebuild]
#   ./bench/scripts/remote-bench.sh watch                # tail logs, exit when "done"
#   ./bench/scripts/remote-bench.sh status               # 1-line health check
#   ./bench/scripts/remote-bench.sh stop                 # kill the running bench
#   ./bench/scripts/remote-bench.sh results              # analyze latest + show summary
#   ./bench/scripts/remote-bench.sh pull                 # rsync results back to ./bench/results

set -euo pipefail

HOST="${BENCH_HOST:-root@209.38.42.28}"
REPO="${BENCH_REPO:-/root/NpmGuard}"
LOG="${BENCH_LOG:-/tmp/bench-run.log}"
PID_FILE="${BENCH_PID_FILE:-/tmp/bench-run.pid}"

ssh_run() { ssh -o ConnectTimeout=10 -o ServerAliveInterval=30 "$HOST" "$@"; }

cmd_status() {
  ssh_run bash -s <<EOF
set -e
PID_FILE="$PID_FILE"
LOG="$LOG"
if [ -f "\$PID_FILE" ] && ps -p "\$(cat \$PID_FILE)" > /dev/null 2>&1; then
  pid=\$(cat \$PID_FILE)
  etime=\$(ps -p "\$pid" -o etime= 2>/dev/null | tr -d ' ')
  last=\$(grep -E "^\[runner\] \[" "\$LOG" 2>/dev/null | tail -1 || echo "(no progress yet)")
  echo "[running] pid=\$pid uptime=\$etime"
  echo "  \$last"
else
  if [ -f "\$LOG" ]; then
    last=\$(tail -3 "\$LOG" | tr '\n' ' ')
    echo "[stopped] last log: \$last"
  else
    echo "[idle] no bench has run on this droplet"
  fi
fi
EOF
}

cmd_start() {
  local limit_arg="" runs_arg="--runs 1" rebuild=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --limit) limit_arg="--limit $2"; shift 2;;
      --runs) runs_arg="--runs $2"; shift 2;;
      --rebuild) rebuild=1; shift;;
      *) echo "unknown arg: $1" >&2; exit 1;;
    esac
  done

  echo "→ checking droplet state..."
  if ssh_run "[ -f $PID_FILE ] && ps -p \$(cat $PID_FILE) > /dev/null 2>&1"; then
    echo "✗ bench already running. Use 'watch' or 'stop' first."
    cmd_status
    exit 1
  fi

  if [ "$rebuild" = 1 ]; then
    echo "→ rebuilding engine on droplet..."
    ssh_run bash -s <<EOF
set -e
cd "$REPO"
git fetch origin
git reset --hard origin/main
npm install --silent
npm run -w @npmguard/shared build
bash deploy/pull-and-restart.sh
EOF
  fi

  echo "→ refreshing Datadog corpus..."
  ssh_run bash -s <<EOF
set -e
cd "$REPO"
npm run -w @npmguard/bench datadog:select 2>&1 | tail -3
npm run -w @npmguard/bench datadog:fetch 2>&1 | tail -3
npm run -w @npmguard/bench datadog:manifest 2>&1 | tail -3
EOF

  echo "→ launching bench in nohup..."
  ssh_run bash -s <<EOF
set -e
cd "$REPO"
CRE_KEY=\$(grep '^NPMGUARD_CRE_API_KEY=' engine/.env | cut -d= -f2)
nohup npm run -w @npmguard/bench run -- \\
  --api http://localhost:8000 \\
  --api-key "\$CRE_KEY" \\
  $runs_arg $limit_arg \\
  > $LOG 2>&1 &
echo \$! > $PID_FILE
sleep 2
ps -p \$(cat $PID_FILE) > /dev/null && echo "[ok] pid=\$(cat $PID_FILE)" || { echo "[fail] bench died immediately"; tail -20 $LOG; exit 1; }
EOF

  echo "✓ bench started"
  echo ""
  echo "  watch:  $0 watch"
  echo "  status: $0 status"
  echo "  stop:   $0 stop"
}

cmd_watch() {
  if ! ssh_run "[ -f $PID_FILE ]"; then
    echo "✗ no bench has been started"; exit 1;
  fi
  echo "→ tailing $LOG (Ctrl-C to detach; bench continues running)"
  echo ""
  ssh_run "tail -f $LOG" | awk '
    { print; fflush() }
    /\[runner\] done — / { exit 0 }
    /\[runner\].*ERROR.*HTTP 4(0[12])/ { exit 0 }
  '
}

cmd_stop() {
  ssh_run bash -s <<EOF
set -e
if [ -f "$PID_FILE" ]; then
  pid=\$(cat "$PID_FILE")
  if ps -p "\$pid" > /dev/null 2>&1; then
    kill "\$pid" 2>/dev/null || true
    pkill -P "\$pid" 2>/dev/null || true
    sleep 1
    pkill -f audit-all.ts 2>/dev/null || true
    echo "[stopped] killed pid=\$pid + children"
  else
    echo "[noop] pid \$pid not running"
  fi
  rm -f "$PID_FILE"
else
  echo "[noop] no pid file"
fi
EOF
}

cmd_results() {
  ssh_run bash -s <<EOF
set -e
cd "$REPO"
RESULTS=\$(ls -t bench/results/*.json 2>/dev/null | head -1)
if [ -z "\$RESULTS" ]; then
  echo "no results yet"
  exit 1
fi
echo "=== latest: \$(basename \$RESULTS) ==="
npm run -w @npmguard/bench analyze -- --results "\$RESULTS" 2>&1 | tail -30
SUMMARY="\${RESULTS%.json}-summary.md"
[ -f "\$SUMMARY" ] && { echo ""; echo "=== summary ==="; cat "\$SUMMARY"; }
EOF
}

cmd_pull() {
  local local_dir="./bench/results"
  mkdir -p "$local_dir"
  echo "→ syncing $HOST:$REPO/bench/results/ → $local_dir/"
  rsync -av --delete-after "$HOST:$REPO/bench/results/" "$local_dir/"
  echo "✓ pulled"
}

case "${1:-}" in
  start)   shift; cmd_start "$@" ;;
  watch)   cmd_watch ;;
  status)  cmd_status ;;
  stop)    cmd_stop ;;
  results) cmd_results ;;
  pull)    cmd_pull ;;
  *)
    echo "Usage: $0 {start|watch|status|stop|results|pull}"
    echo ""
    echo "  start [--limit N] [--runs N] [--rebuild]"
    echo "  watch                  # follow log, exit when done"
    echo "  status                 # is it running? where is it?"
    echo "  stop                   # kill running bench"
    echo "  results                # analyze latest + show summary"
    echo "  pull                   # rsync results back to local repo"
    echo ""
    echo "Env: BENCH_HOST=$HOST BENCH_REPO=$REPO"
    exit 1
    ;;
esac
