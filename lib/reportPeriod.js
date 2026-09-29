/**
 * Report periods, in India Standard Time.
 *
 * IST is a fixed UTC+5:30 with no daylight saving, so a constant offset is exact
 * and there is no need for a timezone library. Every period is half-open:
 * `from` inclusive, `to` exclusive, both real instants (Dates).
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CUSTOM_DAYS = 90;

/** 'YYYY-MM-DD' of the IST calendar day containing `d`. */
const istDateString = (d) => new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The instant of 00:00 IST on the IST day containing `d`. */
function istMidnight(d) {
  const shifted = new Date(new Date(d).getTime() + IST_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - IST_OFFSET_MS);
}

/** 00:00 IST on 'YYYY-MM-DD'. Returns null for anything that is not a real date. */
function fromIstDateString(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return null;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== s) return null;
  return new Date(t - IST_OFFSET_MS);
}

/** 0 = Monday … 6 = Sunday, for the IST day containing `d`. */
const istWeekday = (d) => (new Date(new Date(d).getTime() + IST_OFFSET_MS).getUTCDay() + 6) % 7;

/** Monday 00:00 IST of the week containing `d`. */
const istWeekStart = (d) => new Date(istMidnight(d).getTime() - istWeekday(d) * DAY_MS);

const period = (from, to, kind) => ({ from, to, kind, days: Math.round((to - from) / DAY_MS) });

/** The last complete Monday–Sunday week before `now`. */
const lastFullWeek = (now = new Date()) => {
  const thisMonday = istWeekStart(now);
  return period(new Date(thisMonday.getTime() - 7 * DAY_MS), thisMonday, 'week');
};

/** Monday 00:00 IST up to now. */
const thisWeekSoFar = (now = new Date()) => period(istWeekStart(now), new Date(now), 'this-week');

/** The last N whole IST days, including today so far. */
const lastNDays = (n, now = new Date()) => {
  const tomorrow = new Date(istMidnight(now).getTime() + DAY_MS);
  return period(new Date(tomorrow.getTime() - n * DAY_MS), new Date(now), `last-${n}`);
};

/**
 * 'YYYY-MM-DD'..'YYYY-MM-DD', both days included. Throws a user-facing message
 * for anything invalid, so a route can hand it straight back as a 400.
 */
function customPeriod(fromStr, toStr, now = new Date()) {
  const from = fromIstDateString(fromStr);
  const toDay = fromIstDateString(toStr);
  if (!from || !toDay) throw new Error('Dates must be YYYY-MM-DD.');
  if (toDay < from) throw new Error('The end date is before the start date.');
  const to = new Date(toDay.getTime() + DAY_MS);
  if ((to - from) / DAY_MS > MAX_CUSTOM_DAYS) throw new Error(`A custom range can be at most ${MAX_CUSTOM_DAYS} days.`);
  if (from > now) throw new Error('That range is in the future.');
  return period(from, to > now ? new Date(now) : to, 'custom');
}

/** The period of the same length immediately before `p`, for "vs previous". */
const previousPeriod = (p) => period(new Date(p.from.getTime() - (p.to - p.from)), p.from, 'previous');

/** Resolves the `?period=` family of query params used by routes/reports.js. */
function resolvePeriod(q = {}, now = new Date()) {
  switch (q.period || 'last-week') {
    case 'last-week': return lastFullWeek(now);
    case 'this-week': return thisWeekSoFar(now);
    case 'last-30': return lastNDays(30, now);
    case 'week': {
      const monday = fromIstDateString(q.week);
      if (!monday || istWeekday(monday) !== 0) throw new Error('week must be the YYYY-MM-DD of a Monday.');
      const to = new Date(monday.getTime() + 7 * DAY_MS);
      if (to > now) throw new Error('That week has not finished yet.');
      return period(monday, to, 'week');
    }
    case 'custom': return customPeriod(q.from, q.to, now);
    default: throw new Error('Unknown period.');
  }
}

/** "22–28 Sep 2026" — the last INCLUDED day is `to` minus a moment. */
function labelFor(p) {
  const fmt = (d, opts) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', ...opts });
  const last = new Date(p.to.getTime() - 1);
  const sameMonth = istDateString(p.from).slice(0, 7) === istDateString(last).slice(0, 7);
  if (istDateString(p.from) === istDateString(last)) return fmt(p.from, { day: 'numeric', month: 'short', year: 'numeric' });
  return sameMonth
    ? `${fmt(p.from, { day: 'numeric' })}–${fmt(last, { day: 'numeric', month: 'short', year: 'numeric' })}`
    : `${fmt(p.from, { day: 'numeric', month: 'short' })} – ${fmt(last, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/** Next instant at hh:00 IST (optionally on a given IST weekday, 0 = Monday) after `now`. */
function nextIstTime(now, hour, weekday = null) {
  let t = new Date(istMidnight(now).getTime() + hour * 60 * 60 * 1000);
  while (t <= now || (weekday !== null && istWeekday(t) !== weekday)) t = new Date(t.getTime() + DAY_MS);
  return t;
}

module.exports = {
  IST_OFFSET_MS, DAY_MS, MAX_CUSTOM_DAYS,
  istDateString, istMidnight, fromIstDateString, istWeekday, istWeekStart,
  lastFullWeek, thisWeekSoFar, lastNDays, customPeriod, previousPeriod, resolvePeriod,
  labelFor, nextIstTime,
};
