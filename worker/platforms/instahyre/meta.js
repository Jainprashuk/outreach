'use strict';

// Everything Instahyre-shaped, in one place. The driver (../shared/driver.js)
// reads only this file, so a fix after a site change — or after recon — is an
// edit here and nowhere else.
//
// STATUS (2026-10-20 recon, RECON.md): the session cookie `sessionid` and the
// API host www.instahyre.com/api/v1/ are VERIFIED. Every candidate page
// redirects to /candidate/onboard/ until the 4-step profile setup is finished,
// so the opportunities feed itself is still "verify". The read paths are
// tolerant (any job-shaped JSON from these hosts is read), so a wrong guess
// harvests nothing and the run fails loudly — it can never apply to anything:
// capabilities.apply is false here and in lib/platforms.js.

const { capabilitiesOf } = require('../../../lib/platforms');

const ORIGIN = 'https://www.instahyre.com';

module.exports = {
  id: 'instahyre',
  label: 'Instahyre',
  origin: ORIGIN,
  // The site's own API calls come from these hosts. verify
  apiHosts: ['instahyre.com'],
  // Only JSON that looks like a list endpoint is read (skips analytics beacons).
  // The matched list only (verified) — not its filter counts.
  feedTest: (url) => /\/candidate_opportunities\/candidate_matching\?/.test(url),

  // Logged in = the Django session cookie (verified).
  cookieUrls: [ORIGIN],
  sessionCookies: ['sessionid'],
  // Profile setup not finished: every page lands here (verified).
  setupUrls: ['/candidate/onboard'],
  setupMessage: 'Instahyre sent the page to its profile setup (/candidate/onboard/). Finish the 4 steps there '
    + '(skills, job preferences, resume, privacy) in the debug Chrome, then run again.',

  guardMarkers: {
    loginUrls: ['/login', '/candidate/login', '/accounts/login'],   // verify
    urls: [],
    text: [],
    loginText: ['log in to instahyre', 'login with google', 'forgot password?'],   // verify
  },

  capabilities: capabilitiesOf('instahyre'),

  // Instahyre pushes matched opportunities at you; that page is the main feed.
  // Recruiter-initiated interest arrives in the same list (recruiterFeed): the
  // driver marks those 'recruiter' when meta.fields says so.
  feeds: [
    // Loads GET /api/v1/candidate_opportunities/candidate_matching?…&limit=30&offset=N (verified);
    // scrolling fetches the next batch.
    { url: `${ORIGIN}/candidate/opportunities/?matching=true`, label: 'Matched opportunities', origin: 'recommended' },
  ],
  recruiterFeed: true,
  // Search results. verify
  searchUrl: (s) => {
    const u = new URL(`${ORIGIN}/search-jobs/`);
    if (s.keywords) u.searchParams.set('skills', s.keywords);
    if (s.location) u.searchParams.set('locations', s.location);
    if (s.experienceYears != null) u.searchParams.set('years', String(s.experienceYears));
    return u.toString();
  },
  // Feed rows (verified): { id, message, is_strong_match, employer: { company_name },
  // job: { id, title, locations, keywords[], opportunity_url, hiring_company_name } }.
  // The list carries no experience band, salary or posting date.
  fields: {
    id: ['job.id', 'id'],
    title: ['job.title', 'job.candidate_title', 'title'],
    company: ['job.hiring_company_name', 'employer.company_name'],
    location: ['job.locations'],
    tags: ['job.keywords'],
    // A recruiter wrote to you about it.
    recruiter: ['message'],
  },
  jobUrl: (o, url) => {
    const rel = o.job && o.job.opportunity_url;
    if (rel) return `${ORIGIN}${rel}`;
    return url || (o.id != null ? `${ORIGIN}/job-${o.id}` : '');
  },

  // Activity = what recruiters did (verified): GET
  // /api/v1/candidate_misc/activity/employer_activity?activity_facet=N,
  // 0 viewed · 1 contacted · 2 not shortlisted. Rows carry job.url
  // "/job-435618-backend-developer-at-…", whose number is the harvest's id.
  applications: {
    url: `${ORIGIN}/candidate/activity/`,
    test: (url) => /\/activity\/employer_activity\?/.test(url),
    tabs: [/^\s*contacted\b/i, /^\s*not shortlisted\b/i],
    rowsFrom: (body, url = '') => {
      const facet = (/activity_facet=(\d)/.exec(url) || [])[1] || '0';
      const word = { 0: 'Viewed', 1: 'Contacted', 2: 'Not shortlisted' }[facet] || 'Viewed';
      const list = (body && body.objects) || [];
      return list.map((r) => {
        const m = /\/job-(\d+)/.exec((r && r.job && r.job.url) || '');
        return m ? { jobId: m[1], statuses: [word] } : null;
      }).filter(Boolean);
    },
  },

  // Dry-run apply: what to look for on a listing. Nothing here is clicked.
  //
  // Real apply (mapped 2026-10-21 from the site's own code): "Apply now"
  // calls submitChoice(opp, true) → POST /api/v1/candidate_opportunities/
  // candidate_matching/apply/ with { job_id, is_interested: true }, answered
  // with { opp_id, applied_on }, then the toast "Application sent to <co>!".
  // AFTER that it may open a modal — "apply to N more jobs at this company"
  // (apply_bulk), "are you active?", or a premium upsell. Those are dismissed
  // with Cancel/close, and apply_bulk is blocked at the network as well.
  applyFlow: {
    applyButtons: [/^apply( now)?$/i, /^i'?m interested$/i, /^interested$/i],
    // The listing's own header button (verified: the only "Apply now" on the
    // page — an <a> wrapping this <button>).
    applySelector: '.apply-button button[ng-click^="submitChoice(opp, true)"]',
    externalButtons: [/apply on company (site|website)/i],
    // "Application sent! on October 21, 2026" replaces the button (verified).
    alreadyText: ['you have applied', 'already applied', 'application sent! on'],
    // The job the request is for, to prove it is the one we meant.
    jobIdOf: (url, post) => post && post.job_id != null ? String(post.job_id) : null,
    appliedLabel: /^(applied|application sent)$/i,
    applyRequest: (url, method) => method === 'POST' && /\/candidate_matching\/apply\/?(\?|$)/.test(url),
    blockRequests: [/\/candidate_matching\/apply_bulk\b/],
  },
};
