# Cloud VM runbook

Everything about the cloud VM that runs the Naukri, Instahyre and Hirist workers:
day-to-day commands, adding and removing users, updates, and fixing problems.
How it is built is in `README.md` next to this file.

## At a glance

| What | Value |
|---|---|
| VM | Oracle Cloud, `outreach-cw`, India West (Mumbai), VM.Standard.A1.Flex |
| Size | 2 OCPU / 12 GB RAM, 45 GB disk, Ubuntu 24.04 arm64 |
| Public IP | `130.210.11.217` (ephemeral, survives reboots and resizes, not a terminate) |
| SSH | `ssh -i ~/.ssh/oracle_cw ubuntu@130.210.11.217` |
| Oracle account | `q9jainprashuk` (Pay As You Go, ₹0 within Always Free limits), budget alert `zero-spend` |
| Domain / DNS | `jainprashuk.in` on Cloudflare (nameservers `alfred` / `ariadne`), registered at Hostinger |
| Zero Trust team | `divine-wildflower-0fea` — login methods: One-time PIN, Cloudflare |
| Tunnel | `outreach-cw` (id `899b0efa-eebb-4c0e-b60b-3d6f14d9ef5b`) |
| Portal | `https://outreach.jainprashuk.in` |
| Code on the VM | `/opt/outreach`, tracks `main`, read-only deploy key `oracle-cw` |
| Per-user data | `/srv/cw/<user>/` (Chrome profile, logs), `/srv/cw/<user>.env` (token) |
| Admin tool | `cw` (`/usr/local/bin/cw` → `/opt/outreach/deploy/cloud-worker/cw`) |

**On the Mac:** only the LinkedIn worker. Naukri, Instahyre and Hirist run on the VM
and must never run on the Mac as well — the same token would claim the same runs twice.

### One-time Mac setup (optional, saves typing)

Add to `~/.ssh/config`:

```
Host cw
  HostName 130.210.11.217
  User ubuntu
  IdentityFile ~/.ssh/oracle_cw
  UseKeychain yes
  AddKeysToAgent yes
```

Then `ssh cw` logs in, and every command below can be written `ssh cw '…'`.
The key has a passphrase; after a Mac reboot, if SSH asks for it, run
`ssh-add --apple-use-keychain ~/.ssh/oracle_cw` once.

---

## Everyday commands

Run from the Mac. Read-only ones need no `sudo` (cw adds it). Anything that
changes something needs `-t` (it may prompt) and `sudo`.

| Task | Command |
|---|---|
| Who runs here, links, state | `ssh cw 'cw list'` |
| Memory / CPU / disk | `ssh cw 'cw stats'` |
| Follow a user's worker logs | `ssh cw 'cw logs prashuk'` (all platforms) |
| One platform's log | `ssh cw 'cw logs prashuk hirist'` (`naukri`, `instahyre`, `hirist`, `chrome`, `supervisord`) |
| Restart a user's browser + workers (logins kept) | `ssh -t cw 'sudo cw restart prashuk'` — waits up to 15 min for a running job to finish; add `--now` to cut it off |
| Pull latest `main`, rebuild, restart everyone | `ssh -t cw 'sudo cw update'` — same wait per user; `--now` to skip it |
| Replace a user's token | `ssh -t cw 'sudo cw token prashuk'` |
| Add a user | `ssh -t cw 'sudo cw add <name> <email>'` |
| Remove a user | `ssh -t cw 'sudo cw rm <name>'` (`--purge` also deletes their logins) |

Press `Ctrl+C` to stop following logs.

### Open your cloud browser

`https://screen-prashuk.jainprashuk.in` (or Job Platforms → **Cloud browser**).
Email code login. Use it to log in to a site again when the portal says
"logged out". Closing the tab does not stop anything.

---

## Adding a user

**Before:** they have a portal account (Admin → Invite if not), and `cw stats`
shows room — each user can take up to 3 GB; plan for up to three concurrent users
on the 12 GB VM.

1. **Tell them** their job-site logins will live on this server and that the admin
   can technically access it.
2. **Pick a name**: lowercase letters, digits or `-`, up to 20 characters, e.g. `rahul`.
   Their link becomes `https://screen-rahul.jainprashuk.in`.
