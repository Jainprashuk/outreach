#!/usr/bin/env bash
# Start everything the Mac side needs, in one terminal:
#   1. the debug Chrome on the CDP port (only if it isn't already listening)
#   2. the LinkedIn scrape worker
#   3. the Naukri worker
#
# Each worker holds sleep off for its own lifetime (worker/power.js: caffeinate
# on macOS, systemd-inhibit on Linux), so nothing here needs to. Output is prefixed [linkedin] / [naukri]. Ctrl+C stops both; Chrome stays open.
#
#   npm run workers        (or: worker/start-all.sh)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$REPO/.env" ] && set -a && . "$REPO/.env" && set +a

JL_REPO="${JL_REPO:-$HOME/Desktop/linkdin-post}"
CDP_PORT="${CDP_PORT:-9222}"

[ -n "${WORKER_SECRET:-}" ] || { echo "WORKER_SECRET is not set in $REPO/.env" >&2; exit 1; }
command -v node >/dev/null   || { echo "node not found on PATH" >&2; exit 1; }

# The launchd agent from install-worker.sh would already hold the scrape
# worker's PID lock, and ours would exit straight away. Say so up front.
if [ "$(uname -s)" = Darwin ] && launchctl print "gui/$UID/com.prashuk.scrape-worker" >/dev/null 2>&1; then
  echo "Note: the launchd scrape worker (com.prashuk.scrape-worker) is installed and"
  echo "      owns the LinkedIn worker. Only the Naukri worker will start here."
  echo "      To run both from this script instead:"
  echo "        launchctl bootout gui/$UID/com.prashuk.scrape-worker"
  echo
fi
# Same for the systemd unit install-worker.sh writes on Linux.
if [ "$(uname -s)" = Linux ] && systemctl --user is-active --quiet outreach-scrape-worker 2>/dev/null; then
  echo "Note: the systemd scrape worker (outreach-scrape-worker) is running and owns"
  echo "      the LinkedIn worker. Only the Naukri worker will start here."
  echo "      To run both from this script instead:"
  echo "        systemctl --user stop outreach-scrape-worker"
  echo
fi

# ── 1. Chrome ────────────────────────────────────────────────────────────────
if curl -s --max-time 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null; then
  echo "Chrome already listening on $CDP_PORT."
else
  echo "Opening debug Chrome…"
  bash "$JL_REPO/chrome-debug.sh" || { echo "Could not start Chrome on $CDP_PORT." >&2; exit 1; }
fi
echo "Keep the Chrome window open and visible (lid open, not minimised) — otherwise it harvests nothing."
echo

# ── 2 & 3. Workers ──────────────────────────────────────────────────────────
PIDS=()

start() {  # start <label> <script>
  local label="$1" script="$2"
  # Process substitution keeps $! pointing at node itself, not the log pipe.
  node "$REPO/worker/$script" \
    > >(while IFS= read -r line; do printf '[%s] %s\n' "$label" "$line"; done) 2>&1 &
  PIDS+=("$!")
}

cleanup() {
  trap - INT TERM EXIT
  echo
  echo "Stopping workers…"
  # SIGTERM lets each worker run its own shutdown (lock release, graceful jl kill).
  kill -TERM ${PIDS[@]+"${PIDS[@]}"} 2>/dev/null
  wait 2>/dev/null
  echo "Stopped. Chrome is still open."
}
trap cleanup INT TERM EXIT

start linkedin scrape-worker.js
start naukri   naukri-worker.js

echo "Both workers running. Ctrl+C to stop."
wait "${PIDS[@]}"
