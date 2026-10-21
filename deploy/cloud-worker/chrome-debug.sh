#!/usr/bin/env bash
# Stand-in for the scraper repo's chrome-debug.sh. worker/platform-worker.js
# runs "$JL_REPO/chrome-debug.sh" when nothing answers on the CDP port; here
# supervisord owns Chrome, so this asks it to (re)start Chrome and waits for the
# port instead of launching a second browser.
set -uo pipefail
PORT="${CDP_PORT:-9222}"
up() { curl -s --max-time 1 "http://127.0.0.1:$PORT/json/version" >/dev/null; }

up && { echo "Chrome is already listening on $PORT."; exit 0; }
supervisorctl -c /tmp/cw-supervisord.conf start chrome >/dev/null 2>&1 \
  || supervisorctl -c /tmp/cw-supervisord.conf restart chrome >/dev/null 2>&1 || true
for _ in $(seq 1 40); do up && { echo "Chrome is listening on $PORT."; exit 0; }; sleep 0.5; done
echo "Chrome did not open port $PORT." >&2
exit 1
