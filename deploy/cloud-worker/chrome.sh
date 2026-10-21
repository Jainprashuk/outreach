#!/usr/bin/env bash
# The debug Chrome, run in the foreground by supervisord (which restarts it if
# it exits). Same rules as chrome-debug.sh on the Mac: a real Chrome with its
# own persistent profile and no automation flags, so navigator.webdriver stays
# false. The workers attach to it over CDP; nothing here launches a
# Playwright-controlled browser.
set -euo pipefail

PROFILE="$HOME/.job-leads/chrome-profile"
mkdir -p "$PROFILE"

# A container that was killed leaves Chrome's singleton lock behind, and Chrome
# then refuses to start ("profile in use"). Nothing else runs Chrome in this
# container, so a lock found before we start is always stale.
rm -f "$PROFILE"/Singleton{Lock,Cookie,Socket}

# 9222 binds to 127.0.0.1 by default, and inside the container that loopback is
# private to this one user. The two --disable-* flags stop Chrome freezing tabs
# nobody is looking at (worker/chrome-health.js names that failure); they change
# scheduling, not the fingerprint.
exec cw-browser \
  --remote-debugging-port="${CDP_PORT:-9222}" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --password-store=basic \
  --lang=en-IN \
  --window-position=0,0 \
  --window-size=1600,900 \
  --start-maximized \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  https://www.naukri.com/ https://www.instahyre.com/ https://www.hirist.tech/
