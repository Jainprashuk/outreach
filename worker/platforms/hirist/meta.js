'use strict';

// Everything Hirist-shaped, in one place. The driver (../shared/driver.js)
// reads only this file.
//
// STATUS: written before Phase 0 recon on the live site. Hirist moved to
// hirist.tech; its listings are fetched as JSON by a separate API host. Values
// marked "verify" come from its public pages and must be confirmed in DevTools
// and written into RECON.md. Hirist has no strong recommended feed, so harvest
// uses your searches only (lib/platforms.js sources.recommended = null).
// capabilities.apply is false: only a dry run exists.

const { capabilitiesOf } = require('../../../lib/platforms');

const ORIGIN = 'https://www.hirist.tech';

module.exports = {
  id: 'hirist',
  label: 'Hirist',
  origin: ORIGIN,
  // Hirist's pages call an API on a sibling host. verify
  apiHosts: ['hirist.tech', 'hirist.com'],
  feedTest: (url) => /(\/api\/|gladiator|\/job)/i.test(url) && !/(analytics|track|event|log|banner)/i.test(url),

  cookieUrls: [ORIGIN, 'https://hirist.tech'],
  // verify — the token cookie set at login.
  sessionCookies: ['token', 'authToken', 'jwt', 'hirist_token', 'access_token'],

  guardMarkers: {
    loginUrls: ['/login', '/signin'],   // verify
    urls: [],
    text: [],
    loginText: ['login to hirist', 'sign in with google', 'forgot password'],   // verify
  },

  capabilities: capabilitiesOf('hirist'),

  feeds: [],
  recruiterFeed: false,
  // Search results page. verify
  searchUrl: (s) => {
    const slug = String(s.keywords || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const u = new URL(`${ORIGIN}/k/${slug || 'software'}-jobs`);
    if (s.location) u.searchParams.set('loc', s.location);
    if (s.experienceYears != null) u.searchParams.set('minexp', String(s.experienceYears));
    return u.toString();
  },
  fields: {},
  jobUrl: (o, url) => url || (o.id != null ? `${ORIGIN}/j/${o.id}` : ''),

  applications: {
    url: `${ORIGIN}/my-jobs`,   // verify
    test: (url) => /(applied|application|myjobs|my-jobs)/i.test(url),
    rowsFrom: (body) => {
      const list = Array.isArray(body) ? body : (body && (body.data || body.jobs || body.applications || body.results)) || [];
      return (Array.isArray(list) ? list : []).map(r => r && ({
        jobId: (r.job && r.job.id) || r.jobId || r.job_id || r.id,
        statuses: [r.status, r.applicationStatus, r.recruiterAction, r.stage, r.viewed ? 'viewed' : null].filter(Boolean),
        at: r.updatedAt || r.updated_at || r.appliedOn || null,
      })).filter(Boolean);
    },
  },

  // Listings that redirect to company sites are skipped, as Naukri skips
  // #company-site-button.
  applyFlow: {
    applyButtons: [/^apply( now)?$/i, /^quick apply$/i],
    externalButtons: [/apply on company (site|website)/i, /^apply externally$/i],
    alreadyText: ['already applied', 'you have applied', 'applied on'],
  },
};
