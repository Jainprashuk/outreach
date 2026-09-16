// Timezone-aware evaluation of the scrape schedule, using Intl rather than a
// date library — the repo keeps its dependency list short, and this needs only
// "what is the wall clock in Asia/Kolkata" plus the inverse.
//
// Due-ness is evaluated when a worker polls /api/scrapes/claim, not on a timer:
// the harvest can only run while the Mac is awake, so creating runs on a clock
// would just pile up queued rows nobody can execute.

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

function isValid(schedule) {
  return !!schedule
    && schedule.enabled
    && Array.isArray(schedule.days) && schedule.days.length > 0
    && Array.isArray(schedule.queries) && schedule.queries.length > 0
    && !!parseTime(schedule.time);
}

// The occurrence at or before `now`, or null if none in the last 8 days.
function previousOccurrence(schedule, now = new Date()) {
  if (!isValid(schedule)) return null;
  const tz = schedule.timezone || 'Asia/Kolkata';
  const { hh, mm } = parseTime(schedule.time);
  const days = new Set(schedule.days.map(Number));

  for (let back = 0; back <= 8; back++) {
    const probe = new Date(now.getTime() - back * DAY_MS);
    const p = partsIn(probe, tz);
    if (!days.has(weekdayOf(p.year, p.month, p.day))) continue;
    const occ = zonedToUtc(p.year, p.month, p.day, hh, mm, tz);
    if (occ <= now) return occ;
  }
  return null;
}

// The first occurrence strictly after `now`.
function nextOccurrence(schedule, now = new Date()) {
  if (!isValid(schedule)) return null;
  const tz = schedule.timezone || 'Asia/Kolkata';
  const { hh, mm } = parseTime(schedule.time);
  const days = new Set(schedule.days.map(Number));

  for (let ahead = 0; ahead <= 8; ahead++) {
    const probe = new Date(now.getTime() + ahead * DAY_MS);
    const p = partsIn(probe, tz);
    if (!days.has(weekdayOf(p.year, p.month, p.day))) continue;
    const occ = zonedToUtc(p.year, p.month, p.day, hh, mm, tz);
    if (occ > now) return occ;
  }
  return null;
}

// The occurrence that should fire right now, or null.
//
// Two guards: it must not already have fired (lastFiredAt), and it must be
// recent enough to still be worth running. Without catchUpHours, a Mac opened
// on Thursday would immediately harvest for Monday — which both wastes the
// day's one safe run and looks like the portal misfired.
function dueOccurrence(schedule, now = new Date()) {
  const occ = previousOccurrence(schedule, now);
  if (!occ) return null;

  const last = schedule.lastFiredAt ? new Date(schedule.lastFiredAt) : null;
  if (last && occ <= last) return null;

  const windowMs = Math.max(0, Number(schedule.catchUpHours) || 0) * 3600000;
  if (now.getTime() - occ.getTime() > windowMs) return null;

  return occ;
}

module.exports = { dueOccurrence, nextOccurrence, previousOccurrence, parseTime, partsIn, zonedToUtc };