3. **Portal:** Admin → their account → **Cloud worker** → enter
   `https://screen-rahul.jainprashuk.in` → **Save + issue token** → **Copy**.
   The token is shown once; keep the tab open.
4. **VM:**
   ```bash
   ssh -t cw 'sudo cw add rahul rahul@example.com'
   ```
   Paste the token (hidden). Press Enter for all three platforms, or type e.g. `naukri hirist`.
5. **Them:** Job Platforms → **Cloud browser** → email code → log in to Naukri,
   Instahyre and Hirist → close the tab. Then turn on each platform and set
   searches, schedule and apply mode (start with **Dry run**).
6. **Check:** `ssh cw 'cw list; cw stats'` — their container is `running`; within a
   minute the portal shows their workers online and logged in.

By default, only that user's email is allowed on their screen. To grant your
admin email access to a specific user's screen, add `--allow-admin` to that
user's `cw add` command. The older `--private` option remains accepted but is
no longer needed.

### Adding yourself again (or anyone who also runs LinkedIn on a Mac)

Do **not** issue a new token — that stops the Mac's LinkedIn worker. Use
**Save link** only, and paste the existing token from the Mac:
`grep '^WORKER_SECRET=' ~/Desktop/outreach/.env`.

## Removing a user

```bash
ssh -t cw 'sudo cw rm rahul'          # keeps /srv/cw/rahul (their logins)
ssh -t cw 'sudo cw rm rahul --purge'  # deletes it too
```

Then Admin → their account → **Cloud worker** → **Remove** (also revokes the token).
To move them back to their own computer, they generate a new token from their
setup guide and run the worker there.

---

## Your LinkedIn worker (Mac)

Not on the VM, on purpose (`worker/README.md`). It needs the Mac awake, lid open,
and the debug Chrome window open and not minimised.

```bash
cd ~/Desktop/outreach
bash ~/Desktop/linkdin-post/chrome-debug.sh   # debug Chrome with your LinkedIn login
npm run scrape-worker                          # LinkedIn only
```

Start it at login instead (LinkedIn only — no argument):

```bash
cd ~/Desktop/outreach && bash worker/install-worker.sh
# remove: launchctl bootout gui/$UID/com.prashuk.scrape-worker
```

Wake the Mac for the 09:30 schedule: `sudo pmset repeat wakeorpoweron MTWRFSU 09:25:00`.

**Never** run `npm run workers` (it also starts Naukri, Instahyre and Hirist).
Check nothing extra runs: `ps aux | grep -E "platform-worker|start-all" | grep -v grep` → empty.

---

## Code changes and updates

The VM tracks `main`. After merging a change to worker code or anything under
`deploy/cloud-worker/`:

```bash
ssh -t cw 'sudo cw update'
```

It pulls, rebuilds the image and restarts each user one at a time (about 20 s
offline each). Logins are kept. It never runs by itself.

Server-only changes (routes, models) need nothing on the VM — Vercel deploys them.
Client changes still need `cd client && npm run build` and a committed `client/dist`.

Test the image on the Mac first if the change is risky: start Colima
(`colima start --cpu 2 --memory 4`), then
`docker build -f deploy/cloud-worker/Dockerfile -t outreach-cw .` and run it against
the dev server (`NODE_ENV=dev PORT=4099 node server.js`) with a dev account's token
and `--security-opt seccomp=deploy/cloud-worker/chrome-seccomp.json`.

---

## Oracle console tasks

**Resize CPU/RAM:** Compute → Instances → `outreach-cw` → **Edit** → Shape →
VM.Standard.A1.Flex → set OCPUs and memory → **Save changes**. Reboots (about 2 min);
everything comes back by itself. Stay at or below **2 OCPU / 12 GB** unless you need
more users: the account is pay-as-you-go, so anything above the free limit would be
billed rather than refused. The free A1 allowance currently shown is 4 OCPU / 24 GB.

**Grow the disk** (free up to 200 GB total): instance → **Storage** → boot volume →
**Edit** → size → **Save**. Then:

```bash
ssh cw 'sudo growpart /dev/sda 1; sudo resize2fs /dev/sda1; df -h /'
```

**Public IP missing** (after recreating the VM): instance → **Networking** → VNIC →
**IP administration** → private IP row **⋮ → Edit** → **Ephemeral public IP** → **Update**.
A new IP means updating `~/.ssh/config` and this file; nothing else (the tunnel is outbound).

