// Fit score for leads from the new sources (paste, HN, hiring posts). The LinkedIn
// harvester scores its own leads in Python (extract.py score()); this is the
// server-side equivalent, kept small and pure so it can be tested without a network.
//
// -999 is the existing "hard reject" — the Leads page's "hide rejects" already hides
// it, so a rejected row is still visible if you want to check why.
//
// The AI reading (lib/sources/readPosts.js) is optional input: when it is missing
// (providers busy), the text rules below still decide seeker / hiring / location.

const { isCompanyEmail } = require('./emails');

// Titles that are never the roles you want; they win over any role match.
const DEFAULT_EXCLUDE = [
  'sales', 'recruiter', 'recruiting', 'account executive', 'account manager',
  'customer success', 'customer support', 'marketing', 'veterinary',
  'claims', 'nurse', 'teacher', 'driver', 'warehouse', 'barista', 'legal counsel',
];

const REJECT = -999;

const WEIGHTS = {
  roleMatch: 3,      // a role you target appears in the role/text
  companyEmail: 2,   // at least one address on the company's own domain
  remote: 1,         // says remote
  wantedLocation: 2, // names one of your locations
  fresh: 1,          // posted in the last 7 days
  hasEmail: 1,       // something to write to at all
};

const rx = (parts) => new RegExp(parts.join('|'), 'i');

// Phrasing only a candidate uses (from config.json filters.seeker, trimmed).
const SEEKER = rx([
  String.raw`#open_?to_?work`,
  String.raw`\b(?:i\s?a?m|i'm|im)\s+(?:actively\s+)?(?:looking|searching|seeking|available)\s+(?:for\s+)?(?:a\s+)?(?:new\s+)?(?:job|role|opportunit|position|work|change)`,
  String.raw`\bmy\s+(?:notice\s+period|last\s+working\s+day)\b`,
  String.raw`\bjob\s?seeker\b`,
  String.raw`\b(?:kindly|please)\s+(?:refer|consider)\s+me\b`,
  String.raw`\bcan\s+(?:anyone|someone)\s+(?:refer|help)\s+me\b`,
  String.raw`\b(?:i\s+was|recently|got)\s+laid\s+off\b`,
]);

const HIRING = rx([
  String.raw`\bhiring\b`, String.raw`\bwe(?:'|’)?re\s+looking\s+for\b`, String.raw`\bopenings?\b`,
  String.raw`\bopen\s+(?:position|role)s?\b`, String.raw`\bvacanc(?:y|ies)\b`,
  String.raw`\b(?:share|send|drop|mail|forward)\s+(?:your\s+)?(?:cv|resume|profiles?)\b`,
  String.raw`\binterested\s+candidates?\b`, String.raw`\bjoin\s+our\s+team\b`, String.raw`\bapply\b`,
  String.raw`\bwalk-?in\b`, String.raw`\bjob\s+(?:opening|alert|opportunit)`,
]);

const INDIA = rx([
  String.raw`\bindia\b|\bpan[\s-]?india\b`, String.raw`\+91[\s-]?\d|\binr\b|\blpa\b|\blakhs?\b|₹`,
  String.raw`\b(?:bengaluru|bangalore|blr|hyderabad|pune|mumbai|thane|chennai|kolkata|ahmedabad|jaipur|indore|noida|gurgaon|gurugram|delhi|ncr|chandigarh|kochi|coimbatore|trivandrum|mohali|nagpur|lucknow)\b`,
]);

const ABROAD = rx([
  String.raw`\bu\.?s\.?a\b|\bunited\s+states\b|\bnorth\s+america\b`,
  String.raw`\bus[\s-]?(?:only|citizens?|based|residents?)\b`,
  String.raw`\bc2c\b|\bw2\b|\bh[-\s]?1\s?b\b|\bgreen\s+card\b|\bvisa\s+sponsorship\b`,
  String.raw`\b(?:onsite|on-site|in[\s-]office)\s+(?:in\s+)?(?:sf|nyc|san\s+francisco|new\s+york|london|berlin|seattle|boston|austin|toronto)\b`,
  String.raw`\b(?:uk|eu|us|canada|europe)\s+only\b`,
  String.raw`\bunited\s+kingdom\b|\b(?:london|manchester|berlin|munich|germany|amsterdam|paris|dublin|zurich|stockholm|toronto|vancouver|sydney|melbourne)\b`,
  String.raw`\b(?:uk|u\.k\.)\b|\b(?:cet|cest|est|pst|pt|et)\s*(?:±|\+\/?-|time\s*zone)`,
]);

// Remote with no country attached: open to someone in India.
const GLOBAL_REMOTE = /\bremote\b[^.\n|]{0,40}?\b(?:worldwide|global(?:ly)?|anywhere|international|apac|asia|india)\b|\b(?:worldwide|global|anywhere)\b[^.\n|]{0,15}\bremote\b|\b(?:anywhere\s+in\s+the\s+world|work\s+from\s+anywhere)\b/i;

// Roles the job-feed blocklist (the exclude list above) doesn't cover but that are never
// an engineering application. Kept here so the Jobs feed filters don't change.
const EXTRA_EXCLUDE = ['business development', 'bdm', 'product manager', 'project manager', 'talent acquisition', 'hr executive', 'hr manager'];

// Titles that ask for far more experience than they state in years.
const SENIOR = /\b(?:senior|sr|staff|principal|distinguished|lead|head|director|vp|architect|manager)\b/;
// At or under this many years, a senior title is out of reach.
const JUNIOR_YEARS = 4;

