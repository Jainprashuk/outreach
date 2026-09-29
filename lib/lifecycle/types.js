/**
 * The lifecycle email types, in one place.
 *
 * `pref` is the user-facing opt-out that covers the type (null = the user
 * cannot opt out: the welcome is transactional, and a manual report is
 * something the user asked for by clicking).
 */
const TYPES = {
  welcome:          { label: 'Welcome',                    pref: null },
  'setup-reminder': { label: 'Setup reminder',             pref: 'reminders' },
  inactive:         { label: "We haven't seen you",        pref: 'reminders' },
  'weekly-report':  { label: 'Weekly report',              pref: 'weekly-report' },
  'manual-report':  { label: '"Email it to me" reports',   pref: null },
};

const TYPE_KEYS = Object.keys(TYPES);

const PREFS = {
  reminders:       { label: 'Reminders & nudges', covers: ['setup-reminder', 'inactive'] },
  'weekly-report': { label: 'Weekly report',      covers: ['weekly-report'] },
};
const PREF_KEYS = Object.keys(PREFS);

const isType = (t) => Object.prototype.hasOwnProperty.call(TYPES, t);
const isPref = (p) => Object.prototype.hasOwnProperty.call(PREFS, p);

// Timing, in one place so the sweep and the preview script cannot disagree.
const SETUP_REMINDER_AFTER_DAYS = 5;
const INACTIVE_AFTER_DAYS = 3;
const MANUAL_EMAILS_PER_DAY = 5;

module.exports = {
  TYPES, TYPE_KEYS, PREFS, PREF_KEYS, isType, isPref,
  SETUP_REMINDER_AFTER_DAYS, INACTIVE_AFTER_DAYS, MANUAL_EMAILS_PER_DAY,
};