**Cost check:** Billing & Cost Management → **Cost Analysis** should show ₹0.
The `zero-spend` budget emails at SGD 1.

---

## Cloudflare tasks

**Roll the API token** (if it leaks): My Profile → API Tokens → `outreach-cw` → **⋯ → Roll**.
Then on the VM update `CF_API_TOKEN=` in `/srv/cw/cloudflare.env`:

```bash
ssh -t cw 'sudo nano /srv/cw/cloudflare.env'
```

It is only used by `cw add` / `cw rm` / `cw host-setup`; running containers don't need it.
`ADMIN_EMAIL` is included in a screen's Access policy only when `cw add` is run
with `--allow-admin`.
Permissions: Account › Cloudflare Tunnel: Edit, Account › Access: Apps and Policies: Edit,
Zone › DNS: Edit (jainprashuk.in).

**Login methods:** Zero Trust → Integrations → Identity providers. One-time PIN must
stay on — it is how invited users sign in.

**Who can open a screen:** Zero Trust → Access controls → Applications →
"Cloud browser — <user>" → Policies (their email; yours only if `--allow-admin` was used).
Sessions last 30 days.

**DNS:** each user has one proxied CNAME `screen-<user>` → the tunnel. Everything
else on the domain is DNS-only (grey). Don't proxy the Vercel / Clerk / Resend records.

**Tunnel health:** Zero Trust → Networks → Tunnels → `outreach-cw` should be **Healthy**.

---

## Checks

