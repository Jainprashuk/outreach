# Cloud workers

Runs the Naukri, Instahyre and Hirist workers on a cloud VM instead of each
person's computer, one isolated container per user. LinkedIn is not included; its
worker stays on the Mac (`worker/README.md` explains why).

```
VM (Oracle A1.Flex, Ubuntu 24.04 arm64)
├─ cloudflared ─ tunnel "outreach-cw" ── the only way in from the internet
│    screen-<user>.<domain> → 127.0.0.1:600N   (Cloudflare Access: that user's email)
└─ container cw-<user>      (3 GB RAM cap, 1 CPU, restarts on its own)
     Xvfb → openbox → Google Chrome (CDP 9222, inside the container only)
     x11vnc → noVNC :6080 → host 127.0.0.1:600N
     worker/platform-worker.js × naukri instahyre hirist
     /srv/cw/<user> → /home/worker   (Chrome profile + logs)
```

Nothing in `worker/` changes for this. The container gives the workers what they
expect on a Linux desktop: a display, a real Chrome on port 9222, and
`$JL_REPO/chrome-debug.sh` (here `chrome-debug.sh`, which asks supervisord to
restart Chrome instead of launching a second one).

## Files

| File | What it is |
|---|---|
| `Dockerfile` (+ `Dockerfile.dockerignore`) | The image: Debian, Node 22, Google Chrome (Chromium fallback), Xvfb, noVNC, supervisord |
| `entrypoint.sh` | Writes the supervisord config, one worker per platform in `$PLATFORMS` |
| `chrome.sh` | The debug Chrome: real profile, no automation flags, no `--no-sandbox` |
| `chrome-debug.sh` | Stand-in for the scraper repo's launcher, called by the worker if Chrome is down |
| `novnc-index.html` | The screen link lands straight in the viewer, connected and scaled |
| `cw` | The admin tool. Everything below goes through it |

## One-time host setup

On the VM, with the repo cloned to `/opt/outreach`:

```bash
sudo ln -sf /opt/outreach/deploy/cloud-worker/cw /usr/local/bin/cw
sudo cw host-setup
```

It asks for:

- the Cloudflare API token: Account › Cloudflare Tunnel: Edit, Account › Access: Apps and Policies: Edit, Zone › DNS: Edit;
- the Account ID;
- the domain;
- your admin email (added to a screen's policy only when `cw add` uses `--allow-admin`);
- the portal URL.

Answers are kept in `/srv/cw/cloudflare.env` (mode 600). It then installs Docker
and cloudflared, creates the tunnel, adds 4 GB of swap and builds the image.

Oracle's Ubuntu image already firewalls everything except SSH (iptables plus the
VCN security list), so `cw` adds no firewall of its own. Every container port is
bound to `127.0.0.1`.

## Adding a user

1. **Portal:** Admin → their account → **Cloud worker**. Enter `https://screen-<name>.<domain>` and click **Save + issue token**, then copy the token. For your own account, click **Save link** only and use the token from your Mac's `.env`: issuing a new one would stop your Mac's LinkedIn worker.
2. **VM:** `sudo cw add <name> <their email>`, and paste the token when asked.
3. **Them:** Job Platforms → **Cloud browser** → email code → log in to the three sites → close the tab.

`cw add` creates the container, the tunnel route, the DNS record (the only
proxied one) and an Access app that lets in only their email. Admin access is
opt-in: pass `--allow-admin` to add the configured admin email to that screen.

## Everyday

| Command | Does |
|---|---|
| `sudo cw list` | Users, ports, container state, links |
| `cw stats` | Memory and CPU per user, plus free memory and disk |
| `cw logs <user> [naukri\|instahyre\|hirist\|chrome]` | Follow their logs |
| `sudo cw restart <user>` | Restart their browser and workers; logins are kept |
| `sudo cw token <user>` | Paste a new token (after "Save + issue token" again) |
| `sudo cw rm <user> [--purge]` | Remove them. `--purge` also deletes their saved logins. Then Admin → Cloud worker → Remove |
| `sudo cw update` | `git pull`, rebuild, restart users one at a time. Never runs by itself |

## Capacity

Chrome plus three workers may use up to 3 GB during a busy run. On the 12 GB VM,
plan for up to three concurrent users. Check `cw stats` before adding another.
Runs for one user take turns on their Chrome (`worker/chrome-lock.js`); different
users run side by side.

## Security notes

- A user's Chrome debug port (9222) holds their logged-in sessions. It exists only inside their container's network namespace: no other container and nothing outside can reach it.
- The screen (noVNC) has no password of its own. Cloudflare Access is the gate, and the port is reachable only from the host's loopback, where only cloudflared connects.
- Whoever has root on the VM can reach every container. Tell invited users that before you host them.
- Tokens: the portal stores only hashes. On the VM they sit in `/srv/cw/<user>.env` (root, 600).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Screen link shows a Cloudflare error / bad gateway | `sudo cw list`; if the container isn't `running`, `sudo cw restart <user>` and `cw logs <user>` |
| Portal shows the worker offline | `cw logs <user> <platform>`. "401" or "Unknown worker" means a wrong token: `sudo cw token <user>` |
| Portal shows "logged out" for a site | The user opens their link and logs in again |
| "tabs not responding" | Open the screen and close the frozen tab, or `sudo cw restart <user>` |
| Captcha → platform blocked for 7 days | Intended. Don't work around it |
| Disk filling up | `docker system prune` (keeps volumes, so logins survive) |
