'use strict';

// Everything Instahyre-shaped, in one place. The driver (../shared/driver.js)
// reads only this file, so a fix after a site change — or after recon — is an
// edit here and nowhere else.
//
// STATUS: written before Phase 0 recon was done on the live site. URLs and the
// session cookie follow Instahyre's public pages and its Django stack, and are
// MARKED "verify" until RECON.md is filled in from DevTools. The read paths are
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
  feedTest: (url) => /\/api\//.test(url) && !/(analytics|track|event|log)/i.test(url),

  // Logged in = a Django session cookie on the site. verify
  cookieUrls: [ORIGIN],
  sessionCookies: ['sessionid'],

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
    { url: `${ORIGIN}/candidate/opportunities/?matching=true`, label: 'Matched opportunities', origin: 'recommended' },   // verify
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
  // Field names, once read in DevTools; until then the shared defaults apply.
  fields: {},
  // Listing URL from a row, when the JSON carries only an id/slug. verify
  jobUrl: (o, url) => url || (o.id != null ? `${ORIGIN}/job-${o.id}` : ''),

  // "My applications". Rows → { jobId, statuses: [words], at }. verify
  applications: {
    url: `${ORIGIN}/candidate/applications/`,
    test: (url) => /\/api\//.test(url),
    rowsFrom: (body) => {
      const list = Array.isArray(body) ? body : (body && (body.objects || body.results || body.applications || body.data)) || [];
      return (Array.isArray(list) ? list : []).map(r => r && ({
        jobId: (r.job && (r.job.id || r.job.job_id)) || r.job_id || r.jobId || r.opportunity_id || r.id,
        statuses: [r.status, r.state, r.candidate_status, r.employer_status, r.stage].filter(Boolean),
        at: r.updated_at || r.modified || r.created_at || null,
      })).filter(Boolean);
    },
  },

  // Dry-run apply: what to look for on a listing. Nothing here is clicked.
  applyFlow: {
    applyButtons: [/^apply( now)?$/i, /^i'?m interested$/i, /^interested$/i],
    externalButtons: [/apply on company (site|website)/i],
    alreadyText: ['you have applied', 'already applied', 'application sent'],
  },
};