```bash
# Everything running?
ssh cw 'cw list; systemctl is-active docker cloudflared'
ssh cw 'sudo docker exec cw-prashuk supervisorctl -c /tmp/cw-supervisord.conf status'

# Are the sites logged in (reads cookies, opens no page)?
ssh cw "sudo docker exec cw-prashuk node -e \"const h=require('/app/worker/chrome-health');(async()=>{for(const [n,d] of [['nauk_rt','naukri.com'],['sessionid','instahyre.com'],['hirist_seeker_enc','hirist']]) console.log(n, await h.hasCookie(9222,n,d));})()\""

# Frozen tabs?
ssh cw "sudo docker exec cw-prashuk node -e \"require('/app/worker/chrome-health').stuckTabs(9222).then(t=>console.log(t))\""

# Only SSH open from outside (run on the Mac; expect only 22 open)
for p in 22 80 443 5900 6001 6080 9222; do nc -z -G 3 130.210.11.217 $p && echo "$p OPEN" || echo "$p closed"; done

# Screen link answers (302 = Cloudflare login page)
curl -s -o /dev/null -w "%{http_code}\n" https://screen-prashuk.jainprashuk.in/
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Screen link: Cloudflare error / bad gateway | Container down | `ssh -t cw 'sudo cw restart <user>'`, then `cw logs <user> supervisord` |
| Login page has no email box | One-time PIN turned off | Zero Trust → Identity providers → add One-time PIN |
| PIN email never arrives | Wrong email on the rule / spam | Check spam; check the app's policy email (see Cloudflare tasks) |
| Portal shows worker offline | Container down, wrong token, or VM down | `cw list`; `cw logs <user> <platform>` — "401"/"Unknown worker" = wrong token → `sudo cw token <user>` |
| Portal shows "logged out" | Site session expired | User opens their link and logs in again |
| "Zero jobs read from …" | Page slow or the site changed its feed | Open the site in the cloud browser; check `cw logs <user> <platform>`; driver waits up to 20 s for the feed (`worker/platforms/shared/driver.js` FEED_WAIT_MS) |
| "tabs not responding" | A frozen tab | Close it in the cloud browser, or `sudo cw restart <user>` |
| Captcha → platform blocked 7 days | Site rate-limited the account | Intended. Don't work around it. Log in again after the block |
| Worker says "Another … worker is already running" | Stale lock file | `sudo cw restart <user>` (the entrypoint clears locks) |
| All of a user's workers "Offline", VM load very high, check-ins time out | Chrome out of memory and swapping | `cw logs <user> watchdog` — it restarts Chrome above 80% of the cap, between runs. If it can't (a run stuck holding Chrome), `sudo cw restart <user>` |
| Chrome keeps restarting, log mentions "namespace" / "zygote" | Container started without the seccomp profile | Always start containers through `cw` (it passes `chrome-seccomp.json`) |
| A run shows failed with no worker log line | Another machine with the same token claimed it | Make sure no Naukri/Instahyre/Hirist worker runs on any Mac |
| `cw update` fails pulling | Deploy key / known_hosts | `ssh cw 'ssh -T git@github.com'` should greet you; key is `~/.ssh/github_outreach` (GitHub → repo → Settings → Deploy keys → `oracle-cw`) |
| `ssh` times out | VM rebooting / stopped | Oracle console → instance state; **Start** if stopped |
| `ssh` "Permission denied (publickey)" | Key not loaded | `ssh-add --apple-use-keychain ~/.ssh/oracle_cw` |
| Disk filling | Old images / logs | `ssh cw 'sudo docker system prune -f; df -h /'` (keeps volumes, so logins survive) |
| VM unreachable after Oracle maintenance | Rare reclaim/restart | Console → Start. Everything else restarts by itself |

### Emergency stop

```bash
ssh -t cw 'sudo docker stop $(sudo docker ps -q --filter name=^cw-)'   # all users
ssh -t cw 'sudo docker stop cw-rahul'                                   # one user
```

Start again with `sudo cw restart <user>`. Pausing in the portal (Job Platforms →
Configuration → Pause) is gentler and per platform.

---

## Backups

The only state on the VM is the Chrome profiles (logins). Losing them means
logging in again — annoying, not harmful. To keep a copy anyway:

```bash
ssh cw 'sudo tar czf - -C /srv/cw prashuk --exclude="*/Cache*" --exclude="*/logs"' > ~/cw-prashuk-$(date +%F).tgz
```

Everything else (runs, jobs, settings) is in the portal's database, not on the VM.

## Rebuilding the VM from scratch

1. Oracle: create A1.Flex (Ubuntu 24.04, your `oracle_cw.pub`, public IP), as in the rollout checklist.
2. On the VM: create a deploy key (`ssh-keygen -t ed25519 -f ~/.ssh/github_outreach -N ""`),
   add it to GitHub → repo → Deploy keys (read-only), add `Host github.com / IdentityFile ~/.ssh/github_outreach` to `~/.ssh/config`.
3. `sudo mkdir -p /opt/outreach && sudo chown ubuntu /opt/outreach && git clone git@github.com:Jainprashuk/outreach.git /opt/outreach`
4. `sudo ln -sf /opt/outreach/deploy/cloud-worker/cw /usr/local/bin/cw && sudo cw host-setup`
   (Cloudflare token, Account ID `8e0d30d3f3b85f632090edb2439b6527`, `jainprashuk.in`, your email, portal URL).
   The existing tunnel is reused by name.
5. `sudo cw add` each user again with their existing token (or issue new ones); restore
   profiles from backup into `/srv/cw/<user>/` first, or have them log in again.
6. Old Access apps and DNS records for the same names are reused or replaced; delete
   strays in Cloudflare if a name changed.

---

## Limits and cost (as of Oct 2026)

| Service | Free limit | Usage / headroom |
|---|---|---|
| Oracle A1 | 4 OCPU / 24 GB shown (kept at 2 / 12) | ~3 GB per user → about 3 users now, ~8 at 4 / 24 |
| Oracle disk | 200 GB total | 45 GB used of it; ~1 GB per user |
| Vercel Hobby | 1M requests, 4 h CPU / month | workers check in fast only while needed (≈50–60k requests per cloud user per month); the Mac LinkedIn worker still polls every 20 s (~130k) |
| MongoDB Atlas free | 512 MB | worker check-ins are no longer logged |
| Cloudflare Zero Trust | 50 users | 1 seat per person who opens a screen |

Watch: Vercel → Usage, Atlas → Metrics, `cw stats`, Oracle Cost Analysis.

## Safety rules (do not change casually)

- Real Chrome, real profile, no automation flags, sandbox on (never `--no-sandbox`).
- A captcha blocks that platform for 7 days, server-side. No bypass.
- Apply counts only on the site's own success answer; dry run never clicks submit.
- Chrome's debug port (9222) never leaves its container; screens are reachable only through Cloudflare Access.
- One token per account: issuing a new one stops every other worker using the old one.
