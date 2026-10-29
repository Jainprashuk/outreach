'use strict';

// Everything Hirist-shaped, in one place. The driver (../shared/driver.js)
// reads only this file.
//
// STATUS: VERIFIED on the live site 2026-10-20/21 (RECON.md): search pages
// /search/<slug>-jobs load GET gladiator.hirist.tech/job/search?query=… (20 a
// page); your job feed /jobfeed loads /job/jobfeed?page=N (50 a page, login
// needed); applied jobs /applied-jobs load /job/applied-jobs?page=N&status=;
// the login cookie is hirist_seeker_enc. capabilities.apply is false: only a
// dry run exists.

const { capabilitiesOf } = require('../../../lib/platforms');

const ORIGIN = 'https://www.hirist.tech';

module.exports = {
  id: 'hirist',
  label: 'Hirist',
  origin: ORIGIN,
  // Hirist's pages fetch jobs from this host (verified).
  apiHosts: ['gladiator.hirist.tech'],
  // The job lists only: search results and keyword pages (verified).
  // Your job feed too (logged in only).
  feedTest: (url) => /\/job\/(search|keyword|jobfeed)\b/.test(url),

  cookieUrls: [ORIGIN, 'https://hirist.tech'],
  // Set at login (verified 2026-10-21). PHPSESSID and chatSdkToken exist
  // logged out too, so no pattern match: only these names count.
  sessionCookies: ['hirist_seeker_enc', 'HIRIST_CK1'],

  guardMarkers: {
    loginUrls: ['/login', '/signin'],   // verify
    urls: [],
    text: [],
    loginText: ['login to hirist', 'sign in with google', 'forgot password'],   // verify
  },

  capabilities: capabilitiesOf('hirist'),

  // Your job feed (verified): GET /job/jobfeed?minexp=N&page=0, 50 jobs, the
  // same job shape as search. Needs a login — a logged-out harvest skips it
  // (loginOnly) rather than walking into the login wall.
  feeds: [
    { url: `${ORIGIN}/jobfeed`, label: 'My job feed', origin: 'recommended', loginOnly: true },
  ],
  recruiterFeed: false,
  // Free-text search (verified): /search/backend-developer-jobs?minexp=3.
  // `loc` takes Hirist's own location ids, so location is left to your
  // Filters → Locations, which run on every harvest anyway.
  searchUrl: (s) => {
    const slug = String(s.keywords || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const u = new URL(`${ORIGIN}/search/${slug || 'software-developer'}-jobs`);
    if (s.experienceYears != null) u.searchParams.set('minexp', String(s.experienceYears));
    return u.toString();
  },
  // Numbered pages (verified): ?page=2 loads the API's page=1.
  pageUrl: (url, n) => { const u = new URL(url); u.searchParams.set('page', String(n)); return u.toString(); },
  // Field names in the feed (verified): min/max = experience years,
  // minSal/maxSal (0 with hideSal = 1 when pay is hidden), createdTime = ms.
  fields: {
    id: ['id'],
    company: ['companyData.companyName'],
    expMin: ['min'], expMax: ['max'],
    salMin: ['minSal'], salMax: ['maxSal'],
    posted: ['createdTime', 'createdTimeMs'],
    location: ['locations', 'location'],
  },
  // The feed carries no link; the listing is /j/<title-slug>-<id> (verified:
  // "Happiest Minds - Node.js Architect" → /j/happiest-minds-nodejs-architect-1677995).
  jobUrl: (o, url) => url || (o.id != null
    ? `${ORIGIN}/j/${String(o.title || 'job').toLowerCase().replace(/\./g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-${o.id}`
    : ''),

  // Applied jobs (verified page + feed, 2026-10-21): /applied-jobs loads
  // GET /job/applied-jobs?page=0&status= → { data: { jobs: [], hasMore,
  // count } }. Row fields are "verify" — the account had no applications yet;
  // the page's own code reads appliedData.recruiterActions.
  // NOTE: an unknown hirist.tech path hangs instead of 404ing (seen on
  // /my-jobs), so only verified URLs belong here.
  applications: {
    url: `${ORIGIN}/applied-jobs`,
    test: (url) => /\/job\/applied-jobs\b/.test(url),
    rowsFrom: (body) => {
      const d = body && body.data;
      const list = Array.isArray(body) ? body
        : Array.isArray(d) ? d
        : (d && (d.jobs || d.applications)) || (body && (body.jobs || body.applications || body.results)) || [];
      // A row (verified 2026-10-21 on the first real application):
      // { id: <APPLICATION id>, applicationDate: ms, jobDetail: { id: <job id>,
      //   title, … }, recruiterAction: [], app_status: 0, … }. The job id is
      // jobDetail.id — `id` is the application's own id. recruiterAction's
      // entries were still empty; strings or { action/name/status } are read.
      const word = (a) => (typeof a === 'string' ? a
        : a && typeof a === 'object' ? (a.action || a.actionName || a.name || a.status || a.type || '') : '');
      // Recruiter actions arrive as { recruiterId, actionId, date } (verified
      // 2026-10-29): actionId is the same number as the row's app_status, which
      // Hirist's own page prints as 2 = "Not suitable", 5 = "Downloaded" (resume).
      // Any other id is kept under its number rather than dropped, until its
      // wording is seen on the site.
      const ACTION = { 2: 'Not suitable', 5: 'Resume downloaded' };
      const act = (a) => {
        if (!a || typeof a !== 'object' || a.actionId == null) return word(a);
        return { word: ACTION[a.actionId] || `Hirist recruiter action ${a.actionId}`, at: a.date ? new Date(Number(a.date)).toISOString() : null };
      };
      return (Array.isArray(list) ? list : []).map(r => r && ({
        jobId: (r.jobDetail && r.jobDetail.id) || (r.job && r.job.id) || r.jobId || r.job_id || null,
        statuses: [
          r.applicationStatus, r.stage,
          ...[].concat(r.recruiterAction || []).map(act),
          ...[].concat((r.appliedData && r.appliedData.recruiterActions) || []).map(act),
          typeof r.status === 'string' ? r.status : null,
        ].filter(x => x && (typeof x === 'string' || typeof x === 'object')),
        // applicationDate runs 5h30m behind the real moment (applied at
        // 20:56:36Z, row said 15:26:36Z — verified 2026-10-21), so add it back.
        at: r.applicationDate ? new Date(Number(r.applicationDate) + 330 * 60000).toISOString() : (r.updatedAt || null),
      })).filter(Boolean);
    },
  },

  // Listings that redirect to company sites are skipped, as Naukri skips
  // #company-site-button.
  //
  // Real apply (mapped 2026-10-21 from the site's own code + job JSON): the
  // listing loads GET /job/detail?jobcode=<id> with applyUrl (company site),
  // assessmentFlags/assessmentCompleted (screening test) and applied. The
  // button [data-track="apply-job"] then either redirects (incomplete profile
  // → /registration/…, screening test, company site — which ALSO records an
  // apply on Hirist, so it is skipped BEFORE clicking), opens a dialog, or
  // sends POST gladiator.hirist.tech/job/apply?jobcode=<id> ("Job Applied
  // Successfully") and the button turns "Applied".
  applyFlow: {
    applyButtons: [/^apply( now)?$/i, /^quick apply$/i],
    applySelector: '[data-track="apply-job"]',
    externalButtons: [/apply on company (site|website)/i, /^apply externally$/i],
    alreadyText: ['already applied', 'you have applied', 'applied on'],
    appliedLabel: /^applied$/i,
    // The one request that IS the application.
    applyRequest: (url, method) => method === 'POST' && /gladiator\.hirist\.tech\/job\/apply\?jobcode=/.test(url),
    jobIdOf: (url) => { const m = /[?&]jobcode=(\d+)/.exec(url); return m ? m[1] : null; },
    // Never sent from here: "apply to these similar jobs too".
    blockRequests: [/\/job\/apply-multiple\b/],
    // Read before clicking, from the listing's own JSON.
    detailTest: (url) => /\/job\/detail\?jobcode=/.test(url),
    preCheck: (body) => {
      const d = body && (body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : body);
      if (!d || typeof d !== 'object') return null;
      if (Number(d.applied) > 0 || d.isApplied) return 'Hirist says you have already applied to this job';
      if (d.applyUrl && !Number(d.confidential)) return 'Applies on the company site — Hirist hands you over to it, apply there yourself';
      if (Number(d.status) === 0) return 'Listing closed — Hirist no longer takes applications for it';
      return null;
    },
    // The recruiter's form after Apply (verified live 2026-10-27, job 1680253):
    // the click goes to /job/<id>/screening, questions from
    // assessmentapi.hirist.tech/v1/questionnaire (type 5/4 text, 7 number,
    // 2 pill choice; `mandatory` per question), submit button "Next". Profile
    // values (salary, notice period) arrive pre-filled and are kept.
    screening: {
      urlTest: '/screening',
      questionnaireTest: (url) => /assessmentapi\.hirist\.tech\/v1\/questionnaire\?/.test(url),
      questionBox: '.screening-question-container',
      questionText: '.question-text',
      input: 'textarea, input[type=number], input[type=text]',
      option: 'button.pill-option',
      // Verified: the mandatory question's text div has this class.
      mandatory: '.mandatory-question',
      // Not seen yet (radio / checkbox rows) — a guess, used only when no
      // verified control is present.
      choice: 'label:has(input[type=radio]), label:has(input[type=checkbox])',
      submit: 'button[type=submit], button:has-text("Submit"), button:has-text("Next")',
      maxSteps: 3,
    },
    // Where a click can send you instead of applying.
    redirects: [
      { test: '/registration/', reason: 'Hirist wants your profile finished before you apply (it opened /registration). Finish it on hirist.tech, then re-approve.' },
      { test: 'assessment', reason: 'Hirist opened a screening test for this job — take it on the site, then re-approve.' },
    ],
  },
};
