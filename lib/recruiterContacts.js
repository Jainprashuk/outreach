// Recruiters on a job, from what the job platform itself shows: addresses written
// in the job text ("send your CV to hr@acme.com") and recruiter details the
// platform's own feed carries. Pure — no database, no network — so
// scripts/test-recruiter-contacts.js proves every rule.
//
// Nothing here visits a profile page or any other URL: it reads text and JSON the
// harvest already has. A recruiter becomes a Discover person only when you ask.

const { nameKey, isFreeMail, splitName } = require('./emailPatterns');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Addresses a job text mentions that are never a person to write to.
const NOISE_LOCAL = /^(no-?reply|do-?not-?reply|donotreply|unsubscribe|abuse|privacy|postmaster|webmaster|mailer-daemon|support|help|info)$/i;
const NOISE_DOMAIN = /(^|\.)(naukri\.com|instahyre\.com|hirist\.tech|hirist\.com|cutshort\.io|wellfound\.com|angel\.co|example\.(com|org)|sentry\.io|domain\.com|email\.com)$/i;
const FILE_LIKE = /\.(png|jpe?g|gif|svg|webp|pdf|docx?)$/i;

const MAX_RECRUITERS = 5;

/** Addresses in free text worth showing as a recruiter's. Lower-cased, unique, in order. */
function emailsIn(text, { max = 3 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').match(EMAIL_RE) || []) {
    const email = raw.replace(/[.,;:]+$/, '').toLowerCase();
    const [local, domain] = email.split('@');
    if (!local || !domain || seen.has(email)) continue;
    if (FILE_LIKE.test(email) || NOISE_DOMAIN.test(domain) || NOISE_LOCAL.test(local)) continue;
    seen.add(email);
    out.push(email);
    if (out.length >= max) break;
  }
  return out;
}

/** "priya.sharma" → "Priya Sharma"; null when it doesn't read as a person's name. */
function nameFromLocal(local) {
  const parts = String(local || '').split(/[._-]+/).filter(p => /^[a-z]{2,}$/i.test(p));
  if (parts.length < 2 || parts.length > 3) return null;
  return parts.map(p => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

/** The identity of one recruiter on one job: their address, else their name. */
const keyOf = (r) => (r.email ? `e:${r.email}` : r.name ? `n:${nameKey(r.name)}` : '');

/** Clean one recruiter from untrusted input, or null when there is nothing usable. */
function clean(r) {
  if (!r || typeof r !== 'object') return null;
  const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
  let email = str(r.email, 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email) || NOISE_DOMAIN.test(email.split('@')[1]) || NOISE_LOCAL.test(email.split('@')[0])) email = '';
  const name = str(r.name, 100);
  const profileUrl = /^https?:\/\//i.test(String(r.profileUrl || '')) ? str(r.profileUrl, 300) : '';
  const out = { name: splitName(name) ? name : '', title: str(r.title, 120), email, profileUrl, via: r.via === 'feed' ? 'feed' : 'text' };
  out.key = keyOf(out);
  return out.key ? out : null;
}

/**
 * Everyone worth showing for one job: recruiters the platform's feed named plus
 * addresses in the job text, merged by identity so an address that also belongs
 * to a named recruiter is one row.
 */
function recruitersFor({ description, feed }) {
  const byKey = new Map();
  const add = (r) => {
    const c = clean(r);
    if (!c) return;
    const dupe = [...byKey.values()].find(x => x.key === c.key || (c.email && x.email === c.email));
    if (dupe) {
      for (const f of ['name', 'title', 'email', 'profileUrl']) if (!dupe[f] && c[f]) dupe[f] = c[f];
      dupe.key = keyOf(dupe);
      return;
    }
    byKey.set(c.key, c);
  };
  for (const r of Array.isArray(feed) ? feed : []) add({ ...r, via: 'feed' });
  for (const email of emailsIn(description)) add({ email, name: nameFromLocal(email.split('@')[0]) || '', via: 'text' });
  return [...byKey.values()].slice(0, MAX_RECRUITERS);
}

/** True when an address is on a personal-mail provider (the company domain is then needed from elsewhere). */
const isPersonalMail = (email) => isFreeMail(String(email || '').split('@')[1] || '');

module.exports = { emailsIn, nameFromLocal, clean, recruitersFor, keyOf, isPersonalMail, MAX_RECRUITERS };
