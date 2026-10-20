'use strict';

// Reading jobs out of the JSON a job site's own pages fetch.
//
// Like Naukri's Recommended jobs and My applies, a harvest adds no requests of
// its own: it opens the page you would open, listens to the responses the page
// makes (page.on('response')), and reads the job lists out of them. That is
// both the lightest touch on the site and the most robust read — JSON field
// names change far less often than markup.
//
// The extraction is deliberately tolerant. A site's exact field names are
// written down in its RECON.md once checked in DevTools, and pinned in the
// driver's meta.fields; until then (and as a fallback after) it recognises the
// usual spellings: title/job_title/designation, company_name/company.name, …
// A row without a stable id AND a title is never emitted, so a wrong guess
// harvests nothing rather than something false — and an empty harvest fails
// the run loudly (the dark-wake rule), it is never "no new jobs today".
//
// Output is the shape /ingest already takes (worker/naukri/stub.js), with
// numbers formatted as the text Naukri prints ("8-12 Lacs PA", "3 days ago"),
// so scoring and filters work unchanged (plan, option A).

const first = (obj, keys) => {
  for (const k of keys) {
    const v = k.includes('.') ? k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), obj) : obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

const DEFAULT_FIELDS = {
  id:       ['job_id', 'jobId', 'opportunity_id', 'opportunityId', 'job.id', 'id', 'uuid', 'slug'],
  title:    ['title', 'job_title', 'jobTitle', 'designation', 'job.title', 'role', 'position', 'job.designation'],
  company:  ['company_name', 'companyName', 'company.name', 'employer.company_name', 'employer.name', 'job.company_name',
             'organisation', 'organization', 'recruiter.company_name', 'company'],
  location: ['locations', 'location', 'job_locations', 'jobLocations', 'city', 'cities', 'job.locations', 'job.location'],
  expMin:   ['min_experience', 'minExperience', 'min_exp', 'minExp', 'experience_min', 'exp_min', 'job.min_experience', 'experience.min'],
  expMax:   ['max_experience', 'maxExperience', 'max_exp', 'maxExp', 'experience_max', 'exp_max', 'job.max_experience', 'experience.max'],
  expText:  ['experience', 'experience_range', 'exp', 'job.experience'],
  salMin:   ['min_salary', 'minSalary', 'salary_min', 'min_ctc', 'minCtc', 'job.min_salary', 'salary.min'],
  salMax:   ['max_salary', 'maxSalary', 'salary_max', 'max_ctc', 'maxCtc', 'job.max_salary', 'salary.max'],
  salText:  ['salary', 'salary_range', 'ctc', 'compensation', 'job.salary'],
  tags:     ['skills', 'keywords', 'tags', 'key_skills', 'keySkills', 'job.skills', 'job.keywords'],
  url:      ['url', 'job_url', 'jobUrl', 'public_url', 'publicUrl', 'absolute_url', 'job.url', 'link', 'detail_url'],
  description: ['description', 'job_description', 'jobDescription', 'jd', 'job.description', 'summary'],
  posted:   ['created_at', 'createdAt', 'posted_at', 'postedAt', 'posted_on', 'postedOn', 'date_posted', 'published_at',
             'publishedAt', 'updated_at', 'job.created_at', 'created'],
  // A recruiter on the site reached out about this one (Instahyre). verify names
  recruiter: ['is_recruiter_initiated', 'recruiter_initiated', 'employer_interested', 'interested_by_employer', 'is_invite', 'invited'],
  external: ['is_external', 'isExternal', 'external', 'apply_on_company_site', 'redirect_to_company', 'external_apply'],
};

const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

const asList = (v) => {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(x => (x && typeof x === 'object' ? (x.name || x.title || x.label || x.city || '') : x)).map(String).filter(Boolean);
  if (typeof v === 'object') return [v.name || v.title || v.label || v.city || ''].filter(Boolean);
  return String(v).split(/[,|]/).map(s => s.trim()).filter(Boolean);
};

const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Salary in rupees or lakhs → "8-12 Lacs PA". Values over 1000 are rupees.
function salaryText(min, max, text) {
  const lpa = (n) => (n == null ? null : n > 1000 ? Math.round((n / 100000) * 10) / 10 : n);
  const a = lpa(numOrNull(min)), b = lpa(numOrNull(max));
  if (a != null && b != null && b > 0) return `${a}-${b} Lacs PA`;
  if (a != null && a > 0) return `${a}+ Lacs PA`;
  if (text != null && typeof text !== 'object') return String(text).slice(0, 200);
  return '';
}

// A date, or "5 days ago" text, → { postedText, postedAt }.
function posted(v, now = Date.now()) {
  if (v == null || v === '') return { postedText: '', postedAt: null };
  if (typeof v === 'string' && /ago|today|just now|yesterday/i.test(v)) {
    return { postedText: /yesterday/i.test(v) ? '1 day ago' : v, postedAt: null };
  }
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  if (isNaN(d.getTime())) return { postedText: String(v).slice(0, 100), postedAt: null };
  const days = Math.max(0, Math.floor((now - d.getTime()) / 86400000));
  return { postedText: days === 0 ? 'Today' : `${days} day${days === 1 ? '' : 's'} ago`, postedAt: d.toISOString() };
}

