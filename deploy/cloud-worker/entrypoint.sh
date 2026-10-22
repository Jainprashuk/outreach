#!/usr/bin/env bash
# Writes this container's supervisord config — one worker program per platform
# in $PLATFORMS — and hands over to supervisord, which keeps every piece running.
set -euo pipefail

: "${WORKER_SECRET:?WORKER_SECRET is not set (cw writes it into /srv/cw/<user>.env)}"
: "${OUTREACH_URL:?OUTREACH_URL is not set}"
PLATFORMS="${PLATFORMS:-naukri instahyre hirist}"

LOGS="$HOME/.job-leads/logs"
mkdir -p "$LOGS"

# The workers' PID locks (and the shared chrome.lock) live on the user's volume,
# so they outlive the container. A fresh container numbers its processes from 1
# again, and an old lock can name a pid that now belongs to something else —
# the worker then reads it as "already running" and refuses to start, forever.
# Nothing has started yet, so every lock found here is stale.
rm -f "$HOME"/.job-leads/*.lock
CONF=/tmp/cw-supervisord.conf

# Each program logs to its own file under the user's volume, rotated by
# supervisord, so `cw logs <user> <platform>` survives restarts.
program() {  # program <name> <priority> <command>
  cat <<EOF

[program:$1]
command=$3
priority=$2
autorestart=true
startsecs=3
startretries=1000
stopasgroup=true
killasgroup=true
stdout_logfile=$LOGS/$1.log
stdout_logfile_maxbytes=5MB
stdout_logfile_backups=3
redirect_stderr=true
EOF
}

{
  cat <<EOF
[unix_http_server]
file=/tmp/cw-supervisor.sock

[supervisord]
nodaemon=true
logfile=$LOGS/supervisord.log
logfile_maxbytes=2MB
logfile_backups=2
pidfile=/tmp/cw-supervisord.pid

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix:///tmp/cw-supervisor.sock
EOF
  program xvfb 10 "Xvfb :99 -screen 0 1600x900x24 -nolisten tcp -ac"
  program openbox 20 "bash -c 'sleep 1; exec openbox'"
  program chrome 30 "bash -c 'sleep 2; exec /opt/jl/chrome.sh'"
  program x11vnc 40 "bash -c 'sleep 2; exec x11vnc -display :99 -localhost -forever -shared -nopw -quiet -rfbport 5900'"
  program novnc 50 "websockify --web /opt/novnc 6080 localhost:5900"
  # Restarts Chrome when the container nears its memory cap, between runs.
  program watchdog 55 "bash -c 'sleep 30; exec node /opt/jl/watchdog.js'"
  for p in $PLATFORMS; do
    case "$p" in
      naukri|instahyre|hirist) ;;
      *) echo "Skipping unknown platform \"$p\" in PLATFORMS" >&2; continue ;;
    esac
    program "worker-$p" 60 "bash -c 'sleep 8; exec env PLATFORM=$p node /app/worker/platform-worker.js'"
  done
} > "$CONF"

exec supervisord -c "$CONF"
