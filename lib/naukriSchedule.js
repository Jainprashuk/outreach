// Timezone-aware evaluation of the Naukri schedule, using Intl rather than a
// date library — same reasoning as lib/scrapeSchedule.js, which this is adapted
// from. Copied rather than imported: the two schedules answer to different
// sites and must be free to diverge without one breaking the other. It is small,
// pure, and covered by scripts/test-naukri-schedule.js.
//
// Due-ness is evaluated when the worker polls /api/naukri/claim, not on a timer:
// these runs can only happen while the Mac is awake with a logged-in Chrome, so
// creating them on a clock would pile up queued rows nobody can execute.
//
// The one real difference from the scrape version: a Naukri occurrence fans out
// into up to three runs (refresh / harvest / apply), gated by their own toggles.

const DAY_MS = 86400000;

// Wall-clock parts of `date` as seen in `timeZone`.
function partsIn(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out = {};
  for (const { type, value } of fmt.formatToParts(date)) {
    if (type !== 'literal') out[type] = Number(value);
  }
  // Intl renders midnight as hour 24 in some ICU versions.
  if (out.hour === 24) out.hour = 0;
  return out;
}

// Offset of `timeZone` at `date`, in ms (positive east of UTC).
function offsetAt(date, timeZone) {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - date.getTime();
}

// A wall-clock time in `timeZone` -> the real instant. Resolved twice so a DST
// boundary (irrelevant for Asia/Kolkata, but this shouldn't silently break if
// the timezone is ever changed) lands on the correct side.
function zonedToUtc(y, m, d, hh, mm, timeZone) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - offsetAt(new Date(guess), timeZone);
  const corrected = guess - offsetAt(new Date(ts), timeZone);
  if (corrected !== ts) ts = corrected;
  return new Date(ts);
}

function parseTime(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

// 0 = Sunday .. 6 = Saturday, for the calendar date y-m-d.
const weekdayOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

// Which run kinds this schedule would fire, in the order they must execute:
// refresh before harvest (the profile should be fresh before anything else
// happens), harvest before apply (so an approval made this morning acts on
// today's listings).
function kindsFor(schedule) {
  if (!schedule) return [];
  const kinds = [];
  if (schedule.runRefresh) kinds.push('refresh');
  if (schedule.runHarvest) kinds.push('harvest');
  if (schedule.runApply)   kinds.push('apply');
  // Last: reading replies is read-only and never in the way of applying.
  if (schedule.runTrack)   kinds.push('track');
  return kinds;
}

// Every time of day the schedule fires, with the run kinds each one starts.
//
// Slot 1 is the original single `time` with its three toggles, read exactly as
// before — so a schedule saved before slots existed fires as it always did.
// `extraSlots` adds up to two more (say, a 14:00 apply-only), which is how
// auto-approved jobs can reach the daily cap instead of stopping at one run.
const MAX_SLOTS = 3;

function slotsOf(schedule) {
  if (!schedule) return [];
  const all = [
    { time: schedule.time, kinds: kindsFor(schedule) },
    ...(Array.isArray(schedule.extraSlots) ? schedule.extraSlots : [])
      .map(s => ({ time: s && s.time, kinds: kindsFor(s) })),
  ];
  return all.slice(0, MAX_SLOTS).filter(s => parseTime(s.time) && s.kinds.length);
}

function isValid(schedule) {
  return !!schedule
    && schedule.enabled
    && Array.isArray(schedule.days) && schedule.days.length > 0
    && slotsOf(schedule).length > 0;
}

// Every occurrence of every slot on calendar day `probe` (in the schedule's
// timezone), or [] when that weekday is off.
function occurrencesOn(schedule, probe) {
  const tz = schedule.timezone || 'Asia/Kolkata';
  const days = new Set(schedule.days.map(Number));
  const p = partsIn(probe, tz);
  if (!days.has(weekdayOf(p.year, p.month, p.day))) return [];
  return slotsOf(schedule).map((slot) => {
    const { hh, mm } = parseTime(slot.time);
    return { at: zonedToUtc(p.year, p.month, p.day, hh, mm, tz), kinds: slot.kinds, time: slot.time };
  });
}

// The latest occurrence at or before `now` — { at, kinds, time } — or null if
// none in the last 8 days.
function previousSlot(schedule, now = new Date()) {
  if (!isValid(schedule)) return null;
  for (let back = 0; back <= 8; back++) {
    const occs = occurrencesOn(schedule, new Date(now.getTime() - back * DAY_MS))
      .filter(o => o.at <= now)
      .sort((a, b) => b.at - a.at);
    if (occs.length) return occs[0];
  }
  return null;
}

// The next `count` occurrences strictly after `now`, earliest first.
function upcomingSlots(schedule, now = new Date(), count = 1) {
  if (!isValid(schedule)) return [];
  const out = [];
  for (let ahead = 0; ahead <= 8 && out.length < count; ahead++) {
    const occs = occurrencesOn(schedule, new Date(now.getTime() + ahead * DAY_MS))
      .filter(o => o.at > now)
      .sort((a, b) => a.at - b.at);
    for (const o of occs) {
      // Two probes a day apart can land on the same calendar day near midnight
      // in a far-off timezone; never list one occurrence twice.
      if (!out.some(x => x.at.getTime() === o.at.getTime())) out.push(o);
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, count);
}

const nextSlot = (schedule, now = new Date()) => upcomingSlots(schedule, now, 1)[0] || null;

// Kept for callers that only want the instant.
function previousOccurrence(schedule, now = new Date()) {
  const s = previousSlot(schedule, now);
  return s ? s.at : null;
}
function nextOccurrence(schedule, now = new Date()) {
  const s = nextSlot(schedule, now);
  return s ? s.at : null;
}

// The occurrence that should fire right now — { at, kinds, time } — or null.
//
// Two guards: it must not already have fired (lastFiredAt), and it must be
// recent enough to still be worth running. Without catchUpHours, a Mac opened on
// Thursday would immediately fire Monday's runs — which both wastes the day's
// safe budget and looks like the portal misfired.
//
// Only the LATEST past occurrence is considered: a Mac that slept through 09:30
// and 14:00 fires the 14:00 slot once, not both back to back.
function dueSlot(schedule, now = new Date()) {
  const occ = previousSlot(schedule, now);
  if (!occ) return null;

  const last = schedule.lastFiredAt ? new Date(schedule.lastFiredAt) : null;
  if (last && occ.at <= last) return null;

  const windowMs = Math.max(0, Number(schedule.catchUpHours) || 0) * 3600000;
  if (now.getTime() - occ.at.getTime() > windowMs) return null;

  return occ;
}

function dueOccurrence(schedule, now = new Date()) {
  const s = dueSlot(schedule, now);
  return s ? s.at : null;
}

// Midnight today in `timeZone`, as an instant. The daily apply cap counts from
// here, so "today" means your day, not the server's.
function startOfDayIn(timeZone = 'Asia/Kolkata', now = new Date()) {
  const p = partsIn(now, timeZone);
  return zonedToUtc(p.year, p.month, p.day, 0, 0, timeZone);
}

module.exports = {
  dueOccurrence, nextOccurrence, previousOccurrence,
  dueSlot, nextSlot, previousSlot, upcomingSlots, slotsOf, startOfDayIn,
  kindsFor, parseTime, partsIn, zonedToUtc, MAX_SLOTS,
};
