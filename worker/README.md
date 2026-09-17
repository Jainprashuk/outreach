# LinkedIn scrape worker

Runs on the Mac. Polls the portal for queued scrape runs, executes `jl harvest`
in the scraper repo, and posts the leads back through the same importer the
manual JSON upload uses.

## Why this is not a serverless function

`jl harvest` attaches to a **real, visible Chrome** over the DevTools protocol
(`scroll_harvest.py` → `chromium.connect_over_cdp`). There is no headless path
and no launch path, so it cannot run on Vercel, in Docker, or in CI.

That constraint is also the safety property. A real browser with a real profile,
a real fingerprint, `navigator.webdriver === false`, randomised scroll delays and
zero clicks is why the LinkedIn account has not been restricted. Moving the
harvest to a datacenter IP with a lifted `li_at` cookie would trade that away.

## Setup

1. Put the same `WORKER_SECRET` in `.env` here and in the Vercel env.
2. Log into LinkedIn once in the debug Chrome profile:
   ```bash
   ~/Desktop/linkdin-post/chrome-debug.sh
   ```
3. Start the worker:
   ```bash
   npm run scrape-worker          # by hand, easiest to watch
   worker/install-worker.sh       # or as a launchd agent, starts at login
   ```

## Sleep and wake

**A sleeping Mac runs nothing.** Sleep halts the CPU, so the worker and Chrome
both freeze; there is no setting that keeps a process alive through sleep. The
only way to "keep running" is to not sleep.

Both the npm script and the launchd agent wrap the worker in `caffeinate -is`:

- `-i` prevents idle system sleep on **any** power source.
- `-s` adds a stronger assertion that is **AC-only** (`man caffeinate`).

`-s` alone was the original mistake: on battery it holds nothing, so the Mac
slept while the worker sat there looking alive. Check with
`pmset -g assertions | grep caffeinate` — you want `PreventUserIdleSystemSleep`
in the list, not just `PreventSystemSleep`.

Two things `caffeinate` cannot do:

- **Closing the lid still sleeps the Mac.** Clamshell sleep is firmware-level;
  no assertion overrides it. Only an external display plus power keeps a
  closed-lid Mac awake.
- **It does not create power.** Holding a laptop awake on battery flattens it.

Each harvest additionally runs under `caffeinate -dimsu`, which holds on battery
too — a run must not die mid-scroll because you unplugged.

To run a *scheduled* scrape while away, give the Mac a scheduled wake a few
minutes earlier:

```bash
sudo pmset repeat wakeorpoweron MTWRFSU 09:25:00
pmset -g sched
```

Two things that fail silently and are worth knowing:

- **The lid must be open.** A scheduled wake with the lid shut is a *dark wake*:
  the system comes up but nothing renders, and LinkedIn's virtualised results
  column only mounts rows that are actually laid out. The harvest returns zero.
  Screen off and locked is fine. The worker treats `rendered === 0` as a failure
  rather than "no new leads" so this is never mistaken for a quiet day.
- `wakeorpoweron` wakes from sleep, **not** from a full shutdown.

The portal cannot wake the Mac on demand — it runs on Vercel and your laptop is
behind your router. Wake-on-LAN is not a workaround: it produces a dark wake.

## Failure handling

| Situation | Behaviour |
|---|---|
| Chrome not running | Worker runs `chrome-debug.sh` and retries once |
| Not logged into LinkedIn | Run fails immediately with a readable reason — no retry, it needs a human |
| `jl` exits 2 (LinkedIn checkpoint) | Run marked `blocked`, worker **stops**, server blocks all harvesting for 7 days |
| `rendered === 0` | Run marked `failed` — usually a dark wake or a LinkedIn DOM change |
| Worker killed mid-run | Server fails the run after 90 minutes so the queue unblocks |

The 7-day block is deliberate and lives server-side, so a restarted worker
cannot shrug it off and the schedule obeys it too. `TRACK-SCROLL.md` in the
scraper repo explains why: a checkpoint means stop, not retry.

Only one worker may run at a time — `jl` rewrites `data/leads.json` wholesale
with no locking. A PID lock at `~/.job-leads/worker.lock` enforces it.