// One raw object → the /ingest shape, or null if it is not a job.
function toJob(raw, { fields = {}, baseUrl = '', urlFor = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  // Opportunity wrappers ({ id, job: {...}, employer: {...} }) are flattened so
  // the job's own fields win and the wrapper fills the gaps.
  const o = raw.job && typeof raw.job === 'object' ? { ...raw, ...raw.job, job: raw.job } : raw;
  const F = { ...DEFAULT_FIELDS, ...fields };
  const id = first(o, F.id);
  const title = first(o, F.title);
  if (id == null || typeof title !== 'string' || !title.trim()) return null;
  let company = first(o, F.company);
  if (company && typeof company === 'object') company = company.name || company.company_name || '';
  const exp = first(o, F.expText);
  let expMin = numOrNull(first(o, F.expMin)), expMax = numOrNull(first(o, F.expMax));
  if (expMin == null && typeof exp === 'string') {
    const m = exp.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)/);
    if (m) { expMin = Number(m[1]); expMax = Number(m[2]); }
  }
  let url = first(o, F.url);
  if (urlFor) url = urlFor(o, url);
  if (url && baseUrl && !/^https?:/i.test(url)) url = baseUrl.replace(/\/$/, '') + '/' + String(url).replace(/^\//, '');
  const ext = first(o, F.external);
  return {
    sourceId: String(id),
    title: stripHtml(title).slice(0, 300),
    company: stripHtml(company || '').slice(0, 200),
    location: asList(first(o, F.location)).join(', ').slice(0, 200),
    experienceMin: expMin,
    experienceMax: expMax,
    salaryText: salaryText(first(o, F.salMin), first(o, F.salMax), first(o, F.salText)),
    tags: asList(first(o, F.tags)).slice(0, 20),
    url: url ? String(url) : '',
    description: stripHtml(first(o, F.description) || '').slice(0, 5000),
    ...posted(first(o, F.posted)),
    ...(ext === true || ext === 'true' || ext === 1 ? { companySite: true } : {}),
    // true, or (Instahyre) a recruiter's message object / text.
    ...((() => { const r = first(o, F.recruiter); return r === true || (r && typeof r === 'object') || (typeof r === 'string' && r.trim()); })() ? { recruiter: true } : {}),
  };
}

// Every array in a JSON body whose items look like jobs, flattened to jobs.
// "Look like" = at least half the objects in it produce a job.
function jobsInJson(body, opts = {}) {
  const out = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      const objs = node.filter(x => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length) {
        const jobs = objs.map(x => toJob(x, opts)).filter(Boolean);
        if (jobs.length && jobs.length >= objs.length / 2) {
          for (const j of jobs) if (!seen.has(j.sourceId)) { seen.add(j.sourceId); out.push(j); }
          return;
        }
      }
      for (const x of node) walk(x, depth + 1);
      return;
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(body, 0);
  return out;
}

// Listen to a page's JSON responses that match `test(url)`, collecting jobs.
// Returns { jobs: Map, stop(), lastAt() }.
function collectFeed(page, test, opts = {}) {
  const jobs = new Map();
  let lastAt = 0;
  const onResponse = async (res) => {
    try {
      const url = res.url();
      if (!test(url)) return;
      const type = (res.headers()['content-type'] || '');
      if (!/json/i.test(type)) return;
      const body = await res.json();
      lastAt = Date.now();
      for (const j of jobsInJson(body, opts)) {
        if (!jobs.has(j.sourceId)) jobs.set(j.sourceId, j);
        if (opts.onJob) opts.onJob(j, body);
      }
    } catch (_) { /* a response we cannot read adds nothing */ }
  };
  page.on('response', onResponse);
  return { jobs, stop: () => page.off('response', onResponse), lastAt: () => lastAt };
}

// An application's status words → the same timeline shape Naukri's history
// feed has, with Naukri's status ids (lib/naukriQueue.js NAUKRI_STATUS:
// 1 applied · 4 viewed · 6 shortlisted · 9 contacted · 7 not shortlisted), so
// /track reads every platform with one parser.
const STATUS_WORDS = [
  [/not[\s_-]*(shortlisted|selected)|reject|declin|unsuccessful|closed by recruiter/i, 7, 'Not Shortlisted'],
  [/contact|interview|call|message|chat|invite/i, 9, 'Contacted'],
  [/shortlist|accept|interested|selected|in[\s_-]?process/i, 6, 'Shortlisted'],
  [/view|seen|read|open/i, 4, 'Application Viewed'],
  [/appl|sent|submit/i, 1, 'Applied'],
];
function statusTimeline(words, at = null) {
  const list = (Array.isArray(words) ? words : [words]).filter(Boolean).map(String);
  const out = [{ statusId: 1, statusValue: 'Applied', dateTime: at }];
  for (const w of list) {
    const hit = STATUS_WORDS.find(([rx]) => rx.test(w));
    if (hit && hit[1] !== 1) out.push({ statusId: hit[1], statusValue: w.slice(0, 80) || hit[2], dateTime: at });
  }
  return out;
}

module.exports = { toJob, jobsInJson, collectFeed, statusTimeline, salaryText, posted, stripHtml, DEFAULT_FIELDS };
