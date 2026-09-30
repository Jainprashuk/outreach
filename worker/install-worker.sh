#!/usr/bin/env bash
# Install the LinkedIn scrape worker so it starts at login and the portal's
# Scrape button always has something listening:
#   macOS — a launchd agent   (uninstall: launchctl bootout gui/$UID/com.prashuk.scrape-worker)
#   Linux — a systemd user unit (uninstall: systemctl --user disable --now outreach-scrape-worker)
#
# Running it by hand (`npm run scrape-worker`) is equivalent and easier to
# watch; this is only for when you'd rather not think about it.
set -euo pipefail

LABEL="com.prashuk.scrape-worker"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/.job-leads"

# launchd agents and systemd user units do NOT inherit your shell profile, so
# every value the worker needs has to be written into the plist / unit.
# Forgetting this is the single most common reason one of these silently does
# nothing.
[ -f "$REPO/.env" ] && set -a && . "$REPO/.env" && set +a

: "${WORKER_SECRET:?WORKER_SECRET is not set. Add it to $REPO/.env (and to the Vercel env) first.}"
OUTREACH_URL="${OUTREACH_URL:-${VERCEL_APP_URL:-http://localhost:3000}}"
JL_REPO="${JL_REPO:-$HOME/Desktop/linkdin-post}"
NODE_BIN="$(command -v node)"

[ -x "$NODE_BIN" ] || { echo "node not found on PATH" >&2; exit 1; }
[ -d "$JL_REPO" ]  || { echo "Scraper repo not found at $JL_REPO" >&2; exit 1; }

case "$(uname -s)" in
Darwin) ;;
Linux)
  # ── Linux: systemd user unit ──────────────────────────────────────────────
  command -v systemctl >/dev/null || { echo "systemctl not found — start the worker by hand: npm run scrape-worker" >&2; exit 1; }
  UNIT="outreach-scrape-worker"
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT_FILE="$UNIT_DIR/$UNIT.service"
  mkdir -p "$LOGDIR" "$UNIT_DIR"

  # The worker launches the debug Chrome itself when it isn't running, and
  # Chrome needs your graphical session to draw into. Capture it now, from the
  # desktop terminal this is being run in.
  if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    echo "No DISPLAY or WAYLAND_DISPLAY — run this from a terminal inside your desktop session." >&2
    exit 1
  fi

  umask 077   # the unit contains WORKER_SECRET
  cat > "$UNIT_FILE" <<UNIT_EOF
[Unit]
Description=Outreach LinkedIn scrape worker
After=graphical-session.target network-online.target

[Service]
ExecStart=$NODE_BIN $REPO/worker/scrape-worker.js
WorkingDirectory=$REPO
Environment=OUTREACH_URL=$OUTREACH_URL
Environment=WORKER_SECRET=$WORKER_SECRET
Environment=JL_REPO=$JL_REPO
Environment=DISPLAY=${DISPLAY:-}
Environment=WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-}
Environment=XAUTHORITY=${XAUTHORITY:-}
Environment=XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-}
Restart=always
RestartSec=10
StandardOutput=append:$LOGDIR/worker.log
StandardError=append:$LOGDIR/worker.log

[Install]
WantedBy=default.target
UNIT_EOF
  chmod 600 "$UNIT_FILE"

  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT"

  echo "Installed $UNIT (systemd user unit)"
  echo "  portal : $OUTREACH_URL"
  echo "  scraper: $JL_REPO"
  echo "  log    : $LOGDIR/worker.log"
  echo
  echo "Follow it with:  tail -f $LOGDIR/worker.log"
  echo "Uninstall with:  systemctl --user disable --now $UNIT && rm $UNIT_FILE"
  echo
  cat <<'NOTE'
The worker holds sleep off with systemd-inhibit while it runs. It cannot wake a
suspended machine, so for the portal's scrape SCHEDULE either keep the machine
awake, or set an RTC wake a few minutes early (one-shot, needs root):

    sudo rtcwake -m no -t "$(date +%s -d 'tomorrow 09:25')"

Same rule as on the Mac: the Chrome window must actually be drawing. A locked
screen is fine; a minimised window, or a wake with the display off, harvests
nothing and the run is reported as failed.
NOTE
  exit 0
  ;;
*)
  echo "Unsupported OS: $(uname -s). The worker supports macOS and Linux." >&2
  exit 1
  ;;
esac

# ── macOS: launchd agent ─────────────────────────────────────────────────────
mkdir -p "$LOGDIR" "$HOME/Library/LaunchAgents"

# No caffeinate wrapper here: the worker holds `caffeinate -is -w <its pid>`
# itself (worker/power.js), so it stays awake however it was started.
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
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