const REMOTE = /\bremote\b|\bwork\s+from\s+home\b|\bwfh\b/i;
const REMOTE_LIMITED = /\bremote\s*\(?\s*(?:us|usa|u\.s\.|eu|europe|uk|canada|north\s+america|americas)\b/i;

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

// Role text, forgiving of how people write it: "React.js" ~ "react",
// "Full-Stack" ~ "full stack" ~ "fullstack", "Front-end" ~ "frontend".
const roleText = (s) => norm(s).replace(/\.js\b/g, '').replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ');

/** The first of your roles named in `text`, or null. */
function roleHit(text, roles) {
  const hay = roleText(text);
  const tight = hay.replace(/ /g, '');
  for (const raw of roles || []) {
    const r = roleText(raw);
    if (r && (hay.includes(r) || tight.includes(r.replace(/ /g, '')))) return r;
  }
  return null;
}

/**
 * Location verdict for one post: 'wanted' (names a place you want, or India),
 * 'global' (remote, explicitly anywhere), 'remote' (says remote, no country given),
 * 'abroad' (clearly elsewhere), or 'unknown'.
 * Silence is not a foreign country: most genuine posts name no place at all.
 */
function placeOf(text, { locations = [], remote = null } = {}) {
  const t = String(text || '');
  const wanted = locations.map(norm).filter(l => l && l !== 'remote');
  // Whole words: "india" must not match "Indiana".
  const named = (l) => new RegExp(`\\b${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t);
  if (wanted.some(named) || (wanted.includes('india') && INDIA.test(t))) return 'wanted';
  if (GLOBAL_REMOTE.test(t)) return 'global';
  // "REMOTE | US only" is not remote for you: any foreign restriction wins.
  if (ABROAD.test(t) || REMOTE_LIMITED.test(t)) return 'abroad';
  if (remote === true || REMOTE.test(t)) return 'remote';
  return 'unknown';
}

/**
 * @param item  { text, emails[], role, location, remote, hiring, isSeeker, minYears, postedAt }
 *              The AI fields are optional; text rules fill in for any that are missing.
 * @param target { roles[], locations[], maxYears }
 * @returns {{ score: number, reasons: string[], hiring: boolean }}
 */
function scoreItem(item, target = {}, now = new Date()) {
  const text = String(item.text || '');
  const roles = (target.roles || []).filter(Boolean);
  const locations = (target.locations || []).map(norm).filter(Boolean);
  const reasons = [];

  const seeker = item.isSeeker === true || (item.isSeeker !== false && SEEKER.test(text));
  if (seeker) return { score: REJECT, reasons: ['Someone looking for a job, not hiring'], hiring: false };

  const hiring = item.hiring === true || (item.hiring !== false && HIRING.test(text));
  if (!hiring) return { score: REJECT, reasons: ['Not a hiring post'], hiring: false };

  const place = placeOf(`${item.location || ''} ${text}`, { locations, remote: item.remote });
  const wantsRemote = !locations.length || locations.includes('remote');
  if (place === 'abroad') return { score: REJECT, reasons: ['Outside your locations'], hiring };
  const remote = place === 'remote' || place === 'global';
  if (remote && !wantsRemote) return { score: REJECT, reasons: ['Remote, but you chose specific locations'], hiring };

  // The job-feed blocklist (the exclude list above): "Front-End Sales" is not a frontend job.
  // Checked against the role only — a post can mention "sales" and still hire engineers.
  const roleLower = ` ${roleText(item.role || '')} `;
  const excluded = [...DEFAULT_EXCLUDE, ...EXTRA_EXCLUDE].find(w => roleLower.includes(` ${w} `));
  if (excluded) return { score: REJECT, reasons: [`Not your kind of role (${excluded})`], hiring };

  // With few years, "Senior / Staff / Principal …" is out of reach even when the
  // post never states a number.
  if (Number.isFinite(target.maxYears) && target.maxYears <= JUNIOR_YEARS && SENIOR.test(roleLower)) {
    return { score: REJECT, reasons: [`Senior role — you set ${target.maxYears} years`], hiring };
  }

  if (Number.isFinite(target.maxYears) && Number.isFinite(item.minYears) && item.minYears > target.maxYears) {
    return { score: REJECT, reasons: [`Needs ${item.minYears}+ years`], hiring };
  }

  let score = 0;
  const hit = roleHit(`${item.role || ''} ${text}`, roles);
  if (hit) { score += WEIGHTS.roleMatch; reasons.push(`Mentions "${hit}"`); }
  const emails = item.emails || [];
  if (emails.length) score += WEIGHTS.hasEmail;
  if (emails.some(isCompanyEmail)) { score += WEIGHTS.companyEmail; reasons.push('Company email'); }
  if (place === 'wanted') { score += WEIGHTS.wantedLocation; reasons.push('In your locations'); }
  if (remote) { score += WEIGHTS.remote; reasons.push(place === 'global' ? 'Remote, anywhere' : 'Remote'); }
  const posted = item.postedAt ? new Date(item.postedAt) : null;
  if (posted && !Number.isNaN(posted.getTime()) && now - posted <= 7 * 24 * 3600 * 1000) {
    score += WEIGHTS.fresh; reasons.push('Posted this week');
  }
  return { score, reasons, hiring };
}

module.exports = { scoreItem, placeOf, roleHit, REJECT, WEIGHTS, SEEKER, HIRING, GLOBAL_REMOTE };
