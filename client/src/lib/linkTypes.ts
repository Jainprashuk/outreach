import type { Lead } from './api';

/**
 * What a harvested link actually is. The harvester dumps every URL it finds in a
 * post, so the array mixes real application forms with aggregator spam and a few
 * strings that were never links at all ("ASP.NET", "B.Tech" — the scraper reads
 * any word.tld shape as a domain).
 */
export type LinkType =
  | 'ats' | 'job-post' | 'careers' | 'aggregator'
  | 'shortener' | 'contact' | 'promo' | 'junk' | 'other';

export const LINK_TYPE_META: Record<LinkType, { label: string; icon: string; hint: string }> = {
  'ats':        { label: 'Application form', icon: 'ti-file-check',   hint: 'Greenhouse, Lever, Ashby, Workday, iCIMS…' },
  'job-post':   { label: 'Job posting',      icon: 'ti-briefcase',    hint: 'A LinkedIn job listing' },
  'careers':    { label: 'Careers page',     icon: 'ti-building',     hint: "A company's own careers page" },
  'aggregator': { label: 'Job aggregator',   icon: 'ti-list-search',  hint: 'jobsrmine, remoteyeah, quickhire…' },
  'shortener':  { label: 'Unresolved link',  icon: 'ti-link',         hint: 'lnkd.in / bit.ly — unknown until opened' },
  'contact':    { label: 'Contact / booking',icon: 'ti-calendar',     hint: 'WhatsApp, Calendly, MS Forms' },
  'promo':      { label: 'LinkedIn promo',   icon: 'ti-speakerphone', hint: 'A LinkedIn services page' },
  'junk':       { label: 'Not a real link',  icon: 'ti-alert-square', hint: 'A tech term the scraper misread as a URL' },
  'other':      { label: 'Company / other',  icon: 'ti-world',        hint: 'Some other site' },
};

export const LINK_TYPE_ORDER: LinkType[] = [
  'ats', 'job-post', 'careers', 'aggregator', 'other', 'contact', 'shortener', 'promo', 'junk',
];

/** Types that give you a way in without needing an email address. */
export const APPLYABLE: LinkType[] = ['ats', 'job-post', 'careers'];

const ATS = /greenhouse|lever\.co|workday|myworkdayjobs|ashbyhq|icims|ripplehire|keka\.com|zohorecruit|workable|dover\.com|smartrecruiters|jobvite|recruittune|applybe|paycomonline|paylocity/i;
const AGGREGATOR = /jobsrmine|remoteyeah|quickhire|techmirrors|placero|hiredoor|jobviro|jobfound|stuwise|careervira|jobrapide|indeed|glassdoor|naukri|nauk\.in|foundit|monster|jobsearch|munotes|joblanderz/i;
const CONTACT = /wa\.me|whatsapp|t\.me|telegram|calendly|outlook\.office|forms\.office|forms\.gle|fiverr|upwork|freelancer/i;
const SHORTENER = /^(lnkd\.in|bit\.ly|rb\.gy|okt\.to|.*\.s\.gy|cdr\.co|pulse\.ly|tinyurl\.com|grnh\.se)$/i;

// Strings the scraper turned into URLs that were never links: a bare "word.tld"
// with no path, whose TLD is really a tech suffix or degree abbreviation.
const JUNK_HOST = /^(asp\.net|ado\.net|react\.js|node\.js|vue\.js|next\.js|cypress\.io|b\.tech|m\.tech|b\.sc|b\.e|v0\.dev|l\.com|3\.sr|compensation\.career|lifecycle\.work|testing\.design)$/i;
const JUNK_SHAPE = /^\d+(\.\d+)+$/;  // "2.3.1.2"

const hostOf = (url: string): string => {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
};

export function classifyLink(url: string): LinkType {
  const host = hostOf(url);
  if (!host) return 'junk';
  if (JUNK_HOST.test(host) || JUNK_SHAPE.test(host)) return 'junk';

  if (SHORTENER.test(host)) return 'shortener';

  if (host.endsWith('linkedin.com')) {
    if (url.includes('/jobs/view/')) return 'job-post';
    if (url.includes('/services/page/')) return 'promo';
    if (url.includes('/newsletters/')) return 'promo';
    return 'other';
  }

  if (ATS.test(url)) return 'ats';
  if (AGGREGATOR.test(host)) return 'aggregator';
  if (CONTACT.test(host)) return 'contact';
  // Checked after the specific hosts so an aggregator's /jobs/ path can't win.
  if (/\/(careers?|jobs?|vacancies|openings|apply)(\/|\?|$)/i.test(url)) return 'careers';
  return 'other';
}

/** Distinct link types on a lead, in display order. */
export function leadLinkTypes(lead: Pick<Lead, 'links'>): LinkType[] {
  const seen = new Set<LinkType>();
  (lead.links || []).forEach(l => seen.add(classifyLink(l)));
  return LINK_TYPE_ORDER.filter(t => seen.has(t));
}

/** True when a lead can be actioned through a link even with no email. */
export const hasApplyableLink = (lead: Pick<Lead, 'links'>) =>
  (lead.links || []).some(l => APPLYABLE.includes(classifyLink(l)));
