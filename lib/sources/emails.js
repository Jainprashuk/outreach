// Emails and links out of free text: a WhatsApp export, an HN post, a search snippet.
// A port of find_emails / find_links in linkdin-post/src/jobleads/extract.py, so the
// three new lead sources read text the same way the LinkedIn harvester does.
//
// Every email a new source imports comes from here, never from an AI answer, so a
// model can't hand us an address nobody wrote.

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi;

// Recruiters disguise addresses: name [at] co [dot] com, name(at)co(dot)com,
// name @ co . com. Both separators must be bracketed or space-padded, which is what
// stops "work at Acme. In case…" from being read as an email.
const AT = String.raw`(?:[\[({<]|\s)\s*(?:at|@)\s*(?:[\])}>]|\s)`;
const DOT = String.raw`(?:[\[({<]|\s)\s*(?:dot|\.)\s*(?:[\])}>]|\s)`;
const OBFUSC = new RegExp(
  String.raw`([\w.+-]+?)\s*${AT}\s*([\w-]+)\s*${DOT}\s*([a-z]{2,10})(?:\s*${DOT}\s*([a-z]{2,10}))?\b`,
  'gi',
);

const NOISE = /\.(png|jpe?g|gif|webp|svg|pdf|docx?)$/i;
// "Mail your resumecareers@x.com": a lost space glues the word before onto a
// common mailbox name. Only these exact pairs are split back apart.
const GLUED = /^(?:resumes?|cv)(careers?|hr|jobs?|recruitment|recruiter|recruiting|hiring|talent|people|hello|info)$/;
// Addresses that exist but are never a person to write to.
const NOBODY = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|example|test|abuse)@|@(example|domain|email|yourcompany|company)\.(com|org|in)$/i;

// Free mail providers: a real person, often a consultancy recruiter. Kept, but they
// earn no "company email" points.
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'ymail.com', 'outlook.com',
  'outlook.in', 'hotmail.com', 'live.com', 'aol.com', 'mail.com', 'rediffmail.com',
  'rediff.com', 'icloud.com', 'proton.me', 'protonmail.com', 'zohomail.com',
]);

/** All addresses in `text`, plain and disguised, lowercased and deduped, in order. */
function extractEmails(text) {
  const s = String(text || '');
  const found = [];
  for (const m of s.matchAll(EMAIL)) found.push(m[0]);
  for (const m of s.matchAll(OBFUSC)) {
    const [, local, host, tld, tld2] = m;
    found.push(`${local}@${host}.${tld}${tld2 ? `.${tld2}` : ''}`);
  }
  const out = [];
  for (const raw of found) {
    const addr = raw.trim().replace(/^[.,;:]+|[.,;:]+$/g, '').toLowerCase();
    if (NOISE.test(addr) || NOBODY.test(addr) || addr.split('@').length !== 2) continue;
    let [local, domain] = addr.split('@');
    if (!local || !domain.includes('.')) continue;
    const glued = local.match(GLUED);
    if (glued) local = glued[1];
    const email = `${local}@${domain}`;
    if (!out.includes(email)) out.push(email);
  }
  return out;
}

const domainOf = (email) => String(email || '').split('@')[1] || '';
const isCompanyEmail = (email) => !!domainOf(email) && !FREE_MAIL.has(domainOf(email));

const URL_RE = /(?:https?:\/\/|www\.|lnkd\.in\/)[^\s<>"'‘’“”]+/gi;
// LinkedIn's own navigation, not something to apply through.
const LI_DROP = /^\/(?:feed|in|company|school|posts|notifications|comm\/feed|mynetwork|groups|events|learning|help|legal|pulse|signup|login|uas|checkpoint|search|hashtag|jobs\/search)(?:\/|$)/i;

function tidyUrl(raw) {
  let url = raw.trim().replace(/[.,;:!?…]+$/, '');
  while (url.endsWith(')') && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length) url = url.slice(0, -1);
  while (url.endsWith(']') && (url.match(/]/g) || []).length > (url.match(/\[/g) || []).length) url = url.slice(0, -1);
  if (!url.includes('://')) url = `https://${url}`;
  return url;
}

/** Apply links in `text`. LinkedIn's own navigation links are dropped. */
function extractLinks(text) {
  const out = [];
  for (const m of String(text || '').matchAll(URL_RE)) {
    const url = tidyUrl(m[0]);
    const rest = url.split('://')[1] || '';
    const host = rest.split('/')[0].toLowerCase().replace(/^www\./, '');
    const path = `/${rest.split('/').slice(1).join('/')}`;
    if (host.endsWith('linkedin.com') && (LI_DROP.test(path) || path === '/')) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

module.exports = { extractEmails, extractLinks, domainOf, isCompanyEmail, FREE_MAIL };
