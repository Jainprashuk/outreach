# One user's job-platform workers, with the real Chrome they drive and a screen
# that user can see from a browser. Built and run by deploy/cloud-worker/cw.
#
#   Xvfb :99 → openbox → Google Chrome (CDP 9222, container loopback only)
#   x11vnc → websockify/noVNC :6080   (published to the host's 127.0.0.1 only)
#   node worker/platform-worker.js × $PLATFORMS
#
# Build from the repo root (the .dockerignore next to this file keeps the
# context to the worker and the three lib files it requires):
#   docker build -f deploy/cloud-worker/Dockerfile -t outreach-cw .
#
# Debian rather than Ubuntu on purpose: Ubuntu's chromium is a snap, which does
# not run in a container, while Debian's is a real package — the fallback if
# Google has no Chrome build for this architecture.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Kolkata \
    LANG=en_IN.UTF-8 \
    LC_ALL=en_IN.UTF-8 \
    DISPLAY=:99 \
    HOME=/home/worker \
    JL_REPO=/opt/jl \
    CDP_PORT=9222

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg locales tzdata procps \
      xvfb openbox x11vnc novnc websockify supervisor tini \
      fonts-noto-core fonts-noto-color-emoji fonts-liberation fonts-dejavu-core \
 && sed -i 's/^# *en_IN UTF-8/en_IN UTF-8/; s/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen \
 && locale-gen \
 && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone \
 && rm -rf /var/lib/apt/lists/*

# The real Google Chrome where Google ships one for this architecture (amd64
# always; arm64 since 2026), otherwise Debian's chromium. Chrome's sandbox needs
# clone/unshare/setns for its namespaces, which Docker's default seccomp profile
# refuses — cw runs the container with chrome-seccomp.json (Docker's default
# plus those three) so the sandbox stays ON. Never --no-sandbox.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg; \
    echo "deb [arch=${arch} signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list; \
    apt-get update; \
    if apt-get install -y --no-install-recommends google-chrome-stable; then \
      ln -sf /usr/bin/google-chrome-stable /usr/local/bin/cw-browser; \
    else \
      rm -f /etc/apt/sources.list.d/google-chrome.list; apt-get update; \
      apt-get install -y --no-install-recommends chromium; \
      ln -sf /usr/bin/chromium /usr/local/bin/cw-browser; \
    fi; \
    rm -rf /var/lib/apt/lists/*; \
    cw-browser --version

# Only what the workers load: the worker tree, the three lib files it requires,
# and its two npm dependencies (versions pinned to the repo's lockfile).
WORKDIR /app
RUN printf '{"name":"outreach-cloud-worker","private":true}\n' > package.json \
 && npm install --omit=dev --no-audit --no-fund dotenv@16.6.1 playwright-core@1.63.0 \
 && npm cache clean --force
COPY worker/ /app/worker/
COPY lib/platforms.js lib/naukriFilters.js lib/naukriAnswers.js /app/lib/

# noVNC: the screen link lands straight in the viewer, connected and scaled.
RUN cp -r /usr/share/novnc /opt/novnc
COPY deploy/cloud-worker/novnc-index.html /opt/novnc/index.html

COPY deploy/cloud-worker/chrome.sh deploy/cloud-worker/chrome-debug.sh deploy/cloud-worker/entrypoint.sh \
     deploy/cloud-worker/watchdog.js deploy/cloud-worker/start.html /opt/jl/
RUN chmod 755 /opt/jl/*.sh

# uid 1000 so the host volume (/srv/cw/<user>) can be chowned predictably.
# (The npm install above ran with HOME=/home/worker, so the directory exists and
# is root's; hand it over. On the VM the user's volume is mounted over it.)
RUN userdel -r node 2>/dev/null || true; \
    useradd --uid 1000 --home-dir /home/worker --shell /bin/bash worker; \
    rm -rf /home/worker/.npm /home/worker/.local; \
    chown -R worker:worker /home/worker

USER worker
EXPOSE 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/jl/entrypoint.sh"]
