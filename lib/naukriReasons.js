// Why an apply attempt ended the way it did, as one short group. The worker writes
// free text (worker/naukri/apply.js), so this is the one place that reads it —
// routes/naukri.js decides retries with the same patterns, and Analytics → Naukri
// groups outcomes with them.

// Skips that no future run can turn into an application.
//
// The worker also sends `terminal: true` for these, but the SERVER decides,
// because the worker is a separate process on a machine you update by hand. A
// worker running last week's code kept reporting company-site skips as ordinary
// ones, and they went straight back into the queue to be attempted again. The
// rule belongs where it cannot drift.
const TERMINAL_SKIP = /applies on the company site|already applied|walk-in drive|listing closed or removed/i;
// Only this one says anything about the EMPLOYER. "Already applied" is about
// you and that one listing, and counting it here flagged every other job from
// a company you had applied to once as company-site.
const EXTERNAL_SKIP = /applies on the company site/i;

// First match wins. Keys are stable (the client labels them); `other` catches
// raw exception text and anything a newer worker says that isn't listed here.
const GROUPS = [
  ['applied', 'Applied', /^applied/i],
  ['already-applied', 'Already applied', /already applied/i],
  ['company-site', 'Applies on the company site', EXTERNAL_SKIP],
  ['walk-in', 'Walk-in drive', /walk-in drive/i],
  ['closed', 'Listing closed', /listing closed or removed/i],
  ['question', 'Unanswered screening question', /unanswered screening question/i],
  ['no-button', 'No Apply button', /no apply button|apply button vanished/i],
  ['questionnaire', 'Questionnaire could not be completed', /questionnaire could not be completed/i],
  ['unconfirmed', 'Naukri never confirmed', /never confirmed/i],
  ['dry-run', 'Rehearsal (dry run)', /would have clicked apply/i],
  ['set-aside', 'Set aside by you', /set aside by you/i],
  ['timeout', 'Took too long', /did not finish within/i],
];
const LABELS = Object.fromEntries([...GROUPS.map(([k, l]) => [k, l]), ['other', 'Other error']]);

function reasonGroup(reason) {
  const s = String(reason || '');
  for (const [key, , re] of GROUPS) if (re.test(s)) return key;
  return 'other';
}

module.exports = { TERMINAL_SKIP, EXTERNAL_SKIP, reasonGroup, REASON_LABELS: LABELS };
