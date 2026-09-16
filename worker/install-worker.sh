#!/usr/bin/env bash
# Install the LinkedIn scrape worker as a launchd agent so it starts at login
# and the portal's Scrape button always has something listening.
#
# Running it by hand (`npm run scrape-worker`) is equivalent and easier to
# watch; this is only for when you'd rather not think about it. Uninstall with
#   launchctl bootout gui/$UID/com.prashuk.scrape-worker
set -euo pipefail

LABEL="com.prashuk.scrape-worker"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/.job-leads"

# launchd agents do NOT inherit your shell profile, so every value the worker
# needs has to be written into the plist. Forgetting this is the single most
# common reason one of these silently does nothing.
[ -f "$REPO/.env" ] && set -a && . "$REPO/.env" && set +a

: "${WORKER_SECRET:?WORKER_SECRET is not set. Add it to $REPO/.env (and to the Vercel env) first.}"
OUTREACH_URL="${OUTREACH_URL:-${VERCEL_APP_URL:-http://localhost:3000}}"
JL_REPO="${JL_REPO:-$HOME/Desktop/linkdin-post}"
NODE_BIN="$(command -v node)"

[ -x "$NODE_BIN" ] || { echo "node not found on PATH" >&2; exit 1; }
[ -d "$JL_REPO" ]  || { echo "Scraper repo not found at $JL_REPO" >&2; exit 1; }

mkdir -p "$LOGDIR" "$HOME/Library/LaunchAgents"

# caffeinate -s holds the Mac awake while plugged in, so the worker keeps
# polling and a queued scrape starts immediately instead of at the next wake.
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-s</string>
    <string>$NODE_BIN</string>
    <string>$REPO/worker/scrape-worker.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OUTREACH_URL</key><string>$OUTREACH_URL</string>
    <key>WORKER_SECRET</key><string>$WORKER_SECRET</string>
    <key>JL_REPO</key><string>$JL_REPO</string>
  </dict>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/worker.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/worker.log</string>
</dict>
</plist>
PLIST_EOF

chmod 600 "$PLIST"   # it contains WORKER_SECRET

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL"

echo "Installed $LABEL"
echo "  portal : $OUTREACH_URL"
echo "  scraper: $JL_REPO"
echo "  log    : $LOGDIR/worker.log"
echo
echo "Follow it with:  tail -f $LOGDIR/worker.log"
echo "Uninstall with:  launchctl bootout gui/$UID/$LABEL"
echo

# ── optional: a scheduled wake, so a run queued while the Mac slept still fires
cat <<'NOTE'
If you use the portal's scrape SCHEDULE, the Mac has to be awake at that time.
A scheduled wake a few minutes earlier covers it, e.g. for a 09:30 schedule:

    sudo pmset repeat wakeorpoweron MTWRFSU 09:25:00
    pmset -g sched          # confirm

Two things worth knowing, because both fail silently:
  * The LID MUST BE OPEN. A scheduled wake with the lid shut is a "dark wake" —
    the system comes up but nothing renders, so the harvest scrolls a blank page
    and returns zero. Screen off and locked is fine; lid shut is not.
  * wakeorpoweron wakes from SLEEP, not from a full shutdown.
NOTE
